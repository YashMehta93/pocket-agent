#!/usr/bin/env bash
# Upgrade from an old release, as friends' phones do: a throwaway install running the code of tag v1.0.0
# (PA_FROM_TAG to change) takes the current code from a fake GitHub release, restarts on it, and must then
# be up to date: no update offered again, every file of the new code in place. No network needed.
set -uo pipefail
cd "$(dirname "$0")/../.."
REPO=$PWD; FROM=${PA_FROM_TAG:-v1.0.0}; T=$(mktemp -d); PIDS=""
trap 'kill $PIDS 2>/dev/null; rm -rf "$T"' EXIT
git rev-parse -q --verify "refs/tags/$FROM" >/dev/null || { echo "SKIP: tag $FROM isn't here (git fetch --tags)"; exit 0; }
if [ ! -f build/release/bundle.tgz ] || [ -n "$(find server/src server/devtools server/trusted-keys.json app/assets/ui -newer build/release/bundle.tgz | head -1)" ]; then
  bash scripts/release.sh --dry-run >/dev/null
fi

# fake public GitHub: the dry-run release as v9.9.9
node -e '
const http = require("http"), fs = require("fs"), dir = process.argv[1];
http.createServer((q, r) => {
  const rel = { tag_name: "v9.9.9", draft: false, prerelease: false, assets: fs.readdirSync(dir).map(n => ({ name: n, url: "http://127.0.0.1:8779/assets/" + n })) };
  if (q.url === "/repos/me/pa/releases/latest") { r.writeHead(200, { "content-type": "application/json" }); return r.end(JSON.stringify(rel)); }
  const m = q.url.match(/^\/assets\/(.+)$/);
  if (m && fs.existsSync(dir + "/" + m[1])) { r.writeHead(200); return r.end(fs.readFileSync(dir + "/" + m[1])); }
  r.writeHead(404); r.end();
}).listen(8779);' "$REPO/build/release" & PIDS="$PIDS $!"

mkdir -p "$T/home" "$T/root"
git archive "$FROM" | tar x -C "$T/root"
node -e 'const f = process.argv[1], p = JSON.parse(require("fs").readFileSync(f, "utf8")); p.pocketAgent = { githubRepo: "me/pa" }; require("fs").writeFileSync(f, JSON.stringify(p, null, 2))' "$T/root/server/package.json"
ln -s "$REPO/server/node_modules" "$T/root/server/node_modules"
start() { (cd "$T/root" && exec env -u PA_MODE HOME="$T/home" PA_DATA="$T/home/.pocket-agent" PA_SUPERVISED=1 PA_GITHUB_API=http://127.0.0.1:8779 node server/src/index.js --port 8768 >> "$T/log" 2>&1) & SPID=$!; PIDS="$PIDS $SPID"
  for i in $(seq 1 40); do [ -f "$T/home/.pocket-agent/token" ] && curl -fs http://127.0.0.1:8768/health >/dev/null && return; sleep 0.3; done; }
call() { T="$T" node -e '
const WebSocket = require(process.argv[1] + "/server/node_modules/ws"), fs = require("fs");
const ws = new WebSocket("ws://127.0.0.1:8768/ws?token=" + fs.readFileSync(process.env.T + "/home/.pocket-agent/token", "utf8").trim());
ws.on("open", () => ws.send(JSON.stringify({ t: process.argv[2], id: 1 })));
ws.on("message", r => { const m = JSON.parse(r); if (m.id === 1) { console.log(JSON.stringify(m)); process.exit(0); } });' "$REPO" "$1"; }
fails=0; ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails+1)); fi; }

start
chk=$(call update.check); ok "a $FROM install sees the new release" "$(echo "$chk" | grep -q '"available":true' && echo 1)"
app=$(call update.apply); ok "and applies it" "$(echo "$app" | grep -q '"updated":true' && echo 1)"
for i in $(seq 1 30); do kill -0 $SPID 2>/dev/null || break; sleep 0.3; done
start
chk2=$(call update.check)
ok "after restarting on the new code, no update is offered again ($(echo "$chk2" | grep -o '"local":{"hash":"[^"]*"'))" "$(echo "$chk2" | grep -q '"available":false' && echo 1)"
missing=$(cd "$T/root" && tar tzf "$REPO/build/release/bundle.tgz" | grep -v '/$' | while read f; do [ -e "$f" ] || echo "$f"; done)
ok "every file of the new code is in place${missing:+ (missing: $missing)}" "$([ -z "$missing" ] && echo 1)"
[ $fails = 0 ] && echo "ALL PASSED" || { echo "$fails FAILED"; tail -5 "$T/log"; exit 1; }
