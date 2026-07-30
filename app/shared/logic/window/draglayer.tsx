// Drag overlay. Minimal: button drag shows a small ghost icon; toolbar drag
// shows a thin white line at the target edge (dragged toolbar dims; if the edge
// holds another toolbar, that one gets a white outline — handled in rail.tsx).
import { useEffect } from 'preact/hooks'
import { Icon } from '../ui/icon'
import { drag, pointer, dockTarget, installDrag } from './drag'
import { toolbars, getToolbarAt, type ButtonDef } from './ui-api'

function findButton(id: string): ButtonDef | undefined {
  for (const t of toolbars.value) {
    const b = t.buttons.find((x) => x.id === id)
    if (b) return b
  }
  return undefined
}

export function DragLayer() {
  useEffect(() => installDrag(), [])

  const d = drag.value
  useEffect(() => {
    document.body.classList.toggle('is-dragging', !!d)
  }, [!!d])

  if (!d) return null
  const p = pointer.value
  const dt = dockTarget.value
  // Draw the edge line unless the target edge holds a different toolbar (that's
  // shown as an outline on the toolbar instead).
  const occupant = dt ? getToolbarAt(dt) : undefined
  const showLine = d.kind === 'toolbar' && dt != null && (!occupant || occupant.id === d.id)

  return (
    <>
      {showLine && <div class={`dockline dockline--${dt}`} />}
      {d.kind === 'button' && (
        <div class="dragghost" style={{ left: p.x, top: p.y }}>
          <div class="dragghost__btn">
            <Icon name={findButton(d.id)?.icon ?? 'temp'} />
          </div>
        </div>
      )}
    </>
  )
}
