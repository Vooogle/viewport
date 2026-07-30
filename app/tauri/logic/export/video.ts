// Desktop video export: render each frame with WebGL, push it straight into
// ffmpeg's stdin (no temp frame files), with the timeline audio muxed in.
//
// ffmpeg isn't bundled — that would put ~60MB on every download for something
// many users already have. We use the system's copy if there is one, and
// otherwise fetch a private copy into the app data dir on the first export.
// Nothing is installed system-wide; the user just watches one progress bar once.
import { currentProject } from '@shared/logic/project/project'
import { assets } from '@shared/logic/tools/files/assets'
import { timeline, isSilent } from '@shared/logic/timeline/timeline'
import { contentEnd } from '@shared/logic/timeline/timeline'
import { startTask } from '@shared/logic/ui/progress'
import { clearAllThumbs } from '@shared/logic/timeline/thumbs'
import { setMediaExclusive } from '@shared/logic/media/exclusive'
import { askConfirm } from '@shared/logic/ui/confirm'
import {
  ffmpegAvailable,
  downloadFfmpeg,
  onFfmpegProgress,
  exportBegin,
  exportFrame,
  exportEnd,
  exportCancel,
  exportAudioBegin,
  exportAudioChunk,
  exportAudioEnd,
  makeProxy,
  cancelProxy,
  srcForPath,
} from '../bridge'
import { createRenderer } from '@shared/logic/render/scene'
import {
  planWebCodecs,
  createFrameEncoder,
  tuneEncoder,
  softThreshold,
  type WebCodecPlan,
  type EncoderTuning,
} from './webcodec'
import { defaultBitrate } from './settings'
import { mixdown, streamWav } from './audio'
import { openExportDialog } from './exportdialog'
import {
  beginExport,
  setStage,
  setSummary,
  reportFrame,
  resetRate,
  reportPhase,
  finishExport,
  isCancelled,
  exportState,
  startHeartbeat,
} from './progress'
import { makePump } from './pump'
import { effect } from '@preact/signals'
import type { ExportSettings } from './settings'

const MB = (n: number) => `${(n / 1048576).toFixed(0)} MB`

/** Make sure an ffmpeg exists, fetching one (once) if the system has none. */
async function ensureFfmpeg(): Promise<boolean> {
  if (await ffmpegAvailable()) return true
  const go = await askConfirm(
    'Viewport needs the ffmpeg video encoder, which it downloads once (about 60 MB).\n\n' +
      "It's kept inside Viewport's own folder — nothing is installed on your system.",
    'Download',
  )
  if (!go) return false

  const task = startTask('Video encoder', 'Downloading…')
  let unlisten = () => {}
  try {
    unlisten = await onFfmpegProgress((received, total) =>
      task.step(
        total ? `Downloading ${MB(received)} / ${MB(total)}…` : `Downloading ${MB(received)}…`,
        total ? received / total : null,
      ),
    )
    await downloadFfmpeg()
    task.step('Ready', 1)
    return true
  } catch (e) {
    task.step('Failed', null)
    await askConfirm(
      `Could not download the video encoder: ${(e as Error).message}\n\n` +
        'Check your connection, or install ffmpeg yourself and Viewport will use it.',
      'OK',
    )
    return false
  } finally {
    unlisten()
    task.done()
  }
}

/** Export button → make sure we can encode, then open the settings dialog. */
export async function exportVideo() {
  const project = currentProject.value
  if (!project) return
  if (contentEnd() <= 0) {
    await askConfirm('Nothing to export — the timeline is empty.', 'OK')
    return
  }
  if (!(await ensureFfmpeg())) return
  openExportDialog(runExport)
}

/** Proxy every video source on the timeline; failures fall back to the original. */
async function buildProxies(width: number, height: number) {
  const used = new Set<string>()
  for (const tr of timeline.value.tracks)
    for (const c of tr.clips) if (c.assetId && !c.audioOnly) used.add(c.assetId)

  const videos = assets.value.filter((a) => used.has(a.id) && a.kind === 'video' && a.path && !a.missing)
  const map = new Map<string, { url: string; fps: number }>()
  const failed: string[] = []
  // A video with no filesystem path (imported by drag-drop rather than the
  // file picker) can't be proxied at all. That used to be silent — it never
  // entered the loop below, so the export quietly decoded the original
  // long-GOP file on every frame and crawled at a tenth of its usual rate,
  // with nothing anywhere saying why. Same warning path as a failed proxy.
  for (const a of assets.value)
    if (used.has(a.id) && a.kind === 'video' && !a.path && !a.missing)
      failed.push(`${a.name}: has no file path (drag-dropped?) — re-import it from disk so a fast-seek proxy can be built`)
  // Cancel has to reach the transcode itself, not just this loop. A proxy of a
  // long 4K source runs for minutes at full CPU/GPU, and `await makeProxy` does
  // not come back until it's done — so "cancelled" used to mean the dialog
  // closed while an ffmpeg carried on chewing through the rest of the project.
  // That's what left the *next* export running at a fraction of its usual rate.
  const stopWatch = effect(() => {
    if (exportState.value?.cancelled) void cancelProxy().catch(() => {})
  })
  try {
    for (let i = 0; i < videos.length; i++) {
      if (isCancelled()) break
      const a = videos[i]
      setStage('proxy', `Preparing ${a.name} — source ${i + 1} of ${videos.length}`, i / videos.length)
      try {
        const p = await makeProxy(a.path!, width, height)
        map.set(a.id, { url: srcForPath(p.path), fps: p.fps })
      } catch (e) {
        // A kill from the watcher above surfaces here as a failure; it isn't one.
        if (isCancelled()) break
        // Falling back to the original still works, but it's the difference
        // between a direct read and decoding from a keyframe on every frame —
        // i.e. an export that takes hours instead of minutes. Silently swallowing
        // that left no way to tell a slow export from a broken proxy step.
        failed.push(`${a.name}: ${(e as Error).message || e}`)
      }
    }
  } finally {
    stopWatch()
  }
  return { map, failed }
}

/** Render + encode with the settings and destination chosen in the dialog. */
export async function runExport(settings: ExportSettings, out: string) {
  const project = currentProject.value
  if (!project) return

  const duration = contentEnd()
  const { fps, width, height } = settings

  const total = Math.max(1, Math.round(duration * fps))
  // Quality belongs in here. It's the one setting that changes how hard the
  // encoder has to work, and leaving it out meant comparing two exports' rates
  // without knowing whether they were even encoding at the same target.
  const quality =
    settings.vBitrate != null
      ? `${(settings.vBitrate / 1e6).toFixed(1)} Mbps`
      : settings.crf != null
        ? `CRF ${settings.crf}`
        : 'default quality'
  const summary = `${settings.vCodec} · ${width}×${height} · ${fps} fps · ${quality} · ${clockOf(duration)}`
  beginExport(summary, out, total)
  // Claim the media pipeline before anything else. Preview planes, audio voices
  // and filmstrip extractors all stand down on this, and they need a render
  // pass to actually unmount — taking it here means that has long since
  // happened by the time the encoder probe runs, which is the measurement it
  // would otherwise poison.
  setMediaExclusive(true)
  let renderer: Awaited<ReturnType<typeof createRenderer>> | null = null
  let piping = false
  try {
    // All-intra proxies for every video actually on the timeline. Seeking a
    // normal video decodes forward from the last keyframe on EVERY frame, which
    // is what makes export crawl; in a proxy every frame is a keyframe. Cached
    // per source, so this is a one-time cost per file.
    const { map: proxies, failed } = await buildProxies(width, height)
    if (isCancelled()) throw new Error('cancelled')
    if (failed.length) {
      console.warn('[export] proxy failed, decoding from the original:\n' + failed.join('\n'))
      const go = await askConfirm(
        `Couldn't prepare ${failed.length === 1 ? 'a source' : `${failed.length} sources`} for fast export:\n\n` +
          failed.join('\n') +
          '\n\nThe export will still work, but reading from the originals is dramatically ' +
          'slower — expect hours rather than minutes.',
        'Export anyway',
      )
      if (!go) throw new Error('cancelled')
    }

    setStage('prepare', `Setting up the renderer — ${width}×${height}`, null)
    // Hand back every filmstrip decoder before measuring or encoding anything.
    // They are idle <video> elements on these same sources, sitting in the same
    // media pipeline as the hardware encoder — and a pipeline crowded with them
    // is where `prefer-hardware` silently becomes a software encode. Frames stay
    // cached, so the timeline redraws from storage when the export is done.
    clearAllThumbs()
    // Encode in the webview when we can: it removes both the readback and the
    // raw-pixel IPC, which together are most of the per-frame cost. Falls back
    // to raw frames whenever WebCodecs can't do what the dialog asked for.
    // Only when the export is already targeting a bitrate. WebCodecs has no CRF,
    // so quietly substituting one for a constant-quality export would change
    // what comes out — CRF holds quality and lets the bitrate move, which is the
    // opposite trade. A CRF export stays on ffmpeg and stays slow, on purpose.
    const choice = settings.encodePath ?? 'auto'
    // WebCodecs has no CRF, only a target bitrate. On 'auto' that's a reason to
    // stay on ffmpeg — silently swapping constant-quality for constant-bitrate
    // changes what comes out. But when the path is picked explicitly the choice
    // has been made, so convert rather than ignoring the setting: a dropdown
    // that quietly does the opposite of what it says is worse than a trade-off.
    const substituted = choice === 'webcodecs' && settings.crf != null && !settings.vBitrate
    const bitrate = settings.vBitrate ?? (substituted ? defaultBitrate(width, height, fps) : 0)
    // The same rule read from the other side: on 'auto' a CRF export never even
    // reaches the probe, so it is always ffmpeg. That's deliberate, but it used
    // to be invisible — hence "it always uses ffmpeg no matter what I pick".
    const skippedForCrf = choice === 'auto' && settings.crf != null && !settings.vBitrate
    let plan =
      choice !== 'ffmpeg' && bitrate
        ? await planWebCodecs(settings.vCodec, width, height, fps, bitrate)
        : null
    let canvas = newCanvas(width, height)
    renderer = await createRenderer(canvas, project, proxies, !plan)

    // 'auto' times the encoder on this project's own frames and takes whichever
    // path is cheaper — the two scale differently, since the raw path's cost is
    // bytes over IPC while the encoder's depends on what it's encoding. The
    // default is 'on': always encode here when the config is supported.
    // Find a configuration this machine actually encodes in hardware. Runs
    // whichever path was asked for: an explicit "in-app encoder" deserves the
    // fast configuration just as much as Auto does, and it's how that path
    // reports being stuck in software at all.
    let tuned: EncoderTuning | null = null
    if (plan) {
      tuned = await tuneEncoder(plan, renderer.render, canvas, fps, (label) =>
        setStage('prepare', `Measuring encoder speed — ${label}…`, null),
      )
      plan = tuned.plan
      // The full record, for working out WHY a machine has no hardware path.
      // WebCodecs reports nothing about which encoder it picked, so a table of
      // what every candidate did is the only evidence there is.
      if (tuned.attempts.length > 1) console.table(tuned.attempts)
    }

    const raw = rawTailMs(width, height)
    if (plan && tuned && choice === 'auto' && tuned.ms > raw * RAW_MARGIN) {
      plan = null
      // the probe's context is spent; the raw path needs a fresh one to pack into
      renderer.dispose()
      canvas = newCanvas(width, height)
      renderer = await createRenderer(canvas, project, proxies, true)
    }

    // Say what happened, rather than quietly taking a path — the difference
    // between these is worth over an hour on a long export.
    const notes: string[] = [plan ? 'in-app encoder' : 'ffmpeg']
    // Stays on screen for the whole export. It was announced once, in a dialog
    // that gets dismissed, after which an export decoding every frame from an
    // un-proxied original looked exactly like a healthy one — and this is the
    // single most expensive thing that can be wrong with an export.
    if (failed.length)
      notes.push(
        `${failed.length} source${failed.length === 1 ? '' : 's'} NOT proxied — decoding from ` +
          `the original, which is far slower and can also force software decode: ${failed.join('; ')}`,
      )
    // The measured per-frame cost is not shown on a healthy export: it decided
    // which path to take, and once taken it's a number about the decision, not
    // about the file. It comes back below when something is actually wrong,
    // where it's the evidence rather than trivia.
    if (tuned) {
      if (tuned.allSoftware)
        notes.push(
          'no faster than the explicitly-software control — WebCodecs never engaged ' +
            'hardware here. Set Encode Path to "ffmpeg" so the hardware encoder in the ' +
            'Video Encoder list does the work instead.',
        )
      // Inline rather than console-only: the console isn't reachable in a
      // packaged build, and this is the evidence worth reading. Shown not just
      // on the control verdict but whenever the winner is slower than hardware
      // plausibly runs: the control comparison can pass while everything is
      // degraded together (a busy media pipeline slows the control MORE than
      // prefer-hardware, which reads as "hardware engaged" at 33ms/frame) — and
      // that case, with no table, is indistinguishable from dark magic.
      if (tuned.allSoftware || tuned.ms > softThreshold(width, height))
        notes.push(
          `in-app encoder measured ${tuned.ms.toFixed(0)}ms/frame [${tuned.label}] — tried: ` +
            tuned.attempts
              .map((a) => `${a.label}: ${a.ms != null ? `${a.ms.toFixed(0)}ms` : (a.error ?? 'no result')}`)
              .join('; '),
        )
    }
    if (choice === 'webcodecs' && !plan)
      notes.push(`unavailable: ${settings.vCodec} is not an H.264 encoder WebCodecs can stand in for`)
    if (substituted && plan)
      notes.push(`CRF ${settings.crf} replaced by ${(bitrate / 1e6).toFixed(1)} Mbps — WebCodecs has no CRF`)
    if (skippedForCrf)
      notes.push(
        `Auto never measured the in-app encoder: it has no CRF, and swapping constant ` +
          `quality for a bitrate isn't Auto's call. Pick "In-app encoder" to convert ` +
          `CRF ${settings.crf} to ~${(defaultBitrate(width, height, fps) / 1e6).toFixed(1)} Mbps.`,
      )
    setSummary(`${summary} · ${notes.join(' · ')}`)
    if (isCancelled()) throw new Error('cancelled')

    let audio: AudioBuffer | null = null
    if (settings.aCodec) {
      const tracks = audibleCount()
      setStage(
        'audio',
        `Mixing ${tracks} audio ${tracks === 1 ? 'source' : 'sources'} — ${clockOf(duration)} at 48 kHz`,
        null,
      )
      try {
        // Named per source and per step: this is the longest stretch of an
        // export with nothing on screen, and "Mixing 4 audio sources" sitting
        // there for minutes is indistinguishable from a hang.
        const mix = await mixdown(duration, (msg, frac) => setStage('audio', msg, frac))
        audio = mix.buf
        // Silence used to be the only symptom of a source the mixdown couldn't
        // read — and a part-silent export sounds like a bug in the app rather
        // than a file it can't decode.
        if (mix.failed.length) {
          notes.push(`no audio from ${mix.failed.join('; ')}`)
          setSummary(`${summary} · ${notes.join(' · ')}`)
        }
      } catch {
        /* keep going without sound rather than failing the whole export */
      }
    }

    if (audio) {
      const mb = (audio.length * Math.min(2, audio.numberOfChannels) * 2) / 1e6
      // encoded and staged in one pass — the WAV never exists whole in memory
      await exportAudioBegin()
      await streamWav(audio, exportAudioChunk, (done, all) =>
        setStage('audio', `Writing audio track — ${mb.toFixed(0)} MB WAV`, done / all),
      )
      await exportAudioEnd()
      // It's on disk now. A half-hour stereo mix is ~700MB of Float32, and
      // holding it for the whole render is pressure the browser answers by
      // evicting other things — GPU resources included.
      audio = null
    }
    if (isCancelled()) throw new Error('cancelled')
    setStage('render', plan ? 'Starting hardware encoder…' : `Starting ${settings.vCodec}…`, 0)
    // the renderer decides the wire format; ffmpeg has to be told the same thing
    await exportBegin(out, {
      ...settings,
      rawPixFmt: renderer.pixFmt,
      wire: plan ? plan.wire : 'rawvideo',
    })
    resetRate()
    piping = true

    if (plan) {
      await encodeInWebview(plan, canvas, renderer, { total, fps, width, height })
      await finalise()
      piping = false
      finishExport()
      return
    }

    // Frames are batched into one IPC call, and two batches are kept in flight so
    // a batch crosses the boundary while the next one renders. Each invoke has
    // fixed overhead regardless of size, so sending 8MB four times costs four
    // times that overhead; one 33MB call pays it once. ffmpeg reads a rawvideo
    // stream, so concatenated frames need no framing of their own.
    const bytes = renderer.frameBytes
    const BATCH = Math.max(1, Math.min(8, Math.ceil(24e6 / bytes))) // ~24MB per call
    const bufs = [new Uint8Array(bytes * BATCH), new Uint8Array(bytes * BATCH)]
    const pump = makePump()
    const inflight: (Promise<void> | null)[] = [null, null]
    let batch = 0 // which buffer we're filling
    let n = 0 // frames already packed into it

    const flush = async () => {
      if (!n) return
      // subarray, not slice: a copy here would undo the point of batching
      const payload = bufs[batch].subarray(0, n * bytes)
      inflight[batch] = exportFrame(payload)
      batch = (batch + 1) % 2
      n = 0
      if (inflight[batch]) await inflight[batch] // never refill a buffer mid-send
    }

    for (let i = 0; i < total; i++) {
      const t0 = performance.now()
      if (n === 0 && inflight[batch]) await inflight[batch]
      const t1 = performance.now() // time blocked on IPC counts as send
      await renderer.render(i / fps)
      const t2 = performance.now()
      // straight out of the GL framebuffer — no PNG encode, no base64
      renderer.readFrame(bufs[batch].subarray(n * bytes, (n + 1) * bytes))
      const t3 = performance.now()
      n++
      if (n === BATCH) await flush()
      const t4 = performance.now()
      // Both waits count as send, and the flush one is the point. It used to be
      // left out, which meant the reported phases summed to a fraction of the
      // real frame time and "send 0ms" was true only because the one await it
      // measured is the one flush() has already resolved. The numbers now add
      // up to the wall clock, so an unexplained gap can't hide in here again.
      // seek is carved out of the render window, not added to it
      const seekMs = renderer.lastSeekMs
      reportPhase(seekMs, t2 - t1 - seekMs, t3 - t2, t1 - t0 + (t4 - t3))
      reportFrame(i + 1)
      if (isCancelled()) throw new Error('cancelled')
      await pump() // let the window repaint and the Cancel button be clickable
    }
    await flush()
    await Promise.all(inflight.filter(Boolean))
    await finalise()
    piping = false
    finishExport()
  } catch (e) {
    if (piping) await exportCancel().catch(() => {})
    const msg = (e as Error).message || String(e)
    finishExport(
      msg === 'cancelled'
        ? 'Cancelled — the part of the video rendered so far was saved and will play.'
        : msg,
    )
  } finally {
    renderer?.dispose()
    // give the pipeline back on every path out — cancel and error included, or
    // the preview stays dark and the filmstrips blank until the app restarts
    setMediaExclusive(false)
  }
}

/**
 * The last step, and the one that looks most like a hang.
 *
 * ffmpeg still has to flush its encoder and write the container, which is a
 * single opaque call that can run for a while on a long export. A bar pinned at
 * 100% with a frozen elapsed time is indistinguishable from a crash, so the bar
 * goes indeterminate and a heartbeat keeps the clock ticking.
 */
async function finalise() {
  setStage('finish', 'Finalising — ffmpeg is flushing the encoder and writing the container…', null)
  const stop = startHeartbeat()
  try {
    await exportEnd()
  } finally {
    stop()
  }
}

/**
 * Frame loop for the WebCodecs path. Short because both expensive steps are
 * gone: no readback (the encoder takes the canvas) and nothing large crossing
 * IPC, so no batch buffers and no in-flight bookkeeping. Render, encode, and let
 * the encoder's back-pressure set the pace.
 */
async function encodeInWebview(
  plan: WebCodecPlan,
  canvas: HTMLCanvasElement,
  renderer: { render: (t: number) => Promise<void>; lastSeekMs: number },
  job: { total: number; fps: number; width: number; height: number },
) {
  const { total, fps } = job
  const enc = createFrameEncoder(plan, fps, exportFrame)
  const pump = makePump()
  try {
    for (let i = 0; i < total; i++) {
      const t0 = performance.now()
      await renderer.render(i / fps)
      const t1 = performance.now()
      const { encWaitMs, pipeWaitMs, captureMs } = await enc.encode(canvas, i)
      const seekMs = renderer.lastSeekMs
      // `readback` carries the canvas capture here — it's the GPU sync, which is
      // the closest thing this path has to a readback. The two waits are kept
      // apart: one is Chromium's encoder not keeping up, the other is our own
      // chunks not reaching ffmpeg, and only the second is ours to fix.
      reportPhase(seekMs, t1 - t0 - seekMs, captureMs, encWaitMs, pipeWaitMs)
      reportFrame(i + 1)
      if (isCancelled()) throw new Error('cancelled')
      await pump() // let the window repaint and the Cancel button be clickable
    }
    setStage('finish', 'Flushing the encoder…', null)
    await enc.finish()
  } finally {
    // cancel and error both leave the loop here; the session must not outlive it
    enc.close()
  }
}

function newCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return c
}

/**
 * Estimated cost of one frame on the raw path, ms — readback plus IPC.
 *
 * An estimate, not a measurement: extrapolated from one machine at 1080p yuv420p
 * (3.11MB/frame, 8ms readback + 19ms send ≈ 8.7ms/MB) and scaled by frame size.
 * It holds because this path's cost barely depends on content — a fixed byte
 * count off the GPU and through the pipe. Still wrong on unlike hardware, which
 * is why the summary labels it estimated next to the measured figure.
 */
function rawTailMs(width: number, height: number): number {
  const mb = (width * height * 1.5) / 1e6
  return mb * 8.7
}

/**
 * How much worse the in-app encoder has to measure before 'auto' abandons it.
 *
 * This compares a MEASUREMENT to an ESTIMATE, not two measurements, so a figure
 * landing near `rawTailMs` decides nothing — and it drifts with whatever else
 * the machine is doing during the probe. Without a margin the same project
 * picked the in-app encoder one run and ffmpeg the next: a 4–5x swing that looks
 * like the app randomly getting slow.
 *
 * Biased toward the in-app encoder on purpose — when it wins it wins by a lot,
 * so a marginal loss isn't worth the risk of the estimate being wrong.
 */
const RAW_MARGIN = 1.5

/** how many timeline sources will actually contribute sound */
function audibleCount(): number {
  const ids = new Set<string>()
  for (const tr of timeline.value.tracks)
    for (const c of tr.clips) {
      if (isSilent(c) || !c.assetId) continue
      const a = assets.value.find((x) => x.id === c.assetId)
      if (a && !a.missing && (a.kind === 'audio' || a.kind === 'video')) ids.add(c.assetId)
    }
  return ids.size
}

const clockOf = (sec: number) => {
  const t = Math.round(sec)
  const m = Math.floor(t / 60)
  return `${m}:${(t % 60).toString().padStart(2, '0')}`
}
