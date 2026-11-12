# Branches, versions and releases

## Branches

| Branch | What it is | How it changes |
|---|---|---|
| `master` | Everything the owner has approved | **Only** by merging pull requests on GitHub |
| `v1.0`, `v2.0`, … | A frozen stable major version, exactly as it was released | **Never** |
| `v1.x`, `v2.x`, … | The running line for that major version; minor and patch releases are cut from here | **Only** by merging pull requests on GitHub |
| `feat/…`, `fix/…` | Day-to-day work, one topic per branch | Pushed freely; deleted after merging |
| `me/<github-name>` | One person's own version of the app: their experiments and tweaks (see below) | Only by that person |

GitHub enforces these: `master` and `v1.x` accept changes only through pull requests (no force-push or deletion), and `v1.0` is locked read-only; the owner can override in an emergency. Locally, `.githooks/pre-push` refuses the same pushes before they leave your phone (enabled with `git config core.hooksPath .githooks`; *Build Pocket Agent yourself* does this). Its emergency override: `PA_ALLOW_PROTECTED_PUSH=1 git push …`.

## Day-to-day flow

1. `git switch v1.x && git pull --ff-only && git switch -c feat/short-name`
2. Commit, push the branch, and open a pull request **into `v1.x`**: `bash scripts/open-pr.sh "Title"` (or `gh pr create --base v1.x`).
3. The owner reviews and merges it on GitHub. **Merging is the approval.**
4. `git switch v1.x && git pull --ff-only`.

## Who can release

Only the owner approves code into `v1.x` and `master`, and only the owner cuts releases. Four layers make sure of it:

1. **Approval**: `v1.x` and `master` need a pull request approved by the owner (`.github/CODEOWNERS`), and pushing new commits after an approval needs approving again. The owner merges their own PRs with the admin bypass.
2. **Release tags**: only the owner can create, move or delete `v*` tags (a GitHub ruleset), so nobody else can publish a release.
3. **Immutable releases**: a published release's files can't be changed afterwards.
4. **Signed code** (the one that protects phones even if GitHub is compromised): `release.sh` signs `bundle.tgz` with `release-key.pem` and uploads `bundle.sig`. Apps install release code only if it's signed, for that exact tag, by a key in `server/trusted-keys.json`. That file ships with the app, and changing it needs the owner's approval like any other code. APKs are already protected the same way by Android: an update must be signed with `pocket-agent.keystore`.

To trust another person's releases later: they run `node scripts/release-key.mjs new <github-name>` on their phone and open a PR with the changed `server/trusted-keys.json`; the owner merges it. To stop trusting a key, remove it the same way.

## Personal versions: `me/<github-name>`

Everyone who builds Pocket Agent on their phone (Settings → *Build Pocket Agent yourself*) gets their own branch, `me/<github-name>`, made from `v1.x`. Their app updates from their own copy of the code, so it runs exactly their version. The personal branches and the version line stay separate:

```
v1.x ──●────────●──────────●──────►   shared line: releases are cut from here
        \        ▲ PR        \ merge
me/ana   ●──●──●─┼──●─────────●──►    Ana's app: her tweaks, plus v1.x merged in when she wants
                 │
feat/voice-notes ●   one feature, cherry-picked from me/ana onto v1.x, opened as a PR
```

- **Experiment** on `me/<name>`: commit freely, push to back it up. Only its owner pushes it (`.githooks/pre-push`, from `git config pocketagent.me`).
- **Get everyone's improvements**: merge `origin/v1.x` into `me/<name>` whenever you like.
- **Share something**: put just that change on a `feat/…` branch from `v1.x` (cherry-pick it), push, `bash scripts/open-pr.sh "Title"`. The owner merges it, and it reaches everyone in the next release.
- **Borrow from a friend**: `git fetch` and cherry-pick from `origin/me/<friend>`.

In the app, Settings → **Improve Pocket Agent** starts a chat in your copy, and Claude follows these rules from `CLAUDE.md`. Ask it "share this with everyone" or "get the latest from everyone".

## Cutting a release (from `v1.x`)

1. Open a PR into `v1.x` that sets `VERSION` (e.g. `1.1.0`) and adds a `CHANGELOG.md` entry (`## 1.1.0`). That entry becomes the release notes people read on GitHub and in the app's Versions page, so write it for them; `release.sh` refuses without it. The owner merges it.
2. On the updated `v1.x`: `bash scripts/release.sh`. It:
   - refuses unless `v1.x` matches GitHub exactly and `VERSION` belongs to `v1.x`;
   - builds the APK and code bundle, tags `v1.1.0` (pushing only the tag), and publishes the GitHub release friends' apps update from;
   - opens a PR `v1.x` → `master`; the owner merges it.

## Beta releases

To let testers try something first: set `VERSION` to a pre-release like `1.2.0-beta.1` in the release PR, and run `bash scripts/release.sh` as usual. A version with a dash is published as a GitHub *pre-release*. Only apps on the **Beta** track (Settings → Updates & chats) get it; Stable apps wait for `1.2.0`.

## Versions

- `VERSION` (repo root) is the single source: `MAJOR.MINOR.PATCH`.
  - **Minor** (`1.1.0`): new features, compatible with existing installs.
  - **Patch** (`1.1.1`): fixes only.
  - **Major** (`2.0.0`): breaking changes (protocol, setup, data layout).
- Builds that aren't exactly a release tag are named `VERSION-dev.N` (e.g. `1.1.0-dev.42`).
- The Android version code is the number of commits on the branch, so it only goes up. Android won't install a lower one over a higher one.
- Code updates are refused if the source is older than what the app runs (build number = commit count), so an update can never roll an app back.

## A new major version

When `2.0.0` is ready on `master` (merged from feature PRs):
1. Create `v2.x` from that commit and push it (owner, with the override).
2. Release `2.0.0` from `v2.x`.
3. Create the frozen `v2.0` at the release tag: `git branch v2.0 v2.0.0`, then push it with the override.

`v1.x` keeps getting fixes only if needed.

## Keys

Two private files, both ignored by git, sign every release; keep both backed up somewhere private (a password manager, not phone storage):
- `pocket-agent.keystore` signs the APK. Without it, existing installs can never be updated.
- `release-key.pem` (from `node scripts/release-key.mjs new <name>`) signs the code. Without it, apps refuse new releases until an APK update brings a new trusted key. The app's phone-storage backups never include it.
