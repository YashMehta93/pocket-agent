#!/usr/bin/env bash
# Opens a pull request for the current branch into the shared line (default v1.x), without needing `gh`.
#   bash scripts/open-pr.sh "Add a dark widget" [base]        body: $PR_BODY, or the commit list
# Push the branch first: git push -u origin HEAD. Token: $GITHUB_TOKEN, ~/.config/pocket-agent/github-token
# (saved by Build Pocket Agent yourself; needs Contents + Pull requests: read and write), or `gh auth token`.
set -euo pipefail
cd "$(dirname "$0")/.."
TITLE="${1:?usage: bash scripts/open-pr.sh \"Title\" [base]}"; BASE="${2:-}"
HEAD=$(git branch --show-current)
case "$HEAD" in master|main|v[0-9]*.0|v[0-9]*.x) echo "Open PRs from a feat/… or fix/… branch, not $HEAD."; exit 1 ;; esac
[ -n "$BASE" ] || BASE=$(git branch -r --list 'origin/v*.x' | sed 's#.*origin/##' | sort -V | tail -1)
[ -n "$BASE" ] || BASE=master
REPO=$(git config --get remote.origin.url | sed -E 's#^(https://([^@]+@)?github.com/|git@github.com:)##; s#\.git$##')
TOKEN="${GITHUB_TOKEN:-$(cat ~/.config/pocket-agent/github-token 2>/dev/null || gh auth token 2>/dev/null || true)}"
[ -n "$TOKEN" ] || { echo "No GitHub token (see the comment at the top of this script)."; exit 1; }
git fetch -q origin "$BASE" || true
BODY="${PR_BODY:-$(git log --format='- %s' "origin/$BASE..HEAD" 2>/dev/null | head -50)}"
BODY="$BODY

From \`$HEAD\`, opened with scripts/open-pr.sh."
JSON=$(node -e 'process.stdout.write(JSON.stringify({ title: process.argv[1], head: process.argv[2], base: process.argv[3], body: process.argv[4] }))' "$TITLE" "$HEAD" "$BASE" "$BODY")
RES=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "${PA_GITHUB_API:-https://api.github.com}/repos/$REPO/pulls" -d "$JSON")
URL=$(printf '%s' "$RES" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(r.html_url)console.log(r.html_url);else{console.error("GitHub said:",r.message,JSON.stringify(r.errors||""));process.exit(1)}})')
echo "Pull request: $URL"
