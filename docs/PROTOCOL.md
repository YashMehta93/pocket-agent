# App ↔ server protocol

WebSocket at `ws://<server>/ws?token=<token>`. JSON messages.

- **Requests** (app → server): `{ "t": "<name>", "id": <number>, ...args }`
- **Replies**: `{ "t": "reply", "id": <same>, ...result }` or `{ "t": "reply", "id", "error": "...", "code"?: "BUSY_ELSEWHERE", "kind"?, "short"? }`
- **Events** (server → app, unsolicited): `{ "t": "<event>", ... }`

Handlers live in `server/src/handlers.js`. To add one: add a function there, document it here, and cover it in `server/test/e2e.mjs`.

## Requests

| `t` | Args | Reply |
|---|---|---|
| `hello` | | `version, uiVersion, home, host, platform, defaults, pinned, commands, models, account, live[]` |
| `sessions.list` | `limit?, dir?` | `sessions[]: { sessionId, title, firstPrompt, cwd, lastModified, pinned, live, elsewhere }` |
| `session.history` | `sessionId` | `messages[]` (SDK `SessionMessage`), `info` |
| `session.open` | `sessionId?, cwd?, model?, effort?, permissionMode?` | `sessionId, info` |
| `subscribe` | `sessionId, after` | `info` (live session or null), `events[]` with `seq > after` |
| `unsubscribe` | `sessionId` | |
| `send` | `sessionId, text, images?[{mediaType,data}]`, plus `cwd/model/effort/permissionMode` for a new chat | `sessionId, uuid` — may fail with `code: "BUSY_ELSEWHERE"` |
| `interrupt` | `sessionId` | |
| `permission.reply` | `sessionId, requestId, behavior: allow\|deny, always?, message?, updatedInput?` | `ok` |
| `set` | `sessionId, model?, effort?, permissionMode?` | `info` |
| `session.close` | `sessionId` | stops the Claude process (chat stays on disk) |
| `session.rename` / `session.delete` / `session.pin` | `sessionId, title` / `sessionId` / `sessionId, pinned` | |
| `session.fork` | `sessionId, upToMessageId?, title?` | `sessionId` of the copy |
| `session.continueHere` | `sessionId, mode: fork\|stop` | `sessionId` to continue in |
| `session.rewindFiles` | `sessionId, userMessageId, dryRun?` | `result` |
| `session.context` | `sessionId` | `usage` (SDK context usage) |
| `session.stopTask` | `sessionId, taskId` | |
| `defaults.set` | `defaults: { cwd?, model?, effort?, permissionMode?, thinkingDisplay? }` | `defaults` |
| `fs.list` / `fs.search` / `fs.read` / `fs.mkdir` | `path` / `cwd, q` / `path` / `path` | entries / results / `text, binary, truncated` / |
| `upload` | `cwd, name, data` (base64) | `path` (saved under `<cwd>/.pocket-agent-uploads/`) |
| `app.update` | | `versionCode, versionName, url` of the newest built APK |
| `sessions.import` | `url, token` of another server | `added, updated, unchanged, foldersCreated` |
| `update.channel` | `url, token` (empty url = none) | `channel` |
| `update.check` | (`url, token`, default: the saved channel) | `available, remote, local, channel` |
| `update.apply` | (same) | `updated, depsChanged`; the server then restarts when idle |
| `migrate.run` | `url, token` of the Termux server | `job`; progress arrives as `{ t: "migrate", job }` events (built-in mode only) |
| `backup.create` / `backup.list` / `backup.restore` | — / — / `file` | `file, bytes` / `dir, backups[{file,name,bytes,at}]` / `restored` (then the server restarts when idle). Backups go to `/sdcard/Download/Pocket Agent`, without credentials or tokens |
| `termux.installCommand` | | `command` (paste into Termux), `expiresIn`: fetches `/termux/install.sh?code=` with a 30-minute code |
| `migrate.status` | | `job` |
| `native.call` | `method, params, timeoutMs?` | `result` from the phone (server → phone RPC, see below) |

Token-protected HTTP routes another server pulls from (see `server/src/transfer.js`): `GET /bundle/info`, `GET /bundle.tgz` (server + UI code), `GET /export/sessions.tgz` (chats), `GET /export/migration.tgz` (the whole home, for Move from Termux), `GET /apk/info`, `GET /apk/download`.

## Events

| `t` | Payload | Meaning |
|---|---|---|
| `ev` | `sessionId, seq, ev` | one SDK message, or `pa_user` (echo of a sent message) / `pa_error` |
| `state` | `sessionId, state, info` | `starting \| idle \| running \| waiting \| closed` |
| `activity` | `sessionId, activity` | live status + step log, see `server/src/activity.js` |
| `permission.request` | `requestId, sessionId, toolName, input, suggestions, decisionReason, blockedPath` | Claude wants to use a tool |
| `permission.resolved` | `sessionId, requestId, behavior` | answered (from any client or a notification) |
| `meta` | `commands, models, account` | slash commands, models, account info |
| `sessions.changed` | | refresh the chat list |

## SSE `/events?v=2&api=<n>&token=` (Android background service)

The app is a generic shell: the server decides what to show and do.

| `type` | Payload | App does |
|---|---|---|
| `notify` | `spec` (fields documented at the top of `Notifier.java`) | shows/updates a notification |
| `cancel` | `id` | removes it |
| `rpc` | `id, method, params` | runs a native capability, POSTs `{ id, result \| error }` to `/native/result` |
| `batch` | `events[]` | all of the above, sent on connect to catch up |

Notification content is built in `server/src/notify.js`. Buttons POST their `body` to the `path` they name (e.g. `/permission`).
Apps older than v0.1.6 connect with `v=1` and get raw events (`hello`, `permission.request`, `permission.resolved`, `done`, `activity`).

## Native capabilities (`app/src/.../Rpc.java`)

Called from the UI with `nativeRpc(method, params)` or from the server with `callNative(method, params)`.

| Group | Methods |
|---|---|
| Info | `capabilities`, `device.info`, `permissions.check`, `permissions.request {names}` |
| Notifications | `notify {spec}`, `notify.cancel {id}`, `notifications.list`, `notifications.dismiss {key}` (needs notification access) |
| Basics | `toast`, `vibrate {ms}`, `clipboard.get/set`, `share.text`, `url.open`, `tts.speak`, `location.get` |
| Apps & intents | `app.list`, `app.launch {package}`, `intent.start {action, data, type, package, className, categories, extras, flags}`, `settings.open {screen}` |
| Screen control (accessibility) | `a11y.status`, `a11y.tree {max}`, `a11y.click/long_click {target}`, `a11y.set_text {target, text}`, `a11y.scroll {target, direction}`, `a11y.global {action}`, `a11y.gesture {points, duration}`, `a11y.screenshot {maxSide}` |
| App | `update.install {url}`, `battery.request` (ask to run unrestricted in the background); `capabilities` includes `signer` (SHA-256 of the app's signing certificate, compared with `pocket-agent.json` → `signer`) |
| Termux | `termux.status` → `installed, permission`; `termux.exec {cmd, workdir?, timeoutMs?}` → `code, stdout, stderr` (needs allow-external-apps); `termux.run {path, args, workdir, background}` (fire and forget) |

`target` is `{ index }` from `a11y.tree`, or `{ text }`, `{ desc }`, `{ id }`, or `{ x, y }`.

`POST /permission?token=` with `{ sessionId, requestId, behavior }` answers an approval.
