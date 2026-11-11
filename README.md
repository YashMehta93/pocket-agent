# Pocket Agent

An Android chat app for Claude Code. The app runs on the phone; Claude Code itself runs locally in Termux (later also on a PC over SSH).

```
Pocket Agent APK (WebView UI + native bits)
      │  WebSocket + SSE, localhost, shared token
      ▼
server/  Node bridge in Termux ── Claude Agent SDK ──► claude (Termux launcher)
```

## Layout

| Path | What |
|---|---|
| `app/` | Android app. Plain Java, no Gradle or AndroidX. |
| `app/assets/ui/` | Chat UI (HTML/CSS/JS). The server serves it, so UI changes need no reinstall; the APK bundles a fallback copy. |
| `server/` | Bridge server: sessions, streaming, approvals, files (`server/src/server.js`). |
| `build.sh` | Builds the APK with aapt2 → javac → d8 → apksigner; copies it to `Downloads/claude apps/`. |
| `tools/` | Headless UI tests (jsdom). |
| `server/test/e2e.mjs` | Protocol end-to-end test. |

## Commands

```bash
pocket-agent start|stop|restart|status|logs|token   # bridge server
./build.sh                                           # build APK → Downloads/claude apps/
node server/test/e2e.mjs                             # protocol test (uses a real Claude turn)
node tools/ui-test.mjs [--live]                      # UI test in jsdom (--live runs a real turn)
```

## First run on the phone

1. Install `Downloads/claude apps/pocket-agent.apk` from the Files app.
2. Open it and allow notifications and "Run commands in Termux".
3. If the app says it isn't paired: run `pocket-agent token` in Termux and paste the token into the app.

Optional: so the app can start the server by itself, set `allow-external-apps = true` in `~/.termux/termux.properties`, then run `termux-reload-settings`.

## Notes

- The SDK spawns `$PREFIX/bin/claude` (the proot launcher), so sessions behave like the CLI: same login, settings, CLAUDE.md, skills and MCP servers.
- `android.jar` (API 34) lives in `sdk/` and is not committed. Get it from Google's `platform-34-ext7_r03.zip`.
- Server state lives in `~/.pocket-agent/` (token, prefs, log).
