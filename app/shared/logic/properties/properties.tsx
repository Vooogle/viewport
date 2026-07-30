// Properties tool — edits the selected Object (a clip on a track).
// Fields: Object Location (start), Object Length (on-screen duration), and for
// video/audio a source in-point ("… Beginning"). Length is capped to the
// source length for video/audio; images/other stretch freely.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Icon } from '../ui/icon'
import {
  timeline,
  selectedClipId,
  selectedClips,
  findClip,
  setClipStart,
  setClipDuration,
  setClipIn,
  clipLayer,
  setClipLayer,
  setGroupLayer,
  setClipPixelated,
  setClipGradeOff,
  setClipName,
  playhead,
  isText,
  snapshot,
  MIN_CLIP,
  XFORM_DEFAULTS,
  type Clip,
} from '../timeline/timeline'
import { assets } from '../tools/files/assets'
import { currentProject } from '../project/project'
import {
  applyProp,
  sampleClip,
  animProp,
  setTextContent,
  editableText,
  animatingClipId,
  animPlayhead,
} from '../timeline/anim'
import { onDrag } from '../ui/pointerdrag'
import { GRADE_PROPS } from '../render/grade'
import { CurveEditor } from './curves'
import { LutPicker } from './lutpicker'

const pad = (n: number) => n.toString().padStart(2, '0')

/** seconds -> "H:MM:SS" (with ".dd" when fractional). */
export function formatTC(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const whole = Math.floor(s % 60)
  const frac = (s % 60) - whole
  let out = `${h}:${pad(m)}:${pad(whole)}`
  if (frac > 0.005) out += frac.toFixed(2).slice(1)
  return out
}

/** Plain layer number (1 = top) -> integer, or null. */
function parseLayer(str: string): number | null {
  const n = Number(str.trim())
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : null
}

/** "150%" / "1.5" -> gain fraction, or null. */
function parsePercent(str: string): number | null {
  const t = str.trim()
  const pct = t.endsWith('%')
  const n = Number(pct ? t.slice(0, -1) : t)
  if (!Number.isFinite(n) || n < 0) return null
  return pct ? n / 100 : n
}

const parseNum = (str: string): number | null => {
  const n = Number(str.trim())
  return Number.isFinite(n) ? n : null
}
const formatDeg = (v: number) => `${Math.round(v)}°`
const parseDeg = (str: string) => parseNum(str.replace(/°/g, ''))

/** semitones -> "+3 st" / "-2 st" / "0 st". */
function formatPitch(v: number): string {
  const n = Math.round(v * 10) / 10
  return `${n > 0 ? '+' : ''}${n} st`
}
function parsePitch(str: string): number | null {
  const n = Number(str.replace(/st/i, '').trim())
  return Number.isFinite(n) ? Math.max(-24, Math.min(24, n)) : null
}

/** pan -1..1 -> "C" / "50% L" / "80% R". */
function formatPan(v: number): string {
  if (Math.abs(v) < 0.005) return 'C'
  return `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'L' : 'R'}`
}
function parsePan(str: string): number | null {
  const t = str.trim().toUpperCase()
  if (t === 'C' || t === '0') return 0
  const side = /L/.test(t) ? -1 : 1
  const n = Number(t.replace(/[LR%\s]/g, ''))
  if (!Number.isFinite(n)) return null
  return Math.max(-1, Math.min(1, (Math.abs(n) > 1 ? n / 100 : n) * side))
}

/** "H:MM:SS(.dd)" / "MM:SS" / plain seconds -> seconds, or null if unparseable. */
export function parseTC(str: string): number | null {
  const t = str.trim()
  if (!t) return null
  const parts = t.split(':').map((p) => p.trim())
  if (parts.some((p) => p === '' || isNaN(Number(p)))) return null
  let sec = 0
  for (const p of parts) sec = sec * 60 + Number(p)
  return sec >= 0 ? sec : null
}

// The value readout for a pill. Click to edit as text; parse + apply on commit.
// Static span when the control isn't editable.
function Readout({
  text,
  parse,
  onEdit,
}: {
  text: string
  parse?: (s: string) => number | null
  onEdit?: (v: number) => void
}) {
  const editable = !!(parse && onEdit)
  const [editing, setEditing] = useState(false)
  const [txt, setTxt] = useState(text)
  useEffect(() => {
    if (!editing) setTxt(text)
  }, [text, editing])

  if (!editable) return <span class="slider__val">{text}</span>
  if (!editing)
    return (
      <span
        class="slider__val slider__val--edit"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => {
          setTxt(text)
          setEditing(true)
        }}
      >
        {text}
      </span>
    )
  const commit = () => {
    const v = parse!(txt)
    if (v != null) onEdit!(v)
    setEditing(false)
  }
  return (
    <input
      class="slider__val"
      autofocus
      value={txt}
      onPointerDown={(e) => e.stopPropagation()}
      onInput={(e) => setTxt((e.target as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation() // don't let global shortcuts eat typing
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        else if (e.key === 'Escape') setEditing(false)
      }}
    />
  )
}

// Collapsible property group with an arrow, matching the keybinds categories.
function Category({ label, children }: { label: string; children: ComponentChildren }) {
  const [open, setOpen] = useState(true)
  return (
    <div class="prop__cat">
      <button class="prop__cat-head" onClick={() => setOpen(!open)}>
        <span>{label}</span>
        <Icon name={open ? 'keyboard_arrow_up' : 'keyboard_arrow_down'} size={16} />
      </button>
      {open && <div class="prop__cat-body">{children}</div>}
    </div>
  )
}

/**
 * One property row. `animatable` (default true) tags whether the property can
 * be keyframed. Timeline Properties (track/location/beginning/length) are
 * structural — animating them makes no sense — so they carry animatable={false},
 * which shows a "no animation" tag and marks them for any future keyframe system
 * to skip.
 */
function PropRow({
  label,
  animatable = true,
  action,
  children,
}: {
  label: string
  animatable?: boolean
  /** trailing control on the right of the row (e.g. reset to default) */
  action?: ComponentChildren
  children: ComponentChildren
}) {
  return (
    <label class={'prop__row' + (animatable ? '' : ' is-static')} data-animatable={animatable}>
      <span class="prop__label">
        {label}
        {!animatable && (
          <span class="prop__noanim" title="This property can't be animated">
            <Icon name="animation" size={12} />
          </span>
        )}
      </span>
      {children}
      {action}
    </label>
  )
}

/** Reset a property to its default. Only rendered once the value has moved. */
function ResetBtn({ onReset }: { onReset: () => void }) {
  return (
    <button
      class="prop__reset"
      title="Reset to default"
      // inside a <label>, so keep the click off the labelled control
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onReset()
      }}
    >
      <Icon name="reset" size={12} />
    </button>
  )
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** Step sizes for scroll nudging. See the Properties keybinds. */
export interface NudgeCfg {
  /** plain scroll, no modifier (defaults to `shift`) */
  base?: number
  shift: number
  ctrl: number
  ctrlShift: number
}

// Modifier + scroll over a control nudges its value (Shift/Ctrl/Ctrl+Shift).
// Native listener + refs so it binds once and always sees the latest callback.
function useNudgeWheel(
  elRef: { current: HTMLElement | null },
  cfg: NudgeCfg | undefined,
  onNudge: ((delta: number) => void) | undefined,
) {
  const latest = useRef({ cfg, onNudge })
  latest.current = { cfg, onNudge }
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const { cfg, onNudge } = latest.current
      if (!cfg || !onNudge) return
      const step =
        e.ctrlKey && e.shiftKey
          ? cfg.ctrlShift
          : e.ctrlKey
            ? cfg.ctrl
            : e.shiftKey
              ? cfg.shift
              : cfg.base ?? cfg.shift // plain scroll always nudges
      e.preventDefault()
      onNudge((e.deltaY < 0 ? 1 : -1) * step)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
}

/**
 * Positional 0–100% slider for properties bounded to a fixed range (opacity,
 * volume, …). Pill track, draggable line, `value`/`onCommit` are 0..1.
 * `onInput` fires live during the drag (no history); `onCommit` on release.
 */
export function Slider({
  value,
  onStart,
  onInput,
  onCommit,
  format,
  parse,
  onEdit,
  nudge,
  onNudge,
}: {
  value: number
  onStart?: () => void
  onInput?: (v: number) => void
  onCommit: (v: number) => void
  /** readout label for the current 0..1 value; defaults to a percentage */
  format?: (v: number) => string
  /** parse typed text (display units) — enables text editing of the readout */
  parse?: (s: string) => number | null
  /** apply an edited value (display units) */
  onEdit?: (v: number) => void
  /** modifier-scroll step sizes */
  nudge?: NudgeCfg
  /** apply a scroll nudge (display units) */
  onNudge?: (delta: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useNudgeWheel(ref, nudge, onNudge)
  const [drag, setDrag] = useState<number | null>(null)
  const shown = clamp01(drag ?? value)
  const pct = Math.round(shown * 100)
  const label = format ? format(shown) : `${pct}%`

  const at = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r || r.width === 0) return shown
    return clamp01((clientX - r.left) / r.width)
  }

  const down = (e: PointerEvent) => {
    e.preventDefault()
    let started = false
    const apply = (v: number) => {
      if (!started) {
        onStart?.() // snapshot lazily on first real change
        started = true
      }
      setDrag(v)
      onInput?.(v)
    }
    const v0 = at(e.clientX)
    if (v0 !== value) apply(v0)
    else setDrag(v0)
    const move = (ev: PointerEvent) => apply(at(ev.clientX))
    const up = (ev: PointerEvent) => {
      setDrag(null)
      if (started) onCommit(at(ev.clientX))
    }
    onDrag(move, up)
  }

  return (
    <div class="prop__slider">
      <div class="slider" ref={ref} onPointerDown={(e) => down(e as unknown as PointerEvent)}>
        <div class="slider__fill" style={{ width: `${pct}%` }} />
        <div class="slider__line" style={{ left: `${pct}%` }} />
      </div>
      <Readout text={label} parse={parse} onEdit={onEdit} />
    </div>
  )
}

/**
 * Rate-scrub pill. Drag the line off-center: the further from the middle, the
 * faster the value changes (nonlinear — gentle near centre, quick at the edges).
 * Direction = which way you pull. On release the line springs elastically back
 * to the middle; the value stays where you scrubbed it.
 *
 * `onStart` records one history entry; `onInput` applies live (no history);
 * `onCommit` fires once on release. Units are whatever `value` is in.
 */
export function ScrubPill({
  value,
  min = 0,
  max = Infinity,
  speed = 3,
  onStart,
  onInput,
  onCommit,
  format,
  parse,
  onEdit,
  nudge,
  onNudge,
}: {
  value: number
  min?: number
  max?: number
  /** units per second at full deflection */
  speed?: number
  onStart?: () => void
  onInput: (v: number) => void
  onCommit: (v: number) => void
  format?: (v: number) => string
  /** parse typed text — enables text editing of the readout */
  parse?: (s: string) => number | null
  /** apply an edited value */
  onEdit?: (v: number) => void
  /** modifier-scroll step sizes */
  nudge?: NudgeCfg
  /** apply a scroll nudge */
  onNudge?: (delta: number) => void
}) {
  const track = useRef<HTMLDivElement>(null)
  const cur = useRef(value)
  const defl = useRef(0) // input deflection while held, -1..1
  const vis = useRef(0) // rendered line deflection (springs on release), -1..1
  const accel = useRef(1) // ramps up the longer you hold it off-centre
  const started = useRef(false) // has this drag snapshotted yet
  const mods = useRef({ ctrl: false, shift: false }) // modifiers held during drag
  const raf = useRef(0) // active scrub tick
  const spring = useRef(0) // active spring-back animation
  const last = useRef(0)
  useNudgeWheel(track, nudge, onNudge)
  const [held, setHeld] = useState(false)
  const [knob, setKnob] = useState(0) // triggers re-render for line position
  const [disp, setDisp] = useState(value) // live readout while held

  useEffect(() => {
    if (!held) cur.current = value
  }, [value, held])

  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  // deflection -> rate: |t|^2.2 so a small pull nudges, a big pull races
  const rate = (t: number) => Math.sign(t) * speed * Math.pow(Math.abs(t), 2.2)
  // modifier speed multiplier while dragging: shift = fine, ctrl / ctrl+shift = coarse
  const modMult = () =>
    mods.current.ctrl && mods.current.shift ? 25 : mods.current.ctrl ? 5 : mods.current.shift ? 0.2 : 1
  const render = (v: number) => {
    vis.current = v
    setKnob(v)
  }

  const deflFromX = (clientX: number) => {
    const r = track.current?.getBoundingClientRect()
    if (!r) return 0
    const half = r.width / 2
    return Math.max(-1, Math.min(1, (clientX - (r.left + half)) / half))
  }

  const tick = (now: number) => {
    const dt = Math.min(0.05, (now - last.current) / 1000)
    last.current = now
    // hold-to-accelerate: ramp while pulled off-centre, reset near the middle
    if (Math.abs(defl.current) > 0.06) accel.current = Math.min(8, accel.current + dt * 1.8)
    else accel.current = 1
    const next = clamp(cur.current + rate(defl.current) * accel.current * modMult() * dt)
    if (next !== cur.current) {
      if (!started.current) {
        onStart?.() // snapshot lazily — only when the value actually moves
        started.current = true
      }
      cur.current = next
      onInput(cur.current)
      setDisp(cur.current)
    }
    raf.current = requestAnimationFrame(tick)
  }

  // elastic spring of the line back to centre after release
  const springBack = () => {
    let velocity = 0
    let t0 = performance.now()
    const stiffness = 240
    const damping = 20
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - t0) / 1000)
      t0 = now
      const v = vis.current
      velocity += (-stiffness * v - damping * velocity) * dt
      const next = v + velocity * dt
      if (Math.abs(next) < 0.002 && Math.abs(velocity) < 0.01) {
        render(0)
        return
      }
      render(next)
      spring.current = requestAnimationFrame(step)
    }
    spring.current = requestAnimationFrame(step)
  }

  const down = (e: PointerEvent) => {
    e.preventDefault()
    cancelAnimationFrame(spring.current) // stop any in-flight spring-back
    cur.current = value
    accel.current = 1
    started.current = false
    setHeld(true)
    setDisp(value)
    defl.current = deflFromX(e.clientX)
    mods.current = { ctrl: e.ctrlKey, shift: e.shiftKey }
    render(defl.current)
    last.current = performance.now()
    raf.current = requestAnimationFrame(tick)
    const move = (ev: PointerEvent) => {
      mods.current = { ctrl: ev.ctrlKey, shift: ev.shiftKey }
      defl.current = deflFromX(ev.clientX)
      render(defl.current)
    }
    // catch modifier presses/releases even without moving the mouse
    const key = (ev: KeyboardEvent) => {
      mods.current = { ctrl: ev.ctrlKey, shift: ev.shiftKey }
    }
    const up = () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('keyup', key)
      cancelAnimationFrame(raf.current)
      defl.current = 0
      setHeld(false)
      springBack()
      onCommit(cur.current)
    }
    onDrag(move, up)
    window.addEventListener('keydown', key)
    window.addEventListener('keyup', key)
  }

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current)
      cancelAnimationFrame(spring.current)
    },
    [],
  )

  const shownVal = held ? disp : value
  const label = format ? format(shownVal) : `${Math.round(shownVal)}`
  const linePct = 50 + knob * 50

  return (
    <div class="prop__slider">
      <div
        class={'scrub' + (held ? ' is-held' : '')}
        ref={track}
        onPointerDown={(e) => down(e as unknown as PointerEvent)}
      >
        <div class="scrub__center" />
        <div
          class="scrub__fill"
          style={{ left: `${Math.min(50, linePct)}%`, width: `${Math.abs(knob) * 50}%` }}
        />
        <div class="scrub__line" style={{ left: `${linePct}%` }} />
      </div>
      <Readout text={label} parse={held ? undefined : parse} onEdit={held ? undefined : onEdit} />
    </div>
  )
}

// --- row presets ---
// Every numeric property row is one of a handful of shapes. Naming them keeps
// the category tables below to one line per property.
type Fmt = { format: (v: number) => string; parse: (s: string) => number | null }
const INT: Fmt = { format: (v) => `${Math.round(v)}`, parse: parseNum }
const PCT: Fmt = { format: (v) => `${Math.round(v * 100)}%`, parse: parsePercent }
const DEG: Fmt = { format: formatDeg, parse: parseDeg }
const PITCH: Fmt = { format: formatPitch, parse: parsePitch }
const PAN: Fmt = { format: formatPan, parse: parsePan }

/** Scroll-nudge steps, by the scale the property lives on. */
const STEP = {
  px: { shift: 1, ctrl: 10, ctrlShift: 100 },
  unit: { shift: 1, ctrl: 5, ctrlShift: 20 },
  span: { shift: 1, ctrl: 10, ctrlShift: 25 },
  thin: { shift: 1, ctrl: 2, ctrlShift: 5 },
  deg: { shift: 1, ctrl: 15, ctrlShift: 90 },
  frac: { shift: 0.05, ctrl: 0.1, ctrlShift: 0.25 },
  semitone: { shift: 1, ctrl: 5, ctrlShift: 12 },
  sec: { shift: 1, ctrl: 5, ctrlShift: 25 },
  layer: { shift: 1, ctrl: 1, ctrlShift: 1 },
} satisfies Record<string, NudgeCfg>

/** One animatable property row, as a table entry. */
interface RowSpec extends Fmt {
  prop: string
  label: string
  min?: number
  max?: number
  speed: number
  nudge: NudgeCfg
}
const row = (prop: string, label: string, speed: number, fmt: Fmt, nudge: NudgeCfg, min?: number, max?: number): RowSpec =>
  ({ prop, label, speed, nudge, min, max, ...fmt })

const SIZE_ROWS = [row('w', 'Width', 2, INT, STEP.px, 1), row('h', 'Height', 2, INT, STEP.px, 1)]
const TEXT_ROWS = [
  row('size', 'Font Size', 2, INT, STEP.px, 1),
  row('lineSpacing', 'Line Spacing', 1, INT, STEP.unit),
  row('letterSpacing', 'Letter Spacing', 1, INT, STEP.unit),
  row('curve', 'Curve', 1, INT, STEP.span, -100, 100),
  row('warp', 'Warp', 1, INT, STEP.span, -100, 100),
  row('bgPadding', 'BG Padding', 1, INT, STEP.unit, 0),
  row('bgRadius', 'BG Radius', 1, INT, STEP.unit, 0),
  row('outlineWidth', 'Outline Width', 0.6, INT, STEP.thin, 0),
]
const XFORM_ROWS = [
  row('x', 'Position X', 2, INT, STEP.px),
  row('y', 'Position Y', 2, INT, STEP.px),
  row('z', 'Position Z', 2, INT, STEP.px),
  row('rotX', 'Rotation X', 2, DEG, STEP.deg),
  row('rotY', 'Rotation Y', 2, DEG, STEP.deg),
  row('rotZ', 'Rotation Z', 2, DEG, STEP.deg),
  row('scale', 'Scale', 0.6, PCT, STEP.frac, 0),
  row('opacity', 'Opacity', 0.6, PCT, STEP.frac, 0, 1),
]
const CROP_ROWS = [
  row('cropL', 'Left', 0.5, PCT, STEP.frac, 0, 1),
  row('cropR', 'Right', 0.5, PCT, STEP.frac, 0, 1),
  row('cropT', 'Top', 0.5, PCT, STEP.frac, 0, 1),
  row('cropB', 'Bottom', 0.5, PCT, STEP.frac, 0, 1),
]
const AUDIO_ROWS = [
  row('volume', 'Volume', 0.6, PCT, STEP.frac, 0),
  row('pitch', 'Pitch', 1, PITCH, STEP.semitone, -24, 24),
  row('pan', 'Pan', 0.4, PAN, STEP.frac, -1, 1),
]
// Built from the grading registry rather than written out again — the shader,
// the animation registry and this list must agree on what exists, and three
// hand-kept copies of one list is how they stop agreeing.
const STOPS: Fmt = { format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`, parse: parseNum }
const UNIT: Fmt = { format: (v) => v.toFixed(2), parse: parseNum }
const GRADE_FMT: Record<string, { fmt: Fmt; nudge: NudgeCfg }> = {
  exposure: { fmt: STOPS, nudge: { shift: 0.1, ctrl: 0.5, ctrlShift: 1 } },
}
/**
 * Scrub speed from the property's own range, not by hand.
 *
 * `speed` is units per SECOND at full deflection, so it only means anything
 * relative to the range it moves through. Picked per property it goes wrong
 * silently: a control on a ±180° range with the same number that felt right on
 * ±1 moves three degrees for two seconds of dragging — indistinguishable from a
 * control that doesn't work. A full sweep in eight seconds (one, with the
 * hold-to-accelerate ramp) reads the same on all of them.
 */
const gradeRow = (p: (typeof GRADE_PROPS)[number]) => {
  const f = GRADE_FMT[p.id] ?? { fmt: UNIT, nudge: STEP.frac }
  return row(p.id, p.label, (p.max - p.min) / 8, f.fmt, f.nudge, p.min, p.max)
}
const GRADE_ROWS = GRADE_PROPS.map(gradeRow)

const LUT_MIX_ROW = row('lutMix', 'LUT Mix', 0.6, PCT, STEP.frac, 0, 1)

/** A single animatable numeric row (transform / text / audio), animation-aware. */
function XformRow({
  clip,
  prop,
  label,
  min,
  max,
  speed,
  format,
  parse,
  nudge,
  def,
}: RowSpec & {
  clip: Clip
  /** effective default when the field is unset (e.g. size → project resolution) */
  def?: number
}) {
  const animating = animatingClipId.value === clip.id
  const ap = animProp(prop)
  const track = clip.anim?.[prop]
  // Object-local time, which is what keyframes are stored against: the editor's
  // own playhead while it's open, otherwise where the transport falls inside
  // this object.
  const tLocal = animating
    ? animPlayhead.value
    : Math.max(0, Math.min(clip.duration, playhead.value - clip.start))
  /**
   * What this row SHOWS has to follow the data, not the open editor — the same
   * rule `applyProp` already writes by.
   *
   * It used to sample only while the animation editor was open and read the
   * static field otherwise. So an animated property, with the editor closed,
   * displayed a number nothing renders: the picture came from the keyframes,
   * the row from the leftover static value. Dragging it wrote a keyframe (which
   * is right) and then redisplayed the static value (which is not), so the pill
   * snapped straight back — the value "wouldn't change", and every keyframe you
   * set that way started from the same stale number, which is why two keys came
   * out identical.
   */
  const val =
    track?.keys.length || animating
      ? sampleClip(clip, prop, tLocal)
      : ap
        ? ap.get(clip) // reads nested fields too (e.g. text.size, bg.padding)
        : (clip as unknown as Record<string, number | undefined>)[prop] ?? def ?? XFORM_DEFAULTS[prop] ?? 0
  // The registry knows each property's real default (font size 96, volume 1);
  // XFORM_DEFAULTS only covers the transform fields.
  const dflt = def ?? ap?.default ?? XFORM_DEFAULTS[prop] ?? 0
  const changed = Math.abs(val - dflt) > 1e-6
  return (
    <PropRow
      label={label}
      action={
        changed ? (
          <ResetBtn
            onReset={() => {
              snapshot()
              applyProp(clip.id, prop, dflt)
            }}
          />
        ) : undefined
      }
    >
      <ScrubPill
        value={val}
        min={min ?? -Infinity}
        max={max ?? Infinity}
        speed={speed}
        onStart={() => snapshot()}
        onInput={(v) => applyProp(clip.id, prop, v, false)}
        onCommit={(v) => applyProp(clip.id, prop, v, false)}
        format={format}
        parse={parse}
        onEdit={(v) => applyProp(clip.id, prop, v)}
        nudge={nudge}
        onNudge={(d) => applyProp(clip.id, prop, val + d)}
      />
    </PropRow>
  )
}

function ObjectProps({ clip }: { clip: Clip }) {
  const asset = assets.value.find((a) => a.id === clip.assetId)
  const text = isText(clip)
  const capped = clip.sourceDuration != null
  const hasAudio = asset?.kind === 'audio' || asset?.kind === 'video'
  const hasVisual = text || asset?.kind === 'video' || asset?.kind === 'image'
  const projW = currentProject.value?.width ?? 1920
  const projH = currentProject.value?.height ?? 1080
  // full-scale for the Length slider: source length (capped) or a 30s reference
  const lenMax = capped ? clip.sourceDuration! - (clip.in ?? 0) : 30

  return (
    <div class="prop__list">
      <input
        class="prop__name"
        value={clip.name ?? asset?.name ?? 'Object'}
        title="Object name"
        onFocus={() => snapshot()}
        onInput={(e) => setClipName(clip.id, (e.target as HTMLInputElement).value, false)}
      />

      {/* First for a text object: its words are the thing you came here to
          edit, and buried under Timeline Properties and Size it read as
          missing entirely. */}
      {text && <TextGroup clip={clip} />}

      <Category label="Timeline Properties">
        <PropRow label="Track Layer" animatable={false}>
          <ScrubPill
            value={clipLayer(clip.id)}
            min={1}
            max={timeline.value.tracks.length}
            speed={3}
            onStart={() => snapshot()}
            onInput={(v) => setClipLayer(clip.id, v, false)}
            onCommit={(v) => setClipLayer(clip.id, v, false)}
            format={(v) => `${Math.round(v)}`}
            parse={parseLayer}
            onEdit={(v) => setClipLayer(clip.id, v)}
            nudge={STEP.layer}
            onNudge={(d) => setClipLayer(clip.id, clipLayer(clip.id) + d)}
          />
        </PropRow>

        <PropRow label="Object Location" animatable={false}>
          <ScrubPill
            value={clip.start}
            min={0}
            speed={2}
            onStart={() => snapshot()}
            onInput={(v) => setClipStart(clip.id, v, false)}
            onCommit={(v) => setClipStart(clip.id, v, false)}
            format={formatTC}
            parse={parseTC}
            onEdit={(v) => setClipStart(clip.id, v)}
            nudge={STEP.sec}
            onNudge={(d) => setClipStart(clip.id, clip.start + d)}
          />
        </PropRow>

        {capped && (
          <PropRow label="Object Beginning" animatable={false}>
            <ScrubPill
              value={clip.in ?? 0}
              min={0}
              max={clip.sourceDuration! - MIN_CLIP}
              speed={2}
              onStart={() => snapshot()}
              onInput={(v) => setClipIn(clip.id, v, false)}
              onCommit={(v) => setClipIn(clip.id, v, false)}
              format={formatTC}
              parse={parseTC}
              onEdit={(v) => setClipIn(clip.id, v)}
              nudge={STEP.sec}
              onNudge={(d) => setClipIn(clip.id, (clip.in ?? 0) + d)}
            />
          </PropRow>
        )}

        {/* Object Length is bounded (0–100% of its max) -> positional slider */}
        <PropRow label="Object Length" animatable={false}>
          <Slider
            value={clip.duration / lenMax}
            onStart={() => snapshot()}
            onInput={(v) => setClipDuration(clip.id, v * lenMax, false)}
            onCommit={(v) => setClipDuration(clip.id, v * lenMax, false)}
            format={(v) => formatTC(v * lenMax)}
            parse={parseTC}
            onEdit={(s) => setClipDuration(clip.id, s)}
            nudge={STEP.sec}
            onNudge={(d) => setClipDuration(clip.id, clip.duration + d)}
          />
        </PropRow>
        {capped && <div class="prop__hint">Max {formatTC(clip.sourceDuration!)}</div>}
      </Category>

      {hasVisual && (
        <Category label="Size">
          {SIZE_ROWS.map((r) => (
            <XformRow key={r.prop} clip={clip} {...r} def={r.prop === 'w' ? projW : projH} />
          ))}
          <label class="prop__row prop__row--check is-static">
            <span class="prop__label">Pixelated</span>
            <input
              type="checkbox"
              class="prop__check"
              checked={!!clip.pixelated}
              onChange={(e) => setClipPixelated(clip.id, (e.target as HTMLInputElement).checked)}
            />
          </label>
        </Category>
      )}

      {hasVisual && <RowGroup label="Transform" clip={clip} rows={XFORM_ROWS} />}
      {hasVisual && <RowGroup label="Crop" clip={clip} rows={CROP_ROWS} />}
      {hasVisual && (
        <Category label="Grade">
          {/* First, not last: it's the switch you reach for while judging the
              rest of the group, and it reads as the group's own on/off. */}
          <label class="prop__row prop__row--check is-static">
            <span class="prop__label">Bypass</span>
            <input
              type="checkbox"
              class="prop__check"
              checked={!!clip.gradeOff}
              onChange={(e) => setClipGradeOff(clip.id, (e.target as HTMLInputElement).checked)}
            />
          </label>
          {GRADE_ROWS.map((r) => (
            <XformRow key={r.prop} clip={clip} {...r} />
          ))}
          <CurveEditor clip={clip} />
          <LutPicker clip={clip} />
          {/* only once there's a look to dissolve — a mix slider with nothing
              to mix reads as a control that does nothing */}
          {clip.lutId && <XformRow clip={clip} {...LUT_MIX_ROW} />}
        </Category>
      )}
      {hasAudio && <RowGroup label="Audio Properties" clip={clip} rows={AUDIO_ROWS} />}
    </div>
  )
}

/**
 * Text: the words themselves, then the numeric style rows.
 *
 * The content box only existed in the Text tool, so a text object opened here
 * showed everything about its text except the text. While animating it edits the
 * content channel, same as the Text tool — hence reading through `editableText`
 * rather than off the static field, which doesn't move once keys exist.
 */
function TextGroup({ clip }: { clip: Clip }) {
  const animating = animatingClipId.value === clip.id
  const shown = animating ? editableText(clip, animPlayhead.value) : clip.text?.content ?? ''
  return (
    <Category label="Text">
      <label class="prop__row prop__row--text is-static">
        <span class="prop__label">Content</span>
        <textarea
          class="prop__text"
          rows={2}
          value={shown}
          onFocus={() => snapshot()}
          onInput={(e) => setTextContent(clip.id, (e.target as HTMLTextAreaElement).value, false)}
        />
      </label>
      {TEXT_ROWS.map((r) => (
        <XformRow key={r.prop} clip={clip} {...r} />
      ))}
    </Category>
  )
}

/** A whole category rendered from a row table. */
function RowGroup({ label, clip, rows }: { label: string; clip: Clip; rows: RowSpec[] }) {
  return (
    <Category label={label}>
      {rows.map((r) => (
        <XformRow key={r.prop} clip={clip} {...r} />
      ))}
    </Category>
  )
}

/** The same row across a multi-selection: reads the average, writes to all. */
function GroupRow({ clips, prop, label, min, max, speed, format, parse, nudge }: RowSpec & { clips: Clip[] }) {
  const read = animProp(prop)?.get ?? (() => 0)
  const val = clips.reduce((a, c) => a + read(c), 0) / clips.length
  const all = (v: number, snap = false) => clips.forEach((c) => applyProp(c.id, prop, v, snap))
  return (
    <PropRow label={label}>
      <ScrubPill
        value={val}
        min={min}
        max={max}
        speed={speed}
        onStart={() => snapshot()}
        onInput={all}
        onCommit={all}
        format={format}
        parse={parse}
        onEdit={(v) => all(v, true)}
        nudge={nudge}
        onNudge={(d) => clips.forEach((c) => applyProp(c.id, prop, read(c) + d, true))}
      />
    </PropRow>
  )
}

/**
 * Properties for a multi-selection / linked group. Shows only the categories the
 * objects share, and every edit fans out to all members. Location anchors to the
 * earliest object and moves the whole set; Length/Volume apply to each.
 */
function GroupProps({ ids }: { ids: string[] }) {
  const clips = ids
    .map((id) => findClip(id)?.clip)
    .filter((c): c is Clip => !!c)
  if (clips.length < 2) return <div class="prop__empty">No object selected</div>
  const linked = clips.every((c) => c.group && c.group === clips[0].group)
  const assetOf = (c: Clip) => assets.value.find((a) => a.id === c.assetId)
  const allAudio = clips.every((c) => {
    const a = assetOf(c)
    return a?.kind === 'audio' || a?.kind === 'video'
  })

  // topmost object's layer drives the group's Track Layer
  const topLayer = Math.min(...ids.map((id) => clipLayer(id)))

  // anchor = earliest start; editing Location shifts the whole group
  const anchor = clips.reduce((m, c) => Math.min(m, c.start), Infinity)
  const shiftGroup = (toStart: number, snap: boolean) => {
    const delta = toStart - anchor
    clips.forEach((c) => setClipStart(c.id, c.start + delta, snap))
  }

  // shared length (only when identical across the group)
  const durs = clips.map((c) => c.duration)
  const sameDur = durs.every((d) => Math.abs(d - durs[0]) < 1e-4)

  return (
    <div class="prop__list">
      <div class="prop__name">
        {clips.length} objects{linked ? ' · linked' : ''}
      </div>

      <Category label="Timeline Properties">
        <PropRow label="Track Layer" animatable={false}>
          <ScrubPill
            value={topLayer}
            min={1}
            max={timeline.value.tracks.length}
            speed={3}
            onStart={() => snapshot()}
            onInput={(v) => setGroupLayer(ids, v, false)}
            onCommit={(v) => setGroupLayer(ids, v, false)}
            format={(v) => `${Math.round(v)}`}
            parse={parseLayer}
            onEdit={(v) => setGroupLayer(ids, v)}
            nudge={STEP.layer}
            onNudge={(d) => setGroupLayer(ids, topLayer + d)}
          />
        </PropRow>
        <PropRow label="Group Location" animatable={false}>
          <ScrubPill
            value={anchor}
            min={0}
            speed={2}
            onStart={() => snapshot()}
            onInput={(v) => shiftGroup(v, false)}
            onCommit={(v) => shiftGroup(v, false)}
            format={formatTC}
            parse={parseTC}
            onEdit={(v) => shiftGroup(v, true)}
            nudge={STEP.sec}
            onNudge={(d) => shiftGroup(anchor + d, true)}
          />
        </PropRow>
        {sameDur && (
          <PropRow label="Object Length" animatable={false}>
            <ScrubPill
              value={durs[0]}
              min={MIN_CLIP}
              speed={2}
              onStart={() => snapshot()}
              onInput={(v) => clips.forEach((c) => setClipDuration(c.id, v, false))}
              onCommit={(v) => clips.forEach((c) => setClipDuration(c.id, v, false))}
              format={formatTC}
              parse={parseTC}
              onEdit={(v) => clips.forEach((c) => setClipDuration(c.id, v))}
              nudge={STEP.sec}
              onNudge={(d) => clips.forEach((c) => setClipDuration(c.id, c.duration + d))}
            />
          </PropRow>
        )}
      </Category>

      {allAudio && (
        <Category label="Audio Properties">
          {AUDIO_ROWS.map((r) => (
            <GroupRow key={r.prop} clips={clips} {...r} />
          ))}
        </Category>
      )}
    </div>
  )
}

export function PropertiesTool() {
  const sel = selectedClips.value
  const id = selectedClipId.value
  const found = id ? findClip(id) : null
  return (
    <div class="tool">
      <div class="tool__header">
        <span class="tool__title">Properties</span>
      </div>
      <div class="tool__body prop">
        {sel.length > 1 ? (
          <GroupProps ids={sel} />
        ) : found ? (
          <ObjectProps clip={found.clip} />
        ) : (
          <div class="prop__empty">No object selected</div>
        )}
      </div>
    </div>
  )
}
