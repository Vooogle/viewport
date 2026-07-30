// Public UI API — the surface plugins (and core) use to build the chrome:
// toolbars, their buttons, and top-bar dropdown menus.
//
// Docks are the four screen edges, so there is at most one toolbar per edge
// => max 4 toolbars. State is signal-backed, so any registration reflects live.
import { signal } from '@preact/signals'

export type Dock = 'left' | 'right' | 'top' | 'bottom'
export const DOCKS: readonly Dock[] = ['left', 'right', 'top', 'bottom']
export const MAX_TOOLBARS = DOCKS.length

export interface ButtonDef {
  id: string
  icon: string
  label?: string
  onClick?: () => void
}

export interface ToolbarDef {
  id: string
  name: string
  /** stable 1-based number shown in menus */
  n: number
  dock: Dock
  open: boolean
  buttons: ButtonDef[]
}

export interface MenuItemDef {
  id: string
  label: string
  action?: () => void
  /** draw a separator above this item */
  separatorBefore?: boolean
  /** keep the menu open after the action runs (e.g. Save Layout → rename inline) */
  keepOpen?: boolean
  /** nested flyout submenu */
  submenu?: MenuItemDef[]
  /** special dynamic content rendered from live state:
   *  'toolbars'/'panels' = open/close submenu; 'layouts' = inline saved list */
  dynamic?: 'toolbars' | 'panels' | 'layouts'
}

export interface MenuDef {
  id: string
  label: string
  items: MenuItemDef[]
}

// ---- state ----
export const toolbars = signal<ToolbarDef[]>([])
export const menus = signal<MenuDef[]>([])
/** id of the toolbar to outline (e.g. hovered in the View > Toolbars menu). */
export const highlightToolbar = signal<string | null>(null)

let toolbarCounter = 0

// ---- helpers ----
export function getToolbar(id: string): ToolbarDef | undefined {
  return toolbars.value.find((t) => t.id === id)
}
export function getToolbarAt(dock: Dock): ToolbarDef | undefined {
  return toolbars.value.find((t) => t.dock === dock)
}
function firstFreeDock(): Dock | undefined {
  return DOCKS.find((d) => !getToolbarAt(d))
}
function setToolbars(next: ToolbarDef[]) {
  toolbars.value = next
}

// ==================== toolbar API ====================

/** Add a toolbar. If `dock` is omitted, the first free edge is used.
 *  Returns the toolbar id. Throws if full or the requested dock is taken. */
export function addToolbar(def: {
  id: string
  name?: string
  dock?: Dock
  buttons?: ButtonDef[]
  open?: boolean
}): string {
  if (getToolbar(def.id)) throw new Error(`toolbar "${def.id}" already exists`)
  if (toolbars.value.length >= MAX_TOOLBARS) throw new Error(`max ${MAX_TOOLBARS} toolbars`)
  const dock = def.dock ?? firstFreeDock()
  if (!dock) throw new Error('no free dock')
  if (getToolbarAt(dock)) throw new Error(`dock "${dock}" is taken`)
  setToolbars([
    ...toolbars.value,
    {
      id: def.id,
      name: def.name ?? def.id,
      n: ++toolbarCounter,
      dock,
      open: def.open ?? true,
      buttons: def.buttons ?? [],
    },
  ])
  return def.id
}

export function removeToolbar(id: string) {
  setToolbars(toolbars.value.filter((t) => t.id !== id))
}

/** Show/hide a toolbar (keeps its dock reserved). */
export function setToolbarOpen(id: string, open: boolean) {
  setToolbars(toolbars.value.map((t) => (t.id === id ? { ...t, open } : t)))
}
export function toggleToolbar(id: string) {
  const bar = getToolbar(id)
  if (bar) setToolbarOpen(id, !bar.open)
}

/** Move a toolbar to a dock. If occupied, the two toolbars swap edges. */
export function setToolbarDock(id: string, dock: Dock) {
  const bar = getToolbar(id)
  if (!bar || bar.dock === dock) return
  const occupant = getToolbarAt(dock)
  setToolbars(
    toolbars.value.map((t) => {
      if (t.id === id) return { ...t, dock }
      if (occupant && t.id === occupant.id) return { ...t, dock: bar.dock } // swap
      return t
    }),
  )
}

// ==================== button API ====================

export function addButton(toolbarId: string, btn: ButtonDef, index?: number) {
  setToolbars(
    toolbars.value.map((t) => {
      if (t.id !== toolbarId) return t
      const buttons = [...t.buttons]
      buttons.splice(index ?? buttons.length, 0, btn)
      return { ...t, buttons }
    }),
  )
}

export function removeButton(toolbarId: string, buttonId: string) {
  setToolbars(
    toolbars.value.map((t) =>
      t.id === toolbarId ? { ...t, buttons: t.buttons.filter((b) => b.id !== buttonId) } : t,
    ),
  )
}

/** Move a button to `toToolbarId` at `index`, removing it from wherever it is. */
export function moveButton(buttonId: string, toToolbarId: string, index: number) {
  const next = toolbars.value.map((t) => ({ ...t, buttons: [...t.buttons] }))
  let btn: ButtonDef | undefined
  for (const t of next) {
    const i = t.buttons.findIndex((b) => b.id === buttonId)
    if (i >= 0) {
      btn = t.buttons.splice(i, 1)[0]
      if (t.id === toToolbarId && i < index) index--
      break
    }
  }
  if (!btn) return
  const target = next.find((t) => t.id === toToolbarId)
  if (!target) return
  index = Math.max(0, Math.min(index, target.buttons.length))
  target.buttons.splice(index, 0, btn)
  setToolbars(next)
}

// ==================== menu API ====================

export function addMenu(def: MenuDef, index?: number) {
  if (menus.value.some((m) => m.id === def.id)) throw new Error(`menu "${def.id}" already exists`)
  const next = [...menus.value]
  next.splice(index ?? next.length, 0, def)
  menus.value = next
}

export function removeMenu(id: string) {
  menus.value = menus.value.filter((m) => m.id !== id)
}

export function addMenuItem(menuId: string, item: MenuItemDef, index?: number) {
  menus.value = menus.value.map((m) => {
    if (m.id !== menuId) return m
    const items = [...m.items]
    items.splice(index ?? items.length, 0, item)
    return { ...m, items }
  })
}

export function removeMenuItem(menuId: string, itemId: string) {
  menus.value = menus.value.map((m) =>
    m.id === menuId ? { ...m, items: m.items.filter((i) => i.id !== itemId) } : m,
  )
}
