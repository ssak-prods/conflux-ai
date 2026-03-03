/**
 * BrainQuery — AMD/Groq 70B powered conversational query over team memory.
 *
 * Uses Node.js https module (NOT fetch — Electron doesn't support it).
 */

import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { Decision } from './vectorStore';

const DEFAULT_RAILWAY_URL = 'https://forconflux-production.up.railway.app';

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
    private railwayUrl: string = DEFAULT_RAILWAY_URL;
    private projectToken: string = 'conflux-dev';
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
        this.railwayUrl = config.get<string>('railwayUrl', '') || DEFAULT_RAILWAY_URL;
        this.projectToken = config.get<string>('projectToken', 'conflux-dev');
        this.groqApiKey = config.get<string>('groqApiKey', '');
    }

    public isConfigured(): boolean {
        return this.railwayUrl.length > 0 || this.groqApiKey.length > 0;
    }

    public async ask(question: string, decisions: Decision[]): Promise<string> {
        this.log(`ask() called. ${decisions.length} decisions, railwayUrl=${this.railwayUrl ? 'set' : 'empty'}`);

        if (decisions.length === 0) {
            return "No team decisions recorded yet. Start coding — Conflux will automatically extract decisions from your code changes.";
        }

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
                this.log('Calling Railway /reason...');
                const result = await this.httpPost(
                    this.railwayUrl.replace(/\/$/, '') + '/reason',
                    {
                        messages: [
                            { role: 'system', content: BRAIN_SYSTEM_PROMPT },
                            { role: 'user', content: userMessage },
                        ],
                        temperature: 0.4,
                        max_tokens: 600,
                    },
                    { 'X-Project-Token': this.projectToken },
                    45000,
                );

                if (result && result.choices?.[0]?.message?.content) {
                    return result.choices[0].message.content.trim();
                }
                this.log('Railway /reason failed or empty. Trying Groq...');
            }

            if (this.groqApiKey) {
                const result = await this.httpPost(
                    'https://api.groq.com/openai/v1/chat/completions',
                    {
                        model: 'llama-3.3-70b-versatile',
                        messages: [
                            { role: 'system', content: BRAIN_SYSTEM_PROMPT },
                            { role: 'user', content: userMessage },
                        ],
                        temperature: 0.4,
                        max_tokens: 600,
                    },
                    { 'Authorization': `Bearer ${this.groqApiKey}` },
                    30000,
                );

                if (result && result.choices?.[0]?.message?.content) {
                    return result.choices[0].message.content.trim();
                }
            }

            return "Could not reach AI backend. Please check View → Output → Conflux for details.";
        } catch (error) {
            this.log(`BrainQuery error: ${error}`);
            return "Query failed — check the Conflux output channel for details.";
        }
    }

    /**
     * Reliable HTTP POST using Node.js https module.
     */
    private httpPost(urlStr: string, body: any, extraHeaders: Record<string, string>, timeoutMs: number): Promise<any> {
        return new Promise((resolve) => {
            try {
                const url = new URL(urlStr);
                const payload = JSON.stringify(body);
                const isHttps = url.protocol === 'https:';
                const mod = isHttps ? https : http;

                const options: https.RequestOptions = {
                    hostname: url.hostname,
                    port: url.port || (isHttps ? 443 : 80),
                    path: url.pathname + url.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                        ...extraHeaders,
                    },
                };

                this.log(`POST ${url.hostname}${url.pathname} (${payload.length} bytes, timeout ${timeoutMs}ms)`);

                const timer = setTimeout(() => {
                    this.log(`TIMEOUT ${url.hostname}${url.pathname} after ${timeoutMs}ms`);
                    req.destroy();
                    resolve(null);
                }, timeoutMs);

                const req = mod.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                    res.on('end', () => {
                        clearTimeout(timer);
                        this.log(`Response ${res.statusCode} from ${url.hostname} (${data.length} bytes)`);
                        try {
                            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                                resolve(JSON.parse(data));
                            } else {
                                this.log(`HTTP ERROR ${res.statusCode}: ${data.substring(0, 300)}`);
                                resolve(null);
                            }
                        } catch (e) {
                            this.log(`JSON parse error: ${e}`);
                            resolve(null);
                        }
                    });
                });

                req.on('error', (err) => {
                    clearTimeout(timer);
                    this.log(`REQUEST ERROR ${url.hostname}: ${err.message}`);
                    resolve(null);
                });

                req.write(payload);
                req.end();
            } catch (err: any) {
                this.log(`httpPost setup error: ${err.message}`);
                resolve(null);
            }
        });
    }

    private log(msg: string): void {
        const line = `[Conflux Brain] ${msg}`;
        console.log(line);
        this.outputChannel?.appendLine(line);
    }

    public dispose(): void {
        for (const d of this.disposables) { d.dispose(); }
        this.disposables = [];
    }
}
