/**
 * Inbox Processor — Watches .conflux/inbox/ for JSON files from the MCP server.
 *
 * When the MCP server's conflux_report tool is called, it drops a JSON file
 * into .conflux/inbox/. This processor picks it up, sends it to Railway
 * for distillation, embeds the result, stores in Vectra, syncs via Supabase,
 * and deletes the inbox file.
 *
 * This is the "Inbox Pattern" — MCP writes, Extension reads.
 * No shared state, no index corruption.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { VectorStore, Decision } from './vectorStore';
import { SyncLayer } from './syncLayer';
import * as os from 'os';

export class InboxProcessor implements vscode.Disposable {
    private watcher: vscode.FileSystemWatcher | null = null;
    private vectorStore: VectorStore;
    private syncLayer: SyncLayer;
    private outputChannel: vscode.OutputChannel;
    private railwayUrl: string = '';
    private projectToken: string = '';
    private processing: Set<string> = new Set(); // Prevent double-processing

    constructor(
        vectorStore: VectorStore,
        syncLayer: SyncLayer,
        outputChannel: vscode.OutputChannel
    ) {
        this.vectorStore = vectorStore;
        this.syncLayer = syncLayer;
        this.outputChannel = outputChannel;
    }

    /**
     * Initialize the inbox watcher.
     * Creates .conflux/inbox/ if it doesn't exist and starts watching.
     */
    public initialize(): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }

        const config = vscode.workspace.getConfiguration('conflux');
        this.railwayUrl = config.get<string>('railwayUrl', '');
        this.projectToken = config.get<string>('projectToken', '');

        const inboxDir = path.join(
            workspaceFolders[0].uri.fsPath,
            '.conflux', 'inbox'
        );

        // Ensure inbox directory exists
        if (!fs.existsSync(inboxDir)) {
            fs.mkdirSync(inboxDir, { recursive: true });
        }

        // Watch for new JSON files
        this.watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(
                workspaceFolders[0],
                '.conflux/inbox/*.json'
            )
        );

        this.watcher.onDidCreate((uri) => this.processInboxFile(uri.fsPath));
        this.watcher.onDidChange((uri) => this.processInboxFile(uri.fsPath));

        // Process any existing inbox files (from before extension started)
        this.processExistingFiles(inboxDir);

        this.outputChannel.appendLine('[Conflux] Inbox processor initialized.');
    }

    /**
     * Process any files already in the inbox directory.
     */
    private async processExistingFiles(inboxDir: string): Promise<void> {
        try {
            const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                await this.processInboxFile(path.join(inboxDir, file));
            }
        } catch {
            // Directory might not exist yet
        }
    }

    /**
     * Process a single inbox JSON file.
     *
     * 1. Read the JSON payload
     * 2. Extract decisions from the batch
     * 3. Embed each decision and store in Vectra
     * 4. Sync to teammates via Supabase
     * 5. Delete the inbox file
     */
    private async processInboxFile(filePath: string): Promise<void> {
        // Prevent double-processing
        if (this.processing.has(filePath)) {
            return;
        }
        this.processing.add(filePath);

        try {
            // Read the payload
            if (!fs.existsSync(filePath)) {
                return;
            }

            const raw = fs.readFileSync(filePath, 'utf-8');
            const payload = JSON.parse(raw);

            this.outputChannel.appendLine(
                `[Conflux] Processing inbox file: ${path.basename(filePath)}`
            );

            // Extract decisions from the batch
            const decisions: Array<{ decision: string; confidence: string; context: string }> =
                payload.decisions || [];

            for (const dec of decisions) {
                const decisionText = typeof dec === 'string' ? dec : dec.decision;
                if (!decisionText) {
                    continue;
                }

                const confidence = (typeof dec === 'object' && dec.confidence === 'high')
                    ? 'decided' as const
                    : 'pending' as const;

                const decision: Decision = {
                    summary: decisionText,
                    filePath: 'chat',
                    fileName: 'AI Conversation',
                    languageId: 'chat',
                    author: os.userInfo().username || 'unknown',
                    timestamp: payload.timestamp || new Date().toISOString(),
                    confidence: confidence,
                };

                const stored = await this.vectorStore.storeDecision(decision);
                if (stored) {
                    this.syncLayer.broadcastDecision(decision);
                    this.outputChannel.appendLine(
                        `[Conflux] Chat decision stored: ${decisionText}`
                    );
                }
            }

            // Log open questions for visibility
            const questions = payload.open_questions || [];
            if (questions.length > 0) {
                this.outputChannel.appendLine(
                    `[Conflux] Open questions from chat: ${JSON.stringify(questions)}`
                );
            }

            // Delete the processed inbox file
            try {
                fs.unlinkSync(filePath);
            } catch {
                // File might already be deleted
            }

        } catch (error) {
            this.outputChannel.appendLine(
                `[Conflux] Failed to process inbox file: ${error}`
            );
        } finally {
            this.processing.delete(filePath);
        }
    }

    public dispose(): void {
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = null;
        }
    }
}
