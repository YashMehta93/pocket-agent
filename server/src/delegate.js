// Pocket Agent's own MCP tools, put in every top-level chat: hand a task to the other engine as a linked worker chat.
// Claude chats get deepseek_task, DeepSeek chats get claude_task (docs: SPEC §4.9 and §6 in the DeepSeek notes).
// Each call asks on the phone first, unless the chat runs in Bypass (the owner's rule) or the person chose "always" for
// it in that chat. The worker is a normal chat the person can open, approve and stop; it runs in the calling chat's
// permission mode, and its report (status, time, cost, changed files, its last message) goes back as the tool's result.
// Workers get no tools of their own (depth 1), so they can't start chains of workers.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { VERSION, HOME, log } from "./config.js";
import { broadcastAll } from "./hub.js";
import { openSession, live, setToolProvider } from "./live-session.js";
import { engineOf, linkOf, updateLink } from "./engines.js";
import { ready as dsReady, chatSpend, dsSettings, dsModel } from "./deepseek.js";
import { createQueue } from "./workqueue.js";

export const DS_TOOL = "mcp__pocket__deepseek_task", CLAUDE_TOOL = "mcp__pocket__claude_task";
const MAX_RUNNING = 3, REPORT_MAX = 6000, CHANGED_MAX = 30;
const NAME = { deepseek: "DeepSeek", claude: "Claude" };
const queue = createQueue(MAX_RUNNING);
const jobs = new Map();   // id -> a wait:false run, collected later by worker_results

const DS_DESC = "Hand a self-contained piece of work to a DeepSeek worker: a separate chat that runs Claude Code on DeepSeek (cheaper), in this chat's folder unless you name another. Use it when the person asks for DeepSeek or agrees to it. The worker can't see this chat, so write the task to stand alone: the goal, the files, exact steps, and how to check the result. The person approves each call on their phone and can watch or stop the worker. Returns the worker's report, the files it changed and its chat id. To send that worker a follow-up, pass the id as continue_chat.";
const CLAUDE_DESC = "Ask Claude (Opus by default) to plan, review or solve something hard, in a separate chat that uses the person's Claude plan. Use it when the person asks or agrees. Claude can't see this chat, so include everything it needs. The person approves each call on their phone and can watch or stop it. Returns Claude's answer, the files it changed and its chat id; pass the id as continue_chat for a follow-up.";
const CLAUDE_SIDE = "Pocket Agent tools. deepseek_task runs work on DeepSeek in a separate chat the person can watch. When asked to plan with Claude and build with DeepSeek: write a short plan of steps, send one step per call with exact files and a command that checks it, read each report (and the changed files) before the next step, and re-send or fix a step whose check fails. Don't use it unless the person asked for DeepSeek or agreed. For several independent tasks, send each with wait:false (up to 3 run at once; the rest queue and start as slots free, so never drop a task to fit the limit), then call worker_results to wait for all the reports. Check every report before you rely on it.";
const DEEPSEEK_SIDE = "Pocket Agent tools. claude_task asks Claude (Opus) in a separate chat: good for a plan before big work, a review of finished work, or a problem you're stuck on. Use it when the person asks or agrees; Claude can't see this chat, so include what it needs. For several independent tasks, send each with wait:false (up to 3 run at once; the rest queue and start as slots free, so never drop a task to fit the limit), then call worker_results to wait for all the reports. Check every report before you rely on it.";
const WORKER_RESULTS_DESC = "Collect the reports of workers you started with wait:false. By default waits until all of this chat's uncollected workers finish and returns every report. Pass jobs to pick some; wait:false returns at once with what has finished.";
const READ_ANNOTATIONS = { title: "Collect worker reports", readOnlyHint: true, destructiveHint: false, openWorldHint: false };

const common = {
  task: z.string().min(1).max(40000).describe("Complete instructions for the worker."),
  title: z.string().max(80).optional().describe("A short name for the worker's chat."),
  cwd: z.string().optional().describe("Absolute folder to work in. Default: this chat's folder."),
  wait: z.boolean().optional().describe("false: start it and return at once with a job id; up to 3 run at once and the rest queue. Collect reports with worker_results. Default true: wait for this worker's report."),
};
const followUp = what => z.string().regex(/^[0-9a-f-]{36}$/).optional().describe(`Chat id from an earlier ${what} result, to send that worker a follow-up.`);
// destructiveHint: Auto mode asks too (its classifier can't wave a delegation through)
const annotations = title => ({ title, readOnlyHint: false, destructiveHint: true, openWorldHint: true });

/** The tool definitions for one chat: none for workers, deepseek_task for Claude chats (with a key), claude_task for DeepSeek chats. */
export function pocketTools(s) {
  if (s.link) return [];   // workers don't delegate (depth 1)
  const set = dsSettings(), out = [];
  if (s.engine === "deepseek") {
    if (set.toClaude !== false) out.push(tool("claude_task", CLAUDE_DESC, { ...common,
      model: z.enum(["opus", "sonnet", "haiku"]).optional().describe("opus (default), sonnet or haiku. Claude Code picks your plan's current model for the name."),
      continue_chat: followUp("claude_task") }, (args, extra) => run(s, "claude", args, extra), { annotations: annotations("Ask Claude") }));
  } else if (dsReady() && set.toDeepseek !== false) {
    out.push(tool("deepseek_task", DS_DESC, { ...common,
      model: z.enum(["flash", "pro"]).optional().describe("flash (default): fast and cheap, sees images. pro: stronger, about 3-4x the price."),
      continue_chat: followUp("deepseek_task") }, (args, extra) => run(s, "deepseek", args, extra), { annotations: annotations("Send work to DeepSeek") }));
  }
  if (out.length) out.push(workerResults(s));   // only chats that can start workers collect their reports
  return out;
}

/** worker_results: one definition, bound to the chat whose jobs it reads. */
function workerResults(s) {
  return tool("worker_results", WORKER_RESULTS_DESC, {
    jobs: z.array(z.string()).optional().describe("Job ids from the wait:false replies. Default: all of this chat's uncollected jobs."),
    wait: z.boolean().optional().describe("true (default): wait for them to finish. false: return what has finished now."),
  }, async (args, extra) => {
    const sel = [...jobs.values()].filter(j => j.parent === s.sessionId && !j.collected && (!args.jobs || args.jobs.includes(j.id)));
    if (!sel.length) return { content: [{ type: "text", text: "No workers to collect." }] };
    if (args.wait !== false) await Promise.race([Promise.all(sel.map(j => j.promise.catch(() => {}))),
      new Promise(r => { if (extra?.signal?.aborted) r(); extra?.signal?.addEventListener("abort", r, { once: true }); })]);
    const parts = [];
    let done = 0;
    for (const j of sel) {
      if (j.state === "done") { parts.push(j.report); j.collected = true; done++; }
      else parts.push(NAME[j.engine] + " worker: " + j.state + "\nJob: " + j.id + "\nTitle: " + j.title);
    }
    const first = "Workers: " + done + " done, " + (sel.length - done) + " not finished";
    return { content: [{ type: "text", text: [first, ...parts].join("\n\n=====\n\n") }] };
  }, { annotations: READ_ANNOTATIONS });
}

/** mcpServers for a new chat (LiveSession asks through setToolProvider), or undefined when it gets none. */
export function toolsFor(s) {
  try {
    const tools = pocketTools(s);
    if (!tools.length) return undefined;
    const server = createSdkMcpServer({ name: "pocket", version: VERSION, alwaysLoad: true, timeout: 6 * 3600e3,
      instructions: s.engine === "deepseek" ? DEEPSEEK_SIDE : CLAUDE_SIDE, tools });
    // always_ask: Claude Code asks our canUseTool before every call, even where an allow rule or Auto mode would let it
    // through. live-session.js allows it at once in Bypass or after "always" in this chat; otherwise the phone is asked.
    // worker_results never asks: reading reports starts nothing. The rest always ask.
    return { pocket: { ...server, tools: tools.filter(t => t.name !== "worker_results").map(t => ({ name: t.name, permission_policy: "always_ask" })) } };
  } catch (e) {
    log("pocket tools failed", e?.message);   // the chat still opens, just without them
    return undefined;
  }
}
setToolProvider(toolsFor);

const fail = text => ({ content: [{ type: "text", text }], isError: true });
const busy = s => s.state === "starting" || s.state === "running" || s.state === "waiting";

/** The phone's OK for this exact call (by its tool-use id when Claude Code sends it), used up once. */
function takeApprovalFor(parent, toolName, callId) {
  const queue = parent.approvals?.get?.(toolName);
  if (callId && Array.isArray(queue)) {
    const i = queue.indexOf(callId);
    if (i < 0) return null;
    queue.splice(i, 1);
    return callId;
  }
  return parent.takeApproval?.(toolName) || null;
}

/** Workers run in the calling chat's mode (the owner's rule), unless Settings names one. DeepSeek chats have no Auto mode. */
function workerMode(parent, engine) {
  const mode = dsSettings().workerMode || parent.permissionMode || "default";
  return engine === "deepseek" && mode === "auto" ? "acceptEdits" : mode;
}

async function run(parent, engine, args, extra) {
  const toolName = engine === "deepseek" ? DS_TOOL : CLAUDE_TOOL;
  // A chat keeps the tools it started with; a direction turned off since then is still off.
  if (engine === "deepseek" ? dsSettings().toDeepseek === false : dsSettings().toClaude === false)
    return fail(engine === "deepseek" ? "Sending work to DeepSeek is turned off (Settings → DeepSeek)." : "Asking Claude is turned off (Settings → DeepSeek).");
  const meta = extra?._meta?.["claudecode/toolUseId"], callId = typeof meta === "string" ? meta : null;
  const approved = takeApprovalFor(parent, toolName, callId);
  // Defence in depth: Claude Code only runs this after canUseTool allowed it. Without a recorded OK, only a chat in Bypass may go on.
  if (!approved && parent.permissionMode !== "bypassPermissions") return fail("This needs your OK on the phone, and there wasn't one.");
  if (args.wait === false && args.continue_chat) return fail("continue_chat can't be used with wait:false.");
  if (args.wait === false) return startJob(parent, engine, args, callId, approved);
  // A normal call waits its turn in the queue; extra's stop signal still ends the worker.
  return queue.run(() => runWorker(parent, engine, args, extra, callId, approved, () => {}), parent.sessionId);
}

/** Start a wait:false worker now: it queues like any other run, and its report waits in `jobs` for worker_results. */
async function startJob(parent, engine, args, callId, approved) {
  const job = { id: randomBytes(4).toString("hex"), parent: parent.sessionId, engine, title: oneLine(args.title) || firstLine(args.task),
    state: "queued", chat: null, report: null, collected: false };
  jobs.set(job.id, job);
  job.promise = queue.run(() => { job.state = "running"; return runWorker(parent, engine, args, null, callId, approved, id => { job.chat = id; }); }, parent.sessionId)
    .then(r => { job.report = r.content[0].text; }, e => { job.report = NAME[engine] + " worker: stopped\nJob: " + job.id + "\n---\n" + (e?.message || e); })
    .finally(() => { job.state = "done"; });
  await Promise.resolve();   // lets a free slot start it at once
  return { content: [{ type: "text", text: [NAME[engine] + " worker: " + (job.state === "running" ? "started" : "queued"), "Job: " + job.id,
    "Title: " + job.title, "Queue: " + queue.running + " running, " + queue.waiting + " waiting", "---", "Collect its report with worker_results."].join("\n") }] };
}

/** The person stopped a chat: drop the workers it had waiting for a slot and interrupt the ones it started. */
export function stopJobsOf(parentId) {
  let n = queue.cancel(tag => tag === parentId);
  for (const job of jobs.values()) {
    if (job.parent !== parentId || job.state !== "running" || !job.chat) continue;
    const w = live.get(job.chat);
    const hit = () => { try { w?.q?.interrupt()?.catch?.(() => {}); } catch {} };
    hit();
    // Interrupts that arrive before the worker's turn has begun are lost, so repeat while it's still busy, as runWorker does.
    if (w) {
      let k = 0;
      const timer = setInterval(() => { if (++k > 20 || !busy(w)) clearInterval(timer); else hit(); }, 1500);
      timer.unref?.();
    }
    n++;
  }
  return n;
}

/** One worker run: open or reopen its chat, send the task, wait for its turn and report. onChat gets the worker's chat id. */
async function runWorker(parent, engine, args, extra, callId, approved, onChat) {
  const toolName = engine === "deepseek" ? DS_TOOL : CLAUDE_TOOL, who = NAME[engine];
  const mode = workerMode(parent, engine);
  let worker;
  try {
    if (args.continue_chat) {
      const id = args.continue_chat, link = linkOf(id);
      if (!link || link.parent !== parent.sessionId || (engineOf(id) || "claude") !== engine) return fail("That chat isn't one of this chat's workers.");
      worker = await openSession({ sessionId: id, permissionMode: mode });
      if (worker.state === "running" || worker.state === "waiting") return fail("That worker is still busy.");
      if (worker.permissionMode !== mode) await worker.set({ permissionMode: mode });   // the calling chat's mode may have changed since
    } else {
      const cwd = folder(parent, args.cwd);
      if (!isDir(cwd)) return fail(`Folder not found: ${cwd}`);
      worker = await openSession({ cwd, engine, title: (oneLine(args.title) || firstLine(args.task) || `${who} worker`).slice(0, 60),
        model: engine === "deepseek" ? dsModel(args.model || dsSettings().defaultModel) : (args.model || "opus"),
        permissionMode: mode, link: { parent: parent.sessionId, via: toolName, toolUseId: callId || approved } });
    }
  } catch (e) { return fail(e?.message || String(e)); }   // no key, a blocked folder, a chat open elsewhere…
  onChat(worker.sessionId);
  const linkEv = { t: "link", parent: parent.sessionId, child: worker.sessionId, engine, title: worker.title, toolUseId: callId || approved };
  // this run: no outcome yet (a follow-up clears the last one); the app's Agents tab reads it after a restart
  updateLink(worker.sessionId, { runAt: Date.now(), toolUseId: linkEv.toolUseId, result: null, steps: null, ms: null, usd: null, endedAt: null });
  broadcastAll(linkEv);
  broadcastAll({ t: "sessions.changed" });
  log("worker", worker.sessionId.slice(0, 8), "for", parent.sessionId.slice(0, 8), engine, mode);

  const before = await gitStatus(worker.cwd), usd0 = chatSpend(worker.sessionId)?.usd || 0, t0 = Date.now(), text0 = worker.lastText;
  if (extra?.signal?.aborted) {   // the calling chat was stopped before the worker got its task: don't send it
    if (!args.continue_chat) worker.close();
    const outcome = { result: "stopped", steps: 0, ms: 0, usd: 0, endedAt: Date.now() };
    updateLink(worker.sessionId, outcome);
    broadcastAll({ ...linkEv, ...outcome });
    return fail("Stopped before the worker began.");
  }
  const turn = worker.waitTurn();
  worker.send({ text: args.continue_chat ? `[Pocket Agent] A follow-up from "${oneLine(parent.title) || "the calling chat"}":\n\n${args.task}`
    : brief({ who, other: NAME[parent.engine === "deepseek" ? "deepseek" : "claude"], parent, cwd: worker.cwd, task: args.task, approved: !!approved }) });
  // Stop in the calling chat stops the worker. Interrupts that arrive before the worker's turn has begun are lost,
  // so keep at it while the worker is still busy.
  let timer = null;
  const hit = () => { try { worker.q.interrupt().catch(() => {}); } catch {} };
  const stop = () => {
    if (timer) return;
    hit();
    let n = 0;
    timer = setInterval(() => { if (++n > 20 || !busy(worker)) clearInterval(timer); else hit(); }, 1500);
    timer.unref?.();
  };
  extra?.signal?.addEventListener("abort", stop, { once: true });
  if (extra?.signal?.aborted) stop();
  const r = await turn;
  extra?.signal?.removeEventListener("abort", stop);
  clearInterval(timer);
  const after = await gitStatus(worker.cwd);
  const ms = Date.now() - t0, parentStopped = !!extra?.signal?.aborted;
  const usd = engine === "deepseek" ? Math.max(0, (chatSpend(worker.sessionId)?.usd || 0) - usd0) : null;
  // how the run went, kept with the link and sent to the app: done | stopped | failed, its steps, time and cost
  const steps = worker.activity?.snapshot().steps.filter(s => s.kind === "tool").length ?? null;
  const outcome = { result: runStatus(r, parentStopped).split(" ")[0], steps, ms, usd, endedAt: Date.now() };
  updateLink(worker.sessionId, outcome);
  broadcastAll({ ...linkEv, title: worker.title, ...outcome });
  return report({ who, worker, r, before, after, ms, parentStopped, usd, text: r?.result || (worker.lastText !== text0 ? worker.lastText : "") });
}

/** "done", "stopped" (the caller or the person stopped it) or "failed (<why>)", from the worker's last result. */
function runStatus(r, parentStopped) {
  const sub = r?.subtype || "closed";
  return parentStopped || sub === "error_during_execution" ? "stopped" : sub !== "success" ? `failed (${sub})` : r.is_error ? "failed (error)" : "done";
}

/** The worker's first message. It stays visible in the worker's chat. */
export function brief({ who, other, parent, cwd, task, approved }) {
  return `[Pocket Agent] You're a ${who} worker. The ${other} chat "${oneLine(parent.title) || "untitled"}" sent you this task${approved ? ", and the person approved it" : ""}. `
    + `Work in ${cwd}. The person may not be watching: if you're blocked or need a decision, stop and say so instead of guessing. `
    + `When you finish, end with a short report: what you changed (files), how you checked it, and anything left open.\n\n${task}`;
}

/** The tool's result. Stable: the app reads the first line and the "Chat:" line. `text` defaults to the result's own text. */
export function report({ who, worker, r, before, after, ms, usd, parentStopped, text }) {
  const status = runStatus(r, parentStopped);
  const model = String(worker.model || "default").replace(/\[1m\]$/i, "");
  const cost = usd == null ? "" : usd < 0.001 ? " · under $0.001" : ` · about $${usd.toFixed(usd < 1 ? 3 : 2)}`;
  let body = String((text ?? r?.result) || "").trim() || "(no reply)";
  if (body.length > REPORT_MAX) body = body.slice(0, REPORT_MAX) + "\n…(cut; the full text is in the worker's chat)";
  const lines = [`${who} worker: ${status}`, `Chat: ${worker.sessionId}`, `Title: ${oneLine(worker.title)}`,
    `Folder: ${worker.cwd}`, `Model: ${model} · ${duration(ms)}${cost}`, changed(before, after), "---", body];
  return { content: [{ type: "text", text: lines.join("\n") }], ...(status === "done" ? {} : { isError: true }) };
}

function changed(before, after) {
  if (!before || !after) return "Changed: (not a git repo)";
  const fresh = [...after.keys()].filter(line => before.get(line) !== after.get(line));
  if (!fresh.length) return "Changed: nothing";
  const shown = fresh.slice(0, CHANGED_MAX).map(line => "  " + line.trim());
  if (fresh.length > CHANGED_MAX) shown.push(`  …and ${fresh.length - CHANGED_MAX} more`);
  return [`Changed: ${fresh.length} file${fresh.length === 1 ? "" : "s"}`, ...shown].join("\n");
}

const duration = ms => {
  const s = Math.round(ms / 1000), m = Math.floor(s / 60), pad = n => String(n).padStart(2, "0");
  return s < 60 ? `${s}s` : m < 60 ? `${m}m ${pad(s % 60)}s` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
};

const oneLine = s => String(s || "").replace(/\s+/g, " ").trim();
/** The first non-empty line, up to 60 characters. */
export const firstLine = s => (String(s || "").split("\n").map(l => l.trim()).find(Boolean) || "").slice(0, 60);

function folder(parent, p) {
  if (!p || !p.trim()) return parent.cwd;
  return path.resolve(parent.cwd || HOME, p.trim().replace(/^~(?=\/|$)/, HOME));
}
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const git = (cwd, args) => new Promise(resolve => execFile("git", ["-C", cwd, ...args], { timeout: 10000, maxBuffer: 16 << 20 }, (err, out) => resolve(err ? null : out)));

/**
 * `git status` lines of a folder, each with its file's size and time: a file the worker changes again after an earlier
 * step already changed it keeps the same status line, but not the same size and time. null if it isn't a git repo.
 */
export async function gitStatus(cwd) {
  const [root, out] = await Promise.all([git(cwd, ["rev-parse", "--show-toplevel"]), git(cwd, ["status", "--porcelain=v1", "-uall"])]);
  if (root == null || out == null) return null;
  const top = root.trim(), map = new Map();
  for (const line of out.split("\n").filter(l => l.trim()).slice(0, 5000)) {
    let p = line.slice(3);
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4);            // a rename: the new name
    if (p.startsWith('"')) try { p = JSON.parse(p); } catch {}   // git quotes unusual names (close enough to JSON)
    let sig = "-";
    try { const st = fs.statSync(path.join(top, p)); sig = `${st.size}:${st.mtimeMs}`; } catch {}
    map.set(line, sig);   // porcelain paths are relative to the repo's top, whatever the folder
  }
  return map;
}
