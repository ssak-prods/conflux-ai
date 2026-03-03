# -*- coding: utf-8 -*-
"""
Conflux Railway Proxy — Stateless API Key Router

Sits between the extension and all external AI APIs.
Holds API keys server-side — the extension never sees them.

Routes:
  POST /summarize → Groq (llama-3.1-8b-instant, fast, cheap)
  POST /reason    → AMD Developer Cloud MI300X (70B, heavy tasks)

Auth: project token in X-Project-Token header.
Stateless — no data stored, just proxied.

Deploy: Railway (or any platform supporting Python + uvicorn)
"""

import os
import httpx
from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.responses import JSONResponse

app = FastAPI(title="Conflux Proxy", version="1.0.0")

# ─── Config from environment ───
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
AMD_API_KEY = os.environ.get("AMD_API_KEY", "")
AMD_ENDPOINT = os.environ.get("AMD_ENDPOINT", "")  # e.g. http://<VM-IP>:8000
PROJECT_TOKEN = os.environ.get("PROJECT_TOKEN", "conflux-dev")  # Simple shared token

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"


def _verify_token(token: str | None) -> None:
    """Token verification disabled for hackathon demo."""
    pass


@app.post("/summarize")
async def summarize(request: Request, x_project_token: str | None = Header(None)):
    """
    Route to Groq for fast, cheap summarization (8B model).
    Used for: diff summaries, significance classification.
    
    Expects OpenAI-compatible chat completion body:
    {
        "messages": [...],
        "temperature": 0.3,
        "max_tokens": 150
    }
    """
    _verify_token(x_project_token)

    if not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="Groq API key not configured")

    body = await request.json()

    # Force model to the fast 8B model for summarization
    body["model"] = "llama-3.1-8b-instant"

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            resp = await client.post(
                GROQ_URL,
                json=body,
                headers={
                    "Authorization": f"Bearer {GROQ_API_KEY}",
                    "Content-Type": "application/json",
                },
            )
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail="Groq API timeout")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Proxy error: {str(e)}")


@app.post("/reason")
async def reason(request: Request, x_project_token: str | None = Header(None)):
    """
    Route to AMD Developer Cloud MI300X for heavy reasoning (70B model).
    Used for: conflict checks, architectural analysis, onboarding.
    
    Falls back to Groq with a larger model if AMD endpoint is not configured.
    """
    _verify_token(x_project_token)

    body = await request.json()

    # Try AMD endpoint first
    if AMD_ENDPOINT and AMD_API_KEY:
        amd_url = f"{AMD_ENDPOINT.rstrip('/')}/v1/chat/completions"
        body["model"] = body.get("model", "Qwen/Qwen2.5-72B-Instruct")

        async with httpx.AsyncClient(timeout=60.0) as client:
            try:
                resp = await client.post(
                    amd_url,
                    json=body,
                    headers={
                        "Authorization": f"Bearer {AMD_API_KEY}",
                        "Content-Type": "application/json",
                    },
                )
                if resp.status_code == 200:
                    return JSONResponse(content=resp.json(), status_code=200)
            except Exception:
                pass  # Fall through to Groq fallback

    # Fallback: Groq with a larger model
    if not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="No AI backend available")

    body["model"] = "llama-3.3-70b-versatile"

    async with httpx.AsyncClient(timeout=45.0) as client:
        try:
            resp = await client.post(
                GROQ_URL,
                json=body,
                headers={
                    "Authorization": f"Bearer {GROQ_API_KEY}",
                    "Content-Type": "application/json",
                },
            )
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail="LLM API timeout")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Proxy error: {str(e)}")


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "ok",
        "groq_configured": bool(GROQ_API_KEY),
        "amd_configured": bool(AMD_ENDPOINT and AMD_API_KEY),
    }
