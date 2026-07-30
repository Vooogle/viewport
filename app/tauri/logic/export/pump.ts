// Keeping the window alive during an export.
//
// The frame loops are a chain of awaits, and awaiting an already-resolved
// promise only queues a MICROTASK — the browser never gets between them to
// paint or read input. A project whose frames need no real seek therefore runs
// its whole export as one uninterrupted microtask chain: the window stops
// redrawing, the progress numbers sit still, and Cancel can't be clicked. It
// looks like a hang even though the export is running at full speed.
//
// So the loops hand control back on a real task every so often.
//
// `setTimeout` is the wrong tool: Chromium clamps nested timers to 4ms and
// throttles them to about one a second once the window is hidden, so a
// minimized or occluded export would crawl. A MessageChannel message is an
// ordinary task that keeps being delivered at full rate regardless.

const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null
const waiting: (() => void)[] = []
if (channel) channel.port1.onmessage = () => waiting.shift()?.()

/** Hand control back to the event loop once. */
export function yieldNow(): Promise<void> {
  if (!channel) return new Promise((r) => setTimeout(r, 0))
  return new Promise<void>((r) => {
    waiting.push(r)
    channel.port2.postMessage(0)
  })
}

/**
 * A yield that only fires when it's been longer than `ms` since the last one.
 *
 * Lets a loop stay responsive without paying a task per iteration: a fast
 * encode yields once per frame budget, a slow one (which is already yielding on
 * real I/O) barely notices this at all.
 */
export function makePump(ms = 16): () => Promise<void> {
  let last = performance.now()
  return async () => {
    if (performance.now() - last < ms) return
    await yieldNow()
    last = performance.now()
  }
}
