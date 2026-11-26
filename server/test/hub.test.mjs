// The thin hub (server/src/upstreams.js): a hub server (H) connects to another Pocket Agent server (U),
// proxies its chats under "<envId>:<sessionId>", keeps its chat list while U is down, and stores its token
// only in a 0600 file. Two throwaway homes; no network, no Claude.   node server/test/hub.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";
import { DEVICE_EVENTS } from "../src/hub.js";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "pa-hub-"));
const U_HOME = path.join(T, "upstream");
const H_HOME = path.join(T, "hub");
const SEEDED = "11111111-2222-4333-8444-555555555555";   // tests/ui/fixtures/sample-chat.jsonl
const U_PORT = 8772, H_PORT = 8773, F_PORT = 8774;   // F: a fake other server, for live chats and events
// The servers are started with these, so the test never has to read an app token file.
const U_TOKEN = crypto.randomBytes(24).toString("hex");
const H_TOKEN = crypto.randomBytes(24).toString("hex");

let fails = 0;
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) fails++; };
ok("a device's events leave out environments and profiles", !["environments", "profiles", "environment"].some(x => DEVICE_EVENTS.has(x)));
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

/**
 * A stand-in for another Pocket Agent server: says hello with three live chats, answers subscribe
 * (one with an approval already pending) and sessions.list, and can emit events to its hub.
 */
async function startFakeUpstream(port) {
  const seen = { hellos: 0, subs: [], conns: new Set() };
  const wss = new WebSocketServer({ port });
  await new Promise(r => wss.once("listening", r));
  wss.on("connection", ws => {
    seen.conns.add(ws);
    ws.on("close", () => seen.conns.delete(ws));
    ws.on("message", raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      const reply = o => ws.send(JSON.stringify({ t: "reply", id: m.id, ...o }));
      if (m.t === "hello") {
        seen.hellos++;
        reply({ version: "9.9.9", protocol: 1, environment: { id: "env-fake000001", name: "Fake laptop", protocol: 1, version: "9.9.9" },
          live: ["live-1", "live-2", "live-3"].map(id => ({ sessionId: id, state: "idle", title: id === "live-1" ? "Fake live" : "Another live" })) });
      } else if (m.t === "subscribe") {
        seen.subs.push({ sessionId: m.sessionId, after: m.after });
        reply({ sessionId: m.sessionId, info: { sessionId: m.sessionId, state: "idle", title: "Fake live", seq: 0,
          pending: m.sessionId === "live-1" ? [{ requestId: "r-pending-1", toolName: "Bash", input: { command: "ls" }, title: "Fake live" }] : [] },
          events: [] });
      } else if (m.t === "sessions.list") {
        reply({ sessions: [] });
      } else reply({});
    });
  });
  return {
    seen,
    emit(msg) { for (const ws of seen.conns) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); },
    drop() { for (const ws of seen.conns) try { ws.terminate(); } catch {} },   // the network goes away
    close() { this.drop(); wss.close(); },
  };
}

/** Reads the hub's SSE stream (v=2) into an array of parsed messages. */
async function openSse() {
  const ctl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${H_PORT}/events?token=${encodeURIComponent(H_TOKEN)}&v=2`, { signal: ctl.signal });
  const events = [], reader = res.body.getReader(), dec = new TextDecoder();
  (async () => {
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of block.split("\n")) if (line.startsWith("data: ")) { try { events.push(JSON.parse(line.slice(6))); } catch {} }
        }
      }
    } catch {}
  })();
  return { events, close: () => ctl.abort() };
}

let upstream, hub, client, sse, fake;
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

  // 9. pairing for real: a code from the upstream, swapped for a device token (#69)
  const uOwner = await connect(U_PORT, U_TOKEN);
  const pairCode = async () => (await (await fetch(`http://127.0.0.1:${U_PORT}/devices/pair?token=${encodeURIComponent(U_TOKEN)}`, { method: "POST" })).json()).code;
  await client.call("environments.add", { url: `127.0.0.1:${U_PORT}`, code: await pairCode() });
  ok("a pairing code gets the hub online within 5 s", await poll(async () => (await envState(envId)) === "online", 5000));
  const uDevices = (await uOwner.call("devices.list")).devices;
  ok("the upstream has exactly one paired device", uDevices.length === 1, String(uDevices.length));
  await uOwner.call("devices.revoke", { device: uDevices[0].id });
  ok("revoking it makes the hub unauthorized within 5 s", await poll(async () => (await envState(envId)) === "unauthorized", 5000));
  await client.call("environments.add", { url: `127.0.0.1:${U_PORT}`, code: await pairCode() });
  ok("a new code pairs it again, online within 5 s", await poll(async () => (await envState(envId)) === "online", 5000));
  uOwner.ws.close();

  // 10. a device of the hub itself: another machine's chats are the owner's only (#69)
  const hp = await (await fetch(`http://127.0.0.1:${H_PORT}/devices/pair?token=${encodeURIComponent(H_TOKEN)}`, { method: "POST" })).json();
  const hr = await (await fetch(`http://127.0.0.1:${H_PORT}/devices/redeem`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: hp.code, name: "Test phone" }) })).json();
  const devClient = await connect(H_PORT, hr.token);
  const devHello = await devClient.call("hello", {});
  ok("a device's hello has no environments and no profiles",
    !("environments" in devHello) && !("profiles" in devHello) && !("defaultProfile" in devHello) && devHello.protocol === 1);
  let devSend = null; try { await devClient.call("send", { sessionId: remoteId, text: "hi" }); } catch (e) { devSend = e; }
  ok("a device can't send to another machine's chat", devSend?.code === "forbidden" && /only for this phone's owner/.test(devSend.message), devSend?.message || "");
  let devSub = null; try { await devClient.call("subscribe", { sessionId: remoteId, after: 0 }); } catch (e) { devSub = e; }
  ok("a device can't subscribe to another machine's chat", devSub?.code === "forbidden", devSub?.message || "");
  let devUnknown = null; try { await devClient.call("subscribe", { sessionId: "x:y", after: 0 }); } catch (e) { devUnknown = e; }
  ok("a namespaced id no environment owns is not_found, never a local handler", devUnknown?.code === "not_found" && devUnknown.message === "No such chat", devUnknown?.message || "");
  devClient.ws.close();

  // 11. pairing with this same device is refused before its code is used (#69)
  const selfPair = await (await fetch(`http://127.0.0.1:${H_PORT}/devices/pair?token=${encodeURIComponent(H_TOKEN)}`, { method: "POST" })).json();
  let selfErr = null;
  try { await client.call("environments.add", { url: `127.0.0.1:${H_PORT}`, code: selfPair.code }); } catch (e) { selfErr = e.message; }
  ok("pairing with this same device is refused", selfErr === "That's this device", selfErr || "");

  // 12. removing deletes the token file and the chats
  const removed = await client.call("environments.remove", { environment: envId });
  ok("environments.remove says ok", removed.ok === true);
  ok("removing deletes the token file", tokenFiles().length === 0);
  ok("its chats leave sessions.list", !(await client.call("sessions.list", { limit: 400 })).sessions.some(s => s.sessionId === remoteId));

  // 12b. when the upstream limits this device to folders, its hello.roots stays on the environment record (#72)
  const rootedCode = await (await fetch(`http://127.0.0.1:${U_PORT}/devices/pair?token=${encodeURIComponent(U_TOKEN)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roots: [U_HOME] }) })).json();
  await client.call("environments.add", { url: `127.0.0.1:${U_PORT}`, code: rootedCode.code });
  const limited = await poll(async () => (await list()).find(e => e.id === envId && Array.isArray(e.roots) && e.roots.length), 5000);
  ok("the hub keeps the upstream's hello.roots on the environment", limited?.roots?.[0] === U_HOME, JSON.stringify(limited?.roots));
  await client.call("environments.remove", { environment: envId });

  // address handling (no token anywhere here)
  const t = await client.call("environments.test", { url: `127.0.0.1:${U_PORT}` });
  ok("environments.test sees the upstream", t.ok === true && !!t.version && t.protocol >= 1 && typeof t.ms === "number");
  const dead = await client.call("environments.test", { url: "127.0.0.1:1" });
  ok("environments.test reports a dead address", dead.ok === false && /^Can't reach /.test(dead.error), dead.error || "");
  let badAddr = null;
  try { await client.call("environments.test", { url: "ftp://nowhere" }); } catch (e) { badAddr = e.message; }
  ok("a bad address is refused in plain words", badAddr === "That address doesn't look right", badAddr || "");

  // 13. approvals and done states from a remote live chat notify with no screen open (#69, R7)
  sse = await openSse();
  fake = await startFakeUpstream(F_PORT);
  const fakeAdded = await client.call("environments.add", { url: `127.0.0.1:${F_PORT}`, token: "fake-token" });
  const fakeId = fakeAdded.environment.id;
  ok("the fake upstream's environment is online", await poll(async () => (await envState(fakeId)) === "online", 5000));
  const fakeLive = ["live-1", "live-2", "live-3"];
  ok("the hub subscribes to every chat in the upstream's hello.live",
    await poll(() => fakeLive.every(id => fake.seen.subs.some(s => s.sessionId === id)), 5000),
    fake.seen.subs.map(s => s.sessionId).join(", "));
  const pendNote = await poll(() => sse.events.find(e => e.type === "notify" && e.spec?.id === "approval:r-pending-1"), 5000);
  ok("an approval waiting in the subscribe reply notifies with no screen open", !!pendNote);
  ok("its notification names the environment, with plain text", !!pendNote && typeof pendNote.spec.title === "string"
    && /Fake laptop/.test(pendNote.spec.title) && pendNote.spec.text === "ls");

  fake.emit({ t: "permission.request", sessionId: "live-1", requestId: "r-live-1", toolName: "Bash", input: { command: "npm test" }, title: "Fake live" });
  const liveNote = await poll(() => sse.events.find(e => e.type === "notify" && e.spec?.id === "approval:r-live-1"), 5000);
  ok("an approval from a remote live chat notifies with no screen open", !!liveNote && /Fake laptop/.test(liveNote.spec.title));
  ok("the notification takes named fields only, as plain text", !!liveNote && liveNote.spec.text === "npm test" && typeof liveNote.spec.title === "string");

  fake.emit({ t: "state", sessionId: "live-1", state: "running", info: { sessionId: "live-1", state: "running", title: "Fake live" } });
  fake.emit({ t: "state", sessionId: "live-1", state: "idle", info: { sessionId: "live-1", state: "idle", title: "Fake live" } });
  const doneNote = await poll(() => sse.events.find(e => e.type === "notify" && e.spec?.id === `done:${fakeId}:live-1`), 5000);
  ok("a finished turn on a remote live chat notifies Done", !!doneNote && /Done: Fake laptop/.test(doneNote.spec.title), doneNote?.spec?.title || "");

  // 14. an upstream event whose sessionId contains ":" keeps its whole id, prefixed once (#69, R3)
  const colonFull = `${fakeId}:envB:abc`;
  const subColon = await client.call("subscribe", { sessionId: colonFull, after: 0 });
  ok("a subscribe to a doubly namespaced chat reaches the fake upstream", subColon.sessionId === colonFull && fake.seen.subs.some(s => s.sessionId === "envB:abc"));
  const beforeEv = client.events.length;
  fake.emit({ t: "ev", sessionId: "envB:abc", seq: 1, ev: { type: "assistant" } });
  const gotEv = await poll(() => client.events.slice(beforeEv).find(e => e.t === "ev" && e.seq === 1), 3000);
  ok("an upstream event whose sessionId contains ':' is mapped with the env prefix", gotEv?.sessionId === colonFull, gotEv?.sessionId || "");

  // 15. after a reconnect it re-subscribes with after: lastSeq, and doesn't notify a pending approval twice (#69)
  fake.emit({ t: "ev", sessionId: "live-1", seq: 7, ev: { type: "assistant" } });
  await sleep(300);
  const subsBefore = fake.seen.subs.length, hellosBefore = fake.seen.hellos;
  fake.drop();
  ok("the hub reconnects after the fake upstream drops", await poll(() => fake.seen.hellos > hellosBefore, 5000));
  const resub = await poll(() => fake.seen.subs.slice(subsBefore).find(s => s.sessionId === "live-1" && s.after === 7), 5000);
  ok("after a reconnect it re-subscribes with after: lastSeq", !!resub);
  await sleep(500);
  const pendCount = sse.events.filter(e => e.type === "notify" && e.spec?.id === "approval:r-pending-1").length;
  ok("a pending approval is not notified twice after a reconnect", pendCount === 1, String(pendCount));
} catch (e) {
  console.log("FAIL", e.stack);
  fails++;
} finally {
  try { client?.ws.close(); } catch {}
  try { sse?.close(); } catch {}
  try { fake?.close(); } catch {}
  try { hub?.kill("SIGKILL"); } catch {}
  try { upstream?.kill("SIGKILL"); } catch {}
  await Promise.all([hub && exited(hub), upstream && exited(upstream)]);
  if (fails) for (const p of [hub, upstream]) if (p) console.log(`(server ${p.pid} output)`, serverOutput(p));
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
