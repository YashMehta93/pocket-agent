// The thin hub (server/src/upstreams.js): a hub server (H) connects to another Pocket Agent server (U),
// proxies its chats under "<envId>:<sessionId>", keeps its chat list while U is down, and stores its token
// only in a 0600 file. Two throwaway homes; no network, no Claude.   node server/test/hub.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import WebSocket from "ws";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "pa-hub-"));
const U_HOME = path.join(T, "upstream");
const H_HOME = path.join(T, "hub");
const SEEDED = "11111111-2222-4333-8444-555555555555";   // tests/ui/fixtures/sample-chat.jsonl
const U_PORT = 8772, H_PORT = 8773;
// The servers are started with these, so the test never has to read an app token file.
const U_TOKEN = crypto.randomBytes(24).toString("hex");
const H_TOKEN = crypto.randomBytes(24).toString("hex");

let fails = 0;
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Polls fn until it returns something truthy, or gives up. */
const poll = async (fn, ms, every = 150) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(every);
  }
  return null;
};
/** Every file under dir (the hub's own data in this test's throwaway home). */
const filesUnder = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const tokenFiles = () => filesUnder(path.join(H_HOME, ".pocket-agent")).filter(f => f.endsWith(".token"));

// A stand-in for Claude Code, so nothing here can start the real one (config.js would find it on PATH).
const FAKE_CLAUDE = path.join(T, "fake-claude");
fs.writeFileSync(FAKE_CLAUDE, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });

/** HOME, PA_DATA and no app supervision; PA_SUPERVISED would start update checks and default chats. */
function serverEnv(home, extra = {}) {
  const e = { ...process.env, HOME: home, PA_DATA: path.join(home, ".pocket-agent"), PA_CLAUDE: FAKE_CLAUDE, ...extra };
  delete e.CLAUDE_CONFIG_DIR; delete e.PA_SUPERVISED; delete e.PA_MODE; delete e.PA_PORT; delete e.PA_HUB_BACKOFF_MS;
  return e;
}
const output = new Map();
function startServer(port, env, token) {
  const p = spawn("node", [path.join(REPO, "server/src/index.js"), "--port", String(port), "--token", token], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; const add = d => { out += d; }; p.stdout.on("data", add); p.stderr.on("data", add); output.set(p, () => out);
  p.on("error", e => { out += String(e); });
  return p;
}
const serverOutput = p => (output.get(p)?.() || "").slice(-800);
const health = async port => { try { return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } };
const waitHealth = (port, ms = 15000) => poll(() => health(port), ms, 200);
const exited = p => new Promise(r => (p.exitCode !== null || p.signalCode !== null ? r() : p.once("exit", r)));

/** A WebSocket client for the hub: call(t, params) resolves the reply, or rejects with its error. */
function connect(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    let n = 0;
    const waiting = new Map(), events = [];
    ws.on("message", raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t !== "reply") { events.push(m); return; }
      const p = waiting.get(m.id);
      if (!p) return;
      waiting.delete(m.id); clearTimeout(p.timer);
      if (m.error && m.ok !== false) p.reject(Object.assign(new Error(m.error), { code: m.code }));   // environments.test answers ok:false with a reason

      else p.resolve(m);
    });
    ws.on("error", reject);
    ws.on("open", () => {
      resolve({
        ws, events,
        call: (t, params = {}) => new Promise((res, rej) => {
          const id = ++n;
          const timer = setTimeout(() => { waiting.delete(id); rej(new Error(`${t} timed out`)); }, 20000);
          waiting.set(id, { resolve: res, reject: rej, timer });
          ws.send(JSON.stringify({ t, id, ...params }));
        }),
      });
    });
  });
}

let upstream, hub, client;
try {
  fs.mkdirSync(U_HOME, { recursive: true });
  fs.mkdirSync(H_HOME, { recursive: true });

  // Seed one chat into U before its server starts (the script refuses a home that already has Pocket Agent data).
  execFileSync("sh", [path.join(REPO, "tests/ui/seed-sample-chat.sh")], { cwd: REPO, env: serverEnv(U_HOME) });
  ok("a sample chat is seeded into U", fs.existsSync(path.join(U_HOME, ".claude/projects/-tmp-pa-sample", SEEDED + ".jsonl")));

  upstream = startServer(U_PORT, serverEnv(U_HOME), U_TOKEN);
  ok("the upstream server starts", await waitHealth(U_PORT));
  if (!(await health(U_PORT))) console.log(serverOutput(upstream));

  hub = startServer(H_PORT, serverEnv(H_HOME, { PA_HUB_BACKOFF_MS: "200" }), H_TOKEN);
  ok("the hub server starts", await waitHealth(H_PORT));
  if (!(await health(H_PORT))) console.log(serverOutput(hub));

  // The upstream describes itself now (environment.js): give it a name to check the hub shows it.
  const U_NAME = "Test upstream";
  const uClient = await connect(U_PORT, U_TOKEN);
  await uClient.call("environment.set", { name: U_NAME });
  uClient.ws.close();

  client = await connect(H_PORT, H_TOKEN);
  const list = async () => (await client.call("environments.list")).environments;
  const envState = async id => (await list()).find(e => e.id === id)?.state;
  const remoteItem = async id => (await client.call("sessions.list", { limit: 400 })).sessions.find(s => s.sessionId === id);

  // 1. add and go online
  const added = await client.call("environments.add", { url: `127.0.0.1:${U_PORT}`, token: U_TOKEN });
  const envId = added.environment.id;
  const remoteId = `${envId}:${SEEDED}`;
  ok("environments.add returns a public record with no token", typeof envId === "string" && !JSON.stringify(added).includes(U_TOKEN) && added.environment.name === U_NAME);
  ok("the environment is online within 5 s", await poll(async () => (await envState(envId)) === "online", 5000));

  // 2. its chat list, namespaced
  const item = await poll(() => remoteItem(remoteId), 5000);
  ok("sessions.list has the remote chat", !!item && item.remote === true && item.environment === envId && item.environmentName === U_NAME && item.offline === false);
  ok("its timestamp is numeric, so the merged list sorts like the local one", typeof item?.lastModified === "number");

  // 3. its history
  const hist = await client.call("session.history", { sessionId: remoteId });
  ok("session.history returns the remote chat's messages", hist.sessionId === remoteId && Array.isArray(hist.messages) && hist.messages.length >= 3, `${hist.messages?.length} messages`);

  // 4. subscribing
  const sub = await client.call("subscribe", { sessionId: remoteId, after: 0 });
  ok("subscribe to the remote chat works", sub.sessionId === remoteId && Array.isArray(sub.events));

  // a forwarded change takes effect upstream, and its event comes back namespaced
  await client.call("session.rename", { sessionId: remoteId, title: "Tea, on the laptop" });
  ok("a forwarded request is applied upstream", !!(await poll(async () => (await remoteItem(remoteId))?.title === "Tea, on the laptop", 3000)));
  ok("its event is relayed with the environment", !!(await poll(() => client.events.find(e => e.t === "sessions.changed" && e.environment === envId), 3000)));

  // renaming the environment
  const renamed = await client.call("environments.rename", { environment: envId, name: "  Laptop  " });
  ok("environments.rename trims the name", renamed.environment.name === "Laptop");
  let badName = null;
  try { await client.call("environments.rename", { environment: envId, name: "   " }); } catch (e) { badName = e.message; }
  ok("an empty name is refused", badName === "A name needs 1 to 40 characters", badName || "");

  // 5. a wrong token is unauthorized, not a crash; re-pairing fixes it
  const wrong = await client.call("environments.add", { url: `127.0.0.1:${U_PORT}`, token: "wrong" });
  ok("re-pairing the same address keeps its id", wrong.environment.id === envId);
  ok("a wrong token is unauthorized within 5 s", await poll(async () => (await envState(envId)) === "unauthorized", 5000));
  await client.call("environments.add", { url: `127.0.0.1:${U_PORT}`, token: U_TOKEN });
  ok("re-adding the right token goes online again", await poll(async () => (await envState(envId)) === "online", 5000));
  ok("its chat list comes back", !!(await poll(() => remoteItem(remoteId), 5000)));

  // 6. the upstream dies: offline, cached list still there
  upstream.kill("SIGKILL"); await exited(upstream);
  ok("offline within 5 s when the upstream dies", await poll(async () => (await envState(envId)) === "offline", 5000));
  const stale = await poll(async () => { const s = await remoteItem(remoteId); return s?.offline === true ? s : null; }, 5000);
  ok("sessions.list keeps the chat, marked offline", !!stale);

  // 7. it comes back: online again, and its chats refresh
  upstream = startServer(U_PORT, serverEnv(U_HOME), U_TOKEN);
  ok("the upstream starts again", await waitHealth(U_PORT));
  ok("back online within 10 s", await poll(async () => (await envState(envId)) === "online", 10000));
  const reconnected = await client.call("environments.reconnect", { environment: envId });
  ok("environments.reconnect answers and connects again", !!reconnected.environment &&
    !!(await poll(async () => (await envState(envId)) === "online", 5000)));

  // 8. the token lives only in its 0600 file (found by what it is, not by a secret path)
  const prefsText = fs.readFileSync(path.join(H_HOME, ".pocket-agent/prefs.json"), "utf8");
  const prefs = JSON.parse(prefsText);
  ok("the hub's prefs.json has no token", !prefsText.includes(U_TOKEN) && (prefs.environments || []).every(e => !("token" in e)));
  const tokenFilesNow = tokenFiles();
  const mode = tokenFilesNow.length === 1 ? fs.statSync(tokenFilesNow[0]).mode & 0o777 : 0;
  ok("there is one token file, mode 0600, holding the token", tokenFilesNow.length === 1 && mode === 0o600 && fs.readFileSync(tokenFilesNow[0], "utf8") === U_TOKEN, mode.toString(8));

  // 9. removing deletes the token file and the chats
  const removed = await client.call("environments.remove", { environment: envId });
  ok("environments.remove says ok", removed.ok === true);
  ok("removing deletes the token file", tokenFiles().length === 0);
  ok("its chats leave sessions.list", !(await client.call("sessions.list", { limit: 400 })).sessions.some(s => s.sessionId === remoteId));

  // address handling (no token anywhere here)
  const t = await client.call("environments.test", { url: `127.0.0.1:${U_PORT}` });
  ok("environments.test sees the upstream", t.ok === true && !!t.version && t.protocol >= 1 && typeof t.ms === "number");
  const dead = await client.call("environments.test", { url: "127.0.0.1:1" });
  ok("environments.test reports a dead address", dead.ok === false && /^Can't reach /.test(dead.error), dead.error || "");
  let badAddr = null;
  try { await client.call("environments.test", { url: "ftp://nowhere" }); } catch (e) { badAddr = e.message; }
  ok("a bad address is refused in plain words", badAddr === "That address doesn't look right", badAddr || "");
} catch (e) {
  console.log("FAIL", e.stack);
  fails++;
} finally {
  try { client?.ws.close(); } catch {}
  try { hub?.kill("SIGKILL"); } catch {}
  try { upstream?.kill("SIGKILL"); } catch {}
  await Promise.all([hub && exited(hub), upstream && exited(upstream)]);
  if (fails) for (const p of [hub, upstream]) if (p) console.log(`(server ${p.pid} output)`, serverOutput(p));
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
