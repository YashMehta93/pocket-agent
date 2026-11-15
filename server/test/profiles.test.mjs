// Tests the profiles core: the implicit "personal" profile, workspaces and profileOf, validation, env and the
// per-profile secrets folders, the guard, and the account a profile's chats run on.
// Everything runs in a throwaway HOME / PA_DATA; no network, no Claude, and the app's real data is never touched.
//   node server/test/profiles.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const T = fs.mkdtempSync(path.join(os.tmpdir(), "pa-profiles-"));
const HOME = path.join(T, "home");
Object.assign(process.env, { HOME, PA_DATA: path.join(HOME, ".pocket-agent") });
// A stand-in for Claude Code, so nothing here can start the real one (config.js would find it on PATH).
const FAKE = path.join(T, "fakeclaude.sh");
process.env.PA_CLAUDE = FAKE;
fs.mkdirSync(process.env.PA_DATA, { recursive: true });
fs.writeFileSync(FAKE, "#!/bin/sh\nexit 2\n", { mode: 0o755 });

// Two folders for the profiles' workspaces: A (with A/sub) and B.
const A = path.join(T, "A"), Asub = path.join(A, "sub"), B = path.join(T, "B");
for (const d of [Asub, B]) fs.mkdirSync(d, { recursive: true });

let fails = 0;
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) fails++; };

try {
  const { COLORS, listProfiles, defaultProfileId, profileOf, secretsDir, saveProfile, removeProfile,
    setDefaultProfile, chatEnv, profileGuard } = await import("../src/profiles.js");
  const { prefs } = await import("../src/config.js");
  const { clients } = await import("../src/hub.js");
  const { addAccount, setDefaultAccount, setChatAccount, accountOf } = await import("../src/accounts.js");

  // ───── the default: one implicit profile, nothing written ─────
  const one = listProfiles();
  ok("one personal profile by default", one.length === 1 && one[0].id === "personal" && one[0].name === "Personal", JSON.stringify(one));
  ok("it is the default", defaultProfileId() === "personal");
  ok("palette and defaults", COLORS.includes("teal") && one[0].color === "teal" && one[0].workspaces.length === 0);
  ok("nothing is stored until a save", prefs.profiles === undefined && !fs.existsSync(path.join(process.env.PA_DATA, "prefs.json")));

  // ───── saving a profile ─────
  const sent = [];
  const fake = { readyState: 1, send: s => sent.push(JSON.parse(s)) };
  clients.add(fake);
  const work = saveProfile({ name: "Work", color: "blue", workspaces: [A] });
  clients.delete(fake);
  ok("a saved Work profile gets the id work", work.id === "work", work.id);
  ok("its workspace is resolved", work.workspaces[0] === A);
  ok("the implicit personal profile is kept", listProfiles().length === 2 && listProfiles().some(p => p.id === "personal" && p.name === "Personal"));
  ok("saving broadcasts the list", sent.some(m => m.t === "profiles" && m.profiles?.some(p => p.id === "work") && m.defaultProfile === "personal"));
  ok("its secrets folder is made, 0700", fs.existsSync(secretsDir("work")) && (fs.statSync(secretsDir("work")).mode & 0o777) === 0o700);

  // ───── which profile a folder is ─────
  ok("A is Work", profileOf(A).id === "work");
  ok("A/sub is Work", profileOf(Asub).id === "work");
  ok("B is Personal", profileOf(B).id === "personal");
  ok("no folder is Personal", profileOf(undefined).id === "personal");

  // ───── validation ─────
  let dup = null; try { saveProfile({ name: "Other", workspaces: [A] }); } catch (e) { dup = e; }
  ok("a folder already in another profile is refused", dup?.message === `${A} is already in Work`, dup?.message || "");
  let badEnv = null; try { saveProfile({ id: "work", name: "Work", workspaces: [A], env: { ANTHROPIC_API_KEY: "sk-x" } }); } catch (e) { badEnv = e; }
  ok("ANTHROPIC_ variables are refused", !!badEnv && badEnv.message.includes("ANTHROPIC_API_KEY"), badEnv?.message || "");
  let badKey = null; try { saveProfile({ id: "work", name: "Work", workspaces: [A], env: { "BAD-KEY": "x" } }); } catch (e) { badKey = e; }
  ok("bad variable names are refused", !!badKey);
  let missing = null; try { saveProfile({ name: "Nowhere", workspaces: [path.join(T, "nope")] }); } catch (e) { missing = e; }
  ok("a workspace must exist", !!missing);

  // ───── env and the secrets folder ─────
  const envWork = saveProfile({ id: "work", name: "Work", color: "blue", workspaces: [A], env: { TOKEN_FILE: "$SECRETS/token", PLAIN: "hello" } });
  const base = { KEEP: "1" };
  const env = chatEnv(envWork, base);
  ok("$SECRETS is replaced with the profile's folder", env.TOKEN_FILE === path.join(secretsDir("work"), "token"), env.TOKEN_FILE);
  ok("PA_PROFILE and PA_PROFILE_SECRETS are set", env.PA_PROFILE === "work" && env.PA_PROFILE_SECRETS === secretsDir("work"));
  ok("the base environment is kept", env.KEEP === "1" && env.PLAIN === "hello");
  ok("the base environment is not changed", base.TOKEN_FILE === undefined && base.PA_PROFILE === undefined);

  // ───── the guard ─────
  const guard = profileGuard(profileOf(A));
  const deny = await guard({ tool_input: { command: `cat ${secretsDir("personal")}/key` } });
  ok("the guard denies another profile's secrets folder", deny?.hookSpecificOutput?.permissionDecision === "deny");
  ok("it names the profile", deny?.hookSpecificOutput?.permissionDecisionReason === "That folder belongs to the Personal profile.", deny?.hookSpecificOutput?.permissionDecisionReason || "");
  const denyPlain = await guard({ tool_input: { command: "ls secrets/profiles/personal" } });
  ok("the guard denies the plain path too", denyPlain?.hookSpecificOutput?.permissionDecision === "deny");
  const allow = await guard({ tool_input: { command: "ls /tmp" } });
  ok("the guard allows an ordinary command", Object.keys(allow).length === 0);
  const own = await guard({ tool_input: { path: secretsDir("work") } });
  ok("the guard allows its own secrets folder", Object.keys(own).length === 0);

  // ───── the account a chat runs on ─────
  const personalAcct = addAccount("Personal login"), workAcct = addAccount("Work login");
  setDefaultAccount(personalAcct.id);
  saveProfile({ id: "work", name: "Work", color: "blue", workspaces: [A], accounts: { local: workAcct.id }, env: { TOKEN_FILE: "$SECRETS/token" } },
    ["default", personalAcct.id, workAcct.id]);
  ok("a chat in the Work folder runs on Work's account", accountOf("chat-profile", A) === workAcct.id, accountOf("chat-profile", A));
  ok("a chat in another folder runs on the default account", accountOf("chat-b", B) === personalAcct.id);
  ok("without a folder, the default account", accountOf("chat-b") === personalAcct.id);
  setChatAccount("chat-choice", personalAcct.id);
  ok("the chat's own choice wins", accountOf("chat-choice", A) === personalAcct.id);
  let badAcct = null; try { saveProfile({ id: "work", name: "Work", workspaces: [A], accounts: { local: "nope" } }, ["default", personalAcct.id, workAcct.id]); } catch (e) { badAcct = e; }
  ok("an unknown account is refused", !!badAcct);

  // ───── default and removal ─────
  setDefaultProfile("work");
  ok("the default profile can change", defaultProfileId() === "work");
  const removed = removeProfile("work");
  ok("removing a profile keeps its secrets folder", removed.ok === true && removed.keptSecrets === secretsDir("work") && fs.existsSync(secretsDir("work")));
  ok("removing the default makes the first remaining one default", defaultProfileId() === "personal");
  let last = null; try { removeProfile("personal"); } catch (e) { last = e; }
  ok("the last profile can't be removed", last?.message === "Keep at least one profile", last?.message || "");
  const disk = JSON.parse(fs.readFileSync(path.join(process.env.PA_DATA, "prefs.json"), "utf8"));
  ok("profiles are saved in prefs.json", Array.isArray(disk.profiles) && disk.profiles.length === 1 && disk.profiles[0].id === "personal" && disk.defaultProfile === "personal");
} catch (e) {
  console.log("FAIL", "test crashed", e?.stack || e);
  fails++;
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
