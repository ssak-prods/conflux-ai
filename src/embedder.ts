/**
 * Embedder — On-device text embedding using Transformers.js v3 with ONNX Runtime.
 *
 * Uses @huggingface/transformers to run the all-MiniLM-L6-v2 model locally on CPU.
 * No GPU dependency, no external API call. ONNX Runtime WebAssembly backend.
 *
 * The model (~23MB) is downloaded on first use and cached for subsequent runs.
 * Loading is lazy and async — never blocks the extension host.
 *
 * Package docs: https://huggingface.co/docs/transformers.js
 * Model: https://huggingface.co/Xenova/all-MiniLM-L6-v2
 */

import * as vscode from 'vscode';

// Dynamic import type for Transformers.js (ESM module loaded at runtime)
type Pipeline = any;

export class Embedder implements vscode.Disposable {
    private pipeline: Pipeline | null = null;
    private loading: Promise<Pipeline> | null = null;
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    /**
     * Lazy-load the embedding pipeline. Only downloads the model on first call.
     * Subsequent calls return the cached pipeline immediately.
     */
    private async getPipeline(): Promise<Pipeline> {
        if (this.pipeline) {
            return this.pipeline;
        }

        // If already loading, wait for the same promise (prevent duplicate downloads)
        if (this.loading) {
            return this.loading;
        }

        this.loading = this.initPipeline();
        this.pipeline = await this.loading;
        this.loading = null;
        return this.pipeline;
    }

    private async initPipeline(): Promise<Pipeline> {
        this.outputChannel.appendLine('[Conflux] Loading embedding model (first run downloads ~23MB)...');

        try {
            // Dynamic import for ESM compatibility
            // @huggingface/transformers is an ESM-only package
            const { pipeline, env } = await Function('return import("@huggingface/transformers")')();

            // Disable remote model fetching warnings in production
            // Models will be cached after first download
            env.allowLocalModels = true;
            env.useBrowserCache = false;

            const pipe = await pipeline(
                'feature-extraction',
                'Xenova/all-MiniLM-L6-v2',
                {
                    // Force CPU execution via ONNX Runtime WASM
                    device: 'wasm',
                    dtype: 'q8',  // Quantized for speed
                }
            );

            this.outputChannel.appendLine('[Conflux] Embedding model loaded successfully.');
            return pipe;
        } catch (error) {
            this.outputChannel.appendLine(`[Conflux] Failed to load embedding model: ${error}`);
            throw error;
        }
    }

    /**
     * Embed a text string into a vector (384 dimensions for all-MiniLM-L6-v2).
     * Returns a normalized Float64Array suitable for cosine similarity.
     *
     * Returns null if the embedding fails (fail silently).
     */
    public async embed(text: string): Promise<number[] | null> {
        try {
            const pipe = await this.getPipeline();
            const output = await pipe(text, {
                pooling: 'mean',
                normalize: true,
            });
            // Convert tensor to plain array
            return Array.from(output.data as Float32Array);
        } catch (error) {
            this.outputChannel.appendLine(`[Conflux] Embedding failed: ${error}`);
            return null;
        }
    }

    /**
     * Check if the embedder is ready (model loaded).
     */
    public isReady(): boolean {
        return this.pipeline !== null;
    }

    /**
     * Pre-warm the embedding pipeline (call on activation, non-blocking).
     */
    public async warmup(): Promise<void> {
        try {
            await this.getPipeline();
        } catch {
            // Fail silently on warmup
        }
    }

    public dispose(): void {
        this.pipeline = null;
        this.loading = null;
    }
}
