#!/usr/bin/env node
// pocket-agent.mjs: start and stop the Pocket Agent server on any computer, Windows included (the bash
// `pocket-agent` next to it stays the one for Termux and Linux). No admin, no service, no hidden PowerShell:
// node runs the server directly under a small supervisor, which starts it again when it asks (an update or a
// restored backup exits with 75) or crashes, and gives up after repeated crashes instead of retrying forever.
//   node pocket-agent.mjs start [--port N] [--host H] [--claude PATH]   start in the background (no-op if running)
//   node pocket-agent.mjs stop | restart [--when-idle] | status | logs [lines] | token
//   node pocket-agent.mjs pair [--name "Phone"] [--scopes chat,files.read] [--roots "<folder1>;<folder2>"]
//   (prints a one-use pairing code for a phone: Settings → Environments → Add)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const SERVER = path.resolve(path.dirname(SELF), "../src/index.js");
const DATA = process.env.PA_DATA || path.join(os.homedir(), ".pocket-agent");
const STATE = path.join(DATA, "supervisor.json"), LOG = path.join(DATA, "server.log");
const RESTART_EXIT = 75, MAX_CRASHES = 5, CRASH_WINDOW_MS = 10 * 60_000;   // RESTART_EXIT: same as platform.js
const IS_WIN = process.platform === "win32";
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });

const [cmd = "status", ...rest] = process.argv.slice(2);
const flag = name => { const i = rest.indexOf("--" + name); return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : undefined; };
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return null; } };
const running = () => { const s = readState(); return s && alive(s.pid) ? s : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const note = line => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} [supervisor] ${line}\n`); } catch {} };
const local = s => (!s.host || s.host === "0.0.0.0" || s.host === "::" ? "127.0.0.1" : s.host);
const healthy = async s => { try { return (await fetch(`http://${local(s)}:${s.port}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
const where = () => ({ port: +(flag("port") || process.env.PA_PORT || 8765), host: flag("host") || process.env.PA_HOST || "127.0.0.1" });

/** Stops the supervisor and everything under it. */
function killTree(pid) {
  if (IS_WIN) { try { execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch {} return; }
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }   // its own process group
}

/** One request to the running server over its WebSocket, with the token from DATA. */
async function call(s, t) {
  const token = fs.readFileSync(path.join(DATA, "token"), "utf8").trim();
  const WS = globalThis.WebSocket || (await import("ws")).default;
  return new Promise((resolve, reject) => {
    const ws = new WS(`ws://${local(s)}:${s.port}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("the server didn't answer")); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ t, id: 1 }));
    ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data));
      if (m.t !== "reply" || m.id !== 1) return;
      clearTimeout(timer); ws.close();
      m.error ? reject(new Error(m.error)) : resolve(m);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("can't reach the server")); };
  });
}

async function start() {
  const cur = running();
  if (cur) { console.log(`already running (pid ${cur.pid}, port ${cur.port})`); return 0; }
  try { if (fs.statSync(LOG).size > 2_000_000) fs.renameSync(LOG, LOG + ".old"); } catch {}
  const sup = spawn(process.execPath, [SELF, "supervise", ...rest], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
  sup.unref();
  const s = where();
  for (let i = 0; i < 80; i++) {
    if (await healthy(s)) { console.log(`started (pid ${sup.pid}) on http://${local(s)}:${s.port}`); return 0; }
    if (!alive(sup.pid)) break;
    await sleep(250);
  }
  console.log(`failed to start, see ${LOG}`);
  try { console.log(fs.readFileSync(LOG, "utf8").trim().split("\n").slice(-5).join("\n")); } catch {}
  return 1;
}

/** Runs in the background (started by `start`): keeps the server going. */
async function supervise() {
  process.on("uncaughtException", e => { note("supervisor crashed: " + (e?.stack || e)); process.exit(1); });
  const s = where();
  fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, ...s, startedAt: Date.now() }));
  const args = [SERVER, "--port", String(s.port), "--host", s.host];
  for (const f of ["claude", "token"]) if (flag(f)) args.push("--" + f, flag(f));
  let stopping = false, child = null, crashes = [];
  const stop = () => { stopping = true; try { child?.kill("SIGTERM"); } catch {} };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  while (!stopping) {
    const fd = fs.openSync(LOG, "a");
    child = spawn(process.execPath, args, { stdio: ["ignore", fd, fd], windowsHide: true, env: { ...process.env, PA_SUPERVISOR: "1" } });
    fs.closeSync(fd);
    note(`server started (pid ${child.pid})`);
    const code = await new Promise(r => child.on("exit", (c, sig) => r(c ?? sig)));
    child = null;
    if (stopping) break;
    if (code === RESTART_EXIT) { note("the server asked for a restart"); continue; }
    if (code === 0) { note("the server stopped"); break; }   // stopped on purpose
    const now = Date.now();
    crashes = crashes.filter(t => now - t < CRASH_WINDOW_MS).concat(now);
    if (crashes.length >= MAX_CRASHES) {
      note(`the server stopped ${crashes.length} times in 10 minutes (last: ${code}); giving up. Start it again with: node server/bin/pocket-agent.mjs start`);
      break;
    }
    const wait = Math.min(1000 * 2 ** (crashes.length - 1), 30_000);
    note(`the server exited (${code}); starting it again in ${wait / 1000}s`);
    await sleep(wait);
  }
  try { if (readState()?.pid === process.pid) fs.rmSync(STATE, { force: true }); } catch {}
  process.exit(0);
}

async function stop() {
  const cur = running();
  if (!cur) { try { fs.rmSync(STATE, { force: true }); } catch {} console.log("not running"); return 0; }
  await call(cur, "working.clear").catch(() => {});   // a stop on purpose: replies it cuts off shouldn't continue later
  killTree(cur.pid);
  for (let i = 0; i < 40 && alive(cur.pid); i++) await sleep(250);
  try { fs.rmSync(STATE, { force: true }); } catch {}
  console.log(alive(cur.pid) ? `still running (pid ${cur.pid})` : "stopped");
  return alive(cur.pid) ? 1 : 0;
}

/** Prints a one-use pairing code for another device (a phone, a hub): what pair-cli.js does, from the launcher. */
async function pair() {
  const cur = running();
  if (!cur) { console.log("The server isn't running. Start it first: node server/bin/pocket-agent.mjs start"); return 1; }
  const body = {};
  const name = flag("name"); if (name) body.name = name;
  const scopes = flag("scopes"); if (scopes) body.scopes = scopes.split(",").map(s => s.trim()).filter(Boolean);
  const roots = flag("roots") ? flag("roots").split(";").map(s => s.trim()).filter(Boolean) : null;
  if (roots) body.roots = roots;
  let res, out;
  try {
    const token = fs.readFileSync(path.join(DATA, "token"), "utf8").trim();
    res = await fetch(`http://${local(cur)}:${cur.port}/devices/pair?token=${encodeURIComponent(token)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    out = await res.json().catch(() => ({}));
  } catch (e) { console.log(`Couldn't reach the server on port ${cur.port}: ${e.message}`); return 1; }
  if (!res.ok || !out.code) { console.log(out.error || `The server said no (${res.status}).`); return 1; }
  const limited = Array.isArray(out.roots) ? (out.roots.length ? out.roots.join("; ") : "no folder limit")
    : roots ? `${roots.join("; ")} (not enforced by this server yet)` : "no folder limit";
  console.log(`Pair code: ${out.code}  (one use, valid for 10 minutes)`);
  console.log(`This server: environment ${out.environment || "?"}, port ${cur.port}`);
  console.log(`Limited to: ${limited}`);
  console.log("In Pocket Agent on your phone: Settings → Environments → Add, then enter this computer's address and the code.");
  return 0;
}

async function main() {
  switch (cmd) {
    case "start": return start();
    case "supervise": return supervise();
    case "stop": return stop();
    case "pair": return pair();
    case "restart": {
      const cur = running();
      if (rest.includes("--when-idle") && cur) { await call(cur, "server.restartWhenIdle"); console.log("will restart when idle"); return 0; }
      await stop(); return start();
    }
    case "status": {
      const cur = running();
      if (!cur) { console.log("not running"); return 1; }
      console.log(`running (pid ${cur.pid}) on http://${local(cur)}:${cur.port}`);
      try { console.log(await (await fetch(`http://${local(cur)}:${cur.port}/health`)).text()); } catch { console.log("(not answering /health)"); }
      return 0;
    }
    case "logs": { try { console.log(fs.readFileSync(LOG, "utf8").trimEnd().split("\n").slice(-(+rest[0] || 50)).join("\n")); } catch { console.log("no log yet"); } return 0; }
    case "token": { try { console.log(fs.readFileSync(path.join(DATA, "token"), "utf8").trim()); return 0; } catch { console.log("no token yet: start the server once"); return 1; } }
    default: console.log(fs.readFileSync(SELF, "utf8").split("\n").slice(5, 8).map(l => l.replace(/^\/\/ ?/, "")).join("\n")); return cmd === "help" ? 0 : 2;
  }
}
process.exitCode = await main();
