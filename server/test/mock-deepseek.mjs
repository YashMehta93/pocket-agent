// A fake DeepSeek: its Anthropic-compatible endpoint and its balance call, for tests and on-phone rehearsals.
// No network and no real key. The DeepSeek tests drive the real Claude Code binary against it (server/test/deepseek.test.mjs).
//   node server/test/mock-deepseek.mjs [port] [key]      (defaults 8772, sk-test-deepseek)
//   POST /anthropic/v1/messages[?beta=true]   streaming or not      POST …/count_tokens → 404 (the worst case)
//   GET  /user/balance (Bearer)                                     GET  /__log (the requests so far, without bodies)
// It also refuses to be a proxy: point a test's HTTPS_PROXY here and every attempt to reach another host is blocked
// and recorded in `egress`.
//
// Scripted by directives in the newest message a person wrote (not a tool-result message):
//   [[tool NAME {json}]]  one tool call per step, in order, only if NAME is in the request's tools. The JSON may hold
//                         directives of its own (a worker's task): they're for that worker, not for this chat.
//   [[error 402]]         answer with that HTTP error (402 also marks the balance as used up)
//   [[slow MS]]           wait MS between text chunks          [[think]]  a thinking block first, even with thinking off
//   [[split]]             write the stream in tiny pieces (tests the proxy's SSE parser)
// When every directive has run it answers "MOCK DONE. Last tool result: <first 300 chars>"; with none, "MOCK: <text>".
//
// DeepSeek behaviour it copies (api-docs.deepseek.com, 14 Nov 2026): Bearer or x-api-key auth, its 401/402/422 wording,
// unknown model names → 400, tools[].type "custom" → 422, tool_choice any/tool with thinking → 400, earlier thinking
// blocks required back when tools are present (else 400), ": keep-alive" comments and ping, and usage in the final
// message_delta with cache_read_input_tokens (80% "hits") and cache_creation_input_tokens 0.
import http from "node:http";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

// claude* names are mapped by DeepSeek; anything else unknown is refused (Claude Code strips "[1m]" before sending)
const MODELS = /^(claude[\w.-]*|deepseek-flash|deepseek-v4-pro|deepseek-v4-flash|deepseek-v4-flash-vision-exp)$/;
const FULL = () => ({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "4.20", granted_balance: "0.00", topped_up_balance: "4.20" }] });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const toks = s => Math.max(1, Math.ceil(String(s).length / 4));
const textOf = c => typeof c === "string" ? c : (c || []).filter(b => b.type === "text").map(b => b.text).join("\n");
const noReminders = s => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");

/** Index just past the JSON object that starts at s[i] ("{"), or -1. Braces inside strings don't count. */
function jsonEnd(s, i) {
  let depth = 0, inStr = false;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (c === "\\") k++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return k + 1;
  }
  return -1;
}

/** The directives in a person's message. Tool directives are read first, so directives nested in their JSON stay there. */
export function parseDirectives(text) {
  const tools = [];
  let rest = "", i = 0;
  while (i < text.length) {
    const at = text.indexOf("[[tool ", i);
    if (at < 0) { rest += text.slice(i); break; }
    rest += text.slice(i, at);
    const m = /^\[\[tool (\S+) /.exec(text.slice(at, at + 400));
    const start = m ? at + m[0].length : -1, end = m && text[start] === "{" ? jsonEnd(text, start) : -1;
    let input = null;
    if (end > 0 && text.startsWith("]]", end)) try { input = JSON.parse(text.slice(start, end)); } catch {}
    if (!input) { rest += "[[tool "; i = at + 7; continue; }   // not a directive after all: keep it as text
    tools.push({ name: m[1], input });
    i = end + 2;
  }
  return { tools, rest, error: /\[\[error (\d{3})\]\]/.exec(rest)?.[1] || null, slow: +(/\[\[slow (\d+)\]\]/.exec(rest)?.[1] || 0),
    think: /\[\[think\]\]/.test(rest), split: /\[\[split\]\]/.test(rest), plain: rest.replace(/\[\[(error \d{3}|slow \d+|think|split)\]\]/g, "").trim() };
}

/** What to answer: the next tool directive, or text. */
function plan(body) {
  const msgs = body.messages || [];
  const isPerson = m => m.role === "user" && (typeof m.content === "string"
    || (m.content.some(b => b.type === "text" && noReminders(b.text).trim()) && !m.content.some(b => b.type === "tool_result")));
  let hi = msgs.length - 1;
  while (hi >= 0 && !isPerson(msgs[hi])) hi--;
  const d = parseDirectives(hi >= 0 ? noReminders(textOf(msgs[hi].content)) : "");
  const done = msgs.slice(hi + 1).filter(m => m.role === "assistant" && Array.isArray(m.content)).flatMap(m => m.content).filter(b => b.type === "tool_use").length;
  const toolNames = new Set((body.tools || []).map(t => t.name));
  const next = d.tools[done];
  const last = msgs.at(-1);
  const lastResult = last?.role === "user" && Array.isArray(last.content) ? last.content.find(b => b.type === "tool_result") : null;
  return { ...d, next: next && toolNames.has(next.name) ? next : null, lastResult };
}

function blocks(body, p) {
  const out = [];
  if ((body.thinking && body.thinking.type !== "disabled") || p.think) out.push({ type: "thinking", thinking: "Mock thinking about the task.", signature: crypto.randomBytes(12).toString("hex") });
  if (p.next) out.push({ type: "tool_use", id: "toolu_" + crypto.randomBytes(8).toString("hex"), name: p.next.name, input: p.next.input });
  else {
    const r = p.lastResult ? textOf(p.lastResult.content) : null;
    out.push({ type: "text", text: r != null ? `MOCK DONE. Last tool result: ${r.slice(0, 300)}` : `MOCK: ${p.plain.slice(0, 2000) || "hello"}` });
  }
  return out;
}

export async function startMock({ port = 8772, key = "sk-test-deepseek", alsoAccept = [] } = {}) {
  const keys = new Set([key, ...alsoAccept]);
  const requests = [], egress = [];
  let balance = FULL();
  const fail = (res, code, type, message) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type, message } })); };

  async function messages(req, res, raw, entry) {
    let body;
    try { body = JSON.parse(raw || "{}"); } catch { return fail(res, 400, "invalid_request_error", "Invalid JSON"); }
    const given = req.headers["x-api-key"] || String(req.headers.authorization || "").replace(/^Bearer /, "");
    Object.assign(entry, { model: body.model, stream: !!body.stream, tools: (body.tools || []).map(t => t.name),
      thinking: body.thinking || null, effort: body.output_config?.effort || null, beta: req.headers["anthropic-beta"] || null, authOk: keys.has(given) });
    if (!keys.has(given)) return fail(res, 401, "authentication_error", `Authentication Fails, Your api key: ****${String(given).slice(-4)} is invalid`);
    if (!MODELS.test(body.model || "")) return fail(res, 400, "invalid_request_error", `Model Not Exist: ${body.model}`);
    if ((body.tools || []).some(t => t.type === "custom")) return fail(res, 422, "invalid_request_error", "tools[].type custom is not supported");
    const thinkingOn = !!body.thinking && body.thinking.type !== "disabled";
    if (thinkingOn && body.tools?.length && ["any", "tool"].includes(body.tool_choice?.type)) return fail(res, 400, "invalid_request_error", "tool_choice any/tool is not supported in thinking mode");
    // DeepSeek: with tools, every earlier assistant turn that called a tool must come back with its thinking
    if (thinkingOn && body.tools?.length && (body.messages || []).some(m => m.role === "assistant" && Array.isArray(m.content)
      && m.content.some(b => b.type === "tool_use") && !m.content.some(b => b.type === "thinking")))
      return fail(res, 400, "invalid_request_error", "The reasoning_content in the thinking mode must be passed back to the API.");
    const p = plan(body);
    if (p.error === "402") { balance = { ...balance, is_available: false }; return fail(res, 402, "invalid_request_error", "Insufficient Balance"); }
    if (p.error) return fail(res, +p.error, p.error === "429" ? "rate_limit_error" : "api_error", "Mock error " + p.error);
    const content = blocks(body, p);
    const inTok = toks(JSON.stringify(body.messages || [])), cached = Math.floor(inTok * 0.8);
    const usage = { input_tokens: inTok - cached, cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: toks(JSON.stringify(content)) };
    entry.usage = usage;
    entry.reply = content.map(b => b.type === "tool_use" ? "tool_use:" + b.name : b.type === "text" ? "text:" + b.text.slice(0, 80) : b.type);
    const msg = { id: "msg_" + crypto.randomBytes(8).toString("hex"), type: "message", role: "assistant", model: body.model, content,
      stop_reason: content.some(b => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, usage };
    if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(msg)); }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let gone = false;
    res.on("close", () => { if (!res.writableEnded) { gone = true; entry.closedEarly = true; } });
    const write = async s => {
      if (gone) return;
      if (!p.split) return void res.write(s);
      // odd-sized pieces with pauses, so events (and even "data:" lines) arrive cut in the middle
      for (let k = 0, n = 0; k < s.length && !gone; n++) { const size = [1, 5, 13, 3, 8][n % 5]; res.write(s.slice(k, k + size)); k += size; await sleep(2); }
    };
    const send = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    await write(": keep-alive\n\n");
    await send("message_start", { type: "message_start", message: { ...msg, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } });
    await send("ping", { type: "ping" });
    for (const [i, b] of content.entries()) {
      if (gone) break;
      if (b.type === "text") {
        await send("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
        for (const piece of b.text.match(/.{1,12}/gs) || []) {
          if (gone) break;
          await send("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: piece } });
          if (p.slow) await sleep(p.slow);
        }
      } else if (b.type === "thinking") {
        await send("content_block_start", { type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "", signature: "" } });
        await send("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: b.thinking } });
        await send("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: b.signature } });
      } else {
        await send("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
        const j = JSON.stringify(b.input);
        for (let k = 0; k < j.length; k += 20) await send("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: j.slice(k, k + 20) } });
      }
      await send("content_block_stop", { type: "content_block_stop", index: i });
    }
    await send("message_delta", { type: "message_delta", delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage });
    await send("message_stop", { type: "message_stop" });
    if (!gone) res.end();
  }

  const server = http.createServer(async (req, res) => {
    res.on("error", () => {});
    // absolute-form request line: someone is using us as an HTTP proxy for another host
    if (/^[a-z]+:\/\//i.test(req.url)) { egress.push(`${req.method} ${req.url}`); res.writeHead(403); return res.end(); }
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/__log") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(requests.map(({ bodyText, ...r }) => r), null, 1));
    }
    if (req.method === "GET" && url.pathname === "/user/balance") {
      if (!keys.has(String(req.headers.authorization || "").replace(/^Bearer /, ""))) return fail(res, 401, "authentication_error", "Authentication Fails, Your api key is invalid");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(balance));
    }
    const entry = { at: Date.now(), method: req.method, path: req.url, auth: req.headers.authorization || req.headers["x-api-key"] || null,
      hash: crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16), bodyText: raw };
    requests.push(entry);
    if (req.method === "POST" && /\/v1\/messages\/count_tokens$/.test(url.pathname)) { entry.countTokens = true; return fail(res, 404, "not_found_error", "Not Found"); }
    if (req.method === "POST" && /\/v1\/messages$/.test(url.pathname)) return messages(req, res, raw, entry);
    entry.unknown = true;
    fail(res, 404, "not_found_error", "Not Found");
  });
  // CONNECT: someone tried to reach another host (HTTPS) through us. Refuse, and remember where.
  server.on("connect", (req, sock) => { egress.push(`CONNECT ${req.url}`); sock.on("error", () => {}); sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); });
  server.on("clientError", (e, sock) => { try { sock.destroy(); } catch {} });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return {
    url: `http://127.0.0.1:${port}/anthropic`, port, key, requests, egress,
    balance: () => balance,
    setBalance(b) { balance = b === undefined ? FULL() : b; },
    close: () => new Promise(r => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const m = await startMock({ port: +(process.argv[2] || 8772), key: process.argv[3] || "sk-test-deepseek" });
  console.log(`fake DeepSeek on ${m.url} (balance: http://127.0.0.1:${m.port}/user/balance), key ${m.key}`);
}
