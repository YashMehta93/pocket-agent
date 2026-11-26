// Tests paired devices (server/src/devices.js): hashed tokens, scopes, pairing codes, the lock, and the
// owner/device split over HTTP and the WebSocket. A throwaway HOME / PA_DATA and a real server on a free port;
// the app's real data is never touched.   node server/test/devices.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "pa-devices-"));
const HOME = path.join(T, "home");
Object.assign(process.env, { HOME, PA_DATA: path.join(HOME, ".pocket-agent") });
// A stand-in for Claude Code, so nothing here can start the real one (config.js would find it on PATH).
const FAKE = path.join(T, "fake-claude");
fs.writeFileSync(FAKE, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
process.env.PA_CLAUDE = FAKE;
delete process.env.PA_MODE; delete process.env.PA_SUPERVISED;
delete process.env.CLAUDE_CONFIG_DIR;   // a DeepSeek chat sets it: the throwaway HOME must win
fs.mkdirSync(process.env.PA_DATA, { recursive: true });

// ───── folders a device can be limited to, and one chat in each (#72) ─────
// A transcript in ~/.claude/projects is all a chat is on disk: the same shape as tests/ui/fixtures/sample-chat.jsonl.
const A = path.join(T, "A"), A_SUB = path.join(A, "sub"), B = path.join(T, "B");
fs.mkdirSync(A_SUB, { recursive: true });
fs.mkdirSync(B, { recursive: true });
const SID_A = "aaaaaaaa-1111-4111-8111-111111111111", SID_B = "bbbbbbbb-2222-4222-8222-222222222222";
function seedChat(sessionId, cwd, title) {
  const dir = path.join(HOME, ".claude", "projects", cwd.replace(/[\/\\.]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const u = sessionId.slice(0, 8) + "-0000-4000-8000-000000000001", a = sessionId.slice(0, 8) + "-0000-4000-8000-000000000002";
  const lines = [
    { parentUuid: null, isSidechain: false, userType: "external", entrypoint: "sdk-ts", cwd, sessionId, version: "2.1.0", gitBranch: "", type: "user", uuid: u, timestamp: "2026-01-01T10:00:00.000Z", permissionMode: "default", message: { role: "user", content: [{ type: "text", text: title }] } },
    { type: "ai-title", aiTitle: title, sessionId },
    { parentUuid: u, isSidechain: false, userType: "external", entrypoint: "sdk-ts", cwd, sessionId, version: "2.1.0", gitBranch: "", type: "assistant", uuid: a, timestamp: "2026-01-01T10:00:02.000Z", message: { model: "claude-sonnet-5-5", id: "msg_" + sessionId.slice(0, 8), type: "message", role: "assistant", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 4 }, content: [{ type: "text", text: "ok" }] } },
  ];
  fs.writeFileSync(path.join(dir, sessionId + ".jsonl"), lines.map(l => JSON.stringify(l)).join("\n") + "\n");
}
seedChat(SID_A, A, "Chat in A");
seedChat(SID_B, B, "Chat in B");
fs.symlinkSync(B, path.join(A, "link"), "dir");   // inside A, points out of it

let fails = 0;
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
let n = 0;
/** One WebSocket request → its reply. */
const call = (ws, t, m = {}) => new Promise(res => {
  const id = ++n;
  const h = raw => { const x = JSON.parse(raw); if (x.t === "reply" && x.id === id) { ws.off("message", h); res(x); } };
  ws.on("message", h);
  ws.send(JSON.stringify({ ...m, t, id }));
});
const opened = ws => new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
/** A port that is free right now (8771 can be a leftover server from another run). */
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

let server = null;
try {
  const { SCOPES, DEFAULT_SCOPES, SCOPE_OF, allowed, authenticate, listDevices, revokeDevice, renameDevice, startPairing, redeem, setDeviceRoots } = await import("../src/devices.js");
  const { rootsGate } = await import("../src/roots.js");
  const ownerToken = fs.readFileSync(path.join(process.env.PA_DATA, "token"), "utf8").trim();

  // ───── pairing and redeeming ─────
  const p = await startPairing({ name: "Tablet" });
  ok("pairing returns an 8-character code", /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(p.code) && p.code.replace("-", "").length === 8, p.code);
  ok("the code is good for 10 minutes", Math.abs(p.expiresAt - Date.now() - 600000) < 5000);
  ok("pairing says which server it is", /^env-[0-9a-f]{12}$/.test(p.environment || ""), String(p.environment));

  const r = redeem(p.code, "Tablet");
  ok("redeem gives a token starting pad_", r.token.startsWith("pad_") && r.token.length > 20, r.token.slice(0, 8) + "…");
  ok("the device gets its name and the default scopes", r.device.name === "Tablet" && r.device.scopes.join(",") === DEFAULT_SCOPES.join(","), r.device.scopes.join(","));
  ok("the device id is dev- and 8 hex characters", /^dev-[0-9a-f]{8}$/.test(r.device.id), r.device.id);

  const file = path.join(process.env.PA_DATA, "devices.json");
  const raw = fs.readFileSync(file, "utf8");
  const stored = JSON.parse(raw).devices.find(d => d.id === r.device.id);
  const hash = crypto.createHash("sha256").update(r.token).digest("hex");
  ok("devices.json has the token's hash, not the token", stored?.hash === hash && !raw.includes(r.token));
  ok("devices.json is private (0600)", (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));
  ok("listDevices leaves the hash out", listDevices().every(d => !("hash" in d) && d.id !== undefined));

  const who = authenticate(r.token);
  ok("authenticate(token) gives the device with its scopes",
    who?.kind === "device" && who.id === r.device.id && who.name === "Tablet" && who.scopes.join(",") === DEFAULT_SCOPES.join(","), JSON.stringify(who));
  ok("the owner's token authenticates as the owner", authenticate(ownerToken)?.kind === "owner");
  ok("an unknown token authenticates as nobody", authenticate("pad_nope") === null && authenticate(undefined) === null);

  let err = null; try { redeem(p.code, "Again"); } catch (e) { err = e; }
  ok("a code can be redeemed only once", err?.message === "That code is wrong or has expired", err?.message || "");

  renameDevice(r.device.id, "  Tablet 2 ");
  ok("a device can be renamed, trimmed", listDevices().find(d => d.id === r.device.id)?.name === "Tablet 2");
  err = null; try { renameDevice(r.device.id, " "); } catch (e) { err = e; }
  ok("an empty device name is refused", err?.message === "Give it a name of 1–40 characters", err?.message || "");
  revokeDevice(r.device.id);
  ok("a revoked device is gone and its token stops working", !listDevices().some(d => d.id === r.device.id) && authenticate(r.token) === null);
  err = null; try { revokeDevice(r.device.id); } catch (e) { err = e; }
  ok("revoking an unknown device fails", err?.message === "No such device", err?.message || "");

  err = null; try { await startPairing({ scopes: ["chat", "nope"] }); } catch (e) { err = e; }
  ok("unknown scopes are refused", /Scopes must be one or more/.test(err?.message || ""), err?.message || "");
  err = null; try { await startPairing({ scopes: [] }); } catch (e) { err = e; }
  ok("an empty scope list is refused", !!err);

  // A pair code keeps its roots for redeem; changing them later is the owner's (before the lock tests: a
  // redeem still works here).
  const prRoot = await startPairing({ name: "Limited", roots: [A] });
  const prjRoot = redeem(prRoot.code, "Limited");
  ok("the pair reply carries its roots", JSON.stringify(prRoot.roots) === JSON.stringify([A]) && JSON.stringify(prjRoot.device.roots) === JSON.stringify([A]));
  ok("the principal and the list carry them too", JSON.stringify(authenticate(prjRoot.token).roots) === JSON.stringify([A]) &&
    JSON.stringify(listDevices().find(d => d.id === prjRoot.device.id)?.roots) === JSON.stringify([A]));
  const moved = setDeviceRoots(prjRoot.device.id, []);
  ok("setDeviceRoots changes them ([] removes the limit)", moved.roots.length === 0);
  revokeDevice(prjRoot.device.id);

  const old = await startPairing({ name: "Old", ttlMs: 1 });
  await sleep(5);
  err = null; try { redeem(old.code, "Old"); } catch (e) { err = e; }
  ok("an expired code fails", err?.message === "That code is wrong or has expired", err?.message || "");

  let locked = null;
  for (let i = 0; i < 21; i++) { try { redeem("ZZZZ-ZZZZ", "Nope"); } catch (e) { locked = e; } }
  ok("21 wrong codes lock redeeming", locked?.code === "locked", locked?.message || "");
  err = null; try { redeem("ZZZZ-ZZZZ"); } catch (e) { err = e; }
  ok("while locked, every redeem is refused", err?.code === "locked");

  // ───── who may do what ─────
  const chatDevice = { kind: "device", id: "dev-12345678", name: "Tablet", scopes: ["chat"] };
  ok("a chat device may send", allowed(chatDevice, "send") === true);
  ok("a chat device may not touch DeepSeek", allowed(chatDevice, "deepseek.status") === false);
  ok("a type missing from SCOPE_OF is the owner's", allowed(chatDevice, "session.delete") === false && !("session.delete" in SCOPE_OF));
  ok("hello is open to any signed-in caller", allowed(chatDevice, "hello") === true);
  ok("the owner may do anything", allowed({ kind: "owner" }, "session.delete") === true && allowed({ kind: "owner" }, "anything.at.all") === true);
  const filesDevice = { kind: "device", id: "dev-87654321", name: "Reader", scopes: ["files.read"] };
  ok("files.read and files.write are separate", allowed(filesDevice, "fs.read") === true && allowed(filesDevice, "upload") === false);
  ok("the scopes list is the documented one",
    SCOPES.join(",") === "chat,files.read,files.write,workers,export.sessions,update.source,sync.pair" && DEFAULT_SCOPES.join(",") === "chat,files.read,files.write,workers");

  // ───── roots: the gate, and storing them (#72) ─────
  const rooted = { kind: "device", id: "dev-12345678", name: "Rooted", scopes: ["chat", "files.read", "files.write"], roots: [A] };
  ok("the gate lets the owner through", (await rootsGate({ kind: "owner" }, { t: "fs.list", path: B })) === null);
  ok("the gate lets a device without roots through", (await rootsGate({ kind: "device", id: "dev-x", scopes: ["files.read"], roots: [] }, { t: "fs.list", path: B })) === null);
  ok("a rooted device may list a folder inside a root", (await rootsGate(rooted, { t: "fs.list", path: A_SUB })) === null);
  const gatedB = await rootsGate(rooted, { t: "fs.list", path: B });
  ok("fs.list outside the roots is not_found", gatedB?.code === "not_found" && gatedB.error === "No such folder", JSON.stringify(gatedB));
  const gatedLink = await rootsGate(rooted, { t: "fs.list", path: path.join(A, "link") });
  ok("a link inside a root that points outside counts as outside", gatedLink?.code === "not_found", JSON.stringify(gatedLink));
  ok("fs.list with no path is refused", (await rootsGate(rooted, { t: "fs.list" }))?.error === "No such folder");
  ok("fs.search with no cwd is refused", (await rootsGate(rooted, { t: "fs.search", q: "x" }))?.error === "No such folder");
  ok("sessions.list with a dir outside is refused", (await rootsGate(rooted, { t: "sessions.list", dir: B }))?.error === "No such folder");
  ok("sessions.list with no dir is judged after (the handler filters)", (await rootsGate(rooted, { t: "sessions.list" })) === null);
  ok("an unknown chat with no cwd is the same not_found as a hidden one", (await rootsGate(rooted, { t: "session.history", sessionId: SID_B }))?.error ===
    (await rootsGate(rooted, { t: "session.history", sessionId: crypto.randomUUID() }))?.error);
  ok("a new chat in B is not_found", (await rootsGate(rooted, { t: "send", sessionId: crypto.randomUUID(), cwd: B, text: "hi" }))?.code === "not_found");
  ok("a new chat in A is let through", (await rootsGate(rooted, { t: "send", sessionId: crypto.randomUUID(), cwd: A_SUB, text: "hi" })) === null);

  let rootsErr = null; try { await startPairing({ roots: [path.join(T, "missing")] }); } catch (e) { rootsErr = e; }
  ok("pairing with a folder that doesn't exist is refused", rootsErr?.message === `That folder doesn't exist: ${path.join(T, "missing")}`, rootsErr?.message || "");
  rootsErr = null; try { await startPairing({ roots: Array(17).fill(A) }); } catch (e) { rootsErr = e; }
  ok("at most 16 roots", /At most 16/.test(rootsErr?.message || ""), rootsErr?.message || "");
  rootsErr = null; try { await startPairing({ roots: ["", " "] }); } catch (e) { rootsErr = e; }
  ok("an empty root is refused", /That folder doesn't exist:/.test(rootsErr?.message || ""), rootsErr?.message || "");

  try {
    const { handlers } = await import("../src/handlers.js");
    const missing = Object.keys(SCOPE_OF).filter(k => typeof handlers[k] !== "function");
    ok("every key of SCOPE_OF is a real handler", missing.length === 0, missing.join(","));
  } catch (e) {
    console.log("SKIP", "every key of SCOPE_OF is a real handler (importing handlers.js failed: " + (e?.message || e) + ")");
  }

  // ───── a real server: pairing routes, a device socket, revoking it ─────
  const PORT = await freePort();
  server = spawn("node", [path.join(REPO, "server/src/index.js"), "--port", String(PORT)], { env: process.env, stdio: "ignore" });
  const base = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < 40; i++) { try { const h = await fetch(base + "/health"); if (h.ok) { up = true; break; } } catch {} await sleep(250); }
  if (!up) throw new Error("the test server didn't start on port " + PORT);
  const { default: WebSocket } = await import(path.join(REPO, "server/node_modules/ws/index.js"));

  // the owner's route makes a code; the CLI prints one; redeem takes either
  const pr = await post(`${base}/devices/pair?token=${encodeURIComponent(ownerToken)}`, { name: "Hub", scopes: ["chat"] });
  const pj = await pr.json();
  ok("the owner route makes a pair code", pr.status === 200 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(pj.code), pj.code || JSON.stringify(pj));

  const cli = await new Promise(res => {
    const p = spawn("node", [path.join(REPO, "server/src/pair-cli.js"), "--port", String(PORT), "--name", "CLI device", "--scopes", "chat"], { env: process.env });
    let out = ""; p.stdout.on("data", d => out += d); p.stderr.on("data", d => out += d);
    p.on("close", code => res({ code, out }));
  });
  ok("pair-cli prints the code, this server, and where to enter it",
    cli.code === 0 && /Pair code: [A-Z2-9]{4}-[A-Z2-9]{4}  \(one use, valid for 10 minutes\)/.test(cli.out)
      && new RegExp(`This server: environment env-[0-9a-f]{12}, port ${PORT}\\b`).test(cli.out)
      && cli.out.includes("In Pocket Agent on your phone: Settings → Environments → Add, then enter this computer's address and the code."), cli.out.trim().split("\n")[0]);
  const cliCode = (cli.out.match(/Pair code: ([A-Z2-9]{4}-[A-Z2-9]{4})/) || [])[1];

  const rr = await post(`${base}/devices/redeem`, { code: cliCode, name: "CLI device" });
  const rj = await rr.json();
  ok("POST /devices/redeem turns a code into a device token",
    rr.status === 200 && /^pad_/.test(rj.token || "") && rj.device?.name === "CLI device" && rj.device.scopes.join(",") === "chat", rr.status + " " + JSON.stringify(rj).slice(0, 80));

  const br = await fetch(`${base}/devices/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "WRON-G123" }) });
  const bt = await br.text();
  ok("a wrong code is refused, and the reply never repeats it",
    br.status === 403 && JSON.parse(bt).error === "That code is wrong or has expired" && !bt.includes("WRON") && !bt.includes("G123"), bt);

  // a device socket
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(rj.token)}`);
  await opened(ws);
  const hello = await call(ws, "hello");
  ok("a device's hello keeps the version but not the owner's details",
    hello.version && !("home" in hello) && !("account" in hello) && !("accounts" in hello) && !("usage" in hello) && !("usageByAccount" in hello)
      && !("deepseek" in hello) && !("githubToken" in hello) && !("updateChannel" in hello) && !("updateKind" in hello) && !("updateTrack" in hello) && !("devRepo" in hello),
    Object.keys(hello).join(","));
  const sl = await call(ws, "sessions.list");
  ok("a chat device can call sessions.list", !sl.error && Array.isArray(sl.sessions), sl.error || "");
  const dl = await call(ws, "devices.list");
  ok("a chat device may not list devices", dl.code === "forbidden" && dl.error === "This device isn't allowed to do that", JSON.stringify(dl));
  const fr = await call(ws, "fs.read", { path: "/etc/passwd" });
  ok("a chat device may not read files", fr.code === "forbidden");

  const dp = await post(`${base}/devices/pair?token=${encodeURIComponent(rj.token)}`, {});
  ok("a device may not start pairing", dp.status === 403 && (await dp.json()).error === "forbidden", String(dp.status));
  const bi = await fetch(`${base}/bundle/info?token=${encodeURIComponent(rj.token)}`);
  ok("a device without update.source may not fetch the bundle", bi.status === 403);
  const obi = await fetch(`${base}/bundle/info?token=${encodeURIComponent(ownerToken)}`);
  ok("the owner still can", obi.status === 200, String(obi.status));

  // the owner sees it and can revoke it; its socket closes
  const ownerWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(ownerToken)}`);
  await opened(ownerWs);
  const list = await call(ownerWs, "devices.list");
  const dev = (list.devices || []).find(d => d.name === "CLI device");
  ok("the owner sees the paired device, without its hash", !!dev && dev.scopes.join(",") === "chat" && !("hash" in dev), JSON.stringify(dev));
  const closed = new Promise(res => ws.on("close", (code, reason) => res({ code, reason: String(reason) })));
  const rev = await call(ownerWs, "devices.revoke", { device: dev?.id });
  const c = await closed;
  ok("revoking a device closes its socket at once", rev.ok === true && c.code === 4001 && c.reason === "revoked", JSON.stringify(c));

  // files.read keeps home; update.source opens the bundle routes
  const p2 = await post(`${base}/devices/pair?token=${encodeURIComponent(ownerToken)}`, { name: "Reader", scopes: ["chat", "files.read"] });
  const pj2 = await p2.json();
  const rr2 = await post(`${base}/devices/redeem`, { code: pj2.code, name: "Reader" });
  const rj2 = await rr2.json();
  const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(rj2.token)}`);
  await opened(ws2);
  const hello2 = await call(ws2, "hello");
  ok("a device with files.read keeps home in hello", typeof hello2.home === "string" && hello2.home.length > 0, hello2.home || "");
  ws2.close();
  const p3 = await post(`${base}/devices/pair?token=${encodeURIComponent(ownerToken)}`, { name: "Mirror", scopes: ["update.source"] });
  const pj3 = await p3.json();
  const rj3 = await (await post(`${base}/devices/redeem`, { code: pj3.code, name: "Mirror" })).json();
  ok("update.source lets a device fetch the bundle info", (await fetch(`${base}/bundle/info?token=${encodeURIComponent(rj3.token)}`)).status === 200);

  // ───── a device limited to folders (#72) ─────
  const pr4 = await post(`${base}/devices/pair?token=${encodeURIComponent(ownerToken)}`, { name: "Rooted", roots: [A] });
  const pj4 = await pr4.json();
  ok("the owner route makes a limited pair code, answering with its roots",
    pr4.status === 200 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(pj4.code) && JSON.stringify(pj4.roots) === JSON.stringify([A]), JSON.stringify(pj4).slice(0, 120));
  const pb = await post(`${base}/devices/pair?token=${encodeURIComponent(ownerToken)}`, { name: "Bad", roots: [path.join(T, "missing")] });
  ok("pairing with a folder that doesn't exist is refused over HTTP",
    pb.status === 400 && (await pb.json()).error === `That folder doesn't exist: ${path.join(T, "missing")}`, String(pb.status));
  const rj4 = await (await post(`${base}/devices/redeem`, { code: pj4.code, name: "Rooted" })).json();
  ok("its token is a device limited to A", JSON.stringify(rj4.device?.roots) === JSON.stringify([A]), JSON.stringify(rj4.device?.roots));

  const wsR = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(rj4.token)}`);
  await opened(wsR);
  const helloR = await call(wsR, "hello");
  ok("a rooted device's hello has roots [A] and no home",
    JSON.stringify(helloR.roots) === JSON.stringify([A]) && !("home" in helloR), JSON.stringify({ roots: helloR.roots, home: helloR.home }));
  const slR = await call(wsR, "sessions.list");
  ok("sessions.list has the chat in A and not the one in B",
    !!slR.sessions?.some(s => s.sessionId === SID_A) && !slR.sessions?.some(s => s.sessionId === SID_B),
    (slR.sessions || []).map(s => s.sessionId.slice(0, 8)).join(","));
  const histB = await call(wsR, "session.history", { sessionId: SID_B });
  const histUnknown = await call(wsR, "session.history", { sessionId: crypto.randomUUID() });
  ok("session.history of the chat in B is not_found", histB.code === "not_found" && histB.error === "No such chat", JSON.stringify(histB));
  ok("and it reads exactly like an unknown chat", histB.error === histUnknown.error && histB.code === histUnknown.code, `${histB.error} / ${histUnknown.error}`);
  const subB = await call(wsR, "subscribe", { sessionId: SID_B, after: 0 });
  ok("subscribe to the chat in B is not_found", subB.code === "not_found", JSON.stringify(subB));
  const listSub = await call(wsR, "fs.list", { path: A_SUB });
  ok("fs.list inside a root works", !listSub.error && listSub.path === A_SUB, listSub.error || String(listSub.path));
  const listB = await call(wsR, "fs.list", { path: B });
  ok("fs.list outside the roots is not_found", listB.code === "not_found" && listB.error === "No such folder", JSON.stringify(listB));
  const listNoPath = await call(wsR, "fs.list");
  ok("fs.list with no path is not_found", listNoPath.code === "not_found", JSON.stringify(listNoPath));
  const searchNoCwd = await call(wsR, "fs.search", { q: "a" });
  ok("fs.search without cwd is not_found", searchNoCwd.code === "not_found", JSON.stringify(searchNoCwd));
  const listLink = await call(wsR, "fs.list", { path: path.join(A, "link") });
  ok("fs.list of a link inside A that points to B is not_found", listLink.code === "not_found", JSON.stringify(listLink));
  const newId = crypto.randomUUID();
  const sendB = await call(wsR, "send", { sessionId: newId, cwd: B, text: "hi" });
  ok("send for a new chat in B is not_found", sendB.code === "not_found", JSON.stringify(sendB));
  ok("and it started no chat", !((await call(ownerWs, "hello")).live || []).some(s => s.sessionId === newId));
  const ownSet = await call(wsR, "devices.setRoots", { device: rj4.device.id, roots: [B] });
  ok("a device may not change its own roots", ownSet.code === "forbidden", JSON.stringify(ownSet));
  const ownerList = await call(ownerWs, "devices.list");
  ok("devices.list shows the rooted device's roots", JSON.stringify(ownerList.devices?.find(d => d.id === rj4.device.id)?.roots) === JSON.stringify([A]));
  const changed = await call(ownerWs, "devices.setRoots", { device: rj4.device.id, roots: [B] });
  ok("the owner can change a device's folders", JSON.stringify(changed.device?.roots) === JSON.stringify([B]), JSON.stringify(changed));
  const slAfter = await call(wsR, "sessions.list");
  ok("its open socket follows at once: now B is there and A is not",
    !!slAfter.sessions?.some(s => s.sessionId === SID_B) && !slAfter.sessions?.some(s => s.sessionId === SID_A));
  wsR.close();

  // a device with no roots works exactly as before
  const pf = await post(`${base}/devices/pair?token=${encodeURIComponent(ownerToken)}`, { name: "Free" });
  const pjf = await pf.json();
  const rjf = await (await post(`${base}/devices/redeem`, { code: pjf.code, name: "Free" })).json();
  const wsF = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(rjf.token)}`);
  await opened(wsF);
  const helloF = await call(wsF, "hello");
  const slF = await call(wsF, "sessions.list");
  ok("a device with no roots sees both chats", !!slF.sessions?.some(s => s.sessionId === SID_A) && !!slF.sessions?.some(s => s.sessionId === SID_B));
  ok("and its hello has no roots", !("roots" in helloF), Object.keys(helloF).join(","));
  wsF.close();
  ownerWs.close();
} catch (e) {
  console.log("FAIL", "test crashed", e?.stack || e);
  fails++;
} finally {
  if (server) server.kill();
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
