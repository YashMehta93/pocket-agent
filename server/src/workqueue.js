// Worker runs wait their turn: at most max at once; the rest queue in order and start as slots free (never refused).
/** A queue of runs that keeps at most `max` going; the rest wait in the order they were added. */
export function createQueue(max) {
  const waiting = [];
  let running = 0;
  const next = () => {
    while (running < max && waiting.length) {
      const e = waiting.shift();
      running++;
      Promise.resolve().then(e.fn).then(e.resolve, e.reject).finally(() => { running--; next(); });
    }
  };
  return {
    /** Queue fn; the promise settles with fn's result (or its error) once a slot frees. */
    run(fn, tag) { return new Promise((resolve, reject) => { waiting.push({ fn, tag, resolve, reject }); next(); }); },
    get running() { return running; },
    get waiting() { return waiting.length; },
    /** The 1-based place of the first waiting run with this tag; 0 if none is waiting. */
    position(tag) {
      const i = waiting.findIndex(e => e.tag === tag);
      return i < 0 ? 0 : i + 1;
    },
    /** Drop every waiting run whose tag matches; each is rejected. Returns how many were removed. */
    cancel(pred) {
      let n = 0;
      for (let i = waiting.length - 1; i >= 0; i--) {
        if (!pred(waiting[i].tag)) continue;
        const [e] = waiting.splice(i, 1);
        n++;
        e.reject(new Error("stopped before it began"));
      }
      return n;
    },
  };
}
