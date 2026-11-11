// Pocket Agent bridge server: entry point.
// Lets the Pocket Agent app drive Claude Code through the Claude Agent SDK.
// Architecture overview: docs/ARCHITECTURE.md. Protocol: docs/PROTOCOL.md.
import path from "node:path";
import { spawn } from "node:child_process";
import { VERSION, PORT, HOST, log } from "./config.js";
import { live, anyBusy } from "./live-session.js";
import { createServer } from "./http.js";

const server = createServer();
server.listen(PORT, HOST, () => log(`pocket-agent server ${VERSION} on http://${HOST}:${PORT}`));

function shutdown() { for (const s of live.values()) s.close(); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", e => log("unhandled", e?.message || e));

// SIGUSR2 = restart once no chat is mid-turn (`pocket-agent restart --when-idle`),
// so deploying a server change never cuts off a reply in progress.
process.on("SIGUSR2", () => {
  log("restart requested; waiting until idle");
  const tick = () => {
    if (anyBusy()) return setTimeout(tick, 2000);
    log("idle; restarting");
    const bin = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../bin/pocket-agent");
    spawn("sh", ["-c", `sleep 1; exec "${bin}" start`], { detached: true, stdio: "ignore" }).unref();
    server.close();
    shutdown();
  };
  tick();
});
