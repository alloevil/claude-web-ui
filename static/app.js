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
  renderSessionList(sessions);

  if (sessions.length > 0 && !currentSessionId) {
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
  currentAssistantEl.appendChild(bubble);
  $("#messages").appendChild(currentAssistantEl);

  currentTextEl = document.createElement("span");
  currentTextEl.className = "message-text";
  bubble.appendChild(currentTextEl);
}

function appendText(text) {
  ensureAssistantMessage();
  currentTextEl.textContent += text;
}

function appendThinking(text) {
  ensureAssistantMessage();
  // Show thinking in a subtle style
  let thinkEl = currentAssistantEl.querySelector(".thinking-block");
  if (!thinkEl) {
    thinkEl = document.createElement("div");
    thinkEl.className = "thinking-block";
    thinkEl.style.cssText = "color: var(--text-muted); font-style: italic; font-size: 12px; padding: 4px 0; border-left: 2px solid var(--border); padding-left: 8px; margin: 4px 0;";
    const bubble = currentAssistantEl.querySelector(".message-bubble");
    bubble.insertBefore(thinkEl, currentTextEl);
  }
  thinkEl.textContent += text;
}

function startToolBlock(toolId, name, input) {
  ensureAssistantMessage();

  const block = document.createElement("div");
  block.className = "tool-block";
  block.dataset.toolId = toolId;

  const header = document.createElement("div");
  header.className = "tool-header";
  header.innerHTML = `
    <span class="tool-icon">&#9881;</span>
    <span class="tool-name">${escapeHtml(name)}</span>
    <span class="tool-summary">${input ? summarizeToolInput(name, input) : ""}</span>
    <span class="tool-arrow">&#9654;</span>
  `;

  const content = document.createElement("div");
  content.className = "tool-content";
  if (input) {
    content.textContent = JSON.stringify(input, null, 2);
  }

  header.onclick = () => {
    header.classList.toggle("open");
    content.classList.toggle("open");
  };

  block.appendChild(header);
  block.appendChild(content);

  const bubble = currentAssistantEl.querySelector(".message-bubble");
  bubble.appendChild(block);
  toolBlocks[toolId] = { header, content, block };
}

function finishToolBlock(toolUseId, content, isError) {
  const tb = toolBlocks[toolUseId];
  if (!tb) return;

  const resultEl = document.createElement("div");
  resultEl.className = "tool-result" + (isError ? " error" : "");
  const displayContent = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  // Truncate very long results
  if (displayContent.length > 2000) {
    resultEl.textContent = displayContent.slice(0, 2000) + "\n... (truncated)";
  } else {
    resultEl.textContent = displayContent;
  }
  tb.block.appendChild(resultEl);
  tb.resultEl = resultEl;
}

function finishResult(msg) {
  isStreaming = false;
  $("#btn-send").disabled = false;
  toolBlocks = {};

  if (msg.result && currentAssistantEl) {
    const existingText = currentTextEl?.textContent?.trim() || "";
    if (msg.result.trim() && msg.result.trim() !== existingText) {
      // The result might be the final accumulated text
      // Only add if it's different from what we already have
      if (!existingText.includes(msg.result.trim())) {
        currentTextEl.textContent = msg.result;
      }
    }
  }

  // Add result footer
  if (currentAssistantEl && msg.cost !== undefined) {
    const footer = document.createElement("div");
    footer.className = "result-footer";
    const parts = [];
    if (msg.turns) parts.push(`${msg.turns} turns`);
    if (msg.cost) parts.push(`$${msg.cost.toFixed(4)}`);
    if (msg.subtype) parts.push(msg.subtype);
    footer.textContent = parts.join(" · ");
    currentAssistantEl.querySelector(".message-bubble").appendChild(footer);
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
    const res = await fetch(`/api/sessions/${sessionId}/messages`);
    if (!res.ok) return;
    const messages = await res.json();

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
      } else if (msg.role === "assistant" && msg.blocks) {
        const el = document.createElement("div");
        el.className = "message assistant";
        const bubble = document.createElement("div");
        bubble.className = "message-bubble";
        msg.blocks.forEach((block) => {
          if (block.type === "text") {
            const span = document.createElement("span");
            span.textContent = block.text;
            bubble.appendChild(span);
          } else if (block.type === "tool_use") {
            const tb = document.createElement("div");
            tb.className = "tool-block";
            const header = document.createElement("div");
            header.className = "tool-header";
            header.innerHTML = `
              <span class="tool-icon">&#9881;</span>
              <span class="tool-name">${escapeHtml(block.name)}</span>
              <span class="tool-summary">${summarizeToolInput(block.name, block.input)}</span>
              <span class="tool-arrow">&#9654;</span>
            `;
            const content = document.createElement("div");
            content.className = "tool-content";
            content.textContent = JSON.stringify(block.input, null, 2);
            header.onclick = () => {
              header.classList.toggle("open");
              content.classList.toggle("open");
            };
            tb.appendChild(header);
            tb.appendChild(content);
            bubble.appendChild(tb);
          } else if (block.type === "tool_result") {
            const resultEl = document.createElement("div");
            resultEl.className = "tool-result" + (block.is_error ? " error" : "");
            resultEl.textContent = (block.content || "").slice(0, 2000);
            bubble.appendChild(resultEl);
          }
        });
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
