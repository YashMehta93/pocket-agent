// Tests the server ↔ phone channel with a fake phone (no Claude turns, no device needed):
// server→phone RPC round trip, notification specs, legacy app compatibility, update endpoints.
// Usage: PA_PORT=8766 node server/test/native.test.mjs   (server must be running)
const PORT = process.env.PA_PORT || 8765;
import WebSocket from "ws";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { toNative } from "../src/notify.js";

const token = fs.readFileSync(os.homedir() + "/.pocket-agent/token", "utf8").trim();
const base = `http://127.0.0.1:${PORT}`;
let fails = 0;
const ok = (name, c) => { console.log(c ? "PASS" : "FAIL", name); if (!c) fails++; };

/** A fake phone: SSE client that answers rpc calls like Rpc.java would. */
function fakePhone(v) {
  const events = [];
  return new Promise(resolve => {
    const req = http.get(`${base}/events?v=${v}&api=1&token=${token}`, res => {
      let buf = "";
      res.on("data", d => {
        buf += d;
        for (let i; (i = buf.indexOf("\n\n")) >= 0;) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!chunk.startsWith("data: ")) continue;
          const ev = JSON.parse(chunk.slice(6)); events.push(ev);
          if (ev.type === "rpc") {
            const result = ev.method === "device.info" ? { model: "FakePhone", sdk: 34 } : null;
            const body = JSON.stringify(result ? { id: ev.id, result } : { id: ev.id, error: "Unknown method " + ev.method });
            const r = http.request(`${base}/native/result?token=${token}`, { method: "POST", headers: { "content-type": "application/json" } });
            r.end(body);
          }
        }
      });
      resolve({ events, close: () => req.destroy() });
    });
  });
}

// 1. notification specs (pure function)
const specs = toNative({ type: "permission.request", requestId: "r1", sessionId: "s1", toolName: "Bash", input: "npm test", title: "My chat" });
const spec = specs[0]?.spec;
ok("approval → notify spec with Allow/Deny posting to /permission", specs[0]?.type === "notify" && spec.actions?.length === 2 && spec.actions[0].post.path === "/permission" && spec.actions[0].post.body.behavior === "allow");
ok("approval spec only shows in background and honours the setting", spec.onlyWhenBackground && spec.prefKey === "notifyApproval");
ok("question → no inline buttons", !toNative({ type: "permission.request", requestId: "r2", toolName: "AskUserQuestion" })[0].spec.actions);
ok("resolved → cancel", toNative({ type: "permission.resolved", requestId: "r1" })[0].id === "approval:r1");
ok("busy activity → ongoing status with timer", (s => s.id === "status" && s.chronometerStart === 5)(toNative({ type: "activity", phase: "tool", label: "Running a command", turnStart: 5 })[0].spec));
ok("idle activity → back to 'Listening'", toNative({ type: "activity", phase: "idle" })[0].spec.text === "Listening for Claude");

// 2. live server: RPC round trip through a fake v2 phone
const phone = await fakePhone(2);
const legacy = await fakePhone(1);
await new Promise(r => setTimeout(r, 300));
ok("v2 phone gets a batch catch-up on connect", phone.events[0]?.type === "batch");
ok("legacy phone gets the old hello", legacy.events[0]?.type === "hello");
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
await new Promise(r => ws.on("open", r));
let n = 0;
const call = (t, m = {}) => new Promise((res, rej) => { const id = ++n; const h = raw => { const r = JSON.parse(raw); if (r.t === "reply" && r.id === id) { ws.off("message", h); r.error ? rej(new Error(r.error)) : res(r); } }; ws.on("message", h); ws.send(JSON.stringify({ t, id, ...m })); });
const info = await call("native.call", { method: "device.info" });
ok(`server → phone rpc returns result (${info.result?.model})`, info.result?.model === "FakePhone");
let err = null; try { await call("native.call", { method: "nope" }); } catch (e) { err = e.message; }
ok(`rpc errors propagate ("${err}")`, /Unknown method/.test(err || ""));

// 3. updates
const up = await call("app.update");
ok(`app.update reports the built APK (v${up.versionName}, code ${up.versionCode})`, up.versionCode > 0 && up.url === "/apk/download");
const dl = await new Promise(r => http.get(`${base}/apk/download?token=${token}`, res => { let size = 0; res.on("data", d => size += d.length); res.on("end", () => r({ code: res.statusCode, size })); }));
ok(`APK download works (${dl.size} bytes)`, dl.code === 200 && dl.size > 50000);
const noTok = await new Promise(r => http.get(`${base}/apk/download`, res => { res.resume(); r(res.statusCode); }));
ok("APK download needs the token", noTok === 401);

phone.close(); legacy.close(); ws.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
