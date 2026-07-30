// The tone-curve editor: one square, four channels, drag the points.
//
// SVG rather than canvas — the points are a handful of elements that need hit
// testing and a cursor, which the DOM already does. The drawn line is the same
// interpolation the shader bakes (`curveFn`), so what's drawn here is what the
// picture does, not an approximation of it.
//
// Every read goes through `editableCurve` and every write through `applyCurve`,
// which is what makes the handles animate: with the object open in the
// animation editor, dragging a point writes a keyframe holding the whole shape,
// and scrubbing between two keys walks the handles from the first shape to the
// second. Bound to `clip.curves` instead, the editor would show a static field
// that nothing renders the moment a channel had keys.
import { useState } from 'preact/hooks'
import { snapshot, type Clip } from '../timeline/timeline'
import { applyCurve, editableCurve, animatingClipId, animPlayhead } from '../timeline/anim'
import { playhead } from '../timeline/timeline'
import { curveFn, CURVE_CHANNELS, curveAnimId, IDENTITY_CURVE, type CurvePt, type CurveChannel } from '../render/grade'
import { onDrag } from '../ui/pointerdrag'

const SIZE = 180
/** how close (in curve units) a click has to be to grab a point instead of adding one */
const GRAB = 0.05

const LABEL: Record<CurveChannel, string> = { master: 'RGB', r: 'R', g: 'G', b: 'B' }
const STROKE: Record<CurveChannel, string> = {
  master: 'var(--fg, #e8e8e8)',
  r: '#ff5f56',
  g: '#5fd35f',
  b: '#5f9dff',
}

const IDENTITY = IDENTITY_CURVE
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/** curve space (0..1, y up) → svg space (y down) */
const sx = (x: number) => x * SIZE
const sy = (y: number) => (1 - y) * SIZE

export function CurveEditor({ clip }: { clip: Clip }) {
  const [ch, setCh] = useState<CurveChannel>('master')
  // object-local time: the animation editor's own playhead while it's open,
  // otherwise where the transport falls inside this object
  const tLocal =
    animatingClipId.value === clip.id
      ? animPlayhead.value
      : Math.max(0, Math.min(clip.duration, playhead.value - clip.start))
  const pts = editableCurve(clip, ch, tLocal)
  const animated = (clip.anim?.[curveAnimId(ch)]?.keys.length ?? 0) > 0
  const f = curveFn(pts)

  /** the drawn line, sampled at the resolution the bake uses horizontally */
  const path = (() => {
    const step = 1 / 64
    let d = `M 0 ${sy(clamp01(f(0)))}`
    for (let x = step; x <= 1.0001; x += step) d += ` L ${sx(x).toFixed(2)} ${sy(clamp01(f(Math.min(1, x)))).toFixed(2)}`
    return d
  })()

  const write = (next: CurvePt[], snap: boolean) =>
    applyCurve(clip.id, ch, [...next].sort((a, b) => a[0] - b[0]), snap)

  /** pointer position in curve space */
  const at = (e: PointerEvent, el: SVGSVGElement): CurvePt => {
    const r = el.getBoundingClientRect()
    return [clamp01((e.clientX - r.left) / r.width), clamp01(1 - (e.clientY - r.top) / r.height)]
  }

  const grab = (e: PointerEvent) => {
    const svg = e.currentTarget as SVGSVGElement
    const [px, py] = at(e, svg)
    let idx = pts.findIndex(([x, y]) => Math.abs(x - px) < GRAB && Math.abs(y - py) < GRAB)
    let list = [...pts]
    if (idx < 0) {
      // A click on empty space is a new control point, placed where the click
      // was — not on the line. Dropping it on the line and making you drag it
      // afterwards is one gesture more for the same result.
      list.push([px, py])
      list.sort((a, b) => a[0] - b[0])
      idx = list.findIndex(([x, y]) => x === px && y === py)
      snapshot()
      write(list, false)
    } else {
      snapshot()
    }
    // The first and last points are the black and white ends of the curve;
    // moving them along x would leave the range undefined outside them.
    const locked = idx === 0 || idx === list.length - 1
    onDrag((ev) => {
      const [mx, my] = at(ev, svg)
      const next = [...list]
      const [ox] = next[idx]
      next[idx] = [locked ? ox : mx, my]
      // keep them ordered, and never let two share an x (the bake would divide
      // by a zero-width span)
      next.sort((a, b) => a[0] - b[0])
      list = next
      write(next, false)
    })
  }

  /** right-click / double-click removes an interior point */
  const remove = (e: MouseEvent) => {
    e.preventDefault()
    const svg = e.currentTarget as SVGSVGElement
    const r = svg.getBoundingClientRect()
    const px = clamp01((e.clientX - r.left) / r.width)
    const py = clamp01(1 - (e.clientY - r.top) / r.height)
    const idx = pts.findIndex(([x, y]) => Math.abs(x - px) < GRAB && Math.abs(y - py) < GRAB)
    if (idx <= 0 || idx >= pts.length - 1) return
    snapshot()
    write(pts.filter((_, i) => i !== idx), false)
  }

  const bent = pts.length > 2 || pts.some(([x, y]) => Math.abs(x - y) > 1e-4)

  return (
    <div class="curve">
      <div class="curve__tabs">
        {CURVE_CHANNELS.map((k) => (
          <button
            key={k}
            class={
              'curve__tab' +
              (k === ch ? ' is-on' : '') +
              // a channel with keys counts as set even with no static curve —
              // that's an animated channel, not an untouched one
              (clip.curves?.[k] || clip.anim?.[curveAnimId(k)]?.keys.length ? ' is-set' : '')
            }
            style={{ color: k === ch ? STROKE[k] : undefined }}
            onClick={() => setCh(k)}
            title={k === 'master' ? 'All channels' : `${LABEL[k]} channel`}
          >
            {LABEL[k]}
          </button>
        ))}
        <button
          class="curve__reset"
          disabled={!bent}
          title="Reset this channel"
          onClick={() => {
            snapshot()
            write(IDENTITY, false)
          }}
        >
          Reset
        </button>
      </div>
      <svg
        class="curve__grid"
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        onPointerDown={grab}
        onContextMenu={remove}
        onDblClick={remove}
      >
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g}>
            <line x1={sx(g)} y1={0} x2={sx(g)} y2={SIZE} class="curve__rule" />
            <line x1={0} y1={sy(g)} x2={SIZE} y2={sy(g)} class="curve__rule" />
          </g>
        ))}
        <line x1={0} y1={SIZE} x2={SIZE} y2={0} class="curve__diag" />
        <path d={path} class="curve__line" style={{ stroke: STROKE[ch] }} />
        {pts.map(([x, y], i) => (
          <circle key={i} cx={sx(x)} cy={sy(y)} r={4} class="curve__pt" style={{ stroke: STROKE[ch] }} />
        ))}
      </svg>
      <div class="prop__hint">
        {animated
          ? 'Animated — shaping this writes a keyframe at the playhead.'
          : 'Click to add, drag to shape, right-click a point to remove.'}
      </div>
    </div>
  )
}
