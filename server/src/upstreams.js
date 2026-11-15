// Other Pocket Agent servers ("environments", e.g. a laptop) this server connects to and proxies chats for.
// A remote chat's id is "<envId>:<sessionId>"; local chat ids are UUIDs and never contain ":".
// Tokens live in secrets/profiles/<profile>/environments/<id>.token (0600), never in prefs, a reply or an event.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import WebSocket from "ws";
import { SECRETS_DIR, prefs, savePrefs } from "./config.js";
import { broadcast, broadcastAll, notifyNative } from "./hub.js";
import { toolDetail } from "./activity.js";

export const MIN_PROTOCOL = 1;
const DEFAULT_PORT = 8765;
const MAX_BUFFER = 4000;
const MAX_REMOTE_SUBS = 50;   // remote chats watched per environment, so a busy machine can't flood this one
const BAD_ADDRESS = "That address doesn't look right";
/** Chat requests forwarded to the environment as they are (besides subscribe / unsubscribe, below). */
export const REMOTE_VERBS = new Set(["session.history", "session.open", "session.context", "send", "interrupt",
  "permission.reply", "session.rename", "session.pin", "session.close", "session.fork"]);
/** Events from an environment that are about chats; anything else would overwrite this phone's own state. */
export const RELAY_TYPES = new Set(["activity", "state", "permission.request", "permission.resolved", "tasks",
  "account.limit", "sessions.changed", "link"]);

/** envId -> EnvironmentConnection for saved environments. */
export const connections = new Map();

// ───── ids in replies and events ─────
const ID_FIELDS = new Set(["sessionId", "parent", "parentSessionId", "childSessionId"]);
const plainObject = v => !!v && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** A copy of obj with chat ids namespaced under envId. Recurses to depth 4; message text is never touched. */
export function mapIds(obj, envId, depth = 0) {
  if (Array.isArray(obj)) return depth >= 4 ? obj : obj.map(v => mapIds(v, envId, depth + 1));
  if (!plainObject(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    // Always prefix, even a value that already has ":": a machine that sends "envB:abc" becomes
    // "envA:envB:abc" here, so it goes back only to envA (splitRemoteSession splits at the first ":").
    if (ID_FIELDS.has(k)) out[k] = typeof v === "string" ? `${envId}:${v}` : v;
    else out[k] = depth < 4 && (Array.isArray(v) || plainObject(v)) ? mapIds(v, envId, depth + 1) : v;
  }
  return out;
}

// ───── addresses ─────
/** "1.2.3.4:8765", "name:8765", "http(s)://…", "ws(s)://…" → "http(s)://host:port", no path or slash. */
export function baseUrl(input) {
  let s = String(input ?? "").trim();
  if (!s) throw new Error(BAD_ADDRESS);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "http://" + s;
  let u;
  try { u = new URL(s); } catch { throw new Error(BAD_ADDRESS); }
  const proto = u.protocol === "ws:" ? "http:" : u.protocol === "wss:" ? "https:" : u.protocol;
  if ((proto !== "http:" && proto !== "https:") || !u.hostname || u.username || u.password) throw new Error(BAD_ADDRESS);
  return `${proto}//${u.hostname}:${u.port || DEFAULT_PORT}`;
}
const hostPort = base => new URL(base).host;
const wsUrl = (base, token) => `${base.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;

/** Asks a server whether it's there, for Settings → Environments. */
export async function testUrl(url) {
  const base = baseUrl(url), started = Date.now();
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error("bad status");
    const h = await r.json();
    return { ok: true, version: h.version || null, protocol: h.protocol ?? null, ms: Date.now() - started };
  } catch {
    return { ok: false, error: `Can't reach ${hostPort(base)}` };
  }
}

// ───── stored environments and their token files ─────
const saved = () => (prefs.environments ||= []);
const find = id => saved().find(e => e.id === id);
const safeProfile = p => {
  const s = String(p || "personal").trim().replace(/[^\w.-]+/g, "_").slice(0, 64);
  return !s || /^\.+$/.test(s) ? "personal" : s;
};
const safeEnvId = s => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(s) ? s : null;
const tokenFile = (profile, id) => path.join(SECRETS_DIR, "profiles", safeProfile(profile), "environments", id + ".token");
const readToken = (profile, id) => { try { return fs.readFileSync(tokenFile(profile, id), "utf8").trim(); } catch { return ""; } };
const deleteToken = (profile, id) => { try { fs.rmSync(tokenFile(profile, id), { force: true }); } catch {} };
async function writeToken(profile, id, token) {
  const file = tokenFile(profile, id);
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  for (const dir of [path.join(SECRETS_DIR, "profiles"), path.join(SECRETS_DIR, "profiles", safeProfile(profile)), path.dirname(file)]) {
    await fsp.chmod(dir, 0o700).catch(() => {});
  }
  await fsp.writeFile(file, token, { mode: 0o600 });
  await fsp.chmod(file, 0o600);
}

/** This server's own environment, when environment.js exists (it may not on this branch). */
let localEnv;
const localEnvironment = () => localEnv ||= (async () => {
  try {
    const m = await import("./environment.js");
    const e = typeof m.environment === "function" ? m.environment() : m.environment || m.default;
    return e && typeof e === "object" ? e : null;
  } catch { return null; }
})();

/** The profiles that exist here, with the default one; an older install without profiles.js has "personal". */
async function localProfiles() {
  try {
    const m = await import("./profiles.js");
    return { all: m.listProfiles(), def: m.defaultProfileId() };
  } catch { return { all: [{ id: "personal", name: "Personal" }], def: "personal" }; }
}

/** Pairing with this same server would make a device of itself: /health says which server answers. */
async function isSelf(base, local) {
  if (!local?.id) return false;
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return false;
    const h = await r.json().catch(() => null);
    return !!h?.env && h.env === local.id;
  } catch { return false; }
}

const announce = () => broadcastAll({ t: "environments", environments: listEnvironments() });

/** What the app may see of an environment: never its token. */
function publicRecord(rec) {
  const c = connections.get(rec.id);
  return { id: rec.id, name: rec.name, url: rec.url, profile: rec.profile,
    state: c?.state || "offline", version: c?.version ?? null, protocol: c?.protocol ?? null,
    error: c?.error ?? null, lastOnlineAt: c?.lastOnlineAt ?? null };
}
export const listEnvironments = () => saved().map(publicRecord);

// ───── pairing ─────
const derivedId = base => "env-" + crypto.createHash("sha256").update(base).digest("hex").slice(0, 12);

/** A code from the other server's Settings → Environments, swapped for a device token. */
async function redeem(base, code, name) {
  let r;
  try {
    r = await fetch(`${base}/devices/redeem`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: String(code || ""), name }), signal: AbortSignal.timeout(8000) });
  } catch { throw new Error(`Can't reach ${hostPort(base)}`); }
  if (r.status === 403) throw new Error("That code is wrong or has expired");
  if (r.status === 429) throw new Error("Too many tries. Wait 10 minutes and get a new code");
  if (r.status === 404) throw new Error("That server is too old to pair. Update Pocket Agent there");
  if (!r.ok) {
    let msg = ""; try { msg = (await r.json()).error || ""; } catch {}
    throw new Error(msg || `Can't pair with ${hostPort(base)}`);
  }
  let j; try { j = await r.json(); } catch {}
  if (!j?.token) throw new Error("That server didn't send a token");
  return j;
}

/** One connection just to learn the other server's environment id and name. */
function handshake(base, token, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const host = hostPort(base);
    let ws, timer;
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { ws.terminate(); } catch {}
      if (err) reject(err); else resolve(val);
    };
    try { ws = new WebSocket(wsUrl(base, token)); } catch { return reject(new Error(`Can't reach ${host}`)); }
    timer = setTimeout(() => finish(new Error(`Can't reach ${host}`)), timeoutMs);
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", id: 1 })));
    ws.on("message", raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === "reply" && m.id === 1) { if (m.error) finish(new Error(m.error)); else finish(null, m); }
    });
    ws.on("unexpected-response", (req, res) => {
      res.resume();
      finish(res.statusCode === 401 ? Object.assign(new Error("Pair this device again"), { code: "UNAUTHORIZED" }) : new Error(`Can't reach ${host}`));
    });
    ws.on("close", ev => finish(ev.code === 4001 ? Object.assign(new Error("Pair this device again"), { code: "UNAUTHORIZED" }) : new Error(`Can't reach ${host}`)));
    ws.on("error", () => finish(new Error(`Can't reach ${host}`)));
  });
}

/**
 * Pairs with (or re-pairs) an environment. With a code, the code is redeemed for a token; otherwise a token is required.
 * The answer may be unauthorized: it is saved then, so the list shows it and the person can pair again.
 */
export async function addEnvironment({ url, code, token, profile, name } = {}) {
  const base = baseUrl(url);
  const local = await localEnvironment();
  // Which profile the environment is paired into: the default one unless asked for another.
  const { all, def } = await localProfiles();
  const wanted = typeof profile === "string" && profile.trim() ? profile.trim() : def;
  if (!all.some(p => p.id === wanted)) throw new Error("No such profile");
  const prof = safeProfile(wanted);
  let tok = String(token || "").trim();
  if (code) {
    if (await isSelf(base, local)) throw new Error("That's this device");
    tok = String((await redeem(base, code, local?.name || "Pocket Agent")).token || "").trim();
  }
  if (!tok) throw new Error("A token is needed to connect this device");
  let hello = null;
  try { hello = await handshake(base, tok); }
  catch (e) { if (e.code !== "UNAUTHORIZED") throw e; }
  // A wrong token never reaches hello: keep the record already saved for this address, so re-pairing
  // replaces its token instead of adding a second environment for the same machine.
  const known = saved().find(e => e.url === base);
  const id = safeEnvId(hello?.environment?.id) || known?.id || derivedId(base);
  if (local?.id && id === local.id) throw new Error("That's this device");
  const fallbackName = new URL(base).hostname.replace(/^\[|\]$/g, "");
  const named = String(name || hello?.environment?.name || "").trim().slice(0, 40) || fallbackName;
  let rec = find(id);
  if (!rec) {
    rec = { id, name: named, url: base, profile: prof, addedAt: Date.now() };
    saved().push(rec);
  } else {
    if (rec.profile !== prof) deleteToken(rec.profile, id);
    rec.url = base; rec.profile = prof;
    if (name && String(name).trim()) rec.name = String(name).trim().slice(0, 40);
  }
  await writeToken(prof, id, tok);
  connections.get(id)?.close();
  const conn = new EnvironmentConnection(rec);
  connections.set(id, conn);
  conn.start();
  savePrefs();
  announce();
  return publicRecord(rec);
}

export function removeEnvironment(id) {
  const list = saved(), i = list.findIndex(e => e.id === id);
  if (i < 0) throw new Error("No such environment");
  const [rec] = list.splice(i, 1);
  connections.get(id)?.close();
  connections.delete(id);
  deleteToken(rec.profile, id);
  savePrefs();
  announce();
  return { ok: true };
}

export function renameEnvironment(id, name) {
  const rec = find(id);
  if (!rec) throw new Error("No such environment");
  const n = String(name || "").trim();
  if (n.length < 1 || n.length > 40) throw new Error("A name needs 1 to 40 characters");
  rec.name = n;
  savePrefs();
  announce();
  return publicRecord(rec);
}

/** Once an hour a server that is too old gets another chance; this asks it now. */
export function reconnectEnvironment(id) {
  const rec = find(id);
  if (!rec) throw new Error("No such environment");
  let c = connections.get(id);
  if (!c) { c = new EnvironmentConnection(rec); connections.set(id, c); }
  c.reconnect();
  return publicRecord(rec);
}

// ───── the chat list, merged with the environments' ─────
/** Every saved environment's chats, namespaced; the cached list when it is offline. */
export async function remoteSessions() {
  const parts = await Promise.all(saved().map(async rec => {
    const c = connections.get(rec.id);
    const list = !c ? [] : c.state === "online" ? await c.refreshSessions() : c.cachedSessions();
    return (list || []).map(s => ({ ...mapIds(s, rec.id), environment: rec.id, environmentName: rec.name,
      remote: true, offline: !c || c.state !== "online", profile: rec.profile }));
  }));
  return parts.flat();
}

/** "<envId>:<sid>" for a known environment, else null. */
export function splitRemoteSession(id) {
  if (typeof id !== "string") return null;
  const i = id.indexOf(":");
  if (i < 0) return null;
  const env = connections.get(id.slice(0, i));
  return env ? { env, sid: id.slice(i + 1), full: id } : null;
}

/**
 * In http.js, before the local handler: requests for a remote chat go to its environment, and file browsing
 * with `env` goes there too. Returns undefined when the request is local.
 */
export async function forwardIfRemote(m, ws) {
  if (!m || typeof m !== "object") return undefined;
  const r = splitRemoteSession(m.sessionId);
  if (r) {
    // Another machine's chats are the owner's: a paired device never reaches them.
    if (ws?.principal?.kind !== "owner") throw ownerOnly();
    if (r.env.state !== "online") throw new Error(`${r.env.name} is offline`);
    if (m.t === "subscribe") return await r.env.localSubscribe(ws, r.sid, Number(m.after) || 0, r.full);
    if (m.t === "unsubscribe") return r.env.localUnsubscribe(ws, r.sid, r.full);
    if (REMOTE_VERBS.has(m.t)) {
      const params = { ...m, sessionId: r.sid };
      delete params.t; delete params.id; delete params.env;
      return mapIds(await r.env.call(m.t, params), r.env.id);
    }
    throw new Error("Not available for chats on other devices yet");
  }
  if (m.env && typeof m.t === "string" && (m.t.startsWith("files.") || m.t.startsWith("fs."))) {
    const env = connections.get(m.env);
    if (!env) return undefined;
    if (ws?.principal?.kind !== "owner") throw ownerOnly();
    if (env.state !== "online") throw new Error(`${env.name} is offline`);
    const params = { ...m };
    delete params.t; delete params.id; delete params.env;
    return await env.call(m.t, params);
  }
  return undefined;
}

/** A request that would reach another machine, from someone who isn't this phone's owner. */
function ownerOnly() {
  const e = new Error("Chats on other machines are only for this phone's owner");
  e.code = "forbidden";
  return e;
}

/** A local socket that closes loses its remote subscriptions, like it loses its local ones. */
function watchRemoteSub(ws, full, envId, sid) {
  (ws._remoteSubs ||= new Map()).set(full, { envId, sid });
  if (!ws._remoteCloseHook) {
    ws._remoteCloseHook = true;
    ws.on("close", () => dropRemoteSubs(ws));
  }
}
const unwatchRemoteSub = (ws, full) => ws._remoteSubs?.delete(full);
function dropRemoteSubs(ws) {
  const subs = [...(ws._remoteSubs?.entries() || [])];
  ws._remoteSubs?.clear();
  for (const [full, { envId, sid }] of subs) connections.get(envId)?.localUnsubscribe(ws, sid, full);
}

// ───── the connection to one environment ─────
export class EnvironmentConnection {
  constructor(rec) {
    Object.assign(this, { id: rec.id, name: rec.name, url: rec.url, profile: rec.profile,
      token: readToken(rec.profile, rec.id), state: "connecting", version: null, protocol: null, caps: null,
      helloEnv: null, error: null, lastOnlineAt: null });
    this.attempt = 0;
    this.pending = new Map();   // request id -> { resolve, reject, timer }
    this.nextId = 1;
    this.helloId = null;
    this.subs = new Map();      // remote session id -> { count, bg, after, lastSeq, info, reply, events, ready }
    this.prevStates = new Map();// remote session id -> its last state, for a "done" notification
    this.notifiedRequests = new Set();   // approvals already notified; a re-subscribe must not say them twice
    this.sessions = [];         // last chat list from this environment
    this.closed = false;
  }

  start() { this.closed = false; this.connect(); }

  cachedSessions() { return this.sessions; }

  wsAddress() { return wsUrl(this.url, this.token); }

  connect() {
    if (this.closed) return;
    this.dropSocket();
    if (!this.token) return this.fail("Pair this device again", "unauthorized");
    let ws;
    try { ws = this.ws = new WebSocket(this.wsAddress()); }
    catch { return this.retry(`Can't reach ${hostPort(this.url)}`); }
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.helloId = this.nextId++;
      ws.send(JSON.stringify({ t: "hello", id: this.helloId }));
      clearTimeout(this.helloTimeout);
      this.helloTimeout = setTimeout(() => this.retry(`Can't reach ${hostPort(this.url)}`), 10000);
      this.helloTimeout.unref?.();
    });
    ws.on("pong", () => clearTimeout(this.pongTimer));
    ws.on("message", raw => { if (this.ws === ws) this.onMessage(raw); });
    ws.on("unexpected-response", (req, res) => {
      res.resume();
      if (this.ws !== ws) return;
      if (res.statusCode === 401) this.fail("Pair this device again", "unauthorized");
      else this.retry(`Can't reach ${hostPort(this.url)}`);
    });
    ws.on("close", ev => {
      if (this.ws !== ws) return;
      if (ev.code === 4001) this.fail("Pair this device again", "unauthorized");
      else this.retry(`Can't reach ${hostPort(this.url)}`);
    });
    ws.on("error", () => {});   // a close follows
  }

  reconnect() {
    clearTimeout(this.retryTimer); clearTimeout(this.outdatedTimer);
    this.attempt = 0;
    this.dropSocket();
    this.setState("connecting", null);
    this.connect();
  }

  /** Closes for good (the record was removed or replaced). */
  close() {
    this.closed = true;
    clearTimeout(this.retryTimer); clearTimeout(this.outdatedTimer);
    this.dropSocket();
  }

  dropSocket() {
    clearTimeout(this.pongTimer); clearTimeout(this.helloTimeout); this.helloTimeout = null;
    clearInterval(this.heartbeat); this.heartbeat = null;
    const ws = this.ws;
    this.ws = null; this.helloId = null;
    if (ws) {
      try {
        ws.removeAllListeners();
        ws.on("error", () => {});   // terminating a CONNECTING socket emits one; without a listener it would crash us
        ws.terminate();
      } catch {}
    }
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`${this.name} went offline`)); this.pending.delete(id); }
  }

  setState(state, error = null) {
    const changed = state !== this.state || (error || null) !== this.error;
    this.state = state;
    this.error = error || null;
    if (changed) announce();
  }

  fail(error, state) {
    this.dropSocket();
    this.setState(state, error);
  }

  /** Offline, with backoff: 1, 2, 4… 60 s (±20%); PA_HUB_BACKOFF_MS (tests) replaces the start and caps at 10×. */
  retry(error) {
    if (this.closed || this.state === "unauthorized" || this.state === "outdated") return;
    this.dropSocket();
    this.setState("offline", error);
    const start = +(process.env.PA_HUB_BACKOFF_MS || 1000);
    const cap = process.env.PA_HUB_BACKOFF_MS ? start * 10 : 60000;
    const wait = Math.min(cap, start * 2 ** this.attempt++) * (0.8 + Math.random() * 0.4);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), wait);
    this.retryTimer.unref?.();
  }

  /** Its protocol is older than this hub's: leave it alone for an hour. */
  outdated() {
    this.dropSocket();
    this.setState("outdated", `Update Pocket Agent on ${this.name}`);
    clearTimeout(this.outdatedTimer);
    this.outdatedTimer = setTimeout(() => { if (!this.closed) { this.setState("connecting", null); this.connect(); } }, 3600_000);
    this.outdatedTimer.unref?.();
  }

  startHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try { this.ws.ping(); } catch { return; }
      clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => { try { this.ws?.terminate(); } catch {} }, 10000);
      this.pongTimer.unref?.();
    }, 25_000);
    this.heartbeat.unref?.();
  }

  onMessage(raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object") return;
    if (m.t === "reply") {
      if (m.id === this.helloId) return this.gotHello(m);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) {
        const e = new Error(m.error);
        if (m.code) e.code = m.code;
        if (m.kind) e.kind = m.kind;
        if (m.short) e.short = m.short;
        return p.reject(e);
      }
      return p.resolve(m);
    }
    this.onEvent(m);
  }

  gotHello(m) {
    clearTimeout(this.helloTimeout);
    if (this.closed) return;
    this.version = m.version || null;
    this.protocol = typeof m.protocol === "number" ? m.protocol : null;
    if (!this.protocol || this.protocol < MIN_PROTOCOL) return this.outdated();
    this.helloEnv = m.environment || null;
    this.caps = m.caps || null;
    this.attempt = 0;
    this.lastOnlineAt = Date.now();
    this.prevStates.clear();
    this.setState("online", null);
    this.startHeartbeat();
    this.refreshSessions().catch(() => {});
    // Re-subscribe the chats already watched, then watch every chat that is live upstream: their
    // approvals and done states must notify even while no screen has them open.
    this.resubscribe();
    for (const i of Array.isArray(m.live) ? m.live : []) this.ensureBgSub(i?.sessionId);
  }

  onEvent(m) {
    // A chat id from another machine may itself contain ":" (a hub of a hub): keep it whole as the
    // subscription key, and let mapIds prefix it for this server's clients.
    const sid = typeof m.sessionId === "string" && m.sessionId ? m.sessionId : null;
    if (m.t === "ev" && sid) {
      const sub = this.subs.get(sid);
      if (sub) {
        if (Number.isFinite(m.seq)) sub.lastSeq = Math.max(sub.lastSeq, m.seq);
        sub.events.push({ seq: m.seq, ev: m.ev });
        if (sub.events.length > MAX_BUFFER) sub.events.splice(0, sub.events.length - MAX_BUFFER);
      }
      return broadcast(mapIds({ ...m }, this.id));
    }
    if (!RELAY_TYPES.has(m.t)) return;
    const mapped = mapIds({ ...m, environment: this.id }, this.id);
    if (sid) this.noteState(m, sid, mapped);
    if (m.t === "sessions.changed") this.refreshSessions().catch(() => {});
    broadcastAll(mapped);
  }

  /** A remote chat's approval or finished reply gets a phone notification, headed with the environment's name. */
  noteState(m, sid, mapped) {
    const sub = this.subs.get(sid);
    if (m.t === "state") {
      const prev = this.prevStates.get(sid) || null;
      this.prevStates.set(sid, m.state);
      if (sub) sub.info = mapped.info || sub.info;
      // A live chat is watched even with no screen on it; a closed one stops.
      if (m.state === "closed") this.dropBgSub(sid); else this.ensureBgSub(sid);
      if ((prev === "running" || prev === "waiting") && m.state === "idle")
        notifyNative({ type: "done", sessionId: mapped.sessionId,
          title: typeof mapped.info?.title === "string" ? mapped.info.title : "Session", envName: this.name });
    } else if (m.t === "permission.request") {
      // Named fields only: never spread an environment's object into a notification.
      if (typeof m.requestId === "string" && this.notifiedRequests.has(m.requestId)) return;
      if (typeof m.requestId === "string") this.notifiedRequests.add(m.requestId);
      notifyNative({ type: "permission.request", sessionId: mapped.sessionId, requestId: m.requestId,
        toolName: typeof m.toolName === "string" ? m.toolName : "", input: toolDetail(m.toolName, m.input) || "",
        title: typeof m.title === "string" ? m.title : typeof mapped.info?.title === "string" ? mapped.info.title : undefined,
        envName: this.name });
    } else if (m.t === "permission.resolved") {
      notifyNative({ type: "permission.resolved", requestId: m.requestId });
    }
  }

  /** Watch a live remote chat upstream, so its approvals and done states notify with no screen open. Bounded. */
  ensureBgSub(sid) {
    if (typeof sid !== "string" || !sid) return;
    const existing = this.subs.get(sid);
    if (existing) { existing.bg = true; return; }
    if (this.subs.size >= MAX_REMOTE_SUBS) return;
    const sub = { count: 0, bg: true, pending: true, after: 0, lastSeq: 0, info: null, reply: null, events: [] };
    this.subs.set(sid, sub);
    sub.ready = (async () => {
      try {
        const raw = await this.call("subscribe", { sessionId: sid, after: 0 }, 8000);
        sub.reply = mapIds(raw, this.id);
        sub.info = sub.reply.info || null;
        sub.events = Array.isArray(raw.events) ? raw.events.slice(-MAX_BUFFER) : [];
        sub.lastSeq = Math.max(Number(sub.info?.seq) || 0, ...sub.events.map(e => Number(e.seq) || 0));
        this.notePending(sid, sub);
      } finally { sub.pending = false; }
    })();
    sub.ready.catch(() => { if (this.subs.get(sid) === sub && !sub.count) this.subs.delete(sid); });
  }

  /** Stop watching a chat nobody here has open (a screen subscriber keeps it alive). */
  dropBgSub(sid) {
    const sub = this.subs.get(sid);
    if (!sub || !sub.bg || sub.count > 0) return;
    this.subs.delete(sid);
    this.prevStates.delete(sid);
    this.call("unsubscribe", { sessionId: sid }).catch(() => {});
  }

  /** A subscribe reply's `info.pending`: approvals that were waiting while no screen was open. Notify each once. */
  notePending(sid, sub) {
    const info = sub.info || sub.reply?.info;
    for (const p of Array.isArray(info?.pending) ? info.pending : []) {
      const requestId = p?.requestId;
      if (typeof requestId !== "string" || this.notifiedRequests.has(requestId)) continue;
      this.notifiedRequests.add(requestId);
      const ev = { type: "permission.request", sessionId: `${this.id}:${sid}`, requestId,
        input: toolDetail(p.toolName, p.input) || "", envName: this.name };
      if (typeof p.toolName === "string") ev.toolName = p.toolName;
      const title = typeof p.title === "string" ? p.title : info?.title;
      if (typeof title === "string") ev.title = title;
      notifyNative(ev);
    }
  }

  call(t, params = {}, timeoutMs = 30000) {
    if (this.closed || this.state !== "online" || !this.ws || this.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error(`${this.name} is offline`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name} didn't answer in time`)); }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ t, id, ...params })); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  /** The chat list, cached for when the environment is offline. */
  async refreshSessions() {
    if (this.state !== "online") return this.sessions;
    try {
      const r = await this.call("sessions.list", { limit: 300 }, 4000);
      if (Array.isArray(r.sessions)) this.sessions = r.sessions;
    } catch {}
    return this.sessions;
  }

  /** After a reconnect, the environment forgot our subscriptions: ask again for each chat someone here watches. */
  async resubscribe() {
    for (const [sid, sub] of this.subs) {
      if (!(sub.count > 0 || sub.bg) || sub.pending) continue;   // a new background subscribe is already in flight
      try {
        // From the last seq seen: what happened during the gap comes back, and nothing is replayed twice.
        const raw = await this.call("subscribe", { sessionId: sid, after: sub.lastSeq || sub.after || 0 }, 8000);
        if (this.subs.get(sid) !== sub) continue;   // a screen closed it meanwhile
        const mapped = mapIds(raw, this.id);
        sub.reply = mapped;
        sub.info = mapped.info || sub.info;
        for (const e of raw.events || []) sub.events.push(e);
        sub.events = sub.events.slice(-MAX_BUFFER);
        sub.lastSeq = sub.events.reduce((n, e) => Math.max(n, e.seq || 0), sub.lastSeq);
        this.notePending(sid, sub);   // an approval that arrived during the gap
      } catch {}
    }
  }

  /** The first local subscriber asks the environment; the others share that reply and the events since. */
  async localSubscribe(ws, sid, after, full) {
    const already = ws.subs.has(full);   // a second subscribe from the same socket counts once
    ws.subs.add(full);
    watchRemoteSub(ws, full, this.id, sid);
    let sub = this.subs.get(sid);
    if (!sub) {
      sub = { count: 1, after, lastSeq: 0, info: null, reply: null, events: [] };
      this.subs.set(sid, sub);
      sub.ready = (async () => {
        const raw = await this.call("subscribe", { sessionId: sid, after }, 30000);
        sub.reply = mapIds(raw, this.id);
        sub.info = sub.reply.info || null;
        sub.events = Array.isArray(raw.events) ? raw.events.slice(-MAX_BUFFER) : [];
        sub.lastSeq = sub.events.reduce((n, e) => Math.max(n, e.seq || 0), 0);
        this.notePending(sid, sub);   // approvals waiting while no screen was open
      })();
      sub.ready.catch(() => { if (this.subs.get(sid) === sub) this.subs.delete(sid); });
    } else if (!already) sub.count++;
    // A background subscription (ensureBgSub) may still be waiting for its first reply: share it.
    try { await sub.ready; }
    catch (e) {
      ws.subs.delete(full); unwatchRemoteSub(ws, full); sub.count--;
      if (sub.count <= 0 && this.subs.get(sid) === sub) this.subs.delete(sid);
      throw e;
    }
    const reply = sub.reply || {};
    return { ...reply, sessionId: full, info: sub.info || reply.info || null,
      events: sub.events.filter(e => Number(e.seq || 0) > after) };
  }

  localUnsubscribe(ws, sid, full) {
    ws.subs.delete(full);
    unwatchRemoteSub(ws, full);
    const sub = this.subs.get(sid);
    if (!sub) return {};
    sub.count--;
    if (sub.count <= 0) {
      if (sub.bg) return {};   // still watching for approvals and done states
      this.subs.delete(sid);
      this.prevStates.delete(sid);
      this.call("unsubscribe", { sessionId: sid }).catch(() => {});
    }
    return {};
  }
}

// ───── start-up ─────
/** Opens every saved environment's connection, once the server is listening (index.js). */
export function startEnvironments() {
  for (const rec of saved()) {
    if (connections.has(rec.id)) continue;
    const c = new EnvironmentConnection(rec);
    connections.set(rec.id, c);
    c.start();
  }
}

export function stopEnvironments() {
  for (const c of connections.values()) c.close();
  connections.clear();
}
