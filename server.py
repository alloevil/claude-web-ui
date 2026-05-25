"""
Claude Code Web UI - FastAPI backend

Provides a web interface for interacting with Claude Code via the Agent SDK.
Sessions are managed through the SDK's built-in session management.
"""

import asyncio
import json
import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("claude-web-ui")

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

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
sessions_meta: dict[str, dict[str, Any]] = {}

# Active query tasks for interrupt support
active_tasks: dict[str, asyncio.Task] = {}

# Default working directory
config_cwd = str(Path.home())

# Runtime status (updated from SDK init messages)
runtime_status: dict[str, Any] = {
    "model": "",
    "cwd": config_cwd,
    "tools": [],
    "slash_commands": [],
    "input_tokens": 0,
    "output_tokens": 0,
    "session_id": "",
    "claude_code_version": "",
    "permission_mode": "",
    "mcp_servers": [],
}


# ─── REST API ───────────────────────────────────────────────────────────────────


@app.get("/api/sessions")
async def api_list_sessions():
    """List all sessions with metadata."""
    try:
        sdk_sessions = list_sessions()
    except Exception as e:
        logger.error(f"list_sessions failed: {e}")
        sdk_sessions = []

    sdk_ids = set()
    result = []
    for s in sdk_sessions:
        sid = s.session_id
        sdk_ids.add(sid)
        meta = sessions_meta.get(sid, {})
        result.append({
            "session_id": sid,
            "name": meta.get("name", s.custom_title or s.summary or f"Session {sid[:8]}"),
            "created_at": meta.get("created_at", ""),
            "summary": s.summary,
        })

    for sid, meta in sessions_meta.items():
        if sid not in sdk_ids and not meta.get("sdk_session_id"):
            result.append({
                "session_id": sid,
                "name": meta.get("name", f"Session {sid[:8]}"),
                "created_at": meta.get("created_at", ""),
                "summary": "",
                "pending": True,
            })

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
    active_tasks.pop(session_id, None)
    try:
        delete_session(session_id)
    except Exception:
        pass
    return {"ok": True}


@app.get("/api/sessions/{session_id}/messages")
async def api_get_messages(session_id: str):
    """Get message history for a session."""
    meta = sessions_meta.get(session_id, {})
    sdk_id = meta.get("sdk_session_id", session_id)
    try:
        messages = get_session_messages(sdk_id)
        result = []
        for msg in messages:
            result.append(_serialize_session_message(msg))
        return result
    except Exception as e:
        logger.error(f"get_session_messages({sdk_id[:12]}...) failed: {e}")
        return []


class RenameRequest(BaseModel):
    name: str


@app.post("/api/sessions/{session_id}/rename")
async def api_rename_session(session_id: str, body: RenameRequest):
    """Rename a session."""
    if session_id in sessions_meta:
        sessions_meta[session_id]["name"] = body.name
    return {"ok": True}


@app.post("/api/sessions/{session_id}/interrupt")
async def api_interrupt_session(session_id: str):
    """Interrupt a running query."""
    task = active_tasks.get(session_id)
    if task and not task.done():
        task.cancel()
        logger.info(f"Interrupted task for session {session_id[:12]}...")
        return {"ok": True, "interrupted": True}
    return {"ok": True, "interrupted": False}


class CwdRequest(BaseModel):
    cwd: str


@app.post("/api/config/cwd")
async def api_set_cwd(body: CwdRequest):
    """Set the default working directory."""
    global config_cwd
    expanded = str(Path(body.cwd).expanduser())
    config_cwd = expanded
    logger.info(f"CWD set to: {config_cwd}")
    return {"ok": True, "cwd": config_cwd}


class CliCommandRequest(BaseModel):
    command: str


@app.post("/api/cli-command")
async def api_cli_command(body: CliCommandRequest):
    """Execute a Claude Code CLI command and return the result."""
    cmd = body.command.strip()
    logger.info(f"CLI command: {cmd}")
    try:
        proc = await asyncio.create_subprocess_exec(
            "claude", "-p", cmd, "--output-format", "json",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=config_cwd,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)

        if proc.returncode != 0:
            return {"ok": False, "error": stderr.decode().strip() or f"Exit code {proc.returncode}"}

        # Parse JSON output — find the result message
        try:
            items = json.loads(stdout.decode())
            # Extract result text from the JSON array
            result_text = ""
            for item in items:
                if isinstance(item, dict):
                    if item.get("type") == "result":
                        result_text = item.get("result", "")
                        break
                    elif item.get("type") == "assistant":
                        msg = item.get("message", {})
                        for block in msg.get("content", []):
                            if block.get("type") == "text":
                                result_text += block.get("text", "")
            return {"ok": True, "result": result_text or stdout.decode().strip()}
        except json.JSONDecodeError:
            return {"ok": True, "result": stdout.decode().strip()}

    except asyncio.TimeoutError:
        return {"ok": False, "error": "Command timed out (30s)"}
    except FileNotFoundError:
        return {"ok": False, "error": "claude CLI not found"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/api/config")
async def api_get_config():
    """Get current configuration."""
    return {"cwd": config_cwd}


@app.get("/api/status")
async def api_get_status():
    """Get runtime status (model, tokens, tools, etc.)."""
    # If model is not set yet, try to get it from CLI
    if not runtime_status.get("model"):
        try:
            proc = await asyncio.create_subprocess_exec(
                "claude", "-p", "hi", "--output-format", "json",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=config_cwd,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
            items = json.loads(stdout.decode())
            for item in items:
                if item.get("type") == "system" and item.get("subtype") == "init":
                    d = item
                    runtime_status["model"] = d.get("model", "")
                    runtime_status["tools"] = d.get("tools", [])
                    runtime_status["slash_commands"] = d.get("slash_commands", [])
                    runtime_status["claude_code_version"] = d.get("claude_code_version", "")
                    runtime_status["permission_mode"] = d.get("permissionMode", "")
                    runtime_status["mcp_servers"] = d.get("mcp_servers", [])
                    runtime_status["cwd"] = d.get("cwd", config_cwd)
                    break
        except Exception as e:
            logger.warning(f"Failed to get init info from CLI: {type(e).__name__}: {e}")
    return runtime_status


@app.get("/api/files")
async def api_list_files(path: str = ""):
    """List files in the working directory for @mentions."""
    base = Path(config_cwd)
    target = (base / path).resolve() if path else base
    if not target.exists() or not target.is_dir():
        return []
    try:
        entries = []
        for p in sorted(target.iterdir()):
            if p.name.startswith("."):
                continue
            rel = str(p.relative_to(base))
            entries.append({
                "name": p.name,
                "path": rel,
                "is_dir": p.is_dir(),
            })
        return entries[:50]  # Limit results
    except PermissionError:
        return []


# ─── WebSocket ──────────────────────────────────────────────────────────────────


@app.websocket("/ws/{session_id}")
async def websocket_endpoint(ws: WebSocket, session_id: str):
    """WebSocket endpoint for real-time chat with Claude Code."""
    await ws.accept()

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
        options = ClaudeAgentOptions(
            permission_mode="bypassPermissions",
            resume=sdk_session_id,
            include_partial_messages=True,
            cwd=config_cwd,
        )
    else:
        options = ClaudeAgentOptions(
            permission_mode="bypassPermissions",
            include_partial_messages=True,
            cwd=config_cwd,
        )

    async def _run_query():
        async for message in query(prompt=user_text, options=options):
            if isinstance(message, ResultMessage) and message.session_id:
                sdk_id = message.session_id
                sessions_meta.setdefault(session_id, {})["sdk_session_id"] = sdk_id
                logger.info(f"SDK session created: {sdk_id} (was {session_id[:12]}...)")
                await ws.send_json({
                    "type": "session_ready",
                    "session_id": sdk_id,
                    "old_session_id": session_id,
                })
            elif isinstance(message, SystemMessage) and message.subtype == "init":
                sid = message.data.get("session_id")
                if sid:
                    sessions_meta.setdefault(session_id, {})["sdk_session_id"] = sid
            await _forward_message(ws, message, session_id)

    # Store task for interrupt support
    task = asyncio.create_task(_run_query())
    active_tasks[session_id] = task

    try:
        await task
    except asyncio.CancelledError:
        logger.info(f"Query cancelled for session {session_id[:12]}...")
        await ws.send_json({"type": "result", "result": "Interrupted", "session_id": session_id, "subtype": "interrupted"})
    except Exception as e:
        await ws.send_json({"type": "error", "message": str(e)})
    finally:
        active_tasks.pop(session_id, None)


async def _forward_message(ws: WebSocket, message: Any, session_id: str):
    """Forward an SDK message to the WebSocket client."""
    if isinstance(message, AssistantMessage):
        for block in message.content:
            if isinstance(block, TextBlock):
                pass  # Already streamed via StreamEvent text_delta
            elif isinstance(block, ThinkingBlock):
                pass  # Already streamed via StreamEvent thinking_delta
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
        # Capture init data for status bar
        if message.subtype == "init" and message.data:
            d = message.data
            runtime_status["model"] = d.get("model", "")
            runtime_status["cwd"] = d.get("cwd", config_cwd)
            runtime_status["tools"] = d.get("tools", [])
            runtime_status["slash_commands"] = d.get("slash_commands", [])
            runtime_status["session_id"] = d.get("session_id", "")
            runtime_status["claude_code_version"] = d.get("claude_code_version", "")
            runtime_status["permission_mode"] = d.get("permissionMode", "")
            runtime_status["mcp_servers"] = d.get("mcp_servers", [])
        await ws.send_json({
            "type": "system",
            "subtype": message.subtype,
            "data": message.data,
            "session_id": session_id,
        })

    elif isinstance(message, StreamEvent):
        event = message.event
        event_type = event.get("type", "")
        if event_type == "content_block_delta":
            delta = event.get("delta", {})
            delta_type = delta.get("type", "")
            if delta_type == "text_delta":
                await ws.send_json({
                    "type": "text_delta",
                    "content": delta.get("text", ""),
                    "session_id": session_id,
                })
            elif delta_type == "thinking_delta":
                thinking_text = delta.get("thinking", "")
                if thinking_text:
                    await ws.send_json({
                        "type": "thinking",
                        "content": thinking_text,
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
        elif event_type == "message_start":
            msg_data = event.get("message", {})
            if msg_data.get("model"):
                runtime_status["model"] = msg_data["model"]
        elif event_type == "message_delta":
            usage = event.get("usage", {})
            if usage:
                runtime_status["input_tokens"] = usage.get("input_tokens", 0)
                runtime_status["output_tokens"] = usage.get("output_tokens", 0)
                # Forward usage to client
                await ws.send_json({
                    "type": "usage",
                    "input_tokens": usage.get("input_tokens", 0),
                    "output_tokens": usage.get("output_tokens", 0),
                    "session_id": session_id,
                })

    elif isinstance(message, UserMessage):
        pass


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
            elif isinstance(block, ThinkingBlock):
                thinking_text = getattr(block, "thinking", "") or ""
                if thinking_text:
                    blocks.append({"type": "thinking", "text": thinking_text})
            elif isinstance(block, ToolUseBlock):
                blocks.append({"type": "tool_use", "name": block.name, "input": block.input})
            elif isinstance(block, ToolResultBlock):
                c = block.content if isinstance(block.content, str) else json.dumps(block.content)
                blocks.append({"type": "tool_result", "content": c, "is_error": block.is_error})
        result["blocks"] = blocks
    elif isinstance(message, UserMessage):
        if isinstance(message.content, str):
            result["content"] = message.content
    elif isinstance(message, dict):
        content = message.get("content", "")
        if isinstance(content, str):
            result["content"] = content
        elif isinstance(content, list):
            blocks = []
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        blocks.append({"type": "text", "text": block.get("text", "")})
                    elif block.get("type") == "thinking":
                        blocks.append({"type": "thinking", "text": block.get("thinking", "")})
                    elif block.get("type") == "tool_use":
                        blocks.append({"type": "tool_use", "name": block.get("name", ""), "input": block.get("input", {})})
                elif isinstance(block, TextBlock):
                    blocks.append({"type": "text", "text": block.text})
                elif isinstance(block, ThinkingBlock):
                    t = getattr(block, "thinking", "") or ""
                    if t:
                        blocks.append({"type": "thinking", "text": t})
            result["blocks"] = blocks
        else:
            result["content"] = str(content)
    elif message is not None:
        result["content"] = str(message)

    return result


# ─── Static files ───────────────────────────────────────────────────────────────

static_dir = Path(__file__).parent / "static"
app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
