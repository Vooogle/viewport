// 3D lookup tables (.cube), the creative half of grading.
//
// A LUT is a cube of colours: for every input RGB, the colour it becomes. That
// is the whole of a "look" — a film emulation, a camera's log-to-Rec709
// conversion — as data rather than as a chain of sliders.
//
// Held as a TILED 2D texture, not a 3D one. WebGL2 has 3D textures and the
// renderer usually gets a WebGL2 context, but it falls back to WebGL1 when it
// can't, and a look that silently stops applying on the fallback path is worse
// than a few lines of arithmetic in the shader. The blue axis is laid out
// left-to-right as `size` tiles, each `size`×`size` of red across and green
// down; the shader takes two tiles and blends between them.
import { signal } from '@preact/signals'

/** What a project stores about a LUT: enough to find it again, not the data. */
export interface LutMeta {
  id: string
  name: string
  /** absolute path (desktop) — how it reloads itself when the project reopens */
  path?: string
  size: number
}

export interface Lut extends LutMeta {
  /** tiled RGBA bytes, (size*size) × size */
  data?: Uint8Array
  /** loaded once, gone now — the project remembers it but can't re-read it */
  missing?: boolean
}

/** Every LUT this project knows about. Clips reference one by id. */
export const luts = signal<Lut[]>([])

export const findLut = (id?: string) => (id ? luts.value.find((l) => l.id === id) : undefined)

/** Biggest cube we'll take. 64³ is 786k entries — past this a .cube is almost
 *  certainly not what it says it is, and the tiled texture stops fitting. */
const MAX_SIZE = 64

/**
 * Parse a .cube file into the tiled texture the shader samples.
 *
 * Handles both 3D and 1D tables. A 1D table is three independent channel
 * curves, which is a perfectly ordinary thing to ship as a .cube — and it
 * expands into a (small) 3D cube exactly, so the renderer only ever deals with
 * one kind of thing.
 *
 * Throws with a readable reason: a LUT that silently does nothing is the worst
 * outcome here, since the picture looks fine and the look just never arrives.
 */
export function parseCube(text: string): { size: number; data: Uint8Array; title?: string } {
  let size = 0
  let oneD = 0
  let title: string | undefined
  let dmin = [0, 0, 0]
  let dmax = [1, 1, 1]
  const rows: number[][] = []

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const up = line.toUpperCase()
    if (up.startsWith('TITLE')) {
      title = line.slice(5).trim().replace(/^"|"$/g, '')
      continue
    }
    if (up.startsWith('LUT_3D_SIZE')) {
      size = parseInt(line.split(/\s+/)[1], 10)
      continue
    }
    if (up.startsWith('LUT_1D_SIZE')) {
      oneD = parseInt(line.split(/\s+/)[1], 10)
      continue
    }
    if (up.startsWith('DOMAIN_MIN')) {
      dmin = line.split(/\s+/).slice(1, 4).map(Number)
      continue
    }
    if (up.startsWith('DOMAIN_MAX')) {
      dmax = line.split(/\s+/).slice(1, 4).map(Number)
      continue
    }
    if (up.startsWith('LUT_3D_INPUT_RANGE') || up.startsWith('LUT_1D_INPUT_RANGE')) {
      const v = line.split(/\s+/).slice(1, 3).map(Number)
      dmin = [v[0], v[0], v[0]]
      dmax = [v[1], v[1], v[1]]
      continue
    }
    const nums = line.split(/\s+/).map(Number)
    if (nums.length >= 3 && nums.every((n) => Number.isFinite(n))) rows.push(nums.slice(0, 3))
  }

  const norm = (v: number, ch: number) => {
    const lo = dmin[ch] ?? 0
    const hi = dmax[ch] ?? 1
    return hi > lo ? (v - lo) / (hi - lo) : v
  }
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)))

  if (!size && oneD) {
    // A 1D table applied to each axis independently. Expanded at the table's
    // own resolution, capped — a 4096-entry 1D LUT would otherwise ask for a
    // 4096³ cube.
    const n = Math.min(oneD, 32)
    if (rows.length < oneD) throw new Error(`expected ${oneD} entries, found ${rows.length}`)
    const at = (t: number, ch: number) => {
      const x = t * (oneD - 1)
      const i = Math.min(oneD - 2, Math.floor(x))
      const f = x - i
      return norm(rows[i][ch] * (1 - f) + rows[i + 1][ch] * f, ch)
    }
    const data = new Uint8Array(n * n * n * 4)
    for (let b = 0; b < n; b++)
      for (let g = 0; g < n; g++)
        for (let r = 0; r < n; r++) {
          const o = ((g * n * n + b * n + r) * 4)
          data[o] = byte(at(r / (n - 1), 0))
          data[o + 1] = byte(at(g / (n - 1), 1))
          data[o + 2] = byte(at(b / (n - 1), 2))
          data[o + 3] = 255
        }
    return { size: n, data, title }
  }

  if (!size) throw new Error('no LUT_3D_SIZE line — is this a .cube file?')
  if (size < 2 || size > MAX_SIZE) throw new Error(`LUT_3D_SIZE ${size} is out of range (2–${MAX_SIZE})`)
  const want = size * size * size
  if (rows.length < want) throw new Error(`expected ${want} entries, found ${rows.length}`)

  // .cube order: red varies fastest, then green, then blue.
  const data = new Uint8Array(size * size * size * 4)
  for (let i = 0; i < want; i++) {
    const r = i % size
    const g = Math.floor(i / size) % size
    const b = Math.floor(i / (size * size))
    // tiled layout: x = b*size + r, y = g, row stride = size*size
    const o = (g * size * size + b * size + r) * 4
    data[o] = byte(norm(rows[i][0], 0))
    data[o + 1] = byte(norm(rows[i][1], 1))
    data[o + 2] = byte(norm(rows[i][2], 2))
    data[o + 3] = 255
  }
  return { size, data, title }
}

let lutN = 0
const newLutId = () => 'lut_' + Date.now().toString(36) + (lutN++).toString(36)

/** Register a parsed .cube. Returns the new LUT's id. */
export function addLut(name: string, text: string, path?: string): string {
  const { size, data, title } = parseCube(text)
  const id = newLutId()
  luts.value = [...luts.value, { id, name: title || name, path, size, data }]
  return id
}

export function removeLut(id: string) {
  luts.value = luts.value.filter((l) => l.id !== id)
}

/** What the project file keeps — the bytes are re-read, never stored. */
export const lutsMeta = (): LutMeta[] =>
  luts.value.map(({ id, name, path, size }) => ({ id, name, path, size }))

/**
 * Restore a project's LUTs. Anything with a path is re-read; anything without
 * one (a file dropped into a browser) comes back as missing, the same way a
 * relinkable asset does — the clips keep referring to it, so loading the file
 * again brings the look back rather than needing every clip re-graded.
 */
export async function hydrateLuts(metas: LutMeta[], srcForPath?: (p: string) => string) {
  luts.value = metas.map((m) => ({ ...m, missing: true }))
  if (!srcForPath) return
  const out: Lut[] = []
  for (const m of metas) {
    if (!m.path) {
      out.push({ ...m, missing: true })
      continue
    }
    try {
      const text = await (await fetch(srcForPath(m.path))).text()
      const { size, data } = parseCube(text)
      out.push({ ...m, size, data })
    } catch {
      out.push({ ...m, missing: true })
    }
  }
  luts.value = out
}

/**
 * The LUT half of the object fragment shader.
 *
 * Red and green ride the hardware's bilinear filter (the taps stay inside a
 * tile by construction — the sampled range is half a texel in from each edge).
 * Blue is the tiled axis, so its two neighbouring slices are fetched and mixed
 * by hand: that's what the second texture read is for.
 */
export const LUT_GLSL = `
uniform float uLutOn, uLutSize, uLutMix;
uniform sampler2D uLut;

vec3 lutFetch(vec3 c, float slice){
  float n = uLutSize;
  float u = (slice * n + c.r * (n - 1.0) + 0.5) / (n * n);
  float v = (c.g * (n - 1.0) + 0.5) / n;
  return texture2D(uLut, vec2(u, v)).rgb;
}

vec3 applyLut(vec3 c){
  if (uLutOn < 0.5 || uLutMix <= 0.0) return c;
  vec3 x = clamp(c, 0.0, 1.0);
  float bz = x.b * (uLutSize - 1.0);
  float b0 = floor(bz);
  float b1 = min(b0 + 1.0, uLutSize - 1.0);
  vec3 look = mix(lutFetch(x, b0), lutFetch(x, b1), bz - b0);
  return mix(c, look, clamp(uLutMix, 0.0, 1.0));
}
`
