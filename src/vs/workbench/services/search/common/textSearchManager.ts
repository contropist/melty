/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isThenable } from 'vs/base/common/async';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { Schemas } from 'vs/base/common/network';
import * as path from 'vs/base/common/path';
import * as resources from 'vs/base/common/resources';
import { TernarySearchTree } from 'vs/base/common/ternarySearchTree';
import { URI } from 'vs/base/common/uri';
import { DEFAULT_MAX_SEARCH_RESULTS, hasSiblingPromiseFn, IAITextQuery, IExtendedExtensionSearchOptions, IFileMatch, IFolderQuery, excludeToGlobPattern, IPatternInfo, ISearchCompleteStats, ITextQuery, ITextSearchContext, ITextSearchMatch, ITextSearchResult, ITextSearchStats, QueryGlobTester, QueryType, resolvePatternsForProvider, ISearchRange } from 'vs/workbench/services/search/common/search';
import { AITextSearchProviderNew, TextSearchCompleteNew, TextSearchMatchNew, TextSearchProviderFolderOptions, TextSearchProviderNew, TextSearchProviderOptions, TextSearchQueryNew, TextSearchResultNew } from 'vs/workbench/services/search/common/searchExtTypes';

export interface IFileUtils {
	readdir: (resource: URI) => Promise<string[]>;
	toCanonicalName: (encoding: string) => string;
}
interface IAITextQueryProviderPair {
	query: IAITextQuery; provider: AITextSearchProviderNew;
}

interface ITextQueryProviderPair {
	query: ITextQuery; provider: TextSearchProviderNew;
}
interface FolderQueryInfo {
	queryTester: QueryGlobTester;
	folder: URI;
	folderIdx: number;
}

export class TextSearchManager {

	private collector: TextSearchResultsCollector | null = null;

	private isLimitHit = false;
	private resultCount = 0;

	constructor(private queryProviderPair: IAITextQueryProviderPair | ITextQueryProviderPair,
		private fileUtils: IFileUtils,
		private processType: ITextSearchStats['type']) { }

	private get query() {
		return this.queryProviderPair.query;
	}

	search(onProgress: (matches: IFileMatch[]) => void, token: CancellationToken): Promise<ISearchCompleteStats> {
		const folderQueries = this.query.folderQueries || [];
		const tokenSource = new CancellationTokenSource(token);

		return new Promise<ISearchCompleteStats>((resolve, reject) => {
			this.collector = new TextSearchResultsCollector(onProgress);

			let isCanceled = false;
			const onResult = (result: TextSearchResultNew, folderIdx: number) => {
				if (isCanceled) {
					return;
				}

				if (!this.isLimitHit) {
					const resultSize = this.resultSize(result);
					if (result instanceof TextSearchMatchNew && typeof this.query.maxResults === 'number' && this.resultCount + resultSize > this.query.maxResults) {
						this.isLimitHit = true;
						isCanceled = true;
						tokenSource.cancel();

						result = this.trimResultToSize(result, this.query.maxResults - this.resultCount);
					}

					const newResultSize = this.resultSize(result);
					this.resultCount += newResultSize;
					const a = result instanceof TextSearchMatchNew;

					if (newResultSize > 0 || !a) {
						this.collector!.add(result, folderIdx);
					}
				}
			};

			// For each root folder
			this.doSearch(folderQueries, onResult, tokenSource.token).then(result => {
				tokenSource.dispose();
				this.collector!.flush();

				resolve({
					limitHit: this.isLimitHit || result?.limitHit,
					messages: this.getMessagesFromResults(result),
					stats: {
						type: this.processType
					}
				});
			}, (err: Error) => {
				tokenSource.dispose();
				const errMsg = toErrorMessage(err);
				reject(new Error(errMsg));
			});
		});
	}

	private getMessagesFromResults(result: TextSearchCompleteNew | null | undefined) {
		if (!result?.message) { return []; }
		if (Array.isArray(result.message)) { return result.message; }
		return [result.message];
	}

	private resultSize(result: TextSearchResultNew): number {
		if (result instanceof TextSearchMatchNew) {
			return Array.isArray(result.ranges) ?
				result.ranges.length :
				1;
		}
		else {
			// #104400 context lines shoudn't count towards result count
			return 0;
		}
	}

	private trimResultToSize(result: TextSearchMatchNew, size: number): TextSearchMatchNew {
		return new TextSearchMatchNew(result.uri, result.ranges.slice(0, size), result.previewText);
	}

	private async doSearch(folderQueries: IFolderQuery<URI>[], onResult: (result: TextSearchResultNew, folderIdx: number) => void, token: CancellationToken): Promise<TextSearchCompleteNew | null | undefined> {
		const folderMappings: TernarySearchTree<URI, FolderQueryInfo> = TernarySearchTree.forUris<FolderQueryInfo>();
		folderQueries.forEach((fq, i) => {
			const queryTester = new QueryGlobTester(this.query, fq);
			folderMappings.set(fq.folder, { queryTester, folder: fq.folder, folderIdx: i });
		});

		const testingPs: Promise<void>[] = [];
		const progress = {
			report: (result: TextSearchResultNew) => {

				const folderQuery = folderMappings.findSubstr(result.uri)!;
				const hasSibling = folderQuery.folder.scheme === Schemas.file ?
					hasSiblingPromiseFn(() => {
						return this.fileUtils.readdir(resources.dirname(result.uri));
					}) :
					undefined;

				const relativePath = resources.relativePath(folderQuery.folder, result.uri);
				if (relativePath) {
					// This method is only async when the exclude contains sibling clauses
					const included = folderQuery.queryTester.includedInQuery(relativePath, path.basename(relativePath), hasSibling);
					if (isThenable(included)) {
						testingPs.push(
							included.then(isIncluded => {
								if (isIncluded) {
									onResult(result, folderQuery.folderIdx);
								}
							}));
					} else if (included) {
						onResult(result, folderQuery.folderIdx);
					}
				}
			}
		};

		const folderOptions = folderQueries.map(fq => this.getSearchOptionsForFolder(fq));
		const searchOptions: TextSearchProviderOptions = {
			folderOptions,
			maxFileSize: this.query.maxFileSize,
			maxResults: this.query.maxResults ?? DEFAULT_MAX_SEARCH_RESULTS,
			previewOptions: this.query.previewOptions,
			surroundingContext: this.query.surroundingContext ?? 0,
		};
		if ('usePCRE2' in this.query) {
			(<IExtendedExtensionSearchOptions>searchOptions).usePCRE2 = this.query.usePCRE2;
		}

		let result;
		if (this.queryProviderPair.query.type === QueryType.aiText) {
			result = await (this.queryProviderPair as IAITextQueryProviderPair).provider.provideAITextSearchResults(this.queryProviderPair.query.contentPattern, searchOptions, progress, token);
		} else {
			result = await (this.queryProviderPair as ITextQueryProviderPair).provider.provideTextSearchResults(patternInfoToQuery(this.queryProviderPair.query.contentPattern), searchOptions, progress, token);
		}
		if (testingPs.length) {
			await Promise.all(testingPs);
		}

		return result;
	}

	private getSearchOptionsForFolder(fq: IFolderQuery<URI>): TextSearchProviderFolderOptions {
		const includes = resolvePatternsForProvider(this.query.includePattern, fq.includePattern);
		const excludes = excludeToGlobPattern(fq.excludePattern?.folder, resolvePatternsForProvider(this.query.excludePattern, fq.excludePattern?.pattern));

		const options = {
			folder: URI.from(fq.folder),
			excludes,
			includes,
			useIgnoreFiles: {
				local: !fq.disregardIgnoreFiles,
				parent: !fq.disregardParentIgnoreFiles,
				global: !fq.disregardGlobalIgnoreFiles
			},
			followSymlinks: !fq.ignoreSymlinks,
			encoding: (fq.fileEncoding && this.fileUtils.toCanonicalName(fq.fileEncoding)) ?? '',
		};
		return options;
	}
}

function patternInfoToQuery(patternInfo: IPatternInfo): TextSearchQueryNew {
	return {
		isCaseSensitive: patternInfo.isCaseSensitive || false,
		isRegExp: patternInfo.isRegExp || false,
		isWordMatch: patternInfo.isWordMatch || false,
		isMultiline: patternInfo.isMultiline || false,
		pattern: patternInfo.pattern
	};
}

export class TextSearchResultsCollector {
	private _batchedCollector: BatchedCollector<IFileMatch>;

	private _currentFolderIdx: number = -1;
	private _currentUri: URI | undefined;
	private _currentFileMatch: IFileMatch | null = null;

	constructor(private _onResult: (result: IFileMatch[]) => void) {
		this._batchedCollector = new BatchedCollector<IFileMatch>(512, items => this.sendItems(items));
	}

	add(data: TextSearchResultNew, folderIdx: number): void {
		// Collects TextSearchResults into IInternalFileMatches and collates using BatchedCollector.
		// This is efficient for ripgrep which sends results back one file at a time. It wouldn't be efficient for other search
		// providers that send results in random order. We could do this step afterwards instead.
		if (this._currentFileMatch && (this._currentFolderIdx !== folderIdx || !resources.isEqual(this._currentUri, data.uri))) {
			this.pushToCollector();
			this._currentFileMatch = null;
		}

		if (!this._currentFileMatch) {
			this._currentFolderIdx = folderIdx;
			this._currentFileMatch = {
				resource: data.uri,
				results: []
			};
		}

		this._currentFileMatch.results!.push(extensionResultToFrontendResult(data));
	}

	private pushToCollector(): void {
		const size = this._currentFileMatch && this._currentFileMatch.results ?
			this._currentFileMatch.results.length :
			0;
		this._batchedCollector.addItem(this._currentFileMatch!, size);
	}

	flush(): void {
		this.pushToCollector();
		this._batchedCollector.flush();
	}

	private sendItems(items: IFileMatch[]): void {
		this._onResult(items);
	}
}

function extensionResultToFrontendResult(data: TextSearchResultNew): ITextSearchResult {
	// Warning: result from RipgrepTextSearchEH has fake Range. Don't depend on any other props beyond these...
	if (data instanceof TextSearchMatchNew) {
		return {
			previewText: data.previewText,
			rangeLocations: data.ranges.map(r => ({
				preview: {
					startLineNumber: r.previewRange.start.line,
					startColumn: r.previewRange.start.character,
					endLineNumber: r.previewRange.end.line,
					endColumn: r.previewRange.end.character
				} satisfies ISearchRange,
				source: {
					startLineNumber: r.sourceRange.start.line,
					startColumn: r.sourceRange.start.character,
					endLineNumber: r.sourceRange.end.line,
					endColumn: r.sourceRange.end.character
				} satisfies ISearchRange,
			})),
		} satisfies ITextSearchMatch;
	} else {
		return {
			text: data.text,
			lineNumber: data.lineNumber
		} satisfies ITextSearchContext;
	}
}


/**
 * Collects items that have a size - before the cumulative size of collected items reaches START_BATCH_AFTER_COUNT, the callback is called for every
 * set of items collected.
 * But after that point, the callback is called with batches of maxBatchSize.
 * If the batch isn't filled within some time, the callback is also called.
 */
export class BatchedCollector<T> {
	private static readonly TIMEOUT = 4000;

	// After START_BATCH_AFTER_COUNT items have been collected, stop flushing on timeout
	private static readonly START_BATCH_AFTER_COUNT = 50;

	private totalNumberCompleted = 0;
	private batch: T[] = [];
	private batchSize = 0;
	private timeoutHandle: any;

	constructor(private maxBatchSize: number, private cb: (items: T[]) => void) {
	}

	addItem(item: T, size: number): void {
		if (!item) {
			return;
		}

		this.addItemToBatch(item, size);
	}

	addItems(items: T[], size: number): void {
		if (!items) {
			return;
		}

		this.addItemsToBatch(items, size);
	}

	private addItemToBatch(item: T, size: number): void {
		this.batch.push(item);
		this.batchSize += size;
		this.onUpdate();
	}

	private addItemsToBatch(item: T[], size: number): void {
		this.batch = this.batch.concat(item);
		this.batchSize += size;
		this.onUpdate();
	}

	private onUpdate(): void {
		if (this.totalNumberCompleted < BatchedCollector.START_BATCH_AFTER_COUNT) {
			// Flush because we aren't batching yet
			this.flush();
		} else if (this.batchSize >= this.maxBatchSize) {
			// Flush because the batch is full
			this.flush();
		} else if (!this.timeoutHandle) {
			// No timeout running, start a timeout to flush
			this.timeoutHandle = setTimeout(() => {
				this.flush();
			}, BatchedCollector.TIMEOUT);
		}
	}

	flush(): void {
		if (this.batchSize) {
			this.totalNumberCompleted += this.batchSize;
			this.cb(this.batch);
			this.batch = [];
			this.batchSize = 0;

			if (this.timeoutHandle) {
				clearTimeout(this.timeoutHandle);
				this.timeoutHandle = 0;
			}
		}
	}
}