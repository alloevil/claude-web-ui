"""
Claude Code Web UI - FastAPI backend

Provides a web interface for interacting with Claude Code via the Agent SDK.
Sessions are managed through the SDK's built-in session management.
"""

import asyncio
import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    delete_session,
    get_session_messages,
    list_sessions,
    query,
)

app = FastAPI(title="Claude Code Web UI")

# In-memory session metadata (name, created_at, etc.)
# The SDK handles actual session persistence
sessions_meta: dict[str, dict[str, Any]] = {}


# ─── REST API ───────────────────────────────────────────────────────────────────


@app.get("/api/sessions")
async def api_list_sessions():
    """List all sessions with metadata."""
    try:
        sdk_sessions = list_sessions()
    except Exception:
        sdk_sessions = []

    result = []
    for s in sdk_sessions:
        sid = s.session_id
        meta = sessions_meta.get(sid, {})
        result.append({
            "session_id": sid,
            "name": meta.get("name", s.custom_title or s.summary or f"Session {sid[:8]}"),
            "created_at": meta.get("created_at", ""),
            "summary": s.summary,
        })
    # Sort by created_at descending, fallback to SDK order
    result.sort(key=lambda x: x["created_at"], reverse=True)
    return result


@app.post("/api/sessions")
async def api_create_session():
    """Create a new session."""
    sid = str(uuid.uuid4())
    sessions_meta[sid] = {
        "name": f"Session {len(sessions_meta) + 1}",
        "created_at": datetime.now().isoformat(),
    }
    return {"session_id": sid, "name": sessions_meta[sid]["name"]}


@app.delete("/api/sessions/{session_id}")
async def api_delete_session(session_id: str):
    """Delete a session."""
    sessions_meta.pop(session_id, None)
    try:
        delete_session(session_id)
    except Exception:
        pass
    return {"ok": True}


@app.get("/api/sessions/{session_id}/messages")
async def api_get_messages(session_id: str):
    """Get message history for a session."""
    try:
        messages = get_session_messages(session_id)
        result = []
        for msg in messages:
            result.append(_serialize_session_message(msg))
        return result
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=404)


# ─── WebSocket ──────────────────────────────────────────────────────────────────


@app.websocket("/ws/{session_id}")
async def websocket_endpoint(ws: WebSocket, session_id: str):
    """WebSocket endpoint for real-time chat with Claude Code."""
    await ws.accept()

    # Ensure session metadata exists
    if session_id not in sessions_meta:
        sessions_meta[session_id] = {
            "name": f"Session {len(sessions_meta) + 1}",
            "created_at": datetime.now().isoformat(),
        }

    try:
        while True:
            data = await ws.receive_text()
            msg = json.loads(data)

            if msg.get("type") == "message":
                user_text = msg.get("content", "")
                await _handle_chat(ws, session_id, user_text)
            elif msg.get("type") == "rename":
                new_name = msg.get("name", "")
                if session_id in sessions_meta:
                    sessions_meta[session_id]["name"] = new_name

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass


async def _handle_chat(ws: WebSocket, session_id: str, user_text: str):
    """Process a user message through the Claude Agent SDK and stream back."""
    meta = sessions_meta.get(session_id, {})
    sdk_session_id = meta.get("sdk_session_id")

    if sdk_session_id:
        # Resume existing SDK session
        options = ClaudeAgentOptions(
            permission_mode="bypassPermissions",
            resume=sdk_session_id,
            include_partial_messages=True,
            cwd=str(Path.home()),
        )
    else:
        # First message: create a new SDK session with our chosen ID
        options = ClaudeAgentOptions(
            permission_mode="bypassPermissions",
            session_id=session_id,
            include_partial_messages=True,
            cwd=str(Path.home()),
        )

    try:
        async for message in query(prompt=user_text, options=options):
            # Capture the actual SDK session ID from ResultMessage
            if isinstance(message, ResultMessage) and message.session_id:
                sessions_meta.setdefault(session_id, {})["sdk_session_id"] = message.session_id
            await _forward_message(ws, message, session_id)
    except Exception as e:
        await ws.send_json({"type": "error", "message": str(e)})


async def _forward_message(ws: WebSocket, message: Any, session_id: str):
    """Forward an SDK message to the WebSocket client."""
    if isinstance(message, AssistantMessage):
        for block in message.content:
            if isinstance(block, TextBlock):
                await ws.send_json({
                    "type": "text",
                    "content": block.text,
                    "session_id": session_id,
                })
            elif isinstance(block, ThinkingBlock):
                await ws.send_json({
                    "type": "thinking",
                    "content": block.thinking if hasattr(block, "thinking") else "",
                    "session_id": session_id,
                })
            elif isinstance(block, ToolUseBlock):
                await ws.send_json({
                    "type": "tool_use",
                    "tool_id": block.id,
                    "name": block.name,
                    "input": block.input,
                    "session_id": session_id,
                })
            elif isinstance(block, ToolResultBlock):
                content = block.content if isinstance(block.content, str) else json.dumps(block.content)
                await ws.send_json({
                    "type": "tool_result",
                    "tool_use_id": block.tool_use_id,
                    "content": content,
                    "is_error": block.is_error or False,
                    "session_id": session_id,
                })

    elif isinstance(message, ResultMessage):
        await ws.send_json({
            "type": "result",
            "result": message.result or "",
            "session_id": session_id,
            "subtype": message.subtype,
            "is_error": message.is_error,
            "cost": message.total_cost_usd,
            "turns": message.num_turns,
        })

    elif isinstance(message, SystemMessage):
        await ws.send_json({
            "type": "system",
            "subtype": message.subtype,
            "data": message.data,
            "session_id": session_id,
        })

    elif isinstance(message, StreamEvent):
        event = message.event
        event_type = event.get("type", "")
        # Forward streaming text deltas
        if event_type == "content_block_delta":
            delta = event.get("delta", {})
            if delta.get("type") == "text_delta":
                await ws.send_json({
                    "type": "text_delta",
                    "content": delta.get("text", ""),
                    "session_id": session_id,
                })
        elif event_type == "content_block_start":
            block = event.get("content_block", {})
            if block.get("type") == "tool_use":
                await ws.send_json({
                    "type": "tool_use_start",
                    "tool_id": block.get("id", ""),
                    "name": block.get("name", ""),
                    "session_id": session_id,
                })

    elif isinstance(message, UserMessage):
        pass  # Don't echo user messages back


def _serialize_session_message(msg: Any) -> dict:
    """Serialize a SessionMessage to JSON-safe dict."""
    result = {"role": getattr(msg, "type", "unknown")}
    message = getattr(msg, "message", None)

    if isinstance(message, str):
        result["content"] = message
    elif isinstance(message, AssistantMessage):
        blocks = []
        for block in message.content:
            if isinstance(block, TextBlock):
                blocks.append({"type": "text", "text": block.text})
            elif isinstance(block, ToolUseBlock):
                blocks.append({"type": "tool_use", "name": block.name, "input": block.input})
            elif isinstance(block, ToolResultBlock):
                c = block.content if isinstance(block.content, str) else json.dumps(block.content)
                blocks.append({"type": "tool_result", "content": c, "is_error": block.is_error})
        result["blocks"] = blocks
    elif isinstance(message, UserMessage):
        if isinstance(message.content, str):
            result["content"] = message.content
    elif message is not None:
        result["content"] = str(message)

    return result


# ─── Static files ───────────────────────────────────────────────────────────────

static_dir = Path(__file__).parent / "static"
app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
