// platform.js on every platform, and the server running under pocket-agent.mjs (start, restart when idle,
// stop). A throwaway HOME and PA_DATA, nothing beyond 127.0.0.1, no Claude. Runs on Linux and on Windows
// (CI: the tests and windows jobs).   node server/test/platform.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { IS_WIN, moduleDir, pathDirs, firstRunnable, ideClaudes, shellSpawn, commandFor, killTree, pidAlive, linkShared, canonicalPath, withinRoot } from "../src/platform.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "pa-platform-"));
let fails = 0;
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { for (let t = 0; t < ms; t += 250) { if (await fn()) return true; await sleep(250); } return false; };
const run = child => new Promise(r => { let out = ""; child.stdout?.on("data", d => out += d); child.on("close", code => r({ code, out })); });
const node = process.execPath.replace(/\\/g, "/");   // a path both sh and cmd.exe can run
let stopServer = () => {};   // set once the server test starts, so a failure never leaves it running

try {
  // ───── paths ─────
  ok("moduleDir is this file's folder", moduleDir(import.meta.url) === HERE && fs.existsSync(path.join(HERE, "platform.test.mjs")), moduleDir(import.meta.url));
  const sample = IS_WIN ? ["C:\\a b", "D:\\c"] : ["/a b", "/c"];
  ok("pathDirs splits PATH the platform's way", JSON.stringify(pathDirs([sample[0], "", sample[1]].join(path.delimiter))) === JSON.stringify(sample));
  const tool = path.join(T, IS_WIN ? "tool.exe" : "tool");
  fs.writeFileSync(tool, ""); if (!IS_WIN) fs.chmodSync(tool, 0o755);
  ok("firstRunnable skips what's missing", firstRunnable([path.join(T, "missing"), tool]) === tool);
  const ext = path.join(T, "home", ".vscode", "extensions");
  for (const n of ["anthropic.claude-code-2.1.9-x", "anthropic.claude-code-2.1.10-x", "someone.else-1.0.0"]) fs.mkdirSync(path.join(ext, n), { recursive: true });
  const ide = ideClaudes(path.join(T, "home"));
  ok("ideClaudes lists the IDE's Claude Code, newest first", ide.length === 2 && ide[0].includes("2.1.10"), ide.map(p => path.relative(ext, p)).join(", "));

  // ───── commands ─────
  const echo = await run(shellSpawn("echo hi", { stdio: ["ignore", "pipe", "ignore"] }));
  ok("shellSpawn runs a command line", echo.code === 0 && echo.out.trim() === "hi", JSON.stringify(echo.out.trim()));
  const [tar, pre] = commandFor("tar");
  const src = path.join(T, "tar src"), dst = path.join(T, "tar out"), tgz = path.join(T, "x.tgz");
  fs.mkdirSync(src); fs.mkdirSync(dst); fs.writeFileSync(path.join(src, "a.txt"), "tar ok");
  execFileSync(tar, [...pre, "czf", tgz, "-C", src, "a.txt"], { windowsHide: true });
  execFileSync(tar, [...pre, "xzf", tgz, "-C", dst], { windowsHide: true });
  ok("tar packs and unpacks with this platform's paths", fs.readFileSync(path.join(dst, "a.txt"), "utf8") === "tar ok", tar);

  // ───── processes ─────
  ok("pidAlive: this process", pidAlive(process.pid));
  const gone = shellSpawn(`"${node}" -e ""`, { stdio: "ignore" }); await run(gone);
  ok("pidAlive: a process that ended", !pidAlive(gone.pid));
  // A shell that starts a node that never ends: killTree must stop both.
  const tree = shellSpawn(`"${node}" -e "console.log(process.pid); setInterval(() => {}, 1000)"; true`, { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let grand = 0; tree.stdout.on("data", d => { grand ||= +String(d).trim(); });
  await until(() => grand > 0, 10000);
  ok("a shell and its child are running", pidAlive(tree.pid) && pidAlive(grand), `${tree.pid} → ${grand}`);
  killTree(tree);
  ok("killTree stops the shell and what it started", await until(() => !pidAlive(tree.pid) && !pidAlive(grand), 10000));

  // ───── sharing ~/.claude items (accounts.js, engines.js) ─────
  const claude = path.join(T, "claude"), acct = path.join(T, "accounts", "work-1");
  fs.mkdirSync(path.join(claude, "projects"), { recursive: true }); fs.mkdirSync(acct, { recursive: true });
  fs.writeFileSync(path.join(claude, "projects", "chat.jsonl"), "keep me");
  fs.writeFileSync(path.join(claude, "CLAUDE.md"), "v1");
  const share = (target, link) => IS_WIN ? linkShared(target, link) : (fs.symlinkSync(target, link), "linked");
  const d = share(path.join(claude, "projects"), path.join(acct, "projects"));
  ok("a folder is shared", d === "linked" && fs.existsSync(path.join(acct, "projects", "chat.jsonl")), d);
  const f = share(path.join(claude, "CLAUDE.md"), path.join(acct, "CLAUDE.md"));
  ok("a file is shared", ["linked", "copied"].includes(f) && fs.readFileSync(path.join(acct, "CLAUDE.md"), "utf8") === "v1", f);
  if (IS_WIN) {
    ok("sharing again keeps what's there", linkShared(path.join(claude, "projects"), path.join(acct, "projects")) === "linked");
    fs.writeFileSync(path.join(claude, "CLAUDE.md"), "v2");
    const later = new Date(Date.now() + 10_000); fs.utimesSync(path.join(claude, "CLAUDE.md"), later, later);
    linkShared(path.join(claude, "CLAUDE.md"), path.join(acct, "CLAUDE.md"));
    ok("a shared file follows its original", fs.readFileSync(path.join(acct, "CLAUDE.md"), "utf8") === "v2");
  }
  fs.rmSync(acct, { recursive: true, force: true });   // what removeAccount does
  ok("removing an account folder leaves what it shared alone", !fs.existsSync(acct) && fs.readFileSync(path.join(claude, "projects", "chat.jsonl"), "utf8") === "keep me");

  // ───── roots: what a device limited to some folders may reach ─────
  const R = path.join(T, "roots"), work = path.join(R, "work"), outside = path.join(R, "outside");
  fs.mkdirSync(path.join(work, "a"), { recursive: true }); fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(work, "a", "b.txt"), "in"); fs.writeFileSync(path.join(outside, "secret.txt"), "out");
  const inside = (p, root = work) => withinRoot(p, root);
  ok("roots: a file inside", inside(path.join(work, "a", "b.txt")));
  ok("roots: the root itself", inside(work));
  ok("roots: a file not made yet, inside", inside(path.join(work, "new", "file.txt")));
  ok("roots: a sibling with the same start is outside", !inside(path.join(R, "work-other", "x")));
  ok("roots: '..' can't climb out", !inside(path.join(work, "..", "outside", "secret.txt")));
  ok("roots: a path elsewhere is outside", !inside(path.join(outside, "secret.txt")));
  const linkDir = (target, at) => fs.symlinkSync(target, at, IS_WIN ? "junction" : "dir");
  linkDir(outside, path.join(work, "door"));
  ok("roots: a link inside that points outside is outside", !inside(path.join(work, "door", "secret.txt")));
  linkDir(path.join(R, "missing"), path.join(work, "dangling"));
  ok("roots: a link that points nowhere is refused", !inside(path.join(work, "dangling", "x.txt")) && canonicalPath(path.join(work, "dangling")) === null);
  ok("roots: a NUL byte is refused", !inside(path.join(work, "a\0b")));
  if (IS_WIN) {
    ok("roots: case and slashes don't matter", inside(work.toUpperCase().replace(/\\/g, "/") + "/A/B.TXT"));
    ok("roots: a \\\\?\\ prefix doesn't matter", inside("\\\\?\\" + path.join(work, "a", "b.txt")));
    // os.tmpdir() is usually an 8.3 short path on Windows (C:\Users\RUNNER~1\…): compare it with its long form
    const long = fs.realpathSync.native(work);
    ok("roots: an 8.3 short name and the long name are the same place", inside(path.join(long, "a", "b.txt")) && withinRoot(path.join(work, "a"), long),
      long.toLowerCase() === work.toLowerCase() ? "(no short name in this path)" : "");
    ok("roots: Windows device names are refused", !inside(path.join(work, "CON")) && !inside(path.join(work, "a", "nul.txt")));
    ok("roots: a drive root holds its drive", withinRoot(path.join(work, "a"), path.parse(work).root));
  } else {
    ok("roots: / holds everything", withinRoot(path.join(work, "a"), "/"));
  }

  // ───── the server under pocket-agent.mjs ─────
  const home = path.join(T, "home"), data = path.join(home, ".pocket-agent"), PORT = 8775;
  const env = { ...process.env, HOME: home, USERPROFILE: home, PA_DATA: data };
  delete env.PA_SUPERVISED; delete env.PA_MODE; delete env.PA_SUPERVISOR; delete env.PA_PORT; delete env.PA_HOST;
  delete env.CLAUDE_CONFIG_DIR;   // a DeepSeek chat sets it: the throwaway HOME must win, never the person's own Claude data
  const cli = (...args) => { try { return execFileSync(process.execPath, [path.join(REPO, "server/bin/pocket-agent.mjs"), ...args], { env, encoding: "utf8", windowsHide: true, timeout: 60_000 }); } catch (e) { return "ERROR " + (e.stdout || "") + (e.stderr || e.message); } };
  const health = async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch { return false; } };
  const starts = () => { try { return fs.readFileSync(path.join(data, "server-events.log"), "utf8").split("\n").filter(l => / start /.test(l)).length; } catch { return 0; } };
  stopServer = () => cli("stop");
  const started = cli("start", "--port", String(PORT));
  ok("pocket-agent.mjs start", /started/.test(started) && await health(), started.trim());
  const ui = await fetch(`http://127.0.0.1:${PORT}/ui/`).then(async r => ({ status: r.status, body: await r.text() })).catch(e => ({ status: 0, body: String(e) }));
  ok("the UI is served (its folder resolves on this platform)", ui.status === 200 && /<html/i.test(ui.body), "HTTP " + ui.status);
  const token = fs.readFileSync(path.join(data, "token"), "utf8").trim();
  const WS = globalThis.WebSocket || (await import("ws")).default;
  const list = await new Promise(res => {
    const ws = new WS(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
    ws.onopen = () => ws.send(JSON.stringify({ t: "sessions.list", id: 1 }));
    ws.onmessage = ev => { const m = JSON.parse(String(ev.data)); if (m.t === "reply" && m.id === 1) { ws.close(); res(m); } };
    ws.onerror = () => res({ error: "no connection" });
    setTimeout(() => res({ error: "no answer" }), 8000);
  });
  ok("the protocol answers with the token from PA_DATA", Array.isArray(list.sessions), list.error || `${list.sessions?.length} chats`);
  const before = starts();
  const asked = cli("restart", "--when-idle");
  ok("restart --when-idle: the server restarts itself", /will restart/.test(asked) && await until(async () => starts() > before && await health(), 20000), asked.trim());
  ok("status", /running/.test(cli("status")));
  const paired = cli("pair", "--name", "Phone");
  ok("pair prints a one-use code", /^Pair code: [A-Z2-9]{4}-[A-Z2-9]{4}/m.test(paired), paired.trim().split("\n")[0]);
  const rooted = cli("pair", "--roots", path.join(T, "roots"));
  ok("pair says what the device is limited to", /^Limited to: .*\(not enforced by this server yet\)$/m.test(rooted),
    rooted.split("\n").find(l => l.startsWith("Limited to:")) || rooted.trim());
  const stopped = cli("stop");
  ok("stop", /stopped/.test(stopped) && !(await health()), stopped.trim());
} catch (e) {
  ok("no unexpected error", false, e?.stack || String(e));
} finally {
  try { stopServer(); } catch {}
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
