// Paired devices: another phone, a hub or a computer can use this server with its own token, each with
// scopes and revocable at any time. Only a SHA-256 hash of each token is kept on disk. Pairing codes are
// one-time, live in memory, and turn into a device token when redeemed. See docs/PROTOCOL.md, "Devices".
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA, TOKEN, safeEq } from "./config.js";
import { clients } from "./hub.js";
import { canonicalPath } from "./platform.js";

export const SCOPES = ["chat", "files.read", "files.write", "workers", "export.sessions", "update.source", "sync.pair"];
export const DEFAULT_SCOPES = ["chat", "files.read", "files.write", "workers"];

/** What each WebSocket message needs: null = any signed-in caller, a scope = a device needs it,
 *  a missing key = the owner only. Every key must be a real handler (server/src/handlers.js). */
export const SCOPE_OF = {
  hello: null,                       // hello itself trims what a device sees (handlers.js)
  "sessions.list": "chat",
  "session.history": "chat",
  "session.open": "chat",
  "session.context": "chat",
  subscribe: "chat",
  unsubscribe: "chat",
  send: "chat",
  interrupt: "chat",
  "permission.reply": "chat",        // approvals and answers to Claude's questions
  "session.rename": "chat",
  "session.pin": "chat",
  "session.fork": "chat",
  "session.close": "chat",
  "fs.list": "files.read",
  "fs.search": "files.read",
  "fs.read": "files.read",
  "fs.mkdir": "files.write",
  upload: "files.write",
  "workers.stopAll": "workers",       // stop the background workers a chat started (#66)
};

const FILE = path.join(DATA, "devices.json");
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no 0/O, 1/I/L: easy to read aloud
const PAIR_TTL_MS = 10 * 60 * 1000;
const LOCK_WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;
const LOCK_AFTER = 20;   // more failed redeems than this within the window locks redeeming
const MAX_TRIES = 5;     // failed redeems while any code is active invalidate every active code
const MAX_ROOTS = 16;    // folders a device may be limited to

let devices = load();
let lastSeenSave = 0;                   // lastSeenAt is written at most once a minute
const pairings = new Map();             // normalized code -> { scopes, name, expiresAt, tries }
let failures = [];                      // failed redeem timestamps, within LOCK_WINDOW_MS
let lockedUntil = 0;
let failedWhileActive = 0;              // failed redeems since the last code was made

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (Array.isArray(data.devices)) return data.devices.filter(d => d && typeof d.id === "string" && typeof d.hash === "string");
  } catch {}
  return [];
}
function save() {
  fs.writeFileSync(FILE, JSON.stringify({ devices }, null, 2), { mode: 0o600 });
}
const hashToken = token => crypto.createHash("sha256").update(token).digest("hex");
const publicDevice = d => ({ id: d.id, name: d.name, scopes: [...d.scopes], roots: [...(d.roots || [])], createdAt: d.createdAt, lastSeenAt: d.lastSeenAt });

/** The folder roots of a request: each an existing folder, stored as given (never canonicalized: a link's target
 *  can change). [] (or nothing) means no limit. at most 16. Same check for pairing and for changing them later. */
export function checkRoots(roots) {
  if (roots == null) return [];
  if (!Array.isArray(roots)) throw new Error("Folders must be a list");
  if (roots.length > MAX_ROOTS) throw new Error(`At most ${MAX_ROOTS} folders`);
  return roots.map(r => {
    const given = typeof r === "string" ? r : "";
    const canonical = given.trim() ? canonicalPath(given) : null;
    let folder = false;
    if (canonical) { try { folder = fs.statSync(canonical).isDirectory(); } catch {} }
    if (!folder) throw new Error(`That folder doesn't exist: ${typeof r === "string" ? r : String(r)}`);
    return given;
  });
}

/** The owner, a paired device, or nobody. Also records when a device was last seen (saved at most once a minute). */
export function authenticate(token) {
  if (typeof token !== "string" || !token) return null;
  if (safeEq(token, TOKEN)) return { kind: "owner" };
  const hash = hashToken(token);
  for (const d of devices) {
    if (!safeEq(hash, d.hash)) continue;
    const now = Date.now();
    d.lastSeenAt = now;
    if (now - lastSeenSave >= 60_000) { lastSeenSave = now; save(); }
    return { kind: "device", id: d.id, name: d.name, scopes: [...d.scopes], roots: [...(d.roots || [])] };
  }
  return null;
}

/** Every paired device, without its hash. */
export function listDevices() { return devices.map(publicDevice); }

/** Removes the device, saves, and closes its open WebSockets (code 4001). */
export function revokeDevice(id) {
  const i = devices.findIndex(d => d.id === id);
  if (i < 0) throw new Error("No such device");
  const [d] = devices.splice(i, 1);
  save();
  for (const ws of clients) if (ws.principal?.id === d.id) ws.close(4001, "revoked");
  return publicDevice(d);
}

/** Renames a device: trimmed, 1–40 characters. */
export function renameDevice(id, name) {
  const d = devices.find(x => x.id === id);
  if (!d) throw new Error("No such device");
  const n = typeof name === "string" ? name.trim() : "";
  if (n.length < 1 || n.length > 40) throw new Error("Give it a name of 1–40 characters");
  d.name = n;
  save();
  return publicDevice(d);
}

/** Limits a device to folders from now on ([] removes the limit). Only the owner may call this (handlers.js). */
export function setDeviceRoots(id, roots) {
  const d = devices.find(x => x.id === id);
  if (!d) throw new Error("No such device");
  d.roots = checkRoots(roots);
  save();
  // Its open sockets take the new limit at once: the principal holds the roots the gate and the event filter read.
  for (const ws of clients) if (ws.principal?.kind === "device" && ws.principal.id === d.id) ws.principal.roots = [...d.roots];
  return publicDevice(d);
}

/** A one-use code for a new device: { code: "XXXX-XXXX", expiresAt, environment: this server's id or null, roots }. */
export async function startPairing({ name, scopes = DEFAULT_SCOPES, roots, ttlMs = PAIR_TTL_MS } = {}) {
  const list = Array.isArray(scopes) ? [...new Set(scopes.map(s => String(s).trim()))] : null;
  if (!list || !list.length || list.some(s => !SCOPES.includes(s))) throw new Error(`Scopes must be one or more of: ${SCOPES.join(", ")}`);
  const rootList = checkRoots(roots);
  const clean = typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : null;
  const now = Date.now();
  let code;
  do { code = pairCode(); } while (pairings.has(code));
  const expiresAt = now + Math.max(1, Number(ttlMs) || PAIR_TTL_MS);
  pairings.set(code, { scopes: list, name: clean, roots: rootList, expiresAt, tries: 0 });
  failedWhileActive = 0;
  let environmentId = null;
  // environment.js may not exist (an older install): the code still works, without the server's id.
  try { const env = await import("./environment.js"); environmentId = env.environment().id; } catch {}
  return { code: code.slice(0, 4) + "-" + code.slice(4), expiresAt, environment: environmentId, roots: [...rootList] };
}

/** Exchanges a code for a new device token. Codes are one use; wrong and expired codes count against the lock. */
export function redeem(code, name) {
  const now = Date.now();
  if (lockedUntil) {
    if (now < lockedUntil) throw lockedError();
    lockedUntil = 0; failures = [];
  }
  const key = normalizeCode(code);
  const p = key ? pairings.get(key) : null;
  if (p && p.expiresAt > now) {
    pairings.delete(key);   // single use
    const clean = typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : (p.name || "Device");
    return createDevice(clean, p.scopes, p.roots);
  }
  if (p) pairings.delete(key);   // an expired code is no better than an unknown one
  fail();
  throw new Error("That code is wrong or has expired");
}

/** Whether this caller may send that WebSocket message: the owner always; a device when it holds the scope. */
export function allowed(principal, type) {
  if (principal?.kind === "owner") return true;
  if (principal?.kind !== "device") return false;
  const need = SCOPE_OF[type];
  if (need === null) return true;
  return typeof need === "string" && principal.scopes.includes(need);
}

function pairCode() {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}
const normalizeCode = code => String(code || "").toUpperCase().replace(/[-\s]/g, "");
function lockedError() { const e = new Error("Too many wrong codes. Try again later."); e.code = "locked"; return e; }

function fail() {
  const now = Date.now();
  failures = failures.filter(t => now - t < LOCK_WINDOW_MS);
  failures.push(now);
  failedWhileActive++;
  if (failures.length > LOCK_AFTER) lockedUntil = now + LOCK_MS;
  // nobody can guess their way past a live code: after a few wrong tries, every active code is dropped
  for (const [k, p] of pairings) if (p.expiresAt <= now) pairings.delete(k);
  if (pairings.size && failedWhileActive >= MAX_TRIES) pairings.clear();
}

function createDevice(name, scopes, roots) {
  const token = "pad_" + crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const d = { id: "dev-" + crypto.randomBytes(4).toString("hex"), name: name || "Device", scopes: [...scopes], roots: [...(roots || [])], hash: hashToken(token), createdAt: now, lastSeenAt: now };
  devices.push(d);
  save();
  return { token, device: publicDevice(d) };
}
