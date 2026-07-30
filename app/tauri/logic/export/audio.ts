// Offline audio mixdown for export. Renders every audible clip through an
// OfflineAudioContext (volume + pan, animated values baked as automation), then
// encodes 16-bit PCM WAV for ffmpeg to mux. Returns null when there's no audio.
import { timeline, isText, isSilent, type Clip } from '@shared/logic/timeline/timeline'
import { assets, type Asset } from '@shared/logic/tools/files/assets'
import { sampleClip } from '@shared/logic/timeline/anim'
import { yieldNow } from './pump'
import { masterBus } from '@shared/logic/audio/master'
import { extractAudioSpan, srcForPath } from '../bridge'

const RATE = 48000
const STEP = 1 / 30 // automation resolution for animated volume/pan
const clamp01 = (v: number) => Math.max(0, v)
const clampPan = (v: number) => Math.max(-1, Math.min(1, v))

/** clips that make sound: audio assets, or video that hasn't been muted/detached */
function audibleClips(): { clip: Clip; asset: Asset }[] {
  const out: { clip: Clip; asset: Asset }[] = []
  for (const tr of timeline.value.tracks)
    for (const c of tr.clips) {
      if (isText(c) || !c.assetId || isSilent(c)) continue
      const a = assets.value.find((x) => x.id === c.assetId)
      if (!a || a.missing) continue
      if (a.kind !== 'audio' && a.kind !== 'video') continue
      out.push({ clip: c, asset: a })
    }
  return out
}

/** 44-byte canonical WAV header for `n` frames of `ch`-channel 16-bit PCM. */
function wavHeader(n: number, ch: number, rate: number): Uint8Array {
  const out = new ArrayBuffer(44)
  const dv = new DataView(out)
  const str = (off: number, v: string) => {
    for (let i = 0; i < v.length; i++) dv.setUint8(off + i, v.charCodeAt(i))
  }
  const data = n * ch * 2
  str(0, 'RIFF')
  dv.setUint32(4, 36 + data, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true) // PCM
  dv.setUint16(22, ch, true)
  dv.setUint32(24, rate, true)
  dv.setUint32(28, rate * ch * 2, true)
  dv.setUint16(32, ch * 2, true)
  dv.setUint16(34, 16, true)
  str(36, 'data')
  dv.setUint32(40, data, true)
  return new Uint8Array(out)
}

/** ~8MB of 16-bit stereo per chunk — small enough that no single IPC message
 *  or disk write stalls anything, large enough that the call count stays low. */
const WAV_CHUNK = 1 << 21 // frames

/**
 * Encode an AudioBuffer to 16-bit PCM WAV, a chunk at a time.
 *
 * Two things bite at timeline length. `DataView.setInt16` is ~10x slower than an
 * `Int16Array` view, and a half-hour stereo mix is ~180M samples — the old
 * per-sample loop froze the UI for minutes. Hence typed-array writes in chunks,
 * yielding between them.
 *
 * And the result is ~360MB, so it streams instead of returning: one buffer, plus
 * an IPC copy, plus a Rust copy, for something headed straight to disk. `send`
 * is awaited before the scratch buffer is refilled, so it must be done with the
 * bytes before it resolves.
 */
export async function streamWav(
  buf: AudioBuffer,
  send: (bytes: Uint8Array) => Promise<void>,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const ch = Math.min(2, buf.numberOfChannels)
  const n = buf.length
  await send(wavHeader(n, ch, buf.sampleRate))

  const chans: Float32Array[] = []
  for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c))
  // WAV is little-endian and so is every platform we target, so an Int16Array
  // can be handed over as bytes directly.
  const scratch = new Int16Array(WAV_CHUNK * ch)

  for (let start = 0; start < n; start += WAV_CHUNK) {
    const end = Math.min(n, start + WAV_CHUNK)
    for (let i = start; i < end; i++) {
      for (let c = 0; c < ch; c++) {
        const v = chans[c][i]
        scratch[(i - start) * ch + c] = v < 0 ? Math.max(-1, v) * 0x8000 : Math.min(1, v) * 0x7fff
      }
    }
    const used = (end - start) * ch
    await send(new Uint8Array(scratch.buffer, 0, used * 2))
    onProgress?.(end, n)
    // hand the thread back so the export dialog can repaint. Not setTimeout:
    // once the window is hidden Chromium throttles timers to about one a
    // second, which would stall a minimized export here for hours.
    await yieldNow()
  }
}

/** a decoded source, and the point in the ORIGINAL file its first sample is */
interface Source {
  buf: AudioBuffer
  base: number
}

/** the seconds of a source the timeline actually uses, across all its clips */
function spanOf(clips: Clip[]): { from: number; to: number } {
  let from = Infinity
  let to = 0
  for (const c of clips) {
    const start = Math.max(0, c.in ?? 0)
    if (start < from) from = start
    if (start + c.duration > to) to = start + c.duration
  }
  return { from: from === Infinity ? 0 : from, to }
}

/**
 * Decode one source, AT THE RENDER RATE, reading only the span that's used.
 *
 * Decoding in a plain AudioContext uses the hardware's rate, and a buffer whose
 * rate differs from the context it plays in is resampled by the source node —
 * by interpolation, which aliases. On a 44.1kHz device that meant every source
 * was resampled twice: properly on the way in, then crudely on the way out.
 *
 * ffmpeg cuts the span first wherever there's a path to give it. Handing the
 * whole file to `decodeAudioData` reads all of it into RAM and decodes all of
 * its audio no matter how little is used — an hour-long 4K source contributing
 * ten seconds still cost gigabytes read and an hour decoded, which is what an
 * export "freezing on Mixing N audio sources" was doing. It also fails outright
 * on containers and codecs ffmpeg reads fine, and the failure was silent: those
 * clips simply had no sound while the ones either side of them did.
 */
async function decodeSource(
  probe: BaseAudioContext,
  asset: Asset,
  span: { from: number; to: number },
): Promise<Source | null> {
  if (asset.path) {
    try {
      // a little tail, so rounding can't clip the last frames off a cut
      const wav = await extractAudioSpan(asset.path, span.from, span.to - span.from + 0.05)
      const data = await (await fetch(srcForPath(wav))).arrayBuffer()
      return { buf: await probe.decodeAudioData(data), base: span.from }
    } catch {
      // no ffmpeg, no audio track, or it couldn't read the file — try the
      // webview, which at least handles media that only exists as a blob
    }
  }
  if (!asset.url) return null
  try {
    const data = await (await fetch(asset.url)).arrayBuffer()
    return { buf: await probe.decodeAudioData(data), base: 0 }
  } catch {
    return null
  }
}

/**
 * Mix the timeline down to a single AudioBuffer. `duration` in seconds.
 * WebCodecs takes this directly; the ffmpeg path runs it through `streamWav`.
 *
 * `failed` names the sources that contributed nothing, so an export that comes
 * out part-silent says which footage did it instead of just sounding broken.
 */
export async function mixdown(
  duration: number,
  onStep?: (msg: string, frac: number | null) => void,
): Promise<{ buf: AudioBuffer | null; failed: string[] }> {
  const clips = audibleClips()
  const failed: string[] = []
  if (!clips.length || duration <= 0) return { buf: null, failed }

  // one decode per distinct source, whatever it's used for
  const byAsset = new Map<string, { asset: Asset; clips: Clip[] }>()
  for (const { clip, asset } of clips) {
    const e = byAsset.get(asset.id)
    if (e) e.clips.push(clip)
    else byAsset.set(asset.id, { asset, clips: [clip] })
  }

  const decoded = new Map<string, Source>()
  const probe = new OfflineAudioContext(1, 1, RATE)
  let done = 0
  for (const [id, { asset, clips: uses }] of byAsset) {
    onStep?.(`Reading audio from ${asset.name}`, done / byAsset.size)
    const src = await decodeSource(probe, asset, spanOf(uses))
    if (src) decoded.set(id, src)
    else failed.push(asset.name)
    done++
    await yieldNow()
  }
  if (!decoded.size) return { buf: null, failed }

  onStep?.(`Mixing ${decoded.size} source${decoded.size === 1 ? '' : 's'}`, null)
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * RATE), RATE)
  // same master chain the preview plays through, so the file matches it
  const master = masterBus(ctx)
  for (const { clip } of clips) {
    const src0 = decoded.get(clip.assetId!)
    if (!src0) continue
    const buf = src0.buf
    const src = ctx.createBufferSource()
    src.buffer = buf
    // pitch placeholder matches preview behaviour (rate shift)
    const semis = clip.pitch ?? 0
    if (semis) src.playbackRate.value = Math.pow(2, semis / 12)

    const gain = ctx.createGain()
    const pan = ctx.createStereoPanner()
    src.connect(gain).connect(pan).connect(master)

    // Bake (possibly animated) volume/pan as automation over the clip. Only
    // what's actually keyframed gets an automation curve: a static value was
    // still being written every 1/30s, so a half-hour clip put ~56k identical
    // events on the timeline of a node whose value never moves — all of which
    // the renderer then has to walk.
    const vol = clamp01(sampleClip(clip, 'volume', 0))
    const p = clampPan(sampleClip(clip, 'pan', 0))
    if (!clip.anim?.volume) gain.gain.value = vol
    if (!clip.anim?.pan) pan.pan.value = p
    if (clip.anim?.volume || clip.anim?.pan) {
      for (let t = 0; t <= clip.duration; t += STEP) {
        const at = clip.start + t
        if (clip.anim?.volume) gain.gain.setValueAtTime(clamp01(sampleClip(clip, 'volume', t)), at)
        if (clip.anim?.pan) pan.pan.setValueAtTime(clampPan(sampleClip(clip, 'pan', t)), at)
      }
    }

    // the buffer may be a cut of the source rather than the whole thing, so the
    // clip's in-point is relative to where that cut began
    const offset = Math.max(0, (clip.in ?? 0) - src0.base)
    src.start(clip.start, offset, clip.duration)
  }
  return { buf: await ctx.startRendering(), failed }
}
