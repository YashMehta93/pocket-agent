// DeepSeek: the account (key and balance), prices and spend, and the key keeper.
//
// A DeepSeek chat is Claude Code pointed at DeepSeek's Anthropic-compatible API (engines.js). Its requests come to the
// key keeper, the /deepseek/* route here, with a random per-chat token instead of the key. We swap the token for the
// real key, stream DeepSeek's answer back untouched and read the token counts on the side, so the key never enters a
// chat's environment, and spend is known per chat and per day.
//
// The key lives in ~/.pocket-agent/secrets/deepseek (0600 in a 0700 folder); backups skip it. Only this module reads
// it, and it never leaves the server: the UI gets its last 4 characters, and logs and errors never contain it.
// Spend is an estimate from token counts at DeepSeek's prices (deepseek-spend.json); DeepSeek's balance is the truth.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { HOME, DATA, SECRETS_DIR, prefs, savePrefs, cache, saveCache, log } from "./config.js";
import { broadcastAll } from "./hub.js";

// ───── models ─────
export const DS_MODELS = [
  { value: "deepseek-flash[1m]", displayName: "DeepSeek Flash", description: "Fast and cheap. Sees images.", efforts: ["low", "high", "max"], images: true },
  { value: "deepseek-v4-pro[1m]", displayName: "DeepSeek V4 Pro", description: "Stronger, about 3–4× the price. No images.", efforts: ["low", "high", "max"], images: false },
];
const DEFAULT_MODEL = DS_MODELS[0].value;
export const isDeepseekModel = m => /^deepseek-/.test(m || "");
/** "flash", "pro" or a DeepSeek model name (with or without [1m]) → its DS_MODELS value, else null. */
function knownModel(m) {
  const s = String(m || "").trim().toLowerCase().replace(/\[1m\]$/, "");
  if (["flash", "deepseek-flash", "deepseek-v4-flash"].includes(s)) return DS_MODELS[0].value;
  if (["pro", "v4-pro", "deepseek-v4-pro"].includes(s)) return DS_MODELS[1].value;
  return null;
}
/** Any model name → a DS_MODELS value: Flash/Pro by name, anything else the default (Flash). */
export const dsModel = m => knownModel(m) || DEFAULT_MODEL;

// ───── prices and peak hours ─────
// USD per 1M tokens at peak; off-peak is half. api-docs.deepseek.com/quick_start/pricing, 14 Nov 2026.
const PRICES = { "deepseek-flash": { hit: 0.006, miss: 0.30, out: 1.20 }, "deepseek-v4-pro": { hit: 0.044, miss: 1.32, out: 3.96 } };
const priceFor = m => /v4-pro|^claude-opus/.test(m) ? PRICES["deepseek-v4-pro"] : PRICES["deepseek-flash"];   // DeepSeek's own name mapping
// Peak: Mon–Fri 01:00–04:00 and 06:00–10:00 UTC (06:30–09:30, 11:30–15:30 IST). Chinese holidays are off-peak too: we can't
// know them, so spend may read a little high on those days; it's labelled an estimate.
export const isPeak = t => { const d = new Date(t), w = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes(); return w >= 1 && w <= 5 && (m >= 60 && m < 240 || m >= 360 && m < 600); };
/** USD for one request's usage (input_tokens = cache misses, cache_read_input_tokens = hits, output_tokens). */
export const costOf = (model, u, t = Date.now()) => { const p = priceFor(model || ""); u ||= {}; return (isPeak(t) ? 1 : 0.5) * ((u.cache_read_input_tokens || 0) * p.hit + (u.input_tokens || 0) * p.miss + (u.output_tokens || 0) * p.out) / 1e6; };
/** Whether peak prices apply at `t`, and when that next changes (prices change on whole hours, so 15-minute steps find it). */
export function priceNow(t = Date.now()) {
  const peak = isPeak(t), slot = 15 * 60e3;
  let until = Math.floor(t / slot) * slot + slot;
  while (until < t + 4 * 86400e3 && isPeak(until) === peak) until += slot;
  return { peak, until };
}

// ───── settings (prefs.deepseek; only what the person changed is stored, so defaults can move) ─────
const DEFAULTS = { defaultModel: DEFAULT_MODEL, effort: null, dailyCapUsd: 0, workerMode: null, toDeepseek: true, toClaude: true, blockedFolders: [] };
const bad = message => Object.assign(new Error(message), { code: "BAD_SETTING" });
const toBool = name => v => { if (typeof v !== "boolean") throw bad(`${name} is on or off.`); return v; };
const VALID = {
  defaultModel: v => knownModel(v) || (() => { throw bad("The model is Flash or V4 Pro."); })(),
  effort: v => { if (v == null || v === "") return null; if (!["low", "high", "max"].includes(v)) throw bad("Effort is low, high or max."); return v; },
  // 0 = no limit (the owner's choice: spend is shown, not capped, unless a limit is set)
  dailyCapUsd: v => { const n = typeof v === "string" ? Number(v.replace(/^\$/, "")) : v; if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1000) throw bad("The daily limit is $0 to $1000 (0 means no limit)."); return n; },
  // null = a worker runs in the calling chat's mode (the owner's choice)
  workerMode: v => { if (v == null || v === "") return null; if (!["default", "acceptEdits", "bypassPermissions"].includes(v)) throw bad("Workers ask, auto-edit, or bypass."); return v; },
  toDeepseek: toBool("Sending work to DeepSeek"),
  toClaude: toBool("Asking Claude"),
  blockedFolders: v => {
    const list = (Array.isArray(v) ? v : String(v ?? "").split("\n")).map(x => String(x ?? "").trim()).filter(Boolean)
      .map(x => x === "~" ? HOME : x.startsWith("~/") ? path.join(HOME, x.slice(2)) : x);
    const wrong = list.find(x => !path.isAbsolute(x));
    if (wrong) throw bad(`Use full folder paths, like /root/projects/work (not ${wrong.slice(0, 80)}).`);
    if (list.length > 50) throw bad("At most 50 folders.");
    return [...new Set(list.map(x => path.resolve(x)))];
  },
  // Only DeepSeek itself, or a stand-in on this phone (the test endpoint): the key must never go to another host.
  baseUrl: v => {
    if (v == null || v === "") return null;
    let u; try { u = new URL(String(v)); } catch { throw bad("That isn't an address."); }
    const official = u.href.replace(/\/+$/, "") === "https://api.deepseek.com/anthropic";
    const local = /^https?:$/.test(u.protocol) && ["127.0.0.1", "localhost"].includes(u.hostname) && !u.username && !u.password;
    if (!official && !local) throw bad("Only https://api.deepseek.com/anthropic, or an address on this phone (127.0.0.1), can be used.");
    return u.href.replace(/\/+$/, "");
  },
  direct: toBool("Direct mode"),   // emergency fallback (no UI): chats get DeepSeek's URL and the key itself; no metering, no limit
};
/** The DeepSeek settings, each checked; a broken stored value falls back to its default. */
export function dsSettings() {
  const p = prefs.deepseek && typeof prefs.deepseek === "object" ? prefs.deepseek : {};
  const out = { ...DEFAULTS, blockedFolders: [], baseUrl: null, direct: false };
  for (const k of Object.keys(VALID)) if (p[k] !== undefined) { try { out[k] = VALID[k](p[k]); } catch {} }
  return out;
}
/** Changes some settings; throws (code BAD_SETTING, a plain message) and changes nothing if any field is wrong. */
export function setDsSettings(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw bad("No settings given.");
  const next = { ...(prefs.deepseek && typeof prefs.deepseek === "object" ? prefs.deepseek : {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (!VALID[k]) throw bad(`Unknown DeepSeek setting: ${String(k).slice(0, 40)}`);
    const val = VALID[k](v);
    if (val === null || (k === "direct" && val === false)) delete next[k]; else next[k] = val;
  }
  prefs.deepseek = next; savePrefs();
  push();
  return dsSettings();
}
export const upstream = () => process.env.PA_DEEPSEEK_URL || dsSettings().baseUrl || "https://api.deepseek.com/anthropic";
export const apiRoot = () => upstream().replace(/\/+$/, "").replace(/\/anthropic$/, "");

// ───── the key ─────
const KEY_FILE = path.join(SECRETS_DIR, "deepseek");
let keyCache = { key: null, mtime: -1 };
const state = { note: null, balanceError: null };
/** The saved key, or null. Only the key keeper, the balance check and direct mode use it; never send it to the UI. */
export function readKey() {
  let st; try { st = fs.statSync(KEY_FILE); } catch { keyCache = { key: null, mtime: -1 }; return null; }
  if (st.mtimeMs !== keyCache.mtime) { try { keyCache = { key: fs.readFileSync(KEY_FILE, "utf8").trim() || null, mtime: st.mtimeMs }; } catch { return null; } }
  return keyCache.key;
}
export const ready = () => !!readKey();
export function requireReady() {
  if (!ready()) throw Object.assign(new Error("Add your DeepSeek key in Settings → DeepSeek first."), { code: "NO_DEEPSEEK_KEY" });
}
/** Hides the key in any text that might reach a log or the UI (an error message could quote a header). */
const scrub = (s, key = readKey()) => { s = String(s ?? ""); return key && key.length >= 8 ? s.split(key).join("****") : s; };

/** Checks a key with DeepSeek, then saves it. 401 → BAD_KEY and nothing saved; DeepSeek unreachable → saved with a note. */
export async function setKey(key) {
  key = String(key ?? "").trim();
  if (!/^[\x21-\x7e]{10,200}$/.test(key)) throw Object.assign(new Error("That doesn't look like a DeepSeek key."), { code: "BAD_KEY" });
  let r = null;
  try { r = await fetchBalance(key, 8000); } catch {}
  if (r?.status === 401) throw Object.assign(new Error("DeepSeek didn't accept that key."), { code: "BAD_KEY" });
  // a fresh 0600 file renamed over the old one: the key is never in a file anyone else could read, even briefly
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(SECRETS_DIR, 0o700);
  const tmp = `${KEY_FILE}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, key, { mode: 0o600, flag: "wx" });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, KEY_FILE);
  keyCache = { key, mtime: fs.statSync(KEY_FILE).mtimeMs };
  cache.deepseekBalance = null;
  if (r?.status === 200 && r.json) { storeBalance(r.json); lastFetch = Date.now(); state.note = null; state.balanceError = null; }
  else { saveCache(); state.note = "Saved. Couldn't reach DeepSeek to check it."; state.balanceError = null; }
  log("deepseek key saved", r ? `(checked: ${r.status})` : "(not checked: no answer)");
  push();
  return status();
}
export function removeKey() {
  fs.rmSync(KEY_FILE, { force: true });
  keyCache = { key: null, mtime: -1 };
  cache.deepseekBalance = null; saveCache();
  state.note = null; state.balanceError = null;
  log("deepseek key removed");
  push();
  return status();
}

// ───── balance (from DeepSeek) ─────
async function fetchBalance(key, ms) {
  const r = await fetch(apiRoot() + "/user/balance", { headers: { authorization: "Bearer " + key, accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
function storeBalance(j) {
  const infos = Array.isArray(j?.balance_infos) ? j.balance_infos : [];
  const b = infos.find(x => x?.currency === "USD") || infos[0] || {};
  const str = v => v == null ? null : String(v);
  cache.deepseekBalance = { currency: str(b.currency) || "USD", total: str(b.total_balance), granted: str(b.granted_balance), toppedUp: str(b.topped_up_balance),
    available: j?.is_available !== false, at: Date.now() };
  saveCache();
}
let lastFetch = 0, fetching = null;
/** DeepSeek's balance: cached for 60 s; even when asked, at most one call every 10 s. Errors go to status().balanceError. */
export async function balance({ refresh = false } = {}) {
  const key = readKey();
  if (!key) return null;
  const b = cache.deepseekBalance;
  if (!refresh && b && Date.now() - b.at < 60e3) return b;
  if (fetching) return await fetching;
  if (Date.now() - lastFetch < 10e3) return b || null;
  lastFetch = Date.now();
  fetching = (async () => {
    try {
      const r = await fetchBalance(key, 8000);
      if (r.status === 200 && r.json) { storeBalance(r.json); state.balanceError = null; state.note = null; }
      else state.balanceError = r.status === 401 ? "DeepSeek didn't accept the saved key." : `DeepSeek answered ${r.status}.`;
    } catch (e) { state.balanceError = "Couldn't reach DeepSeek: " + scrub(e?.cause?.message || e?.message || e, key).slice(0, 200); }
    finally { fetching = null; }
    push();
    return cache.deepseekBalance || null;
  })();
  return await fetching;
}

// ───── spend (estimated; ~/.pocket-agent/deepseek-spend.json) ─────
const SPEND_FILE = path.join(DATA, "deepseek-spend.json");
const spend = (() => {
  try { const j = JSON.parse(fs.readFileSync(SPEND_FILE, "utf8")); return { days: j.days || {}, searchDays: j.searchDays || {}, chats: j.chats || {} }; }
  catch { return { days: {}, searchDays: {}, chats: {} }; }
})();
// The day in the phone's time zone (the server runs in UTC; the app sends its offset in hello).
const dayKey = t => new Date(t - (Number.isFinite(prefs.tzOffset) ? prefs.tzOffset : 0) * 60e3).toISOString().slice(0, 10);
const round = x => Math.round(x * 1e6) / 1e6;
let saveTimer = null;
function saveSpend() {
  clearTimeout(saveTimer); saveTimer = null;
  const keep = (o, n) => Object.keys(o).sort().slice(0, -n).forEach(k => delete o[k]);   // keys are dates: the oldest go
  keep(spend.days, 62); keep(spend.searchDays, 62);
  const ids = Object.keys(spend.chats);
  if (ids.length > 500) ids.sort((a, b) => spend.chats[a].at - spend.chats[b].at).slice(0, ids.length - 500).forEach(k => delete spend.chats[k]);
  try { const tmp = SPEND_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(spend), { mode: 0o600 }); fs.renameSync(tmp, SPEND_FILE); }
  catch (e) { log("deepseek spend not saved:", e?.message); }
}
process.on("exit", () => { if (saveTimer) saveSpend(); });
/** This chat's DeepSeek spend so far: { usd, hit, miss, out, n, searches, at }, or null. */
export const chatSpend = id => spend.chats[id] ? { ...spend.chats[id], usd: round(spend.chats[id].usd) } : null;
const todayUsd = (t = Date.now()) => spend.days[dayKey(t)] || 0;
function spendSummary(t = Date.now()) {
  const d = dayKey(t), month = d.slice(0, 7);
  let m = 0; for (const [k, v] of Object.entries(spend.days)) if (k.startsWith(month)) m += v;
  return { today: round(todayUsd(t)), month: round(m), cap: dsSettings().dailyCapUsd, searchesToday: spend.searchDays[d] || 0 };
}
function meter(sessionId, model, u, t = Date.now()) {
  const usd = costOf(model, u, t), d = dayKey(t), searches = Math.max(0, +u.server_tool_use?.web_search_requests || 0);
  spend.days[d] = (spend.days[d] || 0) + usd;
  if (searches) spend.searchDays[d] = (spend.searchDays[d] || 0) + searches;
  const c = spend.chats[sessionId] ||= { usd: 0, hit: 0, miss: 0, out: 0, n: 0, searches: 0, at: 0 };
  c.usd += usd; c.hit += u.cache_read_input_tokens || 0; c.miss += u.input_tokens || 0; c.out += u.output_tokens || 0; c.n++; c.searches += searches; c.at = t;
  saveTimer ||= setTimeout(saveSpend, 2000);
  pushSpend();
  return usd;
}
// After metered requests the app gets { spend, price }, at most every 2 s.
let lastPush = 0, pushTimer = null;
function pushSpend() {
  const wait = 2000 - (Date.now() - lastPush);
  if (wait > 0) { pushTimer ||= setTimeout(() => { pushTimer = null; pushSpend(); }, wait); return; }
  lastPush = Date.now();
  broadcastAll({ t: "deepseek", deepseek: { spend: spendSummary(), price: priceNow() } });
}
const push = () => broadcastAll({ t: "deepseek", deepseek: status() });

/** The `deepseek` object for hello, deepseek.* replies and events (docs/PROTOCOL.md). The key itself never leaves. */
export function status() {
  const key = readKey(), b = key ? cache.deepseekBalance : null, s = dsSettings();
  return { ready: !!key, keyHint: key ? key.slice(-4) : null, note: key ? state.note : null,
    balance: b ? { total: b.total, currency: b.currency, granted: b.granted, toppedUp: b.toppedUp, available: b.available, at: b.at } : null,
    balanceError: key ? state.balanceError : null,
    spend: spendSummary(), price: priceNow(),
    settings: { defaultModel: s.defaultModel, effort: s.effort, dailyCapUsd: s.dailyCapUsd, workerMode: s.workerMode, toDeepseek: s.toDeepseek,
      toClaude: s.toClaude, blockedFolders: s.blockedFolders, baseUrl: s.baseUrl, direct: s.direct },
    models: DS_MODELS };
}

/** Throws FOLDER_BLOCKED if `cwd` is inside a folder the person keeps DeepSeek out of. */
export function checkFolder(cwd) {
  const list = dsSettings().blockedFolders;
  if (!list.length || !cwd) return;
  const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const c = real(cwd);
  for (const b of list) {
    const r = real(b);
    if (c === r || c.startsWith(r.endsWith("/") ? r : r + "/")) throw Object.assign(new Error(`DeepSeek is kept out of ${b} (Settings → DeepSeek).`), { code: "FOLDER_BLOCKED" });
  }
}

// ───── the key keeper (route /deepseek/*, see http.js) ─────
const tokens = new Map();   // per-chat token → sessionId; issued when a DeepSeek chat starts, revoked when it closes
export function issueToken(sessionId) { const t = "pa-ds-" + crypto.randomBytes(16).toString("hex"); tokens.set(t, sessionId); return t; }
export function revokeToken(token) { if (token) tokens.delete(token); }

/**
 * Reads usage from an Anthropic-style SSE stream fed in arbitrary chunks (an event, or a UTF-8 character, may be split
 * anywhere): message_start.message.usage, then each message_delta.usage on top (DeepSeek's last one holds the request's).
 */
export function sseUsage() {
  const dec = new StringDecoder("utf8");
  let buf = "", usage = null, stopped = false;
  const take = ev => {
    let data = "";
    for (const line of ev.split(/\r?\n/)) if (line.startsWith("data:")) data += line.slice(line[5] === " " ? 6 : 5);
    if (!data) return;
    let j; try { j = JSON.parse(data); } catch { return; }
    if (j.type === "message_start" && j.message?.usage) usage = { ...usage, ...j.message.usage };
    else if (j.type === "message_delta" && j.usage) usage = { ...usage, ...j.usage };
    else if (j.type === "message_stop") stopped = true;
  };
  const drain = () => { let m; while ((m = /\r?\n\r?\n/.exec(buf))) { take(buf.slice(0, m.index)); buf = buf.slice(m.index + m[0].length); } };
  return {
    push(chunk) { buf += typeof chunk === "string" ? chunk : dec.write(chunk); drain(); },
    end() { buf += dec.end(); drain(); if (buf.trim()) take(buf); buf = ""; return usage; },
    get usage() { return usage; },
    get stopped() { return stopped; },
  };
}

const MAX_BODY = 64 * 1024 * 1024;
const refused = new Set();
const errJson = (res, code, type, message) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type, message } })); };
const loopback = a => /^(127\.|::1$|::ffff:127\.)/.test(a || "");

/**
 * The key keeper. Claude Code (a DeepSeek chat) → here with its chat's token → DeepSeek with the real key.
 * node:http(s), not fetch: undici's 300 s header/body timeouts would cut off DeepSeek's long queues.
 */
export async function proxy(req, res, url) {
  // from this phone only (a DeepSeek chat runs here), even when the server also listens on other addresses
  if (!loopback(req.socket.remoteAddress) && req.socket.remoteAddress !== req.socket.localAddress) return errJson(res, 403, "permission_error", "Not allowed");
  const auth = String(req.headers.authorization || "");
  const token = /^Bearer\s/i.test(auth) ? auth.slice(7).trim() : String(req.headers["x-api-key"] || "").trim();
  const sessionId = token ? tokens.get(token) : undefined;
  if (!sessionId) return errJson(res, 401, "authentication_error", "Pocket Agent: this chat's DeepSeek pass has expired. Send again.");
  const sub = url.pathname.slice("/deepseek".length);
  if (req.method !== "POST" || !/^\/v1\/messages(\/count_tokens)?$/.test(sub)) {
    if (!refused.has(sub) && refused.size < 50) { refused.add(sub); log("deepseek refused", req.method, sub.slice(0, 100)); }
    return errJson(res, 404, "not_found_error", "Pocket Agent passes on only /v1/messages.");
  }
  const key = readKey();
  if (!key) return errJson(res, 401, "authentication_error", "Add your DeepSeek key in Settings → DeepSeek.");
  const metered = sub === "/v1/messages", cap = dsSettings().dailyCapUsd;
  if (metered && cap > 0 && todayUsd() >= cap)
    return errJson(res, 402, "billing_error", `Pocket Agent: today's DeepSeek limit ($${cap.toFixed(2)}) is used up. Change it in Settings → DeepSeek.`);

  let body;
  try {
    const parts = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_BODY) return errJson(res, 413, "request_too_large", "Pocket Agent: this request is too large."); parts.push(c); }
    body = Buffer.concat(parts);
  } catch { return res.destroy(); }   // Claude Code went away mid-request
  let model = ""; try { model = String(JSON.parse(body).model || ""); } catch {}

  const up = new URL(upstream()), lib = up.protocol === "https:" ? https : http;
  const headers = { "content-type": "application/json", "content-length": body.length, authorization: "Bearer " + key };
  for (const h of ["accept", "anthropic-version", "anthropic-beta", "user-agent"]) if (req.headers[h]) headers[h] = req.headers[h];
  const t0 = Date.now();
  let parser = null, done = false;
  // Meter once per request: at message_stop (before Claude Code can end its turn), else at the end, else with what a cut-off stream had.
  const meterOnce = u => {
    if (done || !metered || !u) return;
    done = true;
    const usd = meter(sessionId, model, u);
    log("deepseek", model || "?", sessionId.slice(0, 8), `${((Date.now() - t0) / 1000).toFixed(1)}s`,
      `in ${u.input_tokens || 0}+${u.cache_read_input_tokens || 0} cached, out ${u.output_tokens || 0}, ≈ $${usd.toFixed(5)}`);
  };
  const upReq = lib.request({ hostname: up.hostname, port: up.port || (up.protocol === "https:" ? 443 : 80), method: "POST",
    path: up.pathname.replace(/\/$/, "") + sub + url.search, headers }, upRes => {
    const status = upRes.statusCode, type = upRes.headers["content-type"] || "application/json";
    const h = { "content-type": type };
    if (upRes.headers["retry-after"]) h["retry-after"] = upRes.headers["retry-after"];
    res.writeHead(status, h);
    upRes.pipe(res);   // untouched, with backpressure; the copy below is only read
    const ok = status < 400;
    if (ok && /event-stream/i.test(type)) parser = sseUsage();
    let text = "";
    upRes.on("data", chunk => {
      if (parser) { parser.push(chunk); if (parser.stopped) meterOnce(parser.usage); }
      else if (text.length < (ok ? 4e6 : 2000)) text += chunk;
    });
    upRes.on("end", () => {
      if (!ok) return upstreamError(status, text, key);
      if (parser) meterOnce(parser.end());
      else { try { meterOnce(JSON.parse(text).usage); } catch {} }
    });
    upRes.on("error", () => { meterOnce(parser?.usage); res.destroy(); });   // DeepSeek dropped the stream: Claude Code retries
  });
  upReq.on("error", e => {
    if (res.writableEnded || res.destroyed) return;   // we cut it off ourselves (Stop)
    log("deepseek network error", scrub(e?.message, key).slice(0, 200));
    if (!res.headersSent) errJson(res, 502, "api_error", "Pocket Agent couldn't reach DeepSeek: " + scrub(e?.message, key).slice(0, 200));
    else res.destroy();
  });
  // Claude Code stopped (Stop, or the chat closed): stop DeepSeek's work too, and count what it had done.
  res.on("close", () => { if (!res.writableEnded) { upReq.destroy(); meterOnce(parser?.usage); } });
  upReq.end(body);
}

function upstreamError(status, text, key) {
  log("deepseek", status, scrub(text, key).replace(/\s+/g, " ").slice(0, 300));
  if (status === 402) {   // out of credit: say so now, and fetch the real balance shortly
    cache.deepseekBalance = { ...(cache.deepseekBalance || { currency: "USD", total: null, granted: null, toppedUp: null }), available: false, at: Date.now() };
    saveCache(); push();
    setTimeout(() => balance({ refresh: true }).catch(() => {}), Math.max(1000, 10e3 - (Date.now() - lastFetch))).unref();
  } else if (status === 401) { state.balanceError = "DeepSeek didn't accept the saved key."; push(); }
}
