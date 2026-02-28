/**
 * MCP Manager — Detects Python, installs deps, and writes MCP config for all IDEs.
 *
 * On activation:
 *   1. Probes for the correct Python binary (python, python3, py)
 *   2. Auto-installs MCP server Python dependencies (pip install -r requirements.txt)
 *   3. Writes .cursor/mcp.json and .vscode/mcp.json with absolute paths
 *
 * The MCP server is NOT spawned by the extension — it's started by the IDE
 * when it reads the config. Cursor/Antigravity both support stdio-based MCP.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChildProcess, spawn, execSync } from 'child_process';

export class McpManager implements vscode.Disposable {
    private mcpProcess: ChildProcess | null = null;
    private outputChannel: vscode.OutputChannel;
    private serverPath: string = '';
    private confluxDir: string = '';
    private pythonBin: string = 'python';

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    /**
     * Initialize the MCP manager:
     * 1. Find the correct Python binary
     * 2. Install MCP server dependencies
     * 3. Write MCP config files for Cursor + Antigravity
     */
    public async initialize(context: vscode.ExtensionContext): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.outputChannel.appendLine('[Conflux] No workspace — MCP server disabled.');
            return;
        }

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        this.confluxDir = path.join(workspaceRoot, '.conflux');

        // The MCP server.py is bundled with the extension
        this.serverPath = path.join(context.extensionPath, 'mcp-server', 'server.py');

        if (!fs.existsSync(this.serverPath)) {
            this.outputChannel.appendLine(
                `[Conflux] MCP server not found at ${this.serverPath}`
            );
            return;
        }

        // Step 1: Find Python
        this.pythonBin = await this.findPython();
        this.outputChannel.appendLine(`[Conflux] Using Python: ${this.pythonBin}`);

        // Step 2: Install dependencies (non-blocking, fire and forget)
        this.installDependencies().catch(() => {
            /* silent — logged inside */
        });

        // Step 3: Write MCP configs with absolute paths
        await this.writeCursorConfig(workspaceRoot);
        await this.writeAntigravityConfig(workspaceRoot);

        this.outputChannel.appendLine('[Conflux] MCP config written. Restart IDE to activate MCP tools.');
    }

    /**
     * Detect the correct Python binary on this machine.
     * Tries: python, python3, py (Windows launcher), then falls back to "python".
     */
    private async findPython(): Promise<string> {
        const candidates = process.platform === 'win32'
            ? ['python', 'python3', 'py']
            : ['python3', 'python'];

        for (const candidate of candidates) {
            try {
                const result = execSync(`${candidate} --version`, {
                    timeout: 5000,
                    stdio: 'pipe',
                }).toString().trim();

                if (result.startsWith('Python')) {
                    this.outputChannel.appendLine(`[Conflux] Found ${candidate}: ${result}`);
                    return candidate;
                }
            } catch {
                // This candidate doesn't exist or errored — try next
            }
        }

        this.outputChannel.appendLine('[Conflux] No Python found — MCP server may not work.');
        return 'python'; // Fallback, hope for the best
    }

    /**
     * Write .cursor/mcp.json for Cursor IDE.
     * Uses absolute paths so it works regardless of CWD.
     */
    private async writeCursorConfig(workspaceRoot: string): Promise<void> {
        const cursorDir = path.join(workspaceRoot, '.cursor');
        const configPath = path.join(cursorDir, 'mcp.json');

        const config: Record<string, any> = {};

        // Read existing config if it exists (don't overwrite other servers)
        if (fs.existsSync(configPath)) {
            try {
                const existing = fs.readFileSync(configPath, 'utf-8');
                Object.assign(config, JSON.parse(existing));
            } catch {
                // Corrupted config — overwrite
            }
        }

        if (!config.mcpServers) {
            config.mcpServers = {};
        }

        // Use absolute paths for both the Python binary and the server script
        config.mcpServers['conflux-team-memory'] = {
            command: this.pythonBin,
            args: [
                this.serverPath,
                '--conflux-dir',
                this.confluxDir,
            ],
        };

        try {
            if (!fs.existsSync(cursorDir)) {
                fs.mkdirSync(cursorDir, { recursive: true });
            }
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
            this.outputChannel.appendLine(`[Conflux] Cursor MCP config → ${configPath}`);
        } catch (error) {
            this.outputChannel.appendLine(`[Conflux] Failed to write Cursor MCP config: ${error}`);
        }
    }

    /**
     * Write MCP config for Antigravity / VS Code compatible forks.
     * Antigravity reads from .vscode/mcp.json.
     */
    private async writeAntigravityConfig(workspaceRoot: string): Promise<void> {
        const vscodeDir = path.join(workspaceRoot, '.vscode');
        const configPath = path.join(vscodeDir, 'mcp.json');

        const config: Record<string, any> = {};

        if (fs.existsSync(configPath)) {
            try {
                const existing = fs.readFileSync(configPath, 'utf-8');
                Object.assign(config, JSON.parse(existing));
            } catch {
                // Corrupted config — overwrite
            }
        }

        if (!config.mcpServers) {
            config.mcpServers = {};
        }

        config.mcpServers['conflux-team-memory'] = {
            command: this.pythonBin,
            args: [
                this.serverPath,
                '--conflux-dir',
                this.confluxDir,
            ],
        };

        try {
            if (!fs.existsSync(vscodeDir)) {
                fs.mkdirSync(vscodeDir, { recursive: true });
            }
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
            this.outputChannel.appendLine(`[Conflux] Antigravity MCP config → ${configPath}`);
        } catch (error) {
            this.outputChannel.appendLine(`[Conflux] Failed to write Antigravity MCP config: ${error}`);
        }
    }

    /**
     * Install Python dependencies for the MCP server.
     * Runs pip install -r requirements.txt in the background.
     */
    public async installDependencies(): Promise<boolean> {
        if (!this.serverPath) {
            return false;
        }

        const requirementsPath = path.join(
            path.dirname(this.serverPath),
            'requirements.txt'
        );

        if (!fs.existsSync(requirementsPath)) {
            return false;
        }

        return new Promise((resolve) => {
            // Use the detected Python binary to run pip
            const proc = spawn(this.pythonBin, ['-m', 'pip', 'install', '-r', requirementsPath, '-q'], {
                cwd: path.dirname(this.serverPath),
                stdio: 'pipe',
            });

            proc.stdout?.on('data', (data: Buffer) => {
                this.outputChannel.appendLine(`[Conflux MCP pip] ${data.toString().trim()}`);
            });

            proc.stderr?.on('data', (data: Buffer) => {
                const msg = data.toString().trim();
                // Only log real errors, not pip warnings
                if (msg && !msg.includes('[notice]')) {
                    this.outputChannel.appendLine(`[Conflux MCP pip] ${msg}`);
                }
            });

            proc.on('close', (code) => {
                if (code === 0) {
                    this.outputChannel.appendLine('[Conflux] MCP server dependencies installed.');
                    resolve(true);
                } else {
                    this.outputChannel.appendLine(`[Conflux] pip install failed with code ${code}`);
                    resolve(false);
                }
            });

            proc.on('error', () => {
                this.outputChannel.appendLine(
                    '[Conflux] Python not found. Install Python to use the MCP server.'
                );
                resolve(false);
            });
        });
    }

    public dispose(): void {
        if (this.mcpProcess) {
            this.mcpProcess.kill();
            this.mcpProcess = null;
        }
    }
}
