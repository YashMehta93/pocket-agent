// A LiveSession is one running Claude Code process (via the Agent SDK) for one chat.
// It relays SDK events to the app, routes tool-permission prompts to the user,
// and tracks a human-readable activity status (see activity.js).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { query, getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE, CLAUDE_DIR, HOME, DATA, BUFFER_MAX, IDLE_CLOSE_MS, prefs, savePrefs, cache, saveCache, log } from "./config.js";

// Each chat's own model, effort and permission mode, kept in prefs so a chat reopened after an idle close or
// a server restart keeps them (before, it fell back to the defaults: Default model, Ask).
const KEEP_SETTINGS = 400;   // most recently changed chats
export const chatSettings = id => prefs.sessionSettings?.[id] || null;
export function rememberChatSettings(id, { model, effort, permissionMode }) {
  if (!id) return;
  const patch = {};
  if (model !== undefined) patch.model = model || null;
  if (effort !== undefined) patch.effort = effort || null;
  if (permissionMode) patch.permissionMode = permissionMode;
  if (!Object.keys(patch).length) return;
  const all = prefs.sessionSettings ||= {};
  all[id] = { ...all[id], ...patch, at: Date.now() };
  const ids = Object.keys(all);
  if (ids.length > KEEP_SETTINGS) ids.sort((a, b) => all[a].at - all[b].at).slice(0, ids.length - KEEP_SETTINGS).forEach(k => delete all[k]);
  savePrefs();
}
import { broadcast, broadcastAll, notifyNative, clients } from "./hub.js";
import { Inbox } from "./inbox.js";
import { Activity, toolDetail } from "./activity.js";
import { noteRateLimit, refreshUsage } from "./usage.js";
import { phoneContext } from "./devtools.js";

/** sessionId -> LiveSession */
export const live = new Map();

export class LiveSession {
  constructor({ sessionId, cwd, resume, model, effort, permissionMode, title }) {
    Object.assign(this, { sessionId, cwd, title: title || null, model: model || null, effort: effort || null,
      permissionMode: permissionMode || "default", state: "starting", seq: 0, buffer: [], lastText: "", lastActive: Date.now() });
    this.pending = new Map();   // requestId -> { resolve, info }
    this.tasks = new Map();     // task_id -> background agent or command (noteTask)
    this.inbox = new Inbox();
    this.activity = new Activity(snap => this.publishActivity(snap));

    const options = {
      pathToClaudeCodeExecutable: CLAUDE,
      cwd,
      includePartialMessages: true,             // token-by-token streaming
      enableFileCheckpointing: true,            // lets "edit message" undo file changes
      settingSources: ["user", "project", "local"],  // same settings, CLAUDE.md, skills as the CLI
      systemPrompt: { type: "preset", preset: "claude_code", append: phoneContext() },   // devtools.js
      thinking: { type: "adaptive", display: prefs.defaults.thinkingDisplay || "summarized" },  // readable thinking instead of empty blocks
      agentProgressSummaries: true,             // periodic progress summaries from subagents
      forwardSubagentText: true,                // subagent text shows up nested under its card
      permissionMode: this.permissionMode,
      allowDangerouslySkipPermissions: true,    // only *permits* switching to bypass later; the mode itself stays as chosen
      canUseTool: (name, input, opts) => this.askPermission(name, input, opts),
      stderr: d => { if (/error/i.test(d)) log("[claude stderr]", sessionId.slice(0, 8), d.trim().slice(0, 300)); },
    };
    if (model) options.model = model;
    if (effort) options.effort = effort;
    if (resume) options.resume = sessionId; else { options.sessionId = sessionId; if (title) options.title = title; }
    this.q = query({ prompt: this.inbox, options });
    this.pump();
  }

  // ───── outgoing events ─────
  emit(ev) {
    const item = { seq: ++this.seq, ev };
    this.buffer.push(item);
    if (this.buffer.length > BUFFER_MAX) this.buffer.splice(0, this.buffer.length - BUFFER_MAX);
    broadcast({ t: "ev", sessionId: this.sessionId, ...item });
  }
  publishActivity(activity) {
    broadcastAll({ t: "activity", sessionId: this.sessionId, activity });
    const { phase, label, detail, turnStart } = activity;
    notifyNative({ type: "activity", sessionId: this.sessionId, title: this.title || "Claude", phase, label, detail, turnStart });
  }
  setState(state) {
    if (state === this.state) return;
    const prev = this.state;
    this.state = state;
    this.lastActive = Date.now();
    broadcastAll({ t: "state", sessionId: this.sessionId, state, info: this.info() });
    saveWorking();
    if (prev === "running" && state === "idle") notifyNative({ type: "done", sessionId: this.sessionId, title: this.title || "Session", text: this.lastText.slice(0, 300) });
  }
  info() {
    return { sessionId: this.sessionId, cwd: this.cwd, state: this.state, seq: this.seq, model: this.model, effort: this.effort,
      permissionMode: this.permissionMode, title: this.title, pending: [...this.pending.values()].map(p => p.info),
      activity: this.activity.snapshot(), tasks: [...this.tasks.values()] };
  }

  // ───── SDK event loop ─────
  async pump() {
    try {
      for await (const m of this.q) {
        this.lastActive = Date.now();
        this.activity.feed(m);
        if (this.state === "idle" && (m.type === "stream_event" || m.type === "assistant")) this.setState("running");   // Claude is replying, whatever ended the last turn
        if (m.type === "system" && m.subtype === "init") {
          this.model = m.model || this.model;
          if (m.permissionMode && (!this.sawInit || this.permissionMode === "plan")) this.permissionMode = m.permissionMode;
          this.sawInit = true;
          if (this.state === "starting") this.setState("idle");
          this.refreshMeta();
        } else if (m.type === "system" && m.subtype === "session_state_changed") {
          this.setState(m.state === "requires_action" ? "waiting" : m.state);
        } else if (m.type === "assistant" && !m.parent_tool_use_id) {
          const t = (m.message?.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
          if (t) this.lastText = t;
        } else if (m.type === "command_lifecycle" && m.state === "started") {
          // a queued message begins its turn (e.g. after a short turn for background-task notices ended in "idle")
          if (this.state !== "waiting") this.setState("running");
        } else if (m.type === "system" && /^task_(started|progress|notification)$/.test(m.subtype || "")) {
          this.noteTask(m);
        } else if (m.type === "rate_limit_event") {
          noteRateLimit(m.rate_limit_info);
        } else if (m.type === "result") {
          if (this.state !== "waiting") this.setState("idle");
        }
        if (m.type === "system" && /^hook_/.test(m.subtype || "")) continue;
        this.emit(m);
      }
    } catch (e) {
      log("session error", this.sessionId.slice(0, 8), e?.message);
      this.emit({ type: "pa_error", message: String(e?.message || e) });
      this.activity.set("error", "Claude Code stopped", String(e?.message || e).slice(0, 200));
    }
    for (const p of this.pending.values()) p.resolve({ behavior: "deny", message: "Session closed" });
    this.pending.clear();
    live.delete(this.sessionId);
    this.setState("closed");
  }

  async refreshMeta() {
    try {
      const [commands, models] = await Promise.all([this.q.supportedCommands(), this.q.supportedModels()]);
      Object.assign(cache, { commands, models });
      try { cache.account = await this.q.accountInfo(); } catch {}
      saveCache();
      broadcastAll({ t: "meta", commands: cache.commands, models: cache.models, account: cache.account });
      refreshUsage(this.q).catch(() => {});
    } catch (e) { log("meta failed", e?.message); }
  }

  /** Background agents and commands Claude started: what each is doing, and how it ended. */
  noteTask(m) {
    const t = this.tasks.get(m.task_id) || { id: m.task_id, status: "running", startedAt: Date.now() };
    if (m.subtype === "task_started") Object.assign(t, { description: m.description, kind: m.task_type === "local_agent" || m.subagent_type ? "agent" : "command", agentType: m.subagent_type || null, background: !!m.is_backgrounded });
    else if (m.subtype === "task_progress") Object.assign(t, { activity: m.description, tokens: m.usage?.total_tokens ?? t.tokens, tools: m.usage?.tool_uses ?? t.tools, ms: m.usage?.duration_ms ?? t.ms });
    else Object.assign(t, { status: m.status || "completed", summary: m.summary || null, endedAt: Date.now(), activity: null });
    t.description ||= m.description || m.summary || "Background task";
    t.kind ||= /^a[0-9a-f]{12,}$/.test(m.task_id) ? "agent" : "command";
    this.tasks.set(m.task_id, t);
    broadcastAll({ t: "tasks", sessionId: this.sessionId, tasks: [...this.tasks.values()] });
  }

  // ───── permissions ─────
  askPermission(toolName, input, opts) {
    const requestId = crypto.randomUUID();
    const info = { requestId, sessionId: this.sessionId, toolName, input, suggestions: opts?.suggestions || [],
      decisionReason: opts?.decisionReason || null, blockedPath: opts?.blockedPath || null, title: this.title, at: Date.now() };
    return new Promise(resolve => {
      const done = r => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        broadcastAll({ t: "permission.resolved", sessionId: this.sessionId, requestId, behavior: r.behavior });
        notifyNative({ type: "permission.resolved", sessionId: this.sessionId, requestId });
        this.activity.approvalDone(r.behavior === "allow");
        if (!this.pending.size && this.state === "waiting") this.setState("running");
        resolve(r);
      };
      this.pending.set(requestId, { resolve: done, info });
      opts?.signal?.addEventListener("abort", () => done({ behavior: "deny", message: "Cancelled" }));
      this.setState("waiting");
      this.activity.approval(toolName, input);
      broadcastAll({ t: "permission.request", ...info });
      notifyNative({ type: "permission.request", ...info, input: toolDetail(toolName, input) || JSON.stringify(input).slice(0, 200) });
    });
  }
  answer({ requestId, behavior, message, always, updatedInput }) {
    const p = this.pending.get(requestId);
    if (!p) return false;
    if (behavior === "allow") {
      const r = { behavior: "allow", updatedInput: updatedInput || p.info.input };
      if (always && p.info.suggestions?.length) r.updatedPermissions = p.info.suggestions;
      p.resolve(r);
    } else {
      p.resolve({ behavior: "deny", message: message || "The user denied this action.", interrupt: !message });
    }
    return true;
  }

  // ───── input ─────
  send({ text, images = [], uuid }) {
    const content = [];
    for (const img of images) content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
    if (text) content.push({ type: "text", text });
    const msg = { type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid: uuid || crypto.randomUUID() };
    this.emit({ type: "pa_user", uuid: msg.uuid, text, images: images.map(i => ({ mediaType: i.mediaType, data: i.data })) });
    this.activity.turn();
    this.inbox.push(msg);
    this.setState("running");
    if (!this.title && text) this.title = text.slice(0, 60);
    return msg.uuid;
  }
  async set({ model, permissionMode, effort }) {
    if (model !== undefined) { await this.q.setModel(model || undefined); this.model = model || null; }
    if (permissionMode) { await this.q.setPermissionMode(permissionMode); this.permissionMode = permissionMode; }
    rememberChatSettings(this.sessionId, { model, effort, permissionMode });
    if (effort !== undefined) { await this.q.applyFlagSettings({ effortLevel: effort || null }); this.effort = effort || null; }
    broadcastAll({ t: "state", sessionId: this.sessionId, state: this.state, info: this.info() });
  }
  close() { this.inbox.end(); try { this.q.close(); } catch {} }
}

export function getLive(sessionId) {
  const s = live.get(sessionId);
  if (!s) throw new Error("Session is not running. Open it first.");
  return s;
}

/** Opens being started right now: sessionId -> Promise<LiveSession>. */
const opening = new Map();

/**
 * Opens (or returns) the live session for a chat; resumes it if it exists on disk.
 * Two requests for the same chat at once (a double tap, a send racing a reconnect) share one open:
 * otherwise both pass the "is it live?" check, and two Claude processes write to the same transcript.
 */
export function openSession(m) {
  const id = m.sessionId;
  if (id && live.has(id)) return Promise.resolve(live.get(id));
  if (id && opening.has(id)) return opening.get(id);
  const p = startSession(m);
  if (id) { opening.set(id, p); p.then(() => opening.delete(id), () => opening.delete(id)); }
  return p;
}
async function startSession({ sessionId, cwd, model, effort, permissionMode, title }) {
  let resume = false;
  if (sessionId) {
    const info = await getSessionInfo(sessionId).catch(() => undefined);
    if (info) { resume = true; cwd = cwd || info.cwd; title = title || info.customTitle || info.summary; }
    const busy = resume && busyElsewhere().get(sessionId);
    if (busy) throw busyError(sessionId, busy);
  }
  sessionId = sessionId || crypto.randomUUID();
  cwd = cwd || prefs.defaults.cwd || HOME;
  if (!fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
  const d = prefs.defaults, kept = chatSettings(sessionId) || {};
  // explicit choice (from the screen) > this chat's remembered settings > the defaults
  const s = new LiveSession({ sessionId, cwd, resume, title, model: model ?? kept.model ?? d.model, effort: effort ?? kept.effort ?? d.effort,
    permissionMode: permissionMode ?? kept.permissionMode ?? d.permissionMode });
  rememberChatSettings(sessionId, { model, effort, permissionMode });
  live.set(sessionId, s);
  log("opened", sessionId.slice(0, 8), resume ? "resume" : "new", cwd);
  return s;
}

// ───── chats open somewhere else ─────
// Claude Code refuses to resume a chat that a Termux terminal or a Claude background
// session is running, so we detect that up front (from Claude's session registry)
// and let the user choose: continue in a copy, or stop the other one.
export function busyElsewhere() {
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(path.join(CLAUDE_DIR, "sessions")).filter(f => f.endsWith(".json")); } catch {}
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, "sessions", f), "utf8"));
      if (!s.sessionId || live.has(s.sessionId) || !s.pid || !fs.existsSync(`/proc/${s.pid}`)) continue;
      if (s.entrypoint && /^sdk/.test(s.entrypoint)) continue;   // sessions run by this server
      out.set(s.sessionId, { kind: s.kind === "bg" ? "background" : "terminal", pid: s.pid, short: s.sessionId.slice(0, 8) });
    } catch {}
  }
  return out;
}
function busyError(sessionId, info) {
  const e = new Error(info.kind === "background" ? "This chat is running as a Claude background session in Termux." : "This chat is open in a Claude terminal in Termux.");
  return Object.assign(e, { code: "BUSY_ELSEWHERE", kind: info.kind, short: info.short, sessionId });
}
export function runClaude(args, timeoutMs = 30000) {
  return new Promise(resolve => execFile(CLAUDE, args, { timeout: timeoutMs }, (err, out, errOut) => resolve({ ok: !err, out: (out || "") + (errOut || "") })));
}

/** Close idle session processes nobody is watching, to save RAM. */
setInterval(() => {
  for (const s of live.values()) {
    const watched = [...clients].some(c => c.subs.has(s.sessionId));
    if (s.state === "idle" && !watched && Date.now() - s.lastActive > IDLE_CLOSE_MS) { log("idle close", s.sessionId.slice(0, 8)); s.close(); }
  }
}, 60_000).unref();

/** True while any session is mid-turn (used to delay restarts). */
export const anyBusy = () => [...live.values()].some(s => s.state === "running" || s.state === "waiting");

// ───── picking up after an unexpected stop ─────
// working.json lists the chats mid-reply. Stopping on purpose closes them first or waits until they're idle (updates),
// which empties the list, so a list found at start-up means Android (or a crash) killed the server mid-reply.
// Those chats get a message asking Claude to continue: at most once per chat an hour, and only right after the stop.
const WORKING = path.join(DATA, "working.json");
export const CONTINUE_TEXT = "[Pocket Agent] The app was closed while you were working (Android stopped it), so your last step and any background agents you started were cut off. Continue where you left off; restart background agents if they're still needed.";
function saveWorking() {
  const ids = [...live.values()].filter(s => s.state === "running" || s.state === "waiting").map(s => s.sessionId);
  try { fs.writeFileSync(WORKING, JSON.stringify({ ids, at: Date.now() })); } catch {}
}
/** A stop on purpose (Settings → Restart, SIGTERM): nothing should continue afterwards. */
export function clearWorking() { try { fs.rmSync(WORKING, { force: true }); } catch {} }
export async function continueInterrupted() {
  let w; try { w = JSON.parse(fs.readFileSync(WORKING, "utf8")); } catch { return []; }
  fs.rmSync(WORKING, { force: true });
  if (!w?.ids?.length || Date.now() - w.at > 30 * 60e3 || prefs.autoContinue === false) return [];
  const done = [];
  prefs.continued ||= {};
  for (const id of w.ids) {
    if (Date.now() - (prefs.continued[id] || 0) < 3600e3) continue;
    prefs.continued[id] = Date.now(); savePrefs();
    try { const s = await openSession({ sessionId: id }); s.send({ text: CONTINUE_TEXT }); done.push(id); log("continued", id.slice(0, 8), "after an unexpected stop"); }
    catch (e) { log("couldn't continue", id.slice(0, 8), e?.message); }
  }
  return done;
}

/** A background agent's own transcript (Claude Code keeps it next to the chat's), as session messages. */
export function taskTranscript(sessionId, taskId) {
  if (!/^[\w-]+$/.test(sessionId) || !/^[\w-]+$/.test(taskId)) throw new Error("Bad id");
  const root = path.join(CLAUDE_DIR, "projects");
  for (const dir of fs.readdirSync(root)) {
    const f = path.join(root, dir, sessionId, "subagents", `agent-${taskId}.jsonl`);
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).slice(-1500);
    const messages = [];
    for (const l of lines) { try { const j = JSON.parse(l); if ((j.type === "user" || j.type === "assistant") && j.message) messages.push({ type: j.type, uuid: j.uuid, message: j.message, parent_tool_use_id: null }); } catch {} }
    return messages;
  }
  return null;
}
