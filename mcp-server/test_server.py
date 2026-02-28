# -*- coding: utf-8 -*-
"""
End-to-end test for the Conflux MCP server.
Creates a synthetic .conflux/vectra/index.json with test decisions,
then calls query_team_memory to verify it returns correct results.
"""

import os
import sys
import json
import tempfile
import shutil

# Add the mcp-server directory to path so we can import from server.py
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "mcp-server"))

from server import VectraReader, embed_text, query_team_memory

# Create a temporary .conflux/vectra directory with test data
TEST_DIR = os.path.join(tempfile.gettempdir(), "conflux_test")
VECTRA_DIR = os.path.join(TEST_DIR, ".conflux", "vectra")

def setup_test_data():
    """Create synthetic test decisions with real embeddings."""
    os.makedirs(VECTRA_DIR, exist_ok=True)

    decisions = [
        {
            "text": "Implements JWT-based authentication using Supabase Auth with role-based access control.",
            "filePath": "/src/auth.ts",
            "fileName": "auth.ts",
            "languageId": "typescript",
            "author": "alice",
            "timestamp": "2026-02-26T10:00:00Z",
            "confidence": "decided",
        },
        {
            "text": "Switches database from SQLite to PostgreSQL for production scalability.",
            "filePath": "/src/db.ts",
            "fileName": "db.ts",
            "languageId": "typescript",
            "author": "bob",
            "timestamp": "2026-02-26T11:00:00Z",
            "confidence": "pending",
        },
        {
            "text": "Introduces a repository pattern to decouple database access from business logic.",
            "filePath": "/src/repositories/base.ts",
            "fileName": "base.ts",
            "languageId": "typescript",
            "author": "alice",
            "timestamp": "2026-02-26T12:00:00Z",
            "confidence": "decided",
        },
    ]

    items = []
    for i, decision in enumerate(decisions):
        print(f"  Embedding decision {i+1}/{len(decisions)}: {decision['text'][:50]}...")
        vector = embed_text(decision["text"])
        items.append({
            "id": f"test-{i}",
            "metadata": decision,
            "vector": vector,
        })

    index_data = {
        "version": 1,
        "metadata_config": {},
        "items": items,
    }

    index_path = os.path.join(VECTRA_DIR, "index.json")
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index_data, f)

    print(f"  Wrote {len(items)} items to {index_path}")
    return index_path


def test_vectra_reader():
    """Test the pure-Python Vectra reader."""
    print("\n--- Test: VectraReader ---")
    reader = VectraReader(VECTRA_DIR)

    query = "What authentication method are we using?"
    print(f"  Query: {query}")
    query_vector = embed_text(query)
    results = reader.query(query_vector, top_k=3)

    print(f"  Results: {len(results)}")
    for r in results:
        print(f"    [{r['score']:.4f}] {r['metadata']['text'][:60]}...")

    # Check that auth-related decision is ranked first
    assert len(results) > 0, "No results returned!"
    assert "auth" in results[0]["metadata"]["text"].lower() or "jwt" in results[0]["metadata"]["text"].lower(), \
        f"Expected auth decision first, got: {results[0]['metadata']['text']}"
    print("  PASSED: Auth decision ranked first!")


def test_query_team_memory():
    """Test the MCP tool function directly."""
    print("\n--- Test: query_team_memory MCP tool ---")

    # Override the VECTRA_DIR in the server module
    import server
    server.VECTRA_DIR = VECTRA_DIR

    result = server.query_team_memory("How is the database structured?")
    print(f"  Result:\n{result}")

    assert "Team Decisions" in result, "Expected 'Team Decisions' header in output"
    assert "PostgreSQL" in result or "database" in result.lower(), "Expected database-related decision"
    print("  PASSED: Database decision found!")


def cleanup():
    """Remove test directory."""
    if os.path.exists(TEST_DIR):
        shutil.rmtree(TEST_DIR)


if __name__ == "__main__":
    print("=== Conflux MCP Server End-to-End Test ===\n")

    try:
        print("1. Setting up test data (this downloads the embedding model on first run)...")
        setup_test_data()

        print("\n2. Testing VectraReader...")
        test_vectra_reader()

        print("\n3. Testing query_team_memory MCP tool...")
        test_query_team_memory()

        print("\n=== ALL TESTS PASSED ===")
    except Exception as e:
        print(f"\n=== TEST FAILED: {e} ===")
        import traceback
        traceback.print_exc()
    finally:
        cleanup()
