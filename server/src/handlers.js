// WebSocket request handlers: { t: "<name>", id, ...args } -> reply { t: "reply", id, ...result | error }.
// See docs/PROTOCOL.md for the full message list. To add one: add a function here, document it there.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSessions, getSessionMessages, getSessionInfo, renameSession, deleteSession, forkSession } from "@anthropic-ai/claude-agent-sdk";
import { VERSION, HOME, UI_DIR, prefs, savePrefs, cache } from "./config.js";
import { broadcastAll } from "./hub.js";
import { live, getLive, openSession, busyElsewhere, runClaude } from "./live-session.js";
import { listDir, searchFiles, readFile, saveUpload } from "./files.js";

const changed = () => broadcastAll({ t: "sessions.changed" });

/** Changes whenever a UI file changes, so open apps can reload themselves. */
export function uiVersion() {
  let max = 0;
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else max = Math.max(max, fs.statSync(p).mtimeMs); } };
  try { walk(UI_DIR); } catch {}
  return String(Math.floor(max));
}

export const handlers = {
  // ───── connection ─────
  async hello() {
    return { version: VERSION, uiVersion: uiVersion(), home: HOME, host: os.hostname(), platform: process.platform,
      defaults: prefs.defaults, pinned: prefs.pinned, commands: cache.commands, models: cache.models, account: cache.account,
      live: [...live.values()].map(s => s.info()) };
  },

  // ───── session list & history ─────
  async "sessions.list"({ limit = 300, dir } = {}) {
    const list = await listSessions({ limit, ...(dir ? { dir } : {}) });
    const busy = busyElsewhere();
    return { sessions: list.map(s => ({
      sessionId: s.sessionId, title: s.customTitle || s.summary, firstPrompt: s.firstPrompt, cwd: s.cwd,
      lastModified: s.lastModified, createdAt: s.createdAt, gitBranch: s.gitBranch, tag: s.tag,
      custom: !!s.customTitle, pinned: prefs.pinned.includes(s.sessionId),
      live: live.get(s.sessionId)?.state || null, elsewhere: busy.get(s.sessionId)?.kind || null,
    })) };
  },
  async "session.history"({ sessionId }) {
    const [messages, info] = await Promise.all([getSessionMessages(sessionId), getSessionInfo(sessionId).catch(() => undefined)]);
    return { sessionId, messages, info };
  },

  // ───── live sessions ─────
  async "session.open"(m, ws) { const s = await openSession(m); ws.subs.add(s.sessionId); return { sessionId: s.sessionId, info: s.info() }; },
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
  async set(m) { const s = live.get(m.sessionId); if (s) await s.set(m); return { info: s?.info() }; },
  async "session.rewindFiles"({ sessionId, userMessageId, dryRun }) { return { result: await getLive(sessionId).q.rewindFiles(userMessageId, { dryRun: !!dryRun }) }; },
  async "session.context"({ sessionId }) { return { usage: await getLive(sessionId).q.getContextUsage() }; },
  async "session.stopTask"({ sessionId, taskId }) { await getLive(sessionId).q.stopTask(taskId); return {}; },

  // ───── session management ─────
  async "session.rename"({ sessionId, title }) { await renameSession(sessionId, title); const s = live.get(sessionId); if (s) s.title = title; changed(); return {}; },
  async "session.delete"({ sessionId }) {
    live.get(sessionId)?.close();
    await deleteSession(sessionId);
    prefs.pinned = prefs.pinned.filter(x => x !== sessionId); savePrefs();
    changed(); return {};
  },
  async "session.pin"({ sessionId, pinned }) {
    prefs.pinned = prefs.pinned.filter(x => x !== sessionId);
    if (pinned) prefs.pinned.unshift(sessionId);
    savePrefs(); changed(); return { pinned: prefs.pinned };
  },
  async "session.fork"({ sessionId, upToMessageId, title }) { const r = await forkSession(sessionId, { upToMessageId, title }); changed(); return { sessionId: r.sessionId }; },
  /** Resolve BUSY_ELSEWHERE: mode "fork" continues in a copy, "stop" stops the Termux background copy first. */
  async "session.continueHere"({ sessionId, mode }) {
    if (mode === "fork") { const r = await forkSession(sessionId); changed(); return { sessionId: r.sessionId }; }
    if (mode !== "stop") throw new Error("unknown mode");
    const busy = busyElsewhere().get(sessionId);
    if (busy?.kind === "terminal") throw new Error("That chat is open in a Termux terminal. Close it there (type /exit), then try again.");
    if (busy) {
      const r = await runClaude(["stop", busy.short]);
      for (let i = 0; i < 20 && busyElsewhere().has(sessionId); i++) await new Promise(res => setTimeout(res, 300));
      if (busyElsewhere().has(sessionId)) throw new Error("Couldn't stop it: " + r.out.trim().slice(0, 200));
    }
    return { sessionId };
  },
  async "defaults.set"({ defaults }) { prefs.defaults = { ...prefs.defaults, ...defaults }; savePrefs(); return { defaults: prefs.defaults }; },

  // ───── files ─────
  async "fs.list"({ path: p }) { return await listDir(p); },
  async "fs.search"({ cwd, q }) { return { results: await searchFiles(cwd || HOME, q) }; },
  async "fs.read"({ path: p }) { return await readFile(p); },
  async "fs.mkdir"({ path: p }) { await fs.promises.mkdir(p, { recursive: true }); return { path: p }; },
  async upload({ cwd, name, data }) { return { path: await saveUpload(cwd, name, data) }; },
};
