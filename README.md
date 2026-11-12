# Pocket Agent

**Claude Code on your Android phone.** Chat with Claude, watch what it's doing live, approve its actions from a notification, and keep every session in one place. Claude Code runs on the phone itself, inside a small Linux system built into the app. No Termux, no computer. Or connect the app to a Pocket Agent server on a computer.

You need a Claude account (Pro or Max) and an Android phone (Android 8+, 64-bit ARM), with about 1.5 GB free.

## Install

1. This repo is private. Ask its owner to invite you, accept the invite on GitHub, and stay signed in to GitHub in your phone's browser.
2. On the phone, open **Releases** (right side of the repo page) → latest → download **`pocket-agent.apk`**.
3. Open it and install. Allow your browser or Files app to install apps if Android asks, and stay on the dialog until it finishes.
4. Open Pocket Agent → **Set up Pocket Agent**. It downloads about 300 MB once (Alpine Linux, Node, git, Claude Code) and takes 3–8 minutes on Wi-Fi. Keep the app open.
5. **Sign in to Claude**: open the sign-in page, approve, copy the code, paste it into the app.

### Updates

Pocket Agent updates itself from this repo's releases, but a private repo needs a read-only GitHub token:

1. On GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Repository access**: *Only select repositories* → `pocket-agent`. **Permissions → Repository → Contents**: *Read-only*. Generate, then copy it.
3. In the app: **Settings → Updates & chats → Get updates from → GitHub releases**. The repo is prefilled; paste the token.

Then **Check for updates** (or the banner) applies new versions: screen and server changes instantly, new APKs with one tap.

## What it does

- Chat with Claude Code: streaming replies, readable thinking, tool cards with diffs and output, todo list, subagents.
- **Live activity**: what Claude is doing right now (thinking, running a command, waiting for you), with a step-by-step log and a timer, also in the notification.
- **Approvals**: allow or deny commands and edits in the app or straight from the notification; answer Claude's questions; approve plans.
- **Every session in one place**: search, pin, rename, fork, edit and retry from any message, and continue a chat anywhere.
- Models, effort, and permission modes (ask, auto-accept edits, plan, auto, bypass).
- Attach photos and files, voice input, share from any app to "Ask Claude", and home-screen shortcuts.
- File browser for your projects. Phone storage is at `/sdcard`.
- **Builds itself**: Settings → *Build Pocket Agent yourself* sets up Java and the Android build tools and clones this repo, so Claude can change and rebuild the app on the phone.
- Optional phone control groundwork (accessibility, notification access), off until you enable it.
- Coming from Termux? Settings → *Move everything from Termux* brings your projects, chats, memory and settings over.

## Build it yourself

- **On the phone**: Settings → **Build Pocket Agent yourself** (repo + token). Then `bash build.sh` in `~/projects/pocket-agent`, or ask Claude to.
- **On a computer**: see [CONTRIBUTING.md](CONTRIBUTING.md#on-a-computer-instead).

Your build is signed with your own key, so it can't update an install of the official build. Uninstall that first; this wipes the app's data.

## How it works

```
Pocket Agent app (WebView UI + small Java shell)
   │ WebSocket, localhost, per-install token
   ▼
Bridge server (Node, server/)  ── Claude Agent SDK ──►  Claude Code
   └── all inside Alpine Linux run by proot, inside the app's private storage
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), then [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/RELEASES.md](docs/RELEASES.md) (branches and versions). Changes: [CHANGELOG.md](CHANGELOG.md). Protocol: [docs/PROTOCOL.md](docs/PROTOCOL.md).

| Path | What |
|---|---|
| `app/` | Android app: Java (no Gradle, no AndroidX), `assets/ui/` chat UI, `jniLibs/` bundled proot |
| `server/` | Bridge between the app and Claude Code (Agent SDK), developer tools |
| `scripts/` | `release.sh` (publish a release), `fetch-android-jar.sh` |
| `tests/`, `server/test/` | headless UI tests (jsdom), protocol, update and migration tests |
| `build.sh` | builds the APK on the phone or a computer |

## Privacy

Everything runs on your phone. Chats stay in the app's private storage. Claude Code talks to Anthropic's API with your own account. Nothing in this repo contains keys, tokens or chats.

## License

MIT; see [LICENSE](LICENSE). The bundled proot binaries are GPL-2.0 (sources: [app/jniLibs/NOTICE.md](app/jniLibs/NOTICE.md)); the fonts are under the SIL Open Font License.
