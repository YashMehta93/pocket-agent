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

## Tracking: issues, labels, milestones

- **Every piece of work starts as an issue**, using the Bug or Feature form. The issue is where the *why* lives.
- **Labels** follow one scheme, defined in `.github/labels.json`:
  - `type: …`: bug, feature, security, docs, chore, test, release. Exactly one per issue and PR.
  - `area: …`: server, ui, android, release, ci, termux, accessibility.
  - `priority: high/low`.
  - `status: needs-triage / needs-verification / blocked`.
  - To change the scheme, edit the file in a PR; GitHub's labels follow on merge (`scripts/sync-labels.sh`).
- **Milestones are releases.** `1.2.0` holds everything planned for 1.2.0, and `Backlog` holds what's wanted but not scheduled. A release ships when its milestone is done, not when a PR merges.
- **Links:**
  - every PR says `Closes #N` (or `Refs #N` / `Part of #N`);
  - every commit message mentions its issue, e.g. `Fix the double open (#19)`.

## Day-to-day flow

1. Pick or open an issue. Give it labels and a milestone.
2. `git switch v1.x && git pull --ff-only && git switch -c fix/short-name` (or `feat/…`, `chore/…`).
3. Commit, mentioning the issue in every message, and add a line to `CHANGELOG.md` under `## Unreleased` for anything users notice.
4. Push and open a PR **into `v1.x`**: `bash scripts/open-pr.sh "Title"` or `gh pr create --base v1.x`. The template asks for the issue link, labels and testing.
5. Checks run on GitHub (`.github/workflows/`):
   - **CI / tests**: server and screen test suites.
   - **CI / apk**: the Java compiles, and a release dry run with the update and upgrade tests.
   - **PR policy**: issue link, type label, issue in every commit.
6. **An approver approves**: anyone in `.github/CODEOWNERS` (you can't approve your own PR). The owner can also merge with the admin bypass.
7. Merge. Then `git switch v1.x && git pull --ff-only`. The issue closes itself.

A PR is not a release: merged work waits in `v1.x` until its milestone's release.

## Releases: always a beta first

Approvers (`.github/release-policy.json` → `approvers`): **YashMehta93, bhavyadhoru, JetErorr**.

```
v1.x:  PRs ──► PRs ──► [release PR: 1.2.0-beta.1] ──► beta.1 on the Beta track
                        fixes ──► [release PR: 1.2.0-beta.2] ──► beta.2
                        [release PR: 1.2.0 + changelog only] ──► 1.2.0 on Stable, PR v1.x → master
```

1. **Beta.**
   - A release PR (label `type: release`) sets `VERSION` to `1.2.0-beta.1` and renames `## Unreleased` in `CHANGELOG.md` to `## 1.2.0-beta.1`. That section becomes the release notes.
   - An approver approves or merges it.
   - The key holder (today, the owner's phone) runs `bash scripts/release.sh` on the updated `v1.x`. It publishes a pre-release, which only Beta-track phones get.
2. **More betas** as needed: fix PRs, then a release PR for `1.2.0-beta.2`.
3. **Final.**
   - A release PR sets `VERSION` to `1.2.0` and writes `## 1.2.0` in the changelog (usually all the betas' notes together).
   - It may change **only** the version, the changelog and docs. Any code change means another beta first.
   - Once approved, `release.sh` publishes it to Stable and opens the `v1.x` → `master` PR.
4. **Patches** (`1.2.1`) follow the same path: `1.2.1-beta.1`, then `1.2.1`.

`release.sh` refuses unless these rules hold (it runs `scripts/release-policy.mjs`):
- `VERSION` is `X.Y.Z` or `X.Y.Z-beta.N`;
- the PR that set `VERSION` was approved or merged by an approver;
- for a final: a beta of the same version exists, nothing but `finalMayChange` paths changed since the last beta, and it's at least `minBetaDays` old (0 today);
- plus the older checks: run on a release line that matches GitHub, a changelog section exists, the tag is new, and the lock files are current.

`bash scripts/release.sh --dry-run` shows which rules hold, without failing on them.

**Hotfix while new work is on `v1.x`:** branch `v1.2-maint` from the `v1.2.0` tag, fix there with the same PR flow, and release `1.2.1-beta.1` → `1.2.1` from it (add it to `releaseBranches`). Merge the fix into `v1.x` too.

## Who can release

1. **Approval**: `v1.x` and `master` need a PR approved by a code owner (`.github/CODEOWNERS`: the three approvers), and new pushes after an approval need approving again. The owner can merge with the admin bypass.
2. **Release tags**: only admins can create, move or delete `v*` tags (a GitHub ruleset), so only the owner's account can publish.
3. **Immutable releases**: a published release's files can't be changed afterwards.
4. **Signed code** (protects phones even if GitHub is compromised): `release.sh` signs `bundle.tgz` with `release-key.pem`, and apps install release code only if it's signed, for that exact tag, by a key in `server/trusted-keys.json`. APKs are protected the same way by Android: updates must be signed with `pocket-agent.keystore`.

Approvers decide *whether* to release. The key holder publishes. To let another person publish too, they make a release key (`node scripts/release-key.mjs new <github-name>`) and add it to `server/trusted-keys.json` in a PR. They'd also need admin rights for tags and a copy of the APK keystore, so think before sharing those.

## Changing this system

Everything above lives in files, so it changes through a normal PR:

| To change… | Edit |
|---|---|
| Who approves releases; beta rules; soak time; what a final may change | `.github/release-policy.json` |
| Who approves PRs | `.github/CODEOWNERS` (keep it in step with the approvers) |
| Labels | `.github/labels.json` |
| PR checks (issue links, labels) | `.github/workflows/pr-policy.yml` |
| Which tests run on GitHub | `.github/workflows/ci.yml` |
| Issue and PR forms | `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md` |
| Required checks, approvals, tag rules | GitHub → Settings → Branches / Rules (owner) |

Emergency switches: the `policy: exempt` label skips the issue-link checks on one PR; `PA_RELEASE_RULES_OFF=1 bash scripts/release.sh` skips the release rules once (say why in the release notes); the owner's admin bypass merges past failing checks.

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
