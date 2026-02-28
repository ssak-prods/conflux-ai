/**
 * Conflux Extension v2 — Main Entry Point
 *
 * Activates on startup and wires together:
 * 1. DiffTracker — detects buffer changes with debounce + accumulation window
 * 2. SignificanceDetector — checks WHAT changed (not line count)
 * 3. LlmSummarizer — sends significant diffs to Railway/Groq for one-sentence summaries
 * 4. VectorStore — stores decisions with embeddings in .conflux/
 * 5. SidebarViewProvider — webview sidebar with 4 tabs (Home, Brain, Team, Insights)
 * 6. McpManager — writes .cursor/mcp.json and .vscode/mcp.json
 * 7. SyncLayer — Supabase Realtime Broadcast for cross-machine sync
 * 8. ProjectRoom — zero-config team formation with 6-digit codes
 * 9. InboxProcessor — watches .conflux/inbox/ for MCP report batches
 * 10. PulseJob — 90s background job for code-only decisions
 * 11. BrainQuery — conversational questions via AMD 70B / Groq 70B
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { DiffTracker } from './diffTracker';
import { LlmSummarizer } from './llmSummarizer';
import { StatusBarManager } from './statusBar';
import { Embedder } from './embedder';
import { VectorStore, Decision } from './vectorStore';
import { McpManager } from './mcpManager';
import { SyncLayer } from './syncLayer';
import { ProjectRoom } from './projectRoom';
import { SidebarViewProvider } from './sidebarView';
import { detectSignificance } from './significanceDetector';
import { InboxProcessor } from './inboxProcessor';
import { PulseJob } from './pulseJob';
import { BrainQuery } from './brainQuery';

let diffTracker: DiffTracker;
let summarizer: LlmSummarizer;
let statusBar: StatusBarManager;
let embedder: Embedder;
let vectorStore: VectorStore;
let mcpManager: McpManager;
let syncLayer: SyncLayer;
let projectRoom: ProjectRoom;
let sidebarProvider: SidebarViewProvider;
let inboxProcessor: InboxProcessor;
let pulseJob: PulseJob;
let brainQuery: BrainQuery;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
    console.log('[Conflux] Activating extension v2...');

    // Create output channel for logging
    outputChannel = vscode.window.createOutputChannel('Conflux');

    // Initialize components
    statusBar = new StatusBarManager();
    summarizer = new LlmSummarizer();
    diffTracker = new DiffTracker();
    embedder = new Embedder(outputChannel);
    vectorStore = new VectorStore(embedder, outputChannel);
    mcpManager = new McpManager(outputChannel);
    syncLayer = new SyncLayer(vectorStore, outputChannel);
    projectRoom = new ProjectRoom(syncLayer, outputChannel);
    inboxProcessor = new InboxProcessor(vectorStore, syncLayer, outputChannel);
    pulseJob = new PulseJob(outputChannel);
    brainQuery = new BrainQuery(outputChannel);

    // ─── Webview Sidebar ───
    sidebarProvider = new SidebarViewProvider(
        context.extensionUri,
        vectorStore,
        outputChannel
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SidebarViewProvider.viewType,
            sidebarProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // ─── React to Project Room Events ───
    projectRoom.onDidJoin((config) => {
        sidebarProvider.setProjectConfig(config);
        sidebarProvider.setSyncStatus(syncLayer.isActive());
        sidebarProvider.refresh();
        statusBar.setTeamMode(config.projectCode);
    });

    projectRoom.onDidLeave(() => {
        sidebarProvider.showWelcome();
        statusBar.setIdle();
    });

    // Check if summarizer is configured (Railway URL or Groq API key)
    if (!summarizer.isConfigured()) {
        statusBar.setUnconfigured();
        vscode.window.showInformationMessage(
            'Conflux: Configure Railway URL or Groq API key in Settings.',
            'Open Settings'
        ).then((selection) => {
            if (selection === 'Open Settings') {
                vscode.commands.executeCommand(
                    'workbench.action.openSettings',
                    'conflux'
                );
            }
        });
    }

    // Initialize last-processed state for open documents
    diffTracker.initializeOpenDocuments();

    // Initialize vector store, embedder, MCP, inbox, and pulse in background
    initializeSubsystems(context);

    // ─── Write Path A: File Diffs → Significance → Summarize → Store ───
    diffTracker.onDiff(async (diff) => {
        const config = vscode.workspace.getConfiguration('conflux');
        if (!config.get<boolean>('enabled', true)) {
            return;
        }

        if (!summarizer.isConfigured()) {
            return;
        }

        // Run the Significance Detector (replaces minDiffLines)
        const significance = detectSignificance(diff.diff, diff.fileName);

        outputChannel.appendLine(
            `[Conflux] Diff for ${diff.fileName}: ${diff.totalChangedLines} lines changed | ` +
            `Significant: ${significance.significant} (${significance.category}: ${significance.reason})`
        );

        // Record in pulse job regardless of significance
        pulseJob.recordChange({
            diff,
            timestamp: Date.now(),
            significant: significance.significant,
            category: significance.category,
        });

        if (!significance.significant) {
            return; // Skip non-architectural changes
        }

        // Significant change detected — process it
        statusBar.setProcessing(diff.fileName);

        // Set FLUSH_REQUESTED for the MCP resource
        pulseJob.setFlushRequested(
            `File change: ${significance.reason} in ${diff.fileName}`
        );

        // Summarize via Railway/Groq
        const result = await summarizer.summarize(
            diff.diff,
            diff.fileName,
            diff.languageId
        );

        if (result) {
            outputChannel.appendLine(`[Conflux] Decision extracted: ${result.summary}`);
            statusBar.setDecision(result.summary);

            // Store in vector memory
            const decision: Decision = {
                summary: result.summary,
                filePath: diff.filePath,
                fileName: diff.fileName,
                languageId: diff.languageId,
                author: os.userInfo().username || 'unknown',
                timestamp: new Date().toISOString(),
                confidence: 'pending',
            };

            const stored = await vectorStore.storeDecision(decision);
            if (stored) {
                const count = await vectorStore.getDecisionCount();
                outputChannel.appendLine(`[Conflux] Total decisions in memory: ${count}`);

                // Broadcast to teammates (Supabase sync)
                syncLayer.broadcastDecision(decision);

                // Live update sidebar (push single decision, no full refresh)
                sidebarProvider.addDecision(decision);
            }

            // Show subtle notification
            vscode.window.setStatusBarMessage(
                `$(brain) Conflux: ${result.summary}`,
                8000
            );
        } else {
            statusBar.setIdle();
        }
    });

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('conflux.queryMemory', async () => {
            const query = await vscode.window.showInputBox({
                prompt: 'Ask the Team Brain anything about your project',
                placeHolder: 'e.g., Where are we? What auth method did we choose? What\'s left to build?',
            });

            if (!query) {
                return;
            }

            // Show progress
            statusBar.setProcessing('Team Brain thinking...');

            // Get all decisions and send to AMD 70B
            const decisions = await vectorStore.getAllDecisions();
            const answer = await brainQuery.ask(query, decisions);

            statusBar.setIdle();

            // Show in a webview panel
            const panel = vscode.window.createWebviewPanel(
                'confluxBrain',
                'Conflux Team Brain',
                vscode.ViewColumn.Beside,
                { enableScripts: false }
            );

            const decisionCount = decisions.length;
            const pending = decisions.filter(d => d.confidence === 'pending').length;
            const decided = decisions.filter(d => d.confidence === 'decided').length;

            panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         padding: 24px; max-width: 720px; margin: 0 auto;
         background: var(--vscode-editor-background, #1e1e1e);
         color: var(--vscode-foreground, #d4d4d4); line-height: 1.6; }
  h1 { color: var(--vscode-textLink-foreground, #4fc3f7); font-size: 1.2em; margin-bottom: 4px; }
  .meta { color: var(--vscode-descriptionForeground, #888); font-size: 0.85em; margin-bottom: 20px; }
  .question { background: var(--vscode-editor-background, #252526); border-left: 3px solid var(--vscode-textLink-foreground, #4fc3f7);
              padding: 12px 16px; border-radius: 4px; margin-bottom: 20px;
              color: var(--vscode-textLink-foreground, #9cdcfe); font-style: italic; }
  .answer { background: var(--vscode-editor-background, #252526); padding: 16px 20px; border-radius: 6px;
            white-space: pre-wrap; font-size: 0.95em; line-height: 1.7; }
  .stats { display: flex; gap: 16px; margin-top: 20px;
           font-size: 0.8em; color: var(--vscode-descriptionForeground, #888); }
  .stat { background: var(--vscode-editor-inactiveSelectionBackground, #2d2d2d); padding: 6px 12px; border-radius: 4px; }
</style>
</head>
<body>
  <h1>🧠 Team Brain</h1>
  <div class="meta">Based on ${decisionCount} recorded team decisions</div>
  <div class="question">"${query.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"</div>
  <div class="answer">${answer.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</div>
  <div class="stats">
    <div class="stat">✅ ${decided} confirmed</div>
    <div class="stat">⏳ ${pending} pending</div>
  </div>
</body>
</html>`;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('conflux.showStatus', async () => {
            const count = await vectorStore.getDecisionCount();
            vscode.window.showInformationMessage(
                `Conflux: ${count} decisions stored in team memory.`
            );
        })
    );

    // Register refresh command for sidebar
    context.subscriptions.push(
        vscode.commands.registerCommand('conflux.refreshDecisions', () => {
            sidebarProvider.refresh();
        })
    );

    // Register project room commands (start/join/leave)
    projectRoom.registerCommands(context);

    // Watch for git commits to upgrade confidence ⏳ → ✅
    watchGitCommits(context);

    // Register disposables
    context.subscriptions.push(
        diffTracker, summarizer, statusBar, embedder, vectorStore,
        mcpManager, syncLayer, projectRoom, sidebarProvider,
        inboxProcessor, pulseJob, brainQuery, outputChannel
    );

    outputChannel.appendLine('[Conflux] Extension v2 activated successfully.');
}

/**
 * Initialize subsystems in the background (non-blocking).
 */
async function initializeSubsystems(context: vscode.ExtensionContext): Promise<void> {
    try {
        // Initialize vector store
        const storeReady = await vectorStore.initialize();
        if (storeReady) {
            outputChannel.appendLine('[Conflux] Vector store initialized.');

            // Refresh sidebar with existing decisions
            sidebarProvider.refresh();
        }

        // Check if we're already in a project room (restore from previous session)
        const savedConfig = projectRoom.getConfig(context);
        if (savedConfig) {
            sidebarProvider.setProjectConfig(savedConfig);
        }

        // Pre-warm the embedder
        embedder.warmup();

        // Initialize MCP server config
        await mcpManager.initialize(context);

        // Start inbox processor (watches .conflux/inbox/)
        inboxProcessor.initialize();

        // Start the 90-second pulse job
        pulseJob.start();

        // Wire pulse job to re-process unreported diffs through the pipeline
        pulseJob.onUnreported(async (diff) => {
            const result = await summarizer.summarize(
                diff.diff,
                diff.fileName,
                diff.languageId
            );

            if (result) {
                outputChannel.appendLine(
                    `[Conflux] Pulse: code-only decision captured: ${result.summary}`
                );

                const decision: Decision = {
                    summary: result.summary,
                    filePath: diff.filePath,
                    fileName: diff.fileName,
                    languageId: diff.languageId,
                    author: os.userInfo().username || 'unknown',
                    timestamp: new Date().toISOString(),
                    confidence: 'pending',
                };

                const stored = await vectorStore.storeDecision(decision);
                if (stored) {
                    syncLayer.broadcastDecision(decision);
                    sidebarProvider.addDecision(decision);
                }
            }
        });

    } catch (error) {
        outputChannel.appendLine(`[Conflux] Subsystem initialization failed: ${error}`);
    }
}

/**
 * Watch for git commits to upgrade decision confidence from ⏳ to ✅.
 */
function watchGitCommits(context: vscode.ExtensionContext): void {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return;
    }

    // Try using the VS Code Git extension API (not available in all forks)
    try {
        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (gitExtension) {
            // Ensure it's activated before accessing exports
            const activate = gitExtension.isActive
                ? Promise.resolve(gitExtension.exports)
                : gitExtension.activate();

            Promise.resolve(activate).then((exports) => {
                try {
                    const git = exports?.getAPI?.(1);
                    if (git) {
                        git.onDidChangeState?.(() => {
                            upgradeAllPendingDecisions();
                        });

                        for (const repo of git.repositories || []) {
                            repo.state?.onDidChange?.(() => {
                                upgradeAllPendingDecisions();
                            });
                        }

                        outputChannel.appendLine('[Conflux] Git integration active — commits will upgrade ⏳ → ✅');
                        return;
                    }
                } catch {
                    // Git API not compatible — fall through
                }
                // If git API not available, use file watcher
                watchGitHeadFile(context);
            }).catch(() => {
                watchGitHeadFile(context);
            });
            return;
        }
    } catch {
        // vscode.git extension not known in this IDE (Antigravity, etc.)
        outputChannel.appendLine('[Conflux] vscode.git not available — using file watcher fallback');
    }

    // Fallback: Watch .git/HEAD for changes
    watchGitHeadFile(context);
}

/**
 * Fallback: Watch .git/HEAD file for changes.
 */
function watchGitHeadFile(context: vscode.ExtensionContext): void {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return;
    }

    const gitHeadPath = path.join(workspaceFolders[0].uri.fsPath, '.git', 'HEAD');
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceFolders[0], '.git/refs/heads/**')
    );

    watcher.onDidChange(() => {
        outputChannel.appendLine('[Conflux] Git ref changed — upgrading pending decisions');
        upgradeAllPendingDecisions();
    });

    watcher.onDidCreate(() => {
        upgradeAllPendingDecisions();
    });

    context.subscriptions.push(watcher);
    outputChannel.appendLine('[Conflux] Git HEAD watcher active (fallback mode)');
}

/**
 * Upgrade all pending decisions to decided (called on git commit).
 */
async function upgradeAllPendingDecisions(): Promise<void> {
    try {
        const decisions = await vectorStore.getAllDecisions();
        let upgraded = 0;

        for (const decision of decisions) {
            if (decision.confidence === 'pending') {
                decision.confidence = 'decided';
                await vectorStore.upsertDecision(decision);
                upgraded++;
            }
        }

        if (upgraded > 0) {
            outputChannel.appendLine(
                `[Conflux] Upgraded ${upgraded} decisions from ⏳ to ✅`
            );
            sidebarProvider.refresh();

            // Subtle notification
            vscode.window.setStatusBarMessage(
                `$(check) Conflux: ${upgraded} decision${upgraded > 1 ? 's' : ''} confirmed by commit`,
                6000
            );
        }
    } catch (error) {
        outputChannel.appendLine(`[Conflux] Failed to upgrade decisions: ${error}`);
    }
}

export function deactivate(): void {
    // Cleanup handled by disposables
}
