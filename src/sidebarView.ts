/**
 * Sidebar View v2 — Webview-based sidebar with 4 tabs.
 *
 * Replaces the old TreeDataProvider with a WebviewViewProvider
 * that renders beautiful HTML with decision cards, team presence,
 * and contextual insights.
 *
 * Tabs: Home | Brain | Team | Insights
 *
 * Communication: Extension ↔ Webview via postMessage
 *   Extension → Webview: setProjectConfig, setDecisions, addDecision, setMembers, etc.
 *   Webview → Extension: startProject, joinProject, queryBrain, openFile
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { VectorStore, Decision } from './vectorStore';

export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'conflux.decisions';

    private _view?: vscode.WebviewView;
    private vectorStore: VectorStore;
    private outputChannel: vscode.OutputChannel;
    private extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];

    constructor(
        extensionUri: vscode.Uri,
        vectorStore: VectorStore,
        outputChannel: vscode.OutputChannel
    ) {
        this.extensionUri = extensionUri;
        this.vectorStore = vectorStore;
        this.outputChannel = outputChannel;
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

        // Load the sidebar HTML
        webviewView.webview.html = this.getHtml(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(
            (message) => this.handleMessage(message),
            undefined,
            this.disposables
        );

        // When the view becomes visible, refresh data
        webviewView.onDidChangeVisibility(
            () => {
                if (webviewView.visible) {
                    this.refresh();
                }
            },
            undefined,
            this.disposables
        );
    }

    /**
     * Handle messages from the webview.
     */
    private handleMessage(message: any): void {
        switch (message.command) {
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
                if (message.path) {
                    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(message.path));
                }
                break;
        }
    }

    /**
     * Set the project config — switches from welcome screen to main UI.
     */
    public setProjectConfig(config: any): void {
        this.postMessage({ type: 'setProjectConfig', config });
    }

    /**
     * Show the welcome screen (user left a project).
     */
    public showWelcome(): void {
        this.postMessage({ type: 'showWelcome' });
    }

    /**
     * Refresh all decisions from the vector store.
     */
    public async refresh(): Promise<void> {
        try {
            const allDecisions = await this.vectorStore.getAllDecisions();
            // Sort by timestamp descending (newest first)
            allDecisions.sort((a, b) =>
                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            );
            this.postMessage({ type: 'setDecisions', decisions: allDecisions });
        } catch (error) {
            this.outputChannel.appendLine(`[Conflux] Failed to refresh sidebar: ${error}`);
        }
    }

    /**
     * Push a single new decision (live update, no full refresh).
     */
    public addDecision(decision: Decision): void {
        this.postMessage({ type: 'addDecision', decision });
    }

    /**
     * Update the online members list.
     */
    public setMembers(members: Array<{ name: string; isOnline: boolean; isAway?: boolean; lastSeen?: string; activeFile?: string }>): void {
        this.postMessage({ type: 'setMembers', members });
    }

    /**
     * Update the sync connection status.
     */
    public setSyncStatus(active: boolean): void {
        this.postMessage({ type: 'setSyncStatus', active });
    }

    /**
     * Set insights (conflicts, gaps).
     */
    public setInsights(insights: Array<{ type: 'warning' | 'info'; title: string; body: string }>): void {
        this.postMessage({ type: 'setInsights', insights });
    }

    /**
     * Navigate to a specific tab.
     */
    public navigateToTab(tab: 'home' | 'brain' | 'team' | 'insights'): void {
        this.postMessage({ type: 'navigateTab', tab });
    }

    /**
     * Post a message to the webview (if it's available).
     */
    private postMessage(message: any): void {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    /**
     * Load the sidebar HTML from disk.
     */
    private getHtml(webview: vscode.Webview): string {
        const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'sidebar.html');

        try {
            return fs.readFileSync(htmlPath, 'utf-8');
        } catch {
            // Fallback if file not found
            return `<!DOCTYPE html>
<html><body>
<h2>Conflux sidebar not found</h2>
<p>Expected at: ${htmlPath}</p>
</body></html>`;
        }
    }

    public dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
    }
}
