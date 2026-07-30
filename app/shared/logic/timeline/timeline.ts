// Timeline data (JSON-serializable) + minimal ruler settings.
// Time values are in SECONDS; frames derived via fps for display.
import { signal } from '@preact/signals'
import { currentProject } from '../project/project'
import { GRADE_PROPS } from '../render/grade'

// A clip = an "Object": something with a beginning and end on a track.
export interface Clip {
  id: string
  assetId?: string
  /** where it begins on the timeline, seconds */
  start: number
  /** how long it shows on screen, seconds */
  duration: number
  /** in-point: seconds into the source media it starts from (video/audio) */
  in?: number
  /** natural length of the source, seconds. undefined = stretchable (images) */
  sourceDuration?: number
  /** which source audio channel this object plays (0-based). undefined = all/mixed */
  channel?: number
  /** audio gain, 1 = 100%. Unlocked above 1 (boost). */
  volume?: number
  /** pitch shift in semitones, 0 = original */
  pitch?: number
  /** stereo pan, -1 = full left, 0 = center, 1 = full right */
  pan?: number
  /** object that plays only the source audio (no video), e.g. detached audio */
  audioOnly?: boolean
  /** link id — objects sharing it are grouped: they select and move together */
  group?: string
  /** keyframe animation, keyed by property id (object-local times). See anim.ts */
  anim?: Record<string, import('./anim').AnimTrack>
  // --- 3D transform (visual objects are textured planes in the fixed-camera
  // scene). Position in project pixels from centre, rotation in degrees. ---
  x?: number
  y?: number
  z?: number
  rotX?: number
  rotY?: number
  rotZ?: number
  /** uniform scale, 1 = fills the frame */
  scale?: number
  /** 0..1 */
  opacity?: number
  /** crop fractions 0..1 cut off each edge of the plane */
  cropL?: number
  cropR?: number
  cropT?: number
  cropB?: number
  /** plane size in project px (defaults to the media's natural size, fit to frame) */
  w?: number
  h?: number
  /** nearest-neighbour scaling (crisp pixel art) instead of smooth interpolation */
  pixelated?: boolean
  /** colour grading. Absent = never graded, and the renderer skips it whole. */
  grade?: import('../render/grade').GradeSpec
  /** grading bypassed — the values stay, they just don't apply (A/B compare) */
  gradeOff?: boolean
  /** tone curves (master + per channel). Absent = identity. */
  curves?: import('../render/grade').CurveSpec
  /** which loaded 3D LUT this object looks through, if any */
  lutId?: string
  /** how much of the LUT to apply, 0..1 (animatable) */
  lutMix?: number
  /** user-facing object name (defaults derived from the asset/text) */
  name?: string
  /** present on TEXT objects (no media asset) — the text content + styling */
  text?: TextSpec
}

export type TextAlign = 'left' | 'center' | 'right' | 'justify'
/** A text object's content + styling. Rendered as a 3D plane in the viewport. */
export interface TextSpec {
  content: string
  font: string // css font-family
  fill: string // text colour
  size: number // px in project space
  lineSpacing: number // added to line-height, px
  letterSpacing: number // px
  align: TextAlign
  bold: boolean
  italic: boolean
  underline: boolean
  caps: boolean
  /** arc the text along a curve; -100..100 (0 = straight) */
  curve: number
  /** horizontal warp / skew amount, -100..100 (0 = none) */
  warp: number
  bg: { on: boolean; color: string; padding: number; radius: number }
  outline: { on: boolean; color: string; width: number }
}

export const TEXT_DEFAULTS: TextSpec = {
  content: 'Text',
  font: 'DM Sans',
  fill: '#ffffff',
  size: 96,
  lineSpacing: 0,
  letterSpacing: 0,
  align: 'center',
  bold: false,
  italic: false,
  underline: false,
  caps: false,
  curve: 0,
  warp: 0,
  bg: { on: false, color: '#000000', padding: 12, radius: 6 },
  outline: { on: false, color: '#000000', width: 4 },
}
/**
 * Does this object make no sound?
 *
 * Volume alone decides. There used to be a separate `muted` flag, which
 * detaching audio set — but a boolean that overrides an animatable property
 * makes that property meaningless: a muted object ignored its own volume
 * keyframes. Silence is volume 0, which is a value you can also animate to and
 * away from.
 *
 * An animated volume is never silent as far as this is concerned, since the
 * static value says nothing about what the curve does.
 */
export function isSilent(c: Clip): boolean {
  return !c.anim?.volume && (c.volume ?? 1) <= 0
}

/** true if a clip is a text object (synthetic, no media asset). */
export function isText(clip: Clip): boolean {
  return clip.text != null
}

/** default transform value for a given key. */
export const XFORM_DEFAULTS: Record<string, number> = {
  x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0, scale: 1, opacity: 1,
  cropL: 0, cropR: 0, cropT: 0, cropB: 0,
}
export interface Track {
  id: string
  name: string
  /** stable creation number (1,2,3…) — shown in the name, never changes on reorder */
  num: number
  kind: 'video' | 'audio'
  /** row height, px */
  height: number
  clips: Clip[]
}
export interface TimelineData {
  fps: number
  duration: number
  tracks: Track[]
}

export const timeline = signal<TimelineData>({ fps: 30, duration: 60, tracks: [] })

export type RulerUnit = 'seconds' | 'frames'
/** display unit for the ruler */
export const rulerUnit = signal<RulerUnit>('seconds')
/** step between labeled segments, in the current unit (1 => 0,1,2; 2 => 0,2,4) */
export const rulerStep = signal<number>(1)
/** playhead position, seconds */
export const playhead = signal<number>(0)

/** fixed pixels between ruler segments — never changes (no zoom) */
export const SEGMENT_PX = 64
/** default track row height, px */
export const TRACK_H = 48
export const TRACK_MIN_H = 28

/** Stable per-track letter from its creation number (1→A, 2→B, …). */
export function trackLetter(num: number): string {
  let n = Math.max(1, num) - 1
  let s = ''
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

/** Add a track; returns its id. `at` inserts at an index (default: end/bottom). */
export function addTrack(kind: 'video' | 'audio' = 'video', snap = true, at?: number): string {
  if (snap) snapshot()
  // stable number: one past the highest ever used (survives reorder/removal).
  // Shown as a letter (Track A, B, C…) that stays with the track.
  const num = timeline.value.tracks.reduce((m, t) => Math.max(m, t.num ?? 0), 0) + 1
  const id = 'track_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  const t: Track = { id, name: `Track ${trackLetter(num)}`, num, kind, height: TRACK_H, clips: [] }
  const tracks = [...timeline.value.tracks]
  tracks.splice(at ?? tracks.length, 0, t)
  timeline.value = { ...timeline.value, tracks }
  return id
}

export function removeTrack(id: string) {
  snapshot()
  timeline.value = { ...timeline.value, tracks: timeline.value.tracks.filter((t) => t.id !== id) }
}

/** Reorder a track to a new index. Tracks earlier in the array render on top. */
export function moveTrack(id: string, toIndex: number, snap = true) {
  const tracks = [...timeline.value.tracks]
  const from = tracks.findIndex((t) => t.id === id)
  if (from < 0) return
  const clamped = Math.max(0, Math.min(tracks.length - 1, toIndex))
  if (from === clamped) return
  if (snap) snapshot()
  const [moved] = tracks.splice(from, 1)
  tracks.splice(clamped, 0, moved)
  timeline.value = { ...timeline.value, tracks }
}

export function renameTrack(id: string, name: string) {
  snapshot()
  timeline.value = {
    ...timeline.value,
    tracks: timeline.value.tracks.map((t) => (t.id === id ? { ...t, name } : t)),
  }
}

// --- playhead seeking ---
function fps(): number {
  return currentProject.value?.fps ?? timeline.value.fps
}
export function seekBy(sec: number) {
  playhead.value = Math.max(0, playhead.value + sec)
}
export function frameStep(dir: number) {
  seekBy(dir / fps())
}

// --- playback ---
/** furthest object end, seconds (the play-out length). */
export function contentEnd(): number {
  let e = 0
  for (const t of timeline.value.tracks) for (const c of t.clips) e = Math.max(e, c.start + c.duration)
  return e
}

export const playing = signal(false)
// when set (animation editor), playback is scoped to this absolute time window
// (the object's span) and loops/stops within it instead of the whole timeline
export const playRange = signal<{ start: number; end: number } | null>(null)

// Media that isn't ready to show the current frame (seeking, or still
// buffering). The playhead holds while this is non-empty, so the clock can't run
// ahead of a picture that's frozen — a seek to a distant keyframe would
// otherwise scroll the timeline over several seconds of stalled video.
const stalled = new Set<string>()
/** true while any visible source is still catching up */
export const mediaStalled = signal(false)
export function setMediaStalled(id: string, isStalled: boolean) {
  const had = stalled.has(id)
  if (isStalled === had) return
  if (isStalled) stalled.add(id)
  else stalled.delete(id)
  mediaStalled.value = stalled.size > 0
}
/** forget a source (unmounted / removed) so it can't stall playback forever */
export function clearMediaStall(id: string) {
  setMediaStalled(id, false)
}

let rafId = 0
let lastT = 0
function tick(now: number) {
  const dt = (now - lastT) / 1000
  lastT = now
  // hold the clock — but keep the loop alive so playback resumes by itself.
  // lastT was just advanced, so the stalled span is dropped rather than
  // accumulating into a jump when the media comes back.
  if (mediaStalled.value) {
    rafId = requestAnimationFrame(tick)
    return
  }
  const r = playRange.value
  const total = r ? r.end : contentEnd()
  const next = playhead.value + dt
  if (next >= total) {
    // loop within the object while animating; otherwise stop at the end
    if (r) playhead.value = r.start
    else {
      playhead.value = total
      pause()
      return
    }
  } else {
    playhead.value = next
  }
  rafId = requestAnimationFrame(tick)
}
export function play() {
  const r = playRange.value
  const end = r ? r.end : contentEnd()
  if (playing.value || end <= 0) return
  if (r) {
    if (playhead.value < r.start || playhead.value >= r.end) playhead.value = r.start
  } else if (playhead.value >= end) {
    playhead.value = 0 // restart from top if at end
  }
  playing.value = true
  lastT = performance.now()
  rafId = requestAnimationFrame(tick)
}
export function pause() {
  playing.value = false
  cancelAnimationFrame(rafId)
}
export function togglePlay() {
  playing.value ? pause() : play()
}

/** Jump the playhead to the next/previous object edge (start or end), + 0. */
export function jumpToEdge(dir: number) {
  const set = new Set<number>([0])
  for (const t of timeline.value.tracks)
    for (const c of t.clips) {
      set.add(c.start)
      set.add(c.start + c.duration)
    }
  const edges = [...set].sort((a, b) => a - b)
  const p = playhead.value
  if (dir > 0) {
    const n = edges.find((x) => x > p + 1e-4)
    if (n != null) playhead.value = n
  } else {
    const prev = [...edges].reverse().find((x) => x < p - 1e-4)
    playhead.value = prev ?? 0
  }
}

// --- undo / redo (timeline data) ---
const undoStack: TimelineData[] = []
const redoStack: TimelineData[] = []
const clone = (d: TimelineData) => structuredClone(d)

/** Record the current state before a mutation (call before editing). */
export function snapshot() {
  undoStack.push(clone(timeline.value))
  if (undoStack.length > 100) undoStack.shift()
  redoStack.length = 0
}
export function undo() {
  if (!undoStack.length) return
  redoStack.push(clone(timeline.value))
  timeline.value = undoStack.pop()!
}
export function redo() {
  if (!redoStack.length) return
  undoStack.push(clone(timeline.value))
  timeline.value = redoStack.pop()!
}
export function clearHistory() {
  undoStack.length = 0
  redoStack.length = 0
}

// --- clips ("Objects") ---
/** Shortest an object can be, seconds. */
export const MIN_CLIP = 0.1

/** Primary selected object — drives the Properties tool (last one clicked). */
export const selectedClipId = signal<string | null>(null)
/** Full selection (multi-select). Always contains the primary when non-null. */
export const selectedClips = signal<string[]>([])

/** Right-click object context menu — shared by the timeline and the viewport so
 *  both open the exact same menu (screen coords + target clip id). */
export const clipMenu = signal<{ x: number; y: number; id: string } | null>(null)
export function openClipMenu(x: number, y: number, id: string) {
  clipMenu.value = { x, y, id }
}

export function isSelected(id: string): boolean {
  return selectedClips.value.includes(id)
}
/** Select exactly one (or clear with null). Pulls in the whole group if linked. */
export function selectOnly(id: string | null) {
  selectedClipId.value = id
  selectedClips.value = id ? expandGroups([id]) : []
}
/** Toggle one (and its group) in/out of the selection (Ctrl+click). */
export function toggleSelect(id: string) {
  const unit = expandGroups([id])
  const has = selectedClips.value.includes(id)
  const next = has
    ? selectedClips.value.filter((x) => !unit.includes(x))
    : [...selectedClips.value, ...unit.filter((x) => !selectedClips.value.includes(x))]
  selectedClips.value = next
  selectedClipId.value = has ? next[next.length - 1] ?? null : id
}
/** Replace the selection with a set (rubber-band); linked members expand in. */
export function setSelection(ids: string[]) {
  const uniq = expandGroups([...new Set(ids)])
  selectedClips.value = uniq
  selectedClipId.value = uniq[uniq.length - 1] ?? null
}
export function clearSelection() {
  selectedClipId.value = null
  selectedClips.value = []
}

export function findClip(id: string): { clip: Clip; track: Track } | null {
  for (const track of timeline.value.tracks) {
    const clip = track.clips.find((c) => c.id === id)
    if (clip) return { clip, track }
  }
  return null
}

// --- linking (groups) ---
/** The group id of a clip, if any. */
export function groupOf(id: string): string | undefined {
  return findClip(id)?.clip.group
}
/** All clip ids in a group. */
export function groupMembers(group: string): string[] {
  const out: string[] = []
  for (const t of timeline.value.tracks) for (const c of t.clips) if (c.group === group) out.push(c.id)
  return out
}
/** Whether a clip belongs to a group. */
export function isLinked(id: string): boolean {
  return groupOf(id) != null
}
/** Expand a selection so any linked member pulls in its whole group. */
export function expandGroups(ids: string[]): string[] {
  const out = new Set<string>()
  for (const id of ids) {
    const g = groupOf(id)
    if (g) for (const m of groupMembers(g)) out.add(m)
    else out.add(id)
  }
  return [...out]
}
/** Rewrite every object on every track through `fn`. The one place the timeline
 *  is walked — return the clip unchanged to leave it alone. */
export function mapClips(fn: (c: Clip) => Clip) {
  timeline.value = {
    ...timeline.value,
    tracks: timeline.value.tracks.map((t) => ({ ...t, clips: t.clips.map(fn) })),
  }
}

/** Drop every object matching `pred`, from whichever track it's on. */
function dropClips(pred: (c: Clip) => boolean) {
  timeline.value = {
    ...timeline.value,
    tracks: timeline.value.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => !pred(c)) })),
  }
}

/** Link the current selection into one group (existing groups merge in). */
export function linkSelected() {
  const ids = expandGroups(selectedClips.value)
  if (ids.length < 2) return
  snapshot()
  setGroup(ids, 'grp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5))
  setSelection(ids)
}
/** Remove the selected objects (and their group siblings) from any group. */
export function unlinkSelected() {
  const ids = expandGroups(selectedClips.value)
  if (!ids.length) return
  snapshot()
  setGroup(ids, undefined)
}
/** Assign a specific group id to a set of clips (used by detach to link a/v). */
export function setGroup(ids: string[], group: string | undefined) {
  const set = new Set(ids)
  mapClips((c) => (set.has(c.id) ? { ...c, group } : c))
}

/**
 * Place a `duration`-long object on a track so it overlaps none of `others`.
 * Works off the actual free gaps between the existing objects and drops it in
 * the gap that both fits and lands closest to the desired `start`. Because the
 * result is always confined to a real gap, overlap is impossible by construction
 * (the open tail after the last object always fits as a fallback).
 */
function fitStart(others: Clip[], start: number, duration: number): number {
  const sorted = [...others].filter((o) => o.duration > 0).sort((a, b) => a.start - b.start)
  const desired = Math.max(0, start)
  // free gaps [from, to); `cursor` walks the covered end so overlapping source
  // data can't produce a negative-width gap.
  const gaps: [number, number][] = []
  let cursor = 0
  for (const o of sorted) {
    if (o.start > cursor) gaps.push([cursor, o.start])
    cursor = Math.max(cursor, o.start + o.duration)
  }
  gaps.push([cursor, Infinity]) // open tail — always fits
  let best = cursor
  let bestDist = Infinity
  for (const [from, to] of gaps) {
    if (to - from < duration) continue // gap too small to hold the object
    const s = Math.min(Math.max(desired, from), to - duration)
    const dist = Math.abs(s - desired)
    if (dist < bestDist) {
      bestDist = dist
      best = s
    }
  }
  return Math.max(0, best)
}

export function addClip(
  trackId: string,
  assetId: string,
  start: number,
  duration: number,
  sourceDuration?: number,
  snap = true,
): string {
  if (snap) snapshot()
  const id = 'clip_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  const target = timeline.value.tracks.find((t) => t.id === trackId)
  const fitted = fitStart(target?.clips ?? [], start, duration)
  const clip: Clip = { id, assetId, start: fitted, duration, in: 0, sourceDuration }
  timeline.value = {
    ...timeline.value,
    tracks: timeline.value.tracks.map((t) =>
      t.id === trackId ? { ...t, clips: [...t.clips, clip] } : t,
    ),
  }
  selectOnly(id)
  return id
}

/** Create a new text object at the playhead on the top-most video track. */
export function addText(): string {
  snapshot()
  let track = timeline.value.tracks.find((t) => t.kind !== 'audio')
  const trackId = track?.id ?? addTrack('video', false)
  track = timeline.value.tracks.find((t) => t.id === trackId)
  const id = 'clip_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  const dur = 5
  const fitted = fitStart(track?.clips ?? [], playhead.value, dur)
  // default text box (project px); user can resize with the gizmo
  const clip: Clip = { id, start: fitted, duration: dur, in: 0, name: 'Text', w: 1000, h: 300, text: { ...TEXT_DEFAULTS, bg: { ...TEXT_DEFAULTS.bg }, outline: { ...TEXT_DEFAULTS.outline } } }
  timeline.value = {
    ...timeline.value,
    tracks: timeline.value.tracks.map((t) => (t.id === trackId ? { ...t, clips: [...t.clips, clip] } : t)),
  }
  selectOnly(id)
  return id
}

/** Patch a text object's spec (shallow-merge; pass nested bg/outline whole). */
export function patchText(id: string, patch: Partial<TextSpec>, snap = true) {
  const c = findClip(id)?.clip
  if (!c?.text) return
  if (snap) snapshot()
  patchClip(id, { text: { ...c.text, ...patch } })
}
/** Rename an object. */
export function setClipName(id: string, name: string, snap = true) {
  if (snap) snapshot()
  patchClip(id, { name })
}

export function removeClip(clipId: string) {
  snapshot()
  if (isSelected(clipId)) setSelection(selectedClips.value.filter((x) => x !== clipId))
  dropClips((c) => c.id === clipId)
}

/** Remove every selected object (one undo step). */
export function removeSelected() {
  const ids = selectedClips.value
  if (!ids.length) return
  snapshot()
  const set = new Set(ids)
  dropClips((c) => set.has(c.id))
  clearSelection()
}

/** Shift keyframe times by `shift` then clamp into [0, duration] (trim behavior:
 *  a key trimmed past an edge lands ON that edge). No import cycle with anim.ts. */
function fitAnim(anim: Clip['anim'], duration: number, shift = 0): Clip['anim'] {
  if (!anim) return anim
  const out: NonNullable<Clip['anim']> = {}
  for (const p in anim) {
    const keys = anim[p].keys
      .map((k) => ({ ...k, t: Math.max(0, Math.min(duration, k.t + shift)) }))
      .sort((a, b) => a.t - b.t)
    out[p] = { ...anim[p], keys }
  }
  return out
}

/** Patch one clip's fields in place (no snapshot — caller decides). */
function patchClip(id: string, patch: Partial<Clip>) {
  mapClips((c) => (c.id === id ? { ...c, ...patch } : c))
}

export function setClipStart(id: string, start: number, snap = true) {
  const found = findClip(id)
  if (!found) return
  const { clip, track } = found
  const others = track.clips.filter((c) => c.id !== id)
  // block against same-track neighbors: can't slide through the object on
  // either side. Left/right decided by the object's current position.
  const leftBound = others
    .filter((c) => c.start <= clip.start)
    .reduce((m, c) => Math.max(m, c.start + c.duration), 0)
  const rightBound = others
    .filter((c) => c.start > clip.start)
    .reduce((m, c) => Math.min(m, c.start), Infinity)
  let s = Math.max(0, start)
  if (rightBound !== Infinity) s = Math.min(s, rightBound - clip.duration)
  s = Math.max(s, leftBound) // left wins if the gap is too small
  if (snap) snapshot()
  patchClip(id, { start: s })
}

export function setClipDuration(id: string, duration: number, snap = true) {
  const found = findClip(id)
  if (!found) return
  const { clip, track } = found
  let d = Math.max(MIN_CLIP, duration)
  // video/audio can't play past the end of their source
  if (clip.sourceDuration != null) d = Math.min(d, clip.sourceDuration - (clip.in ?? 0))
  // can't grow into the next object on the track
  const nextStart = track.clips
    .filter((c) => c.id !== id && c.start >= clip.start)
    .reduce((m, c) => Math.min(m, c.start), Infinity)
  if (nextStart !== Infinity) d = Math.min(d, nextStart - clip.start)
  d = Math.max(MIN_CLIP, d)
  if (snap) snapshot() // live scrubbing snapshots once at drag start instead
  patchClip(id, { duration: d, anim: fitAnim(clip.anim, d) })
}

/**
 * A source was replaced with a new file: re-fit every object using it to the new
 * length. Clamps in-points and durations so nothing runs past the new source end.
 * Images (uncapped) are left alone.
 */
export function retargetAsset(assetId: string, sourceDuration: number) {
  if (!(sourceDuration > 0)) return
  mapClips((c) => {
    if (c.assetId !== assetId || c.sourceDuration == null) return c
    const inPt = Math.min(c.in ?? 0, Math.max(0, sourceDuration - MIN_CLIP))
    const dur = Math.max(MIN_CLIP, Math.min(c.duration, sourceDuration - inPt))
    return { ...c, sourceDuration, in: inPt, duration: dur }
  })
}

/**
 * Point one object at a different source, in place. Keeps where it sits, its
 * name (if renamed), transform, volume/pan and keyframes; the in-point resets
 * to the start of the new media and the length is clamped to it.
 *
 * `sourceDuration` = the new media's natural length; omit for stretchable
 * sources (images). `audioOnly` marks it as a sound-only object.
 */
export function replaceClipMedia(
  clipId: string,
  assetId: string,
  opts: { sourceDuration?: number; audioOnly?: boolean } = {},
  snap = true,
) {
  const found = findClip(clipId)
  if (!found || found.clip.text) return
  const { clip } = found
  const src = opts.sourceDuration
  const dur = src != null ? Math.max(MIN_CLIP, Math.min(clip.duration, src)) : clip.duration
  if (snap) snapshot()
  patchClip(clipId, {
    assetId,
    in: 0,
    sourceDuration: src,
    duration: dur,
    // the old source's channel split doesn't map onto the new file
    channel: undefined,
    audioOnly: opts.audioOnly,
    anim: fitAnim(clip.anim, dur),
  })
}

export function setClipVolume(id: string, volume: number, snap = true) {
  if (snap) snapshot()
  patchClip(id, { volume: Math.max(0, volume) })
}

/** Set one 3D-transform field (x/y/z/rotX/rotY/rotZ/scale/opacity). */
export function setClipXform(id: string, key: string, value: number, snap = true) {
  if (snap) snapshot()
  let v = value
  if (key === 'scale') v = Math.max(0, v)
  if (key === 'w' || key === 'h') v = Math.max(1, Math.round(v))
  if (key === 'opacity' || key.startsWith('crop')) v = Math.max(0, Math.min(1, v))
  patchClip(id, { [key]: v } as Partial<Clip>)
}

/**
 * Set one grading scalar. Writes into `clip.grade`, creating it on first use.
 *
 * A value back at its default is REMOVED rather than stored, so an object that
 * has been graded and then reset is indistinguishable from one that never was —
 * which is what lets the renderer skip the whole thing on a null check.
 */
export function setClipGrade(id: string, key: string, value: number, snap = true) {
  if (snap) snapshot()
  const c = findClip(id)?.clip
  if (!c) return
  const p = GRADE_PROPS.find((g) => g.id === key)
  if (!p) return
  const v = Math.max(p.min, Math.min(p.max, value))
  const grade = { ...(c.grade ?? {}) } as Record<string, number>
  if (Math.abs(v - p.default) < 1e-6) delete grade[key]
  else grade[key] = v
  patchClip(id, { grade: Object.keys(grade).length ? grade : undefined })
}

/**
 * Replace one curve channel. An identity channel is dropped, same rule as the
 * scalars: what isn't there costs the renderer nothing.
 */
export function setClipCurve(id: string, channel: string, pts: [number, number][], snap = true) {
  if (snap) snapshot()
  const c = findClip(id)?.clip
  if (!c) return
  const curves = { ...(c.curves ?? {}) } as Record<string, [number, number][]>
  const identity = pts.length <= 2 && pts.every(([x, y]) => Math.abs(x - y) < 1e-4)
  if (identity) delete curves[channel]
  else curves[channel] = pts
  patchClip(id, { curves: Object.keys(curves).length ? curves : undefined })
}

/** Point an object at a loaded LUT, or clear it with null. */
export function setClipLut(id: string, lutId: string | null, snap = true) {
  if (snap) snapshot()
  patchClip(id, { lutId: lutId ?? undefined })
}

/** How much of the LUT applies, 0..1. */
export function setClipLutMix(id: string, mix: number, snap = true) {
  if (snap) snapshot()
  patchClip(id, { lutMix: Math.max(0, Math.min(1, mix)) })
}

/** Bypass an object's grade without losing it (A/B compare). */
export function setClipGradeOff(id: string, off: boolean, snap = true) {
  if (snap) snapshot()
  patchClip(id, { gradeOff: off || undefined })
}

export function setClipPixelated(id: string, on: boolean, snap = true) {
  if (snap) snapshot()
  patchClip(id, { pixelated: on })
}

export function setClipPitch(id: string, semitones: number, snap = true) {
  if (snap) snapshot()
  patchClip(id, { pitch: Math.max(-24, Math.min(24, semitones)) })
}

export function setClipPan(id: string, pan: number, snap = true) {
  if (snap) snapshot()
  patchClip(id, { pan: Math.max(-1, Math.min(1, pan)) })
}

export function setClipIn(id: string, inSec: number, snap = true) {
  const found = findClip(id)
  if (!found || found.clip.sourceDuration == null) return
  const { clip } = found
  const src = clip.sourceDuration!
  const nextIn = Math.min(Math.max(0, inSec), Math.max(0, src - MIN_CLIP))
  // keep the object within the source: trim length if it now runs past the end
  const dur = Math.min(clip.duration, src - nextIn)
  if (snap) snapshot()
  patchClip(id, { in: nextIn, duration: dur, anim: fitAnim(clip.anim, dur) })
}

/**
 * Drag the left edge: right edge stays put, start + length change together.
 * For video/audio the source in-point moves too (can't expose before frame 0).
 */
export function trimClipStart(id: string, newStart: number, snap = true) {
  const found = findClip(id)
  if (!found) return
  const { clip } = found
  const { track } = found
  const rightEdge = clip.start + clip.duration
  const inPt = clip.in ?? 0
  // capped media can't be dragged out earlier than its own first frame
  let minStart = clip.sourceDuration != null ? Math.max(0, clip.start - inPt) : 0
  // can't trim back over the previous object on the track
  const prevEnd = track.clips
    .filter((c) => c.id !== id && c.start < clip.start)
    .reduce((m, c) => Math.max(m, c.start + c.duration), 0)
  minStart = Math.max(minStart, prevEnd)
  const s = Math.min(Math.max(newStart, minStart), rightEdge - MIN_CLIP)
  const newDur = rightEdge - s
  const patch: Partial<Clip> = { start: s, duration: newDur }
  if (clip.sourceDuration != null) patch.in = inPt + (s - clip.start)
  // left-trim shifts the object's local origin: keys shift by -(delta) then clamp
  patch.anim = fitAnim(clip.anim, newDur, -(s - clip.start))
  if (snap) snapshot()
  patchClip(id, patch)
}

/** Split an object at absolute time `at`; returns the new right-hand clip id. */
export function splitClip(id: string, at: number, snap = true): string | null {
  const found = findClip(id)
  if (!found) return null
  const { clip, track } = found
  const end = clip.start + clip.duration
  if (at <= clip.start + 1e-4 || at >= end - 1e-4) return null
  if (snap) snapshot()
  const leftDur = at - clip.start
  const rightId = 'clip_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  const right: Clip = {
    id: rightId,
    assetId: clip.assetId,
    start: at,
    duration: end - at,
    in: clip.sourceDuration != null ? (clip.in ?? 0) + leftDur : clip.in,
    sourceDuration: clip.sourceDuration,
    group: clip.group,
    // right half keeps the keys past the cut, re-based to its own local 0
    anim: fitAnim(clip.anim, end - at, -leftDur),
  }
  timeline.value = {
    ...timeline.value,
    tracks: timeline.value.tracks.map((t) =>
      t.id !== track.id
        ? t
        : {
            ...t,
            clips: t.clips.flatMap((c) =>
              c.id === id ? [{ ...c, duration: leftDur, anim: fitAnim(c.anim, leftDur) }, right] : [c],
            ),
          },
    ),
  }
  return rightId
}

/** Split every object crossing time `at` (one undo step). */
export function splitAllAt(at: number) {
  const targets: string[] = []
  for (const t of timeline.value.tracks)
    for (const c of t.clips) if (at > c.start + 1e-4 && at < c.start + c.duration - 1e-4) targets.push(c.id)
  if (!targets.length) return
  snapshot()
  for (const id of targets) splitClip(id, at, false)
}

// --- global gaps (dead air across EVERY track) ---
/** A stretch of timeline with no object on any track. */
export interface Gap {
  start: number
  end: number
}
/** anything shorter than this is a rounding artefact, not dead air */
const MIN_GAP = 1 / 240

/**
 * Every stretch where the whole timeline is empty.
 *
 * Per-track holes don't count and shouldn't: a hole on track B under a shot on
 * track A is a composition, not dead air, and closing it would slide B out from
 * under A. So the spans are merged across all tracks first, and what's left
 * between them is time where the render is black on every layer.
 *
 * The stretch after the last object isn't a gap — there's nothing on the far
 * side to pull back. Before the first one is, since everything can move left.
 */
export function timelineGaps(): Gap[] {
  const spans: Gap[] = []
  for (const t of timeline.value.tracks)
    for (const c of t.clips) spans.push({ start: c.start, end: c.start + c.duration })
  if (!spans.length) return []
  spans.sort((a, b) => a.start - b.start)
  const merged: Gap[] = [{ ...spans[0] }]
  for (const s of spans.slice(1)) {
    const last = merged[merged.length - 1]
    if (s.start <= last.end + MIN_GAP) last.end = Math.max(last.end, s.end)
    else merged.push({ ...s })
  }
  const gaps: Gap[] = []
  if (merged[0].start > MIN_GAP) gaps.push({ start: 0, end: merged[0].start })
  for (let i = 1; i < merged.length; i++) gaps.push({ start: merged[i - 1].end, end: merged[i].start })
  return gaps.filter((g) => g.end - g.start > MIN_GAP)
}

/** The gap `t` falls in, if any. */
export function gapAt(t: number): Gap | null {
  return timelineGaps().find((g) => t >= g.start - 1e-4 && t <= g.end + 1e-4) ?? null
}

/**
 * Remove a stretch of dead air: everything after it slides back by its length.
 *
 * A gap has no object overlapping it by definition, so every object is wholly
 * before it or wholly after — no trimming, no splitting, nothing to reconcile.
 * Keyframes are object-local, so they ride along untouched; groups stay
 * together because every member moves by the same amount.
 */
export function closeGap(gap: Gap, snap = true) {
  const len = gap.end - gap.start
  if (!(len > MIN_GAP)) return
  if (snap) snapshot()
  mapClips((c) => (c.start >= gap.end - 1e-4 ? { ...c, start: c.start - len } : c))
  // keep the playhead on the same frame of content rather than on the same
  // number: it was pointing at something, and that something just moved
  if (playhead.value >= gap.end) playhead.value = Math.max(0, playhead.value - len)
  else if (playhead.value > gap.start) playhead.value = gap.start
}

/** Close every global gap, back to front, as one undo step. */
export function closeAllGaps() {
  const gaps = timelineGaps()
  if (!gaps.length) return
  snapshot()
  for (const g of [...gaps].reverse()) closeGap(g, false)
}

// --- snapping (object edges, across all tracks) ---
/** Snap targets in seconds: every other object's start/end, plus 0. */
export function snapPoints(excludeId?: string): number[] {
  const pts: number[] = [0]
  for (const t of timeline.value.tracks)
    for (const c of t.clips) {
      if (c.id === excludeId) continue
      pts.push(c.start, c.start + c.duration)
    }
  return pts
}
/** Nearest target within `threshold`, else the value unchanged. */
export function snapValue(v: number, targets: number[], threshold: number): number {
  let best = v
  let bestD = threshold
  for (const t of targets) {
    const d = Math.abs(v - t)
    if (d < bestD) {
      bestD = d
      best = t
    }
  }
  return best
}

/** Move a clip to `toTrackId` at `start` seconds. Caller snapshots at drag start. */
export function setClipPos(clipId: string, toTrackId: string, start: number) {
  let orig: Clip | undefined
  const stripped = timeline.value.tracks.map((t) => {
    const c = t.clips.find((x) => x.id === clipId)
    if (!c) return t
    orig = c
    return { ...t, clips: t.clips.filter((x) => x.id !== clipId) }
  })
  if (!orig) return
  const target = stripped.find((t) => t.id === toTrackId)
  const fitted = fitStart(target?.clips ?? [], Math.max(0, start), orig.duration)
  const moved: Clip = { ...orig, start: fitted }
  timeline.value = {
    ...timeline.value,
    tracks: stripped.map((t) => (t.id === toTrackId ? { ...t, clips: [...t.clips, moved] } : t)),
  }
}

export function setTrackHeight(id: string, height: number) {
  const h = Math.max(TRACK_MIN_H, Math.round(height))
  timeline.value = {
    ...timeline.value,
    tracks: timeline.value.tracks.map((t) => (t.id === id ? { ...t, height: h } : t)),
  }
}

/**
 * Detach a video object's audio: mute the video and drop an audio-only object
 * onto a fresh audio track. If `audioAssetId` is given (real extracted audio),
 * the new object references it; otherwise it reuses the video asset (fallback).
 */
export function detachAudio(clipId: string, audioAssetId?: string) {
  const found = findClip(clipId)
  if (!found || isSilent(found.clip)) return
  const { clip } = found
  snapshot()
  // link the video to its detached audio so they select + move together
  const group = clip.group ?? 'grp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  // Silence the video by turning it down, not by a flag — see isSilent. Its
  // volume keyframes go WITH the audio, which is the object that now carries
  // the sound; leaving them behind would have them fight the zero.
  const { volume: _v, ...restAnim } = clip.anim ?? {}
  const keptAnim = Object.keys(restAnim).length ? restAnim : undefined
  let tracks = timeline.value.tracks.map((t) => ({
    ...t,
    clips: t.clips.map((c) => (c.id === clipId ? { ...c, volume: 0, anim: keptAnim, group } : c)),
  }))
  // append an audio-only object on a new audio track
  const num = tracks.reduce((m, t) => Math.max(m, t.num ?? 0), 0) + 1
  const tid = 'track_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  const cid = 'clip_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  const audio: Clip = {
    ...clip,
    id: cid,
    assetId: audioAssetId ?? clip.assetId,
    // it inherits the level the video had, including any curve
    volume: clip.volume ?? 1,
    audioOnly: true,
    group,
  }
  tracks = [
    ...tracks,
    { id: tid, name: `Track ${trackLetter(num)}`, num, kind: 'audio', height: TRACK_H, clips: [audio] },
  ]
  timeline.value = { ...timeline.value, tracks }
  selectOnly(cid)
}

/**
 * Reveal a multi-channel audio object: replace it with one object per channel,
 * each on its own new audio track (great for OBS recordings with many sources).
 */
export function revealChannels(clipId: string, count: number) {
  const found = findClip(clipId)
  if (!found || count < 2) return
  const { clip } = found
  snapshot()
  // drop the original object
  let tracks = timeline.value.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) }))
  let baseNum = tracks.reduce((m, t) => Math.max(m, t.num ?? 0), 0)
  for (let i = 0; i < count; i++) {
    baseNum++
    const tid = 'track_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + i
    const cid = 'clip_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + i
    const chClip: Clip = { ...clip, id: cid, channel: i }
    tracks = [
      ...tracks,
      { id: tid, name: `Track ${trackLetter(baseNum)}`, num: baseNum, kind: 'audio', height: TRACK_H, clips: [chClip] },
    ]
  }
  timeline.value = { ...timeline.value, tracks }
  clearSelection()
}

// --- track layer (A = top) for an object ---
/** Layer of an object's track, 1-based from the top (A=1, B=2, …). */
export function clipLayer(id: string): number {
  const idx = timeline.value.tracks.findIndex((t) => t.clips.some((c) => c.id === id))
  return idx < 0 ? 1 : idx + 1
}
/** Move an object to a layer (1-based from the top). Keeps its start (collision-fit). */
export function setClipLayer(id: string, layer: number, snap = true) {
  const found = findClip(id)
  if (!found) return
  const tracks = timeline.value.tracks
  const idx = Math.max(0, Math.min(tracks.length - 1, Math.round(layer) - 1))
  const target = tracks[idx]
  if (!target || target.id === found.track.id) return
  if (snap) snapshot()
  setClipPos(id, target.id, found.clip.start)
}

/**
 * Move a group so its topmost object sits at `layer` (1-based from top); every
 * member shifts by the same track delta, keeping their relative layering.
 */
export function setGroupLayer(ids: string[], layer: number, snap = true) {
  const layers = ids.map((id) => ({ id, layer: clipLayer(id) }))
  if (!layers.length) return
  const top = Math.min(...layers.map((l) => l.layer))
  const delta = Math.round(layer) - top
  if (delta === 0) return
  if (snap) snapshot()
  // move outermost first so members never transiently pile onto one track
  const order = delta > 0 ? [...layers].sort((a, b) => b.layer - a.layer) : [...layers].sort((a, b) => a.layer - b.layer)
  for (const l of order) setClipLayer(l.id, l.layer + delta, false)
}

// --- clipboard (copy / cut / paste objects) ---
// Holds the whole selection (a linked group expands in), each with its track
// index so paste can rebuild the relative time + track layout.
interface ClipItem {
  clip: Clip
  trackIdx: number
  trackKind: 'video' | 'audio'
}
let clipboard: ClipItem[] = []

/** ids to copy: explicit, else the full selection, else the primary. */
function copyIds(id?: string): string[] {
  if (id) return [id]
  if (selectedClips.value.length) return selectedClips.value
  return selectedClipId.value ? [selectedClipId.value] : []
}

export function copyClip(id?: string) {
  const items = copyIds(id)
    .map((cid) => {
      const f = findClip(cid)
      if (!f) return null
      return {
        clip: { ...f.clip },
        trackIdx: timeline.value.tracks.findIndex((t) => t.id === f.track.id),
        trackKind: f.track.kind,
      }
    })
    .filter((x): x is ClipItem => !!x)
  if (items.length) clipboard = items
}

export function cutClip(id?: string) {
  const ids = copyIds(id)
  if (!ids.length) return
  copyClip(id)
  snapshot()
  const set = new Set(ids)
  dropClips((c) => set.has(c.id))
  clearSelection()
}

/** Insert a new clip on a track by id, nudged so it can't overlap. */
function insertOnTrack(trackId: string, clip: Clip): void {
  const t = timeline.value.tracks.find((x) => x.id === trackId)
  const start = fitStart(t?.clips ?? [], clip.start, clip.duration)
  const placed = { ...clip, start }
  timeline.value = {
    ...timeline.value,
    tracks: timeline.value.tracks.map((x) => (x.id === trackId ? { ...x, clips: [...x.clips, placed] } : x)),
  }
}

/**
 * Paste the clipboard, preserving the copied objects' relative time and track
 * offsets. Time anchors to the end of the selected object (else the last object
 * on the anchor track). A linked group is re-linked under a fresh group id so the
 * pasted copy stays grouped without joining the original.
 */
export function pasteClip() {
  if (!clipboard.length) return
  const items = clipboard
  const tracks = timeline.value.tracks
  const sel = selectedClipId.value ? findClip(selectedClipId.value) : null

  const minStart = Math.min(...items.map((i) => i.clip.start))
  const minIdx = Math.min(...items.map((i) => i.trackIdx))
  const anchorIdx = Math.min(Math.max(0, minIdx), tracks.length - 1)
  const anchor = sel?.track ?? tracks[anchorIdx] ?? tracks[0]
  if (!anchor) return

  const pasteStart = Math.max(
    0,
    sel ? sel.clip.start + sel.clip.duration : anchor.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0),
  )
  const timeShift = pasteStart - minStart
  const targetIdx = timeline.value.tracks.findIndex((t) => t.id === anchor.id)
  const trackShift = targetIdx - minIdx

  snapshot()
  const groupMap = new Map<string, string>() // old group -> new group
  const newIds: string[] = []
  for (const it of items) {
    // ensure a destination track exists at the shifted index (append if needed)
    let destIdx = Math.max(0, it.trackIdx + trackShift)
    while (destIdx > timeline.value.tracks.length - 1) addTrack(it.trackKind, false)
    const destId = timeline.value.tracks[destIdx].id

    let group = it.clip.group
    if (group) {
      if (!groupMap.has(group))
        groupMap.set(group, 'grp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + newIds.length)
      group = groupMap.get(group)
    }
    const id = 'clip_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + newIds.length
    insertOnTrack(destId, { ...it.clip, id, start: it.clip.start + timeShift, group })
    newIds.push(id)
  }
  setSelection(newIds)
}
