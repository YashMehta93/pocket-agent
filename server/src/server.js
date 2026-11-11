// Pocket Agent bridge server.
//
// Runs in Termux (later also on a PC) and lets the Pocket Agent app drive
// Claude Code through the Claude Agent SDK.
//
//   GET  /health                 liveness, no auth
//   WS   /ws?token=…             main app protocol (see PROTOCOL.md)
//   GET  /events?token=…         Server-Sent Events for the app's native
//                                notification service (approvals, finished turns)
//   POST /permission?token=…     answer a permission request from a notification
//
// Every endpoint except /health requires the shared token.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import {
  query, listSessions, getSessionMessages, getSessionInfo,
  renameSession, deleteSession, forkSession,
} from "@anthropic-ai/claude-agent-sdk";

const VERSION = "0.1.0";
const HOME = os.homedir();
const DATA = path.join(HOME, ".pocket-agent");
const args = parseArgs(process.argv.slice(2));
const PORT = +(args.port || process.env.PA_PORT || 8765);
const HOST = args.host || process.env.PA_HOST || "127.0.0.1";
const CLAUDE = args.claude || process.env.PA_CLAUDE || "/data/data/com.termux/files/usr/bin/claude";
const IDLE_CLOSE_MS = 20 * 60 * 1000;  // close an idle, unwatched live session after 20 min
const BUFFER_MAX = 4000;               // events kept per live session for reconnects

fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
const TOKEN = loadToken();
const prefs = loadJSON(path.join(DATA, "prefs.json"), { pinned: [], defaults: {} });
let cache = loadJSON(path.join(DATA, "cache.json"), { commands: [], models: [], account: null });

function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) o[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true;
  return o;
}
function loadJSON(f, dflt) { try { return { ...dflt, ...JSON.parse(fs.readFileSync(f, "utf8")) }; } catch { return dflt; } }
function saveJSON(f, v) { fs.writeFileSync(f, JSON.stringify(v, null, 2), { mode: 0o600 }); }
function loadToken() {
  const f = path.join(DATA, "token");
  if (typeof args.token === "string" && args.token.length >= 16) { fs.writeFileSync(f, args.token, { mode: 0o600 }); return args.token; }
  try { const t = fs.readFileSync(f, "utf8").trim(); if (t) return t; } catch {}
  const t = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}
function log(...a) { console.log(new Date().toISOString(), ...a); }
const safeEq = (a, b) => typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ───────────────────────────── async queue (streaming input) ─────────────────────────────
class Inbox {
  constructor() { this.items = []; this.waiters = []; this.done = false; }
  push(v) { const w = this.waiters.shift(); if (w) w({ value: v, done: false }); else this.items.push(v); }
  end() { this.done = true; for (const w of this.waiters.splice(0)) w({ value: undefined, done: true }); }
  [Symbol.asyncIterator]() {
    return { next: () => this.items.length ? Promise.resolve({ value: this.items.shift(), done: false })
      : this.done ? Promise.resolve({ value: undefined, done: true })
      : new Promise(r => this.waiters.push(r)) };
  }
}

// ───────────────────────────── live sessions ─────────────────────────────
const live = new Map();        // sessionId -> LiveSession
const clients = new Set();     // WebSocket clients
const sseClients = new Set();  // native notification listeners

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1 && (!msg.sessionId || c.subs.has(msg.sessionId) || msg.all)) c.send(s);
}
function broadcastAll(msg) { const s = JSON.stringify(msg); for (const c of clients) if (c.readyState === 1) c.send(s); }
function notifyNative(ev) {
  const s = `data: ${JSON.stringify(ev)}\n\n`;
  for (const r of sseClients) r.write(s);
}

class LiveSession {
  constructor({ sessionId, cwd, resume, model, effort, permissionMode, title }) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.state = "starting";
    this.seq = 0;
    this.buffer = [];
    this.pending = new Map();     // requestId -> { resolve, info }
    this.inbox = new Inbox();
    this.lastActive = Date.now();
    this.model = model || null;
    this.effort = effort || null;
    this.permissionMode = permissionMode || "default";
    this.title = title || null;
    this.lastText = "";
    const options = {
      pathToClaudeCodeExecutable: CLAUDE,
      cwd,
      includePartialMessages: true,
      enableFileCheckpointing: true,
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: this.permissionMode,
      canUseTool: (name, input, opts) => this.askPermission(name, input, opts),
      stderr: d => { if (/error/i.test(d)) log("[claude stderr]", sessionId.slice(0, 8), d.trim().slice(0, 300)); },
    };
    if (this.permissionMode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;
    if (model) options.model = model;
    if (effort) options.effort = effort;
    if (resume) options.resume = sessionId; else options.sessionId = sessionId;
    if (!resume && title) options.title = title;
    this.q = query({ prompt: this.inbox, options });
    this.pump();
  }

  emit(ev) {
    const item = { seq: ++this.seq, ev };
    this.buffer.push(item);
    if (this.buffer.length > BUFFER_MAX) this.buffer.splice(0, this.buffer.length - BUFFER_MAX);
    broadcast({ t: "ev", sessionId: this.sessionId, ...item });
  }
  setState(state) {
    if (state === this.state) return;
    const prev = this.state;
    this.state = state;
    this.lastActive = Date.now();
    const info = this.info();
    broadcastAll({ t: "state", sessionId: this.sessionId, state, info });
    if (prev === "running" && state === "idle") notifyNative({ type: "done", sessionId: this.sessionId, title: this.title || "Session", text: this.lastText.slice(0, 300) });
  }
  info() {
    return { sessionId: this.sessionId, cwd: this.cwd, state: this.state, seq: this.seq, model: this.model, effort: this.effort,
      permissionMode: this.permissionMode, title: this.title, pending: [...this.pending.values()].map(p => p.info) };
  }

  async pump() {
    try {
      for await (const m of this.q) {
        this.lastActive = Date.now();
        if (m.type === "system" && m.subtype === "init") {
          this.model = m.model || this.model;
          this.permissionMode = m.permissionMode || this.permissionMode;
          if (Array.isArray(m.slash_commands)) cache.commandNames = m.slash_commands;
          this.setState(this.state === "starting" ? "idle" : this.state);
          this.refreshMeta();
        } else if (m.type === "system" && m.subtype === "session_state_changed") {
          this.setState(m.state === "requires_action" ? "waiting" : m.state);
        } else if (m.type === "assistant" && !m.parent_tool_use_id) {
          const t = (m.message?.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
          if (t) this.lastText = t;
        } else if (m.type === "result") {
          if (this.state !== "waiting") this.setState("idle");
        }
        if (m.type === "system" && /^hook_/.test(m.subtype || "")) continue;
        this.emit(m);
      }
    } catch (e) {
      log("session error", this.sessionId.slice(0, 8), e?.message);
      this.emit({ type: "pa_error", message: String(e?.message || e) });
    }
    this.setState("closed");
    for (const [id, p] of this.pending) p.resolve({ behavior: "deny", message: "Session closed" });
    this.pending.clear();
    live.delete(this.sessionId);
    broadcastAll({ t: "state", sessionId: this.sessionId, state: "closed", info: this.info() });
  }

  async refreshMeta() {
    try {
      const [commands, models] = await Promise.all([this.q.supportedCommands(), this.q.supportedModels()]);
      cache.commands = commands; cache.models = models;
      try { cache.account = await this.q.accountInfo(); } catch {}
      saveJSON(path.join(DATA, "cache.json"), cache);
      broadcastAll({ t: "meta", commands: cache.commands, models: cache.models, account: cache.account });
    } catch (e) { log("meta failed", e?.message); }
  }

  askPermission(toolName, input, opts) {
    const requestId = crypto.randomUUID();
    const info = { requestId, sessionId: this.sessionId, toolName, input,
      suggestions: opts?.suggestions || [], decisionReason: opts?.decisionReason || null,
      blockedPath: opts?.blockedPath || null, title: this.title, at: Date.now() };
    return new Promise(resolve => {
      const done = r => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        broadcastAll({ t: "permission.resolved", sessionId: this.sessionId, requestId, behavior: r.behavior });
        notifyNative({ type: "permission.resolved", sessionId: this.sessionId, requestId });
        if (!this.pending.size && this.state === "waiting") this.setState("running");
        resolve(r);
      };
      this.pending.set(requestId, { resolve: done, info });
      opts?.signal?.addEventListener("abort", () => done({ behavior: "deny", message: "Cancelled" }));
      this.setState("waiting");
      broadcastAll({ t: "permission.request", ...info });
      notifyNative({ type: "permission.request", ...info, input: summarizeInput(toolName, input) });
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

  send({ text, images = [], uuid }) {
    const content = [];
    for (const img of images) content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
    if (text) content.push({ type: "text", text });
    const msg = { type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid: uuid || crypto.randomUUID() };
    this.emit({ type: "pa_user", uuid: msg.uuid, text, images: images.map(i => ({ mediaType: i.mediaType, data: i.data })) });
    this.inbox.push(msg);
    this.setState("running");
    if (!this.title && text) this.title = text.slice(0, 60);
    return msg.uuid;
  }

  async set({ model, permissionMode, effort }) {
    if (model !== undefined) { await this.q.setModel(model || undefined); this.model = model || null; }
    if (permissionMode) { await this.q.setPermissionMode(permissionMode); this.permissionMode = permissionMode; }
    if (effort !== undefined) { await this.q.applyFlagSettings({ effortLevel: effort || null }); this.effort = effort || null; }
    broadcastAll({ t: "state", sessionId: this.sessionId, state: this.state, info: this.info() });
  }

  close() { this.inbox.end(); try { this.q.close(); } catch {} }
}

function summarizeInput(tool, input) {
  if (!input || typeof input !== "object") return String(input ?? "");
  if (tool === "Bash") return input.command;
  if (input.file_path) return input.file_path;
  if (input.url) return input.url;
  if (input.pattern) return input.pattern;
  return JSON.stringify(input).slice(0, 200);
}

// Sessions open somewhere else (a Termux terminal or a Claude background session).
// Claude Code refuses to resume those, so we detect them up front and let the user choose.
const CLAUDE_DIR = path.join(HOME, ".claude");
function busyElsewhere() {
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(path.join(CLAUDE_DIR, "sessions")).filter(f => f.endsWith(".json")); } catch {}
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, "sessions", f), "utf8"));
      if (!s.sessionId || live.has(s.sessionId) || !s.pid || ourPids.has(s.pid)) continue;
      if (!fs.existsSync(`/proc/${s.pid}`)) continue;
      if (s.entrypoint && /^sdk/.test(s.entrypoint)) continue;
      out.set(s.sessionId, { kind: s.kind === "bg" ? "background" : "terminal", pid: s.pid, short: s.sessionId.slice(0, 8) });
    } catch {}
  }
  return out;
}
const ourPids = new Set();
function busyError(sessionId, info) {
  const e = new Error(info.kind === "background"
    ? "This chat is running as a Claude background session in Termux."
    : "This chat is open in a Claude terminal in Termux.");
  e.code = "BUSY_ELSEWHERE"; e.kind = info.kind; e.short = info.short; e.sessionId = sessionId;
  return e;
}
function runClaude(args, timeoutMs = 30000) {
  return new Promise(resolve => {
    import("node:child_process").then(({ execFile }) => {
      execFile(CLAUDE, args, { timeout: timeoutMs, env: process.env }, (err, stdout, stderr) => resolve({ ok: !err, out: (stdout || "") + (stderr || "") }));
    });
  });
}

function getLive(sessionId) {
  const s = live.get(sessionId);
  if (!s) throw new Error("Session is not running. Open it first.");
  return s;
}

async function openSession({ sessionId, cwd, model, effort, permissionMode, title }) {
  if (sessionId && live.has(sessionId)) return live.get(sessionId);
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
  const d = prefs.defaults;
  const s = new LiveSession({ sessionId, cwd, resume, title,
    model: model ?? d.model, effort: effort ?? d.effort, permissionMode: permissionMode ?? d.permissionMode });
  live.set(sessionId, s);
  log("opened", sessionId.slice(0, 8), resume ? "resume" : "new", cwd);
  return s;
}

// Close idle sessions nobody is watching, to save RAM on the phone.
setInterval(() => {
  for (const s of live.values()) {
    const watched = [...clients].some(c => c.subs.has(s.sessionId));
    if (s.state === "idle" && !watched && Date.now() - s.lastActive > IDLE_CLOSE_MS) { log("idle close", s.sessionId.slice(0, 8)); s.close(); }
  }
}, 60_000).unref();

// ───────────────────────────── files ─────────────────────────────
const IGNORE = new Set([".git", "node_modules", ".gradle", "build", "dist", ".cache", "__pycache__", ".venv", "venv", ".next"]);
async function listDir(p) {
  p = path.resolve(p || HOME);
  const ents = await fsp.readdir(p, { withFileTypes: true });
  const out = [];
  for (const e of ents) {
    let size = 0, mtime = 0;
    try { const st = await fsp.stat(path.join(p, e.name)); size = st.size; mtime = st.mtimeMs; } catch {}
    out.push({ name: e.name, dir: e.isDirectory() || (e.isSymbolicLink() && await isDir(path.join(p, e.name))), size, mtime });
  }
  out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  return { path: p, parent: path.dirname(p), entries: out };
}
async function isDir(p) { try { return (await fsp.stat(p)).isDirectory(); } catch { return false; } }
async function searchFiles(cwd, q, limit = 40) {
  q = (q || "").toLowerCase();
  const results = [];
  let seen = 0;
  async function walk(dir, depth) {
    if (depth > 8 || seen > 20000 || results.length >= 400) return;
    let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (IGNORE.has(e.name)) continue;
      seen++;
      const full = path.join(dir, e.name);
      const rel = path.relative(cwd, full);
      if (!q || rel.toLowerCase().includes(q)) results.push({ path: rel, dir: e.isDirectory() });
      if (e.isDirectory() && !e.name.startsWith(".")) await walk(full, depth + 1);
    }
  }
  await walk(cwd, 0);
  const score = r => { const n = path.basename(r.path).toLowerCase(); return (n.startsWith(q) ? 0 : n.includes(q) ? 1 : 2) + r.path.length / 1000; };
  return results.sort((a, b) => score(a) - score(b)).slice(0, limit);
}

// ───────────────────────────── sessions list ─────────────────────────────
async function sessionsList({ limit = 300, dir } = {}) {
  const list = await listSessions({ limit, ...(dir ? { dir } : {}) });
  const busy = busyElsewhere();
  return list.map(s => ({
    elsewhere: busy.get(s.sessionId)?.kind || null,
    sessionId: s.sessionId, title: s.customTitle || s.summary, firstPrompt: s.firstPrompt, cwd: s.cwd,
    lastModified: s.lastModified, createdAt: s.createdAt, gitBranch: s.gitBranch, tag: s.tag,
    custom: !!s.customTitle, pinned: prefs.pinned.includes(s.sessionId),
    live: live.has(s.sessionId) ? live.get(s.sessionId).state : null,
  }));
}

// ───────────────────────────── WebSocket protocol ─────────────────────────────
const handlers = {
  async hello() {
    return { t: "hello", version: VERSION, home: HOME, host: os.hostname(), platform: process.platform,
      defaults: prefs.defaults, pinned: prefs.pinned, commands: cache.commands, models: cache.models, account: cache.account,
      live: [...live.values()].map(s => s.info()) };
  },
  async "sessions.list"(m) { return { sessions: await sessionsList(m) }; },
  async "session.history"({ sessionId }) {
    const messages = await getSessionMessages(sessionId);
    const info = await getSessionInfo(sessionId).catch(() => undefined);
    return { sessionId, messages, info };
  },
  async "session.open"(m, ws) {
    const s = await openSession(m);
    ws.subs.add(s.sessionId);
    return { sessionId: s.sessionId, info: s.info(), seq: s.seq };
  },
  async subscribe({ sessionId, after = 0 }, ws) {
    ws.subs.add(sessionId);
    const s = live.get(sessionId);
    return { sessionId, info: s ? s.info() : null, events: s ? s.buffer.filter(e => e.seq > after) : [] };
  },
  async unsubscribe({ sessionId }, ws) { ws.subs.delete(sessionId); return {}; },
  async send(m, ws) {
    const s = live.get(m.sessionId) || await openSession(m);
    ws.subs.add(s.sessionId);
    return { sessionId: s.sessionId, uuid: s.send(m) };
  },
  async interrupt({ sessionId }) { await getLive(sessionId).q.interrupt(); return {}; },
  async "session.close"({ sessionId }) { live.get(sessionId)?.close(); return {}; },
  async "permission.reply"(m) { return { ok: getLive(m.sessionId).answer(m) }; },
  async set(m) {
    const s = live.get(m.sessionId);
    if (s) await s.set(m);
    return { info: s?.info() };
  },
  async "defaults.set"({ defaults }) {
    prefs.defaults = { ...prefs.defaults, ...defaults };
    saveJSON(path.join(DATA, "prefs.json"), prefs);
    return { defaults: prefs.defaults };
  },
  async "session.rename"({ sessionId, title }) {
    await renameSession(sessionId, title);
    const s = live.get(sessionId); if (s) s.title = title;
    broadcastAll({ t: "sessions.changed" });
    return {};
  },
  async "session.delete"({ sessionId }) {
    live.get(sessionId)?.close();
    await deleteSession(sessionId);
    prefs.pinned = prefs.pinned.filter(x => x !== sessionId); saveJSON(path.join(DATA, "prefs.json"), prefs);
    broadcastAll({ t: "sessions.changed" });
    return {};
  },
  async "session.pin"({ sessionId, pinned }) {
    prefs.pinned = prefs.pinned.filter(x => x !== sessionId);
    if (pinned) prefs.pinned.unshift(sessionId);
    saveJSON(path.join(DATA, "prefs.json"), prefs);
    broadcastAll({ t: "sessions.changed" });
    return { pinned: prefs.pinned };
  },
  async "session.fork"({ sessionId, upToMessageId, title }) {
    const r = await forkSession(sessionId, { upToMessageId, title });
    broadcastAll({ t: "sessions.changed" });
    return { sessionId: r.sessionId };
  },
  // Resolve a BUSY_ELSEWHERE conflict: continue in a copy, or stop the other copy first.
  async "session.continueHere"({ sessionId, mode }) {
    const busy = busyElsewhere().get(sessionId);
    if (mode === "fork") {
      const r = await forkSession(sessionId);
      broadcastAll({ t: "sessions.changed" });
      return { sessionId: r.sessionId };
    }
    if (mode === "stop") {
      if (busy?.kind === "terminal") throw new Error("That chat is open in a Termux terminal. Close it there (type /exit), then try again.");
      if (busy) {
        const r = await runClaude(["stop", busy.short]);
        for (let i = 0; i < 20 && busyElsewhere().has(sessionId); i++) await new Promise(res => setTimeout(res, 300));
        if (busyElsewhere().has(sessionId)) throw new Error("Couldn't stop it: " + r.out.trim().slice(0, 200));
      }
      return { sessionId };
    }
    throw new Error("unknown mode");
  },
  async "session.rewindFiles"({ sessionId, userMessageId, dryRun }) {
    return { result: await getLive(sessionId).q.rewindFiles(userMessageId, { dryRun: !!dryRun }) };
  },
  async "session.context"({ sessionId }) { return { usage: await getLive(sessionId).q.getContextUsage() }; },
  async "session.stopTask"({ sessionId, taskId }) { await getLive(sessionId).q.stopTask(taskId); return {}; },
  async "fs.list"({ path: p }) { return await listDir(p); },
  async "fs.search"({ cwd, q }) { return { results: await searchFiles(cwd || HOME, q) }; },
  async "fs.read"({ path: p }) {
    const st = await fsp.stat(p);
    const max = 512 * 1024;
    const fd = await fsp.open(p, "r");
    const buf = Buffer.alloc(Math.min(st.size, max));
    await fd.read(buf, 0, buf.length, 0); await fd.close();
    const binary = buf.includes(0);
    return { path: p, size: st.size, truncated: st.size > max, binary, text: binary ? null : buf.toString("utf8") };
  },
  async "fs.mkdir"({ path: p }) { await fsp.mkdir(p, { recursive: true }); return { path: p }; },
  async upload({ cwd, name, data }) {
    const dir = path.join(cwd || HOME, ".pocket-agent-uploads");
    await fsp.mkdir(dir, { recursive: true });
    const safe = path.basename(name || "file").replace(/[^\w.\- ]+/g, "_");
    let p = path.join(dir, safe), i = 1;
    while (fs.existsSync(p)) p = path.join(dir, `${i++}-${safe}`);
    await fsp.writeFile(p, Buffer.from(data, "base64"));
    return { path: p };
  },
};

function handleWs(ws) {
  ws.subs = new Set();
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("message", async raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const h = handlers[m.t];
    const reply = r => ws.readyState === 1 && ws.send(JSON.stringify({ ...r, t: "reply", id: m.id }));
    if (!h) return reply({ error: `unknown message ${m.t}` });
    try { reply(await h(m, ws) || {}); }
    catch (e) { log("handler error", m.t, e?.message); reply({ error: String(e?.message || e), code: e?.code, kind: e?.kind, short: e?.short }); }
  });
  ws.on("error", () => {});
}

// ───────────────────────────── HTTP ─────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/health") { res.setHeader("access-control-allow-origin", "*"); return json(res, 200, { ok: true, version: VERSION, live: live.size }); }
  if (url.pathname === "/" || url.pathname.startsWith("/ui/")) return serveUi(url.pathname, res);
  if (!safeEq(url.searchParams.get("token") || req.headers["x-token"], TOKEN)) return json(res, 401, { error: "bad token" });
  if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "hello", pending: [...live.values()].flatMap(s => s.info().pending) })}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }
  if (url.pathname === "/permission" && req.method === "POST") {
    let body = ""; for await (const c of req) body += c;
    try {
      const m = JSON.parse(body || "{}");
      return json(res, 200, { ok: getLive(m.sessionId).answer(m) });
    } catch (e) { return json(res, 400, { error: String(e.message) }); }
  }
  json(res, 404, { error: "not found" });
});
// The chat UI is served from the app's asset folder, so UI changes reach the
// installed app without reinstalling the APK (the APK bundles a fallback copy).
const UI_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../app/assets/ui");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };
async function serveUi(p, res) {
  if (p === "/") { res.writeHead(302, { location: "/ui/" }); return res.end(); }
  let rel = decodeURIComponent(p.slice(4)) || "index.html";
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(UI_DIR, rel);
  if (!file.startsWith(UI_DIR + path.sep)) return json(res, 403, { error: "forbidden" });
  try {
    const body = await fsp.readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch { json(res, 404, { error: "not found" }); }
}
function json(res, code, v) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); }

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
server.on("upgrade", (req, sock, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/ws" || !safeEq(url.searchParams.get("token"), TOKEN)) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, ws => handleWs(ws));
});
server.listen(PORT, HOST, () => log(`pocket-agent server ${VERSION} on http://${HOST}:${PORT}`));

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { for (const s of live.values()) s.close(); process.exit(0); });
process.on("unhandledRejection", e => log("unhandled", e?.message || e));
