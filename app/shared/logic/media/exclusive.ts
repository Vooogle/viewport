// Who owns the media pipeline.
//
// An export needs the video pipeline to itself. Every other media consumer —
// filmstrip extractors, the preview's <video> planes, the mixer's voices — puts
// decoders in the SAME pipeline as the hardware ENCODER, and Chromium answers a
// crowded pipeline by silently handing `prefer-hardware` a software encoder.
// Measured: 4ms/frame vs 30ms+, i.e. minutes vs hours.
//
// So while this is set, those consumers stand down. It lives in shared rather
// than beside the export because its consumers are shared UI, which must not
// import from a platform bundle.
import { signal } from '@preact/signals'

/** true while an export owns the media pipeline; nothing else may open a decoder */
export const mediaExclusive = signal(false)

/** Take or release the pipeline. Pair every `true` with a `false` in a finally. */
export function setMediaExclusive(on: boolean) {
  mediaExclusive.value = on
}
