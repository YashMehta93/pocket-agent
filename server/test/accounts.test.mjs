// Tests the several-Claude-accounts core: the registry, shared folders, sign-in and per-chat accounts.
// Everything runs in a throwaway HOME / PA_DATA with a fake Claude Code; no network, no real sign-in, and the
// app's real data is never touched.   node server/test/accounts.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const T = fs.mkdtempSync(path.join(os.tmpdir(), "pa-accounts-"));
const HOME = path.join(T, "home");
Object.assign(process.env, { HOME, PA_DATA: path.join(HOME, ".pocket-agent") });
// A stand-in for Claude Code, so nothing here can start the real one (config.js would find it on PATH).
const FAKE = path.join(T, "fakeclaude.sh");
process.env.PA_CLAUDE = FAKE;
fs.mkdirSync(process.env.PA_DATA, { recursive: true });

const write = (f, s, mode) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s, mode ? { mode } : undefined); };
// The owner's setup: only these items are shared with an extra account.
const CLAUDE_HOME = path.join(HOME, ".claude");
fs.mkdirSync(path.join(CLAUDE_HOME, "projects"), { recursive: true });
fs.mkdirSync(path.join(CLAUDE_HOME, "skills"), { recursive: true });
write(path.join(CLAUDE_HOME, "CLAUDE.md"), "# shared\n");
write(path.join(CLAUDE_HOME, "settings.json"), "{}");
write(path.join(CLAUDE_HOME, ".claude.json"), "{}");   // never linked into an account folder
write(FAKE, `#!/bin/sh
if [ "$1 $2" = "auth login" ]; then echo "Browser didn't open? Use the url below to sign in:"; echo "https://claude.ai/oauth/authorize?code=true&state=abc"; read code; if [ "$code" = "good-code" ]; then echo signed > "$CLAUDE_CONFIG_DIR/.signed"; echo "Login successful"; exit 0; fi; echo "Invalid code"; exit 1; fi
if [ "$1 $2" = "auth status" ]; then if [ -f "$CLAUDE_CONFIG_DIR/.signed" ]; then echo '{"loggedIn":true,"email":"work@example.com","subscriptionType":"max"}'; else echo '{"loggedIn":false}'; fi; exit 0; fi
exit 2
`, 0o755);

let fails = 0;
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) fails++; };

try {
  const { ACCOUNTS_DIR, listAccounts, accountDir, addAccount, ensureLinks, renameAccount, setDefaultAccount,
    removeAccount, accountOf, setChatAccount, accountEnv, loginStart, loginCode } = await import("../src/accounts.js");
  const { prefs } = await import("../src/config.js");

  const one = listAccounts();
  ok("only the default account at first", one.length === 1 && one[0].id === "default" && one[0].default === true);

  const work = addAccount("Work");
  const dir = path.join(ACCOUNTS_DIR, work.id);
  ok("a new account gets a slugged id", work.id.startsWith("work-"), work.id);
  ok("its folder exists, 0700", fs.existsSync(dir) && (fs.statSync(dir).mode & 0o777) === 0o700);

  const links = ["projects", "CLAUDE.md", "settings.json", "skills"];
  ok("the shared items are symlinks to ~/.claude", links.every(item => {
    const link = path.join(dir, item), st = fs.lstatSync(link);
    return st.isSymbolicLink() && fs.readlinkSync(link) === path.join(CLAUDE_HOME, item);
  }));
  ok("nothing else is in the folder (no login, no .claude.json)",
    !fs.existsSync(path.join(dir, ".claude.json")) &&
    fs.readdirSync(dir).sort().join(",") === links.slice().sort().join(",") &&
    fs.readdirSync(dir).every(item => fs.lstatSync(path.join(dir, item)).isSymbolicLink()));

  process.env.CLAUDE_CONFIG_DIR = "/x";
  process.env.ANTHROPIC_API_KEY = "k";
  const envWork = accountEnv(work.id), envDefault = accountEnv("default");
  ok("the account's env points at its folder", envWork.CLAUDE_CONFIG_DIR === dir);
  ok("the default account's env has no CLAUDE_CONFIG_DIR", envDefault.CLAUDE_CONFIG_DIR === undefined);
  ok("provider keys are not inherited", !envWork.ANTHROPIC_API_KEY && !envDefault.ANTHROPIC_API_KEY);
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.ANTHROPIC_API_KEY;

  const URL = "https://claude.ai/oauth/authorize?code=true&state=abc";
  let url = null; try { url = await loginStart(work.id, { bin: FAKE }); } catch { url = null; }
  ok("loginStart returns the sign-in link", url === URL, url || "");

  let bad = null; try { await loginCode(work.id, "bad-code", { bin: FAKE }); } catch (e) { bad = e; }
  ok("a wrong code is refused", !!bad && bad.message.startsWith("Sign-in didn't work"), bad?.message || "");

  await loginStart(work.id, { bin: FAKE });
  const st = await loginCode(work.id, "good-code", { bin: FAKE });
  ok("a good code signs the account in", st.loggedIn === true && st.email === "work@example.com" && st.plan === "max", JSON.stringify(st));
  ok("the account shows its email", listAccounts().some(a => a.id === work.id && a.email === "work@example.com"));

  setChatAccount("chat-1", work.id);
  ok("a chat keeps its account", accountOf("chat-1") === work.id && accountOf("other") === "default");
  setDefaultAccount(work.id);
  ok("new chats use the default account", accountOf("other") === work.id);

  renameAccount(work.id, "Office");
  ok("an account can be renamed", listAccounts().some(a => a.id === work.id && a.name === "Office"));

  removeAccount(work.id);
  ok("removing an account deletes only its folder", !fs.existsSync(dir));
  ok("the shared files survive", fs.existsSync(path.join(CLAUDE_HOME, "CLAUDE.md")) && fs.existsSync(path.join(CLAUDE_HOME, "projects")));
  ok("its chats fall back to the default account", accountOf("chat-1") === "default");
  ok("the default account is cleared", prefs.defaultAccount === undefined);

  let defErr = null; try { removeAccount("default"); } catch (e) { defErr = e; }
  ok("the default account can't be removed", !!defErr);

  let unknown = null; try { accountDir("nope"); } catch (e) { unknown = e; }
  ok("unknown accounts are refused", !!unknown && unknown.message === "Unknown account");
} catch (e) {
  console.log("FAIL", "test crashed", e?.stack || e);
  fails++;
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
