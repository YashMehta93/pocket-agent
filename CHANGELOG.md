# Changelog

Versions follow `MAJOR.MINOR.PATCH` (see docs/RELEASES.md).

## 1.0.0

The first stable version: Claude Code on an Android phone, with no Termux or computer needed.

**Runs on the phone**
- Built-in Linux (Alpine via proot) with Node, git, ripgrep and Claude Code, installed by a first-run setup that resumes if interrupted.
- Sign in with your own Claude account (Claude Code's own login).
- Optional: connect to a Pocket Agent server on a computer (or Termux) instead.

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

**Groundwork**
- A generic native shell (notification specs, device RPC, accessibility and notification access, off by default), so most changes ship without a new APK.
