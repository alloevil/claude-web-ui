# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A local web interface for Claude Code. The browser connects to a Python backend via WebSocket, which streams responses from the Claude Agent SDK. No build step — the frontend is vanilla HTML/CSS/JS served as static files.

## Commands

```bash
# Install dependencies
pip install -r requirements.txt

# Run the server (auto-reload enabled)
uvicorn server:app --reload --port 8080

# Or use the convenience script (installs deps + starts server)
bash start.sh
```

There is no test suite or linter configured.

## Architecture

**Backend** (`server.py`) — A single FastAPI file that:
- Serves the static frontend from `static/` (mounted at `/`)
- Exposes REST endpoints under `/api/` for session CRUD, config, file browsing, and runtime status
- Hosts a WebSocket endpoint at `/ws/{session_id}` that bridges the browser to the Claude Agent SDK
- Stores session metadata in-memory (`sessions_meta` dict) — not persisted across restarts
- Tracks active query tasks in `active_tasks` to support interrupt/cancel

**Frontend** (`static/`) — Three files with no build pipeline:
- `index.html` — Layout with sidebar (session list), main chat area, and CWD dialog
- `app.js` — All frontend logic: WebSocket handling, message rendering, autocomplete (slash commands and @file mentions), session management, input history (localStorage)
- `style.css` — Dark theme using CSS custom properties

## Data Flow

```
User types message → app.js → WebSocket JSON → server.py
  → claude_agent_sdk.query(prompt, options) → async generator
  → StreamEvent/AssistantMessage/ResultMessage → _forward_message()
  → WebSocket JSON → app.js → DOM rendering (markdown via marked.js, syntax via highlight.js)
```

## WebSocket Message Types

Server-to-client messages that `app.js` handles:
- `text_delta` / `text` — Incremental text content
- `thinking` — Extended thinking content (rendered in collapsible block)
- `tool_use` / `tool_use_start` — Tool invocation with name and input
- `tool_result` — Tool output (rendered in collapsible block)
- `result` — Final message with cost, turns, subtype
- `usage` — Token count updates
- `system` — Init data (model, tools, cwd, slash_commands from SDK)
- `session_ready` — SDK session ID assignment
- `error` — Error messages

## Session ID Mapping

Sessions use a two-layer ID system: `sessions_meta` keys are UUIDs created by the REST API, but the SDK assigns its own session ID on first query. The mapping is stored in `sessions_meta[sid]["sdk_session_id"]`. History loading and session resume use the SDK ID.

## Key Implementation Details

- The `claude-agent-sdk` package provides `query()`, `list_sessions()`, `get_session_messages()`, `delete_session()`, and message type classes (`AssistantMessage`, `StreamEvent`, etc.)
- Permission mode is hardcoded to `"bypassPermissions"` in `_handle_chat()`
- The default working directory (`config_cwd`) starts as `$HOME` and can be changed via the CWD dialog or `/api/config/cwd`
- Slash commands are initially hardcoded in `app.js` but get replaced by SDK-reported commands on `system.init`
- Tool call rendering uses `TOOL_DESCRIPTIONS` map in `app.js` to produce human-readable summaries for known tools (Read, Write, Edit, Bash, Glob, Grep, Agent, WebFetch, WebSearch, etc.)
- Markdown rendering: `marked.js` with `highlight.js` for code blocks; copy buttons added dynamically after rendering
