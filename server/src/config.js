// Configuration, persistent state files and small shared helpers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/** App version, from ./VERSION (repo or install root), or the copy bundled inside the app. */
export const VERSION = (() => {
  for (const rel of ["../../VERSION", "../VERSION"]) { try { return fs.readFileSync(new URL(rel, import.meta.url), "utf8").trim(); } catch {} }
  return "0.0.0";
})();
export const HOME = os.homedir();
export const DATA = process.env.PA_DATA || path.join(HOME, ".pocket-agent");   // token, prefs, cache, logs
export const CLAUDE_DIR = path.join(HOME, ".claude");                          // Claude Code's own state

const args = parseArgs(process.argv.slice(2));
export const PORT = +(args.port || process.env.PA_PORT || 8765);
export const HOST = args.host || process.env.PA_HOST || "127.0.0.1";
/** The `claude` executable the Agent SDK spawns (in Termux: the proot launcher). */
export const CLAUDE = args.claude || process.env.PA_CLAUDE || findClaude();
function findClaude() {
  // The app passes --claude; otherwise look where Claude Code usually lives (app Linux, Termux, PATH).
  const candidates = [path.join(os.homedir(), ".local/bin/claude"), "/data/data/com.termux/files/usr/bin/claude"];
  for (const dir of (process.env.PATH || "").split(":")) if (dir) candidates.push(path.join(dir, "claude"));
  return candidates.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || "claude";
}
/** Directory with the chat UI; served at /ui/ so UI changes reach the app without a reinstall. */
export const UI_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../app/assets/ui");
/** Latest APK and its version info (written by build.sh), offered to the app as an in-app update. */
export const APK_PATH = process.env.PA_APK || path.resolve(UI_DIR, "../../../build/pocket-agent.apk");
export const APK_INFO = APK_PATH.replace(/\.apk$/, ".json");

/** GitHub repo ("owner/name") whose releases fresh installs update from; from server/package.json. */
export const DEFAULT_REPO = (() => { try { return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).pocketAgent?.githubRepo || ""; } catch { return ""; } })();

export const IDLE_CLOSE_MS = 20 * 60 * 1000;  // close an idle, unwatched session process after 20 min
export const BUFFER_MAX = 4000;               // events kept per live session so reconnecting clients catch up

fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });

export const TOKEN = loadToken();
export const prefs = loadJSON("prefs.json", { pinned: [], defaults: {} });
export const cache = loadJSON("cache.json", { commands: [], models: [], account: null });
export const savePrefs = () => saveJSON("prefs.json", prefs);
export const saveCache = () => saveJSON("cache.json", cache);

function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) o[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true;
  return o;
}
function loadJSON(name, dflt) { try { return { ...dflt, ...JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8")) }; } catch { return dflt; } }
function saveJSON(name, v) { fs.writeFileSync(path.join(DATA, name), JSON.stringify(v, null, 2), { mode: 0o600 }); }

/** Shared secret with the app. `--token` (sent by the app when it starts the server) replaces the stored one. */
function loadToken() {
  const f = path.join(DATA, "token");
  if (typeof args.token === "string" && args.token.length >= 16) { fs.writeFileSync(f, args.token, { mode: 0o600 }); return args.token; }
  try { const t = fs.readFileSync(f, "utf8").trim(); if (t) return t; } catch {}
  const t = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}

export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const safeEq = (a, b) => typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
