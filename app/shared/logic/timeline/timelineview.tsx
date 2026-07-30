// Timeline panel.
// Top row: time, unit toggle, stepper. Ruler (fixed-spacing, click to seek,
// Ctrl+wheel to change step). Below: track gutter (headers) + lanes, with an
// outlined + empty-state when there are no tracks.
import type { JSX } from 'preact'
import type { ComponentChildren } from 'preact'
import { signal, effect, type Signal } from '@preact/signals'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Icon } from '../ui/icon'
import {
  timeline,
  rulerUnit,
  rulerStep,
  playhead,
  addTrack,
  removeTrack,
  renameTrack,
  setTrackHeight,
  moveTrack,
  addClip,
  removeClip,
  removeSelected,
  replaceClipMedia,
  setClipPos,
  setClipDuration,
  trimClipStart,
  revealChannels,
  detachAudio,
  isSilent,
  findClip,
  snapPoints,
  snapValue,
  selectedClips,
  isSelected,
  selectOnly,
  toggleSelect,
  setSelection,
  clearSelection,
  linkSelected,
  unlinkSelected,
  groupOf,
  snapshot,
  clipMenu,
  isText,
  timelineGaps,
  closeGap,
  TRACK_H,
  SEGMENT_PX,
  type Track,
  type Clip,
} from './timeline'
import { currentProject } from '../project/project'
import {
  assets,
  addExtractedAudio,
  addAssetsFromFiles,
  addAssetsFromPaths,
  iconFor,
  type Asset,
} from '../tools/files/assets'
import { platform } from '../platform/platform'
import { dragAsset, dragOverTrack } from './assetdrag'
import { requestThumb, probeDuration, THUMB_QUANT } from './thumbs'
import { mediaExclusive } from '../media/exclusive'
import { mediaOps } from '../media/media'
import { startTask } from '../ui/progress'
import { AnimationEditor } from './animview'
import { animatingClipId, startAnimating } from './anim'
import { openCrop } from '../viewport/cropdialog'
import { useMenuClamp } from '../ui/ctxmenu'
import { askConfirm } from '../ui/confirm'
import { onDrag } from '../ui/pointerdrag'
import { interacting, poke } from './interact'

/** The scrolling lanes viewport. There is one timeline, so a module handle is
 *  enough — clip drags need it both to auto-scroll at the edges and to measure
 *  in CONTENT space, since the view moves under the pointer while they run. */
export const lanesEl: { current: HTMLDivElement | null } = { current: null }
const scrollX = () => lanesEl.current?.scrollLeft ?? 0

const round2 = (n: number) => Math.round(n * 100) / 100

function fpsOf(): number {
  return currentProject.value?.fps ?? timeline.value.fps
}
/** seconds covered by one ruler segment (fixed px) */
export function secPerSeg(): number {
  return rulerUnit.value === 'seconds' ? rulerStep.value : rulerStep.value / fpsOf()
}
/** pixels per second at the current ruler scale (clip + playhead positioning) */
export function pps(): number {
  return SEGMENT_PX / secPerSeg()
}

// --- drag snapping. Default: object edges. Shift: free. Ctrl: ruler step.
// Ctrl+Shift: whole second.
const SNAP_PX = 8
type Mods = { ctrlKey: boolean; shiftKey: boolean }
/** Snap a single edge value under the current modifiers. */
function snapEdge(value: number, targets: number[], pxs: number, e: Mods): number {
  if (e.ctrlKey && e.shiftKey) return Math.round(value) // whole second
  if (e.ctrlKey) {
    const s = secPerSeg()
    return Math.round(value / s) * s // ruler step
  }
  if (e.shiftKey) return value // ignore snapping
  return snapValue(value, targets, SNAP_PX / pxs)
}
/** Snap a moving object by whichever of its two edges lands closest. */
function snapMove(start: number, dur: number, targets: number[], pxs: number, e: Mods): number {
  if (e.ctrlKey && e.shiftKey) return Math.round(start)
  if (e.ctrlKey) {
    const s = secPerSeg()
    return Math.round(start / s) * s
  }
  if (e.shiftKey) return start
  const thr = SNAP_PX / pxs
  const sS = snapValue(start, targets, thr) // snapped leading edge
  const sE = snapValue(start + dur, targets, thr) // snapped trailing edge
  const hitS = sS !== start
  const hitE = sE !== start + dur
  if (hitS && hitE) return Math.abs(sS - start) <= Math.abs(sE - (start + dur)) ? sS : sE - dur
  if (hitS) return sS
  if (hitE) return sE - dur
  return start
}
/** nudge the ruler step (dir = +1 / -1), unit-aware clamping */
function stepBy(dir: number) {
  const unit = rulerUnit.value
  const inc = unit === 'seconds' ? 0.1 : 1
  const v = rulerStep.value + dir * inc
  rulerStep.value = unit === 'frames' ? Math.max(1, Math.round(v)) : Math.max(0.1, round2(v))
}

function tc(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${h}:${p(m)}:${p(s)}`
}

// Shared top bar (time readout + unit/step controls) for both timelines.
// `left` renders extra controls (e.g. the animation Back button / Graph toggle).
export function TopBar({
  head = playhead,
  total = timeline.value.duration,
  left,
  right,
}: {
  head?: Signal<number>
  total?: number
  left?: ComponentChildren
  right?: ComponentChildren
} = {}) {
  const unit = rulerUnit.value
  const step = rulerStep.value
  const inc = unit === 'seconds' ? 0.1 : 1
  const clampStep = (v: number) =>
    unit === 'frames' ? Math.max(1, Math.round(v)) : Math.max(0.1, round2(v))
  return (
    <div class="tl-top">
      {left}
      <div class="tl-time">
        {tc(head.value)} / {tc(total)}
      </div>
      <div class="tl-top__spacer" />
      {right}
      <button
        class="tl-unit"
        title="Switch frames / seconds"
        onClick={() => {
          const fps = fpsOf()
          if (unit === 'seconds') {
            rulerUnit.value = 'frames'
            rulerStep.value = Math.max(1, Math.round(step * fps))
          } else {
            rulerUnit.value = 'seconds'
            rulerStep.value = Math.max(0.1, round2(step / fps))
          }
        }}
      >
        {unit === 'seconds' ? 'Second' : 'Frame'}
      </button>
      <div class="tl-step">
        <button class="tl-step__arrow" onClick={() => stepBy(1)}>
          <Icon name="keyboard_arrow_up" size={12} />
        </button>
        <button class="tl-step__arrow" onClick={() => stepBy(-1)}>
          <Icon name="keyboard_arrow_down" size={12} />
        </button>
      </div>
      <input
        class="tl-num"
        type="number"
        min={inc}
        step={inc}
        value={step}
        onInput={(e) => (rulerStep.value = clampStep(+(e.target as HTMLInputElement).value || inc))}
      />
    </div>
  )
}

// Shared ruler for BOTH timelines. `head` is the playhead signal it drives
// (global for the main timeline, the local one for the animation editor);
// `clampMax` bounds it (the object length in the editor, else unbounded).
export function Ruler({
  width,
  scroller,
  head = playhead,
  clampMax = Infinity,
  onHead,
}: {
  width: number
  scroller: { current: HTMLDivElement | null }
  head?: Signal<number>
  clampMax?: number
  /** override how the head moves (e.g. anim editor syncs the real playhead too) */
  onHead?: (v: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const clamp = (v: number) => Math.max(0, Math.min(clampMax, v))
  const setHead = (v: number) => (onHead ? onHead(clamp(v)) : (head.value = clamp(v)))
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Wheel over the ruler:
    //   Ctrl        → change the ruler step
    //   Ctrl+Shift  → move the playhead segment-by-segment (snapped)
    //   Shift       → move the playhead freely
    //   plain       → pan the timeline left/right
    // (native listener so preventDefault works)
    // Zoom notches arrive far faster than the timeline can redraw at high zoom,
    // and each one used to force a full pass. Sum them and apply once a frame:
    // same destination, a fraction of the work. `stepBy` already takes a count.
    let notches = 0
    let raf = 0
    const flushZoom = () => {
      raf = 0
      const n = notches
      notches = 0
      if (n) stepBy(n)
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      poke() // drop detail while the gesture runs
      const d = e.deltaY || e.deltaX
      const dir = d > 0 ? 1 : -1
      if (e.ctrlKey && e.shiftKey) {
        const step = secPerSeg()
        setHead((Math.round(head.value / step) + dir) * step)
      } else if (e.ctrlKey) {
        notches += e.deltaY < 0 ? 1 : -1
        if (!raf) raf = requestAnimationFrame(flushZoom)
      } else if (e.shiftKey) {
        setHead(head.value + dir * (secPerSeg() / 4))
      } else if (scroller.current) {
        scroller.current.scrollLeft += d
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      cancelAnimationFrame(raf)
    }
  }, [head, clampMax])

  const unit = rulerUnit.value
  const step = rulerStep.value
  const count = Math.ceil(width / SEGMENT_PX) + 1
  // Minor ticks are three quarters of the tick DOM and are unreadable while the
  // view is moving, so they sit out the gesture.
  const subdiv = interacting.value ? 1 : 4
  const ticks: JSX.Element[] = []
  for (let i = 0; i < count; i++) {
    const val = round2(i * step)
    const sec = i * secPerSeg()
    ticks.push(
      <div
        class="tl-tick tl-tick--major"
        style={{ left: `${i * SEGMENT_PX}px` }}
        key={`M${i}`}
        title={`Snap to ${unit === 'seconds' ? `${val}s` : `frame ${val}`}`}
        onClick={(e) => {
          e.stopPropagation()
          setHead(sec)
        }}
      >
        <span class="tl-tick__label">{unit === 'seconds' ? `${val}s` : `${val}`}</span>
      </div>,
    )
    for (let s = 1; s < subdiv; s++) {
      ticks.push(
        <div
          class="tl-tick tl-tick--minor"
          style={{ left: `${i * SEGMENT_PX + (s * SEGMENT_PX) / subdiv}px` }}
          key={`m${i}-${s}`}
        />,
      )
    }
  }

  const scrubTo = (clientX: number) => {
    const el = ref.current
    if (!el) return
    const x = Math.max(0, clientX - el.getBoundingClientRect().left)
    setHead((x / SEGMENT_PX) * secPerSeg())
  }

  return (
    <div
      class="tl-ruler"
      ref={ref}
      style={{ width: `${width}px` }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        scrubTo(e.clientX)
        const move = (ev: PointerEvent) => scrubTo(ev.clientX)
        const up = () => {
        }
        onDrag(move, up)
      }}
    >
      {ticks}
    </div>
  )
}

function TrackHead({ track }: { track: Track }) {
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const height = track.height ?? TRACK_H

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const commit = () => {
    const v = inputRef.current?.value.trim()
    if (v) renameTrack(track.id, v)
    setEditing(false)
  }

  const startResize = (e: PointerEvent) => {
    e.preventDefault()
    e.stopPropagation() // don't also start a reorder
    snapshot() // one undo step per resize drag
    const startY = e.clientY
    const startH = height
    const move = (ev: PointerEvent) => setTrackHeight(track.id, startH + (ev.clientY - startY))
    const up = () => {
    }
    onDrag(move, up)
  }

  // drag a head up/down to reorder tracks (top track composites over the rest)
  const startReorder = (e: PointerEvent) => {
    if (editing) return
    e.preventDefault()
    let dirty = false
    const move = (ev: PointerEvent) => {
      const head = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest(
        '[data-thead]',
      ) as HTMLElement | null
      const overId = head?.dataset.thead
      if (!overId || overId === track.id) return
      if (!dirty) {
        snapshot()
        dirty = true
      }
      const toIndex = timeline.value.tracks.findIndex((t) => t.id === overId)
      moveTrack(track.id, toIndex, false)
    }
    const up = () => {
    }
    onDrag(move, up)
  }

  return (
    <div class="tl-thead" data-thead={track.id} style={{ height: `${height}px` }}>
      <div
        class="tl-thead__grip"
        title="Drag to reorder"
        onPointerDown={(e) => startReorder(e as unknown as PointerEvent)}
      >
        <Icon name="drag_indicator" size={16} />
      </div>
      {editing ? (
        <input
          ref={inputRef}
          class="tl-thead__input"
          defaultValue={track.name}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <span class="tl-thead__name" onDblClick={() => setEditing(true)}>
          {track.name}
        </span>
      )}
      <button
        class="tl-thead__x"
        title="Remove track"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => removeTrack(track.id)}
      >
        <Icon name="close" size={14} />
      </button>
      <div class="tl-thead__resize" onPointerDown={(e) => startResize(e as unknown as PointerEvent)} />
    </div>
  )
}

// A single filmstrip tile — lazily pulls its frame, shows it as a cover bg.
function Thumb({ assetId, url, time }: { assetId: string; url: string; time: number }) {
  const [src, setSrc] = useState('')
  // Read during render so this component re-runs when the export lets go, or
  // when a gesture settles — otherwise the deps below never change and the tile
  // stays blank for the rest of the session. Whatever frame it already has stays
  // on screen meanwhile, so dropping detail costs nothing visually.
  const busy = mediaExclusive.value || interacting.value
  useEffect(() => {
    if (busy) return
    let live = true
    requestThumb(assetId, url, time)
      .then((d) => live && setSrc(d))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [assetId, url, time, busy])
  return <div class="tl-thumb" style={{ backgroundImage: src ? `url(${src})` : undefined }} />
}

// Volume waveform for the visible slice of an audio object (peaks span source).
function Waveform({
  peaks,
  inSec,
  duration,
  sourceDuration,
}: {
  peaks: number[]
  inSec: number
  duration: number
  sourceDuration?: number
}) {
  const W = 100
  const H = 100
  // The polygon is in the viewBox's own units and the SVG stretches to whatever
  // width the clip has (preserveAspectRatio="none"), so zoom cannot change it.
  // Rebuilding ~1200 points per audio clip on every zoom notch was pure waste.
  const points = useMemo(() => {
    const total = sourceDuration ?? duration
    const n = peaks.length
    const a = total > 0 ? Math.floor((inSec / total) * n) : 0
    const b = total > 0 ? Math.min(n, Math.ceil(((inSec + duration) / total) * n)) : n
    const slice = peaks.slice(a, Math.max(a + 1, b))
    const mid = H / 2
    const bars = slice.length
    const top: string[] = []
    const bot: string[] = []
    for (let i = 0; i < bars; i++) {
      const x = bars > 1 ? (i / (bars - 1)) * W : 0
      const h = (slice[i] || 0) * mid * 0.92
      top.push(`${x.toFixed(2)},${(mid - h).toFixed(2)}`)
      bot.push(`${x.toFixed(2)},${(mid + h).toFixed(2)}`)
    }
    return [...top, ...bot.reverse()].join(' ')
  }, [peaks, inSec, duration, sourceDuration])
  return (
    <svg class="tl-wave" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polygon points={points} />
    </svg>
  )
}

// Clip contents: video → filmstrip of frames, image → cover, audio → waveform.
function Filmstrip({
  asset,
  inSec,
  duration,
  sourceDuration,
  audioOnly,
  width,
  height,
}: {
  asset?: Asset
  inSec: number
  duration: number
  sourceDuration?: number
  audioOnly?: boolean
  width: number
  height: number
}) {
  if (!asset || asset.missing)
    return (
      <div class="tl-clip__missing">
        <Icon name="download" size={16} />
      </div>
    )
  // audio-only object (or an audio asset) → waveform
  if (audioOnly || asset.kind === 'audio')
    return asset.peaks?.length ? (
      <Waveform peaks={asset.peaks} inSec={inSec} duration={duration} sourceDuration={sourceDuration} />
    ) : (
      <div class="tl-clip__audio">
        <Icon name="insert_drive_file" size={14} />
      </div>
    )
  if (asset.kind === 'image') return <img class="tl-clip__img" src={asset.url} alt="" />
  const tileW = Math.max(40, Math.round((height * 16) / 9))
  const tiles = Math.max(1, Math.ceil(width / tileW))
  // Frame times come off a grid anchored in SOURCE time, not off the tile index.
  // Deriving them from `tiles` meant every zoom notch moved every tile's time —
  // and time is a request dependency, so the whole strip re-fetched on each
  // notch. Anchored, the grid only shifts when the spacing crosses a THUMB_QUANT
  // boundary, so zooming re-uses frames that are already cached. It also caps a
  // strip at duration/THUMB_QUANT tiles however far you zoom in.
  const gap = Math.max(THUMB_QUANT, Math.ceil(duration / tiles / THUMB_QUANT) * THUMB_QUANT)
  const end = inSec + duration
  const out: JSX.Element[] = []
  for (let t = Math.max(0, Math.floor(inSec / gap) * gap); t < end; t += gap) {
    out.push(<Thumb key={t} assetId={asset.id} url={asset.url} time={t} />)
  }
  return <div class="tl-clip__strip">{out}</div>
}

function ClipView({ clip, track }: { clip: Clip; track: Track }) {
  const asset = assets.value.find((a) => a.id === clip.assetId)
  const text = isText(clip)
  const pxs = pps()
  const left = clip.start * pxs
  const width = Math.max(10, clip.duration * pxs)
  const height = track.height ?? TRACK_H

  // highlight the clip if selected, or if any selected object shares its group
  // (linked objects always light up together)
  const sel = selectedClips.value
  const selected =
    sel.includes(clip.id) || (clip.group != null && sel.some((id) => groupOf(id) === clip.group))

  const startMove = (e: PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Ctrl/Cmd+click toggles selection, no drag
    if (e.ctrlKey || e.metaKey) {
      toggleSelect(clip.id)
      return
    }
    if (!isSelected(clip.id)) selectOnly(clip.id)

    // content space: the lanes can scroll under the pointer mid-drag
    const startX = e.clientX + scrollX()
    const targets = snapPoints(clip.id)

    // Multi-select: dragging any member moves the whole group by one time delta
    // (and, if the pointer crosses tracks, by the same track-index delta).
    if (selectedClips.value.length > 1 && isSelected(clip.id)) {
      const trackIndex = (id: string) => timeline.value.tracks.findIndex((t) => t.id === id)
      const origs = selectedClips.value
        .map((id) => {
          const f = findClip(id)
          return f ? { id, trackIdx: trackIndex(f.track.id), start: f.clip.start } : null
        })
        .filter((x): x is { id: string; trackIdx: number; start: number } => !!x)
      const primaryOrig = clip.start
      const primaryOrigIdx = trackIndex(track.id)
      let dirty = false
      const move = (ev: PointerEvent) => {
        if (!dirty) {
          snapshot()
          dirty = true
        }
        const dt = (ev.clientX + scrollX() - startX) / pxs
        const ns = snapMove(primaryOrig + dt, clip.duration, targets, pxs, ev)
        const delta = ns - primaryOrig
        // track shift = where the pointer's lane sits vs the primary's origin
        const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
        const lane = el?.closest('[data-track]') as HTMLElement | null
        const overIdx = lane ? trackIndex(lane.dataset.track!) : primaryOrigIdx
        const trackDelta = overIdx >= 0 ? overIdx - primaryOrigIdx : 0
        const tracks = timeline.value.tracks
        for (const o of origs) {
          const idx = Math.max(0, Math.min(tracks.length - 1, o.trackIdx + trackDelta))
          setClipPos(o.id, tracks[idx].id, o.start + delta)
        }
      }
      const up = () => {
      }
      onDrag(move, up, { autoScroll: lanesEl.current })
      return
    }

    // Single move (cross-track + drop-to-new-track)
    const orig = clip.start
    let dirty = false
    let curTrack = track.id
    let pendingNew: number | null = null
    const move = (ev: PointerEvent) => {
      if (!dirty) {
        snapshot()
        dirty = true
      }
      const dt = (ev.clientX + scrollX() - startX) / pxs
      const ns = snapMove(orig + dt, clip.duration, targets, pxs, ev)
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
      const lane = el?.closest('[data-track]') as HTMLElement | null
      const newZone = el?.closest('[data-newtrack]')
      if (newZone && !lane) {
        pendingNew = ns
        newTrackHint.value = true
        setClipPos(clip.id, curTrack, ns)
      } else {
        pendingNew = null
        newTrackHint.value = false
        curTrack = lane?.dataset.track ?? curTrack
        setClipPos(clip.id, curTrack, ns)
      }
    }
    const up = () => {
      newTrackHint.value = false
      if (pendingNew != null) {
        const kind = asset?.kind === 'audio' ? 'audio' : 'video'
        const id = addTrack(kind, false)
        setClipPos(clip.id, id, pendingNew)
      }
    }
    onDrag(move, up, { autoScroll: lanesEl.current })
  }

  // drag a left/right edge to trim — writes the same props the panel edits
  const startTrim = (side: 'l' | 'r') => (e: PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    selectOnly(clip.id)
    const startX = e.clientX + scrollX()
    const origStart = clip.start
    const origDur = clip.duration
    const targets = snapPoints(clip.id)
    let dirty = false
    const move = (ev: PointerEvent) => {
      if (!dirty) {
        snapshot()
        dirty = true
      }
      const dx = (ev.clientX + scrollX() - startX) / pxs
      if (side === 'l') {
        const ns = snapEdge(origStart + dx, targets, pxs, ev)
        trimClipStart(clip.id, ns, false)
      } else {
        const ne = snapEdge(origStart + origDur + dx, targets, pxs, ev) // right edge
        setClipDuration(clip.id, ne - origStart, false)
      }
    }
    const up = () => {
    }
    onDrag(move, up, { autoScroll: lanesEl.current })
  }

  return (
    <div
      class={'tl-clip' + (!text && asset?.missing ? ' is-missing' : '') + (selected ? ' is-selected' : '') + (text ? ' tl-clip--text' : '')}
      style={{ left: `${left}px`, width: `${width}px`, height: `${height}px` }}
      title={text ? clip.name ?? 'Text' : asset?.name ?? 'missing media'}
      onPointerDown={(e) => startMove(e as unknown as PointerEvent)}
      onContextMenu={(e) => {
        e.preventDefault()
        if (!isSelected(clip.id)) selectOnly(clip.id)
        clipMenu.value = { x: e.clientX, y: e.clientY, id: clip.id }
      }}
    >
      {!text && (
        <Filmstrip
          asset={asset}
          inSec={clip.in ?? 0}
          duration={clip.duration}
          sourceDuration={clip.sourceDuration}
          audioOnly={clip.audioOnly}
          width={width}
          height={height}
        />
      )}
      <span class="tl-clip__label">
        {text && <Icon name="text_fields" size={12} />}
        {clip.name ?? asset?.name ?? 'missing'}
        {clip.channel != null && <span class="tl-clip__ch"> · Ch {clip.channel + 1}</span>}
      </span>
      {isSilent(clip) && (
        <span class="tl-clip__muted" title="Audio detached (muted)">
          <Icon name="volume_off" size={12} />
        </span>
      )}
      {clip.group != null && (
        <span class="tl-clip__link" title="Linked">
          <Icon name="link" size={12} />
        </span>
      )}
      {selected && (
        <>
          <div
            class="tl-clip__handle tl-clip__handle--l"
            onPointerDown={(e) => startTrim('l')(e as unknown as PointerEvent)}
          />
          <div
            class="tl-clip__handle tl-clip__handle--r"
            onPointerDown={(e) => startTrim('r')(e as unknown as PointerEvent)}
          />
        </>
      )}
    </div>
  )
}

/**
 * Dead air, marked where it is: stretches with nothing on ANY track.
 *
 * Drawn over the lanes rather than in a strip of its own, because the thing it
 * describes is vertical — the point is that every track is empty here, and a
 * band that spans them all says that without a legend. The band itself is
 * click-through so it can't eat a rubber-band selection or a drag; only the
 * chip takes the pointer, and the chip is dropped when the gap is too narrow to
 * hold it (still visible, close it from the playhead instead).
 */
function GapBands() {
  const gaps = timelineGaps()
  if (!gaps.length) return null
  const pxs = pps()
  return (
    <>
      {gaps.map((g) => {
        const len = g.end - g.start
        const w = len * pxs
        return (
          <div key={`${g.start}-${g.end}`} class="tl-gap" style={{ left: `${g.start * pxs}px`, width: `${w}px` }}>
            {w >= 26 && (
              <button
                class="tl-gap__close"
                title={`Close ${len.toFixed(2)}s gap — everything after it moves left`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => closeGap(g)}
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
        )
      })}
    </>
  )
}

// Right-click menu for a clip (Delete for now).
// true while a dragged object hovers the "drop to make a new track" zone
const newTrackHint = signal(false)

/** One-shot file picker with no mounted <input> — the menu can close freely. */
function pickOneFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const el = document.createElement('input')
    el.type = 'file'
    el.onchange = () => resolve(el.files?.[0] ?? null)
    el.oncancel = () => resolve(null)
    el.click()
  })
}

export function ClipMenu() {
  const m = clipMenu.value
  // second page of the menu: which source to swap the object onto
  const [picking, setPicking] = useState(false)
  useEffect(() => setPicking(false), [m?.id, m?.x, m?.y])
  const clamp = useMenuClamp(m?.x ?? 0, m?.y ?? 0, picking)
  useEffect(() => {
    if (!m) return
    const close = () => (clipMenu.value = null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    // the source list scrolls inside the menu — only outside scrolling closes it
    const onScroll = (e: Event) => {
      if (!clamp.ref.current?.contains(e.target as Node)) close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [m])
  if (!m) return null
  const found = findClip(m.id)
  const asset = found ? assets.value.find((a) => a.id === found.clip.assetId) : null
  // reveal only for a whole (not already-split) multi-channel audio-only object
  const channels = asset?.channels ?? 0
  const canReveal = found?.clip.audioOnly === true && found?.clip.channel == null && channels > 1
  const canDetach = asset?.kind === 'video' && !found?.clip.audioOnly && !!found && !isSilent(found.clip)
  // crop only makes sense on a visible (image/video) object
  const canCrop = !!found && !found.clip.audioOnly && (asset?.kind === 'video' || asset?.kind === 'image')
  // media objects can be pointed at another source; text objects have none
  const canReplace = !!found && !found.clip.text

  // swap this object onto `a`, keeping its place + properties
  const replaceWith = (a: Asset) => {
    const id = m.id
    const audioOnly = a.kind === 'audio' || found?.track.kind === 'audio'
    clipMenu.value = null
    if (a.kind === 'video' || a.kind === 'audio') {
      // capped sources: fit the object inside the new file's length
      probeDuration(a.url, a.kind).then((dur) =>
        replaceClipMedia(id, a.id, { sourceDuration: dur, audioOnly }),
      )
    } else {
      replaceClipMedia(id, a.id, { audioOnly: false })
    }
  }
  // import a file that isn't in the project yet, then swap onto it
  const importAndReplace = () => {
    const pm = platform.value.pickMedia
    if (pm) {
      pm().then((paths) => {
        const ids = addAssetsFromPaths(paths.slice(0, 1))
        const a = assets.value.find((x) => x.id === ids[0])
        if (a) replaceWith(a)
      })
    } else {
      pickOneFile().then((f) => {
        if (!f) return
        const ids = addAssetsFromFiles([f])
        const a = assets.value.find((x) => x.id === ids[0])
        if (a) replaceWith(a)
      })
    }
  }

  if (picking) {
    const others = assets.value.filter((a) => a.id !== asset?.id && !a.missing)
    return (
      <div
        ref={clamp.ref}
        class="ctxmenu ctxmenu--pick"
        style={{ left: clamp.left, top: clamp.top }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button class="ctxmenu__item" onClick={() => setPicking(false)}>
          <Icon name="keyboard_arrow_left" size={14} /> Replace with…
        </button>
        <div class="ctxmenu__sep" />
        <button class="ctxmenu__item" onClick={importAndReplace}>
          <Icon name="add" size={14} /> Import file…
        </button>
        {others.map((a) => (
          <button key={a.id} class="ctxmenu__item ctxmenu__item--asset" onClick={() => replaceWith(a)} title={a.name}>
            <Icon name={iconFor(a)} size={14} /> {a.name}
          </button>
        ))}
        {!others.length && <div class="ctxmenu__empty">No other media imported</div>}
      </div>
    )
  }
  return (
    <div ref={clamp.ref} class="ctxmenu" style={{ left: clamp.left, top: clamp.top }} onMouseDown={(e) => e.stopPropagation()}>
      <button
        class="ctxmenu__item"
        onClick={() => {
          startAnimating(m.id)
          clipMenu.value = null
        }}
      >
        <Icon name="animation" size={14} /> Animate
      </button>
      {canReplace && (
        <button class="ctxmenu__item" onClick={() => setPicking(true)}>
          <Icon name="swap_horiz" size={14} /> Replace media…
        </button>
      )}
      {canCrop && (
        <button
          class="ctxmenu__item"
          onClick={() => {
            openCrop(m.id)
            clipMenu.value = null
          }}
        >
          <Icon name="crop" size={14} /> Crop object
        </button>
      )}
      {canDetach && (
        <button
          class="ctxmenu__item"
          onClick={() => {
            const id = m.id
            clipMenu.value = null
            const ops = mediaOps()
            if (ops && asset && !asset.missing) {
              // extract real audio via the platform (web = WAV), then place it
              const task = startTask('Detach audio', 'Starting…')
              ops
                .detachAudio({ url: asset.url, path: asset.path }, asset.name, (detail, value) => task.step(detail, value))
                .then((res) => {
                  if (res) {
                    task.step('Placing on timeline…', null)
                    const audioId = addExtractedAudio(res)
                    detachAudio(id, audioId)
                  } else {
                    // Nothing came back — no ffmpeg yet, or a stream it could
                    // not read. Detaching anyway would mute the video and hand
                    // back an object pointing at a file the browser may not
                    // decode either, which is silence: the audio is simply
                    // gone. Leave the object alone and say so.
                    void askConfirm(
                      "Couldn't extract this object's audio, so it has been left as it is. " +
                        'On desktop this usually means ffmpeg is still being fetched — it arrives with your first export.',
                      'OK',
                    )
                  }
                })
                .finally(() => task.done())
            } else {
              detachAudio(id)
            }
          }}
        >
          Detach audio
        </button>
      )}
      {canReveal && (
        <button
          class="ctxmenu__item"
          onClick={() => {
            revealChannels(m.id, channels)
            clipMenu.value = null
          }}
        >
          Reveal channels ({channels})
        </button>
      )}
      {isSelected(m.id) && selectedClips.value.length > 1 && (
        <button
          class="ctxmenu__item"
          onClick={() => {
            linkSelected()
            clipMenu.value = null
          }}
        >
          Link {selectedClips.value.length} objects
        </button>
      )}
      {found?.clip.group != null && (
        <button
          class="ctxmenu__item"
          onClick={() => {
            if (!isSelected(m.id)) selectOnly(m.id)
            unlinkSelected()
            clipMenu.value = null
          }}
        >
          Unlink
        </button>
      )}
      <div class="ctxmenu__sep" />
      <button
        class="ctxmenu__item ctxmenu__item--danger"
        onClick={() => {
          if (isSelected(m.id) && selectedClips.value.length > 1) removeSelected()
          else removeClip(m.id)
          clipMenu.value = null
        }}
      >
        {isSelected(m.id) && selectedClips.value.length > 1 ? `Delete ${selectedClips.value.length}` : 'Delete'}
      </button>
    </div>
  )
}

function Lane({ track }: { track: Track }) {
  const ref = useRef<HTMLDivElement>(null)
  const over = !!dragAsset.value && dragOverTrack.value === track.id

  const drop = (e: PointerEvent) => {
    const a = dragAsset.value
    if (!a) return
    const rect = ref.current?.getBoundingClientRect()
    const start = Math.max(0, e.clientX - (rect?.left ?? 0)) / pps()
    probeDuration(a.url, a.kind).then((dur) => {
      // video/audio are capped to their file length; images/other stretch freely
      const capped = a.kind === 'video' || a.kind === 'audio'
      addClip(track.id, a.id, start, dur, capped ? dur : undefined)
    })
  }

  return (
    <div
      ref={ref}
      class={'tl-lane' + (over ? ' is-drop' : '')}
      data-track={track.id}
      style={{ height: `${track.height ?? TRACK_H}px` }}
      onPointerMove={() => {
        if (dragAsset.value) dragOverTrack.value = track.id
      }}
      onPointerLeave={() => {
        if (dragOverTrack.value === track.id) dragOverTrack.value = null
      }}
      onPointerUp={(e) => drop(e as unknown as PointerEvent)}
    >
      {track.clips.map((c) => (
        <ClipView key={c.id} clip={c} track={track} />
      ))}
    </div>
  )
}

// No tracks yet: the whole area accepts an asset drop (makes the first track).
function EmptyLanes() {
  const ref = useRef<HTMLDivElement>(null)
  const over = !!dragAsset.value
  const drop = (e: PointerEvent) => {
    const a = dragAsset.value
    if (!a) return
    const rect = ref.current?.getBoundingClientRect()
    const start = Math.max(0, e.clientX - (rect?.left ?? 0)) / pps()
    probeDuration(a.url, a.kind).then((dur) => {
      const capped = a.kind === 'video' || a.kind === 'audio'
      snapshot() // one undo step for track + clip
      const id = addTrack(a.kind === 'audio' ? 'audio' : 'video', false)
      addClip(id, a.id, start, dur, capped ? dur : undefined, false)
    })
  }
  return (
    <div
      ref={ref}
      class={'tl__empty' + (over ? ' is-drop' : '')}
      onPointerUp={(e) => drop(e as unknown as PointerEvent)}
    >
      <button class="tl__empty-add" onClick={() => addTrack()} title="Add track">
        <Icon name="add" size={28} />
      </button>
    </div>
  )
}

export function TimelineTool() {
  // when an object is open for animation, the editor replaces the timeline
  return animatingClipId.value ? <AnimationEditor /> : <TimelineMain />
}

function TimelineMain() {
  const tracks = timeline.value.tracks
  const playX = playhead.value * pps()
  const headsRef = useRef<HTMLDivElement>(null)
  const rulerRef = useRef<HTMLDivElement>(null)
  const lanesRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [viewW, setViewW] = useState(0)
  const [band, setBand] = useState<{ l: number; t: number; w: number; h: number } | null>(null)

  // rubber-band select: drag over empty lane area to box-select objects
  const startBand = (e: PointerEvent) => {
    if (e.button !== 0) return
    const el = innerRef.current
    if (!el) return
    // Box coordinates are content-space, and `inner` slides under the pointer
    // while the view auto-scrolls — so its rect has to be re-read every move or
    // the box drifts away from the cursor. The anchor is taken once and stays
    // put, which is what it means for it to be an anchor in the content.
    const rectNow = () => el.getBoundingClientRect()
    const from = rectNow()
    const x0 = e.clientX - from.left
    const y0 = e.clientY - from.top
    const pxs = pps()
    let moved = false
    const hit = (ax: number, ay: number, bx: number, by: number) => {
      const ids: string[] = []
      let top = 0
      for (const t of timeline.value.tracks) {
        const h = t.height ?? TRACK_H
        if (ay < top + h && by > top) {
          for (const c of t.clips) {
            const cx0 = c.start * pxs
            const cx1 = (c.start + c.duration) * pxs
            if (ax < cx1 && bx > cx0) ids.push(c.id)
          }
        }
        top += h
      }
      setSelection(ids)
    }
    const move = (ev: PointerEvent) => {
      moved = true
      const rect = rectNow()
      const x1 = ev.clientX - rect.left
      const y1 = ev.clientY - rect.top
      const l = Math.min(x0, x1)
      const t = Math.min(y0, y1)
      setBand({ l, t, w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) })
      hit(l, t, l + Math.abs(x1 - x0), t + Math.abs(y1 - y0))
    }
    const up = () => {
      if (!moved) clearSelection() // plain click on empty area deselects
      setBand(null)
    }
    // scroll at the edges so the box can reach objects off screen
    onDrag(move, up, { autoScroll: lanesEl.current })
  }

  useEffect(() => {
    const el = lanesRef.current
    if (!el) return
    lanesEl.current = el // clip drags scroll and measure against this
    const ro = new ResizeObserver(() => {
      setViewW(el.clientWidth)
      syncSb(el) // the horizontal scrollbar can appear/vanish on resize too
    })
    ro.observe(el)
    setViewW(el.clientWidth)
    syncSb(el)
    return () => {
      ro.disconnect()
      if (lanesEl.current === el) lanesEl.current = null // don't hold a dead node
    }
  }, [])

  /**
   * Page the timeline to keep the playhead on screen — but only when it LEAVES
   * the view, never to drag the view back to it.
   *
   * Chasing it unconditionally meant the view was pinned to the playhead: scroll
   * somewhere else on purpose, or drag a clip out to the far end, and the next
   * thing to touch the playhead hauled you straight back. If it's already off
   * screen you put it there, so it stays where you left it until playback walks
   * it out of view again.
   */
  const sawPlayhead = useRef(true)
  useEffect(() => {
    return effect(() => {
      const x = playhead.value * pps()
      const el = lanesRef.current
      if (!el) return
      const margin = 40
      const inView = x >= el.scrollLeft && x <= el.scrollLeft + el.clientWidth - margin
      if (!inView && sawPlayhead.current) {
        el.scrollLeft = Math.max(0, x - margin) // it just walked off — follow it
      } else {
        sawPlayhead.current = inView
      }
    })
  }, [])

  // total scrollable width: past the last clip / playhead / project duration, + tail
  const endSec = tracks.reduce((m, t) => t.clips.reduce((mm, c) => Math.max(mm, c.start + c.duration), m), 0)
  const totalSec = Math.max(timeline.value.duration, playhead.value, endSec) + secPerSeg() * 4
  const contentW = Math.max(viewW, totalSec * pps())

  // one scroll drives both: heads follow vertically, ruler follows horizontally
  // .tl__lanes grows a horizontal scrollbar, the gutter never does — that height
  // difference makes the shared scrollTop over-translate the heads and clip the
  // last row, so mirror the scrollbar height as a gutter spacer.
  const sbRef = useRef<HTMLDivElement>(null)
  const syncSb = (el: HTMLElement) => {
    const sb = el.offsetHeight - el.clientHeight
    if (sbRef.current) sbRef.current.style.height = `${sb}px`
  }

  const sync = (e: Event) => {
    const el = e.target as HTMLElement
    poke() // panning counts as a gesture too — hold detail until it settles
    if (headsRef.current) headsRef.current.style.transform = `translateY(${-el.scrollTop}px)`
    if (rulerRef.current) rulerRef.current.style.transform = `translateX(${-el.scrollLeft}px)`
    // Scrolling is how the playhead usually goes off screen, and it doesn't
    // touch the playhead signal — so record it here rather than waiting for the
    // effect above, which wouldn't run again until the playhead itself moved.
    // peek: an event handler has nothing to subscribe to.
    const x = playhead.peek() * pps()
    sawPlayhead.current = x >= el.scrollLeft && x <= el.scrollLeft + el.clientWidth
    syncSb(el)
  }

  return (
    <div class="tl">
      <TopBar />
      <div class="tl__body">
        <div class="tl__gutter">
          <div class="tl__corner" />
          {/* .tl__heads is the clipping viewport and must NOT move; the inner
              wrapper is what gets translated to follow the lane scroll */}
          <div class="tl__heads">
            <div class="tl__headsinner" ref={headsRef}>
              {tracks.map((t) => (
                <TrackHead key={t.id} track={t} />
              ))}
            {/* last row INSIDE the scrolling heads, the same height as
                .tl__newlane on the lane side. Both columns then have identical
                content AND viewport height, so every lane has a visible head and
                this row is exactly reachable at full scroll. */}
              {tracks.length > 0 && (
                <button class="tl__addrow" onClick={() => addTrack()}>
                  <Icon name="add" size={16} /> Add track
                </button>
              )}
            </div>
          </div>
          <div class="tl__sbspacer" ref={sbRef} />
        </div>
        <div class="tl__right">
          <div class="tl__rulerclip">
            <div class="tl__rulermove" ref={rulerRef}>
              <Ruler width={contentW} scroller={lanesRef} />
              <div class="tl-playhead tl-playhead--ruler" style={{ left: `${playX}px` }} />
            </div>
          </div>
          <div class="tl__lanes" ref={lanesRef} onScroll={sync}>
            {tracks.length === 0 ? (
              <EmptyLanes />
            ) : (
              <div
                class="tl__lanesinner"
                ref={innerRef}
                style={{ width: `${contentW}px` }}
                onPointerDown={(e) => startBand(e as unknown as PointerEvent)}
              >
                {tracks.map((t) => (
                  <Lane key={t.id} track={t} />
                ))}
                <GapBands />
                {/* drag an object here to drop it onto a fresh track */}
                <div class={'tl__newlane' + (newTrackHint.value ? ' is-hint' : '')} data-newtrack>
                  <Icon name="add" size={16} />
                </div>
                <div class="tl-playhead" style={{ left: `${playX}px` }} />
                {band && (
                  <div
                    class="tl-rubber"
                    style={{ left: `${band.l}px`, top: `${band.t}px`, width: `${band.w}px`, height: `${band.h}px` }}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
