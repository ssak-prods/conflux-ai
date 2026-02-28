# Conflux — Shared AI Team Memory

> **No context files. No Slack messages. No copy-paste. Just a file save.**

Conflux automatically extracts architectural decisions from your code changes and shares them across your entire team's AI assistants — in real time.

![Conflux Demo](media/icon.png)

## The Problem

AI coding assistants are single-player. Each developer's AI starts blind — it has no knowledge of decisions the rest of the team made. This causes:

- **Architectural drift** — two developers implement the same feature differently
- **Wasted re-explanation** — everyone keeps re-typing the same context into their AI
- **Lead developer bottleneck** — only the person who built it can explain it to the AI

## How Conflux Works

```
Developer saves a file
    ↓
Conflux detects the change (8s debounce)
    ↓
LLM summarizes it into a one-line decision
    ↓
Decision is embedded & stored locally
    ↓
Synced to all teammates in < 5 seconds
    ↓
Every teammate's AI can now query this knowledge via MCP
```

### The Demo

1. **Machine B** asks its AI: *"How should I implement login?"* — gets a generic answer
2. **Machine A** implements Supabase Auth + JWT and saves
3. Conflux extracts: *"Implements JWT-based auth using Supabase Auth"*
4. **Machine B** asks again — gets the correct, team-aware answer
5. The sidebar shows the decision with author, timestamp, and ✅ Decided status

## Features

| Feature | Description |
|---------|-------------|
| 🧠 **Auto-Extract** | Detects code changes and extracts architectural decisions using LLM |
| 📦 **Local Memory** | Stores decisions in `.conflux/` using embedded vector search |
| 🔍 **Semantic Query** | Search team decisions by meaning, not keywords |
| 🔌 **MCP Server** | Your AI assistant queries team memory automatically |
| ⏳→✅ **Confidence** | Tracks pending (file save) vs decided (git commit) |
| 🔄 **Real-time Sync** | Supabase Broadcast syncs decisions across machines |
| 🌐 **Offline-First** | Works without internet; syncs when reconnected |

## Quick Start

### 1. Install
Download the `.vsix` from Releases and install:
```bash
code --install-extension conflux-0.1.0.vsix
```
Works on **VS Code, Cursor, Windsurf, and Antigravity**.

### 2. Set API Key
Get a free key from [console.groq.com](https://console.groq.com), then:

**Settings** → search "conflux" → paste your Groq API key

### 3. Install MCP Dependencies
```bash
cd <extension-path>/mcp-server
pip install -r requirements.txt
```

### 4. Start Coding
Edit some files. Conflux will automatically:
- Extract decisions → show in status bar and sidebar
- Store in local vector DB
- Write MCP config for Cursor/Antigravity

### 5. (Optional) Join a Project Room
`Ctrl+Shift+P` → **Conflux: Join Project Room** → enter your Supabase URL, key, and a shared project code.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  VS Code / Cursor / Antigravity                 │
│                                                 │
│  ┌──────────┐  ┌──────────────┐  ┌───────────┐ │
│  │ DiffTrack│→ │LLM Summarize │→ │ Embedder  │ │
│  │ (8s deb) │  │  (Groq API)  │  │(ONNX CPU) │ │
│  └──────────┘  └──────────────┘  └─────┬─────┘ │
│                                        │       │
│  ┌──────────┐  ┌──────────────┐  ┌─────▼─────┐ │
│  │ Status   │  │  Sidebar     │  │  Vectra   │ │
│  │   Bar    │  │  TreeView    │  │.conflux/  │ │
│  └──────────┘  └──────────────┘  └─────┬─────┘ │
│                                    ┌───┴───┐   │
│                                    │MCP Srv│   │
│                                    │(Python)│   │
│                                    └───┬───┘   │
│                                        │       │
│  ┌─────────────────────────────────────▼─────┐ │
│  │           Supabase Broadcast              │ │
│  │         (real-time team sync)             │ │
│  └───────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

## Technical Details

- **Embedding**: On-device, CPU-only via Transformers.js + ONNX Runtime WASM (`all-MiniLM-L6-v2`)
- **Vector Store**: Vectra (embedded, file-based, no server process)
- **LLM**: Groq free tier (`llama-3.1-8b-instant`)
- **MCP**: FastMCP Python SDK over stdio transport
- **Sync**: Supabase Realtime Broadcast (free tier, no database writes)

## Commands

| Command | Description |
|---------|-------------|
| `Conflux: Query Team Memory` | Semantic search through team decisions |
| `Conflux: Show Status` | Show decision count in memory |
| `Conflux: Join Project Room` | Connect to teammates via shared code |
| `Conflux: Leave Project Room` | Disconnect from team sync |
| `Conflux: Refresh Decisions` | Refresh the sidebar view |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `conflux.groqApiKey` | `""` | Groq API key (required) |
| `conflux.enabled` | `true` | Enable/disable extraction |
| `conflux.debounceMs` | `8000` | Debounce window (ms) |
| `conflux.minDiffLines` | `10` | Min changed lines to trigger |

## Built For

**AMD Slingshot Hackathon 2026** — *Generative AI for Everyone*

## License

MIT
