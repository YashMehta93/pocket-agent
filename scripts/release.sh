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
# A lock behind package.json gets rewritten by npm on every install, so installs would never match the release.
for d in . server; do
  before=$(cksum < "$d/package-lock.json")
  (cd "$d" && npm install --package-lock-only --omit=optional --no-audit --no-fund >/dev/null 2>&1) || true
  [ "$before" = "$(cksum < "$d/package-lock.json")" ] || { echo "$d/package-lock.json was out of date with package.json; it's updated now, commit it."; exit 1; }
done
REMOTE=$(git remote get-url origin 2>/dev/null || true)
REPO=$(echo "$REMOTE" | sed -E 's#^(https://([^@]+@)?github.com/|git@github.com:)##; s#\.git$##')
$DRY || [ -n "$REPO" ] || { echo "No GitHub remote 'origin'."; exit 1; }

VERSION=$(cat VERSION); TAG="v$VERSION"
# Releases come only from a release line (v1.x, v2.x…) that matches GitHub exactly — i.e. everything
# in it was merged through a pull request (docs/RELEASES.md). PA_RELEASE_BRANCH_OK=1 skips this (first v1.0.0).
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if ! $DRY && [ "${PA_RELEASE_BRANCH_OK:-}" != 1 ]; then
  [[ "$BRANCH" =~ ^v[0-9]+\.x$ ]] || { echo "Release from a release line (e.g. v1.x), not '$BRANCH'."; exit 1; }
  [[ "$VERSION" == "${BRANCH%.x}".* ]] || { echo "VERSION $VERSION doesn't belong to $BRANCH."; exit 1; }
  git fetch -q origin "$BRANCH"
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ] || { echo "$BRANCH differs from GitHub. Merge your PR there, then: git pull --ff-only"; exit 1; }
fi
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && [ "$(git rev-list -n1 "$TAG")" != "$(git rev-parse HEAD)" ]; then
  echo "$TAG already exists on another commit. Bump VERSION first (docs/RELEASES.md)."; exit 1; fi
echo "== build $TAG"
PA_RELEASE=1 bash build.sh >/dev/null
OUT=build/release; rm -rf "$OUT"; mkdir -p "$OUT"
cp build/pocket-agent.apk build/pocket-agent.json "$OUT/"
tar czf "$OUT/bundle.tgz" VERSION server/src server/bin server/devtools server/package.json server/package-lock.json app/assets/ui
node --input-type=module -e 'import { bundleInfo } from "./server/src/transfer.js"; console.log(JSON.stringify(await bundleInfo(process.cwd())))' > "$OUT/bundle.json"
echo "   $TAG: $(ls "$OUT" | tr '\n' ' ')"
$DRY && { echo "dry run: files in $OUT"; exit 0; }

TOKEN=${GITHUB_TOKEN:-$(cat ~/.config/pocket-agent/github-token 2>/dev/null || gh auth token 2>/dev/null || true)}
[ -n "$TOKEN" ] || { echo "Set GITHUB_TOKEN (or save it in ~/.config/pocket-agent/github-token)."; exit 1; }
api() { curl -fsS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "$@"; }
AUTH="Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')"

echo "== push $TAG"
PREV=$(git describe --tags --abbrev=0 2>/dev/null || true)
git tag -a "$TAG" -m "Pocket Agent $VERSION" 2>/dev/null || echo "   (tag exists)"
git -c http.extraHeader="$AUTH" push -q origin "refs/tags/$TAG"   # only the tag: branches change through PRs

echo "== release"
NOTES=$(git log --pretty='- %s' ${PREV:+$PREV..}HEAD | head -40)
# A version with a dash (1.1.0-beta.1) is a pre-release: only apps on the Beta track get it.
BODY=$(node -e 'const v = process.argv[2]; console.log(JSON.stringify({ tag_name: process.argv[1], name: "Pocket Agent " + v, body: process.argv[3], prerelease: v.includes("-") }))' "$TAG" "$VERSION" "$NOTES")
REL=$(api -X POST "https://api.github.com/repos/$REPO/releases" -d "$BODY")
ID=$(echo "$REL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')
for f in "$OUT"/*; do
  n=$(basename "$f"); ct=application/octet-stream
  case "$n" in *.json) ct=application/json ;; *.apk) ct=application/vnd.android.package-archive ;; *.tgz) ct=application/gzip ;; esac
  api -X POST -H "Content-Type: $ct" --data-binary "@$f" "https://uploads.github.com/repos/$REPO/releases/$ID/assets?name=$n" >/dev/null
  echo "   uploaded $n"
done
echo "done: https://github.com/$REPO/releases/tag/$TAG"

# Bring master up to date with the release, through a pull request for the owner to merge.
if [[ "$BRANCH" =~ ^v[0-9]+\.x$ ]] && command -v gh >/dev/null; then
  if [ -z "$(gh pr list --repo "$REPO" --base master --head "$BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null)" ]; then
    gh pr create --repo "$REPO" --base master --head "$BRANCH" --title "Release $TAG into master" \
      --body "Release $TAG from $BRANCH. Merging this is your approval for master (docs/RELEASES.md)." >/dev/null 2>&1 \
      && echo "opened PR: $BRANCH → master (merge it on GitHub)" || echo "(no PR opened: $BRANCH may already match master)"
  else echo "PR $BRANCH → master is already open"; fi
fi
