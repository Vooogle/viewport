// Object animation: keyframes stored ON a clip, keyed by property id. Times are
// OBJECT-LOCAL seconds (0 = the object's start) so they stay glued to content
// when the object moves/trims on the timeline. Blockbench-style: each keyframe's
// interpolation governs the segment that FOLLOWS it.
import { signal, effect } from '@preact/signals'
import { timeline, findClip, mapClips, snapshot, playhead, playRange, pause, setClipVolume, setClipPitch, setClipPan, setClipXform, setClipGrade, setClipCurve, setClipLutMix, patchText, TEXT_DEFAULTS, XFORM_DEFAULTS, type Clip, type TextSpec } from './timeline'
import { currentProject } from '../project/project'
import { GRADE_PROPS, CURVE_ANIM, IDENTITY_CURVE, curveAnimId, curveChannelOf, lerpCurves, type GradeProp, type CurveChannel, type CurvePt, type CurveSpec } from '../render/grade'

export type Interp = 'linear' | 'smooth' | 'bezier' | 'step'
/** Every interpolation, in the order the key menu offers them. */
export const INTERPS: Interp[] = ['linear', 'smooth', 'bezier', 'step']

export interface Keyframe {
  /** stable id (for selection / copy across mutations) */
  id: string
  /** object-local seconds */
  t: number
  value: number
  /** easing of the segment AFTER this key */
  interp: Interp
  /** bezier left/incoming handle, offset from the key as [dt, dv] */
  hl?: [number, number]
  /** bezier right/outgoing handle, offset from the key as [dt, dv] */
  hr?: [number, number]
  /** text content at this key (only on the 'content' channel) */
  str?: string
  /** curve shape at this key (only on the curve channels) */
  pts?: CurvePt[]
}
let kidN = 0
const newKid = () => 'k' + Date.now().toString(36) + (kidN++).toString(36)
export interface AnimTrack {
  keys: Keyframe[]
  /** channel disabled — playback uses the static value */
  muted?: boolean
}

// --- animatable property registry ---
export interface AnimProp {
  id: string
  label: string
  category: string
  min: number
  /** upper bound, or undefined for unbounded (e.g. volume boost) */
  max?: number
  default: number
  /** current static value on a clip — the fallback + seed for a first key */
  get: (c: Clip) => number
  /** write the static value (used when NOT animating this object) */
  set: (clipId: string, value: number, snap: boolean) => void
  /**
   * Non-numeric channels. 'text' holds a string per key, 'curve' a set of curve
   * points. Both keep their value in their own field on the keyframe, so the
   * numeric UI (scrub pill, value graph) doesn't apply to either — there is no
   * number to put on an axis.
   */
  kind?: 'text' | 'curve'
  /**
   * Interpolations this property permits. Omitted means all of them.
   *
   * Not every value can be blended. Text content has no midpoint between two
   * strings, so anything but `step` has to invent one — which is where the
   * half-typed words came from. Restricting it at the property is better than
   * teaching each consumer to special-case the channel.
   */
  interps?: Interp[]
}

/** What `prop` allows. New keys take the first, which is its natural default. */
export function allowedInterps(prop: string): Interp[] {
  const list = animProp(prop)?.interps
  return list?.length ? list : INTERPS
}
/** Force an interpolation into what `prop` permits. Applied on write AND on
 *  read, so a project saved before a property was restricted still obeys it. */
export function lockInterp(prop: string, i: Interp): Interp {
  const ok = allowedInterps(prop)
  return ok.includes(i) ? i : ok[0]
}

// 3D transform props — each a plain numeric field on the clip, animatable
const xform = (id: string, label: string, min = -Infinity, max?: number): AnimProp => ({
  id,
  label,
  category: 'Transform',
  min,
  max,
  default: XFORM_DEFAULTS[id] ?? 0,
  get: (c) => (c as unknown as Record<string, number | undefined>)[id] ?? XFORM_DEFAULTS[id] ?? 0,
  set: (cid, v, snap) => setClipXform(cid, id, v, snap),
})

// a numeric TextSpec field (clip.text.<id>), animatable like a transform
const textProp = (id: keyof TextSpec, label: string, min = -Infinity, max?: number): AnimProp => ({
  id,
  label,
  category: 'Text',
  min,
  max,
  default: TEXT_DEFAULTS[id] as number,
  get: (c) => (c.text ? (c.text[id] as number) : (TEXT_DEFAULTS[id] as number)),
  set: (cid, v, snap) => patchText(cid, { [id]: v } as Partial<TextSpec>, snap),
})
// a nested numeric TextSpec field (bg.padding, outline.width, …)
const textNested = (
  id: string, label: string,
  get: (t: TextSpec) => number, patch: (t: TextSpec, v: number) => Partial<TextSpec>,
  min = -Infinity, max?: number,
): AnimProp => ({
  id,
  label,
  category: 'Text',
  min,
  max,
  default: 0,
  get: (c) => (c.text ? get(c.text) : 0),
  set: (cid, v, snap) => {
    const c = findClip(cid)?.clip
    if (c?.text) patchText(cid, patch(c.text, v), snap)
  },
})

// a grading scalar (clip.grade.<id>) — animatable like everything else, which
// is the point of putting them through the registry rather than the shader only
const gradeProp = (p: GradeProp): AnimProp => ({
  id: p.id,
  label: p.label,
  category: 'Grade',
  min: p.min,
  max: p.max,
  default: p.default,
  get: (c) => (c.grade?.[p.id] as number | undefined) ?? p.default,
  set: (cid, v, snap) => setClipGrade(cid, p.id, v, snap),
})

/**
 * A tone-curve channel (clip.curves.<ch>), keyframed as a shape.
 *
 * `get`/`set` are the numeric contract the registry is built on and mean
 * nothing here, so they return 0 and do nothing — the shape lives on
 * `Keyframe.pts` and moves through `applyCurve` / `sampleCurvePts`, the way
 * text content lives on `Keyframe.str`. Every interpolation is allowed: the
 * blend eases exactly like a number does, it just eases a line instead.
 */
const curveProp = (c: (typeof CURVE_ANIM)[number]): AnimProp => ({
  id: c.id,
  label: c.label,
  category: 'Grade',
  kind: 'curve',
  min: 0,
  max: 1,
  default: 0,
  get: () => 0,
  set: () => {},
})

export const ANIM_PROPS: AnimProp[] = [
  xform('x', 'Position X'),
  xform('y', 'Position Y'),
  xform('z', 'Position Z'),
  xform('rotX', 'Rotation X'),
  xform('rotY', 'Rotation Y'),
  xform('rotZ', 'Rotation Z'),
  xform('scale', 'Scale', 0),
  xform('opacity', 'Opacity', 0, 1),
  // size defaults to the project resolution (fills the frame) when unset
  { ...xform('w', 'Width', 1), category: 'Size', default: 0, get: (c) => c.w ?? currentProject.value?.width ?? 1920 },
  { ...xform('h', 'Height', 1), category: 'Size', default: 0, get: (c) => c.h ?? currentProject.value?.height ?? 1080 },
  { ...xform('cropL', 'Crop Left', 0, 1), category: 'Crop' },
  { ...xform('cropR', 'Crop Right', 0, 1), category: 'Crop' },
  { ...xform('cropT', 'Crop Top', 0, 1), category: 'Crop' },
  { ...xform('cropB', 'Crop Bottom', 0, 1), category: 'Crop' },
  {
    id: 'volume',
    label: 'Volume',
    category: 'Audio',
    min: 0,
    default: 1,
    get: (c) => c.volume ?? 1,
    set: (id, v, snap) => setClipVolume(id, v, snap),
  },
  {
    id: 'pitch',
    label: 'Pitch',
    category: 'Audio',
    min: -24,
    max: 24,
    default: 0,
    get: (c) => c.pitch ?? 0,
    set: (id, v, snap) => setClipPitch(id, v, snap),
  },
  {
    id: 'pan',
    label: 'Pan',
    category: 'Audio',
    min: -1,
    max: 1,
    default: 0,
    get: (c) => c.pan ?? 0,
    set: (id, v, snap) => setClipPan(id, v, snap),
  },
  // text content channel (string keyframes). Animating it = the reveal: between
  // keys, step pops to the new text, linear/smooth type the new letters in.
  // Locked to step: two strings have no midpoint, so any blend has to invent
  // one — which is what produced half-typed words between keys.
  { id: 'content', label: 'Text', category: 'Text', kind: 'text', interps: ['step'], min: 0, default: 0, get: () => 0, set: () => {} },
  // animatable numeric text-style props (live on clip.text.*)
  textProp('size', 'Font Size', 1),
  textProp('lineSpacing', 'Line Spacing'),
  textProp('letterSpacing', 'Letter Spacing'),
  textProp('curve', 'Curve', -100, 100),
  textProp('warp', 'Warp', -100, 100),
  textNested('bgPadding', 'BG Padding', (t) => t.bg.padding, (t, v) => ({ bg: { ...t.bg, padding: v } }), 0),
  textNested('bgRadius', 'BG Radius', (t) => t.bg.radius, (t, v) => ({ bg: { ...t.bg, radius: v } }), 0),
  textNested('outlineWidth', 'Outline Width', (t) => t.outline.width, (t, v) => ({ outline: { ...t.outline, width: v } }), 0),
  ...GRADE_PROPS.map(gradeProp),
  ...CURVE_ANIM.map(curveProp),
  // How much of the look applies — the one LUT control that's a number, and
  // animating it is how a look is dissolved in or out over a shot.
  {
    id: 'lutMix',
    label: 'LUT Mix',
    category: 'Grade',
    min: 0,
    max: 1,
    default: 1,
    get: (c) => c.lutMix ?? 1,
    set: (id, v, snap) => setClipLutMix(id, v, snap),
  },
]
// Indexed, not scanned. `sampleClip` calls this for every property it samples —
// roughly fourteen times per visible object per frame — and a linear find over
// the registry made export cost grow with the *registry* as well as the scene.
const PROP_BY_ID = new Map(ANIM_PROPS.map((p) => [p.id, p]))
export function animProp(id: string): AnimProp | undefined {
  return PROP_BY_ID.get(id)
}

// --- editor state (transient, not persisted on clips) ---
/** object currently open in the animation editor, or null */
export const animatingClipId = signal<string | null>(null)
/** local scrub time within the object, seconds */
export const animPlayhead = signal<number>(0)
/** strip (false) vs value-graph (true) view */
export const animGraph = signal<boolean>(false)
/** selected keyframe ids (multi-select: delete / copy / drag) */
export const selectedKeys = signal<string[]>([])

export function isKeySelected(id: string): boolean {
  return selectedKeys.value.includes(id)
}
export function selectKeys(ids: string[], additive = false) {
  selectedKeys.value = additive ? [...new Set([...selectedKeys.value, ...ids])] : ids
}
export function toggleKey(id: string) {
  const has = selectedKeys.value.includes(id)
  selectedKeys.value = has ? selectedKeys.value.filter((x) => x !== id) : [...selectedKeys.value, id]
}
export function clearKeySel() {
  selectedKeys.value = []
}

export function startAnimating(clipId: string) {
  const f = findClip(clipId)
  if (!f) return
  animatingClipId.value = clipId
  selectedKeys.value = []
  // scope playback to the object's span (loops within it while playing)
  playRange.value = { start: f.clip.start, end: f.clip.start + f.clip.duration }
  setAnimPlayhead(0)
}
export function stopAnimating() {
  pause()
  playRange.value = null
  animatingClipId.value = null
  selectedKeys.value = []
}

// while animating, keep the local anim playhead in sync with the real playhead
// (so transport playback moves the object + keyframe scrub together)
effect(() => {
  const id = animatingClipId.value
  if (!id) return
  const f = findClip(id)
  if (!f) return
  const local = playhead.value - f.clip.start
  const clamped = Math.max(0, Math.min(f.clip.duration, local))
  if (Math.abs(animPlayhead.value - clamped) > 1e-6) animPlayhead.value = clamped
})

/** Set the local anim playhead (clamped to the object length) AND move the real
 *  timeline playhead to the matching absolute time, so the viewport preview
 *  tracks the object at the scrubbed local time. */
export function setAnimPlayhead(local: number) {
  const id = animatingClipId.value
  const f = id ? findClip(id) : null
  if (!f) {
    animPlayhead.value = Math.max(0, local)
    return
  }
  const t = Math.max(0, Math.min(f.clip.duration, local))
  animPlayhead.value = t
  playhead.value = f.clip.start + t
}

/** Move the local anim playhead, clamped to the object length. */
export function animSeekBy(sec: number) {
  if (!animatingClipId.value) return
  setAnimPlayhead(animPlayhead.value + sec)
}
export function animFrameStep(dir: number) {
  animSeekBy(dir / (timeline.value.fps || 30))
}
/** Jump to the next/previous keyframe (any property) or an edge. */
export function animJumpKey(dir: number) {
  const id = animatingClipId.value
  const f = id ? findClip(id) : null
  if (!f) return
  const set = new Set<number>([0, f.clip.duration])
  for (const p in f.clip.anim ?? {}) for (const k of f.clip.anim![p].keys) set.add(k.t)
  const ts = [...set].sort((a, b) => a - b)
  const p = animPlayhead.value
  if (dir > 0) {
    const n = ts.find((x) => x > p + 1e-4)
    if (n != null) setAnimPlayhead(n)
  } else {
    const prev = [...ts].reverse().find((x) => x < p - 1e-4)
    setAnimPlayhead(prev ?? 0)
  }
}

// --- helpers ---
const byT = (a: Keyframe, b: Keyframe) => a.t - b.t

/** Write a clip's whole anim map (immutable patch). */
function patchAnim(clipId: string, anim: Record<string, AnimTrack> | undefined) {
  mapClips((c) => (c.id === clipId ? { ...c, anim } : c))
}
function mutateTrack(clipId: string, prop: string, fn: (keys: Keyframe[]) => Keyframe[]) {
  const f = findClip(clipId)
  if (!f) return
  const cur = f.clip.anim ?? {}
  const track = cur[prop] ?? { keys: [] }
  const keys = fn(track.keys.slice()).sort(byT)
  patchAnim(clipId, { ...cur, [prop]: { ...track, keys } })
}

// --- keyframe ops (each snapshots for undo) ---
/** Add (or replace at same time) a keyframe. Returns nothing; selection set by caller. */
export function addKeyframe(clipId: string, prop: string, t: number, value: number, interp: Interp = 'linear', snap = true): string {
  if (snap) snapshot()
  interp = lockInterp(prop, interp)
  const p = animProp(prop)
  const clip = findClip(clipId)?.clip
  const baseVal = p && clip ? p.get(clip) : 0
  let id = ''
  mutateTrack(clipId, prop, (keys) => {
    // first-ever keyframe past the start: reveal the current static value as a
    // keyframe at t=0, so animating an already-set property starts from it
    if (!keys.length && Math.abs(t) > 1e-4) {
      // the seed has to carry the channel's own payload — a curve or text
      // channel seeded with a number holds nothing, and samples as "unset"
      const ch = clip ? curveChannelOf(prop) : undefined
      const seed: Keyframe = { id: newKid(), t: 0, value: baseVal, interp: 'linear' }
      if (ch) seed.pts = clip!.curves?.[ch] ?? IDENTITY_CURVE
      else if (p?.kind === 'text') seed.str = clip?.text?.content ?? ''
      keys.push(seed)
    }
    const at = keys.findIndex((k) => Math.abs(k.t - t) < 1e-4)
    // replace at the same time (keep its interp) — keys can't overlap
    if (at >= 0) {
      keys[at] = { ...keys[at], value }
      id = keys[at].id
    } else {
      id = newKid()
      keys.push({ id, t, value, interp })
    }
    return keys
  })
  return id
}

/** Set an animatable property: keyframe at the playhead while animating this
 *  object, else the plain static value. This is what the Properties tool calls. */
/**
 * Set a property, writing wherever that property is actually read from.
 *
 * An animated property is read from its track — `sampleAt` prefers the keys over
 * the static field whenever the track has any. So for a property that already
 * has keyframes, writing the static field puts the value somewhere nothing ever
 * reads: the edit silently does nothing, in the preview and in the export alike,
 * and only starts working once the animation editor happens to be open. Which
 * branch this takes therefore has to follow the DATA, not the open editor.
 */
export function applyProp(clipId: string, prop: string, value: number, snap = true) {
  const p = animProp(prop)
  if (!p) return
  const clip = findClip(clipId)?.clip
  if (!clip) return
  const keys = clip.anim?.[prop]?.keys ?? []
  const editing = animatingClipId.value === clipId
  if (!editing && !keys.length) {
    p.set(clipId, value, snap) // not animated: the static field is what's read
    return
  }
  // The editor drives its own local playhead; outside it, object-local time is
  // where the main playhead falls within the clip.
  const t = editing
    ? animPlayhead.value
    : Math.max(0, Math.min(clip.duration, playhead.value - clip.start))
  const at = keys.findIndex((k) => Math.abs(k.t - t) < 1e-4)
  if (at >= 0) setKeyframeValue(clipId, prop, at, value, snap)
  else addKeyframe(clipId, prop, t, value, 'linear', snap)
}
export function removeKeyframe(clipId: string, prop: string, index: number) {
  snapshot()
  mutateTrack(clipId, prop, (keys) => keys.filter((_, i) => i !== index))
}

// --- text CONTENT channel (string keyframes; animating it = the reveal) ---
/** Set the text content: keyframes it at the playhead while animating this
 *  object (so typing new text after a key reveals the added letters), else the
 *  plain static content. Called by the Text tool textarea. */
export function setTextContent(clipId: string, str: string, snap = true) {
  const clip = findClip(clipId)?.clip
  if (!clip?.text) return
  if (animatingClipId.value === clipId) {
    if (snap) snapshot()
    const t = animPlayhead.value
    const base = clip.text.content
    mutateTrack(clipId, 'content', (keys) => {
      // seed the pre-existing content at t=0 so the first typed key reveals from it
      if (!keys.length && Math.abs(t) > 1e-4)
        keys.push({ id: newKid(), t: 0, value: 0, interp: lockInterp('content', 'linear'), str: base })
      const at = keys.findIndex((k) => Math.abs(k.t - t) < 1e-4)
      if (at >= 0) keys[at] = { ...keys[at], str }
      else keys.push({ id: newKid(), t, value: 0, interp: lockInterp('content', 'linear'), str })
      return keys
    })
  } else {
    patchText(clipId, { content: str }, snap)
  }
}
/** Add (or replace at the same time) a content keyframe. */
export function addContentKeyAt(clipId: string, t: number, str: string): string {
  snapshot()
  let id = ''
  mutateTrack(clipId, 'content', (keys) => {
    const at = keys.findIndex((k) => Math.abs(k.t - t) < 1e-4)
    if (at >= 0) {
      keys[at] = { ...keys[at], str }
      id = keys[at].id
    } else {
      id = newKid()
      keys.push({ id, t, value: 0, interp: lockInterp('content', 'linear'), str })
    }
    return keys
  })
  return id
}
/** Set the string on a content keyframe (anim editor edit). */
export function setKeyframeText(clipId: string, index: number, str: string, snap = true) {
  if (snap) snapshot()
  mutateTrack(clipId, 'content', (keys) => {
    if (keys[index]) keys[index] = { ...keys[index], str }
    return keys
  })
}
/** Sample the (possibly animated) text content at a local time, with reveal. */
/**
 * What a text box should display at `tLocal` — the counterpart of `sampleClip`
 * for the numeric fields.
 *
 * Park on a keyframe and you get that keyframe's own text, because that is what
 * typing will edit. Park between keys and you get the revealed text, which is
 * what a new key would be seeded from. Binding a box to `clip.text.content`
 * instead is wrong while animating: the content channel holds the strings and
 * the static field never moves, so every keystroke rendered the old value back
 * over what was just typed.
 */
export function editableText(clip: Clip, tLocal: number): string {
  const k = clip.anim?.content?.keys.find((x) => Math.abs(x.t - tLocal) < 1e-4)
  return k?.str ?? sampleText(clip, tLocal)
}

export function sampleText(clip: Clip, tLocal: number): string {
  const track = clip.anim?.content
  const keys = track && !track.muted ? track.keys : null
  const staticC = clip.text?.content ?? ''
  if (!keys || !keys.length) return staticC
  if (tLocal <= keys[0].t) return keys[0].str ?? ''
  const last = keys[keys.length - 1]
  if (tLocal >= last.t) return last.str ?? ''
  let i = 0
  while (i < keys.length - 1 && keys[i + 1].t <= tLocal) i++
  const a = keys[i]
  const b = keys[i + 1]
  const A = a.str ?? ''
  const B = b.str ?? ''
  // Through the lock, so content saved before the channel was restricted still
  // behaves. With `content` locked to step this always holds A and pops at b.t;
  // the typing code below comes back if that lock is ever widened.
  const ai = lockInterp('content', a.interp)
  const bi = lockInterp('content', b.interp)
  // step (either endpoint) = hold A across the segment, pop to B at b.t
  if (ai === 'step' || bi === 'step') return A
  const span = b.t - a.t || 1e-6
  let f = (tLocal - a.t) / span
  // The reveal RATE follows the keyframe's own easing, same as a numeric
  // channel: smooth eases in and out, bezier follows the handles, linear types
  // evenly. Bezier used to fall through to linear here, so setting it on a text
  // key changed nothing.
  if (ai === 'bezier' || bi === 'bezier') {
    const hr = ai === 'bezier' ? a.hr ?? [span / 3, 0] : [span / 3, 0]
    const hl = bi === 'bezier' ? b.hl ?? [-span / 3, 0] : [-span / 3, 0]
    // The content channel has no value axis, so only the handles' TIME offsets
    // mean anything; the curve runs 0→1 over the segment.
    f = bezierYAtX(tLocal, [a.t, 0], [a.t + hr[0], 0], [b.t + hl[0], 1], [b.t, 1])
  } else if (ai === 'smooth' || bi === 'smooth') f = smoothstep(f)
  f = Math.max(0, Math.min(1, f))
  // Type from A's length toward B's length, showing B's prefix: appended letters
  // reveal, and other edits retype or backspace into place.
  //
  // Note this is a LENGTH interpolation, so two strings of the same size swap on
  // the spot rather than transitioning — a same-length replacement is a cut, not
  // a reveal. Deliberate: it keeps the common case (typing text on) clean.
  const n = Math.round(A.length + (B.length - A.length) * f)
  return B.slice(0, Math.max(0, n))
}
// --- tone CURVE channels (point-set keyframes; animating one moves the handles) ---

/**
 * How far through an A→B segment `t` is, 0..1, with the segment's own easing.
 *
 * The numeric sampler can't be reused for this: it eases by interpolating the
 * VALUES, and a curve has no value — so the easing is pulled out here as a plain
 * factor and handed to whatever knows how to blend the payload. Same rules as
 * everywhere else: either endpoint's interp counts, step holds A.
 */
function segEase(a: Keyframe, b: Keyframe, t: number): number {
  if (a.interp === 'step' || b.interp === 'step') return 0
  const span = b.t - a.t || 1e-6
  if (a.interp === 'bezier' || b.interp === 'bezier') {
    const hr = a.interp === 'bezier' ? a.hr ?? [span / 3, 0] : [span / 3, 0]
    const hl = b.interp === 'bezier' ? b.hl ?? [-span / 3, 0] : [-span / 3, 0]
    // no value axis here either — the unit curve runs 0→1 across the segment and
    // only the handles' TIME offsets shape it
    return Math.max(0, Math.min(1, bezierYAtX(t, [a.t, 0], [a.t + hr[0], 0], [b.t + hl[0], 1], [b.t, 1])))
  }
  const f = (t - a.t) / span
  return a.interp === 'smooth' || b.interp === 'smooth' ? smoothstep(f) : f
}

/** The shape a curve channel has at object-local time `t`. */
export function sampleCurvePts(clip: Clip, ch: CurveChannel, tLocal: number): CurvePt[] {
  const stat = clip.curves?.[ch] ?? IDENTITY_CURVE
  const track = clip.anim?.[curveAnimId(ch)]
  const keys = track && !track.muted ? track.keys : null
  if (!keys || !keys.length) return stat
  if (tLocal <= keys[0].t) return keys[0].pts ?? stat
  const last = keys[keys.length - 1]
  if (tLocal >= last.t) return last.pts ?? stat
  let i = 0
  while (i < keys.length - 1 && keys[i + 1].t <= tLocal) i++
  const a = keys[i]
  const b = keys[i + 1]
  return lerpCurves(a.pts ?? stat, b.pts ?? stat, segEase(a, b, tLocal))
}

/**
 * The whole curve set at a local time — what the renderer bakes.
 *
 * Returns the object's own `curves` untouched when nothing on it is animated,
 * so the bake cache key stays identical frame to frame and a static curve costs
 * exactly what it did before curves could move.
 */
export function sampleCurveSpec(clip: Clip, tLocal: number): CurveSpec {
  const animated = clip.anim && CURVE_ANIM.some((c) => clip.anim![c.id]?.keys.length)
  if (!animated) return clip.curves ?? {}
  const out: CurveSpec = { ...(clip.curves ?? {}) }
  for (const c of CURVE_ANIM) out[c.ch] = sampleCurvePts(clip, c.ch, tLocal)
  return out
}

/**
 * What the curve EDITOR should show and edit at `tLocal`.
 *
 * Parked on a keyframe you get that keyframe's own points, because those are
 * what dragging a handle will edit. Between keys you get the blend, which is
 * what a new key would be seeded from — the same rule `editableText` follows,
 * and the reason a handle dragged between two keys doesn't jump first.
 */
export function editableCurve(clip: Clip, ch: CurveChannel, tLocal: number): CurvePt[] {
  const k = clip.anim?.[curveAnimId(ch)]?.keys.find((x) => Math.abs(x.t - tLocal) < 1e-4)
  return k?.pts ?? sampleCurvePts(clip, ch, tLocal)
}

/** Object-local time for a clip: the editor's playhead, or where the transport
 *  falls inside it. */
function localTime(clip: Clip): number {
  return animatingClipId.value === clip.id
    ? animPlayhead.value
    : Math.max(0, Math.min(clip.duration, playhead.value - clip.start))
}

/**
 * Write a curve channel, wherever that channel is actually read from.
 *
 * The curve counterpart of `applyProp`, and it follows the same rule for the
 * same reason: once a channel has keys, the static `clip.curves` field is dead
 * storage, so writing there would drop the edit on the floor.
 */
export function applyCurve(clipId: string, ch: CurveChannel, pts: CurvePt[], snap = true) {
  const clip = findClip(clipId)?.clip
  if (!clip) return
  const prop = curveAnimId(ch)
  const keys = clip.anim?.[prop]?.keys ?? []
  const editing = animatingClipId.value === clipId
  if (!editing && !keys.length) {
    setClipCurve(clipId, ch, pts, snap)
    return
  }
  if (snap) snapshot()
  const t = localTime(clip)
  const base = clip.curves?.[ch] ?? IDENTITY_CURVE
  mutateTrack(clipId, prop, (ks) => {
    // first key past the start: seed the shape it had at t=0, so animating a
    // curve that was already drawn starts from that drawing
    if (!ks.length && Math.abs(t) > 1e-4)
      ks.push({ id: newKid(), t: 0, value: 0, interp: 'linear', pts: base })
    const at = ks.findIndex((k) => Math.abs(k.t - t) < 1e-4)
    if (at >= 0) ks[at] = { ...ks[at], pts }
    else ks.push({ id: newKid(), t, value: 0, interp: 'linear', pts })
    return ks
  })
}

/** Add (or replace at the same time) a curve keyframe holding the shape at `t`. */
export function addCurveKeyAt(clipId: string, prop: string, t: number): string {
  const ch = curveChannelOf(prop)
  const clip = findClip(clipId)?.clip
  if (!ch || !clip) return ''
  snapshot()
  const pts = sampleCurvePts(clip, ch, t)
  let id = ''
  mutateTrack(clipId, prop, (keys) => {
    const at = keys.findIndex((k) => Math.abs(k.t - t) < 1e-4)
    if (at >= 0) {
      keys[at] = { ...keys[at], pts }
      id = keys[at].id
    } else {
      id = newKid()
      keys.push({ id, t, value: 0, interp: 'linear', pts })
    }
    return keys
  })
  return id
}

/**
 * Add a keyframe on any channel, holding whatever that channel shows at `t`.
 *
 * The lane and the "+" button both need this, and both used to call the numeric
 * `addKeyframe` with a `content` special case bolted on beside it. A third kind
 * of channel is exactly the point at which that stops scaling, so the dispatch
 * lives here with the channels rather than in the view.
 */
export function addKeyAt(clipId: string, prop: string, t: number): string {
  const clip = findClip(clipId)?.clip
  if (!clip) return ''
  const kind = animProp(prop)?.kind
  if (kind === 'curve') return addCurveKeyAt(clipId, prop, t)
  if (kind === 'text') return addContentKeyAt(clipId, t, sampleText(clip, t))
  return addKeyframe(clipId, prop, t, sampleClip(clip, prop, t))
}

export function moveKeyframe(clipId: string, prop: string, index: number, t: number, snap = true) {
  if (snap) snapshot()
  const dur = findClip(clipId)?.clip.duration ?? Infinity
  const EPS = 1e-3
  mutateTrack(clipId, prop, (keys) => {
    const k = keys[index]
    if (!k) return keys
    // keys can't overlap: clamp between the neighbors (by current time order)
    let lo = 0
    let hi = dur
    for (let i = 0; i < keys.length; i++) {
      if (i === index) continue
      if (keys[i].t <= k.t && keys[i].t + EPS > lo) lo = keys[i].t + EPS
      if (keys[i].t >= k.t && keys[i].t - EPS < hi) hi = keys[i].t - EPS
    }
    keys[index] = { ...k, t: Math.max(lo, Math.min(hi, Math.max(0, Math.min(dur, t)))) }
    return keys
  })
}
export function setKeyframeValue(clipId: string, prop: string, index: number, value: number, snap = true) {
  if (snap) snapshot()
  const p = animProp(prop)
  const v = p ? Math.max(p.min, p.max != null ? Math.min(p.max, value) : value) : value
  mutateTrack(clipId, prop, (keys) => {
    if (keys[index]) keys[index] = { ...keys[index], value: v }
    return keys
  })
}
export function setKeyframeInterp(clipId: string, prop: string, index: number, interp: Interp) {
  interp = lockInterp(prop, interp)
  snapshot()
  mutateTrack(clipId, prop, (keys) => {
    if (keys[index]) keys[index] = { ...keys[index], interp }
    return keys
  })
}
export function setKeyframeHandles(clipId: string, prop: string, index: number, hl?: [number, number], hr?: [number, number]) {
  mutateTrack(clipId, prop, (keys) => {
    if (keys[index]) keys[index] = { ...keys[index], hl: hl ?? keys[index].hl, hr: hr ?? keys[index].hr }
    return keys
  })
}
/** Set interpolation on every selected keyframe, one undo step. */
export function setSelectedInterp(clipId: string, interp: Interp) {
  const sel = new Set(selectedKeys.value)
  const f = findClip(clipId)
  if (!sel.size || !f?.clip.anim) return
  snapshot()
  const next: Record<string, AnimTrack> = {}
  for (const p in f.clip.anim) {
    // per property: one selection can span channels with different rules
    const locked = lockInterp(p, interp)
    const keys = f.clip.anim[p].keys.map((k) => (sel.has(k.id) ? { ...k, interp: locked } : k))
    next[p] = { ...f.clip.anim[p], keys }
  }
  patchAnim(clipId, next)
}

/** Remove every selected keyframe (across all properties), one undo step. */
export function removeSelectedKeys(clipId: string) {
  const sel = new Set(selectedKeys.value)
  const f = findClip(clipId)
  if (!sel.size || !f?.clip.anim) return
  snapshot()
  const next: Record<string, AnimTrack> = {}
  for (const p in f.clip.anim) {
    const keys = f.clip.anim[p].keys.filter((k) => !sel.has(k.id))
    next[p] = { ...f.clip.anim[p], keys }
  }
  patchAnim(clipId, next)
  clearKeySel()
}

// --- keyframe clipboard ---
interface KeyItem {
  prop: string
  t: number
  value: number
  interp: Interp
  hl?: [number, number]
  hr?: [number, number]
  /** payload of a non-numeric channel — a copied key of one is empty without it */
  str?: string
  pts?: CurvePt[]
}
let keyClip: KeyItem[] = []

export function copySelectedKeys(clipId: string) {
  const sel = new Set(selectedKeys.value)
  const f = findClip(clipId)
  if (!sel.size || !f?.clip.anim) return
  const items: KeyItem[] = []
  for (const p in f.clip.anim)
    for (const k of f.clip.anim[p].keys)
      if (sel.has(k.id))
        items.push({ prop: p, t: k.t, value: k.value, interp: k.interp, hl: k.hl, hr: k.hr, str: k.str, pts: k.pts })
  if (items.length) keyClip = items
}
/** Paste copied keys so the earliest lands at `atT` (the playhead). */
export function pasteKeys(clipId: string, atT: number) {
  if (!keyClip.length) return
  const minT = Math.min(...keyClip.map((k) => k.t))
  const shift = atT - minT
  snapshot()
  const ids: string[] = []
  for (const it of keyClip) {
    const id = addKeyframe(clipId, it.prop, it.t + shift, it.value, it.interp, false)
    // preserve handles, and whatever the channel actually carries — a pasted
    // text or curve key with no payload is a key that renders nothing
    if (it.str != null || it.pts)
      mutateTrack(clipId, it.prop, (keys) => {
        const at = keys.findIndex((k) => k.id === id)
        if (at >= 0) keys[at] = { ...keys[at], str: it.str, pts: it.pts }
        return keys
      })
    const f = findClip(clipId)
    const idx = f?.clip.anim?.[it.prop]?.keys.findIndex((k) => k.id === id) ?? -1
    if (idx >= 0 && (it.hl || it.hr)) setKeyframeHandles(clipId, it.prop, idx, it.hl, it.hr)
    ids.push(id)
  }
  selectedKeys.value = ids
}

/** Remove a property's whole track. */
export function removeAnimProp(clipId: string, prop: string) {
  const f = findClip(clipId)
  if (!f?.clip.anim) return
  snapshot()
  const next = { ...f.clip.anim }
  delete next[prop]
  patchAnim(clipId, Object.keys(next).length ? next : undefined)
}
/** Start animating a property: seeds a keyframe at t=0 with the current static
 *  value, so the lane reveals the object's set value as its starting keyframe. */
export function addAnimProp(clipId: string, prop: string) {
  const f = findClip(clipId)
  if (!f || f.clip.anim?.[prop]) return
  snapshot()
  const p = animProp(prop)
  const ch = curveChannelOf(prop)
  const seed: Keyframe =
    p?.kind === 'text'
      ? { id: newKid(), t: 0, value: 0, interp: 'linear', str: f.clip.text?.content ?? '' }
      : ch
        ? { id: newKid(), t: 0, value: 0, interp: 'linear', pts: f.clip.curves?.[ch] ?? IDENTITY_CURVE }
        : { id: newKid(), t: 0, value: p ? p.get(f.clip) : 0, interp: 'linear' }
  patchAnim(clipId, { ...(f.clip.anim ?? {}), [prop]: { keys: [seed] } })
}
export function toggleAnimMuted(clipId: string, prop: string) {
  const f = findClip(clipId)
  const track = f?.clip.anim?.[prop]
  if (!f || !track) return
  patchAnim(clipId, { ...f.clip.anim!, [prop]: { ...track, muted: !track.muted } })
}

/** Clamp every key into [0, duration] — used after a trim shortens the object. */
export function clampAnim(anim: Record<string, AnimTrack> | undefined, duration: number): Record<string, AnimTrack> | undefined {
  if (!anim) return anim
  const out: Record<string, AnimTrack> = {}
  for (const prop in anim) {
    const keys = anim[prop].keys.map((k) => ({ ...k, t: Math.max(0, Math.min(duration, k.t)) })).sort(byT)
    out[prop] = { ...anim[prop], keys }
  }
  return out
}

// --- sampling ---
function smoothstep(f: number): number {
  return f * f * (3 - 2 * f)
}
// cubic bezier y at parametric solve for x; P0..P3 in (t,value)
function bezierYAtX(x: number, p0: number[], p1: number[], p2: number[], p3: number[]): number {
  // solve for u in [0,1] where X(u)=x (Newton + bisection fallback)
  const bx = (u: number) =>
    (1 - u) ** 3 * p0[0] + 3 * (1 - u) ** 2 * u * p1[0] + 3 * (1 - u) * u * u * p2[0] + u ** 3 * p3[0]
  const by = (u: number) =>
    (1 - u) ** 3 * p0[1] + 3 * (1 - u) ** 2 * u * p1[1] + 3 * (1 - u) * u * u * p2[1] + u ** 3 * p3[1]
  let lo = 0
  let hi = 1
  let u = 0.5
  for (let i = 0; i < 24; i++) {
    const cx = bx(u)
    if (Math.abs(cx - x) < 1e-4) break
    if (cx < x) lo = u
    else hi = u
    u = (lo + hi) / 2
  }
  return by(u)
}

/** Sample a property's animated value at object-local time `t`. */
export function sampleAt(track: AnimTrack | undefined, t: number, fallback: number): number {
  const keys = track && !track.muted ? track.keys : null
  if (!keys || !keys.length) return fallback
  if (t <= keys[0].t) return keys[0].value
  const last = keys[keys.length - 1]
  if (t >= last.t) return last.value
  let i = 0
  while (i < keys.length - 1 && keys[i + 1].t <= t) i++
  const a = keys[i]
  const b = keys[i + 1]
  const span = b.t - a.t || 1e-6
  const f = (t - a.t) / span
  // The A→B segment honours EITHER endpoint's easing (so setting the interp on
  // the destination keyframe works too — consistent with how bezier behaves).
  // step (hold) wins: hold A's value across the segment, pop at B.
  if (a.interp === 'step' || b.interp === 'step') return a.value
  // bezier: each side uses its own handle (auto if that side isn't bezier), so
  // B's incoming (left) handle shapes the A→B curve
  if (a.interp === 'bezier' || b.interp === 'bezier') {
    const hr = a.interp === 'bezier' ? a.hr ?? [span / 3, 0] : [span / 3, 0]
    const hl = b.interp === 'bezier' ? b.hl ?? [-span / 3, 0] : [-span / 3, 0]
    return bezierYAtX(t, [a.t, a.value], [a.t + hr[0], a.value + hr[1]], [b.t + hl[0], b.value + hl[1]], [b.t, b.value])
  }
  if (a.interp === 'smooth' || b.interp === 'smooth') return a.value + (b.value - a.value) * smoothstep(f)
  return a.value + (b.value - a.value) * f // linear
}

/** Convenience: sample a clip's property (static value if not animated). */
export function sampleClip(clip: Clip, prop: string, tLocal: number): number {
  const p = animProp(prop)
  const fallback = p ? p.get(clip) : 0
  return sampleAt(clip.anim?.[prop], tLocal, fallback)
}
