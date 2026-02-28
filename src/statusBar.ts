/**
 * Status Bar Manager — Displays Conflux status and latest decision
 * in the VS Code status bar.
 *
 * VS Code API reference:
 * https://code.visualstudio.com/api/references/vscode-api#StatusBarItem
 */

import * as vscode from 'vscode';

export class StatusBarManager implements vscode.Disposable {
    private statusBarItem: vscode.StatusBarItem;
    private resetTimer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.statusBarItem.command = 'conflux.showStatus';
        this.setIdle();
        this.statusBarItem.show();
    }

    /**
     * Show idle state — Conflux is active but no recent decision.
     */
    public setIdle(): void {
        this.clearResetTimer();
        this.statusBarItem.text = '$(brain) Conflux';
        this.statusBarItem.tooltip = 'Conflux — Shared AI Team Memory (active)';
        this.statusBarItem.backgroundColor = undefined;
    }

    /**
     * Show team mode — connected to a project room.
     */
    public setTeamMode(projectCode: string): void {
        this.clearResetTimer();
        this.statusBarItem.text = `$(brain) Conflux · ${projectCode}`;
        this.statusBarItem.tooltip = `Conflux — Connected to project ${projectCode}`;
        this.statusBarItem.backgroundColor = undefined;
    }

    /**
     * Show processing state — a diff is being summarized.
     */
    public setProcessing(fileName: string): void {
        this.clearResetTimer();
        this.statusBarItem.text = `$(loading~spin) Conflux: Analyzing ${fileName}...`;
        this.statusBarItem.tooltip = `Summarizing changes in ${fileName}`;
    }

    /**
     * Show a decision was extracted — display the summary.
     * Automatically resets to idle after 10 seconds.
     */
    public setDecision(summary: string): void {
        this.clearResetTimer();

        // Truncate long summaries for the status bar
        const truncated = summary.length > 80
            ? summary.substring(0, 77) + '...'
            : summary;

        this.statusBarItem.text = `$(check) Decision: ${truncated}`;
        this.statusBarItem.tooltip = `Conflux Decision:\n${summary}`;

        // Reset to idle after 10 seconds
        this.resetTimer = setTimeout(() => {
            this.setIdle();
        }, 10000);
    }

    /**
     * Show an error state.
     */
    public setError(message: string): void {
        this.clearResetTimer();
        this.statusBarItem.text = `$(warning) Conflux: ${message}`;
        this.statusBarItem.tooltip = message;

        // Reset to idle after 5 seconds
        this.resetTimer = setTimeout(() => {
            this.setIdle();
        }, 5000);
    }

    /**
     * Show unconfigured state — API key missing.
     */
    public setUnconfigured(): void {
        this.clearResetTimer();
        this.statusBarItem.text = '$(key) Conflux: Set API Key';
        this.statusBarItem.tooltip = 'Click to configure Groq API key for Conflux';
        this.statusBarItem.command = 'workbench.action.openSettings';
    }

    private clearResetTimer(): void {
        if (this.resetTimer) {
            clearTimeout(this.resetTimer);
            this.resetTimer = null;
        }
    }

    public dispose(): void {
        this.clearResetTimer();
        this.statusBarItem.dispose();
    }
}
