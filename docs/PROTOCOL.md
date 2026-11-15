# App ↔ server protocol

WebSocket at `ws://<server>/ws?token=<token>`. JSON messages.

- **Requests** (app → server): `{ "t": "<name>", "id": <number>, ...args }`
- **Replies**: `{ "t": "reply", "id": <same>, ...result }` or `{ "t": "reply", "id", "error": "...", "code"?, "kind"?, "short"? }`. Codes: `BUSY_ELSEWHERE`, `ENGINE_FIXED`, `NO_DEEPSEEK_KEY`, `FOLDER_BLOCKED`, `BAD_KEY`, `BAD_SETTING`; `error` is always a plain sentence to show as it is.
- **Events** (server → app, unsolicited): `{ "t": "<event>", ... }`

Handlers live in `server/src/handlers.js`. To add one: add a function there, document it here, and cover it in `server/test/e2e.mjs`.

## Requests

| `t` | Args | Reply |
|---|---|---|
| `hello` | `tzOffset?` (minutes, from `new Date().getTimezoneOffset()`; DeepSeek spend is counted per local day) | `version, protocol, uiVersion, home, host, platform, environments[], defaults, pinned, commands, models, account, live[], engines[], deepseek` (see DeepSeek and Environments below) |
| `sessions.list` | `limit?, dir?` | `sessions[]: { sessionId, title, firstPrompt, cwd, lastModified, pinned, live, elsewhere, engine?, parent?, worker?, spend? }`: `engine` is `"deepseek"` for DeepSeek chats (absent = Claude), `parent` the calling chat of a worker, `worker` its latest run (`at, toolUseId, runAt, result: done\|stopped\|failed\|null, steps, ms, usd, endedAt`; `result` null and no `endedAt` while it runs), `spend` a DeepSeek chat's estimated USD |
| `session.history` | `sessionId` | `messages[]` (SDK `SessionMessage`), `info` |
| `session.open` | `sessionId?, cwd?, model?, effort?, permissionMode?, engine?` | `sessionId, info`. `engine: "claude" \| "deepseek"` picks a new chat's engine (default: `defaults.engine`, else Claude); a chat keeps its engine for life, so asking an existing chat for the other one fails with `ENGINE_FIXED`. DeepSeek also fails with `NO_DEEPSEEK_KEY` or `FOLDER_BLOCKED` |
| `subscribe` | `sessionId, after` | `info` (live session or null), `events[]` with `seq > after`, `settings`, `engine` (`"claude"` \| `"deepseek"`), `parent` (or null) |
| `unsubscribe` | `sessionId` | |
| `send` | `sessionId, text, images?[{mediaType,data}]`, plus `cwd/model/effort/permissionMode/engine` for a new chat | `sessionId, uuid` — may fail with `code: "BUSY_ELSEWHERE"`, or as `session.open` does |
| `interrupt` | `sessionId` | |
| `permission.reply` | `sessionId, requestId, behavior: allow\|deny, always?, allowAll?, message?, updatedInput?` | `ok`. `allowAll` (a worker's request, "Allow all for this worker"): this one, the worker's other waiting requests, and the rest of its turn are allowed without asking; questions and plans still ask, and a follow-up asks again |
| `set` | `sessionId, model?, effort?, permissionMode?` | `info`. A model must suit the chat's engine ("That model isn't available on DeepSeek/Claude."); on DeepSeek, `flash`/`pro` are accepted and an empty effort means `max` |
| `session.close` | `sessionId` | stops the Claude process (chat stays on disk) |
| `session.rename` / `session.delete` / `session.pin` | `sessionId, title` / `sessionId` / `sessionId, pinned` | |
| `session.fork` | `sessionId, upToMessageId?, title?` | `sessionId` of the copy (on the same engine) |
| `session.continueHere` | `sessionId, mode: fork\|stop` | `sessionId` to continue in |
| `session.rewindFiles` | `sessionId, userMessageId, dryRun?` | `result` |
| `session.context` | `sessionId` | `usage` (SDK context usage) |
| `session.stopTask` | `sessionId, taskId` | |
| `defaults.set` | `defaults: { cwd?, model?, effort?, permissionMode?, thinkingDisplay?, engine? }` | `defaults` (`engine`: what new chats start on) |
| `deepseek.status` | `refresh?` (ask DeepSeek for the balance first; at most every 10 s) | `deepseek` |
| `deepseek.setKey` | `key` | `deepseek`. The key is checked with DeepSeek first: refused → `BAD_KEY` and nothing saved; DeepSeek unreachable → saved, with `deepseek.note` saying so |
| `deepseek.removeKey` | | `deepseek` |
| `deepseek.settings` | `settings: { defaultModel?, effort?, dailyCapUsd?, workerMode?, toDeepseek?, toClaude?, blockedFolders?, baseUrl? }` (only the fields to change) | `deepseek`; a wrong or unknown field fails with `BAD_SETTING` and changes nothing |
| `fs.list` / `fs.search` / `fs.read` / `fs.mkdir` | `path` / `cwd, q` / `path` / `path` | entries / results / `text, binary, truncated` / |
| `upload` | `cwd, name, data` (base64) | `path` (saved under `<cwd>/.pocket-agent-uploads/`) |
| `app.update` | | `versionCode, versionName, url` of the newest built APK |
| `sessions.import` | `url, token` of another server | `added, updated, unchanged, foldersCreated` |
| `update.channel` | `url, token` (empty url = none) | `channel` |
| `releases.list` | | `releases[{tag, name, prerelease, publishedAt, notes}]` newest first, `track`, `current{version, build}` (GitHub source only) |
| `update.track` | `track`: `stable` \| `beta` \| `pin`, `tag` (for pin) | `track`. `update.check` / `update.apply` / `app.update` then follow it; a pinned older release is allowed |
| `update.check` | (`url, token`, default: the saved channel) | `available, remote, local, channel` |
| `update.apply` | (same) | `updated, depsChanged`; the server then restarts when idle |
| `migrate.run` | `url, token` of the Termux server | `job`; progress arrives as `{ t: "migrate", job }` events (built-in mode only) |
| `backup.create` / `backup.list` / `backup.restore` | — / — / `file` | `file, bytes` / `dir, backups[{file,name,bytes,at}]` / `restored` (then the server restarts when idle). Backups go to `/sdcard/Download/Pocket Agent`, without credentials or tokens |
| `services.list` / `services.add` / `services.remove` / `services.enable` / `services.restart` / `services.logs` | — / `name, cmd, cwd?` / `name` / `name, enabled` / `name` / `name, lines?` | background services kept running across app restarts (`server/src/services.js`, CLI `pa-service`): `services[{name, cmd, cwd, enabled, state, pid, since, restarts, log}]` / `service` / … / `text` |
| `termux.installCommand` | | `command` (paste into Termux), `expiresIn`: fetches `/termux/install.sh?code=` with a 30-minute code |
| `migrate.status` | | `job` |
| `native.call` | `method, params, timeoutMs?` | `result` from the phone (server → phone RPC, see below) |

Token-protected HTTP routes another server pulls from (see `server/src/transfer.js`): `GET /bundle/info`, `GET /bundle.tgz` (server + UI code), `GET /export/sessions.tgz` (chats), `GET /export/migration.tgz` (the whole home, for Move from Termux), `GET /apk/info`, `GET /apk/download`.

## Events

| `t` | Payload | Meaning |
|---|---|---|
| `ev` | `sessionId, seq, ev` | one SDK message, or `pa_user` (echo of a sent message) / `pa_error` / `pa_cost` (DeepSeek) |
| `state` | `sessionId, state, info` | `starting \| idle \| running \| waiting \| closed` |
| `activity` | `sessionId, activity, spend?` | live status + step log, see `server/src/activity.js`; `spend`: a DeepSeek chat's estimated USD so far |
| `permission.request` | `requestId, sessionId, toolName, input, suggestions, decisionReason, blockedPath, title, toolUseID, mcpServer, engine, parent` | Claude wants to use a tool (`mcpServer`: `{ name, source }` for MCP tools, `source: "sdk"` = Pocket Agent's own). `parent` is set in a worker chat: the app shows the request in that calling chat, headed with the worker |
| `permission.resolved` | `sessionId, requestId, behavior` | answered (from any client or a notification) |
| `meta` | `commands, models, account` | slash commands, models, account info |
| `sessions.changed` | | refresh the chat list |
| `deepseek` | `deepseek`: the whole object, or part of it (`spend` and `price` after metered requests, at most every 2 s) | DeepSeek key, balance, spend or settings changed |
| `link` | `parent, child, engine, title, toolUseId`, and when the run ends `result, steps, ms, usd, endedAt` | a worker chat started (or got a follow-up) for `parent` (then `sessions.changed`); sent again with how the run went |

`info` (in `state` events, `hello.live` and `subscribe`) has `sessionId, cwd, state, seq, model, effort, permissionMode, title, pending[], activity, tasks[], engine, parent`, plus `spend` (estimated USD so far) in DeepSeek chats and `allowAll: true` while a worker runs without asking. `tasks[]`: the subagents and background commands Claude started, `{ id, kind: agent|command, description, status: running|completed|stopped|failed, activity, tokens, tools, ms, startedAt, endedAt, summary, agentType, toolUseId, taskType }` (Claude Code's own housekeeping tasks aren't listed). In `ev`, besides SDK messages: `pa_user` (a sent message), `pa_error`, and `pa_cost` `{ usd }` after each DeepSeek turn (what that turn cost, estimated).

## Environments (other Pocket Agent servers)

A server can connect to other Pocket Agent servers ("environments", e.g. a laptop) and proxy their chats. The app still talks only to the phone's server. A remote chat's id is `<envId>:<sessionId>`; local ids never contain `:`. A server hears about this hub through its normal `/ws`: the hub connects with the environment's token and sends `hello`.

| `t` | Args | Reply |
|---|---|---|
| `environments.list` | | `environments[]: { id, name, url, profile, state, version, protocol, error, lastOnlineAt }`; `state`: `connecting \| online \| offline \| unauthorized \| outdated` |
| `environments.add` | `url` (`host:port`, or with `http(s)://` / `ws(s)://`), `code` (a pairing code) or `token`, `profile?` (default `personal`), `name?` | `environment` (the public record). With a code it is redeemed at `POST <url>/devices/redeem`; a wrong code is `That code is wrong or has expired`. A wrong token is saved as `unauthorized` (`Pair this device again`), so it can be paired again under the same id |
| `environments.remove` | `environment` | `{ ok: true }`; stops the connection and deletes its token file |
| `environments.rename` | `environment, name` (trimmed, 1–40) | `environment` |
| `environments.test` | `url` | `{ ok: true, version, protocol, ms }` or `{ ok: false, error: "Can't reach <host:port>" }` (the reply carries `ok: false`; it is not an error reply) |
| `environments.reconnect` | `environment` | `environment`; resets the backoff and connects now |

The id goes in `environment`, because over the WebSocket `id` is the request id. Tokens are stored per profile in the server's secrets folder (0600, folders 0700) and never appear in prefs, a reply, an event or the log. A wrong WebSocket token is answered with `401 Unauthorized` before the upgrade, so a hub can tell it from a network error.

**Forwarded requests.** A request whose `sessionId` is `<knownEnvId>:<sid>` goes to that environment: `subscribe` (the first local subscriber sends upstream `subscribe { sessionId, after }`; the last `unsubscribe` sends upstream `unsubscribe`), `unsubscribe`, and `session.history`, `session.open`, `session.context`, `send`, `interrupt`, `permission.reply`, `session.rename`, `session.pin`, `session.close`, `session.fork`. Any other request for a remote chat fails with `Not available for chats on other devices yet`. Replies are mapped like the events below. `fs.list` / `fs.search` / `fs.read` / `fs.mkdir` (and `files.*`) with `env: <envId>` go to that environment without `env`. An offline environment fails with `<name> is offline`.

**Merged chat list.** `sessions.list` appends each environment's chats: `sessionId` becomes `<envId>:<sid>`, with `environment`, `environmentName`, `remote: true`, `offline`, and `profile`; `parent` and the other chat-id fields are mapped the same way. The list stays newest first.

**Events.** `hello` and the `environments` event carry the public list. `{ t: "environments", environments }` is sent to every client when an environment or its state changes. A remote `ev` is relayed as `{ t: "ev", sessionId: "<envId>:<sid>", … }` to subscribed clients. These chat events are relayed to everyone with mapped ids and `environment: <envId>`: `activity`, `state`, `permission.request`, `permission.resolved`, `tasks`, `account.limit`, `sessions.changed`, `link`. Nothing else is relayed (usage, accounts, settings, DeepSeek and the remote's own environment list must not overwrite this phone's state). A remote approval or finished reply also gets a phone notification headed with the environment's name; its buttons answer through the hub (`POST /permission` forwards too).

## DeepSeek

A chat runs on Claude or on DeepSeek, chosen when it starts (`engine`) and kept for life. A DeepSeek chat is Claude Code pointed at DeepSeek's Anthropic-compatible API through the server's key keeper, so every message and event above works the same. The key itself never leaves the server; the app sees `keyHint` (its last 4 characters).

The `deepseek` object (`hello`, `deepseek.*` replies, `deepseek` events):

```js
{ ready: true, keyHint: "a1b2",                 // a key is saved; its last 4 characters (or null)
  note: null,                                    // e.g. "Saved. Couldn't reach DeepSeek to check it."
  balance: { total: "4.20", currency: "USD", granted: "0.00", toppedUp: "4.20", available: true, at: 1794650000000 } | null,
  balanceError: null,                            // the last balance check's problem, in plain words
  spend: { today: 0.12, month: 1.40, cap: 0, searchesToday: 0 },   // USD, estimated from token counts; cap 0 = no limit
  price: { peak: false, until: 1794652200000 },  // DeepSeek's peak price now?, and when that changes (ms)
  settings: { defaultModel: "deepseek-flash[1m]", effort: null, dailyCapUsd: 0, workerMode: null, toDeepseek: true,
              toClaude: true, blockedFolders: [], baseUrl: null, direct: false },
  models: [{ value, displayName, description, efforts: ["low","high","max"], images }] }   // Flash and V4 Pro
```

| Setting | Default | Allowed |
|---|---|---|
| `defaultModel` | `deepseek-flash[1m]` | a `models[].value` (`flash` and `pro` are accepted too) |
| `effort` | `null` (max) | `null`, `low`, `high`, `max` |
| `dailyCapUsd` | `0` (no limit) | 0–1000. Once today's spend reaches it, DeepSeek requests get a 402 with a plain message |
| `workerMode` | `null` (a worker runs in its calling chat's mode) | `null`, `default`, `acceptEdits`, `bypassPermissions` |
| `toDeepseek` / `toClaude` | `true` | Claude chats may send work to DeepSeek / DeepSeek chats may ask Claude |
| `blockedFolders` | `[]` | absolute paths (or one per line); no DeepSeek chat starts inside one (`FOLDER_BLOCKED`) |
| `baseUrl` | `null` (`https://api.deepseek.com/anthropic`) | that address, or one on this phone (`http://127.0.0.1:<port>/…`, for a stand-in) |

`engines`: `[{ id: "claude", label: "Claude", ready: true }, { id: "deepseek", label: "DeepSeek", ready }]`.

**Key keeper** (`server/src/deepseek.js`): `POST /deepseek/v1/messages` and `/deepseek/v1/messages/count_tokens`, from this phone only, authorised by a DeepSeek chat's own per-chat token (`Authorization: Bearer pa-ds-…`), not the app token. Anything else is a 404. It forwards to DeepSeek with the real key, streams the answer back untouched, and meters the usage.

**Pocket Agent's own tools** (`mcp__pocket__…`, `mcpServer.source: "sdk"`, e.g. handing work to the other engine) ask in every permission mode except Bypass, where they're allowed without a `permission.request`. `permission.reply` with `always: true` on one means that chat doesn't ask for that tool again until it closes.

## Accounts

Several Claude logins in one app: each chat runs on one account, and they share the chat list, settings, skills and memory. `default` is `~/.claude`; the others are folders in the data directory with their own login (`server/src/accounts.js`).

| `t` | Args | Reply |
|---|---|---|
| `accounts.list` | | `accounts[{ id, name, email, plan, default }]` (default first), `defaultAccount`, `usageByAccount` (each account's usage, as `hello.usage`) |
| `accounts.add` | `name` | `account: { id, name, email, plan }`; the id is slugged from the name (`work-1a2b`) |
| `accounts.login.start` | `account` | `url`: Claude's sign-in link; open it, then send the code back |
| `accounts.login.code` | `account, code` | `status: { loggedIn, email, plan }` |
| `accounts.status` | `account` | `status: { loggedIn, email, plan }` |
| `accounts.rename` | `account, name` | `accounts[]` |
| `accounts.setDefault` | `account` | `accounts[]`: the account new chats use |
| `accounts.remove` | `account` | `accounts[]`; its chats fall back to the default account |
| `chat.account` | `sessionId, account` | moves the chat to that account: a running chat closes and reopens there on the next message (the transcript is shared) |

The account id goes in `account`, because over the WebSocket `id` is the request id (the handlers also accept `id` as an alias when called directly, e.g. from tests).

`hello` adds `accounts`, `defaultAccount` and `usageByAccount` (and keeps `usage`: the default account's). A `{ t: "usage", usage, account }` event says which account's numbers changed. `{ t: "accounts", accounts, defaultAccount }` says the list changed (after add, sign-in, rename, setDefault or remove). `{ t: "account.limit", sessionId, account, limit: five_hour|seven_day|null, resetsAt }` (`resetsAt` in ms) means the account hit a limit, so the app can offer continuing the chat on another one. `info` and the `subscribe` reply include the chat's `account`.

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

`POST /permission?token=` with `{ sessionId, requestId, behavior, allowAll? }` answers an approval. A worker's approval notification is headed like the app's sheet ("DeepSeek · Add README wants to run npm test"), opens the calling chat, and has Allow / Allow all / Deny.
