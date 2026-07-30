// Top-bar menu. Reads menus from the UI API registry (ui-api.ts).
// Click-to-open, hover-to-switch, click-outside / Esc to close.
// Submenus: a MenuList owns which sibling flyout is open, so opening one closes
// the others instantly; a close delay only applies when leaving to empty space.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Icon } from '../ui/icon'
import { askConfirm } from '../ui/confirm'
import {
  menus,
  toolbars,
  highlightToolbar,
  toggleToolbar,
  type MenuItemDef,
} from './ui-api'
import {
  layouts,
  editingLayout,
  loadLayout,
  renameLayout,
  deleteLayout,
  updateLayout,
  type SavedLayout,
} from './ui-layouts'
import { panelInfo, panelTree, highlightPanel, hasPanel, togglePanel } from './panels'

interface FlyoutCtl {
  openId: string | null
  open: (id: string) => void
  closeSoon: () => void
}

function ToolbarsContent() {
  const list = toolbars.value
  return (
    <div onMouseLeave={() => (highlightToolbar.value = null)}>
      {list.length === 0 && <div class="menubar__empty">No toolbars</div>}
      {list.map((t) => (
        <button
          key={t.id}
          class={'menubar__item' + (t.open ? '' : ' is-off')}
          onMouseEnter={() => (highlightToolbar.value = t.open ? t.id : null)}
          onClick={() => toggleToolbar(t.id)}
        >
          <span>
            {t.name} ({t.n})
          </span>
          <span class="menubar__state">{t.open ? 'open' : 'closed'}</span>
        </button>
      ))}
    </div>
  )
}

function PanelsContent() {
  panelTree.value // re-render when panels open/close
  return (
    <div onMouseLeave={() => (highlightPanel.value = null)}>
      {panelInfo.value.map((p) => {
        const open = hasPanel(p.id)
        return (
          <button
            key={p.id}
            class={'menubar__item' + (open ? '' : ' is-off')}
            onMouseEnter={() => (highlightPanel.value = open ? p.id : null)}
            onClick={() => togglePanel(p.id)}
          >
            <span>
              {p.title} ({p.id})
            </span>
            <span class="menubar__state">{open ? 'open' : 'closed'}</span>
          </button>
        )
      })}
    </div>
  )
}

function LayoutRow({ lay }: { lay: SavedLayout }) {
  const editing = editingLayout.value === lay.id
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const commit = () => {
    const v = inputRef.current?.value.trim()
    if (v) renameLayout(lay.id, v)
    editingLayout.value = null
  }

  return (
    <div class="menubar__item layoutrow" onClick={() => loadLayout(lay.id)}>
      {editing ? (
        <input
          ref={inputRef}
          class="layoutrow__input"
          defaultValue={lay.name}
          onClick={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') editingLayout.value = null
          }}
        />
      ) : (
        <span
          onDblClick={(e) => {
            e.stopPropagation()
            if (!lay.builtin) editingLayout.value = lay.id
          }}
        >
          {lay.name}
        </span>
      )}
      {!lay.builtin && !editing && (
        <span class="layoutrow__actions">
          <button
            class="layoutrow__btn"
            title="Save current over this layout"
            onClick={async (e) => {
              e.stopPropagation()
              if (await askConfirm(`Overwrite "${lay.name}" with the current layout?`, 'Overwrite'))
                updateLayout(lay.id)
            }}
          >
            <Icon name="save" size={13} />
          </button>
          <button
            class="layoutrow__btn"
            title="Delete layout"
            onClick={async (e) => {
              e.stopPropagation()
              if (await askConfirm(`Delete "${lay.name}"?`)) deleteLayout(lay.id)
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </span>
      )}
    </div>
  )
}

function MenuItem({ item, close, fly }: { item: MenuItemDef; close: () => void; fly: FlyoutCtl }) {
  const sep = item.separatorBefore ? <div class="menubar__sep" /> : null

  const flyout = (content: ComponentChildren) => {
    const isOpen = fly.openId === item.id
    return (
      <>
        {sep}
        <div
          class="menubar__item has-sub"
          onMouseEnter={() => fly.open(item.id)}
          onMouseLeave={fly.closeSoon}
        >
          <span>{item.label}</span>
          <span class="menubar__arrow" />
          {isOpen && (
            <div class="submenu" onMouseEnter={() => fly.open(item.id)} onMouseLeave={fly.closeSoon}>
              {content}
            </div>
          )}
        </div>
      </>
    )
  }

  if (item.dynamic === 'toolbars') return flyout(<ToolbarsContent />)
  if (item.dynamic === 'panels') return flyout(<PanelsContent />)
  if (item.submenu) return flyout(<MenuList items={item.submenu} close={close} />)
  if (item.dynamic === 'layouts') {
    return (
      <>
        {sep}
        {layouts.value.map((lay) => (
          <LayoutRow key={lay.id} lay={lay} />
        ))}
      </>
    )
  }
  return (
    <>
      {sep}
      <button
        class="menubar__item"
        onClick={() => {
          item.action?.()
          if (!item.keepOpen) close()
        }}
      >
        {item.label}
      </button>
    </>
  )
}

/** Renders a list of items and coordinates which sibling flyout is open. */
function MenuList({ items, close }: { items: MenuItemDef[]; close: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const timer = useRef<number>()
  const open = (id: string) => {
    clearTimeout(timer.current)
    setOpenId(id) // immediate — closes any other open sibling
  }
  const closeSoon = () => {
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpenId(null), 220)
  }
  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <>
      {items.map((item) => (
        <MenuItem key={item.id} item={item} close={close} fly={{ openId, open, closeSoon }} />
      ))}
    </>
  )
}

export function MenuBar() {
  const list = menus.value
  const [open, setOpen] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const close = () => setOpen(null)

  useEffect(() => {
    if (open === null) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div class="menubar" ref={ref}>
      {list.map((menu) => (
        <div class="menubar__menu" key={menu.id}>
          <button
            class={'menubar__label' + (open === menu.id ? ' is-open' : '')}
            onClick={() => setOpen(open === menu.id ? null : menu.id)}
            onMouseEnter={() => open !== null && setOpen(menu.id)}
          >
            {menu.label}
          </button>
          {open === menu.id && (
            <div class="menubar__dropdown">
              {menu.items.length === 0 && <div class="menubar__empty">Empty</div>}
              <MenuList items={menu.items} close={close} />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
