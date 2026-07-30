// Files tool — import + browse media assets.
// Grid view: thumbnail cards. List view: file-explorer with resizable
// columns (Name / Type / Size / Date added). Right-click: Replace / Delete.
import { useEffect, useRef, useState } from 'preact/hooks'
import { Icon } from '../../ui/icon'
import { useMenuClamp } from '../../ui/ctxmenu'
import {
  assets,
  addAssetsFromFiles,
  addAssetsFromPaths,
  removeAsset,
  replaceAsset,
  iconFor,
  formatSize,
  formatDate,
  type Asset,
} from './assets'
import { beginAssetDrag } from '../../timeline/assetdrag'
import { platform } from '../../platform/platform'
import { onDrag } from '../../ui/pointerdrag'

function Preview({ asset, size = 22 }: { asset: Asset; size?: number }) {
  if (asset.missing) return <Icon name="download" size={size} />
  if (asset.kind === 'image') return <img src={asset.url} alt={asset.name} />
  if (asset.kind === 'video') return <video src={asset.url} muted preload="metadata" />
  return <Icon name={iconFor(asset)} size={size} />
}

// Name that marquee-scrolls on hover when it overflows.
function ScrollName({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const enter = () => {
    const el = ref.current
    if (!el?.parentElement) return
    const over = el.scrollWidth - el.parentElement.clientWidth
    if (over > 0) {
      el.style.transition = `transform ${Math.max(1, over / 60)}s linear`
      el.style.transform = `translateX(${-over}px)`
    }
  }
  const leave = () => {
    const el = ref.current
    if (!el) return
    el.style.transition = 'transform 0.2s'
    el.style.transform = 'translateX(0)'
  }
  return (
    <div class="scrollname" onMouseEnter={enter} onMouseLeave={leave}>
      <span ref={ref} class="scrollname__inner">
        {text}
      </span>
    </div>
  )
}

interface CardProps {
  asset: Asset
  onMenu: (e: MouseEvent, id: string) => void
  onRelink: (id: string) => void
}

function GridCard({ asset, onMenu, onRelink }: CardProps) {
  return (
    <div
      class={'asset-card' + (asset.missing ? ' is-missing' : '')}
      title={asset.missing ? `${asset.name} (missing — click to relink)` : asset.name}
      onContextMenu={(e) => onMenu(e, asset.id)}
      onClick={asset.missing ? () => onRelink(asset.id) : undefined}
      onPointerDown={(e) => beginAssetDrag(asset, e as unknown as PointerEvent)}
    >
      <div class="asset-card__preview">
        <Preview asset={asset} />
      </div>
      <div class="asset-card__meta">
        <ScrollName text={asset.name} />
        <div class="asset-card__sub">{asset.ext}</div>
      </div>
    </div>
  )
}

function FileRow({ asset, onMenu, onRelink }: CardProps) {
  return (
    <div
      class={'file-row' + (asset.missing ? ' is-missing' : '')}
      title={asset.missing ? `${asset.name} (missing — click to relink)` : asset.name}
      onContextMenu={(e) => onMenu(e, asset.id)}
      onClick={asset.missing ? () => onRelink(asset.id) : undefined}
      onPointerDown={(e) => beginAssetDrag(asset, e as unknown as PointerEvent)}
    >
      <div class="file-cell file-cell--preview">
        <Preview asset={asset} size={16} />
      </div>
      <div class="file-cell file-cell--name">
        <ScrollName text={asset.name} />
      </div>
      <div class="file-cell file-cell--dim">{asset.ext}</div>
      <div class="file-cell file-cell--dim">{formatSize(asset.size)}</div>
      <div class="file-cell file-cell--dim">{formatDate(asset.addedAt)}</div>
    </div>
  )
}

// --- resizable column widths (px) for the list view ---
type Col = 'name' | 'type' | 'size'
const DEFAULT_COLS: Record<Col, number> = { name: 150, type: 64, size: 78 }

function FileList({ onMenu, onRelink }: { onMenu: (e: MouseEvent, id: string) => void; onRelink: (id: string) => void }) {
  const [cols, setCols] = useState<Record<Col, number>>(DEFAULT_COLS)

  const startResize = (key: Col, e: PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = cols[key]
    const move = (ev: PointerEvent) => {
      setCols((c) => ({ ...c, [key]: Math.max(40, startW + (ev.clientX - startX)) }))
    }
    const up = () => {
    }
    onDrag(move, up)
  }

  const styleVars = {
    '--c-name': `${cols.name}px`,
    '--c-type': `${cols.type}px`,
    '--c-size': `${cols.size}px`,
  } as Record<string, string>

  return (
    <div class="filelist" style={styleVars}>
      <div class="file-head">
        <span class="file-head__cell file-cell--preview" />
        <span class="file-head__cell">
          Name
          <span class="col-resize" onPointerDown={(e) => startResize('name', e as unknown as PointerEvent)} />
        </span>
        <span class="file-head__cell">
          Type
          <span class="col-resize" onPointerDown={(e) => startResize('type', e as unknown as PointerEvent)} />
        </span>
        <span class="file-head__cell">
          Size
          <span class="col-resize" onPointerDown={(e) => startResize('size', e as unknown as PointerEvent)} />
        </span>
        <span class="file-head__cell">Date added</span>
      </div>
      {assets.value.map((a) => (
        <FileRow key={a.id} asset={a} onMenu={onMenu} onRelink={onRelink} />
      ))}
    </div>
  )
}

interface Menu {
  x: number
  y: number
  id: string
}

function ContextMenu({ menu, onClose, onDelete, onReplace }: {
  menu: Menu
  onClose: () => void
  onDelete: (id: string) => void
  onReplace: (id: string) => void
}) {
  useEffect(() => {
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [])
  const clamp = useMenuClamp(menu.x, menu.y)
  return (
    <div ref={clamp.ref} class="ctxmenu" style={{ left: clamp.left, top: clamp.top }} onMouseDown={(e) => e.stopPropagation()}>
      <button class="ctxmenu__item" onClick={() => { onReplace(menu.id); onClose() }}>
        Replace…
      </button>
      <button class="ctxmenu__item ctxmenu__item--danger" onClick={() => { onDelete(menu.id); onClose() }}>
        Delete
      </button>
    </div>
  )
}

type ViewMode = 'grid' | 'list'

export function FilesTool() {
  const inputRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)
  const replaceId = useRef<string | null>(null)
  const [dropHint, setDropHint] = useState(false)
  const [view, setView] = useState<ViewMode>('grid')
  const [menu, setMenu] = useState<Menu | null>(null)
  // desktop: native picker (keeps file paths so projects reload media); web: <input>
  const pickFiles = () => {
    const pm = platform.value.pickMedia
    if (pm) pm().then(addAssetsFromPaths)
    else inputRef.current?.click()
  }

  const openMenu = (e: MouseEvent, id: string) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, id })
  }
  const startReplace = (id: string) => {
    replaceId.current = id
    replaceRef.current?.click()
  }

  return (
    <div class="tool">
      <div class="tool__header">
        <span class="tool__title">Files</span>
        <div class="tool__views">
          <button
            class={'tool__viewbtn' + (view === 'grid' ? ' is-active' : '')}
            title="Grid view"
            onClick={() => setView('grid')}
          >
            <Icon name="grid_view" size={16} />
          </button>
          <button
            class={'tool__viewbtn' + (view === 'list' ? ' is-active' : '')}
            title="List view"
            onClick={() => setView('list')}
          >
            <Icon name="list" size={16} />
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const f = (e.target as HTMLInputElement).files
            if (f) addAssetsFromFiles(f)
            ;(e.target as HTMLInputElement).value = ''
          }}
        />
        <input
          ref={replaceRef}
          type="file"
          hidden
          onChange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0]
            if (f && replaceId.current) replaceAsset(replaceId.current, f)
            replaceId.current = null
            ;(e.target as HTMLInputElement).value = ''
          }}
        />
      </div>

      <div
        class={`tool__body tool__body--${view}` + (dropHint ? ' is-drop' : '')}
        onDragOver={(e) => {
          e.preventDefault()
          setDropHint(true)
        }}
        onDragLeave={() => setDropHint(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDropHint(false)
          if (e.dataTransfer?.files.length) addAssetsFromFiles(e.dataTransfer.files)
        }}
      >
        {view === 'grid' ? (
          <div class="tool__grid">
            {assets.value.map((a) => (
              <GridCard key={a.id} asset={a} onMenu={openMenu} onRelink={startReplace} />
            ))}
            <button class="asset-card asset-card--add" onClick={pickFiles}>
              <div class="asset-card__preview asset-card__preview--add">
                <Icon name="add" size={26} />
              </div>
              <div class="asset-card__name--add">Import</div>
            </button>
          </div>
        ) : (
          <>
            <FileList onMenu={openMenu} onRelink={startReplace} />
            <button class="file-import" onClick={pickFiles}>
              <Icon name="add" size={16} /> Import
            </button>
          </>
        )}
      </div>

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onDelete={removeAsset}
          onReplace={startReplace}
        />
      )}
    </div>
  )
}
