// Turns the raw SDK event stream into a human-readable "what is Claude doing right now"
// status plus a step log for the current turn. This is the single source of truth for
// progress: the app's activity bar and the Android notification both render it.
//
// Snapshot shape (sent to clients as { t: "activity", sessionId, activity }):
//   phase      sending | starting | waiting | thinking | writing | tool | approval | subagent
//              | retrying | compacting | idle | error
//   label      short text, e.g. "Running Bash"
//   detail     one line of context, e.g. the command or the latest thinking sentence
//   turnStart  ms timestamp when the turn began (null when idle before any turn)
//   since      ms timestamp when the current phase began
//   tokens     { thinking, output } estimates for this turn
//   steps      [{ id, at, end, kind: tool|subagent|note, title, detail, status: run|ok|err }]

const MAX_STEPS = 300;
const THROTTLE_MS = 250;

const TOOL_VERBS = {
  Bash: "Running a command", Read: "Reading a file", Write: "Writing a file", Edit: "Editing a file", MultiEdit: "Editing a file",
  NotebookEdit: "Editing a notebook", Glob: "Finding files", Grep: "Searching code", WebFetch: "Fetching a web page",
  WebSearch: "Searching the web", TodoWrite: "Updating the task list", Task: "Starting a subagent", Agent: "Starting a subagent",
  Skill: "Using a skill", AskUserQuestion: "Asking you a question", ExitPlanMode: "Presenting a plan",
};
export const toolVerb = name => TOOL_VERBS[name] || (name.startsWith("mcp__") ? `Using ${name.split("__")[1]}` : `Using ${name}`);

/** One line describing a tool call, e.g. the command or the file path. */
export function toolDetail(name, input) {
  if (!input || typeof input !== "object") return "";
  const short = p => String(p || "").replace(/^\/data\/data\/com\.termux\/files\/home/, "~");
  switch (name) {
    case "Bash": return input.description ? `${input.description}: ${input.command || ""}` : input.command || "";
    case "Read": case "Write": case "Edit": case "MultiEdit": return short(input.file_path);
    case "NotebookEdit": return short(input.notebook_path);
    case "Glob": case "Grep": return input.pattern || "";
    case "WebFetch": return input.url || "";
    case "WebSearch": return input.query || "";
    case "Task": case "Agent": return input.description || "";
    case "TodoWrite": { const t = (input.todos || []).find(x => x.status === "in_progress"); return t ? t.activeForm || t.content : ""; }
    case "Skill": return input.skill || "";
    default: { const v = Object.values(input).find(x => typeof x === "string"); return v ? v.slice(0, 160) : ""; }
  }
}

/** Best-effort extraction of a string field from partially streamed tool-input JSON. */
function partialField(json, field) {
  const m = json.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
  if (!m) return "";
  try { return JSON.parse(`"${m[1].replace(/\\$/, "")}"`); } catch { return m[1]; }
}

function lastSentence(text) {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return "";
  const parts = t.split(/(?<=[.!?])\s+/);
  let s = parts[parts.length - 1];
  if (s.length < 25 && parts.length > 1) s = parts[parts.length - 2] + " " + s;
  return s.length > 180 ? "…" + s.slice(-180) : s;
}

export class Activity {
  constructor(onChange) {
    this.onChange = onChange;
    this.timer = null;
    this.blocks = new Map();   // stream block index -> { kind, text, toolId, name, json }
    this.toolSteps = new Map(); // tool_use_id -> step
    this.taskSteps = new Map(); // task_id -> step
    this.nextId = 1;
    this.s = { phase: "starting", label: "Starting Claude Code", detail: "", turnStart: null, since: Date.now(), tokens: { thinking: 0, output: 0 }, steps: [] };
  }

  snapshot() { return { ...this.s, tokens: { ...this.s.tokens }, steps: this.s.steps.slice() }; }

  set(phase, label, detail = "") {
    const s = this.s;
    if (s.phase !== phase) s.since = Date.now();
    s.phase = phase; s.label = label; s.detail = detail || "";
    this.changed();
  }
  changed(now) {
    if (now) { clearTimeout(this.timer); this.timer = null; this.onChange(this.snapshot()); return; }
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.onChange(this.snapshot()); }, THROTTLE_MS);
  }
  step(kind, title, detail = "", status = "run") {
    const st = { id: this.nextId++, at: Date.now(), end: null, kind, title, detail, status };
    this.s.steps.push(st);
    if (this.s.steps.length > MAX_STEPS) this.s.steps.splice(0, this.s.steps.length - MAX_STEPS);
    return st;
  }
  finish(st, status) { if (st && st.status === "run") { st.status = status; st.end = Date.now(); } }

  /** A new user message was sent: start a new turn. */
  turn() {
    this.blocks.clear(); this.toolSteps.clear(); this.taskSteps.clear();
    Object.assign(this.s, { turnStart: Date.now(), tokens: { thinking: 0, output: 0 }, steps: [] });
    this.set("sending", "Sending your message");
    this.changed(true);
  }

  approval(toolName, input) { this.set("approval", "Waiting for your approval", `${toolVerb(toolName)}: ${toolDetail(toolName, input)}`); this.changed(true); }
  approvalDone(allowed) { if (this.s.phase === "approval") this.set("waiting", allowed ? "Approved, continuing" : "Denied, telling Claude"); }

  /** Feed every SDK message through here. */
  feed(m) {
    switch (m.type) {
      case "system": return this.system(m);
      case "stream_event": return this.stream(m);
      case "assistant": return this.assistant(m);
      case "user": return this.user(m);
      case "tool_progress": {
        const st = this.toolSteps.get(m.tool_use_id);
        if (st && this.s.phase === "tool") { this.s.detail = st.detail; this.changed(); }
        return;
      }
      case "tool_use_summary": if (m.summary) { this.step("note", m.summary, "", "ok"); this.changed(); } return;
      case "result": {
        for (const st of this.s.steps) this.finish(st, m.is_error ? "err" : "ok");
        const secs = this.s.turnStart ? Math.round((Date.now() - this.s.turnStart) / 1000) : 0;
        if (m.usage?.output_tokens) this.s.tokens.output = m.usage.output_tokens;
        if (m.subtype === "success" && !m.is_error) this.set("idle", `Done in ${secs < 60 ? secs + "s" : Math.floor(secs / 60) + "m " + (secs % 60) + "s"}`);
        else this.set("error", "Stopped", m.subtype === "error_max_turns" ? "Reached the turn limit" : m.result || m.subtype || "");
        this.changed(true);
        return;
      }
    }
  }

  system(m) {
    switch (m.subtype) {
      case "init": if (this.s.phase === "starting" || this.s.phase === "sending") this.set("waiting", "Waiting for Claude"); break;
      case "status":
        if (m.status === "compacting") this.set("compacting", "Compacting the conversation", "Summarizing older messages to free up context");
        else if (m.status === "requesting" && !["thinking", "writing", "tool"].includes(this.s.phase)) this.set("waiting", "Waiting for Claude");
        break;
      case "api_retry": this.set("retrying", "Claude is busy, retrying", `Attempt ${m.attempt} of ${m.max_retries}${m.error_status ? ` (HTTP ${m.error_status})` : ""}, next try in ${Math.round((m.retry_delay_ms || 0) / 1000)}s`); break;
      case "thinking_tokens": this.s.tokens.thinking = m.estimated_tokens || this.s.tokens.thinking; if (this.s.phase === "thinking") this.changed(); break;
      case "task_started": {
        const st = this.step("subagent", m.description || "Subagent", m.subagent_type || "");
        this.taskSteps.set(m.task_id, st);
        this.set("subagent", "Subagent working", m.description || "");
        break;
      }
      case "task_progress": {
        const st = this.taskSteps.get(m.task_id);
        const u = m.usage || {};
        const d = `${m.description || st?.title || ""}${u.tool_uses ? ` · ${u.tool_uses} tool calls` : ""}${u.total_tokens ? ` · ${Math.round(u.total_tokens / 100) / 10}k tokens` : ""}`;
        if (st) st.detail = d;
        this.set("subagent", "Subagent working", d);
        break;
      }
      case "task_notification": {
        const st = this.taskSteps.get(m.task_id);
        this.finish(st, m.status === "completed" ? "ok" : "err");
        if (st && m.summary) st.detail = m.summary;
        this.changed();
        break;
      }
      case "compact_boundary": this.step("note", "Conversation compacted", "", "ok"); this.changed(); break;
    }
  }

  stream(m) {
    const e = m.event; if (!e) return;
    const sub = !!m.parent_tool_use_id;
    if (e.type === "message_start") { this.blocks.clear(); if (!sub && this.s.phase !== "approval") this.set("waiting", "Waiting for Claude"); return; }
    if (e.type === "content_block_start") {
      const b = e.content_block || {};
      const blk = { kind: b.type, text: "", toolId: b.id, name: b.name, json: "" };
      this.blocks.set(e.index, blk);
      if (sub) return;
      if (b.type === "thinking" || b.type === "redacted_thinking") this.set("thinking", "Thinking");
      else if (b.type === "text") this.set("writing", "Writing the reply");
      else if (b.type === "tool_use" || b.type === "server_tool_use") this.set("tool", toolVerb(b.name), "preparing…");
      return;
    }
    if (e.type === "content_block_delta") {
      const blk = this.blocks.get(e.index); if (!blk || sub) return;
      const d = e.delta || {};
      if (d.type === "thinking_delta") { blk.text += d.thinking; this.s.detail = lastSentence(blk.text); this.changed(); }
      else if (d.type === "text_delta") { blk.text += d.text; this.s.tokens.output += Math.ceil(d.text.length / 4); this.s.detail = lastSentence(blk.text); this.changed(); }
      else if (d.type === "input_json_delta") {
        blk.json += d.partial_json || "";
        const n = blk.name;
        const hint = n === "Bash" ? partialField(blk.json, "command") : n === "Write" ? `${partialField(blk.json, "file_path")} · ${(blk.json.match(/\\n/g) || []).length + 1} lines`
          : partialField(blk.json, "file_path") || partialField(blk.json, "pattern") || partialField(blk.json, "description") || partialField(blk.json, "url") || partialField(blk.json, "query");
        if (hint) { this.s.detail = hint; this.changed(); }
      }
    }
  }

  assistant(m) {
    for (const b of m.message?.content || []) {
      if (b.type !== "tool_use" && b.type !== "server_tool_use") continue;
      if (this.toolSteps.has(b.id)) continue;
      const parent = m.parent_tool_use_id ? this.taskStepForTool(m.parent_tool_use_id) : null;
      const st = this.step("tool", toolVerb(b.name), toolDetail(b.name, b.input));
      st.tool = b.name; if (parent) st.parent = parent.id;
      this.toolSteps.set(b.id, st);
      if (!m.parent_tool_use_id) this.set("tool", toolVerb(b.name), st.detail);
      else this.changed();
    }
  }
  taskStepForTool(toolUseId) { return this.toolSteps.get(toolUseId) || null; }

  user(m) {
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    let any = false;
    for (const b of content) {
      if (b.type !== "tool_result") continue;
      this.finish(this.toolSteps.get(b.tool_use_id), b.is_error ? "err" : "ok");
      any = true;
    }
    if (any && !m.parent_tool_use_id && this.s.phase !== "approval") this.set("waiting", "Waiting for Claude", "Reading the results");
    else if (any) this.changed();
  }
}
