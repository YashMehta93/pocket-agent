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

## SSE `/events?token=` (Android notification service)

`data: {json}` lines with `type`: `hello` (pending approvals, running activity), `activity`, `permission.request`, `permission.resolved`, `done`.

`POST /permission?token=` with `{ sessionId, requestId, behavior }` answers from a notification button.
