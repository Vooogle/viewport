// Low-resolution stand-ins for the preview.
//
// Playing a timeline of full-resolution sources is decode-bound long before it
// is fill-rate bound: every layer on screen is its own decoder, seeking inside
// long-GOP video, uploading a full-size frame per tick. Scaling the canvas down
// does nothing about that — the decode happens at the source's resolution
// whatever size you draw it.
//
// A proxy is the same footage, small and all-intra, so a seek is a direct read
// rather than a decode from the previous keyframe, and the upload is a fraction
// of the bytes. The export already builds these; this asks for the same thing at
// a preview-sized box, and ffmpeg's cache is keyed on the box, so the two don't
// collide or duplicate work.
//
// Entirely optional. Without a path (browser), without ffmpeg, or before one has
// finished building, the renderer just uses the original — a proxy only ever
// makes things faster, never possible.
import { signal, effect } from '@preact/signals'
import { platform } from '../platform/platform'
import { mediaExclusive } from '../media/exclusive'
import { assets } from '../tools/files/assets'
import { timeline, playing } from '../timeline/timeline'
import type { Project } from '../project/project'

export interface ProxySrc {
  url: string
  /** source frame rate, 0 when it couldn't be read */
  fps: number
}

/** assetId → its preview proxy, for whatever has finished building. */
export const previewProxies = signal<Record<string, ProxySrc>>({})

/**
 * assetId → a small audio-only stand-in, for the preview mixer.
 *
 * The picture in the preview comes from a proxy; the sound was still coming
 * from the original file, and that asymmetry hid a whole class of failure. The
 * webview's demuxer refuses containers and codecs ffmpeg reads fine, and when
 * it does the object plays silently while its picture keeps going — "some
 * objects just have no audio", never the same ones as anybody else's. Seeking
 * for sound inside a multi-GB video is also slow enough to be heard, as
 * crackles when the mixer re-syncs.
 */
export const previewAudio = signal<Record<string, string>>({})

/** Container/codec pairs the webview reads reliably — no stand-in needed. */
const SAFE_AUDIO = new Set(['MP3', 'M4A', 'AAC', 'WAV', 'OGG', 'OPUS', 'FLAC', 'WEBM'])

/**
 * Long edge of a preview proxy.
 *
 * Fixed rather than derived from the panel: the box is part of ffmpeg's cache
 * key, so following the window size would rebuild the whole set on every
 * resize. 960 is comfortably above any preview panel on a normal display.
 */
const LONG_EDGE = 960

/** Box for a project, aspect preserved. ffmpeg fits inside it and never upscales. */
function boxFor(p: Project): [number, number] {
  const s = Math.min(1, LONG_EDGE / Math.max(p.width, p.height))
  const even = (n: number) => Math.max(2, Math.round((n * s) / 2) * 2)
  return [even(p.width), even(p.height)]
}

/** assets already handled — including the ones that failed, so a source ffmpeg
 *  can't read isn't retried on every pass */
const done = new Set<string>()
/** same, for the audio stand-ins — they fail independently of the video ones */
const doneAudio = new Set<string>()
let sweeping = false

/**
 * Build whatever proxies the timeline still needs, one at a time.
 *
 * Serial on purpose: each is an ffmpeg transcode, and starting six at once to
 * make the preview smoother would bring the machine to its knees doing it.
 * Results are published in one go at the end, since every publish rebuilds the
 * renderer and doing that per source would make opening a project a slideshow.
 */
export async function ensurePreviewProxies(project: Project) {
  const make = platform.value.proxyFor
  const makeAudio = platform.value.audioProxyFor
  // An export owns ffmpeg and the media pipeline; competing with it for either
  // is how an export loses its hardware encoder.
  // Not while the timeline is running: the transcode is the heaviest thing on
  // the machine, and playback is when its cost is most audible. It picks up
  // again the moment playback stops.
  if (sweeping || mediaExclusive.value || playing.value) return

  const used = new Set<string>()
  for (const tr of timeline.value.tracks)
    for (const c of tr.clips) if (c.assetId) used.add(c.assetId)

  const todo = make
    ? assets.value.filter((a) => used.has(a.id) && a.kind === 'video' && a.path && !done.has(a.id))
    : []
  // Video always: its sound is buried in a container built for pictures. Audio
  // files only when the webview may not read them — re-encoding an MP3 that
  // already plays is cost for nothing.
  const todoAudio = makeAudio
    ? assets.value.filter(
        (a) =>
          used.has(a.id) &&
          a.path &&
          !doneAudio.has(a.id) &&
          (a.kind === 'video' || (a.kind === 'audio' && !SAFE_AUDIO.has(a.ext.toUpperCase()))),
      )
    : []
  if (!todo.length && !todoAudio.length) return

  sweeping = true
  const [w, h] = boxFor(project)
  const found: Record<string, ProxySrc> = {}
  const foundAudio: Record<string, string> = {}
  try {
    for (const a of todo) {
      done.add(a.id) // marked before the await: a failure must not loop
      if (mediaExclusive.value) break
      const got = await make!(a.path!, w, h)
      if (got) found[a.id] = got
    }
    for (const a of todoAudio) {
      doneAudio.add(a.id)
      if (mediaExclusive.value) break
      const got = await makeAudio!(a.path!)
      if (got) foundAudio[a.id] = got
    }
  } finally {
    sweeping = false
    if (Object.keys(found).length) previewProxies.value = { ...previewProxies.value, ...found }
    // published separately: this one only reaches the mixer, and rebuilding the
    // renderer for it would drop every video decoder for a sound change
    if (Object.keys(foundAudio).length) previewAudio.value = { ...previewAudio.value, ...foundAudio }
  }
}

/**
 * Drop a proxy when its source is relinked.
 *
 * Watched here rather than called from the asset code, which would make the two
 * modules import each other. A stand-in that outlived the footage it stands in
 * for would show the OLD video in the preview and the new one in the export.
 */
const seenUrl = new Map<string, string>()
effect(() => {
  for (const a of assets.value) {
    const prev = seenUrl.get(a.id)
    if (prev !== undefined && prev !== a.url) dropPreviewProxy(a.id)
    seenUrl.set(a.id, a.url)
  }
})

/** Forget a source's proxies — its media changed, so the stand-ins are stale. */
export function dropPreviewProxy(assetId: string) {
  done.delete(assetId)
  doneAudio.delete(assetId)
  if (previewAudio.value[assetId]) {
    const next = { ...previewAudio.value }
    delete next[assetId]
    previewAudio.value = next
  }
  if (!previewProxies.value[assetId]) return
  const next = { ...previewProxies.value }
  delete next[assetId]
  previewProxies.value = next
}
