/**
 * Pulse Job — 90-second background timer for capturing code-only decisions.
 *
 * Cross-correlates file changes with MCP tool call timestamps.
 * If file changes happened but the MCP tool wasn't called in that window,
 * those are "code-only decisions" — captured silently by the extension.
 *
 * Also triggers FLUSH_REQUESTED in the MCP resource when the significance
 * detector fires but the AI hasn't reported.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DiffResult } from './diffTracker';

const PULSE_INTERVAL_MS = 90_000; // 90 seconds

export interface PendingChange {
    diff: DiffResult;
    timestamp: number;
    significant: boolean;
    category: string;
}

export class PulseJob implements vscode.Disposable {
    private timer: ReturnType<typeof setInterval> | null = null;
    private pendingChanges: PendingChange[] = [];
    private lastMcpCallTimestamp: number = 0;
    private confluxDir: string = '';
    private outputChannel: vscode.OutputChannel;
    private onUnreportedDiff: ((diff: DiffResult) => void) | null = null;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    /**
     * Start the 90-second pulse job.
     */
    public start(): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }

        this.confluxDir = path.join(workspaceFolders[0].uri.fsPath, '.conflux');

        this.timer = setInterval(() => {
            this.pulse();
        }, PULSE_INTERVAL_MS);

        this.outputChannel.appendLine('[Conflux] Pulse job started (90-second interval).');
    }

    /**
     * Register a callback for unreported diffs (code-only decisions).
     * These will be sent to Railway for summarization.
     */
    public onUnreported(callback: (diff: DiffResult) => void): void {
        this.onUnreportedDiff = callback;
    }

    /**
     * Record a significant file change from the diff pipeline.
     */
    public recordChange(change: PendingChange): void {
        this.pendingChanges.push(change);
    }

    /**
     * Record that the MCP tool was called (the AI reported).
     * Called by the inbox processor when it picks up a report file.
     */
    public recordMcpCall(): void {
        this.lastMcpCallTimestamp = Date.now();
    }

    /**
     * The 90-second pulse. Cross-correlates file changes with MCP calls.
     */
    private pulse(): void {
        if (this.pendingChanges.length === 0) {
            return;
        }

        const now = Date.now();
        const windowStart = now - PULSE_INTERVAL_MS;

        // Find changes that happened in the last window
        const recentChanges = this.pendingChanges.filter(
            c => c.timestamp > windowStart && c.significant
        );

        if (recentChanges.length === 0) {
            // Clean up old changes
            this.pendingChanges = this.pendingChanges.filter(
                c => c.timestamp > windowStart
            );
            return;
        }

        // Check: did the MCP tool get called in this window?
        const mcpCalledInWindow = this.lastMcpCallTimestamp > windowStart;

        if (!mcpCalledInWindow) {
            // Code-only decisions — the AI never reported.
            // Send these to the diff pipeline for summarization.
            this.outputChannel.appendLine(
                `[Conflux] Pulse: ${recentChanges.length} unreported significant changes detected.`
            );

            for (const change of recentChanges) {
                if (this.onUnreportedDiff) {
                    this.onUnreportedDiff(change.diff);
                }
            }

            // Also set FLUSH_REQUESTED so the AI calls conflux_report next time
            this.setFlushRequested(
                `${recentChanges.length} significant file change(s) not reported via chat`
            );
        }

        // Clean up processed changes
        this.pendingChanges = this.pendingChanges.filter(
            c => c.timestamp > now
        );
    }

    /**
     * Set the FLUSH_REQUESTED flag in .conflux/flush_state.json.
     * The MCP server reads this and injects it into the project-state resource.
     */
    public setFlushRequested(reason: string): void {
        const stateFile = path.join(this.confluxDir, 'flush_state.json');
        try {
            if (!fs.existsSync(this.confluxDir)) {
                fs.mkdirSync(this.confluxDir, { recursive: true });
            }
            fs.writeFileSync(stateFile, JSON.stringify({
                flush_requested: true,
                reason: reason,
                timestamp: new Date().toISOString(),
            }), 'utf-8');
        } catch {
            // Fail silently
        }
    }

    public dispose(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
