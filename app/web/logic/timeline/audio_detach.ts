// Web implementation of "detach audio": decode a video/audio source with
// WebAudio and re-encode its audio track to a standalone WAV blob. Used by the
// timeline's Detach-audio action via the shared MediaOps slot.
//
// This is web-only (WebAudio, Blob URLs). Under Tauri this gets swapped for a
// native ffmpeg extraction behind the same MediaOps interface.
import type { ExtractedAudio, MediaSource, ProgressFn } from '@shared/logic/media/media'

const WAVE_BUCKETS = 600

let ctx: AudioContext | null = null
function audioCtx(): AudioContext {
  return (ctx ??= new (window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)())
}

function computePeaks(buf: AudioBuffer): number[] {
  const data = buf.getChannelData(0)
  const block = Math.max(1, Math.floor(data.length / WAVE_BUCKETS))
  const peaks: number[] = []
  for (let i = 0; i < WAVE_BUCKETS; i++) {
    let max = 0
    const start = i * block
    for (let j = 0; j < block && start + j < data.length; j++) {
      const v = Math.abs(data[start + j])
      if (v > max) max = v
    }
    peaks.push(Math.round(max * 1000) / 1000)
  }
  return peaks
}

/** Encode an AudioBuffer to a 16-bit PCM WAV Blob. */
function encodeWav(buf: AudioBuffer): Blob {
  const chans = buf.numberOfChannels
  const rate = buf.sampleRate
  const frames = buf.length
  const bytes = frames * chans * 2
  const out = new ArrayBuffer(44 + bytes)
  const view = new DataView(out)
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  view.setUint32(4, 36 + bytes, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, chans, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * chans * 2, true) // byte rate
  view.setUint16(32, chans * 2, true) // block align
  view.setUint16(34, 16, true) // bits
  str(36, 'data')
  view.setUint32(40, bytes, true)

  // interleave channels, clamp to 16-bit
  const data: Float32Array[] = []
  for (let c = 0; c < chans; c++) data.push(buf.getChannelData(c))
  let off = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < chans; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]))
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      off += 2
    }
  }
  return new Blob([out], { type: 'audio/wav' })
}

const baseName = (n: string) => n.replace(/\.[^.]+$/, '')

// Fetch the source into an ArrayBuffer, reporting real download % when the
// server sends Content-Length (blob: URLs usually do).
async function fetchBuffer(url: string, onStep?: ProgressFn): Promise<ArrayBuffer> {
  const resp = await fetch(url)
  const len = Number(resp.headers.get('Content-Length') || 0)
  if (!resp.body || !len) {
    onStep?.('Reading source…', null)
    return resp.arrayBuffer()
  }
  const reader = resp.body.getReader()
  const chunks: Uint8Array[] = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
    onStep?.(`Reading source… ${(got / 1e6).toFixed(1)} MB`, got / len)
  }
  const out = new Uint8Array(got)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out.buffer
}

// decodeAudioData holds the whole PCM in RAM and encodeWav walks every sample
// on the main thread, so past a certain size this stops being viable — bail
// instead of freezing the UI. Desktop uses native ffmpeg and has no such limit.
const MAX_WEB_DETACH = 300 * 1024 * 1024

export async function detachAudioWeb(
  src: MediaSource,
  name: string,
  onStep?: ProgressFn,
): Promise<ExtractedAudio | null> {
  const url = src.url
  try {
    onStep?.('Reading source…', null)
    const head = await fetch(url, { method: 'HEAD' }).catch(() => null)
    const len = Number(head?.headers.get('content-length') ?? NaN)
    if (Number.isFinite(len) && len > MAX_WEB_DETACH) return null
    const buf = await fetchBuffer(url, onStep)

    onStep?.('Decoding audio…', null)
    const audio = await audioCtx().decodeAudioData(buf)

    onStep?.('Encoding WAV…', null)
    const blob = encodeWav(audio)

    onStep?.('Analyzing waveform…', null)
    const peaks = computePeaks(audio)

    return {
      url: URL.createObjectURL(blob),
      name: baseName(name) + ' (audio).wav',
      ext: 'WAV',
      size: blob.size,
      duration: audio.duration,
      channels: audio.numberOfChannels,
      peaks,
    }
  } catch {
    // container WebAudio can't demux (e.g. MKV) — caller falls back
    return null
  }
}
