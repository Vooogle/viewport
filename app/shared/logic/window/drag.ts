// Custom pointer-drag controller (buttons + whole toolbars).
// beginDrag() on mousedown records a pending drag; moving past a threshold
// activates it. Element mouseup handlers do button drops; the window mouseup
// here docks a dragged toolbar to the nearest edge.
import { signal } from '@preact/signals'
import { setToolbarDock, type Dock } from './ui-api'

export type Drag =
  | { kind: 'button'; id: string }
  | { kind: 'toolbar'; id: string }

export const drag = signal<Drag | null>(null)
export const pointer = signal<{ x: number; y: number }>({ x: 0, y: 0 })
/** Edge a toolbar drag would dock to (nearest edge to cursor). */
export const dockTarget = signal<Dock | null>(null)

const TOPBAR_H = 28

function nearestDock(x: number, y: number): Dock {
  const dist: Record<Dock, number> = {
    left: x,
    right: window.innerWidth - x,
    top: y - TOPBAR_H,
    bottom: window.innerHeight - y,
  }
  return (Object.keys(dist) as Dock[]).reduce((a, b) => (dist[b] < dist[a] ? b : a))
}

let pending: { kind: 'button' | 'toolbar'; item: string; x: number; y: number } | null = null

export function beginDrag(kind: 'button' | 'toolbar', item: string, e: MouseEvent) {
  if (e.button !== 0) return
  pending = { kind, item, x: e.clientX, y: e.clientY }
  pointer.value = { x: e.clientX, y: e.clientY }
}

function onMove(e: MouseEvent) {
  pointer.value = { x: e.clientX, y: e.clientY }
  if (pending && !drag.value) {
    if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > 4) {
      drag.value = { kind: pending.kind, id: pending.item }
    }
  }
  if (drag.value?.kind === 'toolbar') dockTarget.value = nearestDock(e.clientX, e.clientY)
}

function onUp() {
  const d = drag.value
  if (d?.kind === 'toolbar' && dockTarget.value) setToolbarDock(d.id, dockTarget.value)
  pending = null
  drag.value = null
  dockTarget.value = null
}

export function installDrag() {
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  return () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
}
