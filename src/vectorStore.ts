/**
 * VectorStore — Persistent local vector database using Vectra.
 *
 * Stores architectural decisions as embedded vectors in .conflux/vectra/ folder.
 * Uses cosine similarity for semantic search. All data is file-based (index.json).
 *
 * The same index.json can be read by vectra-py in the MCP server (Phase 3).
 *
 * Vectra docs: https://github.com/Stevenic/vectra
 * npm: https://www.npmjs.com/package/vectra
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { LocalIndex, QueryResult } from 'vectra';
import { Embedder } from './embedder';

export interface Decision {
    id?: string;
    summary: string;
    filePath: string;
    fileName: string;
    languageId: string;
    author: string;
    timestamp: string;
    confidence: 'pending' | 'decided';
    diff?: string;
}

export interface DecisionQueryResult {
    decision: Decision;
    score: number;
}

export class VectorStore implements vscode.Disposable {
    private index: LocalIndex | null = null;
    private embedder: Embedder;
    private storePath: string = '';
    private outputChannel: vscode.OutputChannel;
    private initialized: boolean = false;

    constructor(embedder: Embedder, outputChannel: vscode.OutputChannel) {
        this.embedder = embedder;
        this.outputChannel = outputChannel;
    }

    /**
     * Initialize the vector store for the current workspace.
     * Creates the .conflux/vectra/ directory if it doesn't exist.
     */
    public async initialize(): Promise<boolean> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.outputChannel.appendLine('[Conflux] No workspace folder open — vector store disabled.');
            return false;
        }

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        this.storePath = path.join(workspaceRoot, '.conflux', 'vectra');

        try {
            this.index = new LocalIndex(this.storePath);

            if (!(await this.index.isIndexCreated())) {
                await this.index.createIndex();
                this.outputChannel.appendLine(`[Conflux] Created vector store at ${this.storePath}`);
            } else {
                this.outputChannel.appendLine(`[Conflux] Loaded existing vector store from ${this.storePath}`);
            }

            this.initialized = true;
            return true;
        } catch (error) {
            this.outputChannel.appendLine(`[Conflux] Failed to initialize vector store: ${error}`);
            return false;
        }
    }

    /**
     * Store a new decision in the vector store.
     *
     * 1. Embeds the summary text using the local embedding model
     * 2. Inserts the vector + metadata into Vectra
     *
     * Returns false if the store is not initialized or embedding fails.
     */
    public async storeDecision(decision: Decision): Promise<boolean> {
        if (!this.initialized || !this.index) {
            return false;
        }

        try {
            // Embed the summary text
            let vector = await this.embedder.embed(decision.summary);

            if (!vector) {
                // Embedding failed (model not loaded yet) — use a zero vector fallback.
                // The decision will still be stored and visible in the sidebar.
                // Semantic search won't rank it correctly, but it won't be lost.
                this.outputChannel.appendLine(
                    '[Conflux] Embedding unavailable — storing with fallback vector.'
                );
                vector = new Array(384).fill(0);
            }

            // Store in Vectra with metadata
            await this.index.insertItem({
                vector,
                metadata: {
                    text: decision.summary,
                    filePath: decision.filePath,
                    fileName: decision.fileName,
                    languageId: decision.languageId,
                    author: decision.author,
                    timestamp: decision.timestamp,
                    confidence: decision.confidence,
                },
            });

            this.outputChannel.appendLine(
                `[Conflux] Stored decision: "${decision.summary.substring(0, 60)}..." [${decision.confidence}]`
            );
            return true;
        } catch (error) {
            this.outputChannel.appendLine(`[Conflux] Failed to store decision: ${error}`);
            return false;
        }
    }

    /**
     * Query the vector store for the most relevant decisions.
     *
     * @param query - Natural language query
     * @param topK - Number of results to return (default: 5)
     * @returns Array of decisions with similarity scores
     */
    public async queryDecisions(
        query: string,
        topK: number = 5
    ): Promise<DecisionQueryResult[]> {
        if (!this.initialized || !this.index) {
            return [];
        }

        try {
            // Embed the query
            const vector = await this.embedder.embed(query);
            if (!vector) {
                return [];
            }

            // Search Vectra — queryItems(vector, queryText, topK)
            const results: QueryResult<Record<string, any>>[] = await this.index.queryItems(vector, query, topK);

            return results.map((r) => ({
                decision: {
                    summary: r.item.metadata.text as string,
                    filePath: r.item.metadata.filePath as string,
                    fileName: r.item.metadata.fileName as string,
                    languageId: r.item.metadata.languageId as string,
                    author: r.item.metadata.author as string,
                    timestamp: r.item.metadata.timestamp as string,
                    confidence: r.item.metadata.confidence as 'pending' | 'decided',
                },
                score: r.score,
            }));
        } catch (error) {
            this.outputChannel.appendLine(`[Conflux] Query failed: ${error}`);
            return [];
        }
    }

    /**
     * Upgrade all decisions for a given file from 'pending' to 'decided'.
     * Called when a git commit is detected.
     */
    public async upgradeConfidence(filePath: string): Promise<void> {
        if (!this.initialized || !this.index) {
            return;
        }

        try {
            // Vectra stores items individually — we need to list and update
            // For now, we'll query all items and re-insert with updated confidence
            // This is a limitation of Vectra's API (no direct update)
            const items = await this.index.listItems();

            for (const item of items) {
                const matchesFile = filePath === '*' || item.metadata.filePath === filePath;
                if (
                    matchesFile &&
                    item.metadata.confidence === 'pending'
                ) {
                    // Delete old item and re-insert with updated confidence
                    await this.index.deleteItem(item.id);
                    await this.index.insertItem({
                        vector: item.vector,
                        metadata: {
                            ...item.metadata,
                            confidence: 'decided',
                        },
                    });

                    this.outputChannel.appendLine(
                        `[Conflux] Upgraded confidence for: "${(item.metadata.text as string).substring(0, 40)}..."`
                    );
                }
            }
        } catch (error) {
            this.outputChannel.appendLine(`[Conflux] Failed to upgrade confidence: ${error}`);
        }
    }

    /**
     * Get the count of stored decisions.
     */
    public async getDecisionCount(): Promise<number> {
        if (!this.initialized || !this.index) {
            return 0;
        }

        try {
            const items = await this.index.listItems();
            return items.length;
        } catch {
            return 0;
        }
    }

    /**
     * Get ALL decisions from the store as structured objects.
     * Used by BrainQuery to send full context to the 70B model.
     */
    public async getAllDecisions(): Promise<Decision[]> {
        if (!this.initialized || !this.index) {
            return [];
        }

        try {
            const items = await this.index.listItems();
            return items.map((item) => ({
                summary: item.metadata.text as string,
                filePath: item.metadata.filePath as string,
                fileName: item.metadata.fileName as string,
                languageId: item.metadata.languageId as string,
                author: item.metadata.author as string,
                timestamp: item.metadata.timestamp as string,
                confidence: item.metadata.confidence as 'pending' | 'decided',
            })).sort((a, b) =>
                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            );
        } catch {
            return [];
        }
    }

    /**
     * Upsert a decision from sync — avoid duplicates by checking for matching summaries.
     */
    public async upsertDecision(decision: Decision): Promise<boolean> {
        if (!this.initialized || !this.index) {
            return false;
        }

        try {
            // Check for text-level duplicates (exact match)
            const items = await this.index.listItems();
            const isDuplicate = items.some(
                (item) => (item.metadata.text as string).toLowerCase().trim() ===
                    decision.summary.toLowerCase().trim()
            );

            if (isDuplicate) {
                this.outputChannel.appendLine('[Conflux] Duplicate decision skipped during sync.');
                return false;
            }

            return this.storeDecision(decision);
        } catch (error) {
            this.outputChannel.appendLine(`[Conflux] Upsert failed: ${error}`);
            return false;
        }
    }

    public dispose(): void {
        this.index = null;
        this.initialized = false;
    }
}
