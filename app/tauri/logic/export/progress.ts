// Live export state, shown by the blocking progress dialog.
//
// Deliberately more than a spinner and a label: an export can run for many
// minutes, and "Mixing audio…" tells you nothing about whether it's working,
// how far along it is, or how long it has left.
import { signal } from '@preact/signals'

export type Stage = 'prepare' | 'proxy' | 'audio' | 'render' | 'finish' | 'done' | 'error'

export interface ExportState {
  stage: Stage
  /** what's happening right now, with real numbers in it */
  detail: string
  /** 0..1, or null when the work can't be measured */
  value: number | null
  frame: number
  total: number
  /** frames per second we're actually achieving */
  fps: number
  startedAt: number
  elapsedMs: number
  etaMs: number | null
  /** static description of the job: codec, size, rate, destination */
  summary: string
  out: string
  error?: string
  cancelled: boolean
  /** rolling per-phase cost, ms per frame — shows where the time actually goes.
   *  `seek` is carved out of `render`: waiting on a video decode and drawing on
   *  the GPU are both "draw" to a stopwatch but have nothing else in common.
   *  `send` is blocking on the encoder; `pipe` is blocking on the bytes reaching
   *  ffmpeg. Same reason: one is a codec's throughput and the other is ours. */
  cost: { seek: number; render: number; read: number; send: number; pipe: number }
}

export const exportState = signal<ExportState | null>(null)

/** true while an export is running — used to block edits and dismissal */
export function exportBusy(): boolean {
  const s = exportState.value
  return !!s && s.stage !== 'done' && s.stage !== 'error'
}

export function beginExport(summary: string, out: string, total: number) {
  exportState.value = {
    stage: 'prepare',
    detail: 'Starting…',
    value: null,
    frame: 0,
    total,
    fps: 0,
    startedAt: performance.now(),
    elapsedMs: 0,
    etaMs: null,
    summary,
    out,
    cancelled: false,
    cost: { seek: 0, render: 0, read: 0, send: 0, pipe: 0 },
  }
}

/** Replace the static job description once something is known that wasn't at
 *  the start — notably which encode path the probe picked. */
export function setSummary(summary: string) {
  const s = exportState.value
  if (s) exportState.value = { ...s, summary }
}

export function setStage(stage: Stage, detail: string, value: number | null = null) {
  const s = exportState.value
  if (!s) return
  exportState.value = { ...s, stage, detail, value, elapsedMs: performance.now() - s.startedAt }
}

// Rate over a TIME window rather than a fixed number of samples. Frames arrive
// in bursts (a batch sends every Nth frame, so two are quick and one blocks), and
// a sample window lands unevenly across that pattern — which is what made the
// estimate swing by an hour between updates.
const WINDOW_MS = 5000
let stamps: number[] = []
// The UI is throttled separately: at export rates a signal write per frame just
// re-renders the dialog faster than anyone can read it, and makes the numbers
// look like they're flickering rather than counting.
const UI_MS = 100
let lastUi = 0

export function resetRate() {
  stamps = []
  lastUi = 0
  ema.seek = ema.render = ema.read = ema.send = ema.pipe = 0
}

/**
 * A gap this long between frames means the export wasn't running: the machine
 * slept, or the window was frozen by the OS. Every rate derived from samples
 * either side of that gap is meaningless — an hour of sleep between two frames
 * reads as 0.0003 fps and an ETA measured in weeks.
 */
const SLEEP_MS = 4000

/**
 * Keep the dialog's clock moving through a stage that reports nothing.
 *
 * The final ffmpeg mux is one long opaque call, and a readout that stops
 * updating is exactly what a hang looks like. Returns a stop function.
 */
export function startHeartbeat(ms = 500): () => void {
  const id = setInterval(() => {
    const s = exportState.value
    if (s) exportState.value = { ...s, elapsedMs: performance.now() - s.startedAt }
  }, ms)
  return () => clearInterval(id)
}

// exponential moving average: cheap, and tracks the current rate rather than
// being anchored by however the first few frames went
const ema = { seek: 0, render: 0, read: 0, send: 0, pipe: 0 }
export function reportPhase(seek: number, render: number, read: number, send: number, pipe = 0) {
  const k = 0.1
  ema.seek += (seek - ema.seek) * k
  ema.render += (render - ema.render) * k
  ema.read += (read - ema.read) * k
  ema.send += (send - ema.send) * k
  ema.pipe += (pipe - ema.pipe) * k
}

export function reportFrame(frame: number, detailPrefix = '') {
  const s = exportState.value
  if (!s) return
  const now = performance.now()

  // Came back from sleep (or an OS freeze): throw the window away rather than
  // averaging across a gap the export spent not running, and drop the rate to
  // "unknown" so the dialog shows — instead of an ETA built from it.
  const woke = stamps.length > 0 && now - stamps[stamps.length - 1] > SLEEP_MS
  if (woke) {
    stamps = []
    ema.seek = ema.render = ema.read = ema.send = ema.pipe = 0
  }

  stamps.push(now)
  while (stamps.length > 1 && now - stamps[0] > WINDOW_MS) stamps.shift()
  const span = (now - stamps[0]) / 1000
  const fps = span > 0.25 ? (stamps.length - 1) / span : woke ? 0 : s.fps

  // always let the final frame through, so the dialog never stops just short
  if (now - lastUi < UI_MS && frame < s.total) return
  lastUi = now

  const left = Math.max(0, s.total - frame)
  const etaMs = fps > 0 ? (left / fps) * 1000 : null
  exportState.value = {
    ...s,
    stage: 'render',
    frame,
    fps,
    etaMs,
    elapsedMs: now - s.startedAt,
    value: s.total ? frame / s.total : null,
    detail: `${detailPrefix}Frame ${frame.toLocaleString()} of ${s.total.toLocaleString()}`,
    cost: { seek: ema.seek, render: ema.render, read: ema.read, send: ema.send, pipe: ema.pipe },
  }
}

export function finishExport(error?: string) {
  const s = exportState.value
  if (!s) return
  exportState.value = {
    ...s,
    stage: error ? 'error' : 'done',
    detail: error ?? 'Finished',
    value: error ? null : 1,
    elapsedMs: performance.now() - s.startedAt,
    error,
  }
}

export function closeExport() {
  exportState.value = null
}

export function requestCancel() {
  const s = exportState.value
  if (s) exportState.value = { ...s, cancelled: true, detail: 'Cancelling…' }
}

export const isCancelled = () => exportState.value?.cancelled === true

/** ms → "1:04:12" / "4:12" */
export function clock(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
