// One toolbar. Orientation follows its dock (top/bottom = horizontal,
// left/right = vertical). Uses the custom pointer-drag controller:
// - grab a button -> reorder within / move between toolbars
// - grab blank    -> drag the whole toolbar to a dock edge
import { Fragment } from 'preact'
import { useState } from 'preact/hooks'
import { Icon } from '../ui/icon'
import { moveButton, highlightToolbar, type ToolbarDef } from './ui-api'
import { drag, beginDrag, dockTarget } from './drag'

function indexFromPoint(x: number, y: number, el: HTMLElement, horizontal: boolean): number {
  const btns = Array.from(el.querySelectorAll<HTMLElement>('.iconbtn'))
  for (let i = 0; i < btns.length; i++) {
    const r = btns[i].getBoundingClientRect()
    const mid = horizontal ? r.left + r.width / 2 : r.top + r.height / 2
    if ((horizontal ? x : y) < mid) return i
  }
  return btns.length
}

export function Rail({ bar }: { bar: ToolbarDef }) {
  const horizontal = bar.dock === 'top' || bar.dock === 'bottom'
  const [dropIdx, setDropIdx] = useState<number | null>(null)
  const d = drag.value
  const held = d?.kind === 'toolbar' && d.id === bar.id
  const swapTarget =
    d?.kind === 'toolbar' && d.id !== bar.id && dockTarget.value === bar.dock
  const highlighted = highlightToolbar.value === bar.id

  return (
    <nav
      class={
        `railbar railbar--${bar.dock} ${horizontal ? 'railbar--h' : 'railbar--v'}` +
        (held ? ' is-held' : '') +
        (swapTarget ? ' is-swaptarget' : '') +
        (highlighted ? ' is-highlight' : '')
      }
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('.iconbtn')) return
        beginDrag('toolbar', bar.id, e)
      }}
      onMouseMove={(e) => {
        if (drag.value?.kind === 'button')
          setDropIdx(indexFromPoint(e.clientX, e.clientY, e.currentTarget as HTMLElement, horizontal))
      }}
      onMouseLeave={() => setDropIdx(null)}
      onMouseUp={() => {
        if (drag.value?.kind === 'button')
          moveButton(drag.value.id, bar.id, dropIdx ?? bar.buttons.length)
        setDropIdx(null)
      }}
    >
      {bar.buttons.map((btn, i) => (
        <Fragment key={btn.id}>
          {dropIdx === i && <div class="rail-drop" />}
          <button
            class={'iconbtn' + (d?.kind === 'button' && d.id === btn.id ? ' is-dragging' : '')}
            title={btn.label}
            onMouseDown={(e) => beginDrag('button', btn.id, e)}
            onClick={() => btn.onClick?.()}
          >
            <Icon name={btn.icon} />
          </button>
        </Fragment>
      ))}
      {dropIdx === bar.buttons.length && <div class="rail-drop" />}
    </nav>
  )
}
