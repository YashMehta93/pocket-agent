# Architecture

Pocket Agent is a phone UI for **Claude Code**. The model runs on Anthropic's servers; Claude Code (the agent loop + tools) runs on a Linux environment we control; the app is the remote control.

```
┌──────────── Android app (app/) ─────────────┐
│ WebView ── loads the UI from the server      │  app/assets/ui (HTML/CSS/JS)
│ Java: MainActivity (bridge window.PA),        │  notifications, voice, camera,
│       NotifyService (SSE), ActionReceiver     │  share sheet, shortcuts
└──────────┬───────────────────────────────────┘
           │ WebSocket /ws  +  SSE /events   (127.0.0.1:8765, shared token)
┌──────────▼──────────── server/ (Node) ──────────────────────────┐
│ http.js        routes, UI files, SSE, WS upgrade                  │
│ handlers.js    WS request handlers (docs/PROTOCOL.md)             │
│ live-session.js one LiveSession per running chat                  │
│ activity.js    raw SDK events → "what is Claude doing" + step log │
│        │ Claude Agent SDK: query({ prompt: Inbox, options })     │
│        ▼                                                          │
│ claude  (Claude Code CLI process, one per live chat)              │
│   runs tools here: Bash, Read/Edit, git, MCP…                     │
│   stores chats in ~/.claude/projects/<dir>/<sessionId>.jsonl      │
└───────────────────────────────┬──────────────────────────────────┘
                                │ HTTPS
                         Anthropic API
```

## Where things run today, and where they're going

| | Today | Next (see README "Roadmap") |
|---|---|---|
| Linux environment | Termux (`claude` = proot launcher) | bundled inside the APK (proot + Debian rootfs), no Termux |
| Server start | Termux `pocket-agent start` (app triggers it via RUN_COMMAND) | the app's foreground service |
| Remote compute | — | same server on a PC, reached over SSH/Tailscale |

The protocol between app and server stays the same in all cases; that's the contract that keeps the pieces swappable.

## Lifecycle of one message

1. UI `send` → server `handlers.send` → `openSession` (resumes the chat from disk if needed) → `LiveSession.send` pushes a user message into the session's `Inbox` (the SDK's streaming input).
2. The SDK streams messages back (`stream_event` deltas, `assistant`, `user` tool results, `system` status, `result`). `LiveSession.pump` relays each as `{ t: "ev" }` to subscribed clients and feeds it to `Activity`.
3. When Claude wants to use a tool, the SDK calls `canUseTool` → `LiveSession.askPermission` → `{ t: "permission.request" }` to the UI and an SSE event to the notification service. The answer (`permission.reply` or `POST /permission`) resolves the promise.
4. `result` ends the turn; state goes `running → idle`; the native service posts "Done".

## Key decisions (and why)

- **Agent SDK, not our own agent loop**: we get Claude Code's tools, permissions, skills, CLAUDE.md, MCP, compaction and session files for free, and chats are shared with the terminal CLI.
- **UI served by the server**: UI fixes reach every installed app without a reinstall. The APK bundles a fallback copy. The UI reloads itself when `hello.uiVersion` changes.
- **No Gradle / AndroidX**: the APK builds on the phone itself in seconds with `aapt2 → javac → d8 → apksigner` (`build.sh`). Keep Java dependency-free.
- **Activity is computed server-side** (`activity.js`): one source of truth for the in-app activity bar and the Android notification.
- **Token auth on localhost**: other apps on the phone can reach 127.0.0.1, so every endpoint except `/health` and `/ui/` needs the shared token.

## State on disk

| Path | Owner | What |
|---|---|---|
| `~/.claude/projects/*/<id>.jsonl` | Claude Code | chat transcripts (source of truth for history) |
| `~/.claude/sessions/*.json` | Claude Code | registry of running sessions (used to detect "open in Termux") |
| `~/.pocket-agent/token` | server | shared secret with the app |
| `~/.pocket-agent/prefs.json` | server | pinned chats, new-chat defaults |
| `~/.pocket-agent/server.log` | server | log (`pocket-agent logs`) |
| app SharedPreferences `pa` | app | token, mirrored UI settings for the notification service |
| WebView localStorage `pa.settings` | UI | theme, text size, toggles |
