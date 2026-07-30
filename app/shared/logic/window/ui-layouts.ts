// Saved layouts: snapshot/restore of toolbar arrangement (dock, open, button
// order). "Default" is a built-in, immutable baseline. User layouts persist to
// localStorage.
import { signal } from '@preact/signals'
import { toolbars, type Dock, type ButtonDef } from './ui-api'
import { panelTree, setPanelTree, type PanelNode } from './panels'

interface ToolbarSnap {
  id: string
  dock: string
  open: boolean
  buttons: string[] // button ids, in order
}
export interface LayoutSnapshot {
  toolbars: ToolbarSnap[]
  panels?: PanelNode
}
export interface SavedLayout {
  id: string
  name: string
  snapshot: LayoutSnapshot
  builtin?: boolean
}

export const layouts = signal<SavedLayout[]>([])
/** id of the layout whose name is being edited inline (null = none). */
export const editingLayout = signal<string | null>(null)

const LS_KEY = 'viewport.layouts'
const LS_CURRENT = 'viewport.currentLayout'
let unnamedCount = 0
let installed = false

function captureLayout(): LayoutSnapshot {
  return {
    toolbars: toolbars.value.map((t) => ({
      id: t.id,
      dock: t.dock,
      open: t.open,
      buttons: t.buttons.map((b) => b.id),
    })),
    // clone so a saved layout is isolated from later live edits
    panels: structuredClone(panelTree.value),
  }
}

export function applyLayout(snap: LayoutSnapshot) {
  // Pool all current button defs so buttons can move between toolbars, not just
  // reorder within one. Also remember each button's current toolbar.
  const pool = new Map<string, ButtonDef>()
  const origBar = new Map<string, string>()
  for (const t of toolbars.value) {
    for (const b of t.buttons) {
      pool.set(b.id, b)
      origBar.set(b.id, t.id)
    }
  }
  const snapIds = new Set(snap.toolbars.map((s) => s.id))
  const assigned = new Set<string>()

  const next = toolbars.value.map((t) => {
    const s = snap.toolbars.find((x) => x.id === t.id)
    if (!s) return t
    const buttons: ButtonDef[] = []
    for (const bid of s.buttons) {
      const def = pool.get(bid)
      if (def) {
        buttons.push(def)
        assigned.add(bid)
      }
    }
    return { ...t, dock: s.dock as Dock, open: s.open, buttons }
  })

  // Buttons that exist now but the snapshot never mentioned: keep them in their
  // current toolbar (only for toolbars the snapshot rebuilt).
  for (const [bid, def] of pool) {
    if (assigned.has(bid)) continue
    const oid = origBar.get(bid)
    if (oid && snapIds.has(oid)) {
      const tb = next.find((t) => t.id === oid)
      if (tb) tb.buttons = [...tb.buttons, def]
    }
  }

  toolbars.value = next
  if (snap.panels) setPanelTree(structuredClone(snap.panels))
}

function persist() {
  const user = layouts.value.filter((l) => !l.builtin)
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(user))
  } catch {
    /* storage unavailable — layouts stay in-memory */
  }
}

// Persist the *live* arrangement so a plain refresh restores it. Tiny JSON
// (ids/dock/open only) — never media, keeping storage negligible.
function persistCurrent() {
  try {
    localStorage.setItem(LS_CURRENT, JSON.stringify(captureLayout()))
  } catch {
    /* ignore */
  }
}

/** Capture the current arrangement as the Default baseline, then load saved. */
export function installLayouts() {
  if (installed) return
  installed = true
  const def: SavedLayout = {
    id: 'default',
    name: 'Default',
    snapshot: captureLayout(),
    builtin: true,
  }
  let user: SavedLayout[] = []
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) user = JSON.parse(raw) as SavedLayout[]
  } catch {
    /* ignore */
  }
  layouts.value = [def, ...user]
  unnamedCount = user.length

  // restore the last live arrangement, then keep persisting it on every change
  try {
    const raw = localStorage.getItem(LS_CURRENT)
    if (raw) applyLayout(JSON.parse(raw) as LayoutSnapshot)
  } catch {
    /* ignore */
  }
  toolbars.subscribe(persistCurrent)
  panelTree.subscribe(persistCurrent)
}

export function resetLayout() {
  const def = layouts.value.find((l) => l.id === 'default')
  if (def) applyLayout(def.snapshot)
}

export function saveCurrentLayout() {
  const id = 'lay_' + Date.now().toString(36)
  const name = `Unnamed Layout ${++unnamedCount}`
  layouts.value = [...layouts.value, { id, name, snapshot: captureLayout() }]
  editingLayout.value = id // let the user name it immediately
  persist()
}

export function loadLayout(id: string) {
  const lay = layouts.value.find((l) => l.id === id)
  if (lay) applyLayout(lay.snapshot)
}

/** Overwrite an existing (non-builtin) layout with the current arrangement. */
export function updateLayout(id: string) {
  layouts.value = layouts.value.map((l) =>
    l.id === id && !l.builtin ? { ...l, snapshot: captureLayout() } : l,
  )
  persist()
}

export function renameLayout(id: string, name: string) {
  layouts.value = layouts.value.map((l) => (l.id === id ? { ...l, name } : l))
  persist()
}

export function deleteLayout(id: string) {
  layouts.value = layouts.value.filter((l) => l.id !== id || l.builtin)
  persist()
}
