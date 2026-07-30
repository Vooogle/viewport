// Platform media operations. Shared/UI code calls these; the running platform
// (web = WebCodecs/WebAudio, Tauri = native ffmpeg later) registers an impl.
// Keeps heavy, environment-specific media work out of the shared layer.

export interface ExtractedAudio {
  /** object URL (or file path under native) for the extracted audio */
  url: string
  name: string
  /** upper-case type, e.g. WAV */
  ext: string
  size: number
  duration: number
  channels?: number
  /** volume waveform peaks (0..1) over the whole clip */
  peaks?: number[]
}

/** Live progress reporter: detail text + optional 0..1 value (null = indeterminate). */
export type ProgressFn = (detail: string, value?: number | null) => void

/** Where a media source lives. `path` is set on desktop, where native tools can
 *  read the file directly instead of going through a URL. */
export interface MediaSource {
  url: string
  path?: string
}

export interface MediaOps {
  /** Extract a source's audio into its own asset. null if it can't be decoded. */
  detachAudio(src: MediaSource, name: string, onStep?: ProgressFn): Promise<ExtractedAudio | null>
}

let ops: MediaOps | null = null
export function setMediaOps(o: MediaOps) {
  ops = o
}
export function mediaOps(): MediaOps | null {
  return ops
}
