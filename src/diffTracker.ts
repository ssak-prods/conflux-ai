/**
 * DiffTracker — Tracks per-file buffer state and computes diffs.
 *
 * Uses workspace.onDidChangeTextDocument (fires on every buffer change,
 * including Cursor "Apply Changes") with an 8-second debounce to avoid
 * processing during active typing.
 *
 * VS Code API reference:
 * https://code.visualstudio.com/api/references/vscode-api#workspace.onDidChangeTextDocument
 */

import * as vscode from 'vscode';

export interface DiffResult {
    filePath: string;
    fileName: string;
    languageId: string;
    diff: string;
    addedLines: number;
    removedLines: number;
    totalChangedLines: number;
}

export class DiffTracker implements vscode.Disposable {
    /**
     * Stores the last processed content for each file URI.
     * Key: file URI string, Value: file content at last processing.
     */
    private lastProcessedContent: Map<string, string> = new Map();

    /**
     * Active debounce timers per file URI.
     * Key: file URI string, Value: NodeJS timeout handle.
     */
    private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

    /**
     * Max accumulation timers per file URI.
     * Forces processing after 60 seconds even during continuous typing.
     */
    private accumulationTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

    /**
     * Timestamp of first edit in current window per file URI.
     */
    private firstEditTimestamp: Map<string, number> = new Map();

    /**
     * Callback invoked when a file change is ready to be processed (after debounce).
     */
    private onDiffReady: ((diff: DiffResult) => void) | null = null;

    private disposables: vscode.Disposable[] = [];
    private debounceMs: number;
    private maxAccumulationMs: number = 60000; // 60 seconds

    constructor() {
        const config = vscode.workspace.getConfiguration('conflux');
        this.debounceMs = config.get<number>('debounceMs', 8000);

        // Listen for configuration changes
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('conflux.debounceMs')) {
                    this.debounceMs = vscode.workspace.getConfiguration('conflux').get<number>('debounceMs', 8000);
                }
            })
        );

        // Listen for text document changes (fires on every buffer mutation,
        // including Cursor "Apply Changes", typing, undo, redo, paste)
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument((event) => {
                this.handleDocumentChange(event);
            })
        );
    }

    /**
     * Register a callback for when a diff is ready (after debounce).
     */
    public onDiff(callback: (diff: DiffResult) => void): void {
        this.onDiffReady = callback;
    }

    /**
     * Handle a text document change event.
     * Resets the debounce timer for the affected file.
     */
    private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
        const doc = event.document;

        // Skip non-file schemes (output panels, git diffs, settings, etc.)
        if (doc.uri.scheme !== 'file') {
            return;
        }

        // Skip if no actual content changes (dirty-state changes also fire this event)
        if (event.contentChanges.length === 0) {
            return;
        }

        const uriString = doc.uri.toString();

        // Track first edit timestamp for accumulation window
        if (!this.firstEditTimestamp.has(uriString)) {
            this.firstEditTimestamp.set(uriString, Date.now());
        }

        // Clear any existing debounce timer for this file
        const existingTimer = this.debounceTimers.get(uriString);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        // Set new debounce timer — only process after 8 seconds of inactivity
        const timer = setTimeout(() => {
            this.debounceTimers.delete(uriString);
            this.accumulationTimers.delete(uriString);
            this.firstEditTimestamp.delete(uriString);
            this.processFile(doc);
        }, this.debounceMs);

        this.debounceTimers.set(uriString, timer);

        // Set max accumulation timer (60s) — forces processing even during continuous typing
        if (!this.accumulationTimers.has(uriString)) {
            const accTimer = setTimeout(() => {
                // Force process: clear the debounce timer and process now
                const pendingDebounce = this.debounceTimers.get(uriString);
                if (pendingDebounce) {
                    clearTimeout(pendingDebounce);
                    this.debounceTimers.delete(uriString);
                }
                this.accumulationTimers.delete(uriString);
                this.firstEditTimestamp.delete(uriString);
                this.processFile(doc);
            }, this.maxAccumulationMs);

            this.accumulationTimers.set(uriString, accTimer);
        }
    }

    /**
     * Process a file after the debounce window has elapsed.
     * Computes the diff between the last processed state and current buffer.
     */
    private processFile(doc: vscode.TextDocument): void {
        const uriString = doc.uri.toString();
        const currentContent = doc.getText();
        const previousContent = this.lastProcessedContent.get(uriString) ?? '';

        // Compute a simple line-based diff
        const diff = this.computeDiff(previousContent, currentContent);

        if (!diff) {
            return; // No meaningful changes
        }

        // Always update the baseline to prevent stale diffs accumulating.
        // Significance detection is handled downstream by SignificanceDetector.
        this.lastProcessedContent.set(uriString, currentContent);

        // Build the diff result
        const result: DiffResult = {
            filePath: doc.uri.fsPath,
            fileName: doc.uri.fsPath.split(/[/\\]/).pop() ?? 'unknown',
            languageId: doc.languageId,
            diff: diff.diffText,
            addedLines: diff.added,
            removedLines: diff.removed,
            totalChangedLines: diff.totalChangedLines,
        };

        // Invoke the callback
        if (this.onDiffReady) {
            this.onDiffReady(result);
        }
    }

    /**
     * Compute a simple unified-style diff between two text contents.
     * Returns null if the contents are identical.
     */
    private computeDiff(
        oldContent: string,
        newContent: string
    ): { diffText: string; added: number; removed: number; totalChangedLines: number } | null {
        if (oldContent === newContent) {
            return null;
        }

        const oldLines = oldContent.split('\n');
        const newLines = newContent.split('\n');

        // Simple line-by-line comparison to generate a pseudo-unified diff
        const diffLines: string[] = [];
        let added = 0;
        let removed = 0;

        // Use a simple LCS-based approach for generating diff
        const maxLen = Math.max(oldLines.length, newLines.length);
        const oldSet = new Set(oldLines.map((line, i) => `${i}:${line}`));
        const newSet = new Set(newLines.map((line, i) => `${i}:${line}`));

        // Find removed lines (in old but not in new by content)
        const oldContentSet = new Set(oldLines);
        const newContentSet = new Set(newLines);

        // Track which lines were added/removed by position
        let oi = 0, ni = 0;
        while (oi < oldLines.length || ni < newLines.length) {
            if (oi < oldLines.length && ni < newLines.length) {
                if (oldLines[oi] === newLines[ni]) {
                    // Context line (skip to keep diff compact)
                    oi++;
                    ni++;
                } else {
                    // Check if current old line was removed
                    const oldLineInNew = newLines.indexOf(oldLines[oi], ni);
                    const newLineInOld = oldLines.indexOf(newLines[ni], oi);

                    if (oldLineInNew === -1 || (newLineInOld !== -1 && newLineInOld - oi <= oldLineInNew - ni)) {
                        // Old line was removed or modified
                        diffLines.push(`- ${oldLines[oi]}`);
                        removed++;
                        oi++;
                    } else {
                        // New line was added
                        diffLines.push(`+ ${newLines[ni]}`);
                        added++;
                        ni++;
                    }
                }
            } else if (oi < oldLines.length) {
                diffLines.push(`- ${oldLines[oi]}`);
                removed++;
                oi++;
            } else {
                diffLines.push(`+ ${newLines[ni]}`);
                added++;
                ni++;
            }
        }

        const totalChangedLines = added + removed;
        if (totalChangedLines === 0) {
            return null;
        }

        return {
            diffText: diffLines.join('\n'),
            added,
            removed,
            totalChangedLines,
        };
    }

    /**
     * Initialize the last-processed state for all currently open documents.
     * Called on extension activation to avoid processing the initial load as a "change".
     */
    public initializeOpenDocuments(): void {
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.uri.scheme === 'file') {
                this.lastProcessedContent.set(doc.uri.toString(), doc.getText());
            }
        }
    }

    public dispose(): void {
        // Clear all debounce timers
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();

        // Clear accumulation timers
        for (const timer of this.accumulationTimers.values()) {
            clearTimeout(timer);
        }
        this.accumulationTimers.clear();
        this.firstEditTimestamp.clear();
        this.lastProcessedContent.clear();

        // Dispose all subscriptions
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }
}
