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
fs.mkdirSync(process.env.PA_DATA, { recursive: true });

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
  const { SCOPES, DEFAULT_SCOPES, SCOPE_OF, allowed, authenticate, listDevices, revokeDevice, renameDevice, startPairing, redeem } = await import("../src/devices.js");
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
