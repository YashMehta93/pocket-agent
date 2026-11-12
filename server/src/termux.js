// Termux setup: the app hands the person one command to paste into Termux. That command carries a
// short-lived code (not the server token), good only for the installer script and the server bundle.
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { PORT } from "./config.js";
import { ROOT } from "./transfer.js";

const TTL = 30 * 60_000;
const codes = new Map();   // code -> expiry

export function installCommand() {
  const code = crypto.randomBytes(12).toString("hex");
  codes.set(code, Date.now() + TTL);
  for (const [c, exp] of codes) if (exp < Date.now()) codes.delete(c);
  const url = `http://127.0.0.1:${PORT}/termux/install.sh?code=${code}`;
  // Upgrade first: curl itself breaks on a partly upgraded Termux, and the script arrives through curl.
  const upgrade = "apt-get update && apt-get -y -o Dpkg::Options::=--force-confold full-upgrade";
  return { command: `${upgrade} && curl -fsSL '${url}' | bash`, expiresIn: TTL };
}
export const validCode = c => typeof c === "string" && (codes.get(c) || 0) > Date.now();

export async function installScript(code) {
  const s = await fsp.readFile(path.join(ROOT, "server/devtools/termux-install.sh"), "utf8");
  return s.replace("__APP__", `http://127.0.0.1:${PORT}`).replace("__CODE__", code);
}
