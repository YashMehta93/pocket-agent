// WebSocket request handlers: { t: "<name>", id, ...args } -> reply { t: "reply", id, ...result | error }.
// See docs/PROTOCOL.md for the full message list. To add one: add a function here, document it there.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSessions, getSessionMessages, getSessionInfo, renameSession, deleteSession, forkSession } from "@anthropic-ai/claude-agent-sdk";
import { VERSION, HOME, UI_DIR, APK_INFO, DEFAULT_REPO, prefs, savePrefs, cache, githubRepo } from "./config.js";
import { broadcastAll, callNative } from "./hub.js";
import { live, getLive, openSession, busyElsewhere, runClaude, chatSettings, rememberChatSettings } from "./live-session.js";
import { listDir, searchFiles, readFile, saveUpload } from "./files.js";
import { importSessions, checkUpdate, applyUpdate, sourceName, pickRelease, listReleases, releaseAsset, bundleInfo } from "./transfer.js";
import { runDevSetup, devSetupStatus, devRepo } from "./devtools.js";
import { runMigration, migrationStatus } from "./migrate.js";
import { createBackup, listBackups, restoreBackup, BACKUP_DIR } from "./backup.js";
import { installCommand } from "./termux.js";

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
      updateChannel: prefs.updateChannel ? sourceName(prefs.updateChannel) : null,
      updateKind: prefs.updateChannel ? (prefs.updateChannel.github ? "github" : prefs.updateChannel.path ? "path" : "server") : null,
      githubToken: !!prefs.updateChannel?.token, defaultRepo: DEFAULT_REPO, mode: process.env.PA_MODE || "server", devRepo: devRepo(), updateTrack: prefs.updateTrack || { track: "stable" },
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
    return { sessionId, info: s ? s.info() : null, events: s ? s.buffer.filter(e => e.seq > after) : [], settings: chatSettings(sessionId) };
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
  async set(m) { const s = live.get(m.sessionId); if (s) await s.set(m); else rememberChatSettings(m.sessionId, m); return { info: s?.info(), settings: chatSettings(m.sessionId) }; },
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

  // ───── between servers (transfer.js) ─────
  /** Copy chats from another Pocket Agent server (e.g. Termux) into this one. */
  async "sessions.import"({ url, token }) { const r = await importSessions({ url, token }); changed(); return r; },
  /** Where this server gets code/UI updates from ({url, token}, or null to stop). */
  /** { url, token } of a server, { path } of a local Pocket Agent folder, or nothing to clear. */
  async "update.channel"({ url, token, path: p, github }) {
    prefs.updateChannel = github ? { github: githubRepo(github), token: token || "" }
      : p ? { path: p } : url ? { url: url.replace(/\/$/, ""), token } : null;
    savePrefs();
    return { channel: prefs.updateChannel ? sourceName(prefs.updateChannel) : null };
  },
  async "update.check"(m) { const ch = m.url || m.path || m.github ? m : prefs.updateChannel; if (!ch) return { available: false, channel: null }; return { ...(await checkUpdate(ch)), channel: sourceName(ch) }; },
  // ───── release tracks (GitHub releases): stable, beta, or one pinned version ─────
  async "releases.list"() {
    const ch = prefs.updateChannel;
    if (!ch?.github) throw new Error("Versions come from GitHub releases: set that as the update source first");
    const local = await bundleInfo();
    const releases = (await listReleases(ch)).map(r => ({ tag: r.tag_name, name: r.name, prerelease: !!r.prerelease,
      publishedAt: r.published_at, notes: String(r.body || "").slice(0, 2000) }));
    return { releases, track: prefs.updateTrack || { track: "stable" }, current: { version: local.version, build: local.build } };
  },
  async "update.track"({ track, tag }) {
    if (!["stable", "beta", "pin"].includes(track)) throw new Error("track is stable, beta or pin");
    if (track === "pin" && !tag) throw new Error("Pick a version to pin");
    prefs.updateTrack = track === "pin" ? { track, tag } : { track };
    delete prefs.notifiedRelease;   // tell about the new track's newest release again
    savePrefs();
    return { track: prefs.updateTrack };
  },
  /** Pulls the update, then restarts once no chat is mid-reply (SIGUSR2, see index.js). */
  async "update.apply"(m) { const ch = m.url || m.path || m.github ? m : prefs.updateChannel; if (!ch) throw new Error("No update source set"); return await applyUpdate(ch, () => process.kill(process.pid, "SIGUSR2")); },

  /** "Move from Termux": runs in the background; progress arrives as { t: "migrate", job } events. */
  async "migrate.run"({ url, token }) { return { job: runMigration({ url, token }) }; },
  async "migrate.status"() { return { job: migrationStatus() }; },

  /** "Build Pocket Agent yourself" (app built-in mode): progress arrives as { t: "devsetup", job } events. */
  async "dev.setup"({ repo, token }) { return { job: runDevSetup({ repo: repo || DEFAULT_REPO, token: token || prefs.updateChannel?.token || "" }) }; },
  async "dev.status"() { return { job: devSetupStatus() }; },
  // ───── backups to phone storage (backup.js) ─────
  async "backup.create"() { return await createBackup(); },
  async "backup.list"() { return { dir: BACKUP_DIR, backups: await listBackups() }; },
  async "backup.restore"({ file }) {
    const r = await restoreBackup(file);
    changed();
    setTimeout(() => process.kill(process.pid, "SIGUSR2"), 500);   // reload restored preferences: restart when idle
    return r;
  },
  // ───── Termux (termux.js) ─────
  async "termux.installCommand"() { return installCommand(); },

  // ───── the app itself ─────
  /** Version of the newest built APK, so the app can offer a one-tap update. */
  async "app.update"() {
    try { const info = JSON.parse(fs.readFileSync(APK_INFO, "utf8")); return { ...info, url: "/apk/download" }; }
    catch {}
    // No APK built here (the app's built-in server): ask the update source, and download from it directly.
    const ch = prefs.updateChannel;
    if (ch?.path) try { const info = JSON.parse(fs.readFileSync(path.join(ch.path, "build/pocket-agent.json"), "utf8")); return { ...info, url: "/apk/download" }; } catch {}
    if (ch?.github) try {
      const info = await (await releaseAsset(ch, await pickRelease(ch), "pocket-agent.json")).json();
      if (info.versionCode) return { ...info, url: "/apk/download" };
    } catch {}
    if (ch?.url) try {
      const r = await fetch(`${ch.url}/apk/info?token=${encodeURIComponent(ch.token || "")}`);
      if (r.ok) { const info = await r.json(); if (info.versionCode) return { ...info, url: `${ch.url}/apk/download?token=${encodeURIComponent(ch.token || "")}` }; }
    } catch {}
    return { versionCode: 0 };
  },
  /** Calls a native capability on the phone through the background service (for tools and tests). */
  async "native.call"({ method, params, timeoutMs }) { return { result: await callNative(method, params || {}, timeoutMs || 20000) }; },

  // ───── files ─────
  async "fs.list"({ path: p }) { return await listDir(p); },
  async "fs.search"({ cwd, q }) { return { results: await searchFiles(cwd || HOME, q) }; },
  async "fs.read"({ path: p }) { return await readFile(p); },
  async "fs.mkdir"({ path: p }) { await fs.promises.mkdir(p, { recursive: true }); return { path: p }; },
  async upload({ cwd, name, data }) { return { path: await saveUpload(cwd, name, data) }; },
};
