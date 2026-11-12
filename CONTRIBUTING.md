# Contributing

Read `docs/ARCHITECTURE.md` first (5 minutes). It explains the three parts and how a message flows.

## Set up: develop inside the app (no computer, no Termux)

1. Install Pocket Agent and finish its first-run setup (see README).
2. Settings → **Build Pocket Agent yourself**. Enter the repo (`owner/pocket-agent`) and, for a private repo, a GitHub token (see README, "Updates"). It:
   - installs Java 17, `aapt2`, `zipalign`, `d8` (Google's r8) and `apksigner` (our CLI on Google's apksig);
   - clones the repo into `~/projects/pocket-agent`;
   - downloads `android.jar` and runs `npm install`;
   - builds once, and switches the app's updates to that folder.
3. Ask Claude (in the app) to change Pocket Agent, or edit yourself. Run scripts with `bash`, e.g. `bash build.sh`.

Your own builds are signed with your own `pocket-agent.keystore` (created on first build). Android only installs an update signed with the same key as the installed app. To switch between the official build and your own, uninstall first; that wipes the app's Linux and chats.

### On a computer instead

You need JDK 17, Node 20+, and the Android SDK build-tools (`aapt2`, `zipalign`, `d8`, `apksigner`) on `PATH`:

```bash
git clone https://github.com/YashMehta93/pocket-agent && cd pocket-agent
bash scripts/fetch-android-jar.sh            # sdk/android.jar (API 34)
(cd server && npm install --omit=optional)   # Agent SDK + ws
npm install                                  # jsdom for UI tests
bash build.sh                                # → build/pocket-agent.apk
```

## Where to make a change

| You want to change… | Edit | How it reaches the phone |
|---|---|---|
| Look, layout, chat behaviour | `app/assets/ui/` | Settings → Check for updates (the screen reloads) |
| Server behaviour, a new request | `server/src/` (+ `docs/PROTOCOL.md`) | same: Check for updates; restarts when no reply is running |
| Notification wording, buttons, when to notify | `server/src/notify.js` | same |
| Phone features built from native capabilities | server/UI code calling `callNative()` / `nativeRpc()` | same, no reinstall |
| Built-in Linux setup (packages, install steps) | `app/src/.../Linux.java`, `app/assets/ui/setup.html` | `bash build.sh`, then tap the "App update available" banner |
| A genuinely new native capability | `app/src/.../Rpc.java` (+ manifest for a new permission or service) | same: build, then tap the banner |

UI files, by feature: `core.js` (helpers, connection, sheets), `render.js` (chat rendering), `activity.js` (activity bar and log), `sessions.js` (drawer), `composer.js` (input, pickers, edit/retry), `approvals.js`, `pages.js` (menus, files, settings, background jobs), `main.js` (start-up, events). They're plain scripts sharing globals, loaded in the order in `index.html`: `base.js` first, `main.js` last.

Updating the bundled proot: `bash app/native/prepare-proot.sh` (downloads Termux's packages; needs `patchelf`), then rebuild and commit `app/jniLibs`.

## Branches and releases

Read [docs/RELEASES.md](docs/RELEASES.md): work happens on feature branches with PRs into `v1.x`; `master` and the `v1.x` line change only by merging PRs; `v1.0` is frozen.

## Releases (what friends' apps update from)

```bash
bash scripts/release.sh --dry-run   # build + package into build/release/
bash scripts/release.sh             # tag vX.Y.Z, create the GitHub release, upload the 4 files
```

It needs a GitHub token that can write the repo, in `$GITHUB_TOKEN` or `~/.config/pocket-agent/github-token`. Releases are signed with `pocket-agent.keystore`. **Keep that file private and backed up.** It's ignored by git, and losing it means existing installs can't update.

Fresh installs follow the repo named in `server/package.json` → `pocketAgent.githubRepo`.

## Develop without breaking your running app

Run a second server and point tests at it. It shares this app's chats; keep test chats disposable.

```bash
node server/src/index.js --port 8766 &
PA_PORT=8766 npm run test:ui
```

## Tests

```bash
npm run test:ui          # headless UI (jsdom) against a running server, no Claude turns
npm run test:ui:live     # + a real Claude turn with an approval (uses your Claude plan)
npm run test:server      # protocol end-to-end, includes a real Claude turn
npm run test:native      # server ↔ phone channel with a fake phone (fast, no Claude)
npm run test:setup       # first-run setup screen with a fake native bridge
npm run test:tar         # the app's tar extractor vs GNU tar on the real Alpine archive
npm run test:github      # updating from GitHub releases, against a fake GitHub API
npm run test:migrate     # Move from Termux, into a throwaway home (needs a Termux server)
npm run test:transfer    # chat import + update channel between servers (needs a Termux server)
```

Add a check for anything you fix. UI tests drive the real UI code: `ev("someFunction()")` calls into the page. Tests that start their own server give it a throwaway `HOME` and `PA_DATA`, and must never touch the app's real data.

## Conventions

- No build step for the UI, no frameworks. Plain JS; `esc()` any text you put into HTML; `h()` to make elements.
- Java: framework APIs only (no AndroidX), so `build.sh` keeps working on a phone.
- Server: ES modules, one responsibility per file; comment the *why*.
- Keep user-facing text short and plain.
- Commit messages: what changed and why, in the imperative ("Add activity bar").
- Never commit keys, tokens or personal data. `.gitignore` covers `*.keystore`, `sdk/`, `build/`.
