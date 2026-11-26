# Changelog

Versions follow `MAJOR.MINOR.PATCH` (see docs/RELEASES.md).

## Unreleased

- Fixed the settings screens (#75): the active filter chip is readable in both themes and the filter row scrolls inside the drawer with names cut at 12 characters, Settings shows the real paired-device count, a pair code no longer leaves a stuck button, device rows and the chat header keep their lines tidy, and a code block keeps its first line and stays plain text unless its fence names a language.
- **Devices** (#67): Settings → Devices pairs another device with a one-time code; each paired device gets its own token and scopes, can be renamed, and revoking it cuts it off at once. On a computer, `node server/src/pair-cli.js` prints a code for the phone.
- **This device** (#67): Settings → Claude and connection shows this server's name (for example "Phone") and lets you rename it. Every server now also says its protocol and what it can do, so another Pocket Agent server can show and check it.
- **Profiles** (#68): a profile groups folders with their own Claude account, environment variables and secrets folder, and a chat takes the profile of its folder. With one profile nothing changes.
- **Profiles on screen** (#68): Settings → Profiles lists them with their folders, Claude account and environment variables; with two or more, filter the chats drawer by profile, and every chat row and new chat says which profile it is in.
- **Your other devices** (#69): connect another Pocket Agent server (for example a laptop) with a pairing code or token, and its chats appear in the same list; open one, read it and answer from the phone. Settings → Environments shows each device with a dot for its state and lets you rename it, test it, reconnect, pair again or remove it; the chats drawer filters by Phone or device, a device's chats carry its name (and go grey with "offline" while it's away), and New chat → Where runs the chat there, with the folder picker browsing that machine. Pairing for real uses a code from the other machine (or `node server/src/pair-cli.js`), pairing a device with itself is refused, and the drawer's profile and device filters share one compact row.
- **Other machines, safely** (#69): only this phone's owner can open another machine's chats or files — a paired device is refused. Approvals and Done from another machine notify even when the app is closed, and everything it sends (chat titles, folders, tool calls) is shown as plain text.
- **Windows** (#70): the server runs on a Windows computer as a normal user, with no admin rights: `node server/bin/pocket-agent.mjs start`. Shell commands run in Git Bash, and Claude Code is found where its installer or VS Code put it. A small supervisor restarts the server when it asks (updates, restores) and stops retrying after repeated crashes.
- **Pair a computer** (#70): `node server/bin/pocket-agent.mjs pair` prints a one-use pairing code (with an optional name, scopes and folders) for Settings → Environments → Add, like `pair-cli.js` does, without having to look up the port or token.
- **Devices limited to folders** (#72): pair a device with folders (`--roots` in `pair-cli.js` or the launcher, or in Settings → Devices) and it sees and reaches only chats and files inside them; everything else answers "not found". A hub keeps the other machine's roots, and a new chat there starts its folder picker at the first one.
- **DeepSeek** (#44): add your DeepSeek key in Settings → DeepSeek, then start chats on DeepSeek with the new engine chip, or let a Claude chat send work to DeepSeek (and the other way round) with your OK each time. Each worker is its own chat you can watch and stop. The Usage sheet shows your DeepSeek balance and spend.
- **Agents in one place** (#52): a chat that starts agents gets a slim **Chat · Agents** switch under the header ("Agents 2" while two work, a dot when one needs you; swipe works too). The Agents tab lists its DeepSeek and Claude workers, Claude's own subagents and background commands: what each is doing now, its steps, cost or tokens, and time. Tap one for its live conversation, Stop, and Open as chat. In the chat, a handoff is one quiet line ("Sent to DeepSeek: Add README · done ›") instead of a card, and the bar under the header and the agents line are gone. The chats drawer folds workers under the chat that started them. A worker's approval shows in the chat that started it, headed with the worker ("DeepSeek · Add README wants to run `npm test`"), with **Allow all for this worker** (until it finishes); notifications say the same.
- **Background workers** (#66): stopping a reply no longer stops the background workers that chat started; the Agents tab has **Stop all** for them, and closing a chat stops them. A follow-up to a worker can run in the background too.
- Fixed: after switching Claude accounts, usage showed the previous account's numbers; an unused 5-hour window now shows 0% (#50).
- **Security** (#65): only the phone's own server can use phone features; a server chosen in Settings gets notifications only, its pages never load in the app, and exporting the whole home is limited to a Termux server.
- Fixed: tapping Send no longer drops the keyboard; long-pressing a chat opens its menu without also opening the chat (or closing the menu); the chat keeps following new output without the person scrolling (#57, #58, #56).
- **Sturdier connection** (#62): a dropped connection no longer loses a message being sent (the text stays in the box, and a resend can't duplicate it); the app reconnects as soon as it's back on screen or online; a silently dead server connection is noticed within a minute.
- **Sturdier connection** (#62): reconnecting to the chat you're reading keeps it in place and catches up from where it stopped, so a reply that was mid-stream carries on instead of the chat being rebuilt; if the server can no longer catch up, it reloads as before.
- **Sturdier connection** (#62): a reply that finishes while the phone is away still gives its "done" notification once on reconnect, and a stale "working" status clears instead of staying stuck.

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
