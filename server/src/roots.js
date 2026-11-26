// Folder roots for paired devices (#72): the machine that pairs a device may limit it to folders. The device then
// sees and reaches only chats whose folder is inside a root, and only files inside a root; everything else answers
// "not found", so it can't learn what exists outside. The owner and a device without roots are untouched.
// Paths are compared only with canonicalPath()/withinRoot() (platform.js). See docs/PROTOCOL.md, "Devices".
import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { live } from "./live-session.js";
import { setEventFilter } from "./hub.js";
import { canonicalPath, withinRoot } from "./platform.js";

const CACHE_MAX = 500;   // chats whose folder we remember, at most
const folderCache = new Map();   // sessionId -> canonical folder; a live session's cwd wins over it
// Messages that can start a chat: a missing cwd for one of these would land in this server's default folder.
const CHAT_STARTING = new Set(["send", "session.open"]);

/** A device's roots, or null when it has none (and for the owner, who is never limited). */
export function rootsOf(principal) {
  return principal?.kind === "device" && Array.isArray(principal.roots) && principal.roots.length ? principal.roots : null;
}

/** True when p is a string inside one of the roots, compared as canonical paths. */
export function withinAnyRoot(roots, p) {
  return typeof p === "string" && roots.some(r => withinRoot(p, r));
}

function remember(sessionId, folder) {
  if (typeof folder !== "string") return;
  folderCache.delete(sessionId);
  folderCache.set(sessionId, folder);
  if (folderCache.size > CACHE_MAX) folderCache.delete(folderCache.keys().next().value);
}

/** The chat's canonical folder for the event filter, sync: the live session's cwd, else the gate's cache. */
function knownFolder(sessionId) {
  const cwd = live.get(sessionId)?.cwd;
  if (typeof cwd === "string") return canonicalPath(cwd);
  return folderCache.has(sessionId) ? folderCache.get(sessionId) : undefined;
}

/** undefined = no such chat; null = it exists but its folder can't be judged; else its canonical folder. */
async function chatFolder(sessionId) {
  const cwd = live.get(sessionId)?.cwd;
  if (typeof cwd === "string") { const folder = canonicalPath(cwd); remember(sessionId, folder); return folder; }
  if (folderCache.has(sessionId)) return folderCache.get(sessionId);
  const info = await getSessionInfo(sessionId).catch(() => undefined);
  if (!info) return undefined;
  const folder = canonicalPath(info.cwd);
  remember(sessionId, folder);
  return folder;
}

const notFound = error => ({ error, code: "not_found" });
const noChat = () => notFound("No such chat");
const noFolder = () => notFound("No such folder");

/**
 * The one gate (http.js, after allowed() and before forwardIfRemote and the handler): null lets the message
 * through; a reply object is sent instead. A chat or folder outside the roots looks like one that isn't there.
 */
export async function rootsGate(principal, m) {
  const roots = rootsOf(principal);
  if (!roots || !m || typeof m !== "object") return null;
  // A chat is judged by its own folder: the live session's cwd, else the transcript on disk. One that doesn't
  // exist yet (a new chat) is judged by where it would start.
  if (typeof m.sessionId === "string") {
    const folder = await chatFolder(m.sessionId);
    if (folder !== undefined) {
      if (folder === null || !withinAnyRoot(roots, folder)) return noChat();
    } else if (typeof m.cwd === "string") {
      if (!withinAnyRoot(roots, m.cwd)) return noFolder();
    } else if (CHAT_STARTING.has(m.t)) {
      return noFolder();   // it would start in this server's default folder
    } else {
      // Not something that starts a chat: answer exactly as an existing chat outside the roots does, so the
      // device can't tell a hidden chat from an id that never existed.
      return noChat();
    }
  } else if (CHAT_STARTING.has(m.t) && typeof m.cwd !== "string") {
    return noFolder();
  }
  // Every folder a message names must be inside a root; a missing one that would fall back to HOME is refused.
  if (typeof m.path === "string") { if (!withinAnyRoot(roots, m.path)) return noFolder(); }
  else if (m.t === "fs.list") return noFolder();
  if (typeof m.cwd === "string") { if (!withinAnyRoot(roots, m.cwd)) return noFolder(); }
  else if (m.t === "fs.search" || m.t === "upload") return noFolder();
  if (typeof m.dir === "string" && !withinAnyRoot(roots, m.dir)) return noFolder();
  return null;
}

// ───── events ─────
/** Fields that would show another chat: a message without a sessionId that carries any of them is dropped. */
const CHAT_DETAILS = ["title", "cwd", "parent", "child", "parentSessionId", "childSessionId", "sessions", "info"];
const carriesChatDetails = msg => CHAT_DETAILS.some(k => msg[k] != null);

/** Registered with hub.js (which must not import live-session.js): may this device see this event? */
function deviceMaySee(principal, msg) {
  const roots = rootsOf(principal);
  if (!roots) return true;
  if (typeof msg.sessionId === "string") {
    const folder = knownFolder(msg.sessionId);
    return typeof folder === "string" && withinAnyRoot(roots, folder);   // unknown: don't send
  }
  return !carriesChatDetails(msg);   // e.g. sessions.changed: a refresh, with no chat details
}
setEventFilter(deviceMaySee);
