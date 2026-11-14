// Background agents and commands Claude started in this chat: a line above the message box, a sheet listing
// each with what it's doing now, and a page with an agent's own conversation (live while it runs).
const chatTasks = () => state.liveInfo[state.current?.sessionId]?.tasks || [];
const TASK_DONE = { completed: "Done", stopped: "Stopped", failed: "Failed", killed: "Stopped" };

function taskStats(t) {
  const bits = [];
  if (t.tools) bits.push(`${t.tools} step${t.tools === 1 ? "" : "s"}`);
  if (t.tokens) bits.push(`${fmtTok(t.tokens)} tokens`);
  const ms = t.ms || ((t.endedAt || Date.now()) - t.startedAt);
  if (ms > 1000) bits.push(fmtDur(ms));
  return bits.join(" · ");
}

function renderAgentsLine() {
  const el = $("#agents-line"), tasks = chatTasks();
  if (!tasks.length) { el.hidden = true; return; }
  // "1 agent working · 2 commands done · 1 agent stopped": each group named by what's in it
  const word = (list, n) => { const ag = list.every(t => t.kind === "agent"), cm = list.every(t => t.kind === "command"); const w = ag ? "agent" : cm ? "command" : "task"; return `${n} ${w}${n === 1 ? "" : "s"}`; };
  const run = tasks.filter(t => t.status === "running"), done = tasks.filter(t => t.status === "completed"), stopped = tasks.filter(t => t.status !== "running" && t.status !== "completed");
  const parts = [run.length && word(run, run.length) + " working", done.length && word(done, done.length) + " done", stopped.length && word(stopped, stopped.length) + " stopped"].filter(Boolean);
  el.hidden = false;
  el.innerHTML = (run.length ? '<span class="spark"></span>' : icon("bot")) + `<span>${parts.join(" · ")}</span><span class="chev">›</span>`;
  if (sheet.key === "agents") drawAgents();
}

function openAgents() { sheet.open(`<div id="agents-sheet"></div>`, { key: "agents" }); drawAgents(); }
function drawAgents() {
  const b = $("#agents-sheet"); if (!b) return;
  const tasks = chatTasks().slice().sort((a, c) => (a.status === "running") - (c.status === "running") || a.startedAt - c.startedAt).reverse();
  b.innerHTML = `<h2>Agents and background tasks</h2><div class="sub">Started by Claude in this chat. Tap one to follow it.</div><div class="ag-list"></div>`;
  const list = b.querySelector(".ag-list");
  for (const t of tasks) {
    const row = h(`<button class="ag-row"><span class="ag-st">${t.status === "running" ? '<span class="spark"></span>' : icon(t.status === "completed" ? "check" : "x")}</span>
      <span class="ag-t"><b></b><small class="ag-now"></small><small class="ag-stats"></small></span></button>`);
    row.querySelector("b").textContent = t.description;
    row.querySelector(".ag-now").textContent = t.status === "running" ? (t.activity || "Starting…") : `${TASK_DONE[t.status] || t.status}${t.summary && t.summary !== t.description ? " · " + t.summary : ""}`;
    row.querySelector(".ag-stats").textContent = [t.kind === "agent" ? (t.agentType || "agent") : "command", taskStats(t)].filter(Boolean).join(" · ");
    row.onclick = () => { sheet.close(true); openAgent(t.id); };
    list.append(row);
  }
}

/** An agent's own conversation, refreshed every few seconds while it runs. */
function openAgent(id) {
  const sid = state.current.sessionId;
  let timer = null, view = null;
  const task = () => chatTasks().find(t => t.id === id) || { id, description: "Agent", status: "completed" };
  page.open(task().description, async body => {
    body.innerHTML = `<div class="ag-head"><div class="ag-now"></div><button class="chip" id="ag-stop" hidden>Stop</button></div><div class="ag-chat"></div>`;
    const head = () => {
      const t = task();
      body.querySelector(".ag-now").textContent = t.status === "running" ? `${t.activity || "Working…"} · ${taskStats(t)}` : `${TASK_DONE[t.status] || t.status} · ${taskStats(t)}`;
      body.querySelector("#ag-stop").hidden = t.status !== "running";
    };
    body.querySelector("#ag-stop").onclick = async () => { try { await conn.call("session.stopTask", { sessionId: sid, taskId: id }); toast("Stopping…"); } catch (e) { toast(e.message); } };
    const box = body.querySelector(".ag-chat");
    const load = async () => {
      head();
      if (task().kind === "command") { box.innerHTML = `<p class="u-foot">A background command. Its output reaches Claude when it finishes.</p>`; return; }
      let r; try { r = await conn.call("task.transcript", { sessionId: sid, taskId: id }); } catch (e) { box.textContent = e.message; return; }
      if (!r.messages) { box.innerHTML = `<p class="u-foot">This agent's conversation isn't saved on this phone.</p>`; return; }
      const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
      view ||= new ChatView(box);
      view.reset(); view.loadHistory(r.messages);
      updateTodoBar(chat.todos);   // the agent's view mustn't take over the chat's to-do bar
      if (atEnd) body.scrollTop = body.scrollHeight;
    };
    await load();
    timer = setInterval(() => { if (!page.isOpen) return clearInterval(timer); if (task().status === "running") load(); else { head(); clearInterval(timer); load(); } }, 3000);
  }, "", () => clearInterval(timer));
}

$("#agents-line").onclick = () => openAgents();
setInterval(() => { if (chatTasks().some(t => t.status === "running")) renderAgentsLine(); }, 5000);
