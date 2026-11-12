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

## Where things run

| Mode | Linux environment | Server | How the app connects |
|---|---|---|---|
| **Standalone** (default) | built into the app: Alpine Linux via proot (`Linux.java`) | started and supervised by the app, port 8790 | automatically, with the app's own token |
| **Server** | Termux on this phone, or a computer | `pocket-agent start` (port 8765) | Settings → "Claude runs on" → address + token |

Standalone setup (first run, `setup.html` + `Linux.java`): download the Alpine minirootfs (sha256-checked, resumable) → unpack in Java (`Tar.java`) → `apk add` Node, git, ripgrep, bash… (proot fake-root) → Claude Code's official installer (as a normal user: Claude refuses some flags as root) → copy the server + UI bundled in the APK (`assets/server`, `assets/ui`) to `/opt/pocket-agent` and `npm install` → sign in with `claude auth login` (URL out, pasted code in). Each step is recorded in `files/linux/state.json`, so a failed setup resumes. An app update re-copies the bundle when `assets/bundle.json` changed.

proot ships as `lib*.so` in the APK (`app/jniLibs`, prepared by `app/native/prepare-proot.sh`): Android only executes files from the native-library dir, and the app targets SDK 28 so proot may run programs from the rootfs. Phone storage is bound at `/sdcard` once the storage permission is granted.

The protocol between app and server is the same in both modes; that's what keeps them swappable.

## Updates

The app's built-in server replaces its own code (server + UI) from an **update source** (`server/src/transfer.js`), and offers new APKs from the same place:

| Source | Who uses it | Code | APK |
|---|---|---|---|
| GitHub releases (`owner/repo`, plus a token for private repos) | everyone; fresh installs follow `server/package.json` → `pocketAgent.githubRepo` | release file `bundle.tgz`, checked against `bundle.json`'s hash | `pocket-agent.apk` + `pocket-agent.json` |
| A project folder on the phone | developing Pocket Agent in the app | the folder itself | `build/pocket-agent.apk` |
| Another Pocket Agent server | e.g. a computer or Termux | `/bundle.tgz` | `/apk/download` |

Applying an update waits until no chat is mid-reply; then the app restarts the server. An APK update is installed by Android after one confirmation tap (`Updater.java`).

## Lifecycle of one message

1. UI `send` → server `handlers.send` → `openSession` (resumes the chat from disk if needed) → `LiveSession.send` pushes a user message into the session's `Inbox` (the SDK's streaming input).
2. The SDK streams messages back (`stream_event` deltas, `assistant`, `user` tool results, `system` status, `result`). `LiveSession.pump` relays each as `{ t: "ev" }` to subscribed clients and feeds it to `Activity`.
3. When Claude wants to use a tool, the SDK calls `canUseTool` → `LiveSession.askPermission` → `{ t: "permission.request" }` to the UI and an SSE event to the notification service. The answer (`permission.reply` or `POST /permission`) resolves the promise.
4. `result` ends the turn; state goes `running → idle`; the native service posts "Done".

## Key decisions (and why)

- **The APK is a generic shell; behaviour lives on the server and in the UI.** Android can't update an app's code without a reinstall, so the native side only exposes capabilities (`Rpc.java`): render a notification spec, start an intent, read the screen, and so on. What to notify about, the wording and buttons, and future phone-control tools are server/UI code, so they ship live. The manifest pre-declares the permissions and services the roadmap needs (nothing is granted until a feature asks). Native changes are only for genuinely new capabilities, and those ship as a one-tap in-app update (`app.update` → `update.install`).

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
