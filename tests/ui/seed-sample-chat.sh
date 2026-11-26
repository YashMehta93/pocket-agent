#!/bin/sh
# Gives the screen test a chat to open on a machine with none, such as CI: copies the made-up chat in fixtures/
# to $HOME/.claude/projects only, never CLAUDE_CONFIG_DIR; refuses a real Pocket Agent home; looks through links.
set -e
if [ -e "$HOME/.pocket-agent/prefs.json" ]; then echo "refusing: $HOME is a real Pocket Agent home"; exit 1; fi
projects="$HOME/.claude/projects"
if [ -n "$(find -L "$projects" -name '*.jsonl' 2>/dev/null | head -1)" ]; then echo "chats exist; no sample added"; exit 0; fi
mkdir -p "$projects/-tmp-pa-sample"
cp "$(dirname "$0")/fixtures/sample-chat.jsonl" "$projects/-tmp-pa-sample/11111111-2222-4333-8444-555555555555.jsonl"
echo "added a sample chat to $projects"
