// Background services (server/src/services.js) survive what Android does to the app: a throwaway server
// (own HOME and PA_DATA) registers a tiny web server through the pa-service CLI, which must answer, come
// back after it is killed, come back after the whole Pocket Agent server is killed and restarted, and stop
// when removed. No network, no Claude.   node server/test/services.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "pa-services-"));
const env = { ...process.env, HOME: path.join(T, "home"), PA_DATA: path.join(T, "home/.pocket-agent"), PA_PORT: "8774" };
delete env.PA_MODE; delete env.PA_SUPERVISED;
fs.mkdirSync(env.PA_DATA, { recursive: true });
const SVC_PORT = 8798;

let fails = 0;
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cli = (...args) => { try { return execFileSync("node", [path.join(REPO, "server/devtools/pa-service"), ...args], { env, encoding: "utf8", cwd: T }); } catch (e) { return "ERROR " + (e.stderr || e.message); } };
const up = async () => { try { return (await (await fetch(`http://127.0.0.1:${SVC_PORT}/`)).text()) === "up"; } catch { return false; } };
const until = async (fn, ms = 15000) => { for (let t = 0; t < ms; t += 300) { if (await fn()) return true; await sleep(300); } return false; };
let server;
const startServer = async () => {
  server = spawn("node", [path.join(REPO, "server/src/index.js"), "--port", "8774"], { env, stdio: "ignore" });
  return until(async () => { try { return (await fetch("http://127.0.0.1:8774/health")).ok; } catch { return false; } });
};

try {
  ok("server starts", await startServer());
  fs.writeFileSync(path.join(T, "web.js"), `require("http").createServer((q, r) => r.end("up")).listen(${SVC_PORT}, "127.0.0.1")`);
  const added = cli("add", "preview", "--cwd", T, "--", "node", "web.js");
  ok("pa-service add registers and starts it", /preview: running/.test(added), added.trim());
  ok("the service answers", await until(up));
  const list1 = cli("list");
  ok("pa-service list shows it running", /preview\s+running/.test(list1));

  // it crashes or gets killed: restarted
  execFileSync("sh", ["-c", `pkill -f 'node web[.]js' || true`]);
  ok("killed, it is back on its own", await until(async () => !(await up()), 3000).then(() => until(up, 10000)));
  ok("its restart is counted", /1 restarts?/.test(cli("list")));

  // Android kills the whole app: everything dies, then the server starts again
  server.kill("SIGKILL"); execFileSync("sh", ["-c", `pkill -f 'node web[.]js' || true`]);
  await until(async () => !(await up()), 5000);
  ok("everything down", !(await up()));
  ok("server starts again", await startServer());
  ok("the service comes back with the server", await until(up));

  ok("pa-service logs shows its output log", /starting: node web.js/.test(cli("logs", "preview")));
  ok("stop keeps it registered but not running", /ok/.test(cli("stop", "preview")) && await until(async () => !(await up()), 5000) && /stopped \(off\)/.test(cli("list")));
  ok("start runs it again", /ok/.test(cli("start", "preview")) && await until(up));
  ok("remove stops and forgets it", /ok/.test(cli("remove", "preview")) && await until(async () => !(await up()), 5000) && /No background services/.test(cli("list")));
  ok("bad names are refused", /ERROR/.test(cli("add", "Bad Name!", "--", "true")));
} catch (e) { console.log("FAIL", e.stack); fails++; }
finally {
  try { server?.kill("SIGKILL"); } catch {}
  try { execFileSync("sh", ["-c", `pkill -f 'node web[.]js' || true`]); } catch {}
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
