// Background services: long-running processes (a dev server, a mockup server, a watcher) that Pocket Agent
// keeps running. Android kills the whole app now and then (memory pressure, OEM battery savers), and that
// takes every process started from it down too. Registered services are started again whenever the server
// starts, and restarted with backoff if they exit.
//   registry: <DATA>/services.json   logs: <DATA>/services/<name>.log
//   CLI: pa-service (server/devtools/pa-service); requests: services.* (docs/PROTOCOL.md)
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DATA, HOME, log } from "./config.js";

const FILE = path.join(DATA, "services.json");
const LOGS = path.join(DATA, "services");
const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const running = new Map();   // name -> { child, startedAt, restarts, backoff, timer, state }
let stopping = false;

const load = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")).services || []; } catch { return []; } };
const save = list => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ services: list }, null, 2) + "\n"); };
const logFile = name => path.join(LOGS, name + ".log");

function start(svc) {
  const r = running.get(svc.name) || { restarts: 0, backoff: 1000 };
  running.set(svc.name, r);
  fs.mkdirSync(LOGS, { recursive: true });
  const lf = logFile(svc.name);
  try { if (fs.statSync(lf).size > 1_000_000) fs.renameSync(lf, lf + ".old"); } catch {}
  const fd = fs.openSync(lf, "a");
  fs.writeSync(fd, `\n── ${new Date().toISOString()} starting: ${svc.cmd}\n`);
  // Its own process group, so stopping it also stops whatever it started (npm → node, etc.).
  const child = spawn("/bin/sh", ["-c", svc.cmd], { cwd: svc.cwd || HOME, detached: true, stdio: ["ignore", fd, fd], env: process.env });
  fs.closeSync(fd);
  Object.assign(r, { child, startedAt: Date.now(), state: "running" });
  child.on("exit", (code, signal) => {
    if (r.child !== child) return;
    r.child = null;
    try { fs.appendFileSync(lf, `── ${new Date().toISOString()} exited (${signal || "code " + code})\n`); } catch {}
    if (stopping || r.state === "stopped" || !load().some(s => s.name === svc.name && s.enabled !== false)) { r.state = "stopped"; return; }
    if (Date.now() - r.startedAt > 60_000) r.backoff = 1000;   // ran fine for a while: restart quickly
    r.restarts++; r.state = "restarting";
    log(`service ${svc.name} exited (${signal || code}); restarting in ${r.backoff / 1000}s`);
    r.timer = setTimeout(() => { const now = load().find(s => s.name === svc.name); if (now && now.enabled !== false && !stopping) start(now); }, r.backoff);
    r.backoff = Math.min(r.backoff * 2, 5 * 60_000);
  });
}

function stop(name) {
  const r = running.get(name);
  if (!r) return;
  r.state = "stopped"; clearTimeout(r.timer);
  if (r.child) { try { process.kill(-r.child.pid, "SIGTERM"); } catch { try { r.child.kill("SIGTERM"); } catch {} } }
}

/** Starts every enabled service. Called once when the server starts. */
export function startServices() {
  for (const s of load()) if (s.enabled !== false) start(s);
  const n = load().filter(s => s.enabled !== false).length;
  if (n) log(`started ${n} background service${n === 1 ? "" : "s"}`);
}
/** Stops them all (server shutdown or restart), so a restarted server doesn't find them holding their ports. */
export function stopServices() { stopping = true; for (const name of running.keys()) stop(name); }

export function listServices() {
  return load().map(s => {
    const r = running.get(s.name);
    return { ...s, enabled: s.enabled !== false, state: r?.child ? "running" : r?.state === "restarting" ? "restarting" : "stopped",
      pid: r?.child?.pid || null, since: r?.child ? r.startedAt : null, restarts: r?.restarts || 0, log: logFile(s.name) };
  });
}
export function addService({ name, cmd, cwd }) {
  if (!NAME.test(name || "")) throw new Error("Name: lowercase letters, digits, dot, dash or underscore (max 40)");
  if (!cmd || typeof cmd !== "string") throw new Error("Give the command to run");
  if (cwd && !fs.existsSync(cwd)) throw new Error(`No such folder: ${cwd}`);
  const list = load().filter(s => s.name !== name);
  const svc = { name, cmd, cwd: cwd || HOME, enabled: true };
  list.push(svc); save(list);
  stop(name); running.delete(name); start(svc);
  return svc;
}
export function removeService({ name }) {
  const list = load();
  if (!list.some(s => s.name === name)) throw new Error(`No service named ${name}`);
  save(list.filter(s => s.name !== name)); stop(name); running.delete(name);
  return { removed: name };
}
export function setServiceEnabled({ name, enabled }) {
  const list = load(), svc = list.find(s => s.name === name);
  if (!svc) throw new Error(`No service named ${name}`);
  svc.enabled = !!enabled; save(list);
  stop(name); running.delete(name);
  if (svc.enabled) start(svc);
  return { name, enabled: svc.enabled };
}
export function restartService({ name }) {
  const svc = load().find(s => s.name === name);
  if (!svc) throw new Error(`No service named ${name}`);
  stop(name); running.delete(name); start(svc);
  return { restarted: name };
}
export function serviceLogs({ name, lines = 40 }) {
  try { return { text: fs.readFileSync(logFile(name), "utf8").split("\n").slice(-Math.min(+lines || 40, 500)).join("\n") }; }
  catch { return { text: "" }; }
}
