// Tests DeepSeek in Pocket Agent: prices, the key file, the key keeper (the /deepseek proxy), backups, the delegation tools
// and their reports, and then, with the real Claude Code binary, DeepSeek chats and Claude ↔ DeepSeek workers end to end
// against the fake DeepSeek (mock-deepseek.mjs). Without a Claude Code binary (CI) only the unit part runs.
// No key, no Claude account, no network: a throwaway HOME / PA_DATA; test-mode Claude chats talk to the fake too, and
// anything Claude Code aims at another host goes to the fake's refusing proxy and fails the test.
//   npm run test:deepseek     On the phone, one Claude Code test at a time: flock /tmp/pa-claude-test.lock npm run test:deepseek
//   npm run test:deepseek -- --unit     the unit part only
// Ports: 8771 (the test server), 8772 (the fake DeepSeek).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { startMock, parseDirectives } from "./mock-deepseek.mjs";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const SERVER_PORT = 8771, MOCK_PORT = 8772;
const KEY = "sk-test-deepseek";                 // the "real" DeepSeek key: only the server and the fake may ever see it
// What test-mode Claude chats send to the fake (PA_TEST_ANTHROPIC_KEY). Not the DeepSeek key, as the spec had it: DeepSeek
// chats inherit PA_TEST_ANTHROPIC_KEY, and their environment must be free of the DeepSeek key for the check below to mean anything.
const CLAUDE_KEY = "sk-test-claude-engine";
const DS_TOOL = "mcp__pocket__deepseek_task", CLAUDE_TOOL = "mcp__pocket__claude_task";
const UNIT_ONLY = process.argv.includes("--unit");
const CLAUDE_BIN = findClaude();                // before HOME changes: Claude Code lives in the real home
const T = fs.mkdtempSync(path.join(os.tmpdir(), "pa-deepseek-"));
// Nothing from the shell that runs us may reach the servers or Claude Code: inside Pocket Agent that's the app's own
// PA_DATA and Claude Code's session variables.
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC|PA_|MCP_|HTTPS?_PROXY$|NO_PROXY$)/i.test(k)));

let fails = 0;
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra ? `(${String(extra).replace(/\n/g, "\\n").slice(0, 400)})` : ""); if (!cond) fails++; return !!cond; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const textOf = c => typeof c === "string" ? c : Array.isArray(c) ? c.map(x => x?.text || "").join("\n") : "";
const resultText = r => textOf(r?.content);
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
async function step(name, fn) { try { await fn(); } catch (e) { ok(name, false, e?.stack?.split("\n").slice(0, 4).join(" | ") || e); } }
async function until(fn, ms, what) { for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (fn()) return; throw new Error(`timed out waiting for ${what}`); }
function findClaude() {
  const dirs = [path.join(os.homedir(), ".local/bin"), ...(process.env.PATH || "").split(":").filter(Boolean)];
  for (const d of dirs) { const p = path.join(d, "claude"); try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {} }
  return null;
}

// ───── the unit part runs in this process, with its own throwaway home ─────
const UHOME = path.join(T, "unit"), UDATA = path.join(UHOME, ".pocket-agent");
const FAKE_CLAUDE = path.join(T, "fake-claude");                       // nothing in this process may start the real one
fs.writeFileSync(FAKE_CLAUDE, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
for (const k of Object.keys(process.env)) if (!(k in CLEAN)) delete process.env[k];
Object.assign(process.env, { HOME: UHOME, PA_DATA: UDATA, PA_BACKUP_DIR: path.join(T, "backups"), PA_PORT: String(SERVER_PORT),
  PA_DEEPSEEK_URL: `http://127.0.0.1:${MOCK_PORT}/anthropic`, PA_CLAUDE: FAKE_CLAUDE });
fs.mkdirSync(UDATA, { recursive: true });

let mock = null, server = null;
const hardStop = setTimeout(async () => { console.log("FAIL the whole test took over 25 minutes"); await stopServer(); process.exit(1); }, 25 * 60e3);
hardStop.unref();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await stopServer(); process.exit(1); });

// (the run itself is at the end of the file, once every class and binding below exists)

async function unitTests() {
  // ───── the fake itself ─────
  await step("fake DeepSeek", async () => {
    const post = (body, headers = { authorization: `Bearer ${KEY}` }) => fetch(`${mock.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const r401 = await post({ model: "deepseek-flash", messages: [{ role: "user", content: "hi" }] }, { authorization: "Bearer sk-nope-12345678" });
    ok("fake: a wrong key gets DeepSeek's 401; x-api-key works too", r401.status === 401 && /Authentication Fails/.test(await r401.text())
      && (await post({ model: "deepseek-flash", messages: [{ role: "user", content: "hi" }] }, { "x-api-key": KEY })).status === 200);
    const codes = [await post({ model: "gpt-5", messages: [] }), await post({ model: "deepseek-flash", tools: [{ type: "custom", name: "x" }], messages: [] }),
      await post({ model: "deepseek-flash", thinking: { type: "enabled" }, tools: [{ name: "Bash" }], tool_choice: { type: "any" }, messages: [] }),
      await post({ model: "deepseek-flash", thinking: { type: "adaptive" }, tools: [{ name: "Bash" }], messages: [{ role: "user", content: "x" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }] })].map(r => r.status);
    ok("fake: unknown model 400, custom tool 422, tool_choice any with thinking 400, thinking not sent back 400", codes.join() === "400,422,400,400", codes.join());
    const task = `Build it. [[slow 50]] [[tool Bash ${JSON.stringify({ command: "echo ok" })}]]`;
    const d = parseDirectives(`Go [[think]] [[tool ${DS_TOOL} ${JSON.stringify({ task, title: "T" })}]]`);
    ok("fake: a worker's directives stay inside the caller's tool call", d.tools.length === 1 && d.tools[0].input.task === task && d.think && d.slow === 0);
    const bal = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/user/balance`, { headers: { authorization: `Bearer ${KEY}` } })).json();
    ok("fake: the balance answers like DeepSeek's", bal.is_available === true && bal.balance_infos?.[0]?.total_balance === "4.20");
  });

  const ds = await import("../src/deepseek.js");
  const en = await import("../src/engines.js");
  const dg = await import("../src/delegate.js");
  const { toolVerb, toolDetail } = await import("../src/activity.js");

  // ───── prices ─────
  await step("prices", async () => {
    const tue = (h, m = 0) => Date.UTC(2026, 10, 17, h, m);   // Tuesday, 17 Nov 2026
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    ok("prices: peak is Tue 02:00 UTC, not Tue 05:00 or Sat 02:00", new Date(tue(0)).getUTCDay() === 2 && ds.isPeak(tue(2)) && !ds.isPeak(tue(5)) && !ds.isPeak(Date.UTC(2026, 10, 14, 2)));
    ok("prices: 1M Flash miss tokens cost $0.30 at peak, $0.15 off-peak",
      near(ds.costOf("deepseek-flash", { input_tokens: 1e6 }, tue(2)), 0.30) && near(ds.costOf("deepseek-flash", { input_tokens: 1e6 }, tue(5)), 0.15));
    ok("prices: 1M V4 Pro output tokens cost $3.96 at peak; 1M Flash cache hits $0.006",
      near(ds.costOf("deepseek-v4-pro", { output_tokens: 1e6 }, tue(2)), 3.96) && near(ds.costOf("deepseek-flash", { cache_read_input_tokens: 1e6 }, tue(2)), 0.006));
    const now = ds.priceNow(tue(3, 59));
    ok("prices: from Tue 03:59 UTC it's peak until 04:00", now?.peak === true && now.until === tue(4), JSON.stringify(now));
  });

  // ───── models and the tripwire ─────
  await step("models and tripwire", async () => {
    ok("dsModel: flash, pro and bare names become DS_MODELS values", ds.dsModel("flash") === "deepseek-flash[1m]" && ds.dsModel("pro") === "deepseek-v4-pro[1m]"
      && ds.dsModel("deepseek-v4-pro") === "deepseek-v4-pro[1m]" && ds.dsModel("deepseek-flash[1m]") === "deepseek-flash[1m]");
    ok("dsModel: anything else becomes the default", ds.dsModel("gpt-5") === "deepseek-flash[1m]" && ds.dsModel("claude-opus-5-5") === "deepseek-flash[1m]" && ds.isDeepseekModel("deepseek-flash[1m]") && !ds.isDeepseekModel("opus"));
    const denied = async (tool_name, tool_input) => (await en.tripwire({ hook_event_name: "PreToolUse", tool_name, tool_input }))?.hookSpecificOutput?.permissionDecision === "deny";
    const secrets = ["/root/.pocket-agent/secrets/deepseek", "/root/.pocket-agent/token", "/root/.claude/.credentials.json", "/proc/123/environ", "/proc/self/environ",
      "/root/.config/pocket-agent/github-token", "/root/.config/ado/pat", "/root/.git-credentials", "/root/projects/app/pocket-agent.keystore", "/root/release-key.pem", "/root/.ssh/id_ed25519"];
    const missed = [];
    for (const p of secrets) if (!(await denied("Read", { file_path: p })) || !(await denied("Bash", { command: `cat ${p} | head` }))) missed.push(p);
    ok("tripwire: Read and Bash on every secret path are denied", !missed.length, missed.join(", "));
    ok("tripwire: an ordinary file goes through", !(await denied("Read", { file_path: "src/app.js" })) && !(await denied("Bash", { command: "npm test" })));
  });

  // ───── no key yet: no deepseek_task ─────
  const fake = (o = {}) => ({ sessionId: "aaaaaaaa-0000-4000-8000-000000000001", cwd: UHOME, title: "Parent chat", engine: "claude", link: null,
    permissionMode: "default", approvals: new Map(), takeApproval() { return null; }, ...o });
  const toolNames = s => dg.pocketTools(s).map(t => t.name).join(",");
  await step("tools without a key", async () => {
    ok("no key: Claude chats get no deepseek_task (and no pocket server)", toolNames(fake()) === "" && dg.toolsFor(fake()) === undefined);
    ok("no key: DeepSeek chats still get claude_task", toolNames(fake({ engine: "deepseek" })) === "claude_task");
  });

  // ───── the key file ─────
  const keyFile = path.join(UDATA, "secrets/deepseek"), prefsFile = path.join(UDATA, "prefs.json");
  await step("setKey", async () => {
    let bad = null; try { await ds.setKey("sk-wrong-key-12345"); } catch (e) { bad = e; }
    ok("setKey: a key DeepSeek refuses → BAD_KEY, nothing saved, key not echoed", bad?.code === "BAD_KEY" && !fs.existsSync(keyFile) && !ds.ready() && !String(bad?.message).includes("sk-wrong-key-12345"), bad?.message);
    let odd = null; try { await ds.setKey("not a key"); } catch (e) { odd = e; }
    ok("setKey: something that isn't a key is refused before asking DeepSeek", !!odd && !fs.existsSync(keyFile));
    const st = await ds.setKey(`  ${KEY}\n`);
    const mode = f => fs.statSync(f).mode & 0o777;
    ok("setKey: the right key is saved, trimmed, 0600 in a 0700 folder", ds.ready() && fs.readFileSync(keyFile, "utf8") === KEY && mode(keyFile) === 0o600 && mode(path.dirname(keyFile)) === 0o700,
      fs.existsSync(keyFile) ? (mode(keyFile).toString(8) + " " + mode(path.dirname(keyFile)).toString(8)) : "no file");
    ok("status() shows only the last 4 characters", st?.keyHint === KEY.slice(-4) && !JSON.stringify(ds.status()).includes(KEY));
    ok("prefs.json never holds the key", !fs.existsSync(prefsFile) || !fs.readFileSync(prefsFile, "utf8").includes(KEY));
    ds.removeKey();
    ok("removeKey deletes the file", !fs.existsSync(keyFile) && !ds.ready());
    await ds.setKey(KEY);
  });

  // ───── the key keeper ─────
  await step("SSE usage parser", async () => {
    const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const sse = ": keep-alive\n\n" + ev("message_start", { type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 1 } } })
      + ev("ping", { type: "ping" }) + ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "héllo ✓ 你好" } })
      + ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } }) + ev("message_stop", { type: "message_stop" });
    const usage = (text, size) => { const p = ds.sseUsage(), b = Buffer.from(text); for (let i = 0; i < b.length; i += size) p.push(b.subarray(i, i + size)); return { u: p.end(), stopped: p.stopped }; };
    const whole = usage(sse, 1e9), bytes = usage(sse, 1), crlf = usage(sse.replace(/\n/g, "\r\n"), 3);
    ok("SSE usage parser: the same usage whole, one byte at a time (UTF-8 cut too) and with CRLF", whole.u?.output_tokens === 42 && whole.u.input_tokens === 5 && whole.u.cache_read_input_tokens === 20
      && JSON.stringify(bytes.u) === JSON.stringify(whole.u) && JSON.stringify(crlf.u) === JSON.stringify(whole.u) && whole.stopped && bytes.stopped && crlf.stopped, JSON.stringify([whole, bytes, crlf]));
  });

  await step("key keeper", async () => {
    const proxySrv = http.createServer((req, res) => { const url = new URL(req.url, "http://x"); if (url.pathname.startsWith("/deepseek/")) return ds.proxy(req, res, url); res.writeHead(404); res.end(); });
    await new Promise(r => proxySrv.listen(SERVER_PORT, "127.0.0.1", r));
    try {
      const CHAT = "bbbbbbbb-0000-4000-8000-000000000002", token = ds.issueToken(CHAT);
      const via = (body, { tok = token, p = "/v1/messages?beta=true", method = "POST", signal } = {}) => fetch(`http://127.0.0.1:${SERVER_PORT}/deepseek${p}`,
        { method, signal, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined });
      const ask = (text, stream = true) => ({ model: "deepseek-flash", stream, max_tokens: 100, messages: [{ role: "user", content: text }] });
      const n0 = mock.requests.length, sum = { hit: 0, miss: 0, out: 0 };
      const add = u => { sum.hit += u.cache_read_input_tokens; sum.miss += u.input_tokens; sum.out += u.output_tokens; };
      const same = sp => sp && sp.hit === sum.hit && sp.miss === sum.miss && sp.out === sum.out;
      const r1 = await via(ask("[[split]] Count every token of this reply, please.")); const body1 = await r1.text(); add(mock.requests.at(-1).usage); await sleep(50);
      ok("key keeper: a stream cut mid-event comes through whole and is metered exactly", r1.status === 200 && /message_stop/.test(body1) && same(ds.chatSpend(CHAT)) && ds.chatSpend(CHAT).n === 1,
        JSON.stringify({ spend: ds.chatSpend(CHAT), sum }));
      await (await via(ask("And this one, in one piece."))).text(); add(mock.requests.at(-1).usage);
      const r3 = await via(ask("And a reply that isn't streamed.", false)); await r3.json(); add(mock.requests.at(-1).usage); await sleep(50);
      const sp = ds.chatSpend(CHAT);
      ok("key keeper: whole streams and plain replies are metered too, with a cost", same(sp) && sp.n === 3 && sp.usd > 0, JSON.stringify({ sp, sum }));
      const ups = mock.requests.slice(n0);
      ok("key keeper: DeepSeek gets the real key and the same path, never the chat's pass", ups.length === 3 && ups.every(r => r.auth === `Bearer ${KEY}` && r.path === "/anthropic/v1/messages" + (r.stream ? "?beta=true" : "?beta=true")),
        ups.map(r => `${r.auth} ${r.path}`).join(" | "));
      ok("key keeper: an unknown pass gets 401", (await via(ask("hi"), { tok: "pa-ds-" + "0".repeat(32) })).status === 401);
      ok("key keeper: only POST /v1/messages and count_tokens (balance with a pass → 404)", (await via(null, { p: "/user/balance", method: "GET" })).status === 404
        && (await via(ask("hi"), { p: "/v1/models" })).status === 404);
      const ct = await via(ask("hi"), { p: "/v1/messages/count_tokens" });
      ok("key keeper: count_tokens is passed on (DeepSeek's 404 comes back)", ct.status === 404 && mock.requests.at(-1).countTokens === true);
      // Stop in a chat: Claude Code hangs up, and the request to DeepSeek must end too
      const ac = new AbortController(), marker = "HANG-UP-" + Date.now();
      const slow = await via(ask(`[[slow 200]] ${marker} ` + "words ".repeat(100)), { signal: ac.signal });
      const reader = slow.body.getReader(); await reader.read(); await sleep(300); ac.abort(); await reader.read().catch(() => {});
      await until(() => mock.requests.some(r => r.bodyText.includes(marker) && r.closedEarly), 3000, "the cut-off upstream request").catch(() => {});
      ok("key keeper: when the chat hangs up, the request to DeepSeek is cut off too", mock.requests.some(r => r.bodyText.includes(marker) && r.closedEarly));
      ds.revokeToken(token);
      ok("key keeper: a revoked pass gets 401", (await via(ask("hi"))).status === 401);
    } finally { await new Promise(r => { proxySrv.close(() => r()); proxySrv.closeAllConnections?.(); }); }
  });

  // ───── backups ─────
  await step("backups", async () => {
    const { createBackup } = await import("../src/backup.js");
    const spend = path.join(UDATA, "deepseek-spend.json");
    await until(() => fs.existsSync(spend), 4000, "the spend file").catch(() => write(spend, "{}"));   // written within 2 s of metering
    if (!fs.existsSync(prefsFile)) write(prefsFile, "{}");
    write(path.join(UHOME, ".claude/projects/-x/chat.jsonl"), "{}\n");
    const b = await createBackup();
    const names = execFileSync("tar", ["tzf", b.file]).toString().split("\n");
    ok("backups skip the key and the spend file", names.includes(".pocket-agent/prefs.json") && names.includes(".claude/projects/-x/chat.jsonl")
      && !names.some(n => /secrets|deepseek-spend/.test(n)) && fs.existsSync(spend) && fs.existsSync(keyFile));
  });

  // ───── a DeepSeek chat's environment ─────
  await step("engine options", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-canary-1"; process.env.ANTHROPIC_API_KEY = "sk-ant-canary-2"; process.env.CLAUDE_CONFIG_DIR = "/root/.claude";
    const s = { sessionId: "dddddddd-0000-4000-8000-000000000004", engine: "deepseek", model: "deepseek-flash[1m]", cwd: UHOME, link: null };
    let o;
    try { o = en.engineOptions(s); } finally { delete process.env.CLAUDE_CODE_OAUTH_TOKEN; delete process.env.ANTHROPIC_API_KEY; delete process.env.CLAUDE_CONFIG_DIR; }
    const envText = JSON.stringify(o.env || {});
    ok("a DeepSeek chat's environment has no key and no Claude login, only its own pass to this server",
      !envText.includes(KEY) && !envText.includes("canary") && /^pa-ds-[0-9a-f]{32}$/.test(o.env?.ANTHROPIC_AUTH_TOKEN || "") && o.env.ANTHROPIC_BASE_URL === `http://127.0.0.1:${SERVER_PORT}/deepseek`);
    ok("…its own config folder, no calls home, and the tripwire", o.env.CLAUDE_CONFIG_DIR === path.join(UDATA, "engines/deepseek") && o.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === "1"
      && o.hooks?.PreToolUse?.length > 0 && s.proxyToken === o.env.ANTHROPIC_AUTH_TOKEN && /^deepseek-flash/.test(o.model || ""));
    const dsDir = path.join(UDATA, "engines/deepseek");
    ok("…and that folder never holds a Claude login", !fs.existsSync(path.join(dsDir, ".credentials.json")) && fs.lstatSync(path.join(dsDir, "projects")).isSymbolicLink());
    ds.revokeToken(s.proxyToken);
    ok("Claude chats get no extra options", JSON.stringify(en.engineOptions({ sessionId: "x", engine: "claude", cwd: UHOME })) === "{}");
  });

  // ───── the delegation tools ─────
  await step("tools with a key", async () => {
    ok("with a key: Claude chats get deepseek_task, DeepSeek chats claude_task, workers nothing", toolNames(fake()) === "deepseek_task" && toolNames(fake({ engine: "deepseek" })) === "claude_task"
      && toolNames(fake({ link: { parent: "p" } })) === "" && toolNames(fake({ engine: "deepseek", link: { parent: "p" } })) === "");
    const cfg = dg.toolsFor(fake())?.pocket;
    ok("the pocket server runs in-process and every call asks first", cfg?.type === "sdk" && cfg.name === "pocket" && JSON.stringify(cfg.tools) === JSON.stringify([{ name: "deepseek_task", permission_policy: "always_ask" }]));
    const def = dg.pocketTools(fake())[0];
    ok("deepseek_task: destructive (so Auto mode asks), with the documented inputs", def.annotations?.destructiveHint === true && def.annotations.readOnlyHint === false
      && ["task", "title", "cwd", "model", "continue_chat"].every(k => k in def.inputSchema));
    ds.setDsSettings({ toDeepseek: false }); const off1 = toolNames(fake());
    ds.setDsSettings({ toDeepseek: true, toClaude: false }); const off2 = toolNames(fake({ engine: "deepseek" }));
    ds.setDsSettings({ toClaude: true });
    ok("Settings turn each direction off", off1 === "" && off2 === "" && toolNames(fake()) === "deepseek_task");
  });

  await step("approval gate", async () => {
    const call = (s, args, extra, name = "deepseek_task") => dg.pocketTools(s).find(t => t.name === name).handler(args, extra);
    const meta = id => ({ _meta: { "claudecode/toolUseId": id } });
    let r = await call(fake(), { task: "Do it." });
    ok("no OK on the phone: the handler refuses", r.isError === true && /needs your OK/.test(resultText(r)), resultText(r));
    r = await call(fake({ engine: "deepseek" }), { task: "Do it." }, undefined, "claude_task");
    ok("…claude_task too", r.isError === true && /needs your OK/.test(resultText(r)));
    const s2 = fake(); s2.approvals.set(DS_TOOL, ["toolu_other"]);
    r = await call(s2, { task: "Do it." }, meta("toolu_this"));
    ok("an OK given for another call doesn't count", /needs your OK/.test(resultText(r)) && s2.approvals.get(DS_TOOL).length === 1);
    const s3 = fake(); s3.approvals.set(DS_TOOL, ["toolu_this"]);
    r = await call(s3, { task: "Do it.", cwd: path.join(T, "no-such-folder") }, meta("toolu_this"));
    ok("this call's OK is used up, then the folder is checked", /Folder not found/.test(resultText(r)) && s3.approvals.get(DS_TOOL).length === 0, resultText(r));
    r = await call(fake({ permissionMode: "bypassPermissions" }), { task: "Do it.", cwd: path.join(T, "no-such-folder") });
    ok("a chat in Bypass needs no OK (owner's rule)", /Folder not found/.test(resultText(r)));
    r = await call(fake({ permissionMode: "bypassPermissions" }), { task: "Again.", continue_chat: "cccccccc-0000-4000-8000-000000000003" });
    ok("continue_chat reaches only this chat's own workers", /isn't one of this chat's workers/.test(resultText(r)));
    const { live } = await import("../src/live-session.js");
    const fakes = [1, 2, 3].map(i => `busy-worker-${i}`);
    for (const id of fakes) live.set(id, { sessionId: id, link: { parent: "p" }, state: "running" });
    try { r = await call(fake({ permissionMode: "bypassPermissions" }), { task: "One more." }); } finally { for (const id of fakes) live.delete(id); }
    ok("at most three workers at once", /Three workers/.test(resultText(r)));
    const kept = dg.pocketTools(fake({ permissionMode: "bypassPermissions" }))[0];   // a chat keeps the tools it started with…
    ds.setDsSettings({ toDeepseek: false });
    try { r = await kept.handler({ task: "Do it.", cwd: path.join(T, "no-such-folder") }); } finally { ds.setDsSettings({ toDeepseek: true }); }
    ok("…but a direction turned off since then is off", /turned off/.test(resultText(r)), resultText(r));
    // Stopped before the worker got its task: it isn't sent, and the new worker chat closes (this opens one on the fake binary)
    const before = new Set(live.keys());
    r = await call(fake({ permissionMode: "bypassPermissions" }), { task: "Never sent." }, { signal: AbortSignal.abort(), ...meta("toolu_stopped") });
    const opened = [...live.values()].filter(s => !before.has(s.sessionId));
    await until(() => opened.every(s => !live.has(s.sessionId)), 5000, "the worker to close").catch(() => {});
    ok("stopped before the worker began: nothing sent, the worker closes", /Stopped before the worker began/.test(resultText(r)) && opened.every(s => !live.has(s.sessionId) && !s.buffer.some(e => e.ev.type === "pa_user")),
      resultText(r));
  });

  await step("report", async () => {
    const W = { sessionId: "0f7c0000-1111-4222-8333-444455556666", title: "Add the\nCONTRIBUTORS file", cwd: "/root/projects/demo", model: "deepseek-flash[1m]" };
    const before = new Map([[" M README.md", "10:1"], ["?? old.txt", "2:2"]]);
    const after = new Map([[" M README.md", "14:5"], ["?? old.txt", "2:2"], ["?? CONTRIBUTORS", "3:3"]]);
    const rep = dg.report({ who: "DeepSeek", worker: W, r: { type: "result", subtype: "success", result: "All done." }, before, after, ms: 192000, usd: 0.0312, parentStopped: false });
    const t = resultText(rep);
    ok("report: a stable header the app can read", t.startsWith(`DeepSeek worker: done\nChat: ${W.sessionId}\nTitle: Add the CONTRIBUTORS file\nFolder: /root/projects/demo\nModel: deepseek-flash · 3m 12s · about $0.031\n`)
      && /^Chat: ([0-9a-f-]{36})$/m.exec(t)?.[1] === W.sessionId && !rep.isError, JSON.stringify(t));
    ok("report: a file changed again shows up, an untouched one doesn't", t.endsWith("Changed: 2 files\n  M README.md\n  ?? CONTRIBUTORS\n---\nAll done."), JSON.stringify(t));
    const first = (r, o = {}) => dg.report({ who: "Claude", worker: { ...W, model: "opus" }, r, before: null, after: null, ms: 65000, usd: null, parentStopped: false, ...o });
    const status = (r, o) => resultText(first(r, o)).split("\n")[0];
    ok("report: stopped, failed (…) and done", status({ subtype: "error_during_execution" }) === "Claude worker: stopped" && status({ subtype: "success" }, { parentStopped: true }) === "Claude worker: stopped"
      && status({ subtype: "error_max_turns" }) === "Claude worker: failed (error_max_turns)" && status({ type: "result", subtype: "closed" }) === "Claude worker: failed (closed)"
      && status({ subtype: "success", is_error: true, result: "API Error: 402" }) === "Claude worker: failed (error)" && first({ subtype: "error_max_turns" }).isError === true);
    ok("report: Claude workers show no cost; a folder without git says so", resultText(first({ subtype: "success", result: "Hi" })).includes("\nModel: opus · 1m 05s\nChanged: (not a git repo)\n---\nHi"));
    const many = new Map(Array.from({ length: 35 }, (_, i) => [`?? f${i}.txt`, "1:1"]));
    const t3 = resultText(dg.report({ who: "DeepSeek", worker: W, r: { subtype: "success", result: "x".repeat(7000) }, before: new Map(), after: many, ms: 3000, usd: 0.0000004, parentStopped: false }));
    ok("report: at most 30 files, text cut at 6,000 characters, tiny costs", t3.includes("Changed: 35 files") && t3.includes("\n  ?? f29.txt\n  …and 5 more\n---")
      && t3.endsWith("\n…(cut; the full text is in the worker's chat)") && t3.split("\n---\n")[1].length < 6100 && t3.includes(" · 3s · under $0.001"));
    ok("report: nothing changed; no reply", resultText(dg.report({ who: "DeepSeek", worker: W, r: { subtype: "success", result: "" }, before: after, after, ms: 0, usd: 0, parentStopped: false })).endsWith("Changed: nothing\n---\n(no reply)"));
  });

  await step("git snapshots", async () => {
    const repo = path.join(T, "repo"), sub = path.join(repo, "sub");
    fs.mkdirSync(sub, { recursive: true }); write(path.join(repo, "a.txt"), "a\n"); write(path.join(sub, "keep.txt"), "k\n");
    git(repo, "init", "-q"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
    write(path.join(repo, "a.txt"), "one\n");                     // already changed before the worker starts
    const before = await dg.gitStatus(sub);
    write(path.join(repo, "a.txt"), "one and two\n"); write(path.join(sub, "new.txt"), "n\n");
    const after = await dg.gitStatus(sub);
    const t = resultText(dg.report({ who: "DeepSeek", worker: { sessionId: "x", cwd: sub }, r: { subtype: "success", result: "ok" }, before, after, ms: 0, usd: null, parentStopped: false }));
    ok("git: a file changed again and a new one are reported, also from a subfolder", t.includes("Changed: 2 files\n  M a.txt\n  ?? sub/new.txt"), JSON.stringify(t));
    const plain = path.join(T, "plain"); fs.mkdirSync(plain);
    ok("git: a folder that isn't a repo gives null", (await dg.gitStatus(plain)) === null);
  });

  await step("activity and brief", async () => {
    ok("activity: the parent shows who's working and on what", toolVerb(DS_TOOL) === "DeepSeek is working" && toolVerb(CLAUDE_TOOL) === "Claude is working"
      && toolDetail(DS_TOOL, { task: "\n  Build the parser\nthen test it" }) === "Build the parser" && toolDetail(CLAUDE_TOOL, { title: "Review", task: "x" }) === "Review");
    const b = dg.brief({ who: "DeepSeek", other: "Claude", parent: { title: "Plan\nthe app" }, cwd: "/w", task: "Do X.", approved: true });
    ok("brief: names the caller, the folder and the task", b.startsWith(`[Pocket Agent] You're a DeepSeek worker. The Claude chat "Plan the app" sent you this task, and the person approved it. Work in /w.`) && b.endsWith("\n\nDo X."));
  });
}

// ───── end to end: the real Claude Code, the fake DeepSeek, a test server on 8771 ─────
class Client {
  constructor(ws) {
    Object.assign(this, { ws, n: 0, waiting: new Map(), events: [], watchers: new Set() });
    this.open = new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
    ws.on("message", raw => {
      const m = JSON.parse(raw);
      if (m.t === "reply") { const w = this.waiting.get(m.id); this.waiting.delete(m.id); return w?.(m); }
      this.events.push(m);
      for (const w of [...this.watchers]) w(m);
    });
  }
  call(t, args = {}) {
    return new Promise((res, rej) => {
      const id = ++this.n;
      this.waiting.set(id, r => r.error ? rej(Object.assign(new Error(`${t}: ${r.error}`), { code: r.code })) : res(r));
      this.ws.send(JSON.stringify({ ...args, t, id }));
    });
  }
  mark() { return this.events.length; }
  /** The first event from index `from` on that matches, waiting up to `ms` for it. */
  wait(pred, { from = 0, ms = 150e3, what = "an event" } = {}) {
    const hit = this.events.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const w = m => { if (pred(m)) { clearTimeout(timer); this.watchers.delete(w); res(m); } };
      const timer = setTimeout(() => { this.watchers.delete(w); rej(new Error(`timed out waiting for ${what}`)); }, ms);
      this.watchers.add(w);
    });
  }
}

let serverOut = "";
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode) return;
  const gone = new Promise(r => server.once("exit", r));
  server.kill("SIGTERM");                                  // shutdown() closes every chat, so no Claude Code is left behind
  await Promise.race([gone, sleep(10000)]);
  if (server.exitCode === null && !server.signalCode) server.kill("SIGKILL");
}

async function e2eTests() {
  const EHOME = path.join(T, "home"), EDATA = path.join(EHOME, ".pocket-agent");
  fs.mkdirSync(EDATA, { recursive: true });
  write(path.join(EHOME, ".claude/CLAUDE.md"), "# Personal notes\nCLAUDE-MD-MARKER-5150\n");   // personal setup DeepSeek chats share (owner's choice)
  const refuse = `http://127.0.0.1:${MOCK_PORT}`;
  const env = { ...CLEAN, HOME: EHOME, PA_DATA: EDATA, PA_PORT: String(SERVER_PORT), PA_CLAUDE: CLAUDE_BIN,
    PA_DEEPSEEK_URL: mock.url, PA_TEST_ANTHROPIC_URL: mock.url, PA_TEST_ANTHROPIC_KEY: CLAUDE_KEY,
    // anything aimed at another host (api.anthropic.com…) goes to the fake, which refuses it and writes it down
    HTTPS_PROXY: refuse, HTTP_PROXY: refuse, https_proxy: refuse, http_proxy: refuse, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
  server = spawn(process.execPath, [path.join(REPO, "server/src/index.js"), "--port", String(SERVER_PORT)], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", d => serverOut += d); server.stderr.on("data", d => serverOut += d);
  await until(() => serverOut.includes(`:${SERVER_PORT}`), 20000, "the test server").catch(() => {});
  const health = await fetch(`http://127.0.0.1:${SERVER_PORT}/health`).then(r => r.ok, () => false);
  if (!ok("e2e: the test server starts", health, serverOut.slice(-500))) return;
  const { default: WebSocket } = await import(path.join(REPO, "server/node_modules/ws/index.js"));
  const cl = new Client(new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws?token=${fs.readFileSync(path.join(EDATA, "token"), "utf8").trim()}`));
  await cl.open;
  console.log(`e2e: Claude Code ${CLAUDE_BIN}`);

  // in Bypass nothing should ask; if something does, allow it (and remember) so the test can't hang on it
  let autoAllow = false;
  const unexpected = [];
  cl.watchers.add(m => { if (autoAllow && m.t === "permission.request") { unexpected.push(m); allow(m).catch(() => {}); } });
  const opened = new Set();
  const evs = (sid, from) => cl.events.slice(from).filter(m => m.t === "ev" && m.sessionId === sid).map(m => m.ev);
  const toolResults = (sid, from) => evs(sid, from).filter(e => e.type === "user" && Array.isArray(e.message?.content))
    .flatMap(e => e.message.content).filter(b => b.type === "tool_result").map(b => ({ id: b.tool_use_id, text: textOf(b.content), isError: !!b.is_error }));
  const reportIn = (sid, from) => toolResults(sid, from).find(r => /^(DeepSeek|Claude) worker: /.test(r.text))?.text || "";
  const turnEnd = (sid, from, ms = 240e3) => cl.wait(m => m.t === "ev" && m.sessionId === sid && m.ev.type === "result", { from, ms, what: `the end of ${sid.slice(0, 8)}'s turn` }).then(m => m.ev);
  const asked = (sid, from) => cl.wait(m => m.t === "permission.request" && m.sessionId === sid, { from, what: `an approval in ${sid.slice(0, 8)}` });
  const linked = (parent, from) => cl.wait(m => m.t === "link" && m.parent === parent, { from, what: "the worker's link event" });
  function allow(p) { return cl.call("permission.reply", { sessionId: p.sessionId, requestId: p.requestId, behavior: "allow" }); }
  async function send(args) { const r = await cl.call("send", args); opened.add(r.sessionId); return r.sessionId; }
  async function close(sid) {
    const sub = await cl.call("subscribe", { sessionId: sid }).catch(() => null);
    if (!sub?.info || sub.info.state === "closed") return;
    const from = cl.mark();
    await cl.call("session.close", { sessionId: sid }).catch(() => {});
    await cl.wait(m => m.t === "state" && m.sessionId === sid && m.state === "closed", { from, ms: 20e3, what: "the chat to close" }).catch(() => {});
  }
  async function closeAll() { for (const id of [...opened]) { await close(id); opened.delete(id); } }
  const e2e = async (name, fn) => { try { await step(name, fn); } finally { autoAllow = false; await closeAll(); } };
  const P = `http://127.0.0.1:${SERVER_PORT}/deepseek`;
  const viaProxy = (tok, p = "/v1/messages") => fetch(P + p, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-flash", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
  const repo = path.join(EHOME, "projects/demo");
  write(path.join(repo, "README.md"), "# Demo\n"); git(repo, "init", "-q"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
  const delegate = (tool, task, title) => `Hand this over. [[tool ${tool} ${JSON.stringify({ task, title })}]]`;
  const bash = (command, description = "Run it") => `[[tool Bash ${JSON.stringify({ command, description })}]]`;

  await e2e("hello and the key", async () => {
    const h0 = await cl.call("hello", { tzOffset: -330 });
    ok("e2e hello: both engines; DeepSeek not ready without a key", h0.engines?.map(e => e.id).join() === "claude,deepseek" && h0.deepseek?.ready === false);
    let bad = null; try { await cl.call("deepseek.setKey", { key: "sk-wrong-key-12345" }); } catch (e) { bad = e; }
    ok("e2e deepseek.setKey: a key DeepSeek refuses → BAD_KEY", bad?.code === "BAD_KEY", bad?.message);
    const r = await cl.call("deepseek.setKey", { key: KEY });
    ok("e2e deepseek.setKey: ready, and only the last 4 characters come back", r.deepseek?.ready === true && r.deepseek.keyHint === KEY.slice(-4) && !JSON.stringify(r).includes(KEY));
    const h = await cl.call("hello", { tzOffset: -330 });
    ok("e2e hello: DeepSeek ready, and the key appears nowhere", h.engines?.find(e => e.id === "deepseek")?.ready === true && h.deepseek?.ready === true && !JSON.stringify(h).includes(KEY));
  });

  let dsChat = null, pass = null;
  await e2e("a DeepSeek chat", async () => {
    const cwd = path.join(EHOME, "projects/plain"); fs.mkdirSync(cwd, { recursive: true });
    // the key is built in the shell, so the command itself never contains it
    const cmd = 'k=sk-test-deep; env | grep -c "${k}seek"; printf "%s\\n" "$ANTHROPIC_AUTH_TOKEN"';
    const from = cl.mark(), n0 = mock.requests.length;
    dsChat = await send({ cwd, text: `Check the environment. ${bash(cmd, "Check the environment")}`, engine: "deepseek", permissionMode: "bypassPermissions" });
    opened.delete(dsChat);   // the next steps keep using it
    const end = await turnEnd(dsChat, from);
    const out = toolResults(dsChat, from)[0]?.text || "";
    const [count, tok] = out.trim().split(/\s+/);
    pass = tok;
    ok("e2e DeepSeek chat: the key isn't in its environment, only its own pass", count === "0" && /^pa-ds-[0-9a-f]{32}$/.test(tok || ""), out.slice(0, 100));
    const reqs = mock.requests.slice(n0).filter(r => r.model);
    ok("e2e DeepSeek chat: DeepSeek got the real key and model deepseek-flash", reqs.length > 0 && reqs.every(r => r.auth === `Bearer ${KEY}` && r.model === "deepseek-flash"),
      reqs.map(r => `${r.model} ${r.auth}`).join(" | "));
    ok("e2e DeepSeek chat: the turn ends normally", end.subtype === "success" && /MOCK DONE/.test(end.result || ""), end.result);
    const item = (await cl.call("sessions.list", {})).sessions.find(s => s.sessionId === dsChat);
    ok("e2e sessions.list: a DeepSeek chat, with its spend", item?.engine === "deepseek" && item.spend > 0, JSON.stringify(item && { engine: item.engine, spend: item.spend }));
    const st = await cl.call("deepseek.status", {});
    ok("e2e deepseek.status: today's spend counts it", st.deepseek?.spend?.today > 0, JSON.stringify(st.deepseek?.spend));
    ok("e2e key keeper: a wrong pass gets 401", (await viaProxy("pa-ds-" + "0".repeat(32))).status === 401);
    ok("e2e key keeper: a live chat's pass can't read the balance or other paths (404)",
      (await fetch(`${P}/user/balance`, { headers: { authorization: `Bearer ${pass}` } })).status === 404 && (await viaProxy(pass, "/v1/models")).status === 404);
  });

  await e2e("a chat keeps its engine", async () => {
    if (!dsChat) throw new Error("no DeepSeek chat from the step before");
    opened.add(dsChat);
    await close(dsChat);
    ok("e2e key keeper: a closed chat's pass gets 401", !!pass && (await viaProxy(pass)).status === 401);
    let e = null; try { await cl.call("send", { sessionId: dsChat, text: "Switch?", engine: "claude" }); } catch (x) { e = x; }
    ok("e2e: asking a DeepSeek chat for Claude fails with ENGINE_FIXED", e?.code === "ENGINE_FIXED", e?.message);
    const from = cl.mark(), n0 = mock.requests.length;
    await send({ sessionId: dsChat, text: "Back again." });
    await turnEnd(dsChat, from);
    const again = mock.requests.slice(n0).filter(r => r.model);
    ok("e2e: reopened, it runs on DeepSeek again", again.length > 0 && again.every(r => r.model === "deepseek-flash" && r.auth === `Bearer ${KEY}`));
    const fork = await cl.call("session.fork", { sessionId: dsChat });
    const list = (await cl.call("sessions.list", {})).sessions;
    ok("e2e: a fork of a DeepSeek chat is a DeepSeek chat", list.find(s => s.sessionId === fork.sessionId)?.engine === "deepseek");
  });

  await e2e("personal setup and the tripwire", async () => {
    const cwd = path.join(EHOME, "projects/notes"); fs.mkdirSync(cwd, { recursive: true });
    const mem = path.join(EHOME, ".claude/projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
    write(path.join(mem, "MEMORY.md"), "- [Marker](marker.md) - MEMORY-MARKER-4242\n"); write(path.join(mem, "marker.md"), "MEMORY-MARKER-4242\n");
    const canary = "sk-ant-oat01-CANARY-" + "q".repeat(24), cred = path.join(EHOME, ".claude/.credentials.json");
    write(cred, JSON.stringify({ claudeAiOauth: { accessToken: canary, refreshToken: canary + "-r", expiresAt: Date.now() + 86400e3, scopes: ["user:inference"] } }));
    const secret = path.join(EDATA, "secrets/deepseek");
    const from = cl.mark(), n0 = mock.requests.length;
    try {
      const sid = await send({ cwd, text: `Look. [[tool Read ${JSON.stringify({ file_path: secret })}]] ${bash(`cat ${secret}`, "Show the file")}`, engine: "deepseek", permissionMode: "bypassPermissions" });
      await turnEnd(sid, from);
      const rs = toolResults(sid, from);
      ok("e2e tripwire: Read and Bash on the key file are stopped, even in Bypass", rs.length === 2 && rs.every(r => /keeps this file away/.test(r.text) && !r.text.includes(KEY)), rs.map(r => r.text.slice(0, 80)).join(" | "));
      const reqs = mock.requests.slice(n0).filter(r => r.model);
      ok("e2e: DeepSeek chats get your memory and CLAUDE.md (owner's choice)", reqs.some(r => r.bodyText.includes("MEMORY-MARKER-4242")) && reqs.some(r => r.bodyText.includes("CLAUDE-MD-MARKER-5150")));
      ok("e2e: …but never a Claude login, and never the DeepSeek key", reqs.length > 0 && reqs.every(r => !r.bodyText.includes(canary) && !String(r.auth).includes(canary) && !r.bodyText.includes(KEY)));
    } finally { fs.rmSync(cred, { force: true }); }   // test-mode Claude chats below must not see a login
  });

  await e2e("Claude → DeepSeek, asking first", async () => {
    const task = `Write the check file. ${bash("echo worker-ok | tee worker.txt", "Write the check file")}`;
    const from = cl.mark(), n0 = mock.requests.length;
    const parent = await send({ cwd: repo, text: delegate(DS_TOOL, task, "Worker check"), engine: "claude", permissionMode: "default" });
    const p1 = await asked(parent, from);
    ok("e2e Claude → DeepSeek: the call asks on the phone first, with its tool-use id", p1.toolName === DS_TOOL && /^toolu_/.test(p1.toolUseID || ""), `${p1.toolName} ${p1.toolUseID}`);
    ok("e2e Claude → DeepSeek: nothing starts before the OK", !cl.events.slice(from).some(m => m.t === "link"));
    await allow(p1);
    const link = await linked(parent, from);
    opened.add(link.child);
    ok("e2e Claude → DeepSeek: a linked DeepSeek worker chat starts", link.engine === "deepseek" && link.title === "Worker check" && link.toolUseId === p1.toolUseID, JSON.stringify(link));
    const p2 = await asked(link.child, from);
    ok("e2e Claude → DeepSeek: the worker runs in the caller's mode (Ask), so its command asks", p2.toolName === "Bash", p2.toolName);
    await allow(p2);
    await turnEnd(parent, from);
    const rep = reportIn(parent, from);
    ok("e2e Claude → DeepSeek: the report: done, the worker's chat, its output, the new file", rep.startsWith("DeepSeek worker: done\n") && rep.includes(`\nChat: ${link.child}\n`)
      && rep.includes("worker-ok") && /\nModel: deepseek-flash · (\d+m )?\d+s · (about|under) \$/.test(rep) && rep.includes("Changed: 1 file\n  ?? worker.txt"), rep.slice(0, 400));
    const reqs = mock.requests.slice(n0).filter(r => r.model);
    const parentReqs = reqs.filter(r => /^claude/.test(r.model)), workerReqs = reqs.filter(r => r.bodyText.includes("You're a DeepSeek worker"));
    ok("e2e Claude → DeepSeek: the Claude chat had deepseek_task; the worker had no pocket tools", parentReqs.some(r => r.tools.includes(DS_TOOL)) && workerReqs.length > 0
      && workerReqs.every(r => !r.tools.some(t => t.startsWith("mcp__pocket__"))));
    ok("e2e Claude → DeepSeek: the worker used DeepSeek with the key; the Claude chat never had it", workerReqs.every(r => r.model === "deepseek-flash" && r.auth === `Bearer ${KEY}`)
      && parentReqs.every(r => r.auth === `Bearer ${CLAUDE_KEY}`));
    const item = (await cl.call("sessions.list", {})).sessions.find(s => s.sessionId === link.child);
    ok("e2e Claude → DeepSeek: the chat list links the worker to its caller", item?.engine === "deepseek" && item.parent === parent, JSON.stringify(item && { engine: item.engine, parent: item.parent }));
  });

  await e2e("Claude → DeepSeek in Bypass", async () => {
    autoAllow = true; unexpected.length = 0;
    // worker.txt is already changed (untracked) from the step before; it must still show up when changed again
    const task = `Add a line. ${bash("echo again >> worker.txt && echo worker-ok", "Add a line")}`;
    const from = cl.mark();
    const parent = await send({ cwd: repo, text: delegate(DS_TOOL, task, "Bypass worker"), engine: "claude", permissionMode: "bypassPermissions" });
    const link = await linked(parent, from);
    opened.add(link.child);
    await turnEnd(parent, from);
    ok("e2e Bypass: the call doesn't ask (owner's rule), and the worker doesn't either", unexpected.length === 0, unexpected.map(p => `${p.toolName} in ${p.sessionId === parent ? "caller" : "worker"}`).join(", "));
    const mode = cl.events.slice(from).filter(m => m.t === "state" && m.sessionId === link.child).at(-1)?.info?.permissionMode;
    ok("e2e Bypass: the worker inherits Bypass", mode === "bypassPermissions", mode);
    const rep = reportIn(parent, from);
    ok("e2e Bypass: the report is back, and a file changed again shows up", rep.startsWith("DeepSeek worker: done\n") && rep.includes("worker-ok") && rep.includes("Changed: 1 file\n  ?? worker.txt"), rep.slice(0, 300));
  });

  await e2e("deny", async () => {
    const from = cl.mark();
    const parent = await send({ cwd: repo, text: delegate(DS_TOOL, "This never runs.", "Denied"), engine: "claude", permissionMode: "default" });
    const p = await asked(parent, from);
    await cl.call("permission.reply", { sessionId: parent, requestId: p.requestId, behavior: "deny" });
    await turnEnd(parent, from);
    const r = toolResults(parent, from)[0];
    ok("e2e deny: no worker starts, and Claude hears it was rejected", !cl.events.slice(from).some(m => m.t === "link") && /reject|denied|doesn't want/i.test(r?.text || ""), r?.text?.slice(0, 160));
    ok("e2e deny: no new chat", !(await cl.call("sessions.list", {})).sessions.some(s => s.parent === parent));
  });

  const slowTask = marker => `[[slow 400]] ${marker} ` + "This reply streams slowly, a few words at a time. ".repeat(12);
  const startSlow = async title => {
    autoAllow = true;
    const marker = "SLOW-WORKER-" + Date.now(), from = cl.mark(), n0 = mock.requests.length;
    const parent = await send({ cwd: repo, text: delegate(DS_TOOL, slowTask(marker), title), engine: "claude", permissionMode: "bypassPermissions" });
    const { child } = await linked(parent, from);
    opened.add(child);
    await until(() => mock.requests.slice(n0).some(r => r.bodyText.includes(marker) && r.model === "deepseek-flash" && r.reply), 150e3, "the worker's reply to start");
    await sleep(1500);
    return { parent, child, from, marker, n0 };
  };

  await e2e("Stop in the calling chat", async () => {
    const { parent, child, marker, n0 } = await startSlow("Slow worker");
    const t0 = Date.now(), mark = cl.mark();
    await cl.call("interrupt", { sessionId: parent });
    const st = await cl.wait(m => m.t === "state" && m.sessionId === child && (m.state === "idle" || m.state === "closed"), { from: mark, ms: 15e3, what: "the worker to stop" }).catch(() => null);
    ok("e2e Stop: stopping the calling chat stops its worker within 10 s", !!st && Date.now() - t0 < 10e3, `${Date.now() - t0} ms`);
    await until(() => mock.requests.slice(n0).some(r => r.bodyText.includes(marker) && r.closedEarly), 5000, "the cut").catch(() => {});
    ok("e2e Stop: …and the worker's request to DeepSeek is cut off", mock.requests.slice(n0).some(r => r.bodyText.includes(marker) && r.closedEarly));
  });

  await e2e("Stop in the worker", async () => {
    const { parent, child, from } = await startSlow("Worker to stop");
    await cl.call("interrupt", { sessionId: child });
    const end = await turnEnd(parent, from);
    const rep = reportIn(parent, from);
    ok("e2e Stop in the worker: the caller gets a 'stopped' report", rep.startsWith("DeepSeek worker: stopped\n") && rep.includes(`Chat: ${child}`), rep.slice(0, 200));
    ok("e2e Stop in the worker: …and carries on", end.subtype === "success" && /MOCK DONE. Last tool result: DeepSeek worker: stopped/.test(end.result || ""), end.result?.slice(0, 120));
  });

  await e2e("DeepSeek → Claude", async () => {
    const from = cl.mark(), n0 = mock.requests.length;
    const parent = await send({ cwd: repo, text: delegate(CLAUDE_TOOL, "Review the plan and say hi.", "Plan review"), engine: "deepseek", permissionMode: "default" });
    const p = await asked(parent, from);
    ok("e2e DeepSeek → Claude: asks first", p.toolName === CLAUDE_TOOL, p.toolName);
    await allow(p);
    const link = await linked(parent, from);
    opened.add(link.child);
    await turnEnd(parent, from);
    const rep = reportIn(parent, from);
    ok("e2e DeepSeek → Claude: Claude's answer comes back", link.engine === "claude" && rep.startsWith("Claude worker: done\n") && rep.includes(`Chat: ${link.child}`) && rep.includes("MOCK: "), rep.slice(0, 300));
    const reqs = mock.requests.slice(n0).filter(r => r.model);
    const claudeReqs = reqs.filter(r => /^claude/.test(r.model)), dsReqs = reqs.filter(r => /^deepseek/.test(r.model));
    ok("e2e DeepSeek → Claude: the worker ran on Claude (test mode: the fake, the test token), with no pocket tools",
      claudeReqs.length > 0 && claudeReqs.every(r => r.auth === `Bearer ${CLAUDE_KEY}` && !r.tools.some(t => t.startsWith("mcp__pocket__"))), claudeReqs.map(r => `${r.model} ${r.auth}`).join(" | "));
    ok("e2e DeepSeek → Claude: the DeepSeek chat had claude_task", dsReqs.some(r => r.tools.includes(CLAUDE_TOOL)));
  });

  await e2e("limit and credit", async () => {
    await cl.call("deepseek.settings", { settings: { dailyCapUsd: 0.000001 } });
    const from = cl.mark(), n0 = mock.requests.length;
    const sid = await send({ cwd: repo, text: "Hello under the limit.", engine: "deepseek", permissionMode: "bypassPermissions" });
    await turnEnd(sid, from);
    ok("e2e daily limit: the chat says so, and nothing reaches DeepSeek", JSON.stringify(evs(sid, from)).includes("today's DeepSeek limit") && !mock.requests.slice(n0).some(r => r.bodyText.includes("Hello under the limit")));
    const st0 = await cl.call("deepseek.settings", { settings: { dailyCapUsd: 0 } });
    ok("e2e daily limit: back to no limit", st0.deepseek?.settings?.dailyCapUsd === 0);
    const f2 = cl.mark();
    await cl.call("send", { sessionId: sid, text: "[[error 402]] Buy more." });
    await turnEnd(sid, f2);
    const st = await cl.call("deepseek.status", {});
    ok("e2e out of credit: DeepSeek's 402 shows in the chat and marks the balance used up", /Insufficient Balance/.test(JSON.stringify(evs(sid, f2))) && st.deepseek?.balance?.available === false, JSON.stringify(st.deepseek?.balance));
    mock.setBalance();
  });

  await e2e("hygiene", async () => {
    ok("e2e: the server never printed the key", !serverOut.includes(KEY));
    ok("e2e: DeepSeek never saw a chat's pass, and no request held the key", !mock.requests.some(r => /pa-ds-/.test(String(r.auth)) || r.bodyText.includes(KEY)));
    ok("e2e: nothing tried to reach another host", mock.egress.length === 0, mock.egress.join(", "));
  });
  cl.ws.close();
}

// ───── the run ─────
try {
  mock = await startMock({ port: MOCK_PORT, key: KEY, alsoAccept: [CLAUDE_KEY] });
  await unitTests();
  if (UNIT_ONLY) console.log("SKIP e2e: --unit");
  else if (!CLAUDE_BIN) console.log("SKIP e2e: no Claude Code binary");
  else await e2eTests();
} catch (e) { ok("the test ran to the end", false, e?.stack || e); }
finally {
  await stopServer();
  if (fails && serverOut) console.log("\n── the test server's log (end) ──\n" + serverOut.slice(-6000).replaceAll(KEY, "<key>"));
  await mock?.close();
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
