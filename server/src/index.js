// Pocket Agent bridge server: entry point.
// Lets the Pocket Agent app drive Claude Code through the Claude Agent SDK.
// Architecture overview: docs/ARCHITECTURE.md. Protocol: docs/PROTOCOL.md.
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { VERSION, PORT, HOST, DATA, log } from "./config.js";
import { live, anyBusy, continueInterrupted, clearWorking } from "./live-session.js";
import { createServer } from "./http.js";
import { prefs, savePrefs, DEFAULT_REPO } from "./config.js";
import { ensureDefaults } from "./devtools.js";
import { startUpdateChecks } from "./autoupdate.js";
import { ensureTrustedKeys } from "./signing.js";
import { ROOT, syncVersionFile } from "./transfer.js";
import { startServices, stopServices } from "./services.js";

const server = createServer();
if (ensureTrustedKeys(ROOT)) log("restored server/trusted-keys.json");   // see trusted-keys.default.js
if (syncVersionFile(ROOT)) log("VERSION copied up from the installed APK");   // see transfer.js
// Inside the app: first-start defaults, and follow the project's GitHub releases unless told otherwise.
if (process.env.PA_SUPERVISED) {
  ensureDefaults();
  if (prefs.updateChannel === undefined && DEFAULT_REPO) { prefs.updateChannel = { github: DEFAULT_REPO, token: "" }; savePrefs(); }
  startUpdateChecks();   // a notification when a new release is out (autoupdate.js)
}
server.listen(PORT, HOST, () => {
  log(`pocket-agent server ${VERSION} on http://${HOST}:${PORT}`);
  startServices();   // background services Android's process kills took down (services.js)
  setTimeout(() => continueInterrupted().catch(e => log("continue failed", e?.message)), 3000);   // replies cut off by a kill
});

function shutdown() { stopServices(); for (const s of live.values()) s.close(); clearWorking(); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", e => log("unhandled", e?.message || e));
// Crashes and starts also go to a file in the app's data, readable from inside Linux (the app's server log isn't).
const events = line => { try { fs.appendFileSync(path.join(DATA, "server-events.log"), new Date().toISOString() + " " + line + "\n"); } catch {} };
events(`start ${VERSION} pid ${process.pid}`);
process.on("uncaughtException", e => { events("crash " + (e?.stack || e)); log("crash", e?.stack || e); process.exit(1); });
process.on("exit", code => events(`exit ${code}`));

// SIGUSR2 = restart once no chat is mid-turn (`pocket-agent restart --when-idle`),
// so deploying a server change never cuts off a reply in progress.
process.on("SIGUSR2", () => {
  log("restart requested; waiting until idle");
  const tick = () => {
    if (anyBusy()) return setTimeout(tick, 2000);
    log("idle; restarting");
    // Inside the app (PA_SUPERVISED) the app restarts us; in Termux we start our successor ourselves.
    if (!process.env.PA_SUPERVISED) {
      const bin = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../bin/pocket-agent");
      spawn("sh", ["-c", `sleep 1; exec "${bin}" start`], { detached: true, stdio: "ignore" }).unref();
    }
    server.close();
    shutdown();
  };
  tick();
});
