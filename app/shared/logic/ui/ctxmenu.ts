// Keep a context menu on screen: given the desired cursor position, measure the
// rendered menu and shift it inward so it never overflows the viewport edges.
import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { RefObject } from 'preact'

const PAD = 6

/** `dep` re-measures when the menu's own size changes (e.g. a submenu page). */
export function useMenuClamp(x: number, y: number, dep?: unknown): { ref: RefObject<HTMLDivElement>; left: number; top: number } {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const maxL = window.innerWidth - r.width - PAD
    const maxT = window.innerHeight - r.height - PAD
    setPos({
      left: Math.max(PAD, Math.min(x, maxL)),
      top: Math.max(PAD, Math.min(y, maxT)),
    })
  }, [x, y, dep])
  return { ref, left: pos.left, top: pos.top }
}
