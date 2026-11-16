# App ↔ server protocol

WebSocket at `ws://<server>/ws?token=<token>`. JSON messages.

- **Requests** (app → server): `{ "t": "<name>", "id": <number>, ...args }`
- **Replies**: `{ "t": "reply", "id": <same>, ...result }` or `{ "t": "reply", "id", "error": "...", "code"?, "kind"?, "short"? }`. Codes: `BUSY_ELSEWHERE`, `ENGINE_FIXED`, `NO_DEEPSEEK_KEY`, `FOLDER_BLOCKED`, `BAD_KEY`, `BAD_SETTING`; `error` is always a plain sentence to show as it is.
- **Events** (server → app, unsolicited): `{ "t": "<event>", ... }`

Handlers live in `server/src/handlers.js`. To add one: add a function there, document it here, and cover it in `server/test/e2e.mjs`.

## Requests

| `t` | Args | Reply |
|---|---|---|
| `hello` | `tzOffset?` (minutes, from `new Date().getTimezoneOffset()`; DeepSeek spend is counted per local day) | `version, protocol, uiVersion, home, host, platform, environment, environments[], defaults, pinned, commands, models, account, live[], engines[], deepseek, profiles[], defaultProfile` (see DeepSeek, Environment, Profiles and Environments below) |
| `environment.get` | | `environment`: this server's self-description (see Environment below) |
| `environment.set` | `name?, reaches?`: what to change; anything left out stays | `environment`: the saved self-description. A bad name or reach fails and changes nothing |
| `sessions.list` | `limit?, dir?` | `sessions[]: { sessionId, title, firstPrompt, cwd, lastModified, pinned, live, elsewhere, engine?, parent?, worker?, spend?, profile }`: `engine` is `"deepseek"` for DeepSeek chats (absent = Claude), `parent` the calling chat of a worker, `worker` its latest run (`at, toolUseId, runAt, result: done\|stopped\|failed\|null, steps, ms, usd, endedAt`; `result` null and no `endedAt` while it runs), `spend` a DeepSeek chat's estimated USD, `profile` the profile its folder belongs to (an id); the list also carries each environment's chats, with ids `"<envId>:<sessionId>"` |
| `session.history` | `sessionId` | `messages[]` (SDK `SessionMessage`), `info`, `seq` (the live session's seq as the transcript was read; subscribe after it to catch up) |
| `session.open` | `sessionId?, cwd?, model?, effort?, permissionMode?, engine?` | `sessionId, info`. `engine: "claude" \| "deepseek"` picks a new chat's engine (default: `defaults.engine`, else Claude); a chat keeps its engine for life, so asking an existing chat for the other one fails with `ENGINE_FIXED`. DeepSeek also fails with `NO_DEEPSEEK_KEY` or `FOLDER_BLOCKED` |
| `subscribe` | `sessionId, after` | `info` (live session or null), `events[]` with `seq > after`, `firstSeq` (the oldest seq still buffered, or null when not live: a client resuming from before it must reload the transcript), `settings`, `engine` (`"claude"` \| `"deepseek"`), `parent` (or null) |
| `unsubscribe` | `sessionId` | |
| `send` | `sessionId, text, images?[{mediaType,data}]`, plus `cwd/model/effort/permissionMode/engine` for a new chat | `sessionId, uuid` — may fail with `code: "BUSY_ELSEWHERE"`, or as `session.open` does |
| `interrupt` | `sessionId` | stops the current reply. Background workers (`wait:false`) it started keep running: stop those with `workers.stopAll` |
| `workers.stopAll` | `sessionId` | `stopped`: how many background workers this chat started were stopped (the ones waiting for a slot and the ones running) |
| `permission.reply` | `sessionId, requestId, behavior: allow\|deny, always?, allowAll?, message?, updatedInput?` | `ok`. `allowAll` (a worker's request, "Allow all for this worker"): this one, the worker's other waiting requests, and the rest of its turn are allowed without asking; questions and plans still ask, and a follow-up asks again |
| `set` | `sessionId, model?, effort?, permissionMode?` | `info`. A model must suit the chat's engine ("That model isn't available on DeepSeek/Claude."); on DeepSeek, `flash`/`pro` are accepted and an empty effort means `max` |
| `session.close` | `sessionId` | stops the Claude process and the background workers it started (chat stays on disk) |
| `server.restartWhenIdle` | | `{}`. The server restarts once no chat is mid-reply. On POSIX this is the same as SIGUSR2; under `pocket-agent.mjs` the server exits with 75 and its supervisor starts it again (`server/src/platform.js`) |
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

Token-protected HTTP routes another server pulls from (see `server/src/transfer.js`): `GET /bundle/info`, `GET /bundle.tgz` (server + UI code), `GET /export/sessions.tgz` (chats), `GET /export/migration.tgz` (the whole home, for Move from Termux), `GET /apk/info`, `GET /apk/download`. Pairing has its own routes (see Devices below): `POST /devices/redeem` (no token), `POST /devices/pair?token=` (owner).

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
| `environment` | `environment`: the whole self-description | this server's name or reaches changed (`environment.set`) |

`info` (in `state` events, `hello.live` and `subscribe`) has `sessionId, cwd, state, seq, model, effort, permissionMode, title, pending[], activity, tasks[], engine, parent, account, profile`, plus `spend` (estimated USD so far) in DeepSeek chats and `allowAll: true` while a worker runs without asking. `tasks[]`: the subagents and background commands Claude started, `{ id, kind: agent|command, description, status: running|completed|stopped|failed, activity, tokens, tools, ms, startedAt, endedAt, summary, agentType, toolUseId, taskType }` (Claude Code's own housekeeping tasks aren't listed). In `ev`, besides SDK messages: `pa_user` (a sent message), `pa_error`, and `pa_cost` `{ usd }` after each DeepSeek turn (what that turn cost, estimated).

## Environments (other Pocket Agent servers)

A server can connect to other Pocket Agent servers ("environments", e.g. a laptop) and proxy their chats. The app still talks only to the phone's server. A remote chat's id is `<envId>:<sessionId>`; local ids never contain `:`. A server hears about this hub through its normal `/ws`: the hub connects with the environment's token and sends `hello`.

| `t` | Args | Reply |
|---|---|---|
| `environments.list` | | `environments[]: { id, name, url, profile, state, version, protocol, error, lastOnlineAt }`; `state`: `connecting \| online \| offline \| unauthorized \| outdated` |
| `environments.add` | `url` (`host:port`, or with `http(s)://` / `ws(s)://`), `code` (a pairing code) or `token`, `profile?` (default: the default profile), `name?` | `environment` (the public record). With a code it is redeemed at `POST <url>/devices/redeem`, sending this server's `environment().name`; a wrong code is `That code is wrong or has expired`, a locked server `Too many tries…`, an old server `That server is too old to pair…`. An unknown profile is `No such profile`. A wrong token is saved as `unauthorized` (`Pair this device again`), so it can be paired again under the same id |
| `environments.remove` | `environment` | `{ ok: true }`; stops the connection and deletes its token file |
| `environments.rename` | `environment, name` (trimmed, 1–40) | `environment` |
| `environments.test` | `url` | `{ ok: true, version, protocol, ms }` or `{ ok: false, error: "Can't reach <host:port>" }` (the reply carries `ok: false`; it is not an error reply) |
| `environments.reconnect` | `environment` | `environment`; resets the backoff and connects now |

The id goes in `environment`, because over the WebSocket `id` is the request id. Tokens are stored per profile in the server's secrets folder (0600, folders 0700) and never appear in prefs, a reply, an event or the log. A wrong WebSocket token is answered with `401 Unauthorized` before the upgrade, so a hub can tell it from a network error. Before redeeming a code, `environments.add` asks `GET <url>/health`: if its `env` is this server's own environment id it fails with `That's this device`, and the code is not used.

**Forwarded requests — the owner's only.** A request whose `sessionId` is `<knownEnvId>:<sid>` goes to that environment: `subscribe` (the first local subscriber sends upstream `subscribe { sessionId, after }`; the last `unsubscribe` sends upstream `unsubscribe`), `unsubscribe`, and `session.history`, `session.open`, `session.context`, `send`, `interrupt`, `permission.reply`, `session.rename`, `session.pin`, `session.close`, `session.fork`. Any other request for a remote chat fails with `Not available for chats on other devices yet`. Replies are mapped like the events below. `fs.list` / `fs.search` / `fs.read` / `fs.mkdir` (and `files.*`) with `env: <envId>` go to that environment without `env`. An offline environment fails with `<name> is offline`.

A paired device never reaches another machine: such a request (a namespaced `sessionId`, or `env` on an `fs.`/`files.` call) fails with `{ error: "Chats on other machines are only for this phone's owner", code: "forbidden" }`. `POST /permission` likewise forwards a remote approval for the owner only (a device gets `403`). A namespaced id that no saved environment owns is `{ error: "No such chat", code: "not_found" }` and never reaches a local handler (otherwise `subscribe` would put it in the socket's subscriptions and relayed events could leak to it).

**Ids.** Every chat-id field from an environment (`sessionId`, `parent`, `parentSessionId`, `childSessionId`, at any depth) is always prefixed `<envId>:` — even a value that already contains `:`. A machine that sends `envB:abc` arrives here as `envA:envB:abc` and goes back only to `envA`; `splitRemoteSession` splits at the **first** `:`.

**Merged chat list.** `sessions.list` appends each environment's chats: `sessionId` becomes `<envId>:<sid>`, with `environment`, `environmentName`, `remote: true`, `offline`, and `profile`; `parent` and the other chat-id fields are mapped the same way. The list stays newest first.

**Events.** `hello` and the `environments` event carry the public list. `{ t: "environments", environments }` is sent to every client when an environment or its state changes. A remote `ev` is relayed as `{ t: "ev", sessionId: "<envId>:<sid>", … }` to subscribed clients. These chat events are relayed to everyone with mapped ids and `environment: <envId>`: `activity`, `state`, `permission.request`, `permission.resolved`, `tasks`, `account.limit`, `sessions.changed`, `link`. Nothing else is relayed (usage, accounts, settings, DeepSeek and the remote's own environment list must not overwrite this phone's state). A remote approval or finished reply also gets a phone notification headed with the environment's name; its buttons answer through the hub (`POST /permission` forwards too). Notification fields are named and plain: `type`, the mapped `sessionId`, `requestId`, `toolName`, `input` (from `toolDetail`), `title`, `envName`; an environment's object is never spread into them.

**Live chats without a screen.** The hub subscribes upstream to every chat that is live on its environment — from the upstream's `hello.live` and its `state` events — not only the chats a screen has open, so approvals and Done notify while the app is closed. It remembers each subscription's last `seq` and re-subscribes with `after: lastSeq` when the connection returns; an approval still waiting comes back in the subscribe reply's `info.pending` and is notified once (request ids already notified are remembered). At most 50 remote chats are watched per environment.

**hello views.** A device's `hello` leaves out `environments`, `profiles` and `defaultProfile` too (a device has no other machines, and the profile list is the owner's).

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

## Environment

Every server says what machine it is, so a hub (another Pocket Agent server that connects to it) can show it, route to it and check versions. The stable part lives in `prefs.environment` (`server/src/environment.js`); `hello`, `environment.get` and the `environment` event carry the whole self-description:

```js
{ id: "env-1a2b3c4d5e6f",   // "env-" and 12 hex characters; never a hostname; made once
  name: "Phone",            // "Phone" on Android/Termux, "Windows PC", "Mac" or "Linux computer" at first; 1–40 characters
  os: "android-linux",      // android-linux | windows | macos | linux
  shell: "bash",            // file name of $SHELL (or %ComSpec%)
  engines: ["claude"],      // the ready engines: claude, deepseek
  accounts: ["default"],    // Claude account ids
  reaches: [],              // up to 8 short names of what this server reaches
  limits: { symlinks: true },
  protocol: 1, version: "1.2.0", caps: ["sessions", "files", "workers", "accounts", "environment", "devices", "hub"] }
```

`protocol` rises whenever the WebSocket protocol changes in a way older apps can't handle. `caps` lists what this server can do.

`environment.set` checks `name` (trimmed, 1–40 characters) and `reaches` (up to 8 names, each trimmed, 1–24 characters of letters, digits, `_`, spaces, `.` or `-`). A bad value fails with a plain sentence and changes nothing; a good one is saved, then every client gets `{ t: "environment", environment }`.

`GET /health` needs no token and returns `ok, version, live, protocol, env`; `env` is the environment id only, so the name stays private.

## Devices

A device (another phone, a hub, a computer) can use this server with its own token instead of the owner's. Tokens are revocable and carry scopes. The server keeps only a SHA-256 hash of each token in `devices.json` in the data directory (0600), so the file holds no usable token. Every device is `{ id: "dev-…", name, scopes, createdAt, lastSeenAt }` and its token starts `pad_`.

Scopes: `chat`, `files.read`, `files.write`, `workers`, `export.sessions`, `update.source`, `sync.pair`. A new device gets `chat, files.read, files.write, workers` unless the pair code says otherwise.

| `t` | Args | Reply |
|---|---|---|
| `devices.list` | | `devices[{ id, name, scopes, createdAt, lastSeenAt }]` (no hash) |
| `devices.pair` | `name?, scopes?` (an array from the list above) | `code` ("XXXX-XXXX", one use), `expiresAt` (ms), `environment` (this server's id, or null) |
| `devices.rename` | `device, name` (trimmed, 1–40 characters) | `device` |
| `devices.revoke` | `device` | `ok: true`; its open WebSockets close with code 4001 |

These are the owner's: a device may not call them. The device's id goes in `device`; over the WebSocket `id` is the request id.

`POST /devices/redeem` needs no token: body `{ code, name? }` → `{ token, device }`, `403 { error }` for a wrong or expired code, `429 { error }` while redeeming is locked. Codes are single use and last 10 minutes. Five wrong tries while a code is active drop every active code; more than 20 wrong tries in 10 minutes lock redeeming for 10 minutes. The error text never repeats the code.

`POST /devices/pair?token=…` is the owner's: body `{ name?, scopes? }` → what `devices.pair` returns. `server/src/pair-cli.js` uses it and prints the code (for a computer without the app's screen):

```
node server/src/pair-cli.js [--port N] [--name "Phone hub"] [--scopes chat,files.read]
```

**What a device may do.** Every message type has a scope in `server/src/devices.js` (`SCOPE_OF`): `null` means any signed-in caller, a scope means a device must hold it, and a type not listed is the owner's only.

| Scope | Messages |
|---|---|
| any signed-in caller | `hello` |
| `chat` | `sessions.list`, `session.history`, `session.open`, `session.context`, `subscribe`, `unsubscribe`, `send`, `interrupt`, `permission.reply`, `session.rename`, `session.pin`, `session.fork`, `session.close` |
| `files.read` | `fs.list`, `fs.search`, `fs.read` |
| `files.write` | `fs.mkdir`, `upload` |
| `workers` | worker messages (none yet) |

Everything else — settings and prefs, `accounts.*`, `deepseek.*`, `devices.*`, `environment.set`, updates and channels, backups, `termux.*`, `services.*`, `native.call`, `session.delete` — is the owner's. A message a device may not send gets `{ error: "This device isn't allowed to do that", code: "forbidden" }`. `hello` leaves out what a device has no business seeing: `githubToken`, `updateChannel`, `updateKind`, `updateTrack`, `devRepo`, `usage`, `usageByAccount`, `account`, `accounts`, `defaultAccount`, `deepseek`, `environments`, `profiles`, `defaultProfile` and `home` (`home` stays if the device has `files.read`).

A device also never reaches chats on other machines, even with `chat` (see Environments): the reply is `code: "forbidden"`.

Over HTTP, a device may fetch `/export/sessions.tgz` with `export.sessions` and `/bundle/info` / `/bundle.tgz` with `update.source`; every other token-protected route answers `403 { error: "forbidden" }`. An unknown token is `401 { error: "bad token" }`.

**Events.** A device's socket gets only `ev`, `state`, `activity`, `permission.request`, `permission.resolved`, `tasks`, `sessions.changed` and `link` (`DEVICE_EVENTS` in `server/src/hub.js`): a chat's live state and the chat list. Every other event stays with the owner.
## Profiles

A profile says whose work a chat is (`server/src/profiles.js`): its folders (workspaces), the Claude account its chats use, environment variables, and a secrets folder of its own. A chat's profile comes from its folder: the longest workspace that contains it, else the default profile. With no saved profiles there's one **Personal** profile, and nothing is written until a profile is saved.

| `t` | Args | Reply |
|---|---|---|
| `profiles.list` | | `profiles[{ id, name, color, workspaces[], accounts{ local }, env{} }]`, `defaultProfile` (an id) |
| `profiles.save` | `profile` | `profile` (the saved one). A new profile without an `id` gets one from its name (`work`); an existing one is updated by `id` |
| `profiles.remove` | `profile` | `{ ok: true, keptSecrets }`: the profile is gone, its secrets folder is kept (at `keptSecrets`). The last profile can't be removed |
| `profiles.setDefault` | `profile` | `profiles`, `defaultProfile` |

The param is `profile`, because over the WebSocket `id` is the request id. `color` is one of `teal, blue, violet, rose, amber, green, slate` (anything else is `teal`). A workspace is an existing folder, and a folder belongs to one profile only. `accounts.local` is a Claude account id from `accounts.list` (or `default`): chats in its folders run on it unless the chat chose another account. `env` holds at most 30 variables (names like `A-Z_…`; never `HOME`, `PATH` or `ANTHROPIC_`/`CLAUDE_`/`PA_` ones); `$SECRETS` in a value is the profile's own folder, `<data>/secrets/profiles/<id>` (0700). A chat in a profile gets its env and, with two or more profiles, a guard that refuses tool calls touching another profile's secrets folder.

`hello` adds `profiles` and `defaultProfile`; `sessions.list` items carry `profile` (an id), and `info` carries the chat's `profile`. A `{ t: "profiles", profiles, defaultProfile }` event says the list changed (after save, remove or setDefault).

## SSE `/events?v=2&api=<n>&since=<ms>&token=` (Android background service)

The app is a generic shell: the server decides what to show and do.

| `type` | Payload | App does |
|---|---|---|
| `notify` | `spec` (fields documented at the top of `Notifier.java`) | shows/updates a notification |
| `cancel` | `id` | removes it |
| `rpc` | `id, method, params` | runs a native capability, POSTs `{ id, result \| error }` to `/native/result` |
| `batch` | `events[]` | all of the above, sent on connect to catch up: open approvals, an activity for every live chat (idle ones as idle), and each idle chat's last done if newer than `since` |

`since` is the phone's clock time of the last event it handled (`0` when it has none). A `done` newer than it is replayed once in the connect batch, so a turn that ended while the app was away still notifies, and a reconnect after handling it replays nothing. Apps that send no `since` (older ones) get no replay.

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
