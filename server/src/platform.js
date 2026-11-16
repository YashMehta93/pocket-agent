// Platform differences in one place, so the rest of the server reads the same everywhere.
// POSIX (the app's built-in Linux, Termux, Linux, macOS) behaves exactly as before. Windows is a computer running
// the server as a normal user: no admin rights, no symlinks without Developer Mode, no SIGUSR2, `npm` is a .cmd,
// and Git's GNU tar sits on PATH before Windows' own. Tests: server/test/platform.test.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const IS_WIN = process.platform === "win32";

/** A module's folder: moduleDir(import.meta.url). URL.pathname gives "/C:/…" on Windows, which resolves to C:\C:\…. */
export const moduleDir = url => path.dirname(fileURLToPath(url));

/** The folders on PATH, split the platform's way (";" on Windows, where paths contain ":"). */
export const pathDirs = (p = process.env.PATH || "") => p.split(path.delimiter).filter(Boolean);

/** The first of these files that exists and can run. */
export function firstRunnable(candidates) {
  return candidates.find(p => {
    try { if (IS_WIN) return fs.statSync(p).isFile(); fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
  });
}

/** Claude Code inside the VS Code extension (Anthropic-signed), newest version first. */
export function ideClaudes(home = os.homedir()) {
  const dir = path.join(home, ".vscode", "extensions");
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /^anthropic\.claude-code-\d+\.\d+\.\d+/.test(n)); } catch {}
  const ver = n => n.match(/(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number);
  names.sort((a, b) => { const x = ver(a), y = ver(b); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; });
  return names.map(n => path.join(dir, n, "resources", "native-binary", IS_WIN ? "claude.exe" : "claude"));
}

/** Where Claude Code lives on Windows: its own installer's folder, PATH, then the IDE extension's copy.
 *  Only .exe: the Agent SDK can't start an npm .cmd shim without a shell. */
export function windowsClaudeCandidates(home = os.homedir()) {
  return [path.join(home, ".local", "bin", "claude.exe"), ...pathDirs().map(d => path.join(d, "claude.exe")), ...ideClaudes(home)];
}

// ───── shell commands ─────
let winShell = null;
/** Windows: Git Bash's sh (the shell Claude Code's own Bash tool uses), else cmd.exe. PA_SHELL picks another. */
export function windowsShell() {
  if (winShell) return winShell;
  const fromEnv = process.env.PA_SHELL;
  if (fromEnv) return (winShell = { path: fromEnv, posix: !/^cmd(\.exe)?$/i.test(path.basename(fromEnv)) });
  // <Git>\bin\sh.exe sets up Git Bash properly; git.exe is in <Git>\cmd, <Git>\bin or <Git>\mingw64\bin.
  const gitRoots = pathDirs().filter(d => fs.existsSync(path.join(d, "git.exe")))
    .map(d => path.resolve(d, /mingw64[\\/]bin[\\/]?$/i.test(d) ? "../.." : ".."));
  const bashEnv = process.env.CLAUDE_CODE_GIT_BASH_PATH ? [path.join(path.dirname(process.env.CLAUDE_CODE_GIT_BASH_PATH), "sh.exe")] : [];
  const sh = firstRunnable([...bashEnv, ...gitRoots.map(r => path.join(r, "bin", "sh.exe")),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "sh.exe"), ...pathDirs().map(d => path.join(d, "sh.exe"))]);
  return (winShell = sh ? { path: sh, posix: true } : { path: process.env.ComSpec || "cmd.exe", posix: false });
}

/** Runs a command line in a shell. POSIX: /bin/sh -c, as before. Windows: windowsShell(), without a console window. */
export function shellSpawn(cmd, opts = {}) {
  if (!IS_WIN) return spawn("/bin/sh", ["-c", cmd], opts);
  const sh = windowsShell();
  return sh.posix ? spawn(sh.path, ["-c", cmd], { windowsHide: true, ...opts })
    : spawn(sh.path, ["/d", "/s", "/c", `"${cmd}"`], { windowsHide: true, windowsVerbatimArguments: true, ...opts });
}

/** A command and the arguments that go before its own. POSIX: unchanged. Windows: tar is Windows' own tar.exe
 *  (bsdtar reads C:\ paths; Git's GNU tar, often first on PATH, takes "C:" for a remote host), and npm runs as
 *  node npm-cli.js (npm.cmd can't be started without a shell). */
export function commandFor(name) {
  if (!IS_WIN) return [name, []];
  if (name === "tar") {
    const t = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(t)) return [t, []];
  }
  if (name === "npm") {
    const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(cli)) return [process.execPath, [cli]];
  }
  return [name, []];
}

// ───── processes ─────
/** Stops a process and what it started. POSIX: its process group (it was spawned detached), as before.
 *  Windows: taskkill /T. */
export function killTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  if (IS_WIN) {
    try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10_000 }); }
    catch { try { child.kill(); } catch {} }
    return;
  }
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
}

/** Is a process running? Where /proc exists (Linux, Android, proot) the old check; elsewhere signal 0,
 *  where EPERM means it runs but belongs to someone else. */
export function pidAlive(pid) {
  if (!pid) return false;
  if (!IS_WIN && fs.existsSync("/proc/self")) return fs.existsSync(`/proc/${pid}`);
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// ───── sharing ~/.claude items into another config folder (accounts.js, engines.js) ─────
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
/** Windows stand-in for fs.symlinkSync(target, link): a real symlink when Windows allows one (Developer Mode),
 *  else a junction for a folder or a copy of a file, neither of which needs admin. A copy is refreshed when the
 *  original is newer; anything else already at `link` is left alone. Returns "linked", "copied" or "kept". */
export function linkShared(target, link) {
  const dir = fs.statSync(target).isDirectory();
  let st = null; try { st = fs.lstatSync(link); } catch {}
  if (st?.isSymbolicLink()) {                     // Node reports junctions as links too
    try { if (samePath(fs.realpathSync(link), fs.realpathSync(target))) return "linked"; } catch {}
    fs.unlinkSync(link);
  } else if (st?.isFile() && !dir) {
    if (fs.statSync(target).mtimeMs > st.mtimeMs) fs.copyFileSync(target, link);
    return "copied";
  } else if (st) return "kept";
  try { fs.symlinkSync(target, link, dir ? "dir" : "file"); return "linked"; } catch {}
  if (dir) { fs.symlinkSync(target, link, "junction"); return "linked"; }
  fs.copyFileSync(target, link);
  return "copied";
}

// ───── restart once no chat is mid-reply ─────
// POSIX: SIGUSR2, which `pocket-agent restart --when-idle` also sends. Windows has no such signal, so the
// server registers its handler here and everything else asks through requestRestart().
export const RESTART_EXIT = 75;   // exit code that tells pocket-agent.mjs's supervisor "start me again now"
let onRestart = null;
export function onRestartRequest(fn) { onRestart = fn; if (!IS_WIN) process.on("SIGUSR2", () => fn()); }
export function requestRestart() {
  if (!IS_WIN) { process.kill(process.pid, "SIGUSR2"); return; }
  if (onRestart) setImmediate(onRestart);
}

// ───── is a path inside a root? (device scopes limited to folders) ─────
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;   // Windows device names, valid in any folder
const stripLong = p => p.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
/** The comparable form of a path: absolute and normalized, with links, junctions and (Windows) 8.3 short names
 *  resolved by realpath. A path that doesn't exist yet resolves through its nearest existing parent, so a file
 *  about to be made is judged by where it would land. Windows: no \\?\ prefix, lower case (NTFS ignores case).
 *  null when it can't be judged safely: a NUL byte, a Windows device name, or something that exists but won't
 *  resolve (a link pointing nowhere, a folder this user can't read). */
export function canonicalPath(p) {
  if (typeof p !== "string" || !p || p.includes("\0")) return null;
  let cur = path.resolve(IS_WIN ? stripLong(p) : p);
  if (IS_WIN && cur.split(/[\\/]/).some(s => RESERVED.test(s.replace(/[ .]+$/, "")))) return null;
  const rest = [];
  for (;;) {
    try { cur = fs.realpathSync.native(cur); break; }
    catch {
      try { fs.lstatSync(cur); return null; } catch {}   // it's there, but won't resolve
      const parent = path.dirname(cur);
      if (parent === cur) break;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
  const out = rest.length ? path.join(cur, ...rest) : cur;
  return IS_WIN ? stripLong(out).toLowerCase() : out;
}
/** True when `p` is `root` or inside it, compared as canonicalPath()s: "C:\work-other" isn't inside "C:\work",
 *  ".." can't climb out, and a link inside the root that points elsewhere counts as elsewhere. A guard for what
 *  a device may ask for; a chat inside the root can still reach anything its user can. */
export function withinRoot(p, root) {
  const a = canonicalPath(p), r = canonicalPath(root);
  if (!a || !r) return false;
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}
