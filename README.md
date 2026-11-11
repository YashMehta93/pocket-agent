# Pocket Agent

A phone app for **Claude Code**: chat with Claude, watch what it's doing live, approve its actions from a notification, and keep every session in one place. Claude Code runs locally (today in Termux; soon inside the app itself).

- **Using it**: install `pocket-agent.apk`, open it, allow notifications and "Run commands in Termux". If it asks to pair, run `pocket-agent token` in Termux and paste the result.
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
2. **Standalone APK**: bundle a Linux environment (proot + Debian) so no Termux is needed; per-user Claude sign-in; in-app updates for friends.
3. Phone control tools (accessibility service, intents) exposed to Claude.
4. Connect to a PC over SSH for more compute.
