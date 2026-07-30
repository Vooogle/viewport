// Video poster-frame extraction for timeline filmstrips.
// Memory-conscious: frames are low-res WebP, quantized to time buckets and
// cached per asset so a clip only ever holds a handful of small thumbnails.
// Frames also persist to IndexedDB, so reopening a project draws its filmstrips
// without opening a decoder at all. One hidden <video> per asset does the
// seeking, and it is handed back once extraction goes idle.

import { mediaExclusive } from '../media/exclusive'

const THUMB_H = 48 // captured frame height, px (width follows aspect)
/** Seconds — nearby times share one cached frame. Filmstrips place their
 *  tiles on this grid so zooming re-uses what's already decoded. */
export const THUMB_QUANT = 0.5
const QUANT = THUMB_QUANT

interface Extractor {
  video: HTMLVideoElement
  chain: Promise<unknown>
}

const caches = new Map<string, Map<number, string>>() // assetId -> bucket -> dataURL
const extractors = new Map<string, Extractor>()

const bucket = (t: number) => Math.round(t / QUANT) * QUANT

// --- persistent frame cache ---
//
// Reopening a saved project used to re-extract every filmstrip frame, which
// meant opening a <video> on every source at once to redraw thumbnails the user
// already had last session. Frames are small WebP data URLs, so keeping them is
// cheap — and a cache hit means the extractor never has to exist.
//
// Every failure path resolves rather than rejects: a browser with IndexedDB
// disabled must still get filmstrips, just without the persistence.
const DB_NAME = 'viewport-thumbs'
const STORE = 'frames'
let dbPromise: Promise<IDBDatabase | null> | null = null

function db(): Promise<IDBDatabase | null> {
  return (dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null) // private mode or storage disabled — memory cache still works
    }
  }))
}

const dbKey = (assetId: string, b: number) => `${assetId}|${b}`

async function idbGet(assetId: string, b: number): Promise<string | undefined> {
  const d = await db()
  if (!d) return undefined
  return new Promise((resolve) => {
    try {
      const r = d.transaction(STORE, 'readonly').objectStore(STORE).get(dbKey(assetId, b))
      r.onsuccess = () => resolve(typeof r.result === 'string' ? r.result : undefined)
      r.onerror = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
}

function idbPut(assetId: string, b: number, data: string) {
  void db().then((d) => {
    if (!d) return
    try {
      d.transaction(STORE, 'readwrite').objectStore(STORE).put(data, dbKey(assetId, b))
    } catch {
      /* quota or a closed connection — the memory cache still has it */
    }
  })
}

/** Drop every stored frame for one asset (its media changed or it's gone). */
function idbDrop(assetId: string) {
  void db().then((d) => {
    if (!d) return
    try {
      const os = d.transaction(STORE, 'readwrite').objectStore(STORE)
      const r = os.openKeyCursor()
      r.onsuccess = () => {
        const c = r.result
        if (!c) return
        if (String(c.key).startsWith(assetId + '|')) os.delete(c.key)
        c.continue()
      }
    } catch {
      /* nothing to clean up */
    }
  })
}

// --- decoder lifetime ---

/**
 * How long an idle extractor may keep its decoder.
 *
 * A `<video preload="auto">` holds a decoder and a read-ahead buffer. Fine while
 * a filmstrip is being built, not for the rest of the session: the media
 * pipeline is shared with the hardware ENCODER, and enough idle decoders in it
 * is the difference between NVENC and a silent software fallback — which is how
 * a reopened project exported several times slower than a fresh one.
 */
const IDLE_MS = 4000
const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** in-flight extractions, so duplicate tiles share one decode */
const pending = new Map<string, Promise<string>>()

function scheduleRelease(assetId: string) {
  clearTimeout(releaseTimers.get(assetId))
  releaseTimers.set(
    assetId,
    setTimeout(() => {
      releaseTimers.delete(assetId)
      // something asked again while the timer ran — leave it alone
      for (const k of pending.keys()) if (k.startsWith(assetId + '|')) return
      const ex = extractors.get(assetId)
      if (!ex) return
      release(ex)
      extractors.delete(assetId) // frames stay cached; only the decoder goes
    }, IDLE_MS),
  )
}

function getExtractor(assetId: string, url: string): Extractor {
  let ex = extractors.get(assetId)
  if (ex) return ex
  const video = document.createElement('video')
  video.src = url
  video.muted = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  ex = { video, chain: Promise.resolve() }
  extractors.set(assetId, ex)
  return ex
}

/** Frame nearest `time` (seconds) as a small WebP data URL. Cached + serialized. */
export function requestThumb(assetId: string, url: string, time: number): Promise<string> {
  const key = bucket(time)
  let cache = caches.get(assetId)
  if (!cache) caches.set(assetId, (cache = new Map()))
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)

  const pk = dbKey(assetId, key)
  const live = pending.get(pk)
  if (live) return live

  const job = (async () => {
    // Stored frames come back without touching the media pipeline, which is the
    // whole point — on a reopen this returns before any decoder is created.
    const stored = await idbGet(assetId, key)
    if (stored) {
      cache!.set(key, stored)
      return stored
    }
    // Cached frames are always fine to serve, but opening a decoder is not:
    // an export owns the pipeline and a filmstrip is not worth costing it the
    // hardware encoder. Tiles re-request once the export releases it.
    if (mediaExclusive.value) throw new Error('media pipeline reserved for export')
    const ex = getExtractor(assetId, url)
    const run = ex.chain.then(() => extractFrame(ex.video, key))
    ex.chain = run.catch(() => {}) // keep the chain alive even if one fails
    const data = await run
    cache!.set(key, data)
    idbPut(assetId, key, data)
    return data
  })()

  pending.set(pk, job)
  void job.catch(() => {}).then(() => {
    pending.delete(pk)
    scheduleRelease(assetId)
  })
  return job
}

function extractFrame(v: HTMLVideoElement, time: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const draw = () => {
      const t = Math.min(time, v.duration || time)
      const onSeeked = () => {
        v.removeEventListener('seeked', onSeeked)
        const vh = v.videoHeight || THUMB_H
        const vw = v.videoWidth || THUMB_H
        const w = Math.max(1, Math.round((vw / vh) * THUMB_H))
        const c = document.createElement('canvas')
        c.width = w
        c.height = THUMB_H
        const ctx = c.getContext('2d')
        if (!ctx) return reject(new Error('no 2d ctx'))
        ctx.drawImage(v, 0, 0, w, THUMB_H)
        try {
          // WebP is ~25-35% smaller than JPEG at equal quality; Chromium-only,
          // which is fine for the target. Falls back to JPEG if unsupported.
          let data = c.toDataURL('image/webp', 0.6)
          if (!data.startsWith('data:image/webp')) data = c.toDataURL('image/jpeg', 0.6)
          resolve(data)
        } catch (err) {
          reject(err as Error)
        }
      }
      v.addEventListener('seeked', onSeeked)
      v.currentTime = t
    }
    if (v.readyState >= 2 && v.videoWidth) draw()
    else {
      v.addEventListener('loadeddata', draw, { once: true })
      v.addEventListener('error', () => reject(new Error('thumb load failed')), { once: true })
    }
  })
}

/** Drop cached frames + the hidden video for an asset (removed / replaced). */
export function clearThumbs(assetId: string) {
  caches.delete(assetId)
  clearTimeout(releaseTimers.get(assetId))
  releaseTimers.delete(assetId)
  // the media behind these frames is gone or has changed, so the stored copies
  // are wrong — unlike a project switch, which wants to keep them
  idbDrop(assetId)
  const ex = extractors.get(assetId)
  if (ex) {
    release(ex)
    extractors.delete(assetId)
  }
}

/**
 * Hand back every decoder — for switching projects, and before an export.
 *
 * These live in module-level maps, so replacing `assets` does NOT free them: a
 * hidden `<video>` per source stays alive holding a decoder for a file nothing
 * refers to any more, and that cost follows you into every project after it.
 *
 * Stored frames are deliberately kept: they cost nothing to hold and are what
 * lets the next project draw its filmstrips without opening anything.
 */
export function clearAllThumbs() {
  for (const ex of extractors.values()) release(ex)
  extractors.clear()
  for (const t of releaseTimers.values()) clearTimeout(t)
  releaseTimers.clear()
  caches.clear()
}

/** Make the element let go of its decoder — dropping the reference isn't enough. */
function release(ex: Extractor) {
  ex.video.pause()
  ex.video.removeAttribute('src')
  ex.video.load()
}

/**
 * Let a probe element go once it has answered.
 *
 * A `<video>` that is never told to let go keeps its decoder and its handle on
 * the file for the life of the session. Reopening a project probes every source
 * at once, so these pile up in exactly the pipeline the export needs.
 */
function releaseEl(el: HTMLMediaElement) {
  el.removeAttribute('src')
  el.load()
}

/** Media duration in seconds (images default to 5). */
export function probeDuration(url: string, kind: string): Promise<number> {
  return new Promise((resolve) => {
    if (kind === 'image' || kind === 'other') return resolve(5)
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video')
    el.preload = 'metadata'
    // el.duration is Infinity for streams and unknown-length media, and NaN
    // before metadata settles. `|| 5` lets both through (Infinity is truthy),
    // which puts a bogus length on the clip and blows up everything downstream
    // that multiplies by the timeline duration.
    const ok = (d: number) => (Number.isFinite(d) && d > 0 && d < 24 * 3600 ? d : 5)
    const done = (d: number) => {
      releaseEl(el)
      resolve(d)
    }
    el.addEventListener('loadedmetadata', () => done(ok(el.duration)), { once: true })
    el.addEventListener('error', () => done(5), { once: true })
    el.src = url
  })
}

/** Natural pixel dimensions of a visual source (image or video), or null. */
export function probeSize(url: string, kind: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    if (kind === 'image') {
      const img = new Image()
      img.addEventListener('load', () => resolve(img.naturalWidth ? { w: img.naturalWidth, h: img.naturalHeight } : null), { once: true })
      img.addEventListener('error', () => resolve(null), { once: true })
      img.src = url
    } else if (kind === 'video') {
      const v = document.createElement('video')
      v.preload = 'metadata'
      const done = (s: { w: number; h: number } | null) => {
        releaseEl(v)
        resolve(s)
      }
      v.addEventListener('loadedmetadata', () => done(v.videoWidth ? { w: v.videoWidth, h: v.videoHeight } : null), { once: true })
      v.addEventListener('error', () => done(null), { once: true })
      v.src = url
    } else {
      resolve(null)
    }
  })
}
