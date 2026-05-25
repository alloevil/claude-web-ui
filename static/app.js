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
let toolBlocks = {};
let currentCwd = "~";

// Status
let statusData = { model: "", input_tokens: 0, output_tokens: 0, cost: 0, turns: 0 };

// Input history
let inputHistory = JSON.parse(localStorage.getItem("claude_history") || "[]");
let historyIndex = -1;
let historyDraft = "";

// Autocomplete
let acItems = [];
let acIndex = 0;
let acMode = null; // "slash" | "file" | null

// ─── Marked setup ──────────────────────────────────────────────────────

marked.setOptions({
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try { return hljs.highlight(code, { language: lang }).value; } catch (e) {}
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true,
  gfm: true,
});

// ─── Init ──────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  $("#btn-new-session").onclick = createSession;
  $("#btn-new-empty").onclick = createSession;
  $("#btn-send").onclick = sendMessage;
  $("#btn-delete").onclick = deleteCurrentSession;
  $("#btn-stop").onclick = stopStreaming;
  $("#btn-rename").onclick = renameCurrentSession;

  // CWD dialog
  $("#status-cwd").onclick = showCwdDialog;
  $("#cwd-cancel").onclick = hideCwdDialog;
  $("#cwd-confirm").onclick = confirmCwd;

  const input = $("#input");
  input.addEventListener("keydown", handleInputKeydown);
  input.addEventListener("input", handleInputChange);
  document.addEventListener("keydown", handleGlobalKeydown);

  // Click outside autocomplete to close
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#autocomplete") && !e.target.closest("#input")) {
      hideAutocomplete();
    }
  });

  loadSessions();
  fetchStatus();
});

// ─── Keyboard shortcuts ────────────────────────────────────────────────

function handleGlobalKeydown(e) {
  if (e.key === "Escape") {
    if (isStreaming) { stopStreaming(); e.preventDefault(); }
    if (acMode) { hideAutocomplete(); e.preventDefault(); }
    return;
  }
  if (e.key === "/" && document.activeElement !== $("#input") && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    const input = $("#input");
    input.focus();
    input.value = "/";
    handleInputChange();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "n") { e.preventDefault(); createSession(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === "l") { e.preventDefault(); $("#messages").innerHTML = ""; return; }
}

function handleInputKeydown(e) {
  const input = e.target;

  // Autocomplete navigation
  if (acMode) {
    if (e.key === "ArrowDown") { e.preventDefault(); acMove(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); acMove(-1); return; }
    if (e.key === "Tab" || e.key === "Enter") {
      if (acItems.length > 0) {
        e.preventDefault();
        acSelect();
        return;
      }
    }
    if (e.key === "Escape") { hideAutocomplete(); e.preventDefault(); return; }
  }

  // Send on Enter (no autocomplete active)
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
    return;
  }

  // Input history (only when input is empty or navigating)
  if (e.key === "ArrowUp" && !acMode) {
    if (input.value === "" || historyIndex >= 0) {
      e.preventDefault();
      navigateHistory(-1);
      return;
    }
  }
  if (e.key === "ArrowDown" && !acMode) {
    if (historyIndex >= 0) {
      e.preventDefault();
      navigateHistory(1);
      return;
    }
  }
}

function handleInputChange() {
  const input = $("#input");
  autoResize();

  const text = input.value;
  const cursorPos = input.selectionStart;

  // Detect slash command at start
  if (text.startsWith("/")) {
    const query = text.slice(1);
    showSlashAutocomplete(query);
    return;
  }

  // Detect @mention
  const beforeCursor = text.slice(0, cursorPos);
  const atMatch = beforeCursor.match(/@(\S*)$/);
  if (atMatch) {
    showFileAutocomplete(atMatch[1]);
    return;
  }

  hideAutocomplete();
}

// ─── Input history ─────────────────────────────────────────────────────

function navigateHistory(direction) {
  const input = $("#input");

  if (historyIndex === -1) {
    historyDraft = input.value;
  }

  historyIndex += direction;
  if (historyIndex < -1) historyIndex = -1;
  if (historyIndex >= inputHistory.length) {
    historyIndex = inputHistory.length - 1;
  }

  if (historyIndex === -1) {
    input.value = historyDraft;
  } else {
    input.value = inputHistory[inputHistory.length - 1 - historyIndex];
  }

  autoResize();
  // Move cursor to end
  setTimeout(() => { input.selectionStart = input.selectionEnd = input.value.length; }, 0);
}

function saveToHistory(text) {
  if (!text.trim()) return;
  // Avoid duplicates at the end
  if (inputHistory.length > 0 && inputHistory[inputHistory.length - 1] === text) return;
  inputHistory.push(text);
  if (inputHistory.length > 200) inputHistory = inputHistory.slice(-200);
  localStorage.setItem("claude_history", JSON.stringify(inputHistory));
}

// ─── Autocomplete ──────────────────────────────────────────────────────

// Populated from SDK init message. Only commands the SDK actually supports.
let SLASH_COMMANDS = [
  { name: "clear", desc: "Clear conversation", icon: "🧹" },
  { name: "compact", desc: "Compact conversation", icon: "📦" },
  { name: "context", desc: "Show context info", icon: "📋" },
  { name: "heapdump", desc: "Heap dump", icon: "📊" },
  { name: "init", desc: "Initialize project", icon: "🚀" },
  { name: "review", desc: "Code review", icon: "🔍" },
  { name: "code-review", desc: "Code review", icon: "🔍" },
  { name: "security-review", desc: "Security review", icon: "🛡️" },
  { name: "usage", desc: "Show token usage", icon: "📈" },
  { name: "update-config", desc: "Update configuration", icon: "⚙️" },
  { name: "verify", desc: "Verify code", icon: "✅" },
  { name: "debug", desc: "Debug mode", icon: "🐛" },
  { name: "batch", desc: "Batch operations", icon: "📦" },
  { name: "loop", desc: "Loop mode", icon: "🔄" },
  { name: "run", desc: "Run command", icon: "▶️" },
  { name: "claude-api", desc: "Claude API usage", icon: "🔌" },
  { name: "insights", desc: "Show insights", icon: "💡" },
  { name: "goal", desc: "Set goal", icon: "🎯" },
  { name: "fewer-permission-prompts", desc: "Reduce prompts", icon: "🔇" },
  { name: "run-skill-generator", desc: "Generate skills", icon: "⚡" },
  { name: "team-onboarding", desc: "Team onboarding", icon: "👥" },
];

const SLASH_COMMAND_META = {
  "help": { desc: "Show help", icon: "❓" },
  "clear": { desc: "Clear conversation", icon: "🧹" },
  "compact": { desc: "Compact conversation", icon: "📦" },
  "cost": { desc: "Show cost breakdown", icon: "💰" },
  "model": { desc: "Switch model", icon: "🤖" },
  "status": { desc: "Show status", icon: "📊" },
  "config": { desc: "Show configuration", icon: "⚙️" },
  "init": { desc: "Initialize project", icon: "🚀" },
  "permissions": { desc: "Manage permissions", icon: "🔒" },
  "review": { desc: "Code review", icon: "🔍" },
  "code-review": { desc: "Code review", icon: "🔍" },
  "security-review": { desc: "Security review", icon: "🛡️" },
  "usage": { desc: "Show token usage", icon: "📈" },
  "context": { desc: "Show context info", icon: "📋" },
  "update-config": { desc: "Update configuration", icon: "⚙️" },
  "verify": { desc: "Verify code", icon: "✅" },
  "debug": { desc: "Debug mode", icon: "🐛" },
  "batch": { desc: "Batch operations", icon: "📦" },
  "fewer-permission-prompts": { desc: "Reduce permission prompts", icon: "🔇" },
  "loop": { desc: "Loop mode", icon: "🔄" },
  "claude-api": { desc: "Claude API usage", icon: "🔌" },
  "run": { desc: "Run command", icon: "▶️" },
  "run-skill-generator": { desc: "Generate skills", icon: "⚡" },
  "heapdump": { desc: "Heap dump", icon: "📊" },
  "insights": { desc: "Show insights", icon: "💡" },
  "goal": { desc: "Set goal", icon: "🎯" },
  "team-onboarding": { desc: "Team onboarding", icon: "👥" },
};

function showSlashAutocomplete(query) {
  const filtered = SLASH_COMMANDS.filter(c => c.name.startsWith(query.toLowerCase()));
  if (filtered.length === 0) { hideAutocomplete(); return; }

  acMode = "slash";
  acItems = filtered;
  acIndex = 0;
  renderAutocomplete(query);
}

async function showFileAutocomplete(query) {
  try {
    // Get directory path from query
    const dir = query.includes("/") ? query.slice(0, query.lastIndexOf("/")) : "";
    const prefix = query.includes("/") ? query.slice(query.lastIndexOf("/") + 1) : query;

    const res = await fetch(`/api/files?path=${encodeURIComponent(dir)}`);
    const files = await res.json();

    const filtered = files.filter(f => f.name.toLowerCase().startsWith(prefix.toLowerCase()));
    if (filtered.length === 0) { hideAutocomplete(); return; }

    acMode = "file";
    acItems = filtered;
    acIndex = 0;
    renderAutocomplete(prefix);
  } catch (e) {
    hideAutocomplete();
  }
}

function renderAutocomplete(highlight) {
  const dropdown = $("#autocomplete");
  dropdown.innerHTML = "";

  acItems.forEach((item, i) => {
    const el = document.createElement("div");
    el.className = "autocomplete-item" + (i === acIndex ? " selected" : "");

    if (acMode === "slash") {
      el.innerHTML = `
        <span class="ac-icon">${item.icon}</span>
        <span class="ac-label">/${highlightMatch(item.name, highlight)}</span>
        <span class="ac-desc">${item.desc}</span>
      `;
    } else if (acMode === "file") {
      const icon = item.is_dir ? "📁" : "📄";
      el.innerHTML = `
        <span class="ac-icon">${icon}</span>
        <span class="ac-label">${highlightMatch(item.name, highlight)}</span>
        <span class="ac-desc">${item.path}</span>
      `;
    }

    el.onclick = () => { acIndex = i; acSelect(); };
    el.onmouseenter = () => {
      dropdown.querySelectorAll(".selected").forEach(s => s.classList.remove("selected"));
      el.classList.add("selected");
      acIndex = i;
    };
    dropdown.appendChild(el);
  });

  dropdown.classList.remove("hidden");
}

function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);
  return escapeHtml(before) + "<mark>" + escapeHtml(match) + "</mark>" + escapeHtml(after);
}

function acMove(dir) {
  acIndex = (acIndex + dir + acItems.length) % acItems.length;
  const dropdown = $("#autocomplete");
  dropdown.querySelectorAll(".autocomplete-item").forEach((el, i) => {
    el.classList.toggle("selected", i === acIndex);
  });
  // Scroll into view
  const selected = dropdown.querySelector(".selected");
  if (selected) selected.scrollIntoView({ block: "nearest" });
}

function acSelect() {
  const input = $("#input");
  const item = acItems[acIndex];

  if (acMode === "slash") {
    input.value = "/" + item.name + " ";
    hideAutocomplete();
    input.focus();
  } else if (acMode === "file") {
    const text = input.value;
    const cursorPos = input.selectionStart;
    const beforeCursor = text.slice(0, cursorPos);
    const afterCursor = text.slice(cursorPos);
    const newBefore = beforeCursor.replace(/@(\S*)$/, "@" + item.path + (item.is_dir ? "/" : " "));
    input.value = newBefore + afterCursor;
    hideAutocomplete();
    input.focus();
    input.selectionStart = input.selectionEnd = newBefore.length;
  }
}

function hideAutocomplete() {
  acMode = null;
  acItems = [];
  acIndex = 0;
  const dropdown = $("#autocomplete");
  if (dropdown) dropdown.classList.add("hidden");
}

// ─── Status bar ────────────────────────────────────────────────────────

function persistSessionStatus() {
  if (!currentSessionId) return;
  const saved = JSON.parse(localStorage.getItem("claude_session_status") || "{}");
  saved[currentSessionId] = {
    input_tokens: statusData.input_tokens,
    output_tokens: statusData.output_tokens,
    cost: statusData.cost,
    turns: statusData.turns,
  };
  localStorage.setItem("claude_session_status", JSON.stringify(saved));
}

function loadSessionStatus(sessionId) {
  const saved = JSON.parse(localStorage.getItem("claude_session_status") || "{}");
  const s = saved[sessionId];
  if (s) {
    statusData.input_tokens = s.input_tokens || 0;
    statusData.output_tokens = s.output_tokens || 0;
    statusData.cost = s.cost || 0;
    statusData.turns = s.turns || 0;
  } else {
    statusData.input_tokens = 0;
    statusData.output_tokens = 0;
    statusData.cost = 0;
    statusData.turns = 0;
  }
}

async function fetchStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    statusData.model = data.model || statusData.model;
    statusData.claude_code_version = data.claude_code_version || statusData.claude_code_version;
    statusData.permission_mode = data.permission_mode || statusData.permission_mode;
    statusData.tools = data.tools || statusData.tools;
    statusData.mcp_servers = data.mcp_servers || statusData.mcp_servers;
    if (data.cwd) currentCwd = data.cwd;
    updateStatusBar();
  } catch (e) {}
}

function updateStatusBar() {
  const { model, input_tokens, output_tokens, cost, turns } = statusData;
  const totalTokens = input_tokens + output_tokens;

  // Model
  const modelShort = model ? model.split("/").pop().replace(/^claude-/, "") : "";
  $("#status-model").textContent = modelShort;

  // Context usage bar
  const contextLimit = 200000; // typical context window
  const pct = Math.min((input_tokens / contextLimit) * 100, 100);
  const fill = $("#context-fill");
  fill.style.width = pct + "%";
  fill.className = "context-fill" + (pct > 80 ? " danger" : pct > 60 ? " warn" : "");
  $("#context-text").textContent = totalTokens > 0 ? formatTokens(totalTokens) : "";

  // Session
  $("#status-session").textContent = currentSessionId ? `${currentSessionId.slice(0, 8)}` : "";

  // Cost & turns
  $("#status-cost").textContent = cost > 0 ? `$${cost.toFixed(4)}` : "";
  $("#status-turns").textContent = turns > 0 ? `${turns} turns` : "";

  // CWD
  $("#status-cwd").textContent = `CWD: ${currentCwd}`;
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return n.toString();
}

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
  loadSessionStatus(sessionId);
  disconnectWS();
  connectWS(sessionId);
  showChat();
  highlightSession(sessionId);
  loadHistory(sessionId);
  updateStatusBar();
  fetchStatus();
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
    el.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startInlineRename(el, s.session_id, s.name);
    });
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

// ─── Session rename ────────────────────────────────────────────────────

function startInlineRename(el, sessionId, currentName) {
  const nameEl = el.querySelector(".session-name");
  const input = document.createElement("input");
  input.type = "text";
  input.value = currentName;
  input.className = "inline-rename-input";
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const finish = async () => {
    const newName = input.value.trim() || currentName;
    await fetch(`/api/sessions/${sessionId}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    await loadSessions();
  };

  input.addEventListener("blur", finish);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { input.value = currentName; input.blur(); }
  });
}

function renameCurrentSession() {
  if (!currentSessionId) return;
  const el = $(`[data-id="${currentSessionId}"]`);
  const nameEl = el?.querySelector(".session-name");
  if (el && nameEl) startInlineRename(el, currentSessionId, nameEl.textContent);
}

// ─── CWD dialog ────────────────────────────────────────────────────────

function showCwdDialog() {
  $("#cwd-dialog").classList.remove("hidden");
  const input = $("#cwd-input");
  input.value = currentCwd;
  input.focus();
  input.select();
}

function hideCwdDialog() { $("#cwd-dialog").classList.add("hidden"); }

async function confirmCwd() {
  const newCwd = $("#cwd-input").value.trim();
  if (!newCwd) return;
  currentCwd = newCwd;
  try {
    await fetch("/api/config/cwd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: newCwd }),
    });
  } catch (e) {}
  updateStatusBar();
  hideCwdDialog();
}

// ─── WebSocket ─────────────────────────────────────────────────────────

function connectWS(sessionId) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws/${sessionId}`);
  ws.onmessage = (e) => handleWSMessage(JSON.parse(e.data));
  ws.onclose = () => { if (isStreaming) finishStreaming(); };
  ws.onerror = (e) => console.error("WebSocket error", e);
}

function disconnectWS() {
  if (ws) { ws.close(); ws = null; }
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
    case "usage":
      statusData.input_tokens = msg.input_tokens || 0;
      statusData.output_tokens = msg.output_tokens || 0;
      persistSessionStatus();
      updateStatusBar();
      break;
    case "system":
      handleSystemMessage(msg);
      break;
    case "session_ready":
      if (msg.session_id && msg.session_id !== currentSessionId) {
        currentSessionId = msg.session_id;
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
    const d = msg.data || {};
    if (d.session_id && !currentSessionId) currentSessionId = d.session_id;
    if (d.model) statusData.model = d.model;
    if (d.cwd) currentCwd = d.cwd;
    if (d.permission_mode) statusData.permission_mode = d.permission_mode;
    if (d.claude_code_version) statusData.claude_code_version = d.claude_code_version;
    if (d.mcp_servers) statusData.mcp_servers = d.mcp_servers;
    if (d.tools) statusData.tools = d.tools;

    // Populate slash commands from SDK — complete replacement
    if (d.slash_commands && d.slash_commands.length > 0) {
      SLASH_COMMANDS = d.slash_commands.map(name => {
        const meta = SLASH_COMMAND_META[name] || { desc: name, icon: "⚡" };
        return { name, desc: meta.desc, icon: meta.icon };
      });
      console.log("[init] Loaded", SLASH_COMMANDS.length, "slash commands from SDK");
    }

    updateStatusBar();
  }
}

// ─── Streaming control ────────────────────────────────────────────────

function startStreaming() {
  isStreaming = true;
  $("#btn-send").disabled = true;
  $("#loading-indicator").classList.remove("hidden");
}

function stopStreaming() {
  if (!isStreaming) return;
  if (currentSessionId) {
    fetch(`/api/sessions/${currentSessionId}/interrupt`, { method: "POST" }).catch(() => {});
  }
  finishStreaming();
}

function finishStreaming() {
  isStreaming = false;
  $("#btn-send").disabled = false;
  $("#loading-indicator").classList.add("hidden");
  toolBlocks = {};
  resetCurrent();
}

// ─── Rendering ─────────────────────────────────────────────────────────

function ensureAssistantMessage() {
  if (currentAssistantEl) return;
  startStreaming();

  currentAssistantEl = document.createElement("div");
  currentAssistantEl.className = "message assistant";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.style.display = "none";
  currentAssistantEl.appendChild(bubble);
  $("#messages").appendChild(currentAssistantEl);
}

function getBubble() {
  ensureAssistantMessage();
  return currentAssistantEl.querySelector(".message-bubble");
}

function ensureBubble() {
  const bubble = getBubble();
  bubble.style.display = "";
  if (!currentTextEl) {
    currentTextEl = document.createElement("div");
    currentTextEl.className = "message-text";
    bubble.appendChild(currentTextEl);
  }
  return bubble;
}

function appendText(text) {
  if (!text) return;
  ensureBubble();
  if (!currentTextEl._raw) currentTextEl._raw = "";
  currentTextEl._raw += text;
  currentTextEl.innerHTML = marked.parse(currentTextEl._raw);
}

function appendThinking(text) {
  if (!text || !text.trim()) return;
  ensureAssistantMessage();
  const bubble = currentAssistantEl.querySelector(".message-bubble");
  let thinkEl = currentAssistantEl.querySelector(".thinking-block");
  if (!thinkEl) {
    thinkEl = document.createElement("details");
    thinkEl.className = "thinking-block";
    thinkEl.open = true;
    thinkEl.innerHTML = '<summary>Thinking...</summary><div class="thinking-content"></div>';
    currentAssistantEl.insertBefore(thinkEl, bubble);
  }
  thinkEl.querySelector(".thinking-content").textContent += text;
}

function startToolBlock(toolId, name, input) {
  if (toolBlocks[toolId]) {
    if (input) {
      const detail = toolBlocks[toolId].block.querySelector(".tool-call-detail pre");
      if (detail && !detail.textContent.trim()) {
        detail.textContent = JSON.stringify(input, null, 2);
      }
    }
    return;
  }

  const bubble = getBubble();
  const el = createToolCallEl(name, input);
  el.dataset.toolId = toolId;
  bubble.appendChild(el);
  toolBlocks[toolId] = { block: el };
  bubble.style.display = "";
}

function finishToolBlock(toolUseId, content, isError) {
  const tb = toolBlocks[toolUseId];
  if (!tb) return;

  const displayContent = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  if (!displayContent) return;

  const details = document.createElement("details");
  details.className = "tool-call-result-wrapper" + (isError ? " error" : "");
  const summary = document.createElement("summary");
  summary.textContent = isError ? "Error (click to expand)" : "Result (click to expand)";
  details.appendChild(summary);

  const resultEl = document.createElement("div");
  resultEl.className = "tool-call-result";
  const truncated = displayContent.length > 2000 ? displayContent.slice(0, 2000) + "\n..." : displayContent;
  resultEl.textContent = truncated;
  details.appendChild(resultEl);
  tb.block.appendChild(details);
}

function finishResult(msg) {
  if (currentTextEl && currentTextEl._raw) {
    currentTextEl.innerHTML = marked.parse(currentTextEl._raw);
    currentTextEl.querySelectorAll("pre code").forEach((block) => {
      hljs.highlightElement(block);
    });
    addCopyButtons(currentAssistantEl);
  }

  // Clean up empty bubbles
  if (currentAssistantEl) {
    const bubble = currentAssistantEl.querySelector(".message-bubble");
    if (bubble && bubble.style.display === "none") {
      const thinkBlock = currentAssistantEl.querySelector(".thinking-block");
      if (thinkBlock) { bubble.remove(); }
      else { currentAssistantEl.remove(); }
    } else if (bubble && !bubble.textContent.trim() && !bubble.querySelector(".tool-call")) {
      bubble.style.display = "none";
    }

    // Add result footer
    if (msg.cost !== undefined) {
      const b = currentAssistantEl.querySelector(".message-bubble");
      if (b && b.style.display !== "none") {
        const footer = document.createElement("div");
        footer.className = "result-footer";
        const parts = [];
        if (msg.turns) parts.push(`${msg.turns} turns`);
        if (msg.cost) parts.push(`$${msg.cost.toFixed(4)}`);
        if (msg.subtype) parts.push(msg.subtype);
        footer.textContent = parts.join(" · ");
        b.appendChild(footer);
      }
    }
  }

  // Update status
  if (msg.cost) statusData.cost = msg.cost;
  if (msg.turns) statusData.turns = msg.turns;
  persistSessionStatus();
  updateStatusBar();

  finishStreaming();
  scrollToBottom();
}

function appendError(message) {
  const el = document.createElement("div");
  el.className = "message assistant";
  el.innerHTML = `<div class="message-bubble error-bubble">Error: ${escapeHtml(message)}</div>`;
  $("#messages").appendChild(el);
  finishStreaming();
}

function resetCurrent() {
  currentAssistantEl = null;
  currentTextEl = null;
}

function scrollToBottom() {
  const container = $("#messages");
  container.scrollTop = container.scrollHeight;
}

// ─── Code block copy buttons ───────────────────────────────────────────

function addCopyButtons(container) {
  container.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".copy-btn")) return;
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.textContent = "Copy";
    btn.onclick = () => {
      const code = pre.querySelector("code");
      navigator.clipboard.writeText(code ? code.textContent : pre.textContent);
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy"; }, 2000);
    };
    pre.style.position = "relative";
    pre.appendChild(btn);
  });
}

// ─── Tool call display ────────────────────────────────────────────────

const TOOL_DESCRIPTIONS = {
  Read: (input) => `Reading ${input.file_path || "file"}`,
  Write: (input) => `Writing ${input.file_path || "file"}`,
  Edit: (input) => `Editing ${input.file_path || "file"}`,
  Bash: (input) => `Running: ${input.command || ""}`,
  Glob: (input) => `Searching files: ${input.pattern || ""}`,
  Grep: (input) => `Searching content: ${input.query || input.pattern || ""}`,
  Agent: (input) => `Sub-agent: ${(input.prompt || "").slice(0, 80)}`,
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

  const icon = document.createElement("span");
  icon.className = "tool-call-icon";
  icon.textContent = getToolIcon(name);

  const text = document.createElement("span");
  text.className = "tool-call-text";
  text.textContent = summary;

  header.appendChild(icon);
  header.appendChild(text);

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

function getToolIcon(name) {
  const icons = {
    Read: "\u{1F4C4}", Write: "\u{270F}\u{FE0F}", Edit: "\u{1F4DD}",
    Bash: "\u{1F4BB}", Glob: "\u{1F50D}", Grep: "\u{1F50E}",
    Agent: "\u{1F916}", WebFetch: "\u{1F310}", WebSearch: "\u{1F52E}",
    TodoRead: "\u{1F4CB}", TodoWrite: "\u{2705}", NotebookEdit: "\u{1F4D3}",
  };
  return icons[name] || "⚙️";
}

// ─── Send ──────────────────────────────────────────────────────────────

function createUserBubble(text) {
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  const isTerminalOutput = text.includes("\n") && text.length > 150;

  if (isTerminalOutput) {
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

  // Handle slash commands locally
  if (text.startsWith("/")) {
    handleSlashCommand(text);
    input.value = "";
    input.style.height = "auto";
    historyIndex = -1;
    return;
  }

  // Save to history
  saveToHistory(text);
  historyIndex = -1;

  // Render user message
  const el = document.createElement("div");
  el.className = "message user";
  el.appendChild(createUserBubble(text));
  $("#messages").appendChild(el);
  scrollToBottom();

  // Send via WebSocket
  ws.send(JSON.stringify({ type: "message", content: text }));

  input.value = "";
  input.style.height = "auto";
  input.focus();
}

// ─── Slash commands ────────────────────────────────────────────────────

// Commands that work via CLI (claude -p)
const CLI_COMMANDS = new Set([
  "cost", "usage", "compact", "init", "review", "debug", "verify",
  "code-review", "security-review", "batch", "loop", "run", "claude-api",
  "insights", "goal", "update-config", "heapdump", "fewer-permission-prompts",
  "run-skill-generator", "team-onboarding", "context",
]);

// Commands handled locally (CLI doesn't support them)
const LOCAL_COMMANDS = new Set(["clear", "help", "status", "model", "config", "permissions"]);

async function handleSlashCommand(text) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].slice(1).toLowerCase();

  // Show user message in chat
  const el = document.createElement("div");
  el.className = "message user";
  el.appendChild(createUserBubble(text));
  $("#messages").appendChild(el);
  scrollToBottom();

  // Local commands
  if (cmd === "clear") {
    $("#messages").innerHTML = "";
    return;
  }

  if (cmd === "help") {
    showHelp();
    return;
  }

  if (cmd === "status") {
    showLocalStatus();
    return;
  }

  if (cmd === "model") {
    const model = statusData.model || (await fetchServerModel());
    appendAssistantText(`Current model: **${model || "unknown"}**`);
    return;
  }

  if (cmd === "config") {
    const mcpList = (statusData.mcp_servers || []).map(s => `- ${s.name}: ${s.status}`).join("\n");
    appendAssistantText(`**Configuration**
- Model: ${statusData.model || "unknown"}
- CWD: ${currentCwd}
- Permission mode: ${statusData.permission_mode || "unknown"}
- Claude Code version: ${statusData.claude_code_version || "unknown"}
- Tools: ${(statusData.tools || []).length} available
- MCP servers:\n${mcpList || "- none"}`);
    return;
  }

  if (cmd === "permissions") {
    appendAssistantText(`Permission mode: **${statusData.permission_mode || "unknown"}**`);
    return;
  }

  // CLI commands — call backend /api/cli-command
  if (CLI_COMMANDS.has(cmd)) {
    try {
      startStreaming();
      const res = await fetch("/api/cli-command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: text }),
      });
      const data = await res.json();
      if (data.ok) {
        appendCliResult(cmd, data.result || "(no output)");
      } else {
        appendAssistantText(`Error: ${data.error}`);
      }
    } catch (e) {
      appendAssistantText(`Error: ${e.message}`);
    } finally {
      finishStreaming();
    }
    return;
  }

  // Fallback: send to SDK as regular message
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "message", content: text }));
  }
}

function showHelp() {
  const cmds = SLASH_COMMANDS.map(c => `/${c.name} — ${c.desc}`).join("\n");
  appendAssistantText(`**Available commands:**
${cmds}

**Keyboard shortcuts:**
- \`Enter\` — Send message
- \`Shift+Enter\` — New line
- \`Escape\` — Stop / close autocomplete
- \`/\` — Open command menu
- \`@file\` — Mention a file
- \`↑/↓\` — Browse input history
- \`Ctrl+N\` — New session
- \`Ctrl+L\` — Clear messages`);
}

async function showLocalStatus() {
  const model = statusData.model || (await fetchServerModel());
  appendAssistantText(`**Status**
- Model: **${model || "unknown"}**
- Session: \`${currentSessionId || "none"}\`
- CWD: \`${currentCwd}\`
- Permission mode: ${statusData.permission_mode || "unknown"}
- Claude Code version: ${statusData.claude_code_version || "unknown"}
- Tokens: ${formatTokens(statusData.input_tokens)} in / ${formatTokens(statusData.output_tokens)} out
- Cost: $${statusData.cost.toFixed(6)}
- Turns: ${statusData.turns}`);
}

async function fetchServerModel() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    if (data.model) {
      statusData.model = data.model;
      statusData.claude_code_version = data.claude_code_version || statusData.claude_code_version;
      statusData.permission_mode = data.permission_mode || statusData.permission_mode;
      statusData.tools = data.tools || statusData.tools;
      statusData.mcp_servers = data.mcp_servers || statusData.mcp_servers;
      updateStatusBar();
      return data.model;
    }
  } catch (e) {}
  return statusData.model;
}

function appendAssistantText(markdown) {
  const el = document.createElement("div");
  el.className = "message assistant";
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  const div = document.createElement("div");
  div.className = "message-text";
  div.innerHTML = marked.parse(markdown);
  bubble.appendChild(div);
  bubble.querySelectorAll("pre code").forEach(b => hljs.highlightElement(b));
  addCopyButtons(bubble);
  el.appendChild(bubble);
  $("#messages").appendChild(el);
  scrollToBottom();
}

// ─── ANSI to HTML converter ─────────────────────────────────────────

function ansiToHtml(text) {
  if (!text) return "";
  // Remove OSC sequences (title, links, etc.)
  text = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

  const ANSI_COLORS = {
    30: "#808080", 31: "#ff6b6b", 32: "#51cf66", 33: "#ffd43b",
    34: "#4dabf7", 35: "#cc5de8", 36: "#22b8cf", 37: "#e0e0e0",
    90: "#6c6c80", 91: "#ff8787", 92: "#69db7c", 93: "#ffe066",
    94: "#74c0fc", 95: "#da77f2", 96: "#3bc9db", 97: "#f8f9fa",
  };
  const BG_COLORS = {
    40: "#2a2a4a", 41: "#ff6b6b", 42: "#51cf66", 43: "#ffd43b",
    44: "#4dabf7", 45: "#cc5de8", 46: "#22b8cf", 47: "#e0e0e0",
    100: "#6c6c80", 101: "#ff8787", 102: "#69db7c", 103: "#ffe066",
    104: "#74c0fc", 105: "#da77f2", 106: "#3bc9db", 107: "#f8f9fa",
  };

  let result = "";
  let spanOpen = false;
  let currentStyle = {};
  let styleChanged = false;

  function buildStyle() {
    const parts = [];
    if (currentStyle.bold) parts.push("font-weight:bold");
    if (currentStyle.dim) parts.push("opacity:0.7");
    if (currentStyle.italic) parts.push("font-style:italic");
    if (currentStyle.underline) parts.push("text-decoration:underline");
    if (currentStyle.fg) parts.push(`color:${currentStyle.fg}`);
    if (currentStyle.bg) parts.push(`background-color:${currentStyle.bg}`);
    return parts.join(";");
  }

  function ensureSpan() {
    if (styleChanged) {
      // Close old span if open, open new one with current style
      if (spanOpen) { result += "</span>"; spanOpen = false; }
      const style = buildStyle();
      if (style) {
        result += `<span style="${style}">`;
        spanOpen = true;
      }
      styleChanged = false;
    }
  }

  function closeSpan() {
    if (spanOpen) { result += "</span>"; spanOpen = false; }
    styleChanged = false;
  }

  // Split by ANSI escape sequences
  const parts = text.split(/\x1b\[/);
  result += escapeHtml(parts[0]);

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const mEnd = part.indexOf("m");
    if (mEnd === -1) { result += escapeHtml(part); continue; }

    const params = part.slice(0, mEnd).split(";").map(Number);
    const rest = part.slice(mEnd + 1);

    // Process SGR parameters
    let j = 0;
    while (j < params.length) {
      const p = params[j];
      if (p === 0) {
        closeSpan();
        currentStyle = {};
        styleChanged = true;
      } else if (p === 1) {
        currentStyle.bold = true; styleChanged = true;
      } else if (p === 2) {
        currentStyle.dim = true; styleChanged = true;
      } else if (p === 3) {
        currentStyle.italic = true; styleChanged = true;
      } else if (p === 4) {
        currentStyle.underline = true; styleChanged = true;
      } else if (p === 7) {
        const tmp = currentStyle.fg;
        currentStyle.fg = currentStyle.bg || "#1a1a2e";
        currentStyle.bg = tmp || "#e0e0e0";
        styleChanged = true;
      } else if (p === 22) {
        currentStyle.bold = false; currentStyle.dim = false; styleChanged = true;
      } else if (p === 23) {
        currentStyle.italic = false; styleChanged = true;
      } else if (p === 24) {
        currentStyle.underline = false; styleChanged = true;
      } else if (p === 27) {
        const tmp2 = currentStyle.fg;
        currentStyle.fg = currentStyle.bg;
        currentStyle.bg = tmp2;
        styleChanged = true;
      } else if (p >= 30 && p <= 37) {
        currentStyle.fg = ANSI_COLORS[p]; styleChanged = true;
      } else if (p === 38) {
        // Extended foreground: 38;5;n or 38;2;r;g;b
        if (params[j + 1] === 5 && params[j + 2] !== undefined) {
          currentStyle.fg = ansi256ToRgb(params[j + 2]); j += 2; styleChanged = true;
        } else if (params[j + 1] === 2 && params[j + 4] !== undefined) {
          currentStyle.fg = `rgb(${params[j + 2]},${params[j + 3]},${params[j + 4]})`; j += 4; styleChanged = true;
        }
      } else if (p === 39) {
        delete currentStyle.fg; styleChanged = true;
      } else if (p >= 40 && p <= 47) {
        currentStyle.bg = BG_COLORS[p]; styleChanged = true;
      } else if (p === 48) {
        if (params[j + 1] === 5 && params[j + 2] !== undefined) {
          currentStyle.bg = ansi256ToRgb(params[j + 2]); j += 2; styleChanged = true;
        } else if (params[j + 1] === 2 && params[j + 4] !== undefined) {
          currentStyle.bg = `rgb(${params[j + 2]},${params[j + 3]},${params[j + 4]})`; j += 4; styleChanged = true;
        }
      } else if (p === 49) {
        delete currentStyle.bg; styleChanged = true;
      } else if (p >= 90 && p <= 97) {
        currentStyle.fg = ANSI_COLORS[p]; styleChanged = true;
      } else if (p >= 100 && p <= 107) {
        currentStyle.bg = BG_COLORS[p]; styleChanged = true;
      }
      j++;
    }

    if (rest) { ensureSpan(); result += escapeHtml(rest); }
  }

  closeSpan();
  return result;
}

function ansi256ToRgb(n) {
  if (n < 16) {
    const basic = [
      "#000000","#aa0000","#00aa00","#aa5500","#0000aa","#aa00aa","#00aaaa","#aaaaaa",
      "#555555","#ff5555","#55ff55","#ffff55","#5555ff","#ff55ff","#55ffff","#ffffff",
    ];
    return basic[n] || "#ffffff";
  }
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  n -= 16;
  const r = Math.floor(n / 36) * 51;
  const g = Math.floor((n % 36) / 6) * 51;
  const b = (n % 6) * 51;
  return `rgb(${r},${g},${b})`;
}

function appendCliResult(cmd, text) {
  const el = document.createElement("div");
  el.className = "message assistant";
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  // Header
  const header = document.createElement("div");
  header.style.cssText = "font-size:12px;color:var(--accent);font-weight:600;margin-bottom:8px;font-family:var(--font);";
  header.textContent = `> /${cmd}`;
  bubble.appendChild(header);
  // Content — detect ANSI vs markdown
  if (text.includes("\x1b[")) {
    const pre = document.createElement("pre");
    pre.style.cssText = "margin:0;white-space:pre-wrap;font-size:13px;line-height:1.6;";
    pre.innerHTML = ansiToHtml(text);
    bubble.appendChild(pre);
  } else {
    const div = document.createElement("div");
    div.className = "message-text";
    div.innerHTML = marked.parse(text);
    bubble.appendChild(div);
  }
  addCopyButtons(bubble);
  el.appendChild(bubble);
  $("#messages").appendChild(el);
  scrollToBottom();
}

// ─── Load history ──────────────────────────────────────────────────────

async function loadHistory(sessionId) {
  try {
    const url = `/api/sessions/${sessionId}/messages`;
    const res = await fetch(url);
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
      } else if (msg.role === "assistant") {
        const el = document.createElement("div");
        el.className = "message assistant";
        const bubble = document.createElement("div");
        bubble.className = "message-bubble";

        let hasVisibleContent = false;
        if (msg.blocks) {
          msg.blocks.forEach((block) => {
            if (block.type === "thinking") {
              const thinkEl = document.createElement("details");
              thinkEl.className = "thinking-block";
              thinkEl.open = true;
              thinkEl.innerHTML = `<summary>Thinking...</summary><div class="thinking-content">${escapeHtml(block.text || "")}</div>`;
              el.appendChild(thinkEl);
            } else if (block.type === "text") {
              const div = document.createElement("div");
              div.className = "message-text";
              div.innerHTML = marked.parse(block.text || "");
              bubble.appendChild(div);
              hasVisibleContent = true;
            } else if (block.type === "tool_use") {
              bubble.appendChild(createToolCallEl(block.name, block.input));
              hasVisibleContent = true;
            }
          });
        } else if (msg.content) {
          const div = document.createElement("div");
          div.className = "message-text";
          div.innerHTML = marked.parse(msg.content);
          bubble.appendChild(div);
          hasVisibleContent = true;
        }

        bubble.querySelectorAll("pre code").forEach((block) => {
          hljs.highlightElement(block);
        });
        addCopyButtons(bubble);

        if (!hasVisibleContent && !bubble.textContent.trim()) {
          bubble.style.display = "none";
        }

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
