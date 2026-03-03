/**
 * LLM Summarizer — Routes LLM calls through the Railway proxy.
 *
 * Uses child_process.execFile to spawn a Node.js subprocess for HTTP calls.
 * This completely bypasses Electron's runtime quirks with https/http modules.
 * The subprocess runs plain Node.js — no Electron interference.
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';

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

const DEFAULT_RAILWAY_URL = 'https://forconflux-production.up.railway.app';

export class LlmSummarizer implements vscode.Disposable {
    private groqApiKey: string = '';
    private railwayUrl: string = DEFAULT_RAILWAY_URL;
    private projectToken: string = 'conflux-dev';
    private disposables: vscode.Disposable[] = [];
    private outputChannel?: vscode.OutputChannel;

    constructor(outputChannel?: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.loadConfig();
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
        this.railwayUrl = config.get<string>('railwayUrl', '') || DEFAULT_RAILWAY_URL;
        this.projectToken = config.get<string>('projectToken', 'conflux-dev');
        this.log(`Config loaded: railwayUrl=${this.railwayUrl}, groqKey=${this.groqApiKey ? 'set' : 'empty'}`);
    }

    public isConfigured(): boolean {
        return this.railwayUrl.length > 0 || this.groqApiKey.length > 0;
    }

    public async summarize(
        diff: string,
        fileName: string,
        languageId: string
    ): Promise<SummarizationResult | null> {
        if (!this.isConfigured()) {
            this.log('Not configured — skipping');
            return null;
        }

        const userPrompt = `File: ${fileName} (${languageId})\n\nCode diff:\n\`\`\`\n${diff.substring(0, 3000)}\n\`\`\`\n\nWhat is the ONE architectural decision or design intent behind this change?`;

        try {
            // Try Railway first
            if (this.railwayUrl) {
                this.log(`Calling Railway /summarize...`);
                const result = await this.nodeHttpPost(
                    this.railwayUrl.replace(/\/$/, '') + '/summarize',
                    {
                        messages: [
                            { role: 'system', content: SYSTEM_PROMPT },
                            { role: 'user', content: userPrompt },
                        ],
                        temperature: 0.3,
                        max_tokens: 150,
                    },
                    { 'X-Project-Token': this.projectToken },
                    20000,
                );

                if (result && result.choices?.[0]) {
                    const summary = result.choices[0].message.content.trim();
                    if (summary && summary !== 'SKIP') {
                        this.log(`Decision extracted: "${summary}"`);
                        return {
                            summary,
                            model: result.model || 'railway',
                            tokensUsed: result.usage?.total_tokens ?? 0,
                        };
                    }
                    this.log(`LLM returned SKIP or empty`);
                    return null;
                }
                this.log('Railway returned no result, trying Groq fallback...');
            }

            // Fallback: Direct Groq
            if (this.groqApiKey) {
                this.log('Calling Groq direct...');
                const result = await this.nodeHttpPost(
                    'https://api.groq.com/openai/v1/chat/completions',
                    {
                        model: 'llama-3.1-8b-instant',
                        messages: [
                            { role: 'system', content: SYSTEM_PROMPT },
                            { role: 'user', content: userPrompt },
                        ],
                        temperature: 0.3,
                        max_tokens: 150,
                    },
                    { 'Authorization': `Bearer ${this.groqApiKey}` },
                    25000,
                );

                if (result && result.choices?.[0]) {
                    const summary = result.choices[0].message.content.trim();
                    if (summary && summary !== 'SKIP') {
                        return { summary, model: result.model || 'groq', tokensUsed: result.usage?.total_tokens ?? 0 };
                    }
                }
            }

            this.log('All LLM backends exhausted — returning null');
            return null;
        } catch (error) {
            this.log(`Summarization error: ${error}`);
            return null;
        }
    }

    /**
     * Spawns a child Node.js process to make the HTTP POST.
     * This COMPLETELY bypasses Electron's runtime — the child process
     * is a fresh Node.js instance with no Electron interference.
     *
     * The script is passed as a -e argument, receives the request body
     * via stdin, and returns the response JSON via stdout.
     */
    private nodeHttpPost(
        urlStr: string,
        body: any,
        extraHeaders: Record<string, string>,
        timeoutMs: number
    ): Promise<any> {
        return new Promise((resolve) => {
            const payload = JSON.stringify(body);

            // Inline Node.js script that makes the HTTPS request
            const script = `
const https = require('https');
const http = require('http');
const url = new URL(process.argv[1]);
const headers = JSON.parse(process.argv[2]);
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        timeout: ${Math.floor(timeoutMs * 0.8)},
        headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(input) }, headers)
    }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
            process.stdout.write(JSON.stringify({ status: res.statusCode, body: d }));
        });
    });
    req.on('timeout', () => { req.destroy(); process.stdout.write(JSON.stringify({ status: 0, body: 'timeout' })); });
    req.on('error', (e) => { process.stdout.write(JSON.stringify({ status: 0, body: e.message })); });
    req.write(input);
    req.end();
});
`;

            this.log(`Spawning Node.js subprocess for ${urlStr}`);

            try {
                const child = cp.execFile(
                    process.execPath, // Use the same Node.js binary that VS Code uses
                    ['-e', script, urlStr, JSON.stringify(extraHeaders)],
                    {
                        timeout: timeoutMs,
                        maxBuffer: 1024 * 1024, // 1MB
                        env: { ...process.env }, // Inherit env
                    },
                    (error, stdout, stderr) => {
                        if (error) {
                            this.log(`Subprocess error: ${error.message}`);
                            if (stderr) { this.log(`Subprocess stderr: ${stderr}`); }
                            resolve(null);
                            return;
                        }

                        try {
                            const result = JSON.parse(stdout);
                            this.log(`Subprocess response: status=${result.status}, body=${String(result.body).substring(0, 200)}`);

                            if (result.status >= 200 && result.status < 300) {
                                resolve(JSON.parse(result.body));
                            } else {
                                this.log(`HTTP error ${result.status}: ${String(result.body).substring(0, 500)}`);
                                resolve(null);
                            }
                        } catch (e) {
                            this.log(`Subprocess output parse error: ${e}, stdout=${stdout.substring(0, 200)}`);
                            resolve(null);
                        }
                    }
                );

                // Send the request body via stdin
                if (child.stdin) {
                    child.stdin.write(payload);
                    child.stdin.end();
                }
            } catch (err: any) {
                this.log(`Failed to spawn subprocess: ${err.message}`);
                resolve(null);
            }
        });
    }

    private log(msg: string): void {
        const line = `[Conflux LLM] ${msg}`;
        console.log(line);
        if (this.outputChannel) {
            this.outputChannel.appendLine(line);
        }
    }

    public dispose(): void {
        for (const d of this.disposables) { d.dispose(); }
        this.disposables = [];
    }
}
