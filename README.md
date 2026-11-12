# Pocket Agent

A phone app for **Claude Code**: chat with Claude, watch what it is doing live, approve its actions from a notification, and keep every session in one place. Claude Code runs on the phone itself, in a small Linux system built into the app (no Termux needed), or on a server you connect to (Termux, a computer).

- **Using it**: install `pocket-agent.apk`, open it, tap **Set up Pocket Agent** (downloads ~300 MB once), then sign in with your Claude account.
- **Working on it**: start with `docs/ARCHITECTURE.md`, then `CONTRIBUTING.md`.

## Layout

| Path | What |
|---|---|
| `app/` | Android app: Java (no Gradle/AndroidX) + `assets/ui/` chat UI |
| `server/` | Node bridge between the app and Claude Code (Agent SDK) |
| `docs/` | architecture and app↔server protocol |
| `tests/ui/` | headless UI tests (jsdom) |
| `server/test/` | protocol end-to-end test |
| `build.sh` | builds the APK on the phone → `Downloads/claude apps/` |

## Commands

```bash
pocket-agent start | stop | restart [--when-idle] | status | logs | token
./build.sh                     # build the APK
npm run test:ui                # UI tests        (see CONTRIBUTING.md for all)
```

## Roadmap

1. ~~Chat, sessions, approvals, notifications, live activity~~
2. ~~Standalone APK: built-in Linux (proot + Alpine), per-user Claude sign-in~~ · next: update channel so friends get server/UI updates without new APKs
3. Phone control tools (accessibility service, intents) exposed to Claude.
4. Connect to a PC over SSH for more compute.
