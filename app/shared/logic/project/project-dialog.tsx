// Project flow. View 1 (Projects): existing projects, each showing a rendered
// frame, plus the Create / Import card. View 2: aspect tabs (+ orientation
// flip), resolution presets, and title / resolution (aspect-lockable) / fps on
// the right — or import a bundle, which brings its own settings and media.
import { useEffect, useState } from 'preact/hooks'
import { Icon } from '../ui/icon'
import {
  projects,
  currentProject,
  createProject,
  openProject,
  deleteProject,
  closeProjects,
  projectStartView,
  RATIOS,
  PRESETS,
  FPS_PRESETS,
} from './project'
import { askConfirm } from '../ui/confirm'
import { useMenuClamp } from '../ui/ctxmenu'
import { platform } from '../platform/platform'
import { previews, capturePreview, dropPreview } from './preview'

function ProjCtxMenu({ menu, onDelete }: { menu: { x: number; y: number }; onDelete: () => void }) {
  const clamp = useMenuClamp(menu.x, menu.y)
  return (
    <div ref={clamp.ref} class="ctxmenu" style={{ left: clamp.left, top: clamp.top }} onMouseDown={(e) => e.stopPropagation()}>
      <button class="ctxmenu__item ctxmenu__item--danger" onClick={onDelete}>
        Delete
      </button>
    </div>
  )
}

type View = 'list' | 'new'
type Orient = 'landscape' | 'portrait'

function ratioLabel(id: string, orient: Orient): string {
  const r = RATIOS.find((x) => x.id === id)!
  return orient === 'portrait' ? `${r.h}:${r.w}` : `${r.w}:${r.h}`
}
function orientWH(w: number, h: number, orient: Orient) {
  return orient === 'portrait' ? { w: h, h: w } : { w, h }
}

function NewProject({ onBack }: { onBack: () => void }) {
  const [ratioId, setRatioId] = useState('16:9')
  const [orient, setOrient] = useState<Orient>('landscape')
  const [title, setTitle] = useState('Untitled')
  const [width, setWidth] = useState(1920)
  const [height, setHeight] = useState(1080)
  const [fps, setFps] = useState(30)
  const [locked, setLocked] = useState(true)

  const presets = PRESETS[ratioId]

  const pickRatio = (id: string) => {
    setRatioId(id)
    const p = PRESETS[id][1] ?? PRESETS[id][0]
    const wh = orientWH(p.w, p.h, orient)
    setWidth(wh.w)
    setHeight(wh.h)
  }
  const flip = () => {
    const next: Orient = orient === 'landscape' ? 'portrait' : 'landscape'
    setOrient(next)
    setWidth(height)
    setHeight(width)
  }
  const pickPreset = (p: { w: number; h: number }) => {
    const wh = orientWH(p.w, p.h, orient)
    setWidth(wh.w)
    setHeight(wh.h)
  }
  const aspect = width / height
  const onWidth = (v: number) => {
    setWidth(v)
    if (locked) setHeight(Math.max(1, Math.round(v / aspect)))
  }
  const onHeight = (v: number) => {
    setHeight(v)
    if (locked) setWidth(Math.max(1, Math.round(v * aspect)))
  }

  const isActivePreset = (p: { w: number; h: number }) => {
    const wh = orientWH(p.w, p.h, orient)
    return wh.w === width && wh.h === height
  }

  return (
    <div class="proj-new">
      <div class="proj-header">
        <button class="proj-back" onClick={onBack} title="Back">
          <Icon name="keyboard_arrow_left" size={18} />
        </button>
        <span class="proj-header__title">
          {platform.value.openBundle ? 'New or Import' : 'New Project'}
        </span>
      </div>

      <div class="proj-new__body">
        <div class="proj-new__left">
          <div class="proj-tabs">
            {RATIOS.map((r) => (
              <div
                key={r.id}
                class={'proj-tab' + (ratioId === r.id ? ' is-active' : '')}
                onClick={() => pickRatio(r.id)}
              >
                <span>{ratioLabel(r.id, orient)}</span>
                <button
                  class="proj-tab__flip"
                  title="Flip orientation"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (ratioId !== r.id) pickRatio(r.id)
                    flip()
                  }}
                >
                  <Icon name="swap_horiz" size={15} />
                </button>
              </div>
            ))}
          </div>

          <div class="proj-grid proj-grid--presets">
            {presets.map((p) => {
              const wh = orientWH(p.w, p.h, orient)
              return (
                <button
                  key={p.label}
                  class={'proj-card' + (isActivePreset(p) ? ' is-active' : '')}
                  onClick={() => pickPreset(p)}
                >
                  <div
                    class="proj-card__preview"
                    style={{ aspectRatio: `${wh.w} / ${wh.h}` }}
                  />
                  <div class="proj-card__title">{p.label}</div>
                  <div class="proj-card__sub">
                    {wh.w} × {wh.h}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        <div class="proj-new__right">
          <label class="field">
            <span class="field__label">Title</span>
            <input
              class="field__input"
              value={title}
              onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            />
          </label>

          <div class="field">
            <span class="field__label">Resolution</span>
            <div class="res-row">
              <input
                class="field__input res-input"
                type="number"
                min={1}
                value={width}
                onInput={(e) => onWidth(+(e.target as HTMLInputElement).value)}
              />
              <button
                class={'res-lock' + (locked ? ' is-locked' : '')}
                title={locked ? 'Aspect locked' : 'Aspect unlocked'}
                onClick={() => setLocked(!locked)}
              >
                <Icon name={locked ? 'lock' : 'lock_open'} size={16} />
              </button>
              <input
                class="field__input res-input"
                type="number"
                min={1}
                value={height}
                onInput={(e) => onHeight(+(e.target as HTMLInputElement).value)}
              />
            </div>
          </div>

          <div class="field">
            <span class="field__label">Frame rate</span>
            <div class="fps-row">
              {FPS_PRESETS.map((f) => (
                <button
                  key={f}
                  class={'fps-chip' + (fps === f ? ' is-active' : '')}
                  onClick={() => setFps(f)}
                >
                  {f}
                </button>
              ))}
              <input
                class="field__input fps-input"
                type="number"
                min={1}
                value={fps}
                onInput={(e) => setFps(+(e.target as HTMLInputElement).value)}
              />
            </div>
          </div>

          <div class="proj-new__actions">
            {/* Importing skips every field above — the bundle carries its own
                resolution and rate — so it sits apart from the Create action.
                Desktop only: unpacking media needs a filesystem. */}
            {platform.value.openBundle && (
              <button class="btn" onClick={() => void platform.value.openBundle!()}>
                Import bundle…
              </button>
            )}
            <button
              class="btn btn--primary"
              onClick={() => createProject({ title, width, height, fps })}
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

interface Menu {
  x: number
  y: number
  id: string
  title: string
}

function ProjectsList({ onNew }: { onNew: () => void }) {
  const [menu, setMenu] = useState<Menu | null>(null)

  // Refresh the open project's card while you're looking at the list. Only the
  // open one can be drawn — the renderer reads the live timeline — so each
  // project's picture is whatever it looked like when last viewed here.
  useEffect(() => {
    const p = currentProject.value
    if (p) void capturePreview(p)
  }, [])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const del = async (m: Menu) => {
    setMenu(null)
    if (!(await askConfirm(`Delete “${m.title}”? This can't be undone.`))) return
    deleteProject(m.id)
    dropPreview(m.id)
  }

  return (
    <>
      <div class="proj-header">
        <span class="proj-header__title">Projects</span>
      </div>
      <div class="proj-grid">
        {projects.value.map((p) => (
          <button
            key={p.id}
            class="proj-card"
            onClick={() => openProject(p.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, id: p.id, title: p.title })
            }}
          >
            {/* uniform tile, picture letterboxed inside — the grid stays even
                however the projects are shaped */}
            <div class="proj-card__preview">
              {previews.value[p.id] ? (
                <img class="proj-card__shot" src={previews.value[p.id]} alt="" draggable={false} />
              ) : (
                <Icon name="theaters" size={22} />
              )}
            </div>
            <div class="proj-card__title">{p.title}</div>
            <div class="proj-card__sub">
              {p.width} × {p.height} · {p.fps}fps
            </div>
          </button>
        ))}
        <button class="proj-card proj-card--new" onClick={onNew}>
          <div class="proj-card__preview proj-card__preview--new">
            <Icon name="add" size={28} />
          </div>
          <div class="proj-card__title">
            {platform.value.openBundle ? 'Create / Import' : 'Create New'}
          </div>
        </button>
      </div>
      {menu && <ProjCtxMenu menu={menu} onDelete={() => del(menu)} />}
    </>
  )
}

export function ProjectDialog() {
  const [view, setView] = useState<View>(projectStartView.value)
  const [dropHint, setDropHint] = useState(false)
  const closable = currentProject.value !== null

  useEffect(() => {
    if (!closable) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeProjects()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [closable])

  return (
    <div class="modal" onMouseDown={(e) => closable && e.target === e.currentTarget && closeProjects()}>
      <div
        class={'proj-dialog' + (dropHint ? ' is-drop' : '')}
        onDragOver={(e) => {
          e.preventDefault()
          setDropHint(true)
        }}
        onDragLeave={() => setDropHint(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDropHint(false)
          // dragging an asset in jumps straight to New Project (asset import later)
          setView('new')
        }}
      >
        {closable && (
          <button class="proj-close" title="Close" onClick={closeProjects}>
            <Icon name="close" size={18} />
          </button>
        )}
        {view === 'list' ? (
          <ProjectsList onNew={() => setView('new')} />
        ) : (
          <NewProject onBack={() => setView('list')} />
        )}
      </div>
    </div>
  )
}
