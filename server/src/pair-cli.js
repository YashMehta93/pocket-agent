// Prints a one-use pairing code for another device (a phone running Pocket Agent, a hub), so it can use this
// server with its own token. For a computer without the app's screen. See docs/PROTOCOL.md, "Devices".
//   node server/src/pair-cli.js [--port N] [--name "Phone hub"] [--scopes chat,files.read] [--roots "<folder1>;<folder2>"]
import fs from "node:fs";
import path from "node:path";
import { PORT, DATA } from "./config.js";   // --port is parsed there

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (!process.argv[i].startsWith("--")) continue;
  const next = process.argv[i + 1];
  args[process.argv[i].slice(2)] = next && !next.startsWith("--") ? process.argv[++i] : true;
}
const USAGE = 'Usage: node server/src/pair-cli.js [--port N] [--name "Phone hub"] [--scopes chat,files.read] [--roots "<folder1>;<folder2>"]';
if (args.help) { console.log(USAGE); process.exit(0); }

let token;
try { token = fs.readFileSync(path.join(DATA, "token"), "utf8").trim(); } catch {}
if (!token) { console.error(`No server token in ${DATA}. Is the Pocket Agent server set up here?`); process.exit(1); }

const body = {};
if (typeof args.name === "string") body.name = args.name;
if (typeof args.scopes === "string") body.scopes = args.scopes.split(",").map(s => s.trim()).filter(Boolean);
if (typeof args.roots === "string") body.roots = args.roots.split(";").map(s => s.trim()).filter(Boolean);

let res, out;
try {
  res = await fetch(`http://127.0.0.1:${PORT}/devices/pair?token=${encodeURIComponent(token)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  out = await res.json().catch(() => ({}));
} catch (e) {
  console.error(`Couldn't reach the server on port ${PORT}: ${e.message}`);
  process.exit(1);
}
if (!res.ok || !out.code) {
  console.error(out.error || `The server said no (${res.status}).`);
  process.exit(1);
}
const roots = Array.isArray(out.roots) ? out.roots : body.roots || [];
console.log(`Pair code: ${out.code}  (one use, valid for 10 minutes)`);
console.log(`This server: environment ${out.environment || "?"}, port ${PORT}`);
console.log(`Limited to: ${roots.length ? roots.join(", ") : "no folder limit"}`);
console.log("In Pocket Agent on your phone: Settings → Environments → Add, then enter this computer's address and the code.");
