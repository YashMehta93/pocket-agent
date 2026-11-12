# Pocket Agent: notes for Claude

Pocket Agent is an Android app that runs Claude Code on the phone. You are most likely running *inside* it, in its built-in Linux, working on the person's own copy of the app that's running right now. Your changes reach their phone within minutes, so they can try them immediately. The app improves itself this way, and each person's best changes flow back to everyone.

Read `docs/ARCHITECTURE.md` before larger changes. `CONTRIBUTING.md` says where each kind of change goes, and `docs/RELEASES.md` covers branches and releases.

## Whose code is this

- **`me/<github-name>`**: the person's own version of the app (`git config pocketagent.me` names it). Commit to it freely and push it (`git push -u origin HEAD`): that backs it up, and friends can borrow from it. Never push to someone else's `me/…` branch; the pre-push hook refuses.
- **`v1.x`**: the shared line everyone's releases come from. **`master`**: everything the owner approved. **`v1.0`**: frozen. Never commit or push to these. They change only when the owner merges a pull request. Never merge a PR yourself.

### Typical requests

- **"Change X in my app"**: work on `me/<name>`, commit, then ship it (below).
- **"Get the latest from everyone"**: `git fetch origin && git merge origin/v1.x` into `me/<name>`. Resolve conflicts, keeping the person's changes unless they say otherwise. Then ship.
- **"Share this with everyone" / "send it upstream"**:
  1. `git switch -c feat/<short-name> origin/v1.x`, then `git cherry-pick` the relevant commits, or redo the change cleanly there. Keep it to one topic, without personal tweaks.
  2. Run the tests, then `git push -u origin HEAD`.
  3. `bash scripts/open-pr.sh "Title"` opens the PR into `v1.x`.
  4. Switch back to `me/<name>`. The owner reviews and merges.
- **"Try what <friend> made"**: `git fetch origin && git log origin/me/<friend>`, then cherry-pick what they want onto `me/<name>`.

## Shipping a change to the phone

| Changed | How it reaches the app |
|---|---|
| `app/assets/ui/**` (screens), `server/**` (server, notifications, tools) | The app updates from this folder. Tell the person: **Settings → Check for updates** (or tap the banner). The screen reloads; the server restarts once no reply is running, so this chat ends its turn first. No reinstall. |
| `app/src/**` (Java), `app/AndroidManifest.xml`, `app/res/**` | `bash build.sh`. The app then offers **"App update available"**: one tap. If it says the build is signed with a different key, the person installed the official app but builds with their own key. See CONTRIBUTING.md, "Your own version". |

Prefer screen and server changes over Java: they need no APK and work on every install. Native features can often be built from the existing native capabilities (`callNative()` / `nativeRpc()`, listed in `Rpc.java`).

Never edit `/opt/pocket-agent` (the running copy): the next update replaces it.

## Checks before you say it's done

- `node --check` the JS files you touched; `bash build.sh` if you changed Java.
- Tests need a second server so the running app isn't disturbed. Start one with `node server/src/index.js --port 8766 &`, then run `PA_PORT=8766 npm run test:ui` and `PA_PORT=8766 npm run test:native`. `npm run test:setup` and `npm run test:github` start their own. Tests must never touch the app's real data: anything that starts a server sets its own `HOME` and `PA_DATA`.
- Add a check for anything you fix (see CONTRIBUTING.md, "Tests").

## Rules

- Never commit keys, tokens or personal data: `pocket-agent.keystore`, `~/.config/pocket-agent/github-token`, chats.
- Keep user-facing text short and plain. Plain JS for the UI (no build step, no frameworks); framework-only Java (no AndroidX, no Gradle), so `build.sh` keeps working on a phone.
- Releases (`scripts/release.sh`) are for the owner only, after merges into `v1.x`.

## The phone you're on

- Built-in Alpine Linux in proot, with home `/root`. Phone storage is at `/sdcard`, and built APKs are copied to `/sdcard/Download/claude apps`.
- `termux <command>` runs a command in Termux, if it's installed and allowed in Settings → Termux.
- `apk add` needs root, which this shell doesn't have. Use `apk --usermode --root ~/sys`, or ask the person.
- Don't run `pkill -f <pattern>` with a pattern that also matches your own command line: it kills your shell.
