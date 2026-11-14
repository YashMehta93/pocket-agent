#!/usr/bin/env bash
# Makes the repo's GitHub labels match .github/labels.json (the single place the label scheme is defined).
#   bash scripts/sync-labels.sh           create missing labels, update colours and descriptions
#   bash scripts/sync-labels.sh --prune   also delete labels that aren't in the file (they disappear from issues)
# Needs the GitHub CLI (gh), logged in with write access. Change the scheme by editing the JSON, then run this.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(git config --get remote.origin.url | sed -E 's#^(https://([^@]+@)?github.com/|git@github.com:)##; s#\.git$##')
GH=$(command -v gh || echo "$HOME/.local/bin/gh")
want=$(node -e 'for (const l of JSON.parse(require("fs").readFileSync(".github/labels.json", "utf8"))) console.log([l.name, l.color, l.description].join("\t"))')
have=$("$GH" label list --repo "$REPO" --limit 200 --json name --jq '.[].name')
while IFS=$'\t' read -r name color desc; do
  if grep -Fxq "$name" <<<"$have"; then "$GH" label edit "$name" --repo "$REPO" --color "$color" --description "$desc" >/dev/null && echo "updated  $name"
  else "$GH" label create "$name" --repo "$REPO" --color "$color" --description "$desc" >/dev/null && echo "created  $name"; fi
done <<<"$want"
if [ "${1:-}" = "--prune" ]; then
  while read -r name; do
    [ -n "$name" ] || continue
    cut -f1 <<<"$want" | grep -Fxq "$name" || { "$GH" label delete "$name" --repo "$REPO" --yes >/dev/null && echo "deleted  $name"; }
  done <<<"$have"
fi
