#!/usr/bin/env bash
# Updating from earlier installs, as friends' phones do, against a fake public GitHub serving this code
# as release v9.9.9 (from `scripts/release.sh --dry-run`). No network needed.
#   1. An install running the code of tag v1.0.0 (PA_FROM_TAG to change) takes the release, restarts on
#      it, and must then be up to date with every file of the new code in place.
#   2. A fresh install from the release's APK (laid out the way the app unpacks it) must be up to date
#      straight away, and an app open must cost at most one GitHub API request.
set -uo pipefail
cd "$(dirname "$0")/../.."
REPO=$PWD; FROM=${PA_FROM_TAG:-v1.0.0}; T=$(mktemp -d); PIDS=""
trap 'kill $PIDS 2>/dev/null; rm -rf "$T"' EXIT
if [ ! -f build/release/bundle.tgz ] || [ -n "$(find server/src server/devtools server/trusted-keys.json app/assets/ui -newer build/release/bundle.tgz | head -1)" ]; then
  bash scripts/release.sh --dry-run >/dev/null
fi

# fake public GitHub: the dry-run release as v9.9.9; API requests (/repos/...) are counted, GET /count
# returns and resets the count. Files come by API (/assets/, what old code uses) or public link (/download/).
node -e '
const http = require("http"), fs = require("fs"), dir = process.argv[1];
let api = 0;
http.createServer((q, r) => {
  if (q.url === "/count") { r.writeHead(200); r.end(String(api)); api = 0; return; }
  if (q.url.startsWith("/repos/")) api++;
  const names = fs.readdirSync(dir);
  const rel = { tag_name: "v9.9.9", draft: false, prerelease: false,
    assets: names.map(n => ({ name: n, url: "http://127.0.0.1:8779/assets/" + n, browser_download_url: "http://127.0.0.1:8779/download/" + n })) };
  if (q.url === "/repos/me/pa/releases/latest") { r.writeHead(200, { "content-type": "application/json" }); return r.end(JSON.stringify(rel)); }
  const m = q.url.match(/^\/(assets|download)\/(.+)$/);
  if (m && names.includes(m[2])) { r.writeHead(200); return r.end(fs.readFileSync(dir + "/" + m[2])); }
  r.writeHead(404); r.end();
}).listen(8779);' "$REPO/build/release" & PIDS="$PIDS $!"
for i in $(seq 1 30); do curl -fs http://127.0.0.1:8779/count >/dev/null && break; sleep 0.2; done

fails=0; ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails+1)); fi; }
# start <root> <home>: the app's server on port 8768, from that install, following me/pa on the fake GitHub
start() { (cd "$1" && exec env -u PA_MODE HOME="$2" PA_DATA="$2/.pocket-agent" PA_SUPERVISED=1 PA_GITHUB_API=http://127.0.0.1:8779 node server/src/index.js --port 8768 >> "$T/log" 2>&1) & SPID=$!; PIDS="$PIDS $SPID"
  for i in $(seq 1 40); do [ -f "$2/.pocket-agent/token" ] && curl -fs http://127.0.0.1:8768/health >/dev/null && return; sleep 0.3; done; }
stop() { kill $SPID 2>/dev/null; for i in $(seq 1 30); do kill -0 $SPID 2>/dev/null || return; sleep 0.2; done; }
call() { node -e '
const WebSocket = require(process.argv[1] + "/server/node_modules/ws"), fs = require("fs");
const ws = new WebSocket("ws://127.0.0.1:8768/ws?token=" + fs.readFileSync(process.argv[2] + "/.pocket-agent/token", "utf8").trim());
ws.on("open", () => ws.send(JSON.stringify({ t: process.argv[3], id: 1 })));
ws.on("message", r => { const m = JSON.parse(r); if (m.id === 1) { console.log(JSON.stringify(m)); process.exit(0); } });' "$REPO" "$1" "$2"; }
follow_fake() { node -e 'const f = process.argv[1], p = JSON.parse(require("fs").readFileSync(f, "utf8")); p.pocketAgent = { githubRepo: "me/pa" }; require("fs").writeFileSync(f, JSON.stringify(p, null, 2))' "$1/server/package.json"; }

# ── 1. from an old release's code ──
if git rev-parse -q --verify "refs/tags/$FROM" >/dev/null; then
  R1="$T/old"; H1="$T/home1"; mkdir -p "$R1" "$H1"
  git archive "$FROM" | tar x -C "$R1"; follow_fake "$R1"; ln -s "$REPO/server/node_modules" "$R1/server/node_modules"
  start "$R1" "$H1"
  chk=$(call "$H1" update.check); ok "a $FROM install sees the new release" "$(echo "$chk" | grep -q '"available":true' && echo 1)"
  app=$(call "$H1" update.apply); ok "and applies it" "$(echo "$app" | grep -q '"updated":true' && echo 1)"
  for i in $(seq 1 30); do kill -0 $SPID 2>/dev/null || break; sleep 0.3; done
  start "$R1" "$H1"
  chk2=$(call "$H1" update.check)
  ok "after restarting on the new code, no update is offered again ($(echo "$chk2" | grep -o '"local":{"hash":"[^"]*"'))" "$(echo "$chk2" | grep -q '"available":false' && echo 1)"
  missing=$(cd "$R1" && tar tzf "$REPO/build/release/bundle.tgz" | grep -v '/$' | while read f; do [ -e "$f" ] || echo "$f"; done)
  ok "every file of the new code is in place${missing:+ (missing: $missing)}" "$([ -z "$missing" ] && echo 1)"
  stop
else echo "SKIP 1: tag $FROM isn't here (git fetch --tags)"; fi

# ── 2. a fresh install from the release's APK ──
R2="$T/apk"; H2="$T/home2"; mkdir -p "$R2/app/assets" "$H2" "$T/unz"
(cd "$T/unz" && unzip -q "$REPO/build/release/pocket-agent.apk" 'assets/*')
cp -r "$T/unz/assets/server" "$R2/server"; cp -r "$T/unz/assets/ui" "$R2/app/assets/ui"; cp "$T/unz/assets/bundle.json" "$R2/bundle.json"   # what Linux.syncBundle does
ln -s "$REPO/server/node_modules" "$R2/server/node_modules"
# point it at the fake GitHub through the app's preferences: editing package.json would make it differ from the release
mkdir -p "$H2/.pocket-agent"; echo '{"pinned":[],"defaults":{},"updateChannel":{"github":"me/pa","token":""}}' > "$H2/.pocket-agent/prefs.json"
start "$R2" "$H2"
curl -fs http://127.0.0.1:8779/count >/dev/null   # count from here
chk3=$(call "$H2" update.check); app3=$(call "$H2" app.update)
n=$(curl -fs http://127.0.0.1:8779/count)
ok "a fresh APK install is up to date straight away ($(echo "$chk3" | grep -o '"local":{"hash":"[^"]*"'))" "$(echo "$chk3" | grep -q '"available":false' && echo 1)"
ok "and an app open costs at most one GitHub API request ($n)" "$([ "$n" -le 1 ] && echo 1)"
stop

[ $fails = 0 ] && echo "ALL PASSED" || { echo "$fails FAILED"; tail -5 "$T/log"; exit 1; }
