// Back up and restore to phone storage, so chats, memory and projects survive reinstalling the app
// (uninstalling wipes the app's built-in Linux, e.g. to switch to your own build; see CONTRIBUTING.md).
// A backup is one .tgz in /sdcard/Download/Pocket Agent. It never contains sign-in credentials or tokens:
// phone storage is readable by other apps with storage access.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { HOME, DATA, log } from "./config.js";
import { sh } from "./devtools.js";

export const BACKUP_DIR = process.env.PA_BACKUP_DIR || "/sdcard/Download/Pocket Agent";
// Relative to HOME: Claude Code's chats, memory, settings, skills and plugins; projects; app preferences.
const ITEMS = [".claude", ".claude.json", "projects", path.relative(HOME, path.join(DATA, "prefs.json"))];
const EXCLUDE = [".claude/.credentials.json", ".claude/shell-snapshots", ".claude/session-env", ".claude/cache",
  ".claude/downloads", ".config", "node_modules", ".cache",
  ".l2s.*",   // proot's stand-ins for hard links: the linked files are stored by content instead (-h)
  // Keys and credentials never go to shared storage, at any depth: the APK signing key and the release key
  // (back them up somewhere private, see docs/RELEASES.md), PEM/PKCS12 files, Claude logins, git credentials.
  "*.keystore", "*.jks", "*.p12", "*.pem", ".credentials.json", ".git-credentials"];
const NAME = /^pocket-agent-backup-[\w-]+\.tgz$/;

const sizeOf = f => { try { return fs.statSync(f).size; } catch { return 0; } };
const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

export async function createBackup() {
  try { await fsp.mkdir(BACKUP_DIR, { recursive: true }); await fsp.access(BACKUP_DIR, fs.constants.W_OK); }
  catch { throw new Error("Pocket Agent can't write to phone storage yet. Allow storage access, then try again."); }
  const items = ITEMS.filter(i => !i.startsWith("..") && fs.existsSync(path.join(HOME, i)));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const file = path.join(BACKUP_DIR, `pocket-agent-backup-${stamp}.tgz`), tmp = file + ".part";
  const ex = EXCLUDE.map(e => `--exclude=${quote(e)}`).join(" ");
  // -h stores files by content (proot turns hard links, e.g. in .git, into symlinks to .l2s.* files);
  // --ignore-failed-read skips leftovers that can't be read (e.g. a broken temp file) instead of failing.
  // GNU tar exits 1 when files changed while reading (live chats): still a good backup. 2 is a real failure.
  try { await sh(`tar czhf ${quote(tmp)} --ignore-failed-read --warning=no-file-changed ${ex} -C ${quote(HOME)} ${items.map(quote).join(" ")} 2>/dev/null; c=$?; [ $c -le 1 ] && [ -s ${quote(tmp)} ]`); }
  catch (e) { await fsp.rm(tmp, { force: true }); throw e; }
  await fsp.rename(tmp, file);
  log("backup", file, sizeOf(file));
  return { file, bytes: sizeOf(file) };
}

export async function listBackups() {
  let names = [];
  try { names = (await fsp.readdir(BACKUP_DIR)).filter(n => NAME.test(n)); } catch {}
  return names.map(name => { const file = path.join(BACKUP_DIR, name); return { file, name, bytes: sizeOf(file), at: fs.statSync(file).mtimeMs }; })
    .sort((a, b) => b.at - a.at);
}

/** Unpacks a backup over this home (files in it replace the ones here; nothing else is deleted). */
export async function restoreBackup(file) {
  if (path.dirname(path.resolve(file)) !== path.resolve(BACKUP_DIR) || !NAME.test(path.basename(file))) throw new Error("Not a Pocket Agent backup");
  // Refuse archives with absolute or parent paths before unpacking anything.
  const list = await sh(`tar tzf ${quote(file)}`);
  if (list.split("\n").some(l => l.startsWith("/") || l.split("/").includes(".."))) throw new Error("That backup contains unsafe paths");
  await sh(`tar xzf ${quote(file)} -C ${quote(HOME)}`);
  log("restored backup", file);
  return { restored: true };
}
