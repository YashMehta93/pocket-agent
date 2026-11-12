#!/usr/bin/env bash
# Publishes a Pocket Agent release on GitHub — what friends' apps update from.
#
#   bash scripts/release.sh            build, tag vX.Y.Z, create the release, upload the files
#   bash scripts/release.sh --dry-run  build and package only (build/release/)
#
# Release files (the app looks for these names):
#   pocket-agent.apk    the app, signed with ./pocket-agent.keystore (keep that file secret and backed up:
#                       updates only install over an app signed with the same key)
#   pocket-agent.json   { versionCode, versionName } of the APK
#   bundle.tgz          server + UI code, for in-app "Check for updates"
#   bundle.json         { hash } of that code
#
# Needs a GitHub token with "Contents: read and write" on the repo, from $GITHUB_TOKEN or
# ~/.config/pocket-agent/github-token (or `gh auth token` if the GitHub CLI is logged in).
set -euo pipefail
cd "$(dirname "$0")/.."
DRY=false; [ "${1:-}" = "--dry-run" ] && DRY=true

$DRY || [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Commit your changes first (git status)."; exit 1; }
REMOTE=$(git remote get-url origin 2>/dev/null || true)
REPO=$(echo "$REMOTE" | sed -E 's#^(https://([^@]+@)?github.com/|git@github.com:)##; s#\.git$##')
$DRY || [ -n "$REPO" ] || { echo "No GitHub remote 'origin'."; exit 1; }

echo "== build"
bash build.sh >/dev/null
OUT=build/release; rm -rf "$OUT"; mkdir -p "$OUT"
cp build/pocket-agent.apk build/pocket-agent.json "$OUT/"
tar czf "$OUT/bundle.tgz" server/src server/bin server/devtools server/package.json server/package-lock.json app/assets/ui
node --input-type=module -e 'import { bundleInfo } from "./server/src/transfer.js"; console.log(JSON.stringify(await bundleInfo(process.cwd())))' > "$OUT/bundle.json"
VERSION=$(node -p 'require("./build/pocket-agent.json").versionName'); TAG="v$VERSION"
echo "   $TAG: $(ls "$OUT" | tr '\n' ' ')"
$DRY && { echo "dry run: files in $OUT"; exit 0; }

TOKEN=${GITHUB_TOKEN:-$(cat ~/.config/pocket-agent/github-token 2>/dev/null || gh auth token 2>/dev/null || true)}
[ -n "$TOKEN" ] || { echo "Set GITHUB_TOKEN (or save it in ~/.config/pocket-agent/github-token)."; exit 1; }
api() { curl -fsS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "$@"; }
AUTH="Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')"

echo "== push $TAG"
PREV=$(git describe --tags --abbrev=0 2>/dev/null || true)
git tag -a "$TAG" -m "Pocket Agent $VERSION" 2>/dev/null || echo "   (tag exists)"
git -c http.extraHeader="$AUTH" push -q origin HEAD "$TAG"

echo "== release"
NOTES=$(git log --pretty='- %s' ${PREV:+$PREV..}HEAD | head -40)
BODY=$(node -e 'console.log(JSON.stringify({ tag_name: process.argv[1], name: "Pocket Agent " + process.argv[2], body: process.argv[3] }))' "$TAG" "$VERSION" "$NOTES")
REL=$(api -X POST "https://api.github.com/repos/$REPO/releases" -d "$BODY")
ID=$(echo "$REL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')
for f in "$OUT"/*; do
  n=$(basename "$f"); ct=application/octet-stream
  case "$n" in *.json) ct=application/json ;; *.apk) ct=application/vnd.android.package-archive ;; *.tgz) ct=application/gzip ;; esac
  api -X POST -H "Content-Type: $ct" --data-binary "@$f" "https://uploads.github.com/repos/$REPO/releases/$ID/assets?name=$n" >/dev/null
  echo "   uploaded $n"
done
echo "done: https://github.com/$REPO/releases/tag/$TAG"
