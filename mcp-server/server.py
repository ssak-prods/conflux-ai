# -*- coding: utf-8 -*-
"""
Conflux MCP Server v2 — Team Intelligence Layer

Exposes:
  Tool:     conflux_report  — batch flush of chat decisions (write path)
  Tool:     query_team_memory — semantic search of team decisions (read path, legacy)
  Resource: conflux://project-state — rolling ~300-word project summary (read path)

The MCP server is a thin local process. It:
  - Reads from .conflux/vectra/ (the local vector store)
  - Writes incoming reports to .conflux/inbox/ (picked up by the extension)
  - Serves the rolling project summary as an MCP Resource

Transport: stdio (IDE-agnostic — works with Cursor, Antigravity, Windsurf, VS Code)
"""

import sys
import os
import json
import math
import time
import uuid
import argparse
from typing import Optional
from datetime import datetime, timezone

from mcp.server.fastmcp import FastMCP

# ─── Pure-Python Vectra Index Reader ───

class VectraReader:
    """
    Reads a Vectra index.json file directly, without requiring vectra-py.
    Provides zero-dependency fallback for querying the vector store.
    """

    def __init__(self, index_path: str):
        self.index_path = index_path
        self._data: Optional[dict] = None

    def _load(self) -> dict:
        """Load or reload the index from disk."""
        index_file = os.path.join(self.index_path, "index.json")
        if not os.path.exists(index_file):
            return {"items": []}

        with open(index_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        self._data = data
        return data

    def query(self, query_vector: list[float], top_k: int = 5) -> list[dict]:
        """Find top-k most similar items using cosine similarity."""
        data = self._load()
        items = data.get("items", [])

        if not items:
            return []

        results = []
        for item in items:
            vec = item.get("vector", [])
            if not vec:
                continue

            score = self._cosine_similarity(query_vector, vec)
            results.append({
                "score": score,
                "metadata": item.get("metadata", {}),
                "id": item.get("id", ""),
            })

        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:top_k]

    def get_all_items(self) -> list[dict]:
        """Get all items from the index (for project summary generation)."""
        data = self._load()
        return data.get("items", [])

    @staticmethod
    def _cosine_similarity(a: list[float], b: list[float]) -> float:
        if len(a) != len(b):
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x * x for x in a))
        norm_b = math.sqrt(sum(x * x for x in b))
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)


# ─── Embedding (sentence-transformers) ───

_embedder = None

def get_embedder():
    global _embedder
    if _embedder is None:
        from sentence_transformers import SentenceTransformer
        _embedder = SentenceTransformer("all-MiniLM-L6-v2")
    return _embedder


def embed_text(text: str) -> list[float]:
    model = get_embedder()
    embedding = model.encode(text, normalize_embeddings=True)
    return embedding.tolist()


# ─── State Files ───

def _read_flush_state(conflux_dir: str) -> dict:
    """Read the FLUSH_REQUESTED flag and metadata."""
    state_file = os.path.join(conflux_dir, "flush_state.json")
    if os.path.exists(state_file):
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"flush_requested": False, "reason": "", "timestamp": ""}


def _clear_flush_state(conflux_dir: str) -> None:
    """Clear the FLUSH_REQUESTED flag after the AI has flushed."""
    state_file = os.path.join(conflux_dir, "flush_state.json")
    try:
        with open(state_file, "w", encoding="utf-8") as f:
            json.dump({"flush_requested": False, "reason": "", "timestamp": ""}, f)
    except Exception:
        pass


def _write_to_inbox(conflux_dir: str, payload: dict) -> str:
    """Write a report payload to .conflux/inbox/ as a JSON file."""
    inbox_dir = os.path.join(conflux_dir, "inbox")
    os.makedirs(inbox_dir, exist_ok=True)

    file_id = f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
    file_path = os.path.join(inbox_dir, f"{file_id}.json")

    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    return file_path


def _build_project_summary(vectra_dir: str, flush_state: dict) -> str:
    """
    Build a rolling ~300-word project state summary from all stored decisions.
    This is exposed as an MCP Resource and auto-prepended to AI conversations.
    """
    reader = VectraReader(vectra_dir)
    items = reader.get_all_items()

    if not items:
        summary = (
            "# Conflux — Team Project State\n\n"
            "No team decisions recorded yet. The team has just started working.\n"
            "As code changes are made and discussions happen, decisions will appear here.\n"
        )
        if flush_state.get("flush_requested"):
            summary += (
                f"\n⚠️ FLUSH_REQUESTED: {flush_state.get('reason', 'Architectural change detected')}. "
                "Call conflux_report NOW with your recent decisions.\n"
            )
        return summary

    # Sort by timestamp (most recent first)
    sorted_items = sorted(
        items,
        key=lambda x: x.get("metadata", {}).get("timestamp", ""),
        reverse=True,
    )

    # Build summary from decisions
    decided = []
    pending = []
    for item in sorted_items:
        meta = item.get("metadata", {})
        text = meta.get("text", "")
        confidence = meta.get("confidence", "pending")
        if confidence == "decided":
            decided.append(text)
        else:
            pending.append(text)

    lines = ["# Conflux — Team Project State\n"]

    if decided:
        lines.append("## ✅ Confirmed Decisions")
        for d in decided[:10]:  # Top 10 most recent
            lines.append(f"- {d}")
        lines.append("")

    if pending:
        lines.append("## ⏳ In-Progress / Uncommitted")
        for p in pending[:5]:  # Top 5
            lines.append(f"- {p}")
        lines.append("")

    lines.append(f"\n_Total: {len(decided)} confirmed, {len(pending)} pending "
                 f"| Last updated: {datetime.now(timezone.utc).strftime('%H:%M UTC')}_\n")

    # FLUSH_REQUESTED injection
    if flush_state.get("flush_requested"):
        lines.append(
            f"\n⚠️ FLUSH_REQUESTED: {flush_state.get('reason', 'Architectural change detected')}. "
            "Call conflux_report NOW with your recent decisions, then reset.\n"
        )

    return "\n".join(lines)


# ─── CLI Args ───

parser = argparse.ArgumentParser(description="Conflux MCP Server v2")
parser.add_argument(
    "--conflux-dir",
    type=str,
    default=None,
    help="Path to the .conflux directory (defaults to CWD/.conflux)",
)
args, _ = parser.parse_known_args()

CONFLUX_DIR = args.conflux_dir or os.path.join(os.getcwd(), ".conflux")
VECTRA_DIR = os.path.join(CONFLUX_DIR, "vectra")

# ─── MCP Server ───

mcp = FastMCP(
    name="Conflux",
    instructions=(
        "You are connected to Conflux, a team intelligence system that keeps "
        "all teammates' AIs aligned. The project state resource contains your team's "
        "current decisions — use it to give consistent answers.\n\n"
        "REPORTING PROTOCOL:\n"
        "Every ~5 messages (or immediately if you see FLUSH_REQUESTED in the project state), "
        "call conflux_report ONCE with a structured batch of all decisions, choices, "
        "rejections, and open questions from your recent conversation window. "
        "Do NOT call it for debugging, formatting, or explanations — only for "
        "architectural decisions and significant technical choices.\n"
    ),
)


@mcp.tool()
def conflux_report(
    session_window: str,
    decisions: str,
    open_questions: str = "",
    no_decision_turns: str = "",
) -> str:
    """
    Report a batch of decisions from your conversation to keep the team aligned.

    Call this every ~5 messages with everything that matters from that window.
    If you see FLUSH_REQUESTED in the project state, call immediately.
    Do NOT call for debugging, formatting, or pure explanations.

    Args:
        session_window: Which turns this covers, e.g. "turns 1-5"
        decisions: JSON array of decisions. Each: {"turn": 2, "decision": "Using Supabase Auth with JWT", "confidence": "high", "context": "Compared Firebase vs Supabase"}
        open_questions: JSON array of unresolved questions, e.g. ["Should we use RLS or middleware?"]
        no_decision_turns: Comma-separated turn numbers with no decisions, e.g. "1,3,4"

    Returns:
        Confirmation with any conflict warnings from prior team decisions.
    """
    try:
        # Parse the decisions JSON
        try:
            decisions_list = json.loads(decisions) if decisions else []
        except json.JSONDecodeError:
            # If the AI passes a plain string, wrap it
            decisions_list = [{"turn": 0, "decision": decisions, "confidence": "medium", "context": ""}]

        try:
            questions_list = json.loads(open_questions) if open_questions else []
        except json.JSONDecodeError:
            questions_list = [open_questions] if open_questions else []

        # Build the inbox payload
        payload = {
            "type": "chat_flush",
            "session_window": session_window,
            "decisions": decisions_list,
            "open_questions": questions_list,
            "no_decision_turns": no_decision_turns,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "source": "mcp_report",
        }

        # Write to inbox for the extension to pick up
        file_path = _write_to_inbox(CONFLUX_DIR, payload)

        # Clear FLUSH_REQUESTED flag since the AI just flushed
        _clear_flush_state(CONFLUX_DIR)

        # Check for potential conflicts against existing decisions
        conflict_notes = []
        if decisions_list and os.path.exists(VECTRA_DIR):
            reader = VectraReader(VECTRA_DIR)
            for dec in decisions_list[:3]:  # Check top 3 decisions
                dec_text = dec.get("decision", "") if isinstance(dec, dict) else str(dec)
                if dec_text:
                    try:
                        vec = embed_text(dec_text)
                        similar = reader.query(vec, top_k=2)
                        for s in similar:
                            if s["score"] > 0.85:  # Very similar existing decision
                                existing = s["metadata"].get("text", "")
                                if existing.lower() != dec_text.lower():
                                    conflict_notes.append(
                                        f"⚠️ Similar existing decision (match {s['score']:.0%}): \"{existing}\""
                                    )
                    except Exception:
                        pass  # Embedding not available — skip conflict check

        result = f"✅ Batch recorded: {len(decisions_list)} decisions, {len(questions_list)} open questions."
        if conflict_notes:
            result += "\n\n**Potential conflicts with existing team decisions:**\n"
            result += "\n".join(conflict_notes)
            result += "\n\nPlease verify these don't contradict prior team choices."

        return result

    except Exception as e:
        return f"Report accepted (with warnings): {str(e)}"


@mcp.tool()
def query_team_memory(query: str) -> str:
    """
    Search the team's shared memory for architectural decisions relevant to your query.

    Use this when you need specific context about past team decisions.
    The project state resource already contains a summary — use this tool
    only when you need deeper search on a specific topic.

    Args:
        query: Natural language question about the project's architecture.
               Examples: "What authentication method are we using?",
                        "How is the database structured?"

    Returns:
        Formatted list of relevant team decisions with confidence levels.
    """
    try:
        if not os.path.exists(VECTRA_DIR):
            return (
                "No team memory found yet. The Conflux extension hasn't processed "
                "any code changes yet. Keep coding — decisions will appear automatically."
            )

        query_vector = embed_text(query)

        reader = VectraReader(VECTRA_DIR)
        results = reader.query(query_vector, top_k=5)

        if not results:
            return "No team decisions found matching your query."

        lines = ["## Team Decisions\n"]
        for i, r in enumerate(results, 1):
            meta = r["metadata"]
            confidence = "✅" if meta.get("confidence") == "decided" else "⏳"
            score_pct = f"{r['score'] * 100:.0f}%"

            lines.append(
                f"{i}. {confidence} **{meta.get('text', 'No summary')}**\n"
                f"   - File: `{meta.get('fileName', 'unknown')}`\n"
                f"   - Author: {meta.get('author', 'unknown')}\n"
                f"   - When: {meta.get('timestamp', 'unknown')}\n"
                f"   - Relevance: {score_pct}\n"
            )

        return "\n".join(lines)

    except Exception as e:
        return f"Error querying team memory: {str(e)}"


# ─── MCP Resource: Project State ───

@mcp.resource("conflux://project-state")
def get_project_state() -> str:
    """
    Rolling ~300-word summary of all team decisions.
    Auto-prepended to every AI conversation by the IDE.
    Contains FLUSH_REQUESTED flag when the file watcher detects
    an architectural change and the AI hasn't reported recently.
    """
    flush_state = _read_flush_state(CONFLUX_DIR)
    return _build_project_summary(VECTRA_DIR, flush_state)


if __name__ == "__main__":
    mcp.run(transport="stdio")
