# Contributing

Read `docs/ARCHITECTURE.md` first (5 minutes). It explains the three parts and how a message flows.

## Setup (Termux on Android)

```bash
pkg install nodejs git aapt aapt2 d8 apksigner openjdk-17 proot
# Claude Code must be installed and logged in (`claude` works in Termux)
git clone <repo> ~/projects/pocket-agent && cd ~/projects/pocket-agent
(cd server && npm install --omit=optional)   # Agent SDK + ws; skip the bundled 200 MB binaries
npm install                                   # jsdom for UI tests
# android.jar (API 34) for builds, not committed:
mkdir -p sdk && cd sdk && curl -LO https://dl.google.com/android/repository/platform-34-ext7_r03.zip \
  && unzip -j platform-34-ext7_r03.zip '*/android.jar' && rm platform-34-ext7_r03.zip && cd ..
ln -sf "$PWD/server/bin/pocket-agent" "$PREFIX/bin/pocket-agent"
```

## Where to make a change

| You want to change… | Edit | How it reaches the phone |
|---|---|---|
| Look, layout, chat behaviour | `app/assets/ui/` | reopen the app (it reloads UI from the server) |
| Server behaviour, new request | `server/src/` (+ `docs/PROTOCOL.md`) | `pocket-agent restart --when-idle` |
| Notification wording, buttons, when to notify | `server/src/notify.js` | `pocket-agent restart --when-idle` |
| Phone features built from native capabilities | server/UI code calling `callNative()` / `nativeRpc()` | as above, no reinstall |
| A genuinely new native capability | `app/src/.../Rpc.java` (+ manifest for a new permission/service) | `./build.sh`, then the app shows "Update available": one tap |

UI files, by feature: `core.js` (helpers, connection, sheets), `render.js` (chat rendering), `activity.js` (activity bar/log), `sessions.js` (drawer), `composer.js` (input, pickers, edit/retry), `approvals.js`, `pages.js` (menus, files, settings), `main.js` (start-up, events). They're plain scripts sharing globals, loaded in the order in `index.html`. `base.js` first, `main.js` last.

## Develop without breaking your running app

Run a second server on another port and point tests at it:

```bash
npm run dev:server &          # port 8766
PA_PORT=8766 npm run test:ui
```

The phone keeps using 8765. Deploy with `pocket-agent restart --when-idle`; it waits until no chat is mid-reply.

## Tests

```bash
npm run test:ui          # headless UI (jsdom) against a running server, no Claude turns
npm run test:ui:live     # + a real Claude turn with an approval (uses your Claude plan)
npm run test:server      # protocol end-to-end, includes a real Claude turn
npm run test:native      # server ↔ phone channel with a fake phone (fast, no Claude)
```

Add a check for anything you fix. UI tests drive the real UI code. `ev("someFunction()")` calls into the page.

## Conventions

- No build step for the UI, no frameworks. Plain JS, `esc()` any text you put into HTML, `h()` to make elements.
- Java: framework APIs only (no AndroidX), so `build.sh` keeps working on a phone.
- Server: ES modules, one responsibility per file, comment the *why*.
- Keep user-facing text short and plain.
- Commit messages: what changed and why, in the imperative ("Add activity bar").
