// approvals.js — permission prompts: tool approvals, Claude's questions, plan approval
"use strict";



// ───────────── approvals ─────────────
function showNextPermission() {
  const cur = state.current;
  const p = state.pending.find(x => x.sessionId === cur?.sessionId);
  if (!p) { if (sheet.key?.startsWith("perm:")) sheet.close(true); updateComposer(); return; }
  if (sheet.key === "perm:" + p.requestId) return;
  if (p.toolName === "AskUserQuestion") return askQuestionSheet(p);
  if (p.toolName === "ExitPlanMode") return planSheet(p);
  if (typeof isDelegationTool === "function" && isDelegationTool(p.toolName)) return delegationSheet(p);   // deepseek.js
  const inp = p.input || {};
  let detail = "";
  if (p.toolName === "Bash") detail = `<pre>$ ${esc(inp.command)}</pre>${inp.description ? `<div class="sub" style="margin-top:6px">${esc(inp.description)}</div>` : ""}`;
  else if (p.toolName === "Edit" || p.toolName === "MultiEdit" || p.toolName === "Write") detail = `<div class="sub">${esc(shortPath(inp.file_path))}</div><div id="perm-diff"></div>`;
  else if (p.toolName === "WebFetch") detail = `<pre>${esc(inp.url)}</pre>${inp.prompt ? `<div class="sub">${esc(inp.prompt)}</div>` : ""}`;
  else detail = `<pre>${esc(JSON.stringify(inp, null, 2))}</pre>`;
  const canAlways = (p.suggestions || []).length > 0;
  const b = sheet.open(`<h2>Allow ${esc(prettyToolName(p.toolName))}?</h2>
    ${p.decisionReason ? `<div class="sub">${esc(p.decisionReason)}</div>` : ""}${p.blockedPath ? `<div class="sub">Outside the project: ${esc(shortPath(p.blockedPath))}</div>` : ""}
    <div class="perm-detail">${detail}</div>
    <div class="btns"><button class="btn primary" data-a="allow">Allow</button>
    ${canAlways ? `<button class="btn" data-a="always">Allow and don't ask again${p.toolName === "Bash" ? " for this command" : ""}</button>` : ""}
    <div class="btns row2" style="margin-top:0"><button class="btn danger" data-a="deny">Deny</button><button class="btn ghost" data-a="tell">Deny & say why</button></div></div>`,
    { key: "perm:" + p.requestId });
  const dd = b.querySelector("#perm-diff");
  if (dd) {
    if (p.toolName === "Write") dd.append(codeBlock(inp.content || "", langOf(inp.file_path)));
    else if (p.toolName === "Edit") dd.append(diffView(diffLines(inp.old_string, inp.new_string)).el);
    else for (const e of inp.edits || []) dd.append(diffView(diffLines(e.old_string, e.new_string)).el);
  }
  const reply = async (behavior, extra = {}) => {
    haptic("tick"); sheet.close(true);
    try { await conn.call("permission.reply", { sessionId: p.sessionId, requestId: p.requestId, behavior, ...extra }); } catch (e) { toast(e.message); }
  };
  b.querySelector('[data-a="allow"]').onclick = () => reply("allow");
  b.querySelector('[data-a="always"]')?.addEventListener("click", () => reply("allow", { always: true }));
  b.querySelector('[data-a="deny"]').onclick = () => reply("deny");
  b.querySelector('[data-a="tell"]').onclick = async () => { const why = await promptSheet({ title: "What should Claude do instead?", multiline: true, ok: "Send" }); if (why) reply("deny", { message: why }); else showNextPermission(); };
}
function askQuestionSheet(p) {
  const qs = p.input?.questions || [];
  const answers = {};
  const b = sheet.open(`<h2>Claude has ${qs.length > 1 ? "some questions" : "a question"}</h2><div id="qs"></div>
    <div class="btns"><button class="btn primary" data-a="ok">Submit answers</button><button class="btn ghost" data-a="skip">Skip</button></div>`, { key: "perm:" + p.requestId });
  qs.forEach(q => {
    const blk = h(`<div class="q-block"><div class="qh">${esc(q.header || "")}</div><div style="margin:2px 0 6px">${esc(q.question)}</div></div>`);
    const chosen = new Set();
    (q.options || []).forEach(o => {
      const btn = h(`<button class="opt">${icon("circle")}<div class="ot"><div>${esc(o.label)}</div><div class="od">${esc(o.description || "")}</div></div></button>`);
      btn.onclick = () => {
        if (!q.multiSelect) { chosen.clear(); blk.querySelectorAll(".opt").forEach(x => { x.classList.remove("on"); x.querySelector("svg").outerHTML = icon("circle"); }); }
        if (chosen.has(o.label)) chosen.delete(o.label); else chosen.add(o.label);
        btn.classList.toggle("on", chosen.has(o.label)); btn.querySelector("svg").outerHTML = icon(chosen.has(o.label) ? "ccheck" : "circle");
        answers[q.question] = [...chosen].join(", ");
      };
      blk.append(btn);
    });
    const other = h(`<input class="field" placeholder="Other (type your own answer)">`);
    other.oninput = () => { if (other.value.trim()) answers[q.question] = other.value.trim(); else answers[q.question] = [...chosen].join(", "); };
    blk.append(other);
    b.querySelector("#qs").append(blk);
  });
  b.querySelector('[data-a="ok"]').onclick = async () => {
    sheet.close(true);
    await conn.call("permission.reply", { sessionId: p.sessionId, requestId: p.requestId, behavior: "allow", updatedInput: { ...p.input, answers } }).catch(e => toast(e.message));
  };
  b.querySelector('[data-a="skip"]').onclick = async () => { sheet.close(true); await conn.call("permission.reply", { sessionId: p.sessionId, requestId: p.requestId, behavior: "deny", message: "The user skipped the questions." }).catch(() => {}); };
}
function planSheet(p) {
  const b = sheet.open(`<h2>Ready to start?</h2><div class="sub">Claude finished planning. Review the plan:</div><div class="perm-detail md" id="plan-md"></div>
    <div class="btns"><button class="btn primary" data-a="auto">Yes, auto-accept edits</button><button class="btn" data-a="ask">Yes, ask before each edit</button>
    <button class="btn ghost" data-a="no">No, keep planning…</button></div>`, { key: "perm:" + p.requestId });
  setMd(b.querySelector("#plan-md"), p.input?.plan || "");
  const go = async (mode) => {
    sheet.close(true);
    await conn.call("permission.reply", { sessionId: p.sessionId, requestId: p.requestId, behavior: "allow" }).catch(e => toast(e.message));
    applySetting({ permissionMode: mode });
  };
  b.querySelector('[data-a="auto"]').onclick = () => go("acceptEdits");
  b.querySelector('[data-a="ask"]').onclick = () => go("default");
  b.querySelector('[data-a="no"]').onclick = async () => {
    const why = await promptSheet({ title: "What should change in the plan?", multiline: true, ok: "Send" });
    await conn.call("permission.reply", { sessionId: p.sessionId, requestId: p.requestId, behavior: "deny", message: why || "Keep planning. The user wants changes to the plan." }).catch(() => {});
  };
}
