/**
 * Project Room v2 — Zero-config team formation.
 *
 * Supabase credentials are embedded in the extension (anon keys are
 * public by design — RLS handles security). Users only enter a 6-digit
 * alphanumeric project code to join a team.
 *
 * Owner flow:  "Start a Project"  → describe → mode → get code
 * Joiner flow: "Join your Team"   → enter code → brief → done
 */

import * as vscode from 'vscode';
import * as os from 'os';
import { SyncLayer, SyncConfig } from './syncLayer';

// ─── Hardcoded Supabase credentials (anon/publishable key — safe to embed) ───
const SUPABASE_URL = 'https://hwdprsbrccwvnypyxgbt.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_UnG686t9DBnjODL7XSQdtg_85ndOnTI';

export interface ProjectConfig {
    projectCode: string;
    projectDescription: string;
    mode: 'active' | 'stealth';
    displayName: string;
    createdAt: string;
}

export class ProjectRoom implements vscode.Disposable {
    private syncLayer: SyncLayer;
    private outputChannel: vscode.OutputChannel;
    private disposables: vscode.Disposable[] = [];
    private _onDidJoin = new vscode.EventEmitter<ProjectConfig>();
    public readonly onDidJoin = this._onDidJoin.event;
    private _onDidLeave = new vscode.EventEmitter<void>();
    public readonly onDidLeave = this._onDidLeave.event;

    constructor(syncLayer: SyncLayer, outputChannel: vscode.OutputChannel) {
        this.syncLayer = syncLayer;
        this.outputChannel = outputChannel;
    }

    /**
     * Register commands for project room management.
     */
    public registerCommands(context: vscode.ExtensionContext): void {
        this.disposables.push(
            vscode.commands.registerCommand('conflux.startProject', () =>
                this.startProject(context)
            ),
            vscode.commands.registerCommand('conflux.joinProject', () =>
                this.joinProject(context)
            ),
            vscode.commands.registerCommand('conflux.leaveProject', () =>
                this.leaveProject(context)
            )
        );

        // Auto-rejoin if config exists from a previous session
        this.autoRejoin(context);
    }

    /**
     * Generate a 6-digit alphanumeric project code.
     * Charset: 0-9, A-Z (no lowercase to avoid confusion, no O/0/I/1/L ambiguity)
     * 30^6 = 729 million unique codes — more than enough.
     */
    private generateCode(): string {
        const chars = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // 30 chars, no ambiguous ones
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }

    /**
     * Owner flow: Start a new project.
     * Steps: project description → mode → generate code → connect
     */
    private async startProject(context: vscode.ExtensionContext): Promise<void> {
        // Step 1: What are you building?
        const description = await vscode.window.showInputBox({
            prompt: 'What are you building?',
            placeHolder: 'e.g. A product recommender web app for a 48-hour hackathon',
            ignoreFocusOut: true,
        });

        if (!description) {
            return;
        }

        // Step 2: How involved should Conflux be?
        const modeChoice = await vscode.window.showQuickPick(
            [
                {
                    label: '$(eye) Active',
                    description: 'Recommended — full co-pilot with warnings and suggestions',
                    detail: 'Full co-pilot. Warns about conflicts, suggests connections, narrates your final demo.',
                    picked: true,
                    value: 'active',
                },
                {
                    label: '$(eye-closed) Stealth',
                    description: 'Watches silently — your AI gets smarter without interruptions',
                    detail: 'Conflux runs in the background. Your AI gets team context, but you never hear from us.',
                    value: 'stealth',
                },
            ],
            {
                placeHolder: 'How much should Conflux help?',
                ignoreFocusOut: true,
            }
        );

        if (!modeChoice) {
            return;
        }

        // Step 3: Generate the project code
        const projectCode = this.generateCode();
        const displayName = os.userInfo().username || 'unknown';

        const config: ProjectConfig = {
            projectCode,
            projectDescription: description,
            mode: (modeChoice as any).value || 'active',
            displayName,
            createdAt: new Date().toISOString(),
        };

        // Save config
        await context.workspaceState.update('conflux.projectConfig', config);

        // Connect to Supabase
        const connected = await this.connectToRoom(config.projectCode);

        if (connected) {
            this._onDidJoin.fire(config);

            // Show the code prominently
            const action = await vscode.window.showInformationMessage(
                `Conflux: Project created! Share this code with your team: ${projectCode}`,
                'Copy Code'
            );
            if (action === 'Copy Code') {
                await vscode.env.clipboard.writeText(projectCode);
                vscode.window.showInformationMessage('Project code copied to clipboard!');
            }
        } else {
            vscode.window.showWarningMessage(
                'Conflux: Connected locally. Sync will activate when internet is available.'
            );
            // Still fire join event — offline-first
            this._onDidJoin.fire(config);
        }
    }

    /**
     * Joiner flow: Join an existing project.
     * One input: the 6-digit project code.
     */
    private async joinProject(context: vscode.ExtensionContext): Promise<void> {
        const projectCode = await vscode.window.showInputBox({
            prompt: 'Enter the 6-digit project code from your team lead',
            placeHolder: 'e.g. K4M7R2',
            ignoreFocusOut: true,
            validateInput: (value) => {
                const clean = value.trim().toUpperCase();
                if (clean.length !== 6) {
                    return 'Project code must be exactly 6 characters';
                }
                if (!/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(clean)) {
                    return 'Invalid characters in project code';
                }
                return null;
            },
        });

        if (!projectCode) {
            return;
        }

        const code = projectCode.trim().toUpperCase();
        const displayName = os.userInfo().username || 'unknown';

        const config: ProjectConfig = {
            projectCode: code,
            projectDescription: '', // Will be synced from owner
            mode: 'active',
            displayName,
            createdAt: new Date().toISOString(),
        };

        // Save config
        await context.workspaceState.update('conflux.projectConfig', config);

        // Connect
        const connected = await this.connectToRoom(code);

        if (connected) {
            this._onDidJoin.fire(config);
            vscode.window.showInformationMessage(
                `Conflux: Joined project ${code}. Your AI is now briefed with your team's context.`
            );
        } else {
            vscode.window.showWarningMessage(
                'Conflux: Connected locally. Sync will activate when internet is available.'
            );
            this._onDidJoin.fire(config);
        }
    }

    /**
     * Connect to a Supabase broadcast room.
     */
    private async connectToRoom(projectCode: string): Promise<boolean> {
        const syncConfig: SyncConfig = {
            supabaseUrl: SUPABASE_URL,
            supabaseAnonKey: SUPABASE_ANON_KEY,
            projectCode,
        };

        return this.syncLayer.connect(syncConfig);
    }

    /**
     * Leave the current project room.
     */
    private async leaveProject(context: vscode.ExtensionContext): Promise<void> {
        await this.syncLayer.disconnect();
        await context.workspaceState.update('conflux.projectConfig', undefined);
        this._onDidLeave.fire();
        vscode.window.showInformationMessage('Conflux: Left the project room.');
    }

    /**
     * Auto-rejoin a project room if config exists from a previous session.
     */
    private async autoRejoin(context: vscode.ExtensionContext): Promise<void> {
        const config = context.workspaceState.get<ProjectConfig>('conflux.projectConfig');
        if (config && config.projectCode) {
            this.outputChannel.appendLine(
                `[Conflux] Auto-rejoining project room: ${config.projectCode}`
            );
            const connected = await this.connectToRoom(config.projectCode);
            if (connected) {
                this._onDidJoin.fire(config);
            }
        }
    }

    /**
     * Get the current project config (if joined).
     */
    public getConfig(context: vscode.ExtensionContext): ProjectConfig | undefined {
        return context.workspaceState.get<ProjectConfig>('conflux.projectConfig');
    }

    /**
     * Check if currently in a project room.
     */
    public isInRoom(): boolean {
        return this.syncLayer.isActive();
    }

    public dispose(): void {
        this._onDidJoin.dispose();
        this._onDidLeave.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
    }
}
