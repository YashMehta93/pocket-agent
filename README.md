# Pocket Agent

**Claude Code on your Android phone.** Chat with Claude, watch what it's doing live, approve its actions from a notification, and keep every session in one place. Claude Code runs on the phone itself, inside a small Linux system built into the app. No Termux, no computer. Or connect the app to a Pocket Agent server on a computer.

You need a Claude account (Pro or Max) and an Android phone (Android 8+, 64-bit ARM), with about 1.5 GB free.

## Install

1. On the phone, open **[Releases](https://github.com/YashMehta93/pocket-agent/releases/latest)** → download **`pocket-agent.apk`**.
2. Open it and install. Allow your browser or Files app to install apps if Android asks. Tap **Install** on every prompt, and stay on the dialog until it finishes. OnePlus, Oppo and Realme phones show two install prompts and a security scan: cancelling either prompt cancels the install. If it still won't install there, see [Troubleshooting](#troubleshooting).
3. Open Pocket Agent → **Set up Pocket Agent**. It downloads about 300 MB once (Alpine Linux, Node, git, Claude Code) and takes 3–8 minutes on Wi-Fi. Keep the app open.
4. **Sign in to Claude**: open the sign-in page, approve, copy the code, paste it into the app.
5. Tap **Allow** on the "keep running in the background" banner, so Android doesn't stop Claude mid-reply. On Vivo, Xiaomi, Oppo and similar phones, also set Pocket Agent's battery use to *Unrestricted* / *No restrictions* in its App info.

### Updates

Pocket Agent follows this repo's releases on its own, with nothing to set up. When a new release is out, you get a notification, and the app shows a banner: screen and server changes apply in seconds, a new APK installs with one tap.

**Settings → Updates & chats** chooses what you follow:
- **Stable**: the newest full release (default).
- **Beta**: also test versions (pre-releases), first.
- **Versions**: every release with what changed. Pick one to stay on it ("Pinned"), including an older one. Going back switches the screens and server; the app itself stays newer, because Android can't install an older app over a newer one.

## Troubleshooting

- **OnePlus / Oppo / Realme: "App not installed"**: tap Install on *both* prompts, then *Continue installation* after the scan. If it still fails: Settings → Apps → *StdSP Core* → ⋮ → *Uninstall updates* (this phone's own APK scanner), then try again.
- **"Signed with a different key"**: the APK was built by someone else. See [Your own version](CONTRIBUTING.md#your-own-version-and-its-signing-key).
- **Termux setup stopped with a curl error**: in Termux, run `apt update && apt full-upgrade -y`, then get a new setup command in Settings → Termux.

## What it does

- Chat with Claude Code: streaming replies, readable thinking, tool cards with diffs and output, todo list, subagents.
- **Live activity**: what Claude is doing right now (thinking, running a command, waiting for you), with a step-by-step log and a timer, also in the notification.
- **Approvals**: allow or deny commands and edits in the app or straight from the notification; answer Claude's questions; approve plans.
- **Every session in one place**: search, pin, rename, fork, edit and retry from any message, and continue a chat anywhere.
- Models, effort, and permission modes (ask, auto-accept edits, plan, auto, bypass).
- Attach photos and files, voice input, share from any app to Pocket Agent, and home-screen shortcuts.
- File browser for your projects. Phone storage is at `/sdcard`.
- **Builds itself**: Settings → *Build Pocket Agent yourself* sets up Java and the Android build tools and clones this repo, so Claude can change and rebuild the app on the phone.
- Optional phone control groundwork (accessibility, notification access), off until you enable it.
- **Background services**: `pa-service add preview -- npm run dev` keeps a dev or preview server running; Pocket Agent starts it again after Android kills the app.
- **Back up and restore** chats, memory, settings and projects to phone storage (Settings → Updates & chats).
- **Termux (optional)**: Settings → Termux → *Set up Termux* gives you one command to paste into Termux. Claude in the app can then run commands there (`termux <command>`), and you can run Claude in Termux instead of the built-in Linux. Coming from an older Termux setup? *Move everything from Termux* brings your projects, chats, memory and settings over.

## Make it yours

Pocket Agent improves itself. Settings → **Build Pocket Agent yourself** gets you your own copy of the code on your own branch. Then **Improve Pocket Agent** starts a chat in it: ask for any change, and your app updates in a minute. Your experiments stay on `me/<your-github-name>`. When something's good for everyone, ask Claude to "share this with everyone": it opens a pull request into the shared line, and once the owner merges it, the next release brings it to everyone. Details: [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/RELEASES.md](docs/RELEASES.md#personal-versions-megithub-name).

## Build it yourself

- **On the phone**: Settings → **Build Pocket Agent yourself** (repo + token), then **Improve Pocket Agent**.
- **On a computer**: see [CONTRIBUTING.md](CONTRIBUTING.md#on-a-computer-instead).

Your build is signed with your own key, so its APKs can't update the official app. Screen and server changes still apply without one; for Java changes, see [Your own version](CONTRIBUTING.md#your-own-version-and-its-signing-key).

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
| `scripts/` | `release.sh` (publish a release), `open-pr.sh` (PR without `gh`), `fetch-android-jar.sh` |
| `CLAUDE.md` | what Claude needs to know to change this app safely |
| `tests/`, `server/test/` | headless UI tests (jsdom), protocol, update and migration tests |
| `build.sh` | builds the APK on the phone or a computer |

## Privacy

Everything runs on your phone. Chats stay in the app's private storage. Claude Code talks to Anthropic's API with your own account. Nothing in this repo contains keys, tokens or chats.

## License

MIT; see [LICENSE](LICENSE). The bundled proot binaries are GPL-2.0 (sources: [app/jniLibs/NOTICE.md](app/jniLibs/NOTICE.md)); the fonts are under the SIL Open Font License.
