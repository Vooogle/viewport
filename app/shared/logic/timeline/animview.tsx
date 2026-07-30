// Object animation editor. Opens over the timeline for one object: an
// object-local ruler, one lane per animated property, keyframes as diamonds
// (strip) or a value curve with draggable points + bezier handles (graph).
import { effect } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Icon } from '../ui/icon'
import { findClip, snapshot } from './timeline'
import { pps, secPerSeg, Ruler, TopBar } from './timelineview'
import { ScrubPill } from '../properties/properties'
import { useMenuClamp } from '../ui/ctxmenu'
import { assets } from '../tools/files/assets'
import {
  ANIM_PROPS,
  animProp,
  animatingClipId,
  animPlayhead,
  setAnimPlayhead,
  animGraph,
  selectedKeys,
  isKeySelected,
  selectKeys,
  toggleKey,
  clearKeySel,
  stopAnimating,
  addKeyAt,
  setKeyframeText,
  moveKeyframe,
  setKeyframeValue,
  setSelectedInterp,
  allowedInterps,
  removeSelectedKeys,
  setKeyframeHandles,
  addAnimProp,
  removeAnimProp,
  toggleAnimMuted,
  sampleAt,
} from './anim'
import { onDrag } from '../ui/pointerdrag'

const STRIP_H = 30
const GRAPH_H = 120

// ---- one property lane ----
function AnimLane({ clipId, prop, dur }: { clipId: string; prop: string; dur: number }) {
  const f = findClip(clipId)
  const clip = f?.clip
  const p = animProp(prop)
  const [menu, setMenu] = useState<{ i: number; x: number; y: number } | null>(null)
  if (!clip || !p) return null
  const track = clip.anim?.[prop]
  const keys = track?.keys ?? []
  const pxs = pps()
  // Non-numeric channels (text content, tone curves) have no value to put on an
  // axis, so they stay a strip even in graph mode. Asked of the registry rather
  // than by name: a second such channel is exactly what broke the `prop ===
  // 'content'` test that used to be here.
  const graph = animGraph.value && !p.kind
  const laneH = graph ? GRAPH_H : STRIP_H
  const width = Math.max(dur, 0) * pxs

  // value range for graph mode — derived from the data (keys + bezier handle
  // endpoints so a handle dragged past the top/bottom stretches the graph). Only
  // FINITE prop bounds anchor the axis; unbounded props (x/y/z/rot are ±Infinity)
  // must not, or the range blows up to Infinity and every point becomes NaN.
  const isFin = Number.isFinite
  let vmin = Infinity
  let vmax = -Infinity
  const bump = (v: number) => {
    vmin = Math.min(vmin, v)
    vmax = Math.max(vmax, v)
  }
  for (const k of keys) {
    bump(k.value)
    if (k.interp === 'bezier') {
      if (k.hr) bump(k.value + k.hr[1])
      if (k.hl) bump(k.value + k.hl[1])
    }
  }
  if (isFin(p.min)) bump(p.min)
  if (p.max != null && isFin(p.max)) bump(p.max)
  if (!keys.length) bump(p.get(clip)) // no keys → centre on the current value
  if (!isFin(vmin) || !isFin(vmax)) { vmin = 0; vmax = 1 }
  if (vmax - vmin < 1e-6) vmax = vmin + 1
  const pad = (vmax - vmin) * 0.1
  vmin -= pad
  vmax += pad
  const valToY = (v: number) => laneH - ((v - vmin) / (vmax - vmin)) * laneH
  const yToVal = (y: number) => vmin + ((laneH - y) / laneH) * (vmax - vmin)

  // drag keyframe(s): grabbed key (+ any other selected) move in time; value moves
  // too in graph mode (only keys on this lane's prop, since scale is per-prop).
  const dragKey = (i: number) => (e: PointerEvent) => {
    e.stopPropagation()
    if (e.button !== 0) return // right-click → let onContextMenu handle it
    const k = keys[i]
    if (e.ctrlKey || e.metaKey) return toggleKey(k.id)
    if (!isKeySelected(k.id)) selectKeys([k.id])
    const el = (e.currentTarget as HTMLElement).closest('.anim-lane') as HTMLElement
    const rect = el.getBoundingClientRect()
    const startX = e.clientX
    // snapshot original positions of every selected key across all props
    const cur = findClip(clipId)?.clip.anim ?? {}
    const sel = new Set(selectedKeys.value)
    const origs: { prop: string; id: string; t: number; value: number }[] = []
    for (const pp in cur) for (const kk of cur[pp].keys) if (sel.has(kk.id)) origs.push({ prop: pp, id: kk.id, t: kk.t, value: kk.value })
    const idxById = (pp: string, id: string) => findClip(clipId)?.clip.anim?.[pp]?.keys.findIndex((x) => x.id === id) ?? -1
    let dirty = false
    const move = (ev: PointerEvent) => {
      if (!dirty) {
        snapshot()
        dirty = true
      }
      let dt = (ev.clientX - startX) / pxs
      const dv = graph ? yToVal(ev.clientY - rect.top) - k.value : 0
      if (ev.ctrlKey) {
        const s = secPerSeg()
        dt = Math.round((k.t + dt) / s) * s - k.t
      }
      for (const o of origs) {
        const ix = idxById(o.prop, o.id)
        if (ix < 0) continue
        moveKeyframe(clipId, o.prop, ix, o.t + dt, false)
        if (graph && o.prop === prop) setKeyframeValue(clipId, o.prop, idxById(o.prop, o.id), o.value + dv, false)
      }
    }
    const up = () => {
    }
    onDrag(move, up)
  }

  // drag a bezier handle (graph mode)
  const dragHandle = (i: number, side: 'l' | 'r') => (e: PointerEvent) => {
    e.stopPropagation()
    if (e.button !== 0) return
    const k = keys[i]
    const el = (e.currentTarget as HTMLElement).closest('.anim-lane') as HTMLElement
    const rect = el.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - rect.left) / pxs - k.t
      const dv = yToVal(ev.clientY - rect.top) - k.value
      setKeyframeHandles(clipId, prop, i, side === 'l' ? [Math.min(0, dt), dv] : undefined, side === 'r' ? [Math.max(0, dt), dv] : undefined)
    }
    const up = () => {
    }
    onDrag(move, up)
  }

  const addAt = (clientX: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    const t = Math.max(0, Math.min(dur, (clientX - rect.left) / pxs))
    selectKeys([addKeyAt(clipId, prop, t)])
  }

  // graph curve polyline
  let path = ''
  if (graph && keys.length) {
    const steps = Math.max(2, Math.floor(width / 4))
    const pts: string[] = []
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * dur
      pts.push(`${t * pxs},${valToY(sampleAt(track, t, p.get(clip)))}`)
    }
    path = pts.join(' ')
  }

  return (
    <div
      class={'anim-lane' + (graph ? ' is-graph' : '')}
      style={{ width: `${width}px`, height: `${laneH}px` }}
      onDblClick={(e) => addAt(e.clientX, e.currentTarget as HTMLElement)}
    >
      {graph && keys.length > 0 && (
        <svg class="anim-graph-svg" width={width} height={laneH}>
          <polyline points={path} class="anim-curve" />
          {keys.map((k, i) => {
            if (k.interp !== 'bezier') return null
            const lines = []
            if (i < keys.length - 1)
              lines.push(
                <line
                  key={`hr${i}`}
                  class="anim-handle-line"
                  x1={k.t * pxs}
                  y1={valToY(k.value)}
                  x2={(k.t + (k.hr?.[0] ?? (keys[i + 1].t - k.t) / 3)) * pxs}
                  y2={valToY(k.value + (k.hr?.[1] ?? 0))}
                />,
              )
            if (i > 0)
              lines.push(
                <line
                  key={`hl${i}`}
                  class="anim-handle-line"
                  x1={k.t * pxs}
                  y1={valToY(k.value)}
                  x2={(k.t + (k.hl?.[0] ?? -(k.t - keys[i - 1].t) / 3)) * pxs}
                  y2={valToY(k.value + (k.hl?.[1] ?? 0))}
                />,
              )
            return lines
          })}
        </svg>
      )}
      {/* keyframes */}
      {keys.map((k, i) => {
        const x = k.t * pxs
        const y = graph ? valToY(k.value) : laneH / 2
        return (
          <div key={i}>
            <div
              class={'anim-key anim-key--' + k.interp + (isKeySelected(k.id) ? ' is-sel' : '')}
              style={{ left: `${x}px`, top: `${y}px` }}
              // what this key actually holds — otherwise the only way to see a
              // keyframe's value is to right-click it
              title={`${p.label}  ${Math.round(k.value * 1000) / 1000}  @ ${k.t.toFixed(2)}s`}
              onPointerDown={dragKey(i)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (!isKeySelected(k.id)) selectKeys([k.id])
                setMenu({ i, x: e.clientX, y: e.clientY })
              }}
            />
            {graph && k.interp === 'bezier' && i < keys.length - 1 && (
              <div
                class="anim-handle"
                style={{ left: `${(k.t + (k.hr?.[0] ?? (keys[i + 1].t - k.t) / 3)) * pxs}px`, top: `${valToY(k.value + (k.hr?.[1] ?? 0))}px` }}
                onPointerDown={dragHandle(i, 'r')}
              />
            )}
            {graph && k.interp === 'bezier' && i > 0 && (
              <div
                class="anim-handle"
                style={{ left: `${(k.t + (k.hl?.[0] ?? -(k.t - keys[i - 1].t) / 3)) * pxs}px`, top: `${valToY(k.value + (k.hl?.[1] ?? 0))}px` }}
                onPointerDown={dragHandle(i, 'l')}
              />
            )}
          </div>
        )
      })}

      {menu && (
        <KeyMenu
          clipId={clipId}
          prop={prop}
          index={menu.i}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

function KeyMenu({ clipId, prop, index, x, y, onClose }: { clipId: string; prop: string; index: number; x: number; y: number; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [])
  const clamp = useMenuClamp(x, y)
  const key = findClip(clipId)?.clip.anim?.[prop]?.keys[index]
  const cur = key?.interp
  const ap = animProp(prop)
  const choices = allowedInterps(prop)
  const isContent = ap?.kind === 'text'
  // A curve key holds a whole shape; it is edited in the curve editor with the
  // playhead parked on it, not by a number in this menu.
  const numeric = key && ap && !ap.kind
  return (
    <div
      ref={clamp.ref}
      class="ctxmenu anim-keymenu"
      style={{ left: clamp.left, top: clamp.top }}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {key && isContent && (
        <div class="anim-keymenu__val">
          <textarea
            class="txt-area anim-keymenu__text"
            rows={2}
            value={key.str ?? ''}
            onInput={(e) => setKeyframeText(clipId, index, (e.target as HTMLTextAreaElement).value, false)}
          />
        </div>
      )}
      {key && ap?.kind === 'curve' && (
        <div class="anim-keymenu__val">
          <span class="anim-keymenu__label">Curve shape — edit it in Properties with the playhead here</span>
        </div>
      )}
      {numeric && ap && (
        <div class="anim-keymenu__val">
          <span class="anim-keymenu__label">Value</span>
          <ScrubPill
            value={key.value}
            min={ap.min}
            max={ap.max ?? Infinity}
            onStart={snapshot}
            onInput={(v) => setKeyframeValue(clipId, prop, index, v, false)}
            onCommit={(v) => setKeyframeValue(clipId, prop, index, v, false)}
            format={(v) => `${Math.round(v * 1000) / 1000}`}
            parse={(s) => {
              const n = parseFloat(s)
              return Number.isFinite(n) ? n : null
            }}
            onEdit={(v) => {
              snapshot()
              setKeyframeValue(clipId, prop, index, v, false)
            }}
          />
        </div>
      )}
      {/* Only what this property permits. A channel with a single option shows
          none — there is nothing to choose, and offering a picker that snaps
          straight back is worse than not offering one. */}
      {choices.length > 1 &&
        choices.map((it) => (
          <button
            key={it}
            class={'ctxmenu__item' + (cur === it ? ' is-on' : '')}
            onClick={() => {
              setSelectedInterp(clipId, it)
              onClose()
            }}
          >
            {it[0].toUpperCase() + it.slice(1)}
          </button>
        ))}
      <button
        class="ctxmenu__item ctxmenu__item--danger"
        onClick={() => {
          removeSelectedKeys(clipId)
          onClose()
        }}
      >
        Delete {selectedKeys.value.length > 1 ? `${selectedKeys.value.length} keyframes` : 'keyframe'}
      </button>
    </div>
  )
}

// ---- property row head ----
function AnimHead({ clipId, prop }: { clipId: string; prop: string }) {
  const f = findClip(clipId)
  const p = animProp(prop)
  if (!f || !p) return null
  const track = f.clip.anim?.[prop]
  const muted = track?.muted
  const laneH = animGraph.value ? GRAPH_H : STRIP_H
  return (
    <div class="anim-head" style={{ height: `${laneH}px` }}>
      <button class={'anim-head__eye' + (muted ? ' is-off' : '')} title={muted ? 'Enable channel' : 'Disable channel'} onClick={() => toggleAnimMuted(clipId, prop)}>
        <Icon name={muted ? 'visibility_off' : 'visibility'} size={15} />
      </button>
      <span class="anim-head__name">{p.label}</span>
      <button
        class="anim-head__add"
        title="Add keyframe at playhead"
        onClick={() => {
          addKeyAt(clipId, prop, animPlayhead.value)
        }}
      >
        <Icon name="add" size={15} />
      </button>
      <button class="anim-head__del" title="Remove property" onClick={() => removeAnimProp(clipId, prop)}>
        <Icon name="close" size={13} />
      </button>
    </div>
  )
}

/**
 * Property picker for the Add row. Fixed-position so the gutter's overflow
 * clipping can't cut it off, clamped on-screen, and scrollable when the list is
 * longer than the space below the button.
 *
 * Grouped under category headings, and filterable. It was a flat list, which
 * was fine at fourteen properties and is not at thirty-six: grading alone adds
 * ten, and the ones at the bottom of a scroller read as missing rather than as
 * further down.
 */
function AddPropMenu({
  at,
  items,
  onPick,
  onClose,
}: {
  at: { x: number; y: number }
  items: { id: string; label: string; category: string }[]
  onPick: (id: string) => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onClose)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClose)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  const clamp = useMenuClamp(at.x, at.y)
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const shown = needle
    ? items.filter((p) => p.label.toLowerCase().includes(needle) || p.category.toLowerCase().includes(needle))
    : items
  // insertion order is the registry's order, which is already grouped
  const groups: { name: string; props: typeof items }[] = []
  for (const p of shown) {
    const g = groups.find((x) => x.name === p.category)
    if (g) g.props.push(p)
    else groups.push({ name: p.category, props: [p] })
  }
  return (
    <div
      ref={clamp.ref}
      class="anim-add__menu"
      style={{ left: clamp.left, top: clamp.top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        class="anim-add__find"
        placeholder="Find a property…"
        value={q}
        autoFocus
        onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        // Enter takes the only remaining match — with a filter, that's the
        // whole gesture: type three letters, press Enter.
        onKeyDown={(e) => {
          if (e.key === 'Enter' && shown.length) onPick(shown[0].id)
          if (e.key === 'Escape') onClose()
        }}
      />
      {groups.map((g) => (
        <div key={g.name} class="anim-add__group">
          <div class="anim-add__head">{g.name}</div>
          {g.props.map((p) => (
            <button key={p.id} class="anim-add__item" onClick={() => onPick(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      ))}
      {!shown.length && <div class="anim-add__head">Nothing matches</div>}
    </div>
  )
}

// ---- editor shell ----
export function AnimationEditor() {
  const clipId = animatingClipId.value
  const f = clipId ? findClip(clipId) : null
  const headsRef = useRef<HTMLDivElement>(null)
  const rulerRef = useRef<HTMLDivElement>(null)
  const lanesRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [viewW, setViewW] = useState(800)
  const [addAt, setAddAt] = useState<{ x: number; y: number } | null>(null)
  const [band, setBand] = useState<{ l: number; t: number; w: number; h: number } | null>(null)

  useEffect(() => {
    const el = lanesRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setViewW(el.clientWidth)
      syncSb(el) // the horizontal scrollbar can appear/vanish on resize too
    })
    ro.observe(el)
    setViewW(el.clientWidth)
    syncSb(el)
    return () => ro.disconnect()
  }, [])

  // keep the local playhead on-screen (same paging as the main timeline)
  useEffect(() => {
    return effect(() => {
      const x = animPlayhead.value * pps()
      const el = lanesRef.current
      if (!el) return
      const left = el.scrollLeft
      const w = el.clientWidth
      const margin = 40
      if (x > left + w - margin || x < left) el.scrollLeft = Math.max(0, x - margin)
    })
  }, [])

  if (!f) {
    stopAnimating()
    return null
  }
  const clip = f.clip
  const asset = assets.value.find((a) => a.id === clip.assetId)
  const dur = clip.duration
  const isTextObj = clip.text != null
  const hasAudio = asset?.kind === 'audio' || asset?.kind === 'video'
  const hasVisual = isTextObj || asset?.kind === 'video' || asset?.kind === 'image'
  const props = Object.keys(clip.anim ?? {})
  // only offer props that apply to this object type
  const available = ANIM_PROPS.filter((p) => {
    if (props.includes(p.id)) return false
    if (p.category === 'Text') return isTextObj
    if (p.category === 'Audio') return hasAudio
    // nothing to grade on an object with no picture
    if (p.category === 'Grade') return hasVisual
    return true
  })
  const pxs = pps()
  // same content-width formula as the main timeline (tail of 4 segments)
  const totalSec = Math.max(dur, animPlayhead.value) + secPerSeg() * 4
  const contentW = Math.max(viewW, totalSec * pxs)
  const playX = animPlayhead.value * pxs

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
    if (headsRef.current) headsRef.current.style.transform = `translateY(${-el.scrollTop}px)`
    if (rulerRef.current) rulerRef.current.style.transform = `translateX(${-el.scrollLeft}px)`
    syncSb(el)
  }

  const laneH = animGraph.value ? GRAPH_H : STRIP_H
  // rubber-band select keyframes by time window × lanes (keys stopPropagation,
  // so a band only starts on empty lane space)
  const startBand = (e: PointerEvent) => {
    if (e.button !== 0) return
    const inner = innerRef.current
    if (!inner) return
    const rect = inner.getBoundingClientRect()
    const x0 = e.clientX - rect.left
    const y0 = e.clientY - rect.top
    const additive = e.ctrlKey || e.shiftKey
    const base = additive ? selectedKeys.value.slice() : []
    if (!additive) clearKeySel()
    const move = (ev: PointerEvent) => {
      const x1 = ev.clientX - rect.left
      const y1 = ev.clientY - rect.top
      const l = Math.min(x0, x1)
      const t = Math.min(y0, y1)
      const w = Math.abs(x1 - x0)
      const h = Math.abs(y1 - y0)
      setBand({ l, t, w, h })
      const anim = findClip(clip.id)?.clip.anim ?? {}
      const hits: string[] = []
      Object.keys(anim).forEach((pp, li) => {
        const top = li * laneH
        if (top + laneH < t || top > t + h) return
        for (const k of anim[pp].keys) {
          const kx = k.t * pxs
          if (kx >= l && kx <= l + w) hits.push(k.id)
        }
      })
      selectKeys([...base, ...hits])
    }
    const up = () => {
      setBand(null)
    }
    onDrag(move, up)
  }

  return (
    <div class="tl tl--anim">
      <TopBar
        head={animPlayhead}
        total={dur}
        right={
          <button
            class={'anim-graphbtn' + (animGraph.value ? ' is-on' : '')}
            title="Toggle value graph"
            onClick={() => (animGraph.value = !animGraph.value)}
          >
            <Icon name="show_chart" size={16} /> Graph
          </button>
        }
      />
      <div class="tl__body">
        <div class="tl__gutter">
          <div class="tl__corner anim-corner">
            <button class="anim-back" title="Back to timeline" onClick={stopAnimating}>
              <Icon name="keyboard_arrow_left" size={16} />
            </button>
            <span class="anim-corner__name" title={asset?.name}>
              {asset?.name ?? 'Object'}
            </span>
          </div>
          {/* see .tl__headsinner — the clipping box must stay put */}
          <div class="anim__heads">
            <div class="tl__headsinner" ref={headsRef}>
              {props.map((prop) => (
                <AnimHead key={prop} clipId={clip.id} prop={prop} />
              ))}
            {/* last row inside the heads — the lanes reserve the same height
                via .tl--anim .tl__lanesinner's padding-bottom */}
              <div class="anim-addrow">
                <button
                  class="anim-add"
                  disabled={!available.length}
                  onClick={(e) => {
                    if (addAt) return setAddAt(null)
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setAddAt({ x: r.left, y: r.bottom + 4 })
                  }}
                >
                  <Icon name="add" size={15} /> Property
                </button>
              </div>
            </div>
          </div>
          <div class="tl__sbspacer" ref={sbRef} />
        </div>
        {addAt && available.length > 0 && (
          <AddPropMenu
            at={addAt}
            items={available}
            onPick={(id) => {
              addAnimProp(clip.id, id)
              setAddAt(null)
            }}
            onClose={() => setAddAt(null)}
          />
        )}
        <div class="tl__right">
          <div class="tl__rulerclip">
            <div class="tl__rulermove" ref={rulerRef}>
              <Ruler width={contentW} scroller={lanesRef} head={animPlayhead} clampMax={dur} onHead={setAnimPlayhead} />
              <div class="tl-playhead tl-playhead--ruler" style={{ left: `${playX}px` }} />
            </div>
          </div>
          <div class="tl__lanes" ref={lanesRef} onScroll={sync}>
            <div
              class="tl__lanesinner"
              ref={innerRef}
              style={{ width: `${contentW}px` }}
              onPointerDown={(e) => startBand(e as unknown as PointerEvent)}
            >
              {props.length === 0 ? (
                <div class="anim-empty">Add a property to start animating</div>
              ) : (
                props.map((prop) => <AnimLane key={prop} clipId={clip.id} prop={prop} dur={dur} />)
              )}
              <div class="tl-playhead" style={{ left: `${playX}px` }} />
              {band && (
                <div class="tl-rubber" style={{ left: `${band.l}px`, top: `${band.t}px`, width: `${band.w}px`, height: `${band.h}px` }} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
