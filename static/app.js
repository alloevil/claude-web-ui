/**
 * Claude Code Web UI - Frontend
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── State ─────────────────────────────────────────────────────────────

let currentSessionId = null;
let ws = null;
let isStreaming = false;
let currentAssistantEl = null;
let currentTextEl = null;
let toolBlocks = {};  // tool_id -> { header, content, resultEl }

// ─── Init ──────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  $("#btn-new-session").onclick = createSession;
  $("#btn-new-empty").onclick = createSession;
  $("#btn-send").onclick = sendMessage;
  $("#btn-delete").onclick = deleteCurrentSession;

  const input = $("#input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener("input", autoResize);

  loadSessions();
});

// ─── Sessions ──────────────────────────────────────────────────────────

async function loadSessions() {
  const res = await fetch("/api/sessions");
  const sessions = await res.json();
  console.log(`[loadSessions] Got ${sessions.length} sessions, currentSessionId=${currentSessionId}`);
  renderSessionList(sessions);

  if (sessions.length > 0 && !currentSessionId) {
    console.log(`[loadSessions] Auto-switching to: ${sessions[0].session_id}`);
    switchSession(sessions[0].session_id);
  }
}

async function createSession() {
  const res = await fetch("/api/sessions", { method: "POST" });
  const data = await res.json();
  await loadSessions();
  switchSession(data.session_id);
}

async function deleteCurrentSession() {
  if (!currentSessionId) return;
  if (!confirm("Delete this session?")) return;

  await fetch(`/api/sessions/${currentSessionId}`, { method: "DELETE" });
  currentSessionId = null;
  disconnectWS();
  showEmpty();
  await loadSessions();
}

function switchSession(sessionId) {
  if (isStreaming) return;
  currentSessionId = sessionId;
  disconnectWS();
  connectWS(sessionId);
  showChat();
  highlightSession(sessionId);
  loadHistory(sessionId);
}

function renderSessionList(sessions) {
  const list = $("#session-list");
  list.innerHTML = "";
  sessions.forEach((s) => {
    const el = document.createElement("div");
    el.className = "session-item" + (s.session_id === currentSessionId ? " active" : "");
    el.dataset.id = s.session_id;
    el.dataset.tooltip = escapeHtml(s.name);
    el.innerHTML = `
      <span class="session-icon">&#9679;</span>
      <span class="session-name">${escapeHtml(s.name)}</span>
    `;
    el.onclick = () => switchSession(s.session_id);
    list.appendChild(el);
  });
}

function highlightSession(sessionId) {
  $$(".session-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === sessionId);
  });
  const meta = $(`[data-id="${sessionId}"] .session-name`);
  if (meta) $("#chat-title").textContent = meta.textContent;
}

function showEmpty() {
  $("#empty-state").classList.remove("hidden");
  $("#chat-view").classList.add("hidden");
}

function showChat() {
  $("#empty-state").classList.add("hidden");
  $("#chat-view").classList.remove("hidden");
  $("#messages").innerHTML = "";
  $("#input").focus();
}

// ─── WebSocket ─────────────────────────────────────────────────────────

function connectWS(sessionId) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws/${sessionId}`);

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleWSMessage(msg);
  };

  ws.onclose = () => {
    if (isStreaming) finishStreaming();
  };

  ws.onerror = (e) => {
    console.error("WebSocket error", e);
  };
}

function disconnectWS() {
  if (ws) {
    ws.close();
    ws = null;
  }
  finishStreaming();
}

// ─── Message handling ──────────────────────────────────────────────────

function handleWSMessage(msg) {
  switch (msg.type) {
    case "text":
    case "text_delta":
      appendText(msg.content);
      break;
    case "thinking":
      appendThinking(msg.content);
      break;
    case "tool_use":
      startToolBlock(msg.tool_id, msg.name, msg.input);
      break;
    case "tool_use_start":
      startToolBlock(msg.tool_id, msg.name, null);
      break;
    case "tool_result":
      finishToolBlock(msg.tool_use_id, msg.content, msg.is_error);
      break;
    case "result":
      finishResult(msg);
      break;
    case "system":
      handleSystemMessage(msg);
      break;
    case "session_ready":
      // SDK assigned a real session ID
      if (msg.session_id && msg.session_id !== currentSessionId) {
        currentSessionId = msg.session_id;
        // Refresh session list to pick up the new SDK session
        loadSessions();
      }
      break;
    case "error":
      appendError(msg.message);
      break;
  }
  scrollToBottom();
}

function handleSystemMessage(msg) {
  if (msg.subtype === "init") {
    // Session initialized, update title if needed
    const sid = msg.data?.session_id;
    if (sid && !currentSessionId) {
      currentSessionId = sid;
    }
  }
}

// ─── Rendering ─────────────────────────────────────────────────────────

function ensureAssistantMessage() {
  if (currentAssistantEl) return;
  isStreaming = true;
  $("#btn-send").disabled = true;

  currentAssistantEl = document.createElement("div");
  currentAssistantEl.className = "message assistant";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.style.display = "none"; // Hidden until content arrives
  currentAssistantEl.appendChild(bubble);
  $("#messages").appendChild(currentAssistantEl);
}

function ensureBubble() {
  ensureAssistantMessage();
  const bubble = currentAssistantEl.querySelector(".message-bubble");
  bubble.style.display = "";
  if (!currentTextEl) {
    currentTextEl = document.createElement("span");
    currentTextEl.className = "message-text";
    bubble.appendChild(currentTextEl);
  }
  return bubble;
}

function appendText(text) {
  ensureBubble();
  currentTextEl.textContent += text;
}

function appendThinking(text) {
  const bubble = ensureBubble();
  let thinkEl = currentAssistantEl.querySelector(".thinking-block");
  if (!thinkEl) {
    thinkEl = document.createElement("div");
    thinkEl.className = "thinking-block";
    thinkEl.style.cssText = "color: var(--text-muted); font-style: italic; font-size: 12px; padding: 4px 0; border-left: 2px solid var(--border); padding-left: 8px; margin: 4px 0;";
    bubble.insertBefore(thinkEl, currentTextEl);
  }
  thinkEl.textContent += text;
}

function startToolBlock(toolId, name, input) {
  const bubble = ensureBubble();

  const el = createToolCallEl(name, input);
  el.dataset.toolId = toolId;

  bubble.appendChild(el);
  toolBlocks[toolId] = { block: el };
}

function finishToolBlock(toolUseId, content, isError) {
  const tb = toolBlocks[toolUseId];
  if (!tb) return;

  const displayContent = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  if (!displayContent) return;

  const resultEl = document.createElement("div");
  resultEl.className = "tool-call-result" + (isError ? " error" : "");
  const truncated = displayContent.length > 1000 ? displayContent.slice(0, 1000) + "\n..." : displayContent;
  resultEl.textContent = truncated;
  tb.block.appendChild(resultEl);
}

function finishResult(msg) {
  isStreaming = false;
  $("#btn-send").disabled = false;
  toolBlocks = {};

  // Text was already streamed via text_delta, no need to set from result

  // Format any JSON in the message
  if (currentAssistantEl) {
    formatJsonInElement(currentAssistantEl.querySelector(".message-bubble"));
  }

  // Add result footer
  if (msg.cost !== undefined) {
    const bubble = ensureBubble();
    const footer = document.createElement("div");
    footer.className = "result-footer";
    const parts = [];
    if (msg.turns) parts.push(`${msg.turns} turns`);
    if (msg.cost) parts.push(`$${msg.cost.toFixed(4)}`);
    if (msg.subtype) parts.push(msg.subtype);
    footer.textContent = parts.join(" · ");
    bubble.appendChild(footer);
  }

  resetCurrent();
  scrollToBottom();
}

function appendError(message) {
  const el = document.createElement("div");
  el.className = "message assistant";
  el.innerHTML = `<div class="message-bubble" style="color: var(--error); border-color: var(--error);">Error: ${escapeHtml(message)}</div>`;
  $("#messages").appendChild(el);
  finishStreaming();
}

function finishStreaming() {
  isStreaming = false;
  $("#btn-send").disabled = false;
  toolBlocks = {};
  resetCurrent();
}

function resetCurrent() {
  currentAssistantEl = null;
  currentTextEl = null;
}

function scrollToBottom() {
  const container = $("#messages");
  container.scrollTop = container.scrollHeight;
}

// ─── Tool call display ────────────────────────────────────────────────

const TOOL_DESCRIPTIONS = {
  Read: (input) => `Reading ${input.file_path || "file"}`,
  Write: (input) => `Writing ${input.file_path || "file"}`,
  Edit: (input) => `Editing ${input.file_path || "file"}`,
  Bash: (input) => `Running: ${input.command || ""}`,
  Glob: (input) => `Searching files: ${input.pattern || ""}`,
  Grep: (input) => `Searching content: ${input.query || input.pattern || ""}`,
  Agent: (input) => `Spawning sub-agent: ${(input.prompt || "").slice(0, 60)}`,
  WebFetch: (input) => `Fetching: ${input.url || ""}`,
  WebSearch: (input) => `Searching: ${input.query || ""}`,
  TodoRead: () => `Reading task list`,
  TodoWrite: () => `Updating task list`,
  NotebookEdit: (input) => `Editing notebook: ${input.notebook_path || ""}`,
};

function createToolCallEl(name, input) {
  const el = document.createElement("div");
  el.className = "tool-call";

  const desc = TOOL_DESCRIPTIONS[name];
  const summary = desc ? desc(input) : `Using ${name}`;

  const header = document.createElement("div");
  header.className = "tool-call-header";
  header.innerHTML = `<span class="tool-call-icon">⚙</span> <span class="tool-call-text">${escapeHtml(summary)}</span>`;

  // Collapsible detail with original input
  const detail = document.createElement("div");
  detail.className = "tool-call-detail";
  if (input) {
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(input, null, 2);
    detail.appendChild(pre);
  }

  header.onclick = () => {
    header.classList.toggle("open");
    detail.classList.toggle("open");
  };

  el.appendChild(header);
  el.appendChild(detail);
  return el;
}

// ─── JSON formatting ───────────────────────────────────────────────────

function formatJsonInElement(el) {
  // Walk text nodes and wrap JSON blocks in <pre><code>
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const node of textNodes) {
    const text = node.textContent;
    // Try to find JSON objects/arrays in the text
    const jsonPattern = /(\{[\s\S]*?\}|\[[\s\S]*?\])/g;
    let match;
    let lastIndex = 0;
    let hasJson = false;
    const fragment = document.createDocumentFragment();

    while ((match = jsonPattern.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[0]);
        hasJson = true;
        // Add text before JSON
        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }
        // Create formatted JSON block with syntax highlighting
        const pre = document.createElement("pre");
        pre.className = "json-block";
        const code = document.createElement("code");
        code.innerHTML = highlightJson(JSON.stringify(parsed, null, 2));
        pre.appendChild(code);
        fragment.appendChild(pre);
        lastIndex = match.index + match[0].length;
      } catch (e) {
        // Not valid JSON, skip
      }
    }

    if (hasJson) {
      // Add remaining text
      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
      node.parentNode.replaceChild(fragment, node);
    }
  }
}

function formatJsonString(text) {
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(parsed, null, 2);
  } catch (e) {
    return text;
  }
}

function highlightJson(json) {
  // Escape HTML first, then add syntax highlighting spans
  const escaped = json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped.replace(
    /("(?:\\.|[^"\\])*")\s*(:)?|(\b(?:true|false)\b)|(\bnull\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, str, colon, bool, nil, num) => {
      if (str) {
        if (colon) {
          // It's a key
          return `<span class="json-key">${str}</span>:`;
        }
        // It's a string value
        return `<span class="json-string">${str}</span>`;
      }
      if (bool) return `<span class="json-boolean">${bool}</span>`;
      if (nil) return `<span class="json-null">${nil}</span>`;
      if (num) return `<span class="json-number">${num}</span>`;
      return match;
    }
  );
}

// ─── Send ──────────────────────────────────────────────────────────────

function createUserBubble(text) {
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  // Detect terminal/long output: has newlines, error traces, or is long
  const isTerminalOutput = text.includes("\n") && text.length > 150;

  if (isTerminalOutput) {
    // Show a short preview, collapsible full content
    const preview = document.createElement("div");
    preview.className = "user-preview";
    const firstLine = text.split("\n")[0];
    preview.textContent = firstLine.length > 80 ? firstLine.slice(0, 80) + "..." : firstLine;
    bubble.appendChild(preview);

    const toggle = document.createElement("span");
    toggle.className = "user-toggle";
    toggle.textContent = "Show full output";
    bubble.appendChild(toggle);

    const fullBlock = document.createElement("pre");
    fullBlock.className = "user-full-output";
    fullBlock.textContent = text;
    bubble.appendChild(fullBlock);

    toggle.onclick = () => {
      const isOpen = fullBlock.classList.toggle("open");
      toggle.textContent = isOpen ? "Hide" : "Show full output";
    };
  } else {
    bubble.textContent = text;
  }

  return bubble;
}

function sendMessage() {
  const input = $("#input");
  const text = input.value.trim();
  if (!text || isStreaming || !ws || ws.readyState !== WebSocket.OPEN) return;

  // Render user message
  const el = document.createElement("div");
  el.className = "message user";
  el.appendChild(createUserBubble(text));
  $("#messages").appendChild(el);
  scrollToBottom();

  // Send via WebSocket
  ws.send(JSON.stringify({ type: "message", content: text }));

  // Reset input
  input.value = "";
  input.style.height = "auto";
  input.focus();
}

// ─── Load history ──────────────────────────────────────────────────────

async function loadHistory(sessionId) {
  try {
    const url = `/api/sessions/${sessionId}/messages`;
    console.log(`[loadHistory] Fetching: ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[loadHistory] Response not OK: ${res.status}`);
      return;
    }
    const messages = await res.json();
    console.log(`[loadHistory] Got ${messages.length} messages`);

    const container = $("#messages");
    container.innerHTML = "";

    messages.forEach((msg) => {
      if (msg.role === "user") {
        const text = typeof msg.content === "string" ? msg.content : (msg.blocks || []).map(b => b.text || "").join("");
        if (!text) return;
        const el = document.createElement("div");
        el.className = "message user";
        el.appendChild(createUserBubble(text));
        container.appendChild(el);
      } else if (msg.role === "assistant") {
        const el = document.createElement("div");
        el.className = "message assistant";
        const bubble = document.createElement("div");
        bubble.className = "message-bubble";

        if (msg.blocks) {
          msg.blocks.forEach((block) => {
            if (block.type === "text") {
              const span = document.createElement("span");
              span.textContent = block.text;
              bubble.appendChild(span);
            } else if (block.type === "tool_use") {
              bubble.appendChild(createToolCallEl(block.name, block.input));
            }
          });
        } else if (msg.content) {
          const span = document.createElement("span");
          span.textContent = msg.content;
          bubble.appendChild(span);
        }

        formatJsonInElement(bubble);
        el.appendChild(bubble);
        container.appendChild(el);
      }
    });
    scrollToBottom();
  } catch (e) {
    console.error("Failed to load history", e);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function autoResize() {
  const el = $("#input");
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function summarizeToolInput(name, input) {
  if (!input) return "";
  if (name === "Read" || name === "Write" || name === "Edit") {
    return input.file_path || "";
  }
  if (name === "Bash") {
    const cmd = input.command || "";
    return cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
  }
  if (name === "Glob" || name === "Grep") {
    return input.pattern || input.query || "";
  }
  return "";
}
