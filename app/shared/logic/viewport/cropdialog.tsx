// Crop editor dialog: a flat 2D view of the selected object with a movable /
// resizable crop rectangle. Left rail picks an aspect ratio (and locks it so
// resizing keeps the ratio); Apply writes the crop properties (cropL/R/T/B) as
// fractional insets so the object's visible region matches the drawn rectangle.
import { signal } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Icon } from '../ui/icon'
import { currentProject } from '../project/project'
import { timeline, snapshot, playhead, type Clip } from '../timeline/timeline'
import { applyProp } from '../timeline/anim'
import { assets } from '../tools/files/assets'
import { onDrag } from '../ui/pointerdrag'

const cropDialog = signal<{ clipId: string } | null>(null)
export function openCrop(clipId: string) {
  cropDialog.value = { clipId }
}

// [label, pixel aspect ratio | null(free)]
const CROP_RATIOS: [string, number | null][] = [
  ['Free', null],
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
  ['4:3', 4 / 3],
  ['1:1', 1],
  ['21:9', 21 / 9],
  ['3:4', 3 / 4],
  ['2:3', 2 / 3],
]

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const MIN = 0.03 // smallest crop rect (fraction) so it stays grabbable

type Rect = { l: number; t: number; w: number; h: number }

export function CropDialog() {
  const d = cropDialog.value
  if (!d) return null
  // remount per target so internal state re-inits cleanly
  return <CropInner key={d.clipId} clipId={d.clipId} />
}

function CropInner({ clipId }: { clipId: string }) {
  const project = currentProject.value
  const clip = findClip(clipId)
  const asset = clip ? assets.value.find((a) => a.id === clip.assetId) : null
  const stageRef = useRef<HTMLDivElement>(null)
  const vidRef = useRef<HTMLVideoElement>(null)

  const baseW = clip?.w ?? project?.width ?? 16
  const baseH = clip?.h ?? project?.height ?? 9
  const fullAspect = baseW / baseH // pixel aspect of the whole media

  const [rect, setRect] = useState<Rect>(() => ({
    l: clip?.cropL ?? 0,
    t: clip?.cropT ?? 0,
    w: 1 - (clip?.cropL ?? 0) - (clip?.cropR ?? 0),
    h: 1 - (clip?.cropT ?? 0) - (clip?.cropB ?? 0),
  }))
  const [ratio, setRatio] = useState<number | null>(null) // target pixel ratio
  const [locked, setLocked] = useState(false)
  // guide lines (fraction positions) drawn while snapping
  const [snapLines, setSnapLines] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] })

  // seek a video preview to the object's in-point so cropping matches the frame
  useEffect(() => {
    const v = vidRef.current
    if (v && clip) v.currentTime = (clip.in ?? 0) + Math.max(0, playhead.value - clip.start)
  }, [clip])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!project || !clip || !asset) {
    cropDialog.value = null
    return null
  }

  const close = () => (cropDialog.value = null)

  const pickRatio = (r: number | null) => {
    setRatio(r)
    if (r == null) {
      setLocked(false)
      return
    }
    setLocked(true)
    // centred, maximal rect of that pixel ratio inside the media
    let w: number, h: number
    if (fullAspect > r) {
      h = 1
      w = r / fullAspect
    } else {
      w = 1
      h = fullAspect / r
    }
    setRect({ l: (1 - w) / 2, t: (1 - h) / 2, w, h })
  }

  // fraction delta from a pointer drag over the stage
  const fracDelta = (dxPx: number, dyPx: number) => {
    const r = stageRef.current!.getBoundingClientRect()
    return [dxPx / r.width, dyPx / r.height] as const
  }

  // begin a drag; the rect at press-time is captured as the base for the whole
  // gesture so deltas never accumulate across separate drags
  const startDrag = (onMove: (fx: number, fy: number, base: Rect) => void) => (e: Event) => {
    const pe = e as unknown as PointerEvent
    pe.stopPropagation()
    pe.preventDefault()
    if (pe.button !== 0) return
    const sx = pe.clientX
    const sy = pe.clientY
    const base = rect
    const move = (ev: PointerEvent) => {
      const [fx, fy] = fracDelta(ev.clientX - sx, ev.clientY - sy)
      onMove(fx, fy, base)
    }
    const up = () => {
      setSnapLines({ x: [], y: [] })
    }
    onDrag(move, up)
  }

  // snap targets: media sides + centre line, on each axis
  const CAND = [0, 0.5, 1]
  const SNAPF = 0.02
  // snap a single coordinate to the nearest candidate → [value, matchedLine|null]
  const snap1 = (v: number): [number, number | null] => {
    for (const c of CAND) if (Math.abs(v - c) < SNAPF) return [c, c]
    return [v, null]
  }
  // snap a moving box on one axis by testing its start/centre/end edges
  const snapBox = (start: number, size: number): [number, number | null] => {
    for (const off of [0, size / 2, size])
      for (const c of CAND) if (Math.abs(start + off - c) < SNAPF) return [c - off, c]
    return [start, null]
  }

  // move the whole rect (snaps left/centre/right + top/centre/bottom)
  const onBody = startDrag((fx, fy, r0) => {
    let [l, gx] = snapBox(r0.l + fx, r0.w)
    let [t, gy] = snapBox(r0.t + fy, r0.h)
    l = Math.max(0, Math.min(l, 1 - r0.w))
    t = Math.max(0, Math.min(t, 1 - r0.h))
    setRect({ ...r0, l, t })
    setSnapLines({ x: gx == null ? [] : [gx], y: gy == null ? [] : [gy] })
  })

  // resize from a handle (dirX/dirY in -1|0|1). Snaps the dragged edge/corner;
  // keeps the pixel ratio if locked.
  const onResize = (dirX: number, dirY: number) =>
    startDrag((fx, fy, r0) => {
      let left = r0.l
      let right = r0.l + r0.w
      let top = r0.t
      let bottom = r0.t + r0.h
      const gx: number[] = []
      const gy: number[] = []
      if (dirX < 0) {
        const [v, g] = snap1(r0.l + fx)
        left = v
        if (g != null) gx.push(g)
      } else if (dirX > 0) {
        const [v, g] = snap1(r0.l + r0.w + fx)
        right = v
        if (g != null) gx.push(g)
      }
      if (dirY < 0) {
        const [v, g] = snap1(r0.t + fy)
        top = v
        if (g != null) gy.push(g)
      } else if (dirY > 0) {
        const [v, g] = snap1(r0.t + r0.h + fy)
        bottom = v
        if (g != null) gy.push(g)
      }
      let l = left
      let t = top
      let w = right - left
      let h = bottom - top
      if (locked && ratio) {
        if (dirX !== 0) {
          const nh = (w * fullAspect) / ratio
          if (dirY < 0) t = r0.t + r0.h - nh
          else if (dirY === 0) t = r0.t + (r0.h - nh) / 2
          h = nh
        } else if (dirY !== 0) {
          const nw = (h * ratio) / fullAspect
          if (dirX < 0) l = r0.l + r0.w - nw
          else if (dirX === 0) l = r0.l + (r0.w - nw) / 2
          w = nw
        }
      }
      // clamp size + keep inside [0,1]
      w = Math.max(MIN, w)
      h = Math.max(MIN, h)
      l = clamp01(Math.min(l, 1 - MIN))
      t = clamp01(Math.min(t, 1 - MIN))
      if (l + w > 1) w = 1 - l
      if (t + h > 1) h = 1 - t
      setRect({ l, t, w, h })
      setSnapLines({ x: gx, y: gy })
    })

  const apply = () => {
    snapshot()
    applyProp(clipId, 'cropL', clamp01(rect.l), false)
    applyProp(clipId, 'cropR', clamp01(1 - (rect.l + rect.w)), false)
    applyProp(clipId, 'cropT', clamp01(rect.t), false)
    applyProp(clipId, 'cropB', clamp01(1 - (rect.t + rect.h)), false)
    close()
  }
  const reset = () => {
    setRatio(null)
    setLocked(false)
    setRect({ l: 0, t: 0, w: 1, h: 1 })
  }

  const pct = (v: number) => `${v * 100}%`
  const HANDLES: [number, number, string][] = [
    [-1, -1, 'nwse-resize'],
    [1, -1, 'nesw-resize'],
    [-1, 1, 'nesw-resize'],
    [1, 1, 'nwse-resize'],
    [0, -1, 'ns-resize'],
    [0, 1, 'ns-resize'],
    [-1, 0, 'ew-resize'],
    [1, 0, 'ew-resize'],
  ]

  return (
    <div class="crop" onMouseDown={close}>
      <div class="crop__panel" onMouseDown={(e) => e.stopPropagation()}>
        <aside class="crop__side">
          <div class="crop__title">Crop</div>
          <div class="crop__label">Aspect ratio</div>
          <div class="crop__ratios">
            {CROP_RATIOS.map(([label, r]) => (
              <button
                key={label}
                class={'crop__ratio' + (ratio === r ? ' is-active' : '')}
                onClick={() => pickRatio(r)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            class={'crop__lock' + (locked ? ' is-on' : '')}
            disabled={ratio == null}
            title={locked ? 'Ratio locked while resizing' : 'Ratio unlocked'}
            onClick={() => setLocked((v) => !v)}
          >
            <Icon name={locked ? 'lock' : 'lock_open'} size={14} />
            {locked ? 'Ratio locked' : 'Ratio free'}
          </button>
          <button class="crop__reset" onClick={reset}>
            Reset
          </button>
          <div class="crop__spacer" />
          <div class="crop__actions">
            <button class="crop__btn" onClick={close}>
              Cancel
            </button>
            <button class="crop__btn crop__btn--primary" onClick={apply}>
              Apply
            </button>
          </div>
        </aside>

        <div class="crop__stage-wrap">
          <div class="crop__stage" ref={stageRef} style={{ aspectRatio: `${baseW} / ${baseH}` }}>
            {asset.kind === 'video' ? (
              <video class="crop__media" ref={vidRef} src={asset.url} muted playsInline />
            ) : (
              <img class="crop__media" src={asset.url} alt="" draggable={false} />
            )}
            {(snapLines.x.length > 0 || snapLines.y.length > 0) && (
              <div class="crop__guides">
                {snapLines.x.map((x, i) => (
                  <div key={'x' + i} class="crop__guide crop__guide--v" style={{ left: pct(x) }} />
                ))}
                {snapLines.y.map((y, i) => (
                  <div key={'y' + i} class="crop__guide crop__guide--h" style={{ top: pct(y) }} />
                ))}
              </div>
            )}
            <div
              class="crop__rect"
              style={{ left: pct(rect.l), top: pct(rect.t), width: pct(rect.w), height: pct(rect.h) }}
              onPointerDown={onBody as unknown as (e: Event) => void}
            >
              <div class="crop__thirds" />
              {HANDLES.map(([dx, dy, cur]) => (
                <span
                  key={`${dx},${dy}`}
                  class="crop__h"
                  style={{
                    left: dx < 0 ? '0' : dx > 0 ? '100%' : '50%',
                    top: dy < 0 ? '0' : dy > 0 ? '100%' : '50%',
                    cursor: cur,
                  }}
                  onPointerDown={onResize(dx, dy) as unknown as (e: Event) => void}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function findClip(id: string): Clip | null {
  for (const tr of timeline.value.tracks) for (const c of tr.clips) if (c.id === id) return c
  return null
}
