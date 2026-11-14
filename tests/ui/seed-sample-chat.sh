#!/bin/sh
# Gives the screen test a chat to open on a machine with none, such as CI: copies the made-up chat in
# fixtures/ to where Claude Code keeps chats. Does nothing where chats already exist, so real ones stay untouched.
set -e
projects="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
if [ -n "$(find "$projects" -name '*.jsonl' 2>/dev/null | head -1)" ]; then echo "chats exist; no sample added"; exit 0; fi
mkdir -p "$projects/-tmp-pa-sample"
cp "$(dirname "$0")/fixtures/sample-chat.jsonl" "$projects/-tmp-pa-sample/11111111-2222-4333-8444-555555555555.jsonl"
echo "added a sample chat to $projects"
