# Changelog

Versions follow `MAJOR.MINOR.PATCH` (see docs/RELEASES.md).

## Unreleased

## 1.2.0

- **Usage limits** (#35): a ring in the chat header and a meter in the chats drawer show how much of your 5-hour and weekly Claude limits you've used and when they reset. A line above the message box warns from 90%. Tap either for the Usage sheet: this chat's context window, every limit including per-model ones, and a warning when your pace would run out before the reset.
- **Steps in one line** (#37): a reply's tool steps collapse into one line ("Ran 2 commands, read 3 files ›"). Tap it for a timeline, then a step for its input and output, with Copy and Prettify. Settings → Appearance switches back to cards. While Claude works, the box says "Queue a message…".
- The model chip names the real model (for example "Opus 5.5") instead of "Default" (#36).
- **Picks up after Android kills the app** (#40): replies cut off by a swipe or memory pressure continue on their own when the app comes back, with a message in the chat saying so. Tip: lock Pocket Agent in recents so a swipe doesn't stop it.
- **Close and back within reach** (#41): every sheet has a close button, pages have a back button at the bottom, and back from a step returns to its timeline.
- **See the agents Claude starts** (#43): a line above the message box ("1 agent working · 2 commands done ›") opens a list with what each is doing, then an agent's own conversation, live, with Stop.
- Thoughts stay in the chat and open with one tap (#37). The Usage sheet shows the context window for any chat (#35).
- Fixed: the stop button disappeared while Claude was still working after a restart (#38); a row of bare timings ("431ms") after a restart (#39); Settings → Restart Claude's server did nothing (#42, needs this version's app); the model sheet now ticks Default when a chat uses it.

- **Releases:** every release now ships as a beta first; a final release is the last beta plus only the version and changelog, approved by an approver. Work is tracked in issues and milestones.
- After installing an app update (APK), Pocket Agent no longer offers a second, pointless "An update is ready".
- Update checks use far fewer GitHub requests (GitHub limits them per internet connection, and phones on the same Wi-Fi share that limit), and retry once when the network drops a request. *Check for updates* still asks GitHub right away.
- **Background services**: dev and preview servers started from chats used to die whenever Android killed the app. `pa-service add <name> -- <command>` registers one; Pocket Agent starts it with the server, restarts it (with backoff) if it exits, and stops it cleanly on shutdown. Claude is told to use it instead of `nohup`/`&`.
- **Security:** WebView remote debugging is on only in debug builds; only the app's own pages load inside the app (exact origin), and every other link opens in the browser, which also fixes links that opened inside the app with no way back; backups never include signing keys (`*.keystore`, `*.pem`), Claude logins or git credentials, at any depth.

## 1.1.1

- Updating from 1.0.0 through "An update is ready" left out the new trusted-keys file (1.0.0 copied only the files it knew), so the update was offered again and again, and signed releases were refused. The app now restores that file on start-up, updates copy every file the new code brings, and when an app update (APK) is available it's the only banner shown, since it includes the code.

## 1.1.0

**Updates**
- The repo is public: apps follow releases with no GitHub token, and new installs need no invite.
- A notification when a new release is out, even with the app closed (checked every 6 hours, once per release).
- Release tracks in Settings → Updates & chats: **Stable**, **Beta** (pre-releases, for testers) or **Pinned** to one version. **Versions** lists every release with its notes; pick any, older ones too (screens and server go back; the app stays newer).
- **Signed releases**: apps install release code only if it's signed by a trusted key (`server/trusted-keys.json`), for that exact version. Releases are published only once all their files are uploaded.
- `release.sh` publishes versions with a dash (`1.2.0-beta.1`) as pre-releases, and works from `v1.x` again (it compared `1.0.0` with `v1`).

**Fixes**
- Termux setup upgrades Termux first (a partly upgraded Termux broke curl), and turns on the app's access to Termux before anything else.
- GitHub repos can be written any way (`owner/repo`, `github.com/…`, `git@…`), for updates and *Build Pocket Agent yourself*.
- README: install help for OnePlus/Oppo phones (two prompts and a scan; StdSP Core).

## 1.0.0

The first stable version: Claude Code on an Android phone, with no Termux or computer needed.

**Runs on the phone**
- Built-in Linux (Alpine via proot) with Node, git, ripgrep and Claude Code, installed by a first-run setup that resumes if interrupted.
- Sign in with your own Claude account (Claude Code's own login).
- Optional: connect to a Pocket Agent server on a computer (or Termux) instead.
- Asks to keep running in the background, so Android doesn't stop Claude mid-reply.
- Back up chats, memory, settings and projects to phone storage, and restore them (no credentials in backups).
- Termux, optional: one command sets it up; Claude in the app can run commands there (`termux …`), or the whole server can run there.

**Chat**
- Streaming replies, readable thinking, tool cards with command output and file diffs, todo list, subagents.
- Live activity bar with a step-by-step log and timer, also shown in the notification.
- Approvals in the app or straight from the notification; Claude's questions; plan approval.
- Models, effort and permission modes; attachments, photos, voice input, share-to-app, shortcuts.
- Every session in one place: search, pin, rename, fork, edit and retry, and import chats from another server.

**Updates and building**
- Updates from GitHub releases (with a token for private repos), from a project folder, or from another server; never rolls back to older code.
- One-tap APK updates.
- *Build Pocket Agent yourself*: Java 17, aapt2, zipalign, d8 and apksigner from official sources, the repo, and a test build, all on the phone.
- *Move everything from Termux*: projects, chats, memory, skills, settings and build tools.
- **Make it yours**: developer setup puts each person on their own branch (`me/<github-name>`), and *Improve Pocket Agent* starts a chat in their copy of the code, guided by `CLAUDE.md`. Shared features go to `v1.x` through pull requests (`scripts/open-pr.sh`).
- The update banner spots an APK signed with a different key and explains instead of failing.

**Groundwork**
- A generic native shell (notification specs, device RPC, accessibility and notification access, off by default), so most changes ship without a new APK.
