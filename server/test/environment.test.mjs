// Tests every server's self-description (environment.js): the id created once, the saved name and reaches,
// the checks, and the protocol/caps a hub uses. A throwaway HOME / PA_DATA; the app's real data is never touched.
//   node server/test/environment.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const T = fs.mkdtempSync(path.join(os.tmpdir(), "pa-environment-"));
const HOME = path.join(T, "home");
Object.assign(process.env, { HOME, PA_DATA: path.join(HOME, ".pocket-agent") });
fs.mkdirSync(process.env.PA_DATA, { recursive: true });

let fails = 0;
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) fails++; };

try {
  const { PROTOCOL, CAPS, environment, setEnvironment, detectOs } = await import("../src/environment.js");
  const { prefs } = await import("../src/config.js");

  const first = environment();
  ok("the id is created once and stays the same on a second call", first.id === environment().id && prefs.environment?.id === first.id);
  ok("the id is env- and 12 hex characters, never a hostname", /^env-[0-9a-f]{12}$/.test(first.id), first.id);
  ok("the id is saved to prefs on disk", JSON.parse(fs.readFileSync(path.join(process.env.PA_DATA, "prefs.json"), "utf8")).environment?.id === first.id);
  ok("it names itself after this kind of machine", first.name === "Linux computer", first.name);
  ok("detectOs says linux here", detectOs() === "linux", detectOs());

  let bad = null; try { setEnvironment({ name: "" }); } catch (e) { bad = e; }
  ok("an empty name is refused", bad?.message === "Give it a name of 1–40 characters", bad?.message || "");
  bad = null; try { setEnvironment({ name: "x".repeat(41) }); } catch (e) { bad = e; }
  ok("a name over 40 characters is refused", bad?.message === "Give it a name of 1–40 characters", bad?.message || "");

  bad = null; try { setEnvironment({ reaches: ["a/b"] }); } catch (e) { bad = e; }
  ok("a reach with a slash is refused", !!bad, bad?.message || "");

  const env = environment();
  ok("it says protocol 1", env.protocol === 1 && PROTOCOL === 1, String(env.protocol));
  ok("it lists its caps", Array.isArray(CAPS) && ["sessions", "files", "workers", "accounts", "environment"].every(c => env.caps.includes(c)), env.caps.join(","));
} catch (e) {
  console.log("FAIL", "test crashed", e?.stack || e);
  fails++;
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
