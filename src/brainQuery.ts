/**
 * BrainQuery — AMD/Groq 70B powered conversational query over the team knowledge graph.
 *
 * Instead of vector similarity search (which breaks when embedding is unavailable),
 * this sends all stored decisions as context to a 70B model via Railway /reason.
 *
 * Handles questions like:
 *   "Where are we in the project?"
 *   "What authentication method did we choose?"
 *   "What's left to build?"
 *   "Are there any unresolved architectural decisions?"
 *
 * Route: extension → Railway /reason → AMD MI300X (70B) → answer
 * Fallback: Railway → Groq 70B if AMD not configured
 */

import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { Decision } from './vectorStore';

const BRAIN_SYSTEM_PROMPT = `You are the Conflux Team Brain — an AI that knows everything about a software project because you've been watching the team code it in real time.

You have access to a log of every architectural decision the team has made, automatically extracted from their code changes and conversations.

Your job is to answer questions about the project honestly and helpfully, like a senior engineer who's been watching the whole thing unfold.

Rules:
- Answer conversationally, like a knowledgeable teammate, not a database readout
- If someone asks "where are we?", give a clear status summary: what's been decided, what's pending, what might be missing
- If you see conflicting decisions, flag them
- If the knowledge base is sparse or incomplete, say so honestly — don't make things up
- Keep answers concise but complete (3-8 sentences max unless the question requires more)
- Use the confidence tags: ✅ = committed to git, ⏳ = in progress / not yet committed`;

export class BrainQuery implements vscode.Disposable {
    private railwayUrl: string = '';
    private projectToken: string = '';
    private groqApiKey: string = '';
    private disposables: vscode.Disposable[] = [];
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.loadConfig();

        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(() => this.loadConfig())
        );
    }

    private loadConfig(): void {
        const config = vscode.workspace.getConfiguration('conflux');
        this.railwayUrl = config.get<string>('railwayUrl', '');
        this.projectToken = config.get<string>('projectToken', 'conflux-dev');
        this.groqApiKey = config.get<string>('groqApiKey', '');
    }

    public isConfigured(): boolean {
        return this.railwayUrl.length > 0 || this.groqApiKey.length > 0;
    }

    /**
     * Ask the 70B model a question about the project.
     * Sends all decisions as context, gets a conversational answer.
     */
    public async ask(question: string, decisions: Decision[]): Promise<string> {
        if (decisions.length === 0) {
            return "No team decisions recorded yet. Start coding — Conflux will automatically extract decisions from your code changes.";
        }

        // Build the context block from all decisions (most recent first, max 80)
        const decisionContext = decisions
            .slice(0, 80)
            .map((d, i) => {
                const badge = d.confidence === 'decided' ? '✅' : '⏳';
                const when = new Date(d.timestamp).toLocaleString();
                return `${i + 1}. ${badge} "${d.summary}" (in ${d.fileName}, by ${d.author}, ${when})`;
            })
            .join('\n');

        const userMessage = `Here are all the architectural decisions recorded for this project so far:\n\n${decisionContext}\n\n---\n\nQuestion: ${question}`;

        try {
            if (this.railwayUrl) {
                const result = await this.callRailwayReason(userMessage);
                if (result) {
                    return result;
                }
                // Fall through to Groq direct
            }

            if (this.groqApiKey) {
                const result = await this.callGroqDirect(userMessage);
                if (result) {
                    return result;
                }
            }

            return "Could not reach AI backend. Check your Railway URL or Groq API key in settings.";
        } catch (error) {
            this.outputChannel.appendLine(`[Conflux] BrainQuery failed: ${error}`);
            return "Query failed — check the Conflux output channel for details.";
        }
    }

    private callRailwayReason(userMessage: string): Promise<string | null> {
        return new Promise((resolve) => {
            const payload = JSON.stringify({
                messages: [
                    { role: 'system', content: BRAIN_SYSTEM_PROMPT },
                    { role: 'user', content: userMessage },
                ],
                temperature: 0.4,
                max_tokens: 600,
            });

            const url = new URL(`${this.railwayUrl.replace(/\/$/, '')}/reason`);
            const isHttps = url.protocol === 'https:';
            const httpModule = isHttps ? https : http;

            const options: https.RequestOptions = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Project-Token': this.projectToken,
                    'Content-Length': Buffer.byteLength(payload),
                },
                timeout: 30000,
            };

            const req = httpModule.request(options, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const content = json.choices?.[0]?.message?.content;
                        resolve(content ? content.trim() : null);
                    } catch {
                        resolve(null);
                    }
                });
            });

            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.write(payload);
            req.end();
        });
    }

    private callGroqDirect(userMessage: string): Promise<string | null> {
        return new Promise((resolve) => {
            const payload = JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: BRAIN_SYSTEM_PROMPT },
                    { role: 'user', content: userMessage },
                ],
                temperature: 0.4,
                max_tokens: 600,
            });

            const options: https.RequestOptions = {
                hostname: 'api.groq.com',
                port: 443,
                path: '/openai/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.groqApiKey}`,
                    'Content-Length': Buffer.byteLength(payload),
                },
                timeout: 25000,
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const content = json.choices?.[0]?.message?.content;
                        resolve(content ? content.trim() : null);
                    } catch {
                        resolve(null);
                    }
                });
            });

            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.write(payload);
            req.end();
        });
    }

    public dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
    }
}
