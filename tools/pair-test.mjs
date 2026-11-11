import { JSDOM, VirtualConsole } from "jsdom"; import fs from "node:fs"; import os from "node:os";
const token = fs.readFileSync(os.homedir() + "/.pocket-agent/token", "utf8").trim();
const errs = []; const vc = new VirtualConsole(); vc.on("jsdomError", e => errs.push(e.message));
const dom = await JSDOM.fromURL("http://127.0.0.1:8765/ui/#token=wrong-token-1234567890", { runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(w) { w.matchMedia = () => ({ matches: true, addEventListener() {} }); w.ResizeObserver = class { observe() {} }; w.fetch = fetch; } });
const w = dom.window, sleep = ms => new Promise(r => setTimeout(r, ms));
await new Promise(r => w.addEventListener("load", r));
for (let i = 0; i < 80 && !/Pair/.test(w.document.querySelector("#banner").textContent); i++) await sleep(250);
const b = w.document.querySelector("#banner");
console.log(!b.hidden && /Pair/.test(b.textContent) ? "PASS" : "FAIL", "wrong token shows Pair banner:", JSON.stringify(b.textContent));
b.querySelector("button").click(); await sleep(400);
w.document.querySelector("#ps-in").value = token; w.document.querySelector('#sheet [data-r="1"]').click();
for (let i = 0; i < 40 && !w.eval("conn.ok"); i++) await sleep(250);
console.log(w.eval("conn.ok") ? "PASS" : "FAIL", "pairing connects"); console.log(errs.length ? "ERRORS " + errs.join(" | ") : "no page errors");
process.exit();
