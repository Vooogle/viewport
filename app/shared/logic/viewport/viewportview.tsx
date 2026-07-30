// Viewport panel: a 3D camera view (static by default) over a transport bar.
// The camera doesn't move unless a tool grabs it later; objects live in 3D space.
// Right of the transport: an aspect/resolution popover (like the New Project dialog).
import { signal } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Icon } from '../ui/icon'
import {
  currentProject,
  updateProject,
  RATIOS,
  PRESETS,
  FPS_PRESETS,
  type Project,
} from '../project/project'
import {
  playhead,
  contentEnd,
  playing,
  togglePlay,
  seekBy,
  jumpToEdge,
  timeline,
  selectedClipId,
  selectOnly,
  snapshot,
  openClipMenu,
  isText,
  type Clip,
} from '../timeline/timeline'
import { sampleClip, applyProp, animatingClipId, animPlayhead } from '../timeline/anim'
import { assets } from '../tools/files/assets'
import { mediaExclusive } from '../media/exclusive'
import { loadGoogleFont } from '../text/fonts'
import { prefs, setPref } from '../prefs/preferences'
import { onDrag } from '../ui/pointerdrag'
import { createRenderer } from '../render/scene'
import { previewProxies, ensurePreviewProxies } from '../render/proxies'

// which transform a viewport drag edits; clicking a selected object cycles it.
// scale = standard 2D (move body + resize handles); rotate = 3-axis; move = 3D
type VpMode = 'scale' | 'rotate' | 'move'
export const vpMode = signal<VpMode>('scale')
const MODES: VpMode[] = ['scale', 'rotate', 'move']
/** Preview render scales. Fractions of the on-screen size, not of the project. */
const PREVIEW_SCALES = [1, 0.75, 0.5, 0.25]
const MODE_LABEL: Record<VpMode, string> = { scale: 'Transform', rotate: 'Rotate', move: '3D Move' }
function cycleMode() {
  vpMode.value = MODES[(MODES.indexOf(vpMode.value) + 1) % MODES.length]
}

// active snap guide lines while dragging (project-space X columns / Y rows).
// rendered as thin lines across the view so the user sees what they snapped to.
const snapGuides = signal<{ x: number[]; y: number[] }>({ x: [], y: [] })

// snap candidates in VIEW-PIXEL (screen) space — matches the flat 2D handles the
// user sees. Frame sides + centre, plus each other object's PROJECTED bounding
// box (min/centre/max of its projected corners). Rotation & perspective included.
function screenCands(excludeId: string, project: Project, fit: number): { x: number[]; y: number[] } {
  const viewW = project.width * fit
  const viewH = project.height * fit
  const x = [0, viewW / 2, viewW]
  const y = [0, viewH / 2, viewH]
  const t = playhead.value
  for (const tr of timeline.value.tracks)
    for (const c of tr.clips)
      if (c.id !== excludeId && !c.audioOnly && t >= c.start && t < c.start + c.duration) {
        const lc = t - c.start
        const pr = projector(c, lc, project, fit)
        const cm = cropMap(c, lc)
        const cs = [pr(...cm(-1, -1)), pr(...cm(1, -1)), pr(...cm(1, 1)), pr(...cm(-1, 1))]
        const ctr = pr(...cm(0, 0))
        const lefts = cs.map((p) => p.left)
        const tops = cs.map((p) => p.top)
        x.push(Math.min(...lefts), ctr.left, Math.max(...lefts))
        y.push(Math.min(...tops), ctr.top, Math.max(...tops))
      }
  return { x, y }
}

const SNAP_PX = 8 // snap distance, in screen pixels (constant on-screen feel)

// Screen-space move snap. `probesX/Y` are the object's start-of-drag projected
// edge/centre positions (px); moving x by 1 project-unit shifts the screen by
// `k` px. Returns the snapped nx/ny (project units) + matched guide lines (px).
function snapScreenMove(
  probesX: number[], probesY: number[],
  x0: number, y0: number, k: number,
  nx: number, ny: number,
  cands: { x: number[]; y: number[] },
): { nx: number; ny: number; gx: number[]; gy: number[] } {
  const gx: number[] = []
  const gy: number[] = []
  const shiftX = (nx - x0) * k
  loopX: for (const p of probesX)
    for (const cd of cands.x)
      if (Math.abs(p + shiftX - cd) < SNAP_PX) {
        nx = x0 + (cd - p) / k
        gx.push(cd)
        break loopX
      }
  const shiftY = (ny - y0) * k
  loopY: for (const p of probesY)
    for (const cd of cands.y)
      if (Math.abs(p + shiftY - cd) < SNAP_PX) {
        ny = y0 + (cd - p) / k
        gy.push(cd)
        break loopY
      }
  return { nx, ny, gx, gy }
}

// modifier snapping: Shift = free, Ctrl = logical segments, default = fine snap
const gridOf = (p: Project) => Math.max(p.width, p.height) / 24
function snapAngle(deg: number, ev: { shiftKey: boolean; ctrlKey: boolean }): number {
  if (ev.shiftKey) return deg
  return ev.ctrlKey ? Math.round(deg / 45) * 45 : Math.round(deg / 15) * 15
}

/** default plane size when a clip has no explicit w/h: the media's natural size
 *  fit INSIDE the frame preserving aspect (so images aren't stretched). Falls
 *  back to the project resolution until the asset's dimensions are probed. */
function naturalFit(clip: Clip, project: Project): { w: number; h: number } {
  const a = assets.value.find((x) => x.id === clip.assetId)
  if (a?.width && a?.height) {
    const s = Math.min(project.width / a.width, project.height / a.height)
    return { w: a.width * s, h: a.height * s }
  }
  return { w: project.width, h: project.height }
}
/** effective width/height for a clip. */
function planeSize(clip: Clip, local: number, project: Project) {
  const hasW = clip.w != null || clip.anim?.w
  const hasH = clip.h != null || clip.anim?.h
  if (!hasW && !hasH) return naturalFit(clip, project) // neither set → natural aspect
  const nat = hasW && hasH ? null : naturalFit(clip, project)
  return {
    w: hasW ? sampleClip(clip, 'w', local) : nat!.w,
    h: hasH ? sampleClip(clip, 'h', local) : nat!.h,
  }
}
/** map a normalized handle coord (u,v in [-1..1] over the VISIBLE/cropped rect)
 *  to plane-local coords (lx,ly in [-1..1] over the full plane). So the gizmo +
 *  handles wrap the cropped item, not the whole uncropped plane. */
function cropMap(clip: Clip, local: number): (u: number, v: number) => [number, number] {
  const cl = sampleClip(clip, 'cropL', local)
  const cr = sampleClip(clip, 'cropR', local)
  const ct = sampleClip(clip, 'cropT', local)
  const cb = sampleClip(clip, 'cropB', local)
  return (u, v) => [-1 + 2 * cl + (u + 1) * (1 - cr - cl), -1 + 2 * ct + (v + 1) * (1 - cb - ct)]
}

/** Point-in-quad. A projected rectangle stays convex, so a consistent
 *  cross-product sign on all four edges means the point is inside. */
function inQuad(px: number, py: number, q: { left: number; top: number }[]): boolean {
  let neg = false
  let pos = false
  for (let i = 0; i < 4; i++) {
    const a = q[i]
    const b = q[(i + 1) % 4]
    const d = (px - a.left) * (b.top - a.top) - (py - a.top) * (b.left - a.left)
    if (d < -1e-6) neg = true
    else if (d > 1e-6) pos = true
    if (neg && pos) return false
  }
  return true
}

/**
 * The preview picture: one canvas, drawn by the SAME renderer the export uses.
 *
 * It used to be a stack of CSS-3D planes — which meant the preview and the
 * export were two separate implementations of one picture, and they drifted
 * four separate times (underline, letter spacing, curve, warp, text background).
 * Sharing the renderer makes a difference between them inexpressible, and it is
 * what lets colour grading be written once.
 *
 * Interaction stays in the DOM. Handles, gizmos and snap guides sit on top and
 * place themselves from `projector`, which is maths and never needed the planes
 * to be elements. Only picking had to be rebuilt: a canvas has nothing for a
 * click to land on, so the topmost quad containing the point wins.
 */
function ScenePreview({
  project,
  w,
  h,
  visible,
  fit,
  exportOwnsMedia,
  hold,
  renderScale,
}: {
  project: Project
  w: number
  h: number
  visible: { clip: Clip; local: number }[]
  fit: number
  exportOwnsMedia: boolean
  /** object the animation editor is scrubbing, shown outside its range */
  hold: { clipId: string; local: number } | null
  /** canvas pixels per on-screen pixel */
  renderScale: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  // read in render so the loop below re-subscribes to what should redraw it
  const t = playhead.value
  const isPlaying = playing.value

  /**
   * What forces the renderer to be REBUILT, as opposed to merely redrawn.
   *
   * It resolves its media once at construction, so it must be rebuilt when the
   * set of sources the TIMELINE references changes — and only then. Every
   * rebuild is a new WebGL context, and past the browser's limit it starts
   * dropping the oldest, after which the next compile fails and the viewport
   * goes blank.
   *
   * Deliberately over the whole timeline rather than what is on screen now:
   * keying it to the visible clips meant scrubbing across a cut changed the
   * key, so moving the playhead rebuilt the renderer.
   */
  const proxies = previewProxies.value
  const sceneKey = (() => {
    const ids = new Set<string>()
    for (const tr of timeline.value.tracks)
      for (const c of tr.clips) if (c.assetId) ids.add(c.assetId)
    return [...ids]
      .map((id) => {
        // both: the original identifies the source (so relinking rebuilds), the
        // proxy is what the renderer will actually open once one exists
        const orig = assets.value.find((a) => a.id === id)?.url ?? ''
        return `${id}|${orig}|${proxies[id]?.url ?? ''}`
      })
      .sort()
      .join(',')
  })()

  const latest = useRef({ t, isPlaying, hold })
  latest.current = { t, isPlaying, hold }
  /**
   * Something this component reads has changed, so the picture may be stale.
   *
   * Set on every render — the component subscribes to the playhead, the
   * timeline, the assets and the editor state, so a re-render IS the signal
   * that a redraw is due. Without it the loop redrew the whole scene sixty
   * times a second at rest, for a picture nobody had changed.
   */
  const dirty = useRef(true)
  dirty.current = true
  /** bumped to rebuild after the GPU hands a lost context back */
  const [gen, setGen] = useState(0)
  /**
   * Everything that requires a NEW renderer, as one string.
   *
   * It keys the canvas element and is the effect's only dependency, so the two
   * can't drift. They did: `exportOwnsMedia` was a dependency but not part of
   * the key, so releasing the pipeline after an export re-ran the effect on the
   * same canvas — whose context the teardown had explicitly lost, and a canvas
   * never recovers from that on its own.
   */
  const buildKey = `${project.width}x${project.height}|${w}x${h}@${renderScale}|${exportOwnsMedia}|${gen}|${sceneKey}`

  /**
   * Renderer builds, serialised.
   *
   * `createRenderer` is async — it awaits its images before compiling — so two
   * builds could overlap, and the first one's teardown would call loseContext
   * on the canvas the second was still using. Chaining means a build never
   * starts until the previous one has been created AND disposed.
   */
  const chain = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    const cv = ref.current
    // While an export owns the media pipeline the preview must not hold
    // decoders — that contention is what quietly costs the export its hardware
    // encoder. The canvas just stays as it was.
    if (!cv || exportOwnsMedia || w < 1 || h < 1) return
    // cap the backing store: a 4K-DPR canvas costs real fill rate for a preview
    // Render scale only changes how many pixels are drawn — the canvas keeps
    // its on-screen size, so a lower setting is a softer picture, not a smaller
    // one. 1 is one canvas pixel per CSS pixel; device pixel ratio is
    // deliberately not applied, since paying 4x the fill rate for a preview is
    // exactly what the setting exists to avoid.
    cv.width = Math.max(1, Math.round(w * renderScale))
    cv.height = Math.max(1, Math.round(h * renderScale))

    // Small all-intra stand-ins where one has been built; the renderer falls
    // back to the original for anything not in here.
    const override = new Map(Object.entries(proxies).map(([id, p]) => [id, { url: p.url, fps: p.fps }]))

    let dead = false
    let raf = 0
    let rend: Awaited<ReturnType<typeof createRenderer>> | null = null
    let busy = false

    chain.current = chain.current.then(async () => {
      if (dead) return
      try {
        const r = await createRenderer(cv, project, override, false)
        if (dead) return r.dispose()
        rend = r
      } catch (err) {
        // No renderer means a blank viewport; say why rather than leaving a
        // white rectangle and an unhandled rejection.
        console.error('[viewport] could not start the renderer:', err)
      }
    })

    // A lost context (sleep, driver reset, too many live contexts) leaves the
    // canvas frozen. Rebuild once the browser hands it back.
    const onLost = (e: Event) => {
      e.preventDefault() // keeps the canvas restorable
      rend = null
    }
    const onRestored = () => setGen((g) => g + 1)
    cv.addEventListener('webglcontextlost', onLost)
    cv.addEventListener('webglcontextrestored', onRestored)

    const frame = async () => {
      raf = requestAnimationFrame(frame)
      // one render in flight at a time: render() awaits seeks and decodes, and
      // overlapping calls would fight over the same elements
      if (!rend || busy || dead) return
      // At rest, draw only when something actually moved.
      if (!dirty.current && !latest.current.isPlaying) return
      dirty.current = false
      busy = true
      try {
        // live only while running — paused wants the exact frame, which means
        // seeking, same as an export
        rend.live = latest.current.isPlaying
        rend.hold = latest.current.hold
        rend.measure = false // no phase accounting here; the sync is pure cost
        await rend.render(Math.max(0, latest.current.t))
      } catch {
        /* a lost context or an undecodable source — keep the loop alive */
      } finally {
        busy = false
      }
    }
    raf = requestAnimationFrame(frame)

    return () => {
      dead = true
      cancelAnimationFrame(raf)
      cv.removeEventListener('webglcontextlost', onLost)
      cv.removeEventListener('webglcontextrestored', onRestored)
      // onto the same chain, so the next build waits for this teardown
      chain.current = chain.current.then(() => rend?.dispose())
    }
    // Per-frame values (the playhead, playing) are read through `latest`, so
    // they can never tear the renderer down.
  }, [buildKey])

  // Build the proxies this timeline wants. Fire and forget: each one that
  // lands changes `sceneKey`, which rebuilds the renderer pointing at it.
  // `isPlaying` is a dependency because the sweep refuses to run during
  // playback (a transcode is the heaviest thing on the machine). Without it,
  // anything skipped for that reason waited for an unrelated timeline change
  // before it was ever built again.
  useEffect(() => {
    if (exportOwnsMedia) return
    void ensurePreviewProxies(project)
  }, [sceneKey, exportOwnsMedia, isPlaying, project.width, project.height])

  /** Topmost object under the pointer, or null for the empty frame. */
  const pick = (e: PointerEvent): { clip: Clip; local: number } | null => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return null
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    for (const v of visible) {
      const pr = projector(v.clip, v.local, project, fit)
      const cm = cropMap(v.clip, v.local)
      const quad = [pr(...cm(-1, -1)), pr(...cm(1, -1)), pr(...cm(1, 1)), pr(...cm(-1, 1))]
      if (inQuad(px, py, quad)) return v
    }
    return null
  }

  return (
    <canvas
      // A fresh element per build. dispose() explicitly loses the context, and
      // a canvas that has been through that won't hand out a working one again
      // — so the old element is discarded rather than reused.
      key={buildKey}
      class="vp__canvas"
      ref={ref}
      style={{ width: `${w}px`, height: `${h}px` }}
      onPointerDown={(e) => {
        const hit = pick(e as unknown as PointerEvent)
        if (!hit) return selectOnly(null)
        objectPointer(hit.clip, hit.local, project, fit).onDown(e as unknown as Event)
      }}
      onContextMenu={(e) => {
        const hit = pick(e as unknown as unknown as PointerEvent)
        if (hit) objectPointer(hit.clip, hit.local, project, fit).onMenu(e as unknown as Event)
      }}
    />
  )
}

function objectPointer(clip: Clip, local: number, project: Project, fit: number) {
  const sv = (k: string) => sampleClip(clip, k, local)
  const onDown = ((e: PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.button !== 0) return
    const wasSel = selectedClipId.value === clip.id
    if (!wasSel) selectOnly(clip.id)
    const sx = e.clientX
    const sy = e.clientY
    const ox = sv('x')
    const oy = sv('y')
    const pr = projector(clip, local, project, fit)
    const cm = cropMap(clip, local)
    const corners = [pr(...cm(-1, -1)), pr(...cm(1, -1)), pr(...cm(1, 1)), pr(...cm(-1, 1))]
    const ctr = pr(...cm(0, 0))
    const lefts = corners.map((c) => c.left)
    const tops = corners.map((c) => c.top)
    const probesX = [Math.min(...lefts), ctr.left, Math.max(...lefts)]
    const probesY = [Math.min(...tops), ctr.top, Math.max(...tops)]
    const cands = screenCands(clip.id, project, fit)
    const Pp = Math.max(project.width, project.height)
    const z0 = sv('z')
    const k = (Pp / Math.max(Pp - z0, Pp * 0.05)) * fit
    let moved = false
    let dirty = false
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx
      const dy = ev.clientY - sy
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return
      moved = true
      if (!dirty) {
        snapshot()
        dirty = true
      }
      let nx = ox + dx / fit
      let ny = oy + dy / fit
      let gx: number[] = []
      let gy: number[] = []
      if (ev.shiftKey) {
        /* free */
      } else if (ev.ctrlKey) {
        const g = gridOf(project)
        nx = Math.round(nx / g) * g
        ny = Math.round(ny / g) * g
      } else {
        const r = snapScreenMove(probesX, probesY, ox, oy, k, nx, ny, cands)
        nx = r.nx
        ny = r.ny
        gx = r.gx
        gy = r.gy
      }
      snapGuides.value = { x: gx, y: gy }
      applyProp(clip.id, 'x', nx, false)
      applyProp(clip.id, 'y', ny, false)
    }
    const up = () => {
      snapGuides.value = { x: [], y: [] }
      if (!moved && wasSel) cycleMode()
    }
    onDrag(move, up)
  }) as unknown as (e: Event) => void
  const onMenu = ((e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (selectedClipId.value !== clip.id) selectOnly(clip.id)
    openClipMenu(e.clientX, e.clientY, clip.id)
  }) as unknown as (e: Event) => void
  return { onDown, onMenu }
}

const D = Math.PI / 180

// Project a plane-local point (lx,ly in [-1..1] of the half-size) to view-pixel
// coords, replicating the CSS perspective so FLAT handles sit exactly on the 3D
// plane's corners — constant screen size, always grabbable regardless of tilt.
function projector(clip: Clip, local: number, project: Project, fit: number) {
  const sv = (k: string) => sampleClip(clip, k, local)
  const rx = sv('rotX') * D
  const ry = sv('rotY') * D
  const rz = sv('rotZ') * D
  const s = sv('scale')
  const tx = sv('x')
  const ty = sv('y')
  const tz = sv('z')
  const size = planeSize(clip, local, project)
  const P = Math.max(project.width, project.height)
  const viewW = project.width * fit
  const viewH = project.height * fit
  // lx,ly are plane-local in [-1..1]; w/h default to the plane's size but can be
  // overridden (finite-difference resize snapping projects hypothetical sizes)
  return (lx: number, ly: number, offX = 0, offY = 0, w = size.w, h = size.h) => {
    let x = ((lx * w) / 2) * s
    let y = ((ly * h) / 2) * s
    let z = 0
    let c = Math.cos(rz)
    let sn = Math.sin(rz)
    ;[x, y] = [x * c - y * sn, x * sn + y * c]
    c = Math.cos(ry)
    sn = Math.sin(ry)
    ;[x, z] = [x * c + z * sn, -x * sn + z * c]
    c = Math.cos(rx)
    sn = Math.sin(rx)
    ;[y, z] = [y * c - z * sn, y * sn + z * c]
    x += tx
    y += ty
    z += tz
    const f = P / Math.max(P - z, P * 0.05) // perspective divide
    return { left: viewW / 2 + x * f * fit + offX, top: viewH / 2 + y * f * fit + offY }
  }
}

// Flat handle overlay (in the 2D view) — handles positioned at the projected
// corners; drag maths use screen delta so tilt/perspective don't fight grabbing.
function HandlesOverlay({ clip, local, project, fit }: { clip: Clip; local: number; project: Project; fit: number }) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const mode = vpMode.value
  const size = planeSize(clip, local, project)
  const grid = gridOf(project)
  const sv = (k: string) => sampleClip(clip, k, local)
  const set = (k: string, v: number) => applyProp(clip.id, k, v, false)
  const proj = projector(clip, local, project, fit)
  const cm = cropMap(clip, local)
  // projected VISIBLE (cropped) box coord: u,v in [-1..1] over the cropped rect,
  // so the gizmo box + handles wrap the cropped item and line up with each other
  const projV = (u: number, v: number, offX = 0, offY = 0, w = size.w, h = size.h) => {
    const [lx, ly] = cm(u, v)
    return proj(lx, ly, offX, offY, w, h)
  }
  // all snapping is done in SCREEN space against the projected 2D handles, so it
  // matches exactly what the user sees (rotation + perspective included)
  const cands = screenCands(clip.id, project, fit)

  // live screen position of the (sxDir,syDir) handle for a hypothetical w/h.
  // computed relative to the anchored opposite corner `A` (whose screen position
  // is fixed during the resize), so the centre shift doesn't corrupt it.
  const handleScreen = (sxDir: number, syDir: number, w: number, h: number, A: { left: number; top: number }) => {
    const m = projV(sxDir, syDir, 0, 0, w, h)
    const a = projV(-sxDir, -syDir, 0, 0, w, h)
    return { left: A.left + (m.left - a.left), top: A.top + (m.top - a.top) }
  }
  // try to snap the dragged handle along one axis by adjusting its size (w for x,
  // h for y). Uses a finite difference so it works under any rotation/perspective.
  const snapAxisScreen = (
    axis: 'x' | 'y', sxDir: number, syDir: number, w: number, h: number, A: { left: number; top: number },
  ): { size: number; line: number; dist: number } | null => {
    const cur0 = handleScreen(sxDir, syDir, w, h, A)
    const cur = axis === 'x' ? cur0.left : cur0.top
    const bumped = axis === 'x' ? handleScreen(sxDir, syDir, w + 1, h, A).left : handleScreen(sxDir, syDir, w, h + 1, A).top
    const d1 = bumped - cur // screen px per +1 size unit
    if (d1 === 0) return null
    const list = axis === 'x' ? cands.x : cands.y
    let best: number | null = null
    let bestd = SNAP_PX
    for (const cd of list) {
      const dd = Math.abs(cur - cd)
      if (dd < bestd) { bestd = dd; best = cd }
    }
    if (best == null) return null
    return { size: (axis === 'x' ? w : h) + (best - cur) / d1, line: best, dist: bestd }
  }

  const drag = (onMove: (dx: number, dy: number, ev: PointerEvent) => void) => (e: Event) => {
    const pe = e as unknown as PointerEvent
    pe.stopPropagation()
    pe.preventDefault()
    if (pe.button !== 0) return
    const sx = pe.clientX
    const sy = pe.clientY
    let dirty = false
    const move = (ev: PointerEvent) => {
      if (!dirty) {
        snapshot()
        dirty = true
      }
      onMove(ev.clientX - sx, ev.clientY - sy, ev)
    }
    const up = () => {
      snapGuides.value = { x: [], y: [] }
    }
    onDrag(move, up)
  }

  const cornerResize = (sxDir: number, syDir: number) => {
    const w0 = size.w, h0 = size.h, x0 = sv('x'), y0 = sv('y')
    // anchored (opposite) edges stay put as the dragged corner moves
    const fixedX = x0 - (sxDir * w0) / 2
    const fixedY = y0 - (syDir * h0) / 2
    const A = projV(-sxDir, -syDir) // anchored corner screen pos (fixed)
    return drag((dx, dy, ev) => {
      let w = w0 + sxDir * (dx / fit)
      let h = h0 + syDir * (dy / fit)
      if (!ev.ctrlKey) {
        // uniform scale (aspect-locked). Pick the single scale factor k that puts
        // the corner as close to the pointer as possible — the projection of the
        // drag onto the resize diagonal. Continuous, so no jump when the drag's
        // dominant axis changes (the old max-of-kw/kh flipped and skipped).
        const a = sxDir * (dx / fit)
        const b = syDir * (dy / fit)
        const k = 1 + (a * w0 + b * h0) / (w0 * w0 + h0 * h0)
        w = w0 * k
        h = h0 * k
      }
      w = Math.max(1, w)
      h = Math.max(1, h)
      const gx: number[] = []
      const gy: number[] = []
      if (!ev.shiftKey) {
        const sX = snapAxisScreen('x', sxDir, syDir, w, h, A)
        const sY = snapAxisScreen('y', sxDir, syDir, w, h, A)
        if (ev.ctrlKey) {
          // free aspect: snap each axis independently
          if (sX) { w = Math.max(1, sX.size); gx.push(sX.line) }
          if (sY) { h = Math.max(1, sY.size); gy.push(sY.line) }
        } else if (sX || sY) {
          // locked aspect: snap the closer edge, derive the other from ratio
          if (sX && (!sY || sX.dist <= sY.dist)) {
            w = Math.max(1, sX.size)
            h = h0 * (w / w0)
            gx.push(sX.line)
          } else if (sY) {
            h = Math.max(1, sY.size)
            w = w0 * (h / h0)
            gy.push(sY.line)
          }
        }
      }
      set('w', w)
      set('x', fixedX + (sxDir * w) / 2)
      set('h', h)
      set('y', fixedY + (syDir * h) / 2)
      snapGuides.value = { x: gx, y: gy }
    })
  }
  const edgeResize = (sxDir: number, syDir: number) => {
    const w0 = size.w, h0 = size.h, x0 = sv('x'), y0 = sv('y')
    const fixedX = x0 - (sxDir * w0) / 2
    const fixedY = y0 - (syDir * h0) / 2
    const A = projV(-sxDir, -syDir) // anchored opposite edge screen pos (fixed)
    return drag((dx, dy, ev) => {
      const gx: number[] = []
      const gy: number[] = []
      if (sxDir) {
        let w = Math.max(1, w0 + sxDir * (dx / fit))
        if (ev.ctrlKey) w = Math.max(1, Math.round(w / grid) * grid)
        else if (!ev.shiftKey) {
          const s = snapAxisScreen('x', sxDir, syDir, w, h0, A)
          if (s) { w = Math.max(1, s.size); gx.push(s.line) }
        }
        set('w', w)
        set('x', fixedX + (sxDir * w) / 2)
      }
      if (syDir) {
        let h = Math.max(1, h0 + syDir * (dy / fit))
        if (ev.ctrlKey) h = Math.max(1, Math.round(h / grid) * grid)
        else if (!ev.shiftKey) {
          const s = snapAxisScreen('y', sxDir, syDir, w0, h, A)
          if (s) { h = Math.max(1, s.size); gy.push(s.line) }
        }
        set('h', h)
        set('y', fixedY + (syDir * h) / 2)
      }
      snapGuides.value = { x: gx, y: gy }
    })
  }
  const tiltX = () => {
    const r0 = sv('rotX')
    return drag((_dx, dy, ev) => set('rotX', snapAngle(r0 - dy * 0.5, ev)))
  }
  const tiltY = () => {
    const r0 = sv('rotY')
    return drag((dx, _dy, ev) => set('rotY', snapAngle(r0 + dx * 0.5, ev)))
  }
  const roll = (e: Event) => {
    const pe = e as unknown as PointerEvent
    pe.stopPropagation()
    pe.preventDefault()
    if (pe.button !== 0) return
    const rect = overlayRef.current!.getBoundingClientRect()
    const ctr = projV(0, 0)
    const cx = rect.left + ctr.left
    const cy = rect.top + ctr.top
    const a0 = Math.atan2(pe.clientY - cy, pe.clientX - cx)
    const r0 = sv('rotZ')
    let dirty = false
    const move = (ev: PointerEvent) => {
      if (!dirty) {
        snapshot()
        dirty = true
      }
      const a = Math.atan2(ev.clientY - cy, ev.clientX - cx)
      set('rotZ', snapAngle(r0 + ((a - a0) * 180) / Math.PI, ev))
    }
    const up = () => {
    }
    onDrag(move, up)
  }
  const depth = () => {
    const z0 = sv('z')
    return drag((_dx, dy, ev) => {
      let z = z0 - dy / fit
      if (ev.ctrlKey) z = Math.round(z / grid) * grid
      set('z', z)
    })
  }
  // axis-aligned screen bounds of the projected plane, with a minimum grab size
  const corners = [projV(-1, -1), projV(1, -1), projV(1, 1), projV(-1, 1)]
  const ctr = projV(0, 0)

  // 2D move of the whole object, in SCREEN space. Attached to a flat proxy over
  // the object's projected bounds so the body is grabbable no matter how the 3D
  // transform has shrunk/moved the plane. Snaps the projected edges/centre to the
  // screen candidates. Click (no drag) cycles the mode.
  const bodyDrag = (e: Event) => {
    const pe = e as unknown as PointerEvent
    pe.stopPropagation()
    pe.preventDefault()
    if (pe.button !== 0) return
    const sx = pe.clientX
    const sy = pe.clientY
    const x0 = sv('x'), y0 = sv('y')
    // projected edge/centre probe positions (px) at drag start
    const lefts = corners.map((c) => c.left)
    const tops = corners.map((c) => c.top)
    const probesX = [Math.min(...lefts), ctr.left, Math.max(...lefts)]
    const probesY = [Math.min(...tops), ctr.top, Math.max(...tops)]
    // how many screen px a 1-unit change in x/y translates to (perspective at z)
    const Pp = Math.max(project.width, project.height)
    const z0 = sv('z')
    const k = (Pp / Math.max(Pp - z0, Pp * 0.05)) * fit
    let moved = false
    let dirty = false
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx
      const dy = ev.clientY - sy
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return
      moved = true
      if (!dirty) {
        snapshot()
        dirty = true
      }
      let nx = x0 + dx / fit
      let ny = y0 + dy / fit
      let gx: number[] = []
      let gy: number[] = []
      if (ev.shiftKey) {
        /* free */
      } else if (ev.ctrlKey) {
        nx = Math.round(nx / grid) * grid
        ny = Math.round(ny / grid) * grid
      } else {
        const r = snapScreenMove(probesX, probesY, x0, y0, k, nx, ny, cands)
        nx = r.nx
        ny = r.ny
        gx = r.gx
        gy = r.gy
      }
      set('x', nx)
      set('y', ny)
      snapGuides.value = { x: gx, y: gy }
    }
    const up = () => {
      snapGuides.value = { x: [], y: [] }
      if (!moved) cycleMode() // click on the selected object → next mode
    }
    onDrag(move, up)
  }

  const MINP = 30
  let bl = Math.min(...corners.map((c) => c.left))
  let br = Math.max(...corners.map((c) => c.left))
  let bt = Math.min(...corners.map((c) => c.top))
  let bb = Math.max(...corners.map((c) => c.top))
  if (br - bl < MINP) { bl = ctr.left - MINP / 2; br = ctr.left + MINP / 2 }
  if (bb - bt < MINP) { bt = ctr.top - MINP / 2; bb = ctr.top + MINP / 2 }
  const bodyBox = { left: bl, top: bt, width: br - bl, height: bb - bt }

  type H = { key: string; at: { left: number; top: number }; cursor: string; title: string; on: (e: Event) => void; extra?: string }
  const handles: H[] = []
  if (mode === 'scale') {
    handles.push(
      { key: 'nw', at: projV(-1, -1), cursor: 'nwse-resize', title: 'Resize', on: cornerResize(-1, -1) },
      { key: 'ne', at: projV(1, -1), cursor: 'nesw-resize', title: 'Resize', on: cornerResize(1, -1) },
      { key: 'sw', at: projV(-1, 1), cursor: 'nesw-resize', title: 'Resize', on: cornerResize(-1, 1) },
      { key: 'se', at: projV(1, 1), cursor: 'nwse-resize', title: 'Resize', on: cornerResize(1, 1) },
      { key: 'n', at: projV(0, -1), cursor: 'ns-resize', title: 'Stretch', on: edgeResize(0, -1) },
      { key: 's', at: projV(0, 1), cursor: 'ns-resize', title: 'Stretch', on: edgeResize(0, 1) },
      { key: 'w', at: projV(-1, 0), cursor: 'ew-resize', title: 'Stretch', on: edgeResize(-1, 0) },
      { key: 'e', at: projV(1, 0), cursor: 'ew-resize', title: 'Stretch', on: edgeResize(1, 0) },
    )
  } else if (mode === 'rotate') {
    handles.push(
      { key: 's', at: projV(0, 1), cursor: 'ns-resize', title: 'Tilt (X)', on: tiltX(), extra: 'vp__h--rot' },
      { key: 'e', at: projV(1, 0), cursor: 'ew-resize', title: 'Turn (Y)', on: tiltY(), extra: 'vp__h--rot' },
      { key: 'roll', at: projV(0, -1, 0, -34), cursor: 'grab', title: 'Roll (Z)', on: roll, extra: 'vp__h--rot' },
    )
  } else {
    // depth knob sits a fixed distance below the centre; the body proxy (below)
    // handles X/Y move, so this stays separate and grabbable when the plane is tiny
    handles.push({ key: 'z', at: projV(0, 0, 0, 46), cursor: 'ns-resize', title: 'Depth (Z) — drag up/down', on: depth(), extra: 'vp__h--axisz' })
  }

  const label = projV(0, -1, 0, -34)
  const rollTop = mode === 'rotate' ? projV(0, -1) : null
  const rollKnob = mode === 'rotate' ? projV(0, -1, 0, -34) : null
  // outline through the projected VISIBLE (cropped) corners — same coords as the
  // handles, so the selection box wraps the cropped item exactly
  const outline = [projV(-1, -1), projV(1, -1), projV(1, 1), projV(-1, 1)]
    .map((p) => `${p.left},${p.top}`)
    .join(' ')
  return (
    <div class={'vp__handles vp__gizmo--' + mode} ref={overlayRef}>
      {/* flat drag proxy over the object's projected bounds — rendered before the
          handles so the handles (later siblings) win the pointer at the edges,
          but the body stays grabbable anywhere no matter the 3D transform */}
      <div
        class="vp__body"
        style={{ left: `${bodyBox.left}px`, top: `${bodyBox.top}px`, width: `${bodyBox.width}px`, height: `${bodyBox.height}px` }}
        onPointerDown={bodyDrag as unknown as (e: Event) => void}
      />
      <svg class="vp__outline">
        <polygon points={outline} />
      </svg>
      <span class="vp__gizmo-mode" style={{ left: `${label.left}px`, top: `${label.top - 14}px` }}>
        {MODE_LABEL[mode]}
      </span>
      {rollTop && rollKnob && (
        <svg class="vp__roll-svg">
          <line x1={rollTop.left} y1={rollTop.top} x2={rollKnob.left} y2={rollKnob.top} />
        </svg>
      )}
      {handles.map((h) => (
        <span
          key={h.key}
          class={'vp__h' + (h.extra ? ' ' + h.extra : '')}
          style={{ left: `${h.at.left}px`, top: `${h.at.top}px`, cursor: h.cursor }}
          title={h.title}
          onPointerDown={h.on}
        />
      ))}
    </div>
  )
}

// snap guide lines (thin accent lines) across the view — positions are already
// in view pixels (screen space), matching the 2D handles. Purely visual.
function SnapGuides({ project, fit }: { project: Project; fit: number }) {
  const g = snapGuides.value
  if (!g.x.length && !g.y.length) return null
  const viewW = project.width * fit
  const viewH = project.height * fit
  // frame-edge guides sit on the clipped border; pull 1px inside so they show
  const cx = (x: number) => Math.min(Math.max(x, 1), viewW - 1)
  const cy = (y: number) => Math.min(Math.max(y, 1), viewH - 1)
  return (
    <div class="vp__guides">
      {g.x.map((x, i) => (
        <div key={'x' + i} class="vp__guide vp__guide--v" style={{ left: `${cx(x)}px` }} />
      ))}
      {g.y.map((y, i) => (
        <div key={'y' + i} class="vp__guide vp__guide--h" style={{ top: `${cy(y)}px` }} />
      ))}
    </div>
  )
}

function Scene({ project }: { project: Project }) {
  const ref = useRef<HTMLDivElement>(null)
  // The view is sized in px from the measured stage rather than by CSS. Letting
  // `aspect-ratio` do it needs one axis fixed and the other auto, and whichever
  // max-* then clamps squashes the frame — the ratio breaks the moment the panel
  // is narrower (or shorter) than the project. Fitting both axes here can't.
  const [box, setBox] = useState({ w: 0, h: 0, fit: 1 })
  useEffect(() => {
    const el = ref.current
    const stage = el?.parentElement
    if (!el || !stage) return
    const measure = () => {
      const cs = getComputedStyle(stage)
      // clientWidth/Height include padding, which isn't usable space
      const availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      const f = Math.min(availW / project.width, availH / project.height)
      if (!Number.isFinite(f) || f <= 0) return
      setBox({ w: project.width * f, h: project.height * f, fit: f })
    }
    const ro = new ResizeObserver(measure)
    ro.observe(stage)
    measure()
    return () => ro.disconnect()
  }, [project.width, project.height])
  const fit = box.fit

  const t = playhead.value
  const selId = selectedClipId.value
  const animId = animatingClipId.value
  const tracks = timeline.value.tracks
  // read during render so the planes come back when the export releases
  const exportOwnsMedia = mediaExclusive.value
  // Visible objects, TOP first — the order hit-testing wants. The renderer
  // draws bottom-up itself, so this list is only for picking and for the
  // selection overlay.
  const visible: { clip: Clip; local: number }[] = []
  for (const tr of tracks) {
    for (const c of tr.clips) {
      if (c.audioOnly) continue
      const isAnim = c.id === animId
      // half-open range hides an object exactly at its end; but while animating
      // that clip we must keep it visible (incl. the last frame) so you can see
      // and edit the animation there
      const inRange = t >= c.start && t < c.start + c.duration
      if (!inRange && !isAnim) continue
      const local = isAnim ? Math.max(0, Math.min(c.duration, animPlayhead.value)) : t - c.start
      if (isText(c)) {
        // no-op once loaded; the renderer rasterises with whatever is available,
        // so an unrequested web font would silently fall back to sans-serif
        loadGoogleFont(c.text!.font)
      } else {
        const a = assets.value.find((x) => x.id === c.assetId)
        if (!a || (a.kind !== 'video' && a.kind !== 'image')) continue
      }
      visible.push({ clip: c, local })
    }
  }
  const selected = visible.find((v) => v.clip.id === selId) ?? null

  return (
    <div
      class="vp__view"
      ref={ref}
      style={{ width: `${box.w}px`, height: `${box.h}px` }}
      onPointerDown={(e) => e.currentTarget === e.target && selectOnly(null)}
    >
      <ScenePreview
        project={project}
        w={box.w}
        h={box.h}
        visible={visible}
        fit={fit}
        exportOwnsMedia={exportOwnsMedia}
        renderScale={prefs.value.previewScale}
        hold={
          animId
            ? (() => {
                const v = visible.find((x) => x.clip.id === animId)
                return v ? { clipId: animId, local: v.local } : null
              })()
            : null
        }
      />
      {/* flat handle overlay, outside the 3D transform so handles stay grabbable */}
      {selected && <HandlesOverlay clip={selected.clip} local={selected.local} project={project} fit={fit} />}
      <SnapGuides project={project} fit={fit} />
    </div>
  )
}

function tc(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${h}:${p(m)}:${p(ss)}`
}

/** Best-guess the aspect tab from the current resolution. */
function guessRatio(w: number, h: number): string {
  const r = Math.max(w, h) / Math.min(w, h)
  let best = RATIOS[0]
  let bestD = Infinity
  for (const x of RATIOS) {
    const d = Math.abs(x.w / x.h - r)
    if (d < bestD) {
      bestD = d
      best = x
    }
  }
  return best.id
}

function ViewportSettings() {
  const p = currentProject.value
  if (!p) return null
  const [ratioId, setRatioId] = useState(guessRatio(p.width, p.height))
  const [locked, setLocked] = useState(true)
  const portrait = p.height > p.width
  const aspect = p.width / p.height

  // orient a landscape-defined preset to match the current orientation
  const orient = (w: number, h: number) => (portrait ? { w: h, h: w } : { w, h })

  const pickRatio = (id: string) => {
    setRatioId(id)
    const preset = PRESETS[id][1] ?? PRESETS[id][0]
    const wh = orient(preset.w, preset.h)
    updateProject({ width: wh.w, height: wh.h })
  }
  const flip = () => updateProject({ width: p.height, height: p.width })
  const pickPreset = (pr: { w: number; h: number }) => {
    const wh = orient(pr.w, pr.h)
    updateProject({ width: wh.w, height: wh.h })
  }
  const setW = (v: number) => updateProject({ width: v, height: locked ? Math.max(1, Math.round(v / aspect)) : p.height })
  const setH = (v: number) => updateProject({ height: v, width: locked ? Math.max(1, Math.round(v * aspect)) : p.width })

  const isActive = (pr: { w: number; h: number }) => {
    const wh = orient(pr.w, pr.h)
    return wh.w === p.width && wh.h === p.height
  }

  return (
    <div class="vp-settings" onMouseDown={(e) => e.stopPropagation()}>
      <div class="vp-settings__field">
        <span class="field__label">Aspect ratio</span>
        <div class="vp-settings__tabs">
          {RATIOS.map((r) => (
            <div
              key={r.id}
              class={'proj-tab' + (ratioId === r.id ? ' is-active' : '')}
              onClick={() => pickRatio(r.id)}
            >
              <span>{portrait ? `${r.h}:${r.w}` : `${r.w}:${r.h}`}</span>
              <button
                class="proj-tab__flip"
                title="Flip orientation"
                onClick={(e) => {
                  e.stopPropagation()
                  flip()
                }}
              >
                <Icon name="swap_horiz" size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div class="vp-settings__field">
        <span class="field__label">Resolution</span>
        <div class="vp-settings__presets">
          {PRESETS[ratioId].map((pr) => {
            const wh = orient(pr.w, pr.h)
            return (
              <button
                key={pr.label}
                class={'proj-card' + (isActive(pr) ? ' is-active' : '')}
                onClick={() => pickPreset(pr)}
              >
                <div class="proj-card__preview" style={{ aspectRatio: `${wh.w} / ${wh.h}` }} />
                <div class="proj-card__title">{pr.label}</div>
              </button>
            )
          })}
        </div>
        <div class="res-row">
          <input
            class="field__input res-input"
            type="number"
            min={1}
            value={p.width}
            onInput={(e) => setW(+(e.target as HTMLInputElement).value)}
          />
          <button
            class={'res-lock' + (locked ? ' is-locked' : '')}
            title={locked ? 'Aspect locked' : 'Aspect unlocked'}
            onClick={() => setLocked(!locked)}
          >
            <Icon name={locked ? 'lock' : 'lock_open'} size={14} />
          </button>
          <input
            class="field__input res-input"
            type="number"
            min={1}
            value={p.height}
            onInput={(e) => setH(+(e.target as HTMLInputElement).value)}
          />
        </div>
      </div>

      <div class="vp-settings__field">
        <span class="field__label">Frame rate</span>
        <div class="fps-row">
          {FPS_PRESETS.map((f) => (
            <button
              key={f}
              class={'fps-chip' + (p.fps === f ? ' is-active' : '')}
              onClick={() => updateProject({ fps: f })}
            >
              {f}
            </button>
          ))}
          <input
            class="field__input fps-input"
            type="number"
            min={1}
            value={p.fps}
            onInput={(e) => updateProject({ fps: Math.max(1, +(e.target as HTMLInputElement).value || 1) })}
          />
        </div>
      </div>
    </div>
  )
}

export function ViewportTool() {
  const p = currentProject.value
  const ratio = p ? `${p.width} / ${p.height}` : '16 / 9'
  const isPlaying = playing.value
  const [settings, setSettings] = useState(false)

  useEffect(() => {
    if (!settings) return
    const close = () => setSettings(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [settings])

  return (
    <div class="vp">
      <div class="vp__stage">
        {/* fixed-camera 3D scene: visual objects as textured planes */}
        {p ? <Scene project={p} /> : <div class="vp__view" style={{ aspectRatio: ratio }} />}
      </div>

      <div class="vp__transport">
        <div class="vp__time">
          {tc(playhead.value)} / {tc(contentEnd())}
        </div>
        <div class="vp__controls">
          <button class="iconbtn" title="Previous object edge" onClick={() => jumpToEdge(-1)}>
            <Icon name="keyboard_double_arrow_left" size={18} />
          </button>
          <button class="iconbtn" title="Back 5s" onClick={() => seekBy(-5)}>
            <Icon name="keyboard_arrow_left" size={18} />
          </button>
          <button class="iconbtn" title={isPlaying ? 'Pause' : 'Play'} onClick={togglePlay}>
            <Icon name={isPlaying ? 'pause' : 'play_arrow'} size={20} />
          </button>
          <button class="iconbtn" title="Forward 5s" onClick={() => seekBy(5)}>
            <Icon name="keyboard_arrow_right" size={18} />
          </button>
          <button class="iconbtn" title="Next object edge" onClick={() => jumpToEdge(1)}>
            <Icon name="keyboard_double_arrow_right" size={18} />
          </button>
        </div>
        <div class="vp__right">
          {/* Render scale. Fewer pixels drawn, stretched back to the same size —
              a softer preview, never a smaller one. Playback resolution in any
              other editor, and the usual answer to a heavy timeline. */}
          <select
            class="vp__scale"
            title="Preview render scale — lower is faster, same size on screen"
            value={String(prefs.value.previewScale)}
            onChange={(e) => setPref('previewScale', +(e.target as HTMLSelectElement).value)}
          >
            {PREVIEW_SCALES.map((v) => (
              <option key={v} value={String(v)}>
                {v === 1 ? 'Full' : `${v}x`}
              </option>
            ))}
          </select>
          <button
            class={'iconbtn' + (settings ? ' is-active' : '')}
            title="Viewport — aspect, resolution, frame rate"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setSettings((s) => !s)}
          >
            <Icon name="viewport" size={18} />
          </button>
          {settings && <ViewportSettings />}
        </div>
      </div>
    </div>
  )
}
