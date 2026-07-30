// Font picker for the Text tool. System fonts now; Google Fonts search + dynamic
// loading is layered on in a later pass (see loadGoogleFont).
import { useEffect, useRef, useState } from 'preact/hooks'
import { Icon } from '../ui/icon'

// fallback list when the browser can't enumerate installed fonts
export const SYSTEM_FONTS = [
  'DM Sans',
  'Arial',
  'Helvetica',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Palatino',
  'Garamond',
  'Impact',
  'Comic Sans MS',
]

// full list of installed fonts via the Local Font Access API (Chromium; prompts
// once for permission). Falls back to SYSTEM_FONTS if unavailable / denied.
let sysCache: string[] | null = null
export async function getSystemFonts(): Promise<string[]> {
  if (sysCache) return sysCache
  const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts
  if (typeof q !== 'function') return (sysCache = SYSTEM_FONTS)
  try {
    const fonts = await q()
    const fams = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b))
    sysCache = fams.length ? fams : SYSTEM_FONTS
  } catch {
    sysCache = SYSTEM_FONTS
  }
  return sysCache
}

// curated popular Google Fonts (search matches these; any other family name can
// still be loaded via the "Use …" row — Google serves it if it exists)
export const GOOGLE_FONTS = [
  'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Oswald', 'Raleway', 'Poppins', 'Nunito',
  'Merriweather', 'Playfair Display', 'Ubuntu', 'Rubik', 'Work Sans', 'Inter', 'Quicksand',
  'Bebas Neue', 'Anton', 'Pacifico', 'Lobster', 'Dancing Script', 'Caveat', 'Shadows Into Light',
  'Permanent Marker', 'Abril Fatface', 'Righteous', 'Fredoka', 'Josefin Sans', 'Comfortaa',
  'Archivo', 'Barlow', 'Cabin', 'Karla', 'Mukta', 'Titillium Web', 'PT Sans', 'PT Serif',
  'Source Sans 3', 'Noto Sans', 'Fira Sans', 'Manrope', 'DM Serif Display', 'Space Grotesk',
  'Zilla Slab', 'Bungee', 'Press Start 2P', 'Orbitron', 'Audiowide', 'Monoton', 'Satisfy',
  'Great Vibes', 'Sacramento', 'Indie Flower', 'Amatic SC', 'Cinzel', 'Cormorant Garamond',
]

/** Load a web font (Google Fonts) by family name; injects a stylesheet once. */
const loaded = new Set<string>()
export function loadGoogleFont(family: string) {
  const f = family.trim()
  if (!f || loaded.has(f) || SYSTEM_FONTS.includes(f)) return
  loaded.add(f)
  const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f)}:wght@400;700&display=swap`
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  document.head.appendChild(link)
}

export function FontPicker({ value, onPick }: { value: string; onPick: (font: string) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [src, setSrc] = useState<'system' | 'google'>('system')
  const [sysFonts, setSysFonts] = useState<string[]>(SYSTEM_FONTS)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const ql = q.trim().toLowerCase()
  const google = src === 'google'
  const list = (google ? GOOGLE_FONTS : sysFonts).filter((f) => f.toLowerCase().includes(ql))
  // load the shown Google fonts so the list previews in their own typeface
  useEffect(() => {
    if (open && google) list.slice(0, 30).forEach(loadGoogleFont)
  }, [open, ql, google])
  // enumerate installed fonts when the System tab is shown
  useEffect(() => {
    if (open && !google) getSystemFonts().then(setSysFonts)
  }, [open, google])
  const exact = list.some((f) => f.toLowerCase() === ql)
  const pick = (f: string) => {
    if (google) loadGoogleFont(f)
    onPick(f)
    setOpen(false)
  }

  return (
    <div class="font-pick" ref={ref}>
      <button class="font-pick__btn" onClick={() => setOpen((o) => !o)} style={{ fontFamily: `'${value}', sans-serif` }}>
        <span>{value}</span>
        <Icon name="keyboard_arrow_down" size={16} />
      </button>
      {open && (
        <div class="font-pick__menu">
          <div class="font-pick__tabs">
            <button class={'font-pick__tab' + (!google ? ' is-on' : '')} onClick={() => setSrc('system')}>System</button>
            <button class={'font-pick__tab' + (google ? ' is-on' : '')} onClick={() => setSrc('google')}>Google</button>
          </div>
          <input
            class="font-pick__search"
            placeholder={google ? 'Search any Google font…' : 'Search system fonts…'}
            value={q}
            autoFocus
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          />
          <div class="font-pick__list">
            {google && q.trim() && !exact && (
              <button class="font-pick__item font-pick__use" onClick={() => pick(q.trim())}>
                Use “{q.trim()}”
              </button>
            )}
            {list.map((f) => (
              <button key={f} class={'font-pick__item' + (f === value ? ' is-on' : '')} style={{ fontFamily: `'${f}', sans-serif` }} onClick={() => pick(f)}>
                {f}
              </button>
            ))}
            {list.length === 0 && !(google && q.trim()) && <div class="font-pick__empty">No fonts</div>}
          </div>
        </div>
      )}
    </div>
  )
}
