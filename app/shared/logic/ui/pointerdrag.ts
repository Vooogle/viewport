// One pointer drag, from mousedown to release.
//
// Every draggable thing in the app — scrub pills, the ruler, clips, track heads,
// panel dividers, viewport handles — wants the same three lines of window
// listeners and the same teardown. This owns them, so a drag handler is just its
// own move/up logic.

export interface DragOpts {
  /**
   * Scroll this element horizontally while the pointer sits near its edges, so a
   * clip can be dragged past the visible part of the timeline.
   *
   * The caller's `move` is re-run on every scroll step, which is what makes the
   * dragged thing keep up: holding still at the edge produces no pointermove
   * events at all, so without this the view would slide out from under the item
   * and leave it behind. Handlers therefore have to measure in CONTENT space
   * (clientX + scrollLeft), not viewport space, or they'll fight the scrolling.
   */
  autoScroll?: HTMLElement | null
}

/** How close to the edge scrolling starts, and the fastest it goes. */
const EDGE_PX = 56
const MAX_STEP = 24

/**
 * Listen for the rest of a drag. `move` fires while held, `up` once on release;
 * the listeners remove themselves either way.
 *
 * Native drag-and-drop and text selection are suppressed for the duration.
 * Chromium will happily start its own image drag or select a run of text out
 * from under a custom drag, which kills the pointer stream mid-gesture and
 * leaves the interaction stuck — the "it sometimes bugs out" case.
 */
export function onDrag(move: (e: PointerEvent) => void, up?: (e: PointerEvent) => void, opts?: DragOpts) {
  const scroller = opts?.autoScroll ?? null
  let last: PointerEvent | null = null
  let raf = 0

  const swallow = (e: Event) => e.preventDefault()

  const step = () => {
    raf = 0
    if (!scroller || !last) return
    const r = scroller.getBoundingClientRect()
    const over =
      last.clientX < r.left + EDGE_PX
        ? last.clientX - (r.left + EDGE_PX)
        : last.clientX > r.right - EDGE_PX
          ? last.clientX - (r.right - EDGE_PX)
          : 0
    if (!over) return
    // ramp with how far past the threshold the pointer is, so a nudge creeps
    // and pinning the edge races
    const by = Math.sign(over) * Math.min(MAX_STEP, (Math.abs(over) / EDGE_PX) * MAX_STEP)
    const before = scroller.scrollLeft
    scroller.scrollLeft = Math.max(0, before + by)
    // Ran out of room at this end. Stop rather than spin a frame loop that can
    // no longer do anything; moving the pointer starts it again.
    if (scroller.scrollLeft === before) return
    move(last)
    raf = requestAnimationFrame(step)
  }

  const onMove = (e: PointerEvent) => {
    last = e
    move(e)
    if (scroller && !raf) raf = requestAnimationFrame(step)
  }
  const onUp = (e: PointerEvent) => {
    cancelAnimationFrame(raf)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('dragstart', swallow, true)
    window.removeEventListener('selectstart', swallow, true)
    up?.(e)
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('dragstart', swallow, true)
  window.addEventListener('selectstart', swallow, true)
}
