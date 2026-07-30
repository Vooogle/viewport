// Desktop media operations. Anything heavy goes through ffmpeg in the Rust
// process rather than WebAudio on the render thread — the web implementation
// decodes the whole file into RAM and re-encodes it sample-by-sample, which
// locks the UI on long sources.
import type { ExtractedAudio, MediaOps, MediaSource, ProgressFn } from '@shared/logic/media/media'
import { detachAudioWeb } from '../../web/logic/timeline/audio_detach'
import { extractAudio, srcForPath } from './bridge'

const baseName = (n: string) => n.replace(/\.[^.]+$/, '')

async function detachAudioNative(
  src: MediaSource,
  name: string,
  onStep?: ProgressFn,
): Promise<ExtractedAudio | null> {
  // no path (e.g. a file dropped into the webview) → nothing native to read
  if (!src.path) return detachAudioWeb(src, name, onStep)

  onStep?.('Extracting audio…', null)
  let wavPath: string
  try {
    wavPath = await extractAudio(src.path)
  } catch {
    // no audio track, or ffmpeg couldn't demux it — the caller falls back to
    // referencing the video itself
    return null
  }

  const url = srcForPath(wavPath)
  onStep?.('Reading track…', null)
  // the extracted WAV is far smaller than the source video, so measuring it in
  // the webview is cheap; peaks come from the shared analysis path
  try {
    const buf = await (await fetch(url)).arrayBuffer()
    const ctx = new AudioContext()
    const audio = await ctx.decodeAudioData(buf.slice(0))
    void ctx.close()
    return {
      url,
      name: baseName(name) + ' (audio).wav',
      ext: 'WAV',
      size: buf.byteLength,
      duration: audio.duration,
      channels: audio.numberOfChannels,
      peaks: peaksOf(audio),
    }
  } catch {
    // still usable on the timeline even if we couldn't measure it here
    return { url, name: baseName(name) + ' (audio).wav', ext: 'WAV', size: 0, duration: 0 }
  }
}

const WAVE_BUCKETS = 600
function peaksOf(buf: AudioBuffer): number[] {
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

export const tauriMediaOps: MediaOps = { detachAudio: detachAudioNative }
