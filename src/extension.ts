/**
 * Conflux Extension v2 — Main Entry Point
 *
 * ARCHITECTURE: Static imports ensure esbuild bundles ALL modules inline.
 * The webview sidebar is still crash-proof (inline class, no deps).
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// ─── STATIC imports — esbuild resolves these at compile time ───
import { StatusBarManager } from './statusBar';
import { DiffTracker } from './diffTracker';
import { LlmSummarizer } from './llmSummarizer';
import { Embedder } from './embedder';
import { VectorStore } from './vectorStore';
import { McpManager } from './mcpManager';
import { SyncLayer, TeamMember } from './syncLayer';
import { ProjectRoom } from './projectRoom';
import { detectSignificance } from './significanceDetector';
import { InboxProcessor } from './inboxProcessor';
import { PulseJob } from './pulseJob';
import { BrainQuery } from './brainQuery';

// ─── Minimal, crash-proof webview provider (inline, no deps) ───

class MinimalSidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'conflux.decisions';
    private _view?: vscode.WebviewView;
    private extensionUri: vscode.Uri;
    private messageHandler?: (msg: any) => void;

    constructor(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
        };

        webviewView.webview.html = this.getHtml();

        webviewView.webview.onDidReceiveMessage((msg) => {
            if (this.messageHandler) {
                this.messageHandler(msg);
            }
        });
    }

    public onMessage(handler: (msg: any) => void): void {
        this.messageHandler = handler;
    }

    public postMessage(message: any): void {
        this._view?.webview.postMessage(message);
    }

    private getHtml(): string {
        const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'sidebar.html');
        try {
            return fs.readFileSync(htmlPath, 'utf-8');
        } catch {
            return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<style>
  body { font-family: sans-serif; text-align: center; padding: 40px 16px;
         background: var(--vscode-sideBar-background, #1e1e1e);
         color: var(--vscode-foreground, #ccc); }
  h1 { font-size: 1.4em; }
  p { color: var(--vscode-descriptionForeground, #888); font-size: 0.9em; margin: 12px 0; }
  button { padding: 10px 16px; border: none; border-radius: 4px; cursor: pointer;
           font-size: 0.92em; width: 200px; margin: 5px 0; }
  .primary { background: var(--vscode-button-background, #007acc);
             color: var(--vscode-button-foreground, #fff); }
  .secondary { background: var(--vscode-button-secondaryBackground, #333);
               color: var(--vscode-button-secondaryForeground, #ccc); }
</style>
<script>
  const vscode = acquireVsCodeApi();
  function cmd(c) { vscode.postMessage({ command: c }); }
</script>
</head><body>
  <h1>🧠 Conflux</h1>
  <p>Shared context for your whole team's AI.</p>
  <button class="primary" onclick="cmd('startProject')">Start a New Project</button><br>
  <button class="secondary" onclick="cmd('joinProject')">Join Your Team</button>
  <p style="font-size:0.8em;margin-top:20px;">Works alone too — just start coding.</p>
</body></html>`;
        }
    }
}

// ─── activate() ───

export function activate(context: vscode.ExtensionContext): void {
    console.log('[Conflux] Activating...');

    // STEP 1: Register sidebar webview IMMEDIATELY (always works)
    const sidebar = new MinimalSidebarProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            MinimalSidebarProvider.viewType,
            sidebar,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    sidebar.onMessage((msg) => {
        switch (msg.command) {
            case 'startProject':
                vscode.commands.executeCommand('conflux.startProject');
                break;
            case 'joinProject':
                vscode.commands.executeCommand('conflux.joinProject');
                break;
            case 'queryBrain':
                vscode.commands.executeCommand('conflux.queryMemory');
                break;
            case 'openFile':
                if (msg.path) {
                    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path));
                }
                break;
        }
    });

    console.log('[Conflux] Sidebar registered.');

    // STEP 2: Initialize subsystems
    initializeSubsystems(context, sidebar);
}

function initializeSubsystems(
    context: vscode.ExtensionContext,
    sidebar: MinimalSidebarProvider,
): void {
    const outputChannel = vscode.window.createOutputChannel('Conflux');
    context.subscriptions.push(outputChannel);
    outputChannel.appendLine('[Conflux] Starting subsystem initialization...');
    vscode.window.showInformationMessage('[Conflux DEBUG] initializeSubsystems entered');

    let statusBar: StatusBarManager;
    let diffTracker: DiffTracker;
    let summarizer: LlmSummarizer;
    let embedder: Embedder;
    let vectorStore: VectorStore;
    let mcpManager: McpManager;
    let syncLayer: SyncLayer;
    let projectRoom: ProjectRoom;
    let inboxProcessor: InboxProcessor;
    let pulseJob: PulseJob;
    let brainQuery: BrainQuery;

    try {
        statusBar = new StatusBarManager();
        summarizer = new LlmSummarizer(outputChannel);
        diffTracker = new DiffTracker();
        embedder = new Embedder(outputChannel);
        vectorStore = new VectorStore(embedder, outputChannel);
        mcpManager = new McpManager(outputChannel);
        syncLayer = new SyncLayer(vectorStore, outputChannel);
        projectRoom = new ProjectRoom(syncLayer, outputChannel);
        inboxProcessor = new InboxProcessor(vectorStore, syncLayer, outputChannel);
        pulseJob = new PulseJob(outputChannel);
        brainQuery = new BrainQuery(outputChannel);
        outputChannel.appendLine('[Conflux] All components created.');
        vscode.window.showInformationMessage('[Conflux DEBUG] All 11 components created OK');
    } catch (err: any) {
        outputChannel.appendLine(`[Conflux] FATAL: Component creation failed: ${err.message}`);
        outputChannel.appendLine(err.stack || '');
        vscode.window.showErrorMessage(`Conflux failed to load: ${err.message}`);
        return;
    }

    // ─── React to Project Room Events ───
    projectRoom.onDidJoin((config) => {
        sidebar.postMessage({ type: 'setProjectConfig', config });
        sidebar.postMessage({ type: 'setSyncStatus', active: syncLayer.isActive() });
        statusBar.setTeamMode(config.projectCode);
        refreshDecisions();

        // Start presence heartbeats
        syncLayer.startPresence(config.displayName);
    });

    projectRoom.onDidLeave(() => {
        sidebar.postMessage({ type: 'showWelcome' });
        statusBar.setIdle();
        syncLayer.stopPresence();
    });

    // Listen for presence updates
    syncLayer.onPresenceUpdate((members: TeamMember[]) => {
        sidebar.postMessage({ type: 'setTeamMembers', members });
        outputChannel.appendLine(`[Conflux] Team update: ${members.map((m: any) => m.name).join(', ')}`);
    });

    // ─── Config check ───
    if (!summarizer.isConfigured()) {
        statusBar.setUnconfigured();
    }

    // Initialize open docs
    try { diffTracker.initializeOpenDocuments(); } catch { }

    // ─── Vector Store Init ───
    (async () => {
        try {
            const storeReady = await vectorStore.initialize();
            if (storeReady) {
                outputChannel.appendLine('[Conflux] Vector store initialized.');
                refreshDecisions();
            }
        } catch (err: any) {
            outputChannel.appendLine(`[Conflux] Vector store init failed: ${err.message}`);
        }
    })();

    // ─── MCP, Inbox, Pulse ───
    (async () => {
        try { await mcpManager.initialize(context); } catch { }
        try { inboxProcessor.initialize(); } catch { }
        try { pulseJob.start(); } catch { }
        try { embedder.warmup(); } catch { }
    })();

    // ─── Refresh helper ───
    async function refreshDecisions() {
        try {
            const allDecisions = await vectorStore.getAllDecisions();
            allDecisions.sort((a: any, b: any) =>
                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            );
            sidebar.postMessage({ type: 'setDecisions', decisions: allDecisions });
        } catch { }
    }

    // ─── Write Path: file diffs → significance → summarize → store ───
    diffTracker.onDiff(async (diff) => {
        try {
            vscode.window.showInformationMessage(`[Conflux DEBUG] Diff detected: ${diff.fileName} (${diff.totalChangedLines} lines)`);
            outputChannel.appendLine(`[Conflux DEBUG] Diff callback fired for ${diff.fileName}`);

            const config = vscode.workspace.getConfiguration('conflux');
            if (!config.get<boolean>('enabled', true)) {
                vscode.window.showWarningMessage('[Conflux DEBUG] Extension disabled in settings!');
                return;
            }
            if (!summarizer.isConfigured()) {
                vscode.window.showWarningMessage('[Conflux DEBUG] Summarizer not configured! railwayUrl and groqKey both empty.');
                return;
            }

            const significance = detectSignificance(diff.diff, diff.fileName);
            outputChannel.appendLine(
                `[Conflux] Diff for ${diff.fileName}: ${diff.totalChangedLines} lines | ` +
                `Significant: ${significance.significant} (${significance.category}: ${significance.reason})`
            );

            if (pulseJob) {
                pulseJob.recordChange({
                    diff, timestamp: Date.now(),
                    significant: significance.significant,
                    category: significance.category,
                });
            }

            if (!significance.significant) {
                vscode.window.showInformationMessage(`[Conflux DEBUG] Change not significant: ${significance.reason}`);
                return;
            }
            vscode.window.showInformationMessage(`[Conflux DEBUG] Significant! Calling LLM via subprocess...`);

            statusBar.setProcessing(diff.fileName);

            if (pulseJob) {
                try { pulseJob.setFlushRequested(`File change: ${significance.reason} in ${diff.fileName}`); } catch { }
            }

            const result = await summarizer.summarize(diff.diff, diff.fileName, diff.languageId);

            if (result) {
                vscode.window.showInformationMessage(`[Conflux DEBUG] LLM returned: "${result.summary.substring(0, 60)}..."`);
                outputChannel.appendLine(`[Conflux] Decision: ${result.summary}`);
                statusBar.setDecision(result.summary);

                const decision = {
                    summary: result.summary,
                    filePath: diff.filePath,
                    fileName: diff.fileName,
                    languageId: diff.languageId,
                    author: os.userInfo().username || 'unknown',
                    timestamp: new Date().toISOString(),
                    confidence: 'pending' as const,
                };

                try {
                    const stored = await vectorStore.storeDecision(decision);
                    if (stored) {
                        vscode.window.showInformationMessage(`[Conflux DEBUG] Decision stored + broadcast OK`);
                        syncLayer.broadcastDecision(decision);
                        sidebar.postMessage({ type: 'addDecision', decision });
                    } else {
                        vscode.window.showWarningMessage(`[Conflux DEBUG] vectorStore.storeDecision returned false`);
                    }
                } catch (storeErr: any) {
                    vscode.window.showErrorMessage(`[Conflux DEBUG] Store CRASHED: ${storeErr.message}`);
                    outputChannel.appendLine(`[Conflux] Store error: ${storeErr.stack || storeErr.message}`);
                }

                vscode.window.setStatusBarMessage(`$(brain) Conflux: ${result.summary}`, 8000);
            } else {
                vscode.window.showWarningMessage(`[Conflux DEBUG] LLM returned NULL — check Output > Conflux for details`);
                statusBar.setIdle();
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`[Conflux DEBUG] WRITE PATH CRASHED: ${err.message}`);
            outputChannel.appendLine(`[Conflux] Write path crash: ${err.stack || err.message}`);
        }
    });

    // ─── Commands ───
    context.subscriptions.push(
        vscode.commands.registerCommand('conflux.queryMemory', async () => {
            const query = await vscode.window.showInputBox({
                prompt: 'Ask the Team Brain anything about your project',
                placeHolder: "e.g., How should I implement login? What's our auth strategy?",
            });
            if (!query) { return; }
            statusBar.setProcessing('Team Brain thinking...');
            try {
                const decisions = await vectorStore.getAllDecisions();
                const answer = await brainQuery.ask(query, decisions);
                statusBar.setIdle();

                const panel = vscode.window.createWebviewPanel(
                    'confluxBrain', 'Conflux Team Brain',
                    vscode.ViewColumn.Beside, { enableScripts: false }
                );

                const count = decisions.length;
                const decided = decisions.filter((d: any) => d.confidence === 'decided').length;
                const pending = count - decided;

                panel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body{font-family:sans-serif;padding:24px;max-width:720px;margin:0 auto;
background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-foreground,#d4d4d4);line-height:1.6}
h1{color:var(--vscode-textLink-foreground,#4fc3f7);font-size:1.2em;margin-bottom:4px}
.meta{color:var(--vscode-descriptionForeground,#888);font-size:0.85em;margin-bottom:20px}
.q{background:var(--vscode-editor-background,#252526);border-left:3px solid var(--vscode-textLink-foreground,#4fc3f7);
padding:12px 16px;border-radius:4px;margin-bottom:20px;color:#9cdcfe;font-style:italic}
.a{background:var(--vscode-editor-background,#252526);padding:16px 20px;border-radius:6px;
white-space:pre-wrap;font-size:0.95em;line-height:1.7}
.stats{display:flex;gap:16px;margin-top:20px;font-size:0.8em;color:var(--vscode-descriptionForeground,#888)}
.stat{background:var(--vscode-editor-inactiveSelectionBackground,#2d2d2d);padding:6px 12px;border-radius:4px}
</style></head><body>
<h1>🧠 Team Brain</h1>
<div class="meta">Based on ${count} recorded team decisions</div>
<div class="q">"${escHtml(query)}"</div>
<div class="a">${escHtml(answer).replace(/\n/g, '<br>')}</div>
<div class="stats"><div class="stat">✅ ${decided} confirmed</div><div class="stat">⏳ ${pending} pending</div></div>
</body></html>`;
            } catch {
                statusBar.setIdle();
                vscode.window.showErrorMessage('Conflux: Failed to query Team Brain.');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('conflux.showStatus', async () => {
            try {
                const count = await vectorStore.getDecisionCount();
                vscode.window.showInformationMessage(`Conflux: ${count} decisions in team memory.`);
            } catch {
                vscode.window.showInformationMessage('Conflux: Team memory not initialized yet.');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('conflux.refreshDecisions', () => { refreshDecisions(); })
    );

    // Register project room commands
    try { projectRoom.registerCommands(context); } catch { }

    // ─── Git Commit Watcher (confidence upgrade ⏳ → ✅) ───
    watchGitCommits(context, vectorStore, sidebar, outputChannel, refreshDecisions);

    // Register disposables
    context.subscriptions.push(
        diffTracker, summarizer, statusBar, embedder, vectorStore,
        mcpManager, syncLayer, projectRoom,
        inboxProcessor, pulseJob, brainQuery
    );

    outputChannel.appendLine('[Conflux] Extension v2 activated successfully.');
}

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function watchGitCommits(
    context: vscode.ExtensionContext,
    vectorStore: VectorStore,
    sidebar: MinimalSidebarProvider,
    outputChannel: vscode.OutputChannel,
    refreshDecisions: () => Promise<void>,
): void {
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { return; }

        try {
            const gitExt = vscode.extensions.getExtension('vscode.git');
            if (gitExt) {
                const doGit = (exports: any) => {
                    try {
                        const git = exports?.getAPI?.(1);
                        if (git) {
                            git.onDidChangeState?.(() => { upgradeAll(); });
                            for (const repo of git.repositories || []) {
                                repo.state?.onDidChange?.(() => { upgradeAll(); });
                            }
                            outputChannel.appendLine('[Conflux] Git integration active.');
                        }
                    } catch { }
                };
                if (gitExt.isActive) { doGit(gitExt.exports); }
                else { gitExt.activate().then(doGit).catch(() => { }); }
            }
        } catch {
            outputChannel.appendLine('[Conflux] vscode.git not available — using fallback.');
        }

        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceFolders[0], '.git/refs/heads/**')
        );
        watcher.onDidChange(() => { upgradeAll(); });
        watcher.onDidCreate(() => { upgradeAll(); });
        context.subscriptions.push(watcher);

        async function upgradeAll() {
            try {
                const decisions = await vectorStore.getAllDecisions();
                let upgraded = 0;
                for (const d of decisions) {
                    if (d.confidence === 'pending') {
                        d.confidence = 'decided';
                        await vectorStore.upsertDecision(d);
                        upgraded++;
                    }
                }
                if (upgraded > 0) {
                    outputChannel.appendLine(`[Conflux] Upgraded ${upgraded} decisions ⏳ → ✅`);
                    refreshDecisions();
                    vscode.window.setStatusBarMessage(
                        `$(check) Conflux: ${upgraded} decision${upgraded > 1 ? 's' : ''} confirmed`, 6000
                    );
                }
            } catch { }
        }
    } catch { }
}

export function deactivate(): void { }
