// "This Project" — edit the open project's details after it exists.
//
// The viewport's own settings popover already covers resolution and fps, but
// nothing could rename a project once created: the title was only ever set in
// the New Project form. This is the one place that edits all of it, reachable
// from File without going near the viewport.
import { signal } from '@preact/signals'
import { useState } from 'preact/hooks'
import { Icon } from '../ui/icon'
import { currentProject, updateProject, RATIOS, PRESETS, FPS_PRESETS } from './project'
import { saveProject } from './project-store'

const open = signal(false)
export function openProjectSettings() {
  open.value = true
}

/** Closest named ratio for a size, so the preset list opens on the right tab. */
function ratioFor(w: number, h: number): string {
  const a = w / h
  let best = RATIOS[0].id
  let diff = Infinity
  for (const r of RATIOS)
    for (const cand of [r.w / r.h, r.h / r.w]) {
      const d = Math.abs(cand - a)
      if (d < diff) {
        diff = d
        best = r.id
      }
    }
  return best
}

export function ProjectSettingsDialog() {
  if (!open.value) return null
  const p = currentProject.value
  if (!p) return null
  return <Inner key={p.id} />
}

function Inner() {
  const p = currentProject.value!
  const [title, setTitle] = useState(p.title)
  const [locked, setLocked] = useState(true)
  const portrait = p.height > p.width
  const ratioId = ratioFor(p.width, p.height)
  const aspect = p.width / p.height

  const close = () => (open.value = false)
  const commit = () => {
    // an all-whitespace title would leave an unclickable blank card
    updateProject({ title: title.trim() || 'Untitled' })
    void saveProject()
    close()
  }
  const setW = (v: number) =>
    updateProject({ width: v, height: locked ? Math.max(1, Math.round(v / aspect)) : p.height })
  const setH = (v: number) =>
    updateProject({ height: v, width: locked ? Math.max(1, Math.round(v * aspect)) : p.width })

  return (
    <div class="modal" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="proj-dialog">
        <button class="proj-close" title="Close" onClick={close}>
          <Icon name="close" size={18} />
        </button>
        <div class="proj-header">
          <span class="proj-header__title">This Project</span>
        </div>

        <div class="kb-body">
          <div class="pref-section">
            <div class="pref-section__title">Name</div>
            <input
              class="field__input"
              value={title}
              autoFocus
              onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                e.stopPropagation() // don't let global shortcuts eat typing
                if (e.key === 'Enter') commit()
                else if (e.key === 'Escape') close()
              }}
            />
          </div>

          <div class="pref-section">
            <div class="pref-section__title">Resolution</div>
            <div class="proj-grid proj-grid--presets">
              {PRESETS[ratioId].map((preset) => {
                const w = portrait ? preset.h : preset.w
                const h = portrait ? preset.w : preset.h
                return (
                  <button
                    key={preset.label}
                    class={'proj-card' + (p.width === w && p.height === h ? ' is-active' : '')}
                    onClick={() => updateProject({ width: w, height: h })}
                  >
                    <div class="proj-card__preview" style={{ aspectRatio: `${w} / ${h}` }} />
                    <div class="proj-card__title">{preset.label}</div>
                    <div class="proj-card__sub">
                      {w} × {h}
                    </div>
                  </button>
                )
              })}
            </div>
            <div class="res-row">
              <input
                class="field__input res-input"
                type="number"
                min={1}
                value={p.width}
                onInput={(e) => setW(Math.max(1, +(e.target as HTMLInputElement).value || 1))}
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
                value={p.height}
                onInput={(e) => setH(Math.max(1, +(e.target as HTMLInputElement).value || 1))}
              />
            </div>
          </div>

          <div class="pref-section">
            <div class="pref-section__title">Frame rate</div>
            <div class="pref-seg">
              {FPS_PRESETS.map((f) => (
                <button
                  key={f}
                  class={'pref-seg__btn' + (p.fps === f ? ' is-on' : '')}
                  onClick={() => updateProject({ fps: f })}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div class="modal__actions">
          <button class="btn" onClick={close}>
            Cancel
          </button>
          <button class="btn btn--primary" onClick={commit}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
