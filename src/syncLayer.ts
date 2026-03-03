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

export interface TeamMember {
    name: string;
    lastSeen: number;
}

export class SyncLayer implements vscode.Disposable {
    private supabase: SupabaseClient | null = null;
    private channel: RealtimeChannel | null = null;
    private vectorStore: VectorStore;
    private outputChannel: vscode.OutputChannel;
    private config: SyncConfig | null = null;
    private outgoingQueue: Decision[] = [];
    private isConnected: boolean = false;

    // ─── Presence ───
    private presenceInterval: ReturnType<typeof setInterval> | null = null;
    private cleanupInterval: ReturnType<typeof setInterval> | null = null;
    private members: Map<string, number> = new Map(); // name → lastSeen timestamp
    private myName: string = '';
    private presenceListeners: Array<(members: TeamMember[]) => void> = [];

    constructor(vectorStore: VectorStore, outputChannel: vscode.OutputChannel) {
        this.vectorStore = vectorStore;
        this.outputChannel = outputChannel;
    }

    /**
     * Connect to the sync channel.
     */
    public async connect(config: SyncConfig): Promise<boolean> {
        this.config = config;

        if (!config.supabaseUrl || !config.supabaseAnonKey || !config.projectCode) {
            this.outputChannel.appendLine('[Conflux Sync] Missing config — sync disabled.');
            return false;
        }

        try {
            this.supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);

            const channelName = `conflux:${config.projectCode}`;
            this.channel = this.supabase.channel(channelName);

            // Listen for decisions
            this.channel.on('broadcast', { event: 'decision' }, (payload) => {
                this.handleIncomingDecision(payload.payload as Decision);
            });

            // Listen for presence heartbeats
            this.channel.on('broadcast', { event: 'presence' }, (payload) => {
                const name = payload.payload?.name;
                if (name && name !== this.myName) {
                    this.members.set(name, Date.now());
                    this.emitPresence();
                }
            });

            this.channel.subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    this.isConnected = true;
                    this.outputChannel.appendLine(
                        `[Conflux Sync] Connected to project room: ${config.projectCode}`
                    );
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

    // ─── Presence Heartbeat ───

    /**
     * Start sending presence heartbeats every 15 seconds.
     * Also starts a cleanup timer to remove stale members after 45 seconds.
     */
    public startPresence(name: string): void {
        this.myName = name;
        this.members.set(name, Date.now()); // Add self
        this.emitPresence();

        // Send heartbeat immediately, then every 15s
        this.sendPresenceBeat();
        this.presenceInterval = setInterval(() => this.sendPresenceBeat(), 15_000);

        // Clean up stale members every 20s
        this.cleanupInterval = setInterval(() => this.cleanupStaleMembers(), 20_000);

        this.outputChannel.appendLine(`[Conflux Sync] Presence started for "${name}"`);
    }

    /**
     * Stop sending presence heartbeats.
     */
    public stopPresence(): void {
        if (this.presenceInterval) {
            clearInterval(this.presenceInterval);
            this.presenceInterval = null;
        }
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.members.clear();
        this.emitPresence();
    }

    /**
     * Register a callback for presence updates.
     */
    public onPresenceUpdate(listener: (members: TeamMember[]) => void): void {
        this.presenceListeners.push(listener);
    }

    private sendPresenceBeat(): void {
        if (!this.channel || !this.isConnected || !this.myName) { return; }
        this.channel.send({
            type: 'broadcast',
            event: 'presence',
            payload: { name: this.myName, ts: Date.now() },
        }).catch(() => { });

        // Keep self alive
        this.members.set(this.myName, Date.now());
    }

    private cleanupStaleMembers(): void {
        const now = Date.now();
        const STALE_MS = 45_000; // 45 seconds
        let changed = false;
        for (const [name, lastSeen] of this.members) {
            if (name !== this.myName && now - lastSeen > STALE_MS) {
                this.members.delete(name);
                this.outputChannel.appendLine(`[Conflux Sync] Member "${name}" went offline`);
                changed = true;
            }
        }
        if (changed) { this.emitPresence(); }
    }

    private emitPresence(): void {
        const list: TeamMember[] = [];
        for (const [name, lastSeen] of this.members) {
            list.push({ name, lastSeen });
        }
        for (const listener of this.presenceListeners) {
            try { listener(list); } catch { }
        }
    }

    // ─── Decision Broadcasting ───

    public async broadcastDecision(decision: Decision): Promise<void> {
        if (!this.channel || !this.isConnected) {
            this.outgoingQueue.push(decision);
            this.outputChannel.appendLine('[Conflux Sync] Queued decision for sync (offline)');
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
            this.outgoingQueue.push(decision);
            this.outputChannel.appendLine(`[Conflux Sync] Broadcast failed, queued: ${error}`);
        }
    }

    private async handleIncomingDecision(decision: Decision): Promise<void> {
        if (!decision || !decision.summary) { return; }

        this.outputChannel.appendLine(
            `[Conflux Sync] Received decision from ${decision.author}: "${decision.summary.substring(0, 50)}..."`
        );

        const stored = await this.vectorStore.upsertDecision(decision);
        if (stored) {
            vscode.window.setStatusBarMessage(
                `$(cloud-download) Conflux: Team decision from ${decision.author}`,
                5000
            );
        }
    }

    private async flushQueue(): Promise<void> {
        if (this.outgoingQueue.length === 0) { return; }

        this.outputChannel.appendLine(
            `[Conflux Sync] Flushing ${this.outgoingQueue.length} queued decisions...`
        );

        const queue = [...this.outgoingQueue];
        this.outgoingQueue = [];

        for (const decision of queue) {
            await this.broadcastDecision(decision);
        }
    }

    public async disconnect(): Promise<void> {
        this.stopPresence();
        if (this.channel) {
            await this.supabase?.removeChannel(this.channel);
            this.channel = null;
        }
        this.isConnected = false;
        this.supabase = null;
    }

    public isActive(): boolean {
        return this.isConnected && this.channel !== null;
    }

    public dispose(): void {
        this.disconnect();
    }
}
