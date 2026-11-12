#!/usr/bin/env bash
# Tests chat import + update channel between two servers: the running Termux server (source, 8765)
# and a throwaway "app" server (target, 8766) with its own empty HOME and its own copy of the code.
set -uo pipefail
cd "$(dirname "$0")/../.."
REPO=$PWD; T=$(mktemp -d); trap 'kill $PID 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/root/server" "$T/root/app/assets"
cp -r server/src server/bin server/package.json server/package-lock.json "$T/root/server/"
ln -s "$REPO/server/node_modules" "$T/root/server/node_modules"
cp -r app/assets/ui "$T/root/app/assets/"
echo "/* local edit that the update must replace */" >> "$T/root/app/assets/ui/css/app.css"
(env -u PA_MODE HOME="$T/home" PA_DATA="$T/home/.pocket-agent" PA_SUPERVISED=1 node "$T/root/server/src/index.js" --port 8766 > "$T/server.log" 2>&1) & PID=$!
for i in $(seq 1 30); do curl -fs http://127.0.0.1:8766/health >/dev/null && break; sleep 0.3; done
SRC_TOKEN=$(cat ~/.pocket-agent/token) TGT_TOKEN=$(cat "$T/home/.pocket-agent/token") TROOT="$T/root" REPO="$REPO" PID=$PID node --input-type=module -e '
import WebSocket from "'"$REPO"'/server/node_modules/ws/index.js";
import fs from "node:fs";
let fails = 0; const ok = (n, c) => { console.log(c ? "PASS" : "FAIL", n); if (!c) fails++; };
const ws = new WebSocket("ws://127.0.0.1:8766/ws?token=" + process.env.TGT_TOKEN);
await new Promise(r => ws.on("open", r));
let n = 0; const call = (t, m = {}) => new Promise((res, rej) => { const id = ++n; const h = raw => { const r = JSON.parse(raw); if (r.t === "reply" && r.id === id) { ws.off("message", h); r.error ? rej(new Error(r.error)) : res(r); } }; ws.on("message", h); ws.send(JSON.stringify({ t, id, ...m })); });
const src = { url: "http://127.0.0.1:8765", token: process.env.SRC_TOKEN };
const before = (await call("sessions.list")).sessions.length;
ok(`target starts with ${before} chats`, before === 0);
let bad = null; try { await call("sessions.import", { ...src, token: "wrong" }); } catch (e) { bad = e.message; }
ok(`wrong token is reported clearly ("${bad}")`, /wrong token/.test(bad || ""));
const r = await call("sessions.import", src);
ok(`import copied chats (added ${r.added})`, r.added > 0);
const list = (await call("sessions.list")).sessions;
ok(`imported chats are listed (${list.length})`, list.length > 0);
const one = list[0];
const hist = await call("session.history", { sessionId: one.sessionId });
ok(`an imported chat opens with its history ("${(one.title || "").slice(0, 30)}", ${hist.messages.length} messages)`, hist.messages.length > 0);
const again = await call("sessions.import", src);
ok(`re-import is idempotent (added ${again.added}, unchanged ${again.unchanged})`, again.added === 0);
const chk = await call("update.check", src);
ok("update check sees the difference", chk.available === true && chk.remote.hash !== chk.local.hash);
await call("update.channel", src);
const hello = await call("hello");
ok("update source is remembered", hello.updateChannel === src.url);
const ap = await call("update.apply");
ok("update applied", ap.updated === true);
await new Promise(r => setTimeout(r, 2500));
const css = fs.readFileSync(process.env.TROOT + "/app/assets/ui/css/app.css", "utf8");
ok("UI files replaced by the source version", !css.includes("local edit that the update must replace") && css === fs.readFileSync(process.env.REPO + "/app/assets/ui/css/app.css", "utf8"));
let alive = true; try { process.kill(+process.env.PID, 0); } catch { alive = false; }
ok("server exited to be restarted by its supervisor", !alive);
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED"); process.exit(fails ? 1 : 0);
'
