import * as vscode from "vscode";
import { Joule, Conversation, GitRepo, TaskMode, DiffInfo } from "../types";
import * as conversations from "./conversations";
import * as joules from "./joules";
import * as utils from "../util/utils";
import { Vanilla } from "../assistants/vanilla";
import { Coder } from "../assistants/coder";
import * as config from "../util/config";
import { FileManager } from "../fileManager";
import { getRepoAtWorkspaceRoot } from "../util/gitUtils";
import * as datastores from "./datastores";
import { generateCommitMessage } from "./commitMessageGenerator";
import { WebviewNotifier } from "../webviewNotifier";

const webviewNotifier = WebviewNotifier.getInstance();

/**
 * A Task manages the interaction between a conversation and a git repository
 */
export class Task implements Task {
	conversation: Conversation;
	gitRepo: GitRepo | null;
	fileManager: FileManager | undefined;
	createdAt: Date;
	updatedAt: Date;
	savedMeltyMindFiles: string[] = [];

	constructor(
		public id: string,
		public name: string,
		public taskMode: TaskMode,
		public files?: string[]
	) {
		this.conversation = conversations.create();
		this.gitRepo = null;
		this.savedMeltyMindFiles = files || [];
		this.createdAt = new Date();
		this.updatedAt = new Date();
	}

	updateLastModified() {
		this.updatedAt = new Date();
	}

	public setFileManager(fileManager: FileManager) {
		this.fileManager = fileManager;
	}

	public addErrorJoule(message: string): void {
		// first, remove any bot joules
		this.conversation = conversations.forceConversationReadyForResponseFrom(
			this.conversation,
			"bot"
		);
		const errorJoule = joules.createJouleError(
			`Melty encountered an error: ${message}. Try again?`
		);
		this.conversation = conversations.addJoule(this.conversation, errorJoule);
	}

	/**
	 * Initializes the GitRepo's repository field. Note that if the GitRepo has only a rootPath,
	 * then we still need to run `init` to populate the repository field.
	 */
	public async init(fileManager: FileManager): Promise<boolean> {
		if (this.gitRepo && this.gitRepo.repository) {
			return true;
		}

		const result = await getRepoAtWorkspaceRoot();
		if (typeof result === "string") {
			console.log(`Could not initialize task: ${result}`);
			return false;
		}

		this.gitRepo = result;
		console.log(`Initialized task ${this.id}`);

		this.setFileManager(fileManager);
		return true;
	}

	/**
	 * Lists Joules in a Task.
	 */
	public listJoules(): readonly Joule[] {
		return this.conversation.joules;
	}

	private ensureWorkingDirectoryClean(): void {
		if (!utils.repoIsClean(this.gitRepo!.repository)) {
			utils.handleGitError(`Working directory is not clean:
                ${this.gitRepo!.repository.state.workingTreeChanges.length}
                ${this.gitRepo!.repository.state.indexChanges.length}
                ${this.gitRepo!.repository.state.mergeChanges.length}`);
		}
	}

	/**
	 * Commits any local changes (or empty commit if none).
	 * @returns the number of changes committed
	 */
	private async commitLocalChanges(): Promise<number> {
		// Get all changes, including untracked files
		const changes = await this.gitRepo!.repository.diffWithHEAD();

		// Filter out ignored files
		const nonIgnoredChanges = changes.filter(
			(change: any) => !change.gitIgnored
		);

		// Add only non-ignored files
		await this.gitRepo!.repository.add(
			nonIgnoredChanges.map((change: any) => change.uri.fsPath)
		);

		const indexChanges = this.gitRepo!.repository.state.indexChanges;

		if (indexChanges.length > 0) {
			const udiffPreview = await utils.getUdiffFromWorking(this.gitRepo!);
			const message = await generateCommitMessage(udiffPreview);

			await this.gitRepo!.repository.commit(`[via melty] ${message}`);
		}

		await this.gitRepo!.repository.status();
		return indexChanges.length;
	}

	/**
	 * Adds a bot message (and changes) to the conversation.
	 *
	 * @param contextPaths - the paths to the files in the context of which to respond (melty's mind)
	 * @param mode - the mode of the assistant to use
	 * @param processPartial - a function to process the partial joule
	 */
	public async respondBot(
		processPartial: (partialConversation: Conversation) => void
	): Promise<void> {
		try {
			webviewNotifier.updateStatusMessage("Checking repo status");
			await this.gitRepo!.repository.status();
			this.ensureWorkingDirectoryClean();
			webviewNotifier.resetStatusMessage();

			let assistant;
			switch (this.taskMode) {
				case "coder":
					assistant = new Coder();
					break;
				case "vanilla":
					assistant = new Vanilla();
					break;
				default:
					throw new Error(`Unknown assistant type: ${this.taskMode}`);
			}

			const meltyMindFiles =
				await this.fileManager!.getMeltyMindFilesRelative();

			this.conversation = await assistant.respond(
				this.conversation,
				this.gitRepo!,
				meltyMindFiles,
				processPartial
			);

			webviewNotifier.updateStatusMessage(
				"Adding edited files to Melty's Mind"
			);
			const lastJoule = conversations.lastJoule(this.conversation)!;
			if (lastJoule.diffInfo?.filePathsChanged) {
				// add any edited files to melty's mind
				lastJoule.diffInfo.filePathsChanged.forEach((editedFile) => {
					this.fileManager!.addMeltyMindFile(editedFile, true);
				});
			}

			webviewNotifier.updateStatusMessage("Autosaving conversation");
			this.updateLastModified();
			await datastores.dumpTaskToDisk(this);
		} catch (e) {
			if (config.DEV_MODE) {
				throw e;
			} else {
				vscode.window.showErrorMessage(`Error talking to the bot: ${e}`);
				const message = "[  Error :(  ]";
				const joule = joules.createJouleBot(
					message,
					{
						rawOutput: message,
						contextPaths: [],
					},
					"complete"
				);
				this.conversation = conversations.addJoule(this.conversation, joule);
			}
		}
	}

	/**
	 * Adds a human message (and changes) to the conversation.
	 */
	public async respondHuman(message: string): Promise<Joule> {
		this.conversation = conversations.forceConversationReadyForResponseFrom(
			this.conversation,
			"human"
		);

		let newJoule: Joule;

		if (config.getIsAutocommitMode() && this.taskMode !== "vanilla") {
			webviewNotifier.updateStatusMessage("Checking repo status");
			let didCommit = false;
			await this.gitRepo!.repository.status();
			webviewNotifier.updateStatusMessage("Committing user's changes");
			didCommit = (await this.commitLocalChanges()) > 0;
			webviewNotifier.resetStatusMessage();

			const latestCommit = this.gitRepo!.repository.state.HEAD?.commit;
			const diffPreview = await utils.getUdiffFromCommit(
				this.gitRepo!,
				latestCommit
			);

			const diffInfo = {
				filePathsChanged: null,
				diffPreview: diffPreview || "",
			};

			newJoule = didCommit
				? joules.createJouleHumanWithChanges(message, latestCommit, diffInfo)
				: joules.createJouleHuman(message);
		} else {
			newJoule = joules.createJouleHuman(message);
		}

		this.conversation = conversations.addJoule(this.conversation, newJoule);
		this.updateLastModified();

		webviewNotifier.updateStatusMessage("Autosaving conversation");
		await datastores.dumpTaskToDisk(this);

		webviewNotifier.resetStatusMessage();
		return conversations.lastJoule(this.conversation)!;
	}

	/**
	 * goes to a plain JSON object that can be passed to JSON.stringify
	 */
	public serialize(): any {
		return {
			...this,
			gitRepo: {
				...this.gitRepo,
				repository: null,
			},
			fileManager: null,
			savedMeltyMindFiles: this.fileManager
				? this.fileManager.dumpMeltyMindFiles()
				: undefined,
		};
	}

	public static deserialize(serializedTask: any): Task {
		const task = Object.assign(
			new Task(serializedTask.id, "", "coder"), // default to coder
			serializedTask
		) as Task;

		task.fileManager = undefined;

		return task;
	}
}