// Global shortcut handling. For now it just blocks the browser's default for any
// combo we've bound (e.g. Ctrl+S saving the page) when focus isn't in a field.
// Later this is where bound actions get dispatched.
import { keybinds, comboFromEvent, keyName } from './keybinds'
import { actions } from './actions'

function isEditable(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null
  if (!n) return false
  const tag = n.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || n.isContentEditable
}

/** id of the keybind any of whose combos matches, or null */
function matchBind(combo: string): string | null {
  for (const cat of keybinds.value)
    for (const b of cat.binds)
      if (b.combos.some((c) => c.join('+') === combo)) return b.id
  return null
}

function onKeyDown(e: KeyboardEvent) {
  if (isEditable(e.target)) return // don't hijack typing / copy-paste in fields
  if (keyName(e) === null) return // modifier-only
  const id = matchBind(comboFromEvent(e).join('+'))
  if (!id) return
  e.preventDefault() // block browser default (e.g. Ctrl+S)
  actions.get(id)?.()
}

export function installShortcuts() {
  window.addEventListener('keydown', onKeyDown, { capture: true })
}
