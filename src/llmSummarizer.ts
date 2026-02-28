/**
 * LLM Summarizer — Routes LLM calls through the Railway proxy.
 *
 * The Railway proxy holds all API keys server-side.
 * Extension authenticates with a project token only.
 *
 * Two endpoints:
 *   POST /summarize → Groq (8B, fast) — for diff summaries
 *   POST /reason   → AMD MI300X (70B) — for conflict checks (future)
 *
 * Fallback: If Railway URL is not configured, falls back to direct Groq API.
 */

import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';

export interface SummarizationResult {
    summary: string;
    model: string;
    tokensUsed: number;
}

const SYSTEM_PROMPT = `You are an expert software architect reviewing code changes.
Your job is to extract the ONE key architectural decision or design intent from a code diff.

Rules:
- Output EXACTLY ONE sentence describing the architectural decision, not the code change itself.
- Focus on WHY the change was made, not WHAT changed.
- Use present tense ("Uses", "Implements", "Switches to").
- Be specific about technologies, patterns, and design choices.
- If the diff is trivial (formatting, typos, comments), respond with "SKIP".

Examples of good outputs:
- "Implements JWT-based authentication using Supabase Auth with role-based access control."
- "Switches from REST to WebSocket for real-time order updates to reduce polling overhead."
- "Introduces a repository pattern to decouple database access from business logic."

Examples of bad outputs (too vague or describing code not intent):
- "Updates the auth file." (too vague)
- "Adds a new function called handleLogin." (describes code, not intent)
- "Changes some imports." (trivial)`;

export class LlmSummarizer implements vscode.Disposable {
    private groqApiKey: string = '';
    private railwayUrl: string = '';
    private projectToken: string = '';
    private disposables: vscode.Disposable[] = [];

    constructor() {
        this.loadConfig();

        // Watch for config changes
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (
                    e.affectsConfiguration('conflux.groqApiKey') ||
                    e.affectsConfiguration('conflux.railwayUrl') ||
                    e.affectsConfiguration('conflux.projectToken')
                ) {
                    this.loadConfig();
                }
            })
        );
    }

    private loadConfig(): void {
        const config = vscode.workspace.getConfiguration('conflux');
        this.groqApiKey = config.get<string>('groqApiKey', '');
        this.railwayUrl = config.get<string>('railwayUrl', '');
        this.projectToken = config.get<string>('projectToken', 'conflux-dev');
    }

    /**
     * Check if the summarizer is configured.
     * Either Railway URL or direct Groq API key must be set.
     */
    public isConfigured(): boolean {
        return this.railwayUrl.length > 0 || this.groqApiKey.length > 0;
    }

    /**
     * Summarize a code diff into a one-sentence architectural decision.
     * Routes through Railway if configured, falls back to direct Groq.
     */
    public async summarize(
        diff: string,
        fileName: string,
        languageId: string
    ): Promise<SummarizationResult | null> {
        if (!this.isConfigured()) {
            return null;
        }

        const userPrompt = `File: ${fileName} (${languageId})

Code diff:
\`\`\`
${diff.substring(0, 3000)}
\`\`\`

What is the ONE architectural decision or design intent behind this change?`;

        try {
            // Try Railway proxy first (fast timeout so failure doesn't block)
            if (this.railwayUrl) {
                const railwayResult = await this.callRailway(userPrompt);
                if (railwayResult && railwayResult.summary !== 'SKIP' && railwayResult.summary.trim() !== '') {
                    return railwayResult;
                }
                // Railway failed or returned SKIP — fall through to Groq
            }

            // Groq direct fallback
            if (this.groqApiKey) {
                const groqResult = await this.callGroqDirect(userPrompt);
                if (!groqResult || groqResult.summary === 'SKIP' || groqResult.summary.trim() === '') {
                    return null;
                }
                return groqResult;
            }

            return null;
        } catch (error) {
            // Fail silently — never surface errors to the developer's editor
            console.error('[Conflux] LLM summarization failed silently:', error);
            return null;
        }
    }

    /**
     * Call the Railway proxy /summarize endpoint.
     * Railway holds the API keys — we just send the project token.
     */
    private callRailway(userMessage: string): Promise<SummarizationResult | null> {
        return new Promise((resolve) => {
            const payload = JSON.stringify({
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: userMessage },
                ],
                temperature: 0.3,
                max_tokens: 150,
            });

            const url = new URL(`${this.railwayUrl.replace(/\/$/, '')}/summarize`);
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
                timeout: 5000,  // Fail fast so Groq fallback kicks in quickly
            };

            const req = httpModule.request(options, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.error) {
                            console.error('[Conflux] Railway error:', json.error);
                            resolve(null);
                            return;
                        }
                        const choice = json.choices?.[0];
                        if (!choice) {
                            resolve(null);
                            return;
                        }
                        resolve({
                            summary: choice.message.content.trim(),
                            model: json.model || 'railway-proxy',
                            tokensUsed: json.usage?.total_tokens ?? 0,
                        });
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

    /**
     * Direct Groq API fallback (when Railway is not configured).
     */
    private callGroqDirect(userMessage: string): Promise<SummarizationResult | null> {
        return new Promise((resolve) => {
            const payload = JSON.stringify({
                model: 'llama-3.1-8b-instant',
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: userMessage },
                ],
                temperature: 0.3,
                max_tokens: 150,
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
                timeout: 15000,
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.error) {
                            resolve(null);
                            return;
                        }
                        const choice = json.choices?.[0];
                        if (!choice) {
                            resolve(null);
                            return;
                        }
                        resolve({
                            summary: choice.message.content.trim(),
                            model: json.model || 'llama-3.1-8b-instant',
                            tokensUsed: json.usage?.total_tokens ?? 0,
                        });
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
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }
}
