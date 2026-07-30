// Loading and choosing a 3D LUT for the selected object.
//
// The file is read here rather than through the asset system on purpose: a LUT
// is not media on the timeline, it's a setting an object points at, and putting
// .cube files in the media bin would put something in there that can never be
// dragged onto a track.
import { useRef, useState } from 'preact/hooks'
import { setClipLut, snapshot, type Clip } from '../timeline/timeline'
import { addLut, luts, removeLut, findLut } from '../render/lut'

export function LutPicker({ clip }: { clip: Clip }) {
  const file = useRef<HTMLInputElement>(null)
  const [err, setErr] = useState<string | null>(null)
  const current = findLut(clip.lutId)

  const load = async (e: Event) => {
    const input = e.target as HTMLInputElement
    const f = input.files?.[0]
    input.value = '' // so picking the same file twice still fires
    if (!f) return
    setErr(null)
    try {
      // `path` exists on files chosen through the desktop shell's picker; with
      // it the LUT reloads itself next time the project opens, without it the
      // project remembers the name and asks for the file again.
      const path = (f as File & { path?: string }).path
      const id = addLut(f.name.replace(/\.cube$/i, ''), await f.text(), path)
      snapshot()
      setClipLut(clip.id, id, false)
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'could not read that file')
    }
  }

  return (
    <div class="lut">
      <div class="lut__row">
        <select
          class="lut__select"
          value={clip.lutId ?? ''}
          onChange={(e) => setClipLut(clip.id, (e.target as HTMLSelectElement).value || null)}
        >
          <option value="">No LUT</option>
          {luts.value.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
              {l.missing ? ' (missing)' : ` · ${l.size}³`}
            </option>
          ))}
        </select>
        <button class="lut__btn" onClick={() => file.current?.click()} title="Load a .cube file">
          Load…
        </button>
        {current && (
          <button
            class="lut__btn"
            title="Forget this LUT (every object using it loses the look)"
            onClick={() => {
              snapshot()
              removeLut(current.id)
              setClipLut(clip.id, null, false)
            }}
          >
            Remove
          </button>
        )}
        <input ref={file} type="file" accept=".cube" class="lut__file" onChange={load} />
      </div>
      {/* A missing LUT is the normal state of a reopened browser project, so it
          says what to do about it rather than just reporting itself broken. */}
      {current?.missing && <div class="prop__hint">Load the .cube again to bring this look back.</div>}
      {err && <div class="prop__hint lut__err">{err}</div>}
    </div>
  )
}
