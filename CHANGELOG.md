# Changelog

Versions follow `MAJOR.MINOR.PATCH` (see docs/RELEASES.md).

## 1.1.2

- After installing an app update (APK), Pocket Agent no longer offers a second, pointless "An update is ready".
- Update checks use far fewer GitHub requests (GitHub limits them per internet connection, and phones on the same Wi-Fi share that limit), and retry once when the network drops a request. *Check for updates* still asks GitHub right away.

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
