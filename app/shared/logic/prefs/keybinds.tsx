// Keybinds dialog — collapsible categories. Each row: action, the combo written
// as one clickable field (click to rebind, OBS-style), and a Revert button.
// Display + capture only for now; wiring the actions to real behavior is later.
import { signal } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'
import { Icon } from '../ui/icon'

export interface Keybind {
  id: string
  label: string
  /** one or more combos; any of them triggers the action */
  combos: string[][]
  /** default combos, for Revert */
  def: string[][]
}
export interface KbCategory {
  id: string
  label: string
  binds: Keybind[]
}

const bind = (id: string, label: string, ...combos: string[][]): Keybind => ({
  id,
  label,
  combos,
  def: combos,
})

export const keybinds = signal<KbCategory[]>([
  {
    id: 'general',
    label: 'General',
    binds: [
      bind('save', 'Save project', ['Ctrl', 'S']),
      bind('copy', 'Copy', ['Ctrl', 'C']),
      bind('cutObject', 'Cut', ['Ctrl', 'X']),
      bind('paste', 'Paste', ['Ctrl', 'V']),
      bind('undo', 'Undo', ['Ctrl', 'Z']),
      bind('redo', 'Redo', ['Ctrl', 'Shift', 'Z']),
      bind('selectAll', 'Select all', ['Ctrl', 'A']),
      bind('link', 'Link objects', ['Ctrl', 'L']),
      bind('unlink', 'Unlink objects', ['Ctrl', 'Shift', 'L']),
    ],
  },
  {
    id: 'timeline',
    label: 'Timeline',
    binds: [
      bind('cut', 'Cut', ['S']),
      bind('cutAll', 'Cut all', ['Shift', 'S']),
      bind('deleteObject', 'Delete object', ['Delete']),
      bind('closeGap', 'Close gap at playhead', ['G']),
      bind('closeAllGaps', 'Close all gaps', ['Shift', 'G']),
      bind('frameLeft', 'Move playhead 1 frame left', ['Ctrl', '←']),
      bind('frameRight', 'Move playhead 1 frame right', ['Ctrl', '→']),
      bind('clipLeft', 'Move clip left edge', ['Ctrl', 'Shift', '←']),
      bind('clipRight', 'Move clip right edge', ['Ctrl', 'Shift', '→']),
      bind('seek5Left', 'Move 5 seconds left', ['←']),
      bind('seek5Right', 'Move 5 seconds right', ['→']),
      bind('seek1Left', 'Move 1 second left', ['Shift', '←']),
      bind('seek1Right', 'Move 1 second right', ['Shift', '→']),
      bind('rulerPanL', 'Pan timeline back (over ruler)', ['Scroll ↑']),
      bind('rulerPanR', 'Pan timeline forward (over ruler)', ['Scroll ↓']),
      bind('rulerStepIn', 'Zoom ruler in', ['Ctrl', 'Scroll ↑']),
      bind('rulerStepOut', 'Zoom ruler out', ['Ctrl', 'Scroll ↓']),
      bind('rulerSeekBack', 'Move playhead back (over ruler)', ['Shift', 'Scroll ↑']),
      bind('rulerSeekFwd', 'Move playhead forward (over ruler)', ['Shift', 'Scroll ↓']),
      bind('rulerSeekSegBack', 'Move playhead back by segment', ['Ctrl', 'Shift', 'Scroll ↑']),
      bind('rulerSeekSegFwd', 'Move playhead forward by segment', ['Ctrl', 'Shift', 'Scroll ↓']),
    ],
  },
  {
    id: 'properties',
    label: 'Properties',
    binds: [
      bind('propUp', 'Nudge value up', ['Scroll ↑']),
      bind('propDown', 'Nudge value down', ['Scroll ↓']),
      bind('propFineUp', 'Nudge up — ×1 / ×0.1', ['Shift', 'Scroll ↑']),
      bind('propFineDown', 'Nudge down — ×1 / ×0.1', ['Shift', 'Scroll ↓']),
      bind('propStepUp', 'Nudge up — ×5 / ×0.5', ['Ctrl', 'Scroll ↑']),
      bind('propStepDown', 'Nudge down — ×5 / ×0.5', ['Ctrl', 'Scroll ↓']),
      bind('propBigUp', 'Nudge up — ×25 / ×2.5', ['Ctrl', 'Shift', 'Scroll ↑']),
      bind('propBigDown', 'Nudge down — ×25 / ×2.5', ['Ctrl', 'Shift', 'Scroll ↓']),
    ],
  },
])

export const showKeybinds = signal(false)
export function openKeybinds() {
  showKeybinds.value = true
}

export function mutateBind(catId: string, bindId: string, fn: (b: Keybind) => Keybind) {
  keybinds.value = keybinds.value.map((c) =>
    c.id !== catId ? c : { ...c, binds: c.binds.map((b) => (b.id !== bindId ? b : fn(b))) },
  )
}
// Set combo at idx; idx === combos.length appends a new one.
export function setCombo(catId: string, bindId: string, idx: number, keys: string[]) {
  mutateBind(catId, bindId, (b) => {
    const combos = b.combos.slice()
    combos[idx] = keys
    return { ...b, combos }
  })
}
export function addCombo(catId: string, bindId: string, keys: string[]) {
  mutateBind(catId, bindId, (b) => ({ ...b, combos: [...b.combos, keys] }))
}
export function removeCombo(catId: string, bindId: string, idx: number) {
  mutateBind(catId, bindId, (b) => ({ ...b, combos: b.combos.filter((_, i) => i !== idx) }))
}
export function revertBind(catId: string, bindId: string) {
  mutateBind(catId, bindId, (b) => ({ ...b, combos: b.def }))
}

/** Register (or overwrite) a bind in a category; creates the category if new. */
export function registerBind(catId: string, catLabel: string, b: Keybind) {
  const cats = keybinds.value
  const cat = cats.find((c) => c.id === catId)
  if (!cat) {
    keybinds.value = [...cats, { id: catId, label: catLabel, binds: [b] }]
    return
  }
  keybinds.value = cats.map((c) =>
    c.id !== catId
      ? c
      : { ...c, binds: c.binds.some((x) => x.id === b.id) ? c.binds.map((x) => (x.id === b.id ? b : x)) : [...c.binds, b] },
  )
}
export function makeBind(id: string, label: string, ...combos: string[][]): Keybind {
  return bind(id, label, ...combos)
}

/** Look up a bind by id across all categories. */
export function findBind(bindId: string): Keybind | undefined {
  for (const c of keybinds.value) {
    const b = c.binds.find((x) => x.id === bindId)
    if (b) return b
  }
  return undefined
}
/** True if any of the bind's combos equals `combo` (order-insensitive parts). */
export function matchesBind(bindId: string, combo: string[]): boolean {
  const b = findBind(bindId)
  if (!b) return false
  const norm = (c: string[]) => [...c].sort().join('+')
  const target = norm(combo)
  return b.combos.some((c) => norm(c) === target)
}

const ARROWS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ' ': 'Space',
}
export function keyName(e: KeyboardEvent): string | null {
  if (e.key in ARROWS) return ARROWS[e.key]
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null // modifier alone
  return e.key.length === 1 ? e.key.toUpperCase() : e.key
}
function mods(e: KeyboardEvent | WheelEvent): string[] {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  return parts
}
export function comboFromEvent(e: KeyboardEvent): string[] {
  const parts = mods(e)
  const k = keyName(e)
  if (k) parts.push(k)
  return parts
}
// Wheel bind: modifiers + direction. deltaY<0 = up.
export function comboFromWheel(e: WheelEvent): string[] {
  const parts = mods(e)
  parts.push(e.deltaY < 0 ? 'Scroll ↑' : 'Scroll ↓')
  return parts
}

function Category({ cat, editing, setEditing }: {
  cat: KbCategory
  editing: string | null
  setEditing: (v: string | null) => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <div class="kb-cat">
      <button class="kb-cat__head" onClick={() => setOpen(!open)}>
        <span>{cat.label}</span>
        <Icon name={open ? 'keyboard_arrow_up' : 'keyboard_arrow_down'} size={18} />
      </button>
      {open && (
        <div class="kb-list">
          {cat.binds.map((b) => {
            const changed = JSON.stringify(b.combos) !== JSON.stringify(b.def)
            const addKey = `${cat.id}:${b.id}:${b.combos.length}`
            const addingNew = editing === addKey
            return (
              <div class="kb-row" key={b.id}>
                <span class="kb-row__label">{b.label}</span>
                <span class="kb-row__right">
                  <span class="kb-combos">
                    {b.combos.map((combo, i) => {
                      const key = `${cat.id}:${b.id}:${i}`
                      const isEditing = editing === key
                      return (
                        <span class="kb-combo-row" key={i}>
                          <button
                            class={'kb-combo' + (isEditing ? ' is-editing' : '')}
                            onClick={() => setEditing(isEditing ? null : key)}
                          >
                            {isEditing ? 'Press keys…' : combo.join(' + ')}
                          </button>
                          {i > 0 && (
                            <button
                              class="kb-remove"
                              title="Remove this binding"
                              onClick={() => {
                                if (editing === key) setEditing(null)
                                removeCombo(cat.id, b.id, i)
                              }}
                            >
                              <Icon name="close" size={14} />
                            </button>
                          )}
                        </span>
                      )
                    })}
                    {addingNew && (
                      <span class="kb-combo-row">
                        <button class="kb-combo is-editing" onClick={() => setEditing(null)}>
                          Press keys…
                        </button>
                      </span>
                    )}
                  </span>
                  <button
                    class="kb-revert"
                    disabled={!changed}
                    onClick={() => revertBind(cat.id, b.id)}
                  >
                    Revert
                  </button>
                  <button
                    class="kb-add"
                    title="Add another binding"
                    onClick={() => setEditing(addingNew ? null : addKey)}
                  >
                    <Icon name="add" size={16} />
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function KeybindsDialog() {
  const open = showKeybinds.value
  const [editing, setEditing] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const commit = (keys: string[]) => {
      const [catId, bindId, idx] = editing!.split(':')
      setCombo(catId, bindId, Number(idx), keys)
      setEditing(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (editing) {
        // While recording: swallow the event so browser shortcuts (Ctrl+S,
        // Ctrl+F, etc.) don't fire. Ctrl+W/T/N can't be blocked by JS.
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'Escape') return setEditing(null)
        if (keyName(e) === null) return // wait for a non-modifier key
        commit(comboFromEvent(e))
        return
      }
      if (e.key === 'Escape') showKeybinds.value = false
    }
    // Capture wheel while recording so the page doesn't scroll and we can bind
    // Scroll ↑ / Scroll ↓. passive:false lets preventDefault stop the scroll.
    const onWheel = (e: WheelEvent) => {
      if (!editing) return
      e.preventDefault()
      e.stopPropagation()
      commit(comboFromWheel(e))
    }
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => {
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('wheel', onWheel, true)
    }
  }, [open, editing])

  if (!open) return null
  return (
    <div
      class="modal"
      onMouseDown={(e) => e.target === e.currentTarget && (showKeybinds.value = false)}
    >
      <div class="proj-dialog">
        <button class="proj-close" title="Close" onClick={() => (showKeybinds.value = false)}>
          <Icon name="close" size={18} />
        </button>
        <div class="proj-header">
          <span class="proj-header__title">Keybinds</span>
        </div>
        <div class="kb-body">
          {keybinds.value.map((cat) => (
            <Category key={cat.id} cat={cat} editing={editing} setEditing={setEditing} />
          ))}
        </div>
      </div>
    </div>
  )
}
