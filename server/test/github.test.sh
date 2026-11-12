#!/usr/bin/env bash
# Tests updating from GitHub releases (what friends' apps do) against a fake GitHub API that
# behaves like a private repo: no token → 404, right token → the release made by
# `scripts/release.sh --dry-run`. A throwaway "fresh install" server (own HOME, own code copy,
# repo baked into package.json) checks, applies and downloads the APK. No network needed.
set -uo pipefail
cd "$(dirname "$0")/../.."
REPO=$PWD; T=$(mktemp -d); PIDS=""
trap 'kill $PIDS 2>/dev/null; [ -n "${SHOWLOG:-}" ] && tail -15 "$T/server.log"; rm -rf "$T"' EXIT
[ -f build/release/bundle.tgz ] || bash scripts/release.sh --dry-run >/dev/null

# fake GitHub: GET /repos/me/pa/releases/latest and /assets/<name>, token "t0k" required
node -e '
const http = require("http"), fs = require("fs"), dir = process.argv[1];
const names = ["pocket-agent.apk", "pocket-agent.json", "bundle.tgz", "bundle.json"];
http.createServer((q, r) => {
  if (q.headers.authorization !== "Bearer t0k") { r.writeHead(404); return r.end("{}"); }
  if (q.url === "/repos/me/pa/releases/latest") {
    r.writeHead(200, { "content-type": "application/json" });
    return r.end(JSON.stringify({ tag_name: "v9.9.9", assets: names.map(n => ({ name: n, url: "http://127.0.0.1:8777/assets/" + n })) }));
  }
  const m = q.url.match(/^\/assets\/(.+)$/);
  if (m && names.includes(m[1]) && q.headers.accept === "application/octet-stream") { r.writeHead(200); return r.end(fs.readFileSync(dir + "/" + m[1])); }
  r.writeHead(404); r.end();
}).listen(8777);' "$REPO/build/release" & PIDS="$PIDS $!"

mkdir -p "$T/home" "$T/root/server" "$T/root/app/assets"
cp -r server/src server/bin server/devtools server/package-lock.json "$T/root/server/"
node -e 'const p = require(process.argv[1] + "/server/package.json"); p.pocketAgent = { githubRepo: "me/pa" }; require("fs").writeFileSync(process.argv[2], JSON.stringify(p, null, 2))' "$REPO" "$T/root/server/package.json"
ln -s "$REPO/server/node_modules" "$T/root/server/node_modules"
cp -r app/assets/ui "$T/root/app/assets/"; echo "/* older */" >> "$T/root/app/assets/ui/css/app.css"
(env -u PA_MODE HOME="$T/home" PA_DATA="$T/home/.pocket-agent" PA_SUPERVISED=1 PA_GITHUB_API=http://127.0.0.1:8777 node "$T/root/server/src/index.js" --port 8767 > "$T/server.log" 2>&1) & SPID=$!; PIDS="$PIDS $SPID"
for i in $(seq 1 30); do curl -fs http://127.0.0.1:8767/health >/dev/null && break; sleep 0.3; done

TOK=$(cat "$T/home/.pocket-agent/token") T="$T" REPO="$REPO" SPID=$SPID node --input-type=module -e '
import WebSocket from "'"$REPO"'/server/node_modules/ws/index.js";
import fs from "node:fs";
let fails = 0; const ok = (n, c) => { console.log(c ? "PASS" : "FAIL", n); if (!c) fails++; };
const ws = new WebSocket("ws://127.0.0.1:8767/ws?token=" + process.env.TOK);
await new Promise(r => ws.on("open", r));
let n = 0; const call = (t, m = {}) => new Promise((res, rej) => { const id = ++n; const h = raw => { const r = JSON.parse(raw); if (r.t === "reply" && r.id === id) { ws.off("message", h); r.error ? rej(new Error(r.error)) : res(r); } }; ws.on("message", h); ws.send(JSON.stringify({ t, id, ...m })); });
const err = async p => { try { await p; return null; } catch (e) { return e.message; } };
const hello = await call("hello");
ok(`fresh install follows the repo in package.json (${hello.updateChannel})`, hello.updateChannel === "github.com/me/pa" && hello.updateKind === "github");
const noTok = await err(call("update.check"));
ok(`private repo without a token says what to do ("${noTok}")`, /add a GitHub token/.test(noTok || ""));
await call("update.channel", { github: "https://github.com/me/pa.git", token: "t0k" });
const h2 = await call("hello");
ok("token saved, repo URL normalised", h2.updateChannel === "github.com/me/pa" && h2.githubToken === true);
const chk = await call("update.check");
ok(`update found in release ${chk.remote?.release}`, chk.available === true);
const app = await call("app.update");
const want = JSON.parse(fs.readFileSync(process.env.REPO + "/build/release/pocket-agent.json", "utf8"));
ok(`APK version from the release (${app.versionName})`, app.versionCode === want.versionCode && app.url === "/apk/download");
const dl = await fetch("http://127.0.0.1:8767/apk/download?token=" + process.env.TOK);
const apk = Buffer.from(await dl.arrayBuffer());
ok(`APK streams through the app server (${apk.length} bytes)`, dl.ok && apk.equals(fs.readFileSync(process.env.REPO + "/build/release/pocket-agent.apk")));
// rollback guard: an app that already runs newer code must refuse the (older) release
fs.writeFileSync(process.env.T + "/root/applied.json", JSON.stringify({ build: 999999 }));
const old = await call("update.check");
ok(`older release is not offered (release build ${old.remote?.build} < app build ${old.local?.build})`, old.older === true && old.available === false);
const refused = await err(call("update.apply"));
ok(`applying it is refused ("${(refused || "").slice(0, 60)}…")`, /older code/.test(refused || ""));
fs.unlinkSync(process.env.T + "/root/applied.json");
const ap = await call("update.apply");
ok("update applied", ap.updated === true);
await new Promise(r => setTimeout(r, 2500));
const css = fs.readFileSync(process.env.T + "/root/app/assets/ui/css/app.css", "utf8");
ok("code replaced by the release version", !css.includes("/* older */"));
ok("the applied build is recorded for the next check", JSON.parse(fs.readFileSync(process.env.T + "/root/applied.json", "utf8")).build > 0);
let alive = true; try { process.kill(+process.env.SPID, 0); } catch { alive = false; }
ok("server exited to be restarted by the app", !alive);
// restart it like the app does: the same release must now count as installed (no update offered again)
const { spawn } = await import("node:child_process");
const env = { ...process.env, HOME: process.env.T + "/home", PA_DATA: process.env.T + "/home/.pocket-agent", PA_SUPERVISED: "1", PA_GITHUB_API: "http://127.0.0.1:8777" }; delete env.PA_MODE;
const srv = spawn("node", [process.env.T + "/root/server/src/index.js", "--port", "8767"], { env, stdio: "ignore" });
for (let i = 0; i < 40; i++) { try { if ((await fetch("http://127.0.0.1:8767/health")).ok) break; } catch {} await new Promise(r => setTimeout(r, 300)); }
const ws2 = new WebSocket("ws://127.0.0.1:8767/ws?token=" + process.env.TOK); await new Promise(r => ws2.on("open", r));
const again = await new Promise(res => { ws2.on("message", raw => { const r = JSON.parse(raw); if (r.t === "reply" && r.id === 1) res(r); }); ws2.send(JSON.stringify({ t: "update.check", id: 1 })); });
ok(`after restarting, the release counts as installed (local ${again.local?.hash} = release ${again.remote?.hash})`, again.available === false && again.local?.hash === again.remote?.hash);
ws2.close(); srv.kill();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED"); process.exit(fails ? 1 : 0);
'
