// App preferences (General). Small JSON persisted to ~/.viewport/settings.json
// on desktop (localStorage in the browser) — never media.
// The Preferences > General menu opens this dialog; it holds sectioned toggles.
import { signal, effect } from '@preact/signals'
import { Icon } from '../ui/icon'
import { platform } from '../platform/platform'
import { readJson, writeJson, SETTINGS_KEY } from '../storage/store'

export type ThemeMode = 'dark' | 'light' | 'system'
/** the palette vars a user can customise (a curated subset, per theme) */
export const COLOR_VARS = ['--accent', '--bg', '--bg-elev', '--text'] as const
export type ColorVar = (typeof COLOR_VARS)[number]
export const COLOR_LABELS: Record<ColorVar, string> = {
  '--accent': 'Accent',
  '--bg': 'Background',
  '--bg-elev': 'Surface',
  '--text': 'Text',
}
/** stock palette per resolved theme — the fallback the pickers show + Reset restores */
export const THEME_DEFAULTS: Record<'dark' | 'light', Record<ColorVar, string>> = {
  dark: { '--accent': '#4c8dff', '--bg': '#121316', '--bg-elev': '#191b1f', '--text': '#e6e7ea' },
  light: { '--accent': '#2f6fe0', '--bg': '#f4f5f7', '--bg-elev': '#ffffff', '--text': '#1a1c20' },
}

export interface Prefs {
  /** block browser zoom (Ctrl+wheel, Ctrl +/-/0, pinch) */
  lockZoom: boolean
  /** colour theme; 'system' follows the OS preference */
  theme: ThemeMode
  /** per-theme colour overrides (only the vars the user changed) */
  colors: { dark: Partial<Record<ColorVar, string>>; light: Partial<Record<ColorVar, string>> }
  /** allow the app to contact the update server to check for new versions */
  updateRequests: boolean
  /** viewport render scale, 1 = one canvas pixel per on-screen pixel. Lower
   *  draws fewer pixels and stretches them up; the picture stays the same size */
  previewScale: number
}
const DEFAULTS: Prefs = {
  lockZoom: false,
  theme: 'system',
  colors: { dark: {}, light: {} },
  updateRequests: true,
  previewScale: 1,
}
const KEY = 'viewport.prefs'

const merge = (j: Partial<Prefs> & { colors?: Prefs['colors'] }): Prefs => ({
  ...DEFAULTS,
  ...j,
  colors: { dark: { ...j?.colors?.dark }, light: { ...j?.colors?.light } },
})

export const prefs = signal<Prefs>(merge({}))

// Persisting is deferred until the stored copy has been read — otherwise the
// initial defaults would race ahead and overwrite the user's real settings.
let loaded = false

export async function loadPrefs() {
  let stored = await readJson<Partial<Prefs> | null>(SETTINGS_KEY, null)
  if (!stored) {
    // one-time migration from the old localStorage-only layout
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) {
        stored = JSON.parse(raw) as Partial<Prefs>
        await writeJson(SETTINGS_KEY, merge(stored))
        localStorage.removeItem(KEY)
      }
    } catch {
      /* nothing to migrate */
    }
  }
  if (stored) prefs.value = merge(stored)
  loaded = true
}

export function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]) {
  prefs.value = { ...prefs.value, [k]: v }
}
// persist (tiny JSON only)
effect(() => {
  const value = prefs.value
  if (!loaded) return
  void writeJson(SETTINGS_KEY, value)
})

export const showPrefs = signal(false)
export function openPrefs() {
  showPrefs.value = true
}

// --- theme: resolve dark/light (incl. 'system'), then apply the CSS palette ---
const mql = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
const systemDark = signal(mql ? mql.matches : true)
mql?.addEventListener('change', (e) => (systemDark.value = e.matches))

export function resolvedTheme(p: Prefs = prefs.value): 'dark' | 'light' {
  return p.theme === 'system' ? (systemDark.value ? 'dark' : 'light') : p.theme
}

// apply the resolved theme + any per-theme colour overrides to <html>
effect(() => {
  const p = prefs.value
  const t = resolvedTheme(p) // reads systemDark → re-runs on OS change
  const root = document.documentElement
  root.dataset.theme = t
  const ov = p.colors[t] ?? {}
  for (const v of COLOR_VARS) {
    if (ov[v]) root.style.setProperty(v, ov[v]!)
    else root.style.removeProperty(v)
  }
})

export function setColor(v: ColorVar, value: string) {
  const t = resolvedTheme()
  const colors = { ...prefs.value.colors, [t]: { ...prefs.value.colors[t], [v]: value } }
  prefs.value = { ...prefs.value, colors }
}
export function resetColors() {
  const t = resolvedTheme()
  prefs.value = { ...prefs.value, colors: { ...prefs.value.colors, [t]: {} } }
}

// --- zoom lock: prevent the browser from zooming the whole app ---
export function installZoomLock() {
  const onWheel = (e: WheelEvent) => {
    if (prefs.value.lockZoom && (e.ctrlKey || e.metaKey)) e.preventDefault()
  }
  const onKey = (e: KeyboardEvent) => {
    if (!prefs.value.lockZoom) return
    if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0'].includes(e.key)) e.preventDefault()
  }
  const onGesture = (e: Event) => {
    if (prefs.value.lockZoom) e.preventDefault()
  }
  // capture + non-passive so preventDefault actually blocks the zoom
  window.addEventListener('wheel', onWheel, { passive: false, capture: true })
  window.addEventListener('keydown', onKey, { capture: true })
  window.addEventListener('gesturestart', onGesture as EventListener)
  window.addEventListener('gesturechange', onGesture as EventListener)
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button class={'pref-switch' + (on ? ' is-on' : '')} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span class="pref-switch__knob" />
    </button>
  )
}

export function PreferencesDialog() {
  if (!showPrefs.value) return null
  const p = prefs.value
  return (
    <div class="modal" onMouseDown={(e) => e.target === e.currentTarget && (showPrefs.value = false)}>
      <div class="proj-dialog">
        <button class="proj-close" title="Close" onClick={() => (showPrefs.value = false)}>
          <Icon name="close" size={18} />
        </button>
        <div class="proj-header">
          <span class="proj-header__title">Preferences</span>
        </div>
        <div class="kb-body">
          {/* browser-only: the desktop shell has no page zoom to lock */}
          {!platform.value.isDesktop && (
            <div class="pref-section">
              <div class="pref-section__title">UI</div>
              <div class="pref-row">
                <div class="pref-row__text">
                  <span class="pref-row__label">Lock zoom</span>
                  <span class="pref-row__desc">Stop the browser zooming the app (Ctrl+scroll, Ctrl +/−, pinch)</span>
                </div>
                <Toggle on={p.lockZoom} onChange={(v) => setPref('lockZoom', v)} />
              </div>
            </div>
          )}

          <div class="pref-section">
            <div class="pref-section__title">Updates</div>
            <div class="pref-row">
              <div class="pref-row__text">
                <span class="pref-row__label">Update requests</span>
                <span class="pref-row__desc">Let Viewport check online for new versions</span>
              </div>
              <Toggle on={p.updateRequests} onChange={(v) => setPref('updateRequests', v)} />
            </div>
          </div>

          <div class="pref-section">
            <div class="pref-section__title">Appearance</div>
            <div class="pref-row">
              <div class="pref-row__text">
                <span class="pref-row__label">Theme</span>
                <span class="pref-row__desc">Dark, light, or follow the system</span>
              </div>
              <div class="pref-seg">
                {(['dark', 'light', 'system'] as ThemeMode[]).map((m) => (
                  <button
                    key={m}
                    class={'pref-seg__btn' + (p.theme === m ? ' is-on' : '')}
                    onClick={() => setPref('theme', m)}
                  >
                    {m[0].toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div class="pref-row">
              <div class="pref-row__text">
                <span class="pref-row__label">Colors</span>
                <span class="pref-row__desc">Customise the {resolvedTheme(p)} palette</span>
              </div>
              <button class="pref-reset" onClick={resetColors}>
                Reset
              </button>
            </div>
            <div class="pref-colors">
              {COLOR_VARS.map((v) => {
                const cur = p.colors[resolvedTheme(p)][v] ?? THEME_DEFAULTS[resolvedTheme(p)][v]
                return (
                  <label key={v} class="pref-color">
                    <input
                      type="color"
                      value={cur}
                      onInput={(e) => setColor(v, (e.target as HTMLInputElement).value)}
                    />
                    <span>{COLOR_LABELS[v]}</span>
                  </label>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
