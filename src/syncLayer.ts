/**
 * Sync Layer — Real-time decision sync via Supabase Realtime Broadcast.
 *
 * When a local decision is stored, it broadcasts to all teammates on the same
 * project channel. When a remote decision arrives, it upserts into local Vectra.
 *
 * Uses Supabase Realtime Broadcast (free tier):
 * - No database writes (ephemeral messages only)
 * - Channel name = project code (the "room" concept)
 * - Offline-first: queues outgoing, replays on reconnect
 *
 * Supabase docs: https://supabase.com/docs/guides/realtime/broadcast
 */

import * as vscode from 'vscode';
import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { VectorStore, Decision } from './vectorStore';

export interface SyncConfig {
    supabaseUrl: string;
    supabaseAnonKey: string;
    projectCode: string;
}

export class SyncLayer implements vscode.Disposable {
    private supabase: SupabaseClient | null = null;
    private channel: RealtimeChannel | null = null;
    private vectorStore: VectorStore;
    private outputChannel: vscode.OutputChannel;
    private config: SyncConfig | null = null;
    private outgoingQueue: Decision[] = [];
    private isConnected: boolean = false;

    constructor(vectorStore: VectorStore, outputChannel: vscode.OutputChannel) {
        this.vectorStore = vectorStore;
        this.outputChannel = outputChannel;
    }

    /**
     * Connect to the sync channel.
     * Call this after the user joins a project room.
     */
    public async connect(config: SyncConfig): Promise<boolean> {
        this.config = config;

        if (!config.supabaseUrl || !config.supabaseAnonKey || !config.projectCode) {
            this.outputChannel.appendLine('[Conflux Sync] Missing config — sync disabled.');
            return false;
        }

        try {
            // Initialize Supabase client
            this.supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);

            // Subscribe to the project's broadcast channel
            const channelName = `conflux:${config.projectCode}`;
            this.channel = this.supabase.channel(channelName);

            // Listen for incoming decisions
            this.channel.on('broadcast', { event: 'decision' }, (payload) => {
                this.handleIncomingDecision(payload.payload as Decision);
            });

            // Subscribe to the channel
            this.channel.subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    this.isConnected = true;
                    this.outputChannel.appendLine(
                        `[Conflux Sync] Connected to project room: ${config.projectCode}`
                    );

                    // Flush queued outgoing decisions
                    this.flushQueue();
                } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                    this.isConnected = false;
                    this.outputChannel.appendLine(
                        `[Conflux Sync] Disconnected from project room (${status})`
                    );
                }
            });

            return true;
        } catch (error) {
            this.outputChannel.appendLine(`[Conflux Sync] Connection failed: ${error}`);
            return false;
        }
    }

    /**
     * Broadcast a new decision to all teammates.
     * If offline, queues the decision for later.
     */
    public async broadcastDecision(decision: Decision): Promise<void> {
        if (!this.channel || !this.isConnected) {
            // Offline-first: queue for later
            this.outgoingQueue.push(decision);
            this.outputChannel.appendLine(
                '[Conflux Sync] Queued decision for sync (offline)'
            );
            return;
        }

        try {
            await this.channel.send({
                type: 'broadcast',
                event: 'decision',
                payload: decision,
            });

            this.outputChannel.appendLine(
                `[Conflux Sync] Broadcast decision: "${decision.summary.substring(0, 50)}..."`
            );
        } catch (error) {
            // Queue on failure
            this.outgoingQueue.push(decision);
            this.outputChannel.appendLine(`[Conflux Sync] Broadcast failed, queued: ${error}`);
        }
    }

    /**
     * Handle an incoming decision from a teammate.
     * Upserts into local Vectra store (deduplication handled by VectorStore).
     */
    private async handleIncomingDecision(decision: Decision): Promise<void> {
        if (!decision || !decision.summary) {
            return;
        }

        this.outputChannel.appendLine(
            `[Conflux Sync] Received decision from ${decision.author}: "${decision.summary.substring(0, 50)}..."`
        );

        // Upsert into local vector store (deduplicates by similarity score)
        const stored = await this.vectorStore.upsertDecision(decision);
        if (stored) {
            // Show a notification about the incoming decision
            vscode.window.setStatusBarMessage(
                `$(cloud-download) Conflux: Team decision from ${decision.author}`,
                5000
            );
        }
    }

    /**
     * Flush queued outgoing decisions (called on reconnect).
     */
    private async flushQueue(): Promise<void> {
        if (this.outgoingQueue.length === 0) {
            return;
        }

        this.outputChannel.appendLine(
            `[Conflux Sync] Flushing ${this.outgoingQueue.length} queued decisions...`
        );

        const queue = [...this.outgoingQueue];
        this.outgoingQueue = [];

        for (const decision of queue) {
            await this.broadcastDecision(decision);
        }
    }

    /**
     * Disconnect from the sync channel.
     */
    public async disconnect(): Promise<void> {
        if (this.channel) {
            await this.supabase?.removeChannel(this.channel);
            this.channel = null;
        }
        this.isConnected = false;
        this.supabase = null;
    }

    /**
     * Check if currently connected to a project room.
     */
    public isActive(): boolean {
        return this.isConnected && this.channel !== null;
    }

    public dispose(): void {
        this.disconnect();
    }
}
