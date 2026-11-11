// Fan-out of server events to connected clients.
//   - WebSocket clients: the app UI (main protocol, see docs/PROTOCOL.md)
//   - SSE clients: the app's native background service (notifications + native RPC)
import crypto from "node:crypto";
import { toNative } from "./notify.js";

export const clients = new Set();     // WebSocket connections, each with ws.subs = Set<sessionId>
export const sseClients = new Set();  // { res, v, api }: v=1 legacy app (raw events), v=2 generic shell (specs + rpc)

/** Send to clients subscribed to msg.sessionId (or to everyone if the message has no sessionId). */
export function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1 && (!msg.sessionId || c.subs.has(msg.sessionId))) c.send(s);
}

/** Send to every connected client. */
export function broadcastAll(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

/** An internal event for the phone: new apps get rendered notification specs, old apps the raw event. */
export function notifyNative(ev) {
  let translated = null;
  for (const c of sseClients) {
    if (c.v >= 2) { translated ||= toNative(ev); for (const m of translated) sse(c.res, m); }
    else sse(c.res, ev);
  }
}

// ───── server → phone RPC (see app/src/.../Rpc.java for methods) ─────
const pendingRpc = new Map();   // id -> { resolve, reject, timer }

/** Calls a native capability on the phone. Rejects if no app is connected or it doesn't answer. */
export function callNative(method, params = {}, timeoutMs = 20000) {
  const target = [...sseClients].find(c => c.v >= 2);
  if (!target) return Promise.reject(new Error("The Pocket Agent app isn't connected (or is too old for this feature)"));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingRpc.delete(id); reject(new Error(`Phone didn't answer ${method} in time`)); }, timeoutMs);
    pendingRpc.set(id, { resolve, reject, timer });
    sse(target.res, { type: "rpc", id, method, params });
  });
}

/** Result posted back by the phone (POST /native/result). */
export function nativeResult({ id, result, error }) {
  const p = pendingRpc.get(id);
  if (!p) return false;
  pendingRpc.delete(id); clearTimeout(p.timer);
  if (error) p.reject(new Error(error)); else p.resolve(result);
  return true;
}
