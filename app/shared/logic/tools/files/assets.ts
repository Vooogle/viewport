// Media assets + a file-type registry plugins can extend.
//
// Persistence: only metadata (name/type/size/date) is saved — the actual file
// blob cannot survive a refresh. On reload, assets come back as "missing"
// (blank slots) that the user can relink by replacing them.
import { signal } from '@preact/signals'
import { clearThumbs, clearAllThumbs, probeDuration, probeSize } from '../../timeline/thumbs'
import { platform } from '../../platform/platform'

const baseName = (p: string) => p.split(/[\\/]/).pop() || p
import { retargetAsset } from '../../timeline/timeline'

export type AssetKind = 'video' | 'image' | 'audio' | 'other'

export interface FileType {
  /** lowercase extension without dot, e.g. "mp4" */
  ext: string
  kind: AssetKind
  /** optional custom icon name (white SVG) */
  icon?: string
}

const DEFAULT_TYPES: FileType[] = [
  ...['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'].map((ext) => ({ ext, kind: 'video' as const })),
  ...['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif'].map((ext) => ({ ext, kind: 'image' as const })),
  ...['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].map((ext) => ({ ext, kind: 'audio' as const })),
]

export const fileTypes = signal<FileType[]>(DEFAULT_TYPES)

/** Register one or more supported file types (plugins use this). */
export function registerFileType(ft: FileType | FileType[]) {
  const map = new Map(fileTypes.value.map((t) => [t.ext, t]))
  for (const t of Array.isArray(ft) ? ft : [ft]) map.set(t.ext.toLowerCase(), { ...t, ext: t.ext.toLowerCase() })
  fileTypes.value = [...map.values()]
}

function typeFor(ext: string) {
  return fileTypes.value.find((t) => t.ext === ext.toLowerCase())
}
export function isSupported(name: string): boolean {
  return !!typeFor(extLower(name))
}

export interface Asset {
  id: string
  name: string
  kind: AssetKind
  /** upper-case type shown in UI, e.g. MP4, PNG */
  ext: string
  size: number
  /** object URL, or '' when the blob is gone (missing after refresh) */
  url: string
  missing: boolean
  addedAt: number
  /** audio channel count, once probed (2 = stereo, 6 = 5.1, many for OBS) */
  channels?: number
  /** downsampled waveform peaks (0..1), one bucket over the whole source */
  peaks?: number[]
  /** natural pixel dimensions (image/video), once probed */
  width?: number
  height?: number
  /** absolute file path (desktop only) — lets a project reload the media itself */
  path?: string
}

export const assets = signal<Asset[]>([])

export type AssetMeta = Omit<Asset, 'url' | 'missing'>

/** Serializable metadata (no blobs) — used to persist per project. */
export function assetsMeta(): AssetMeta[] {
  return assets.value.map(({ id, name, kind, ext, size, addedAt, channels, peaks, width, height, path }) => ({
    id,
    name,
    kind,
    ext,
    size,
    addedAt,
    channels,
    peaks,
    width,
    height,
    path,
  }))
}

/**
 * Let go of everything the outgoing project's media is holding.
 *
 * Overwriting `assets` only drops the descriptions. The media itself is held
 * elsewhere — a hidden `<video>` per source in the thumbnail extractor cache,
 * and a blob URL per web-loaded file — and neither is reachable from the array,
 * so neither was ever released. Opening a large project therefore left its
 * decoders and buffers alive for the rest of the session, which is why an
 * export in a *different* project afterwards ran at a fraction of its rate.
 */
function releaseAssets() {
  for (const a of assets.value) if (a.url.startsWith('blob:')) URL.revokeObjectURL(a.url)
  clearAllThumbs()
}

/** Restore assets from metadata. On desktop, a stored file path reloads the
 *  media itself (asset protocol); on web the blob is gone → a blank slot to
 *  relink. */
export function hydrateAssets(meta: AssetMeta[]) {
  releaseAssets()
  const srcForPath = platform.value.srcForPath
  assets.value = meta.map((m) => {
    if (srcForPath && m.path) {
      const a: Asset = { ...m, url: srcForPath(m.path), missing: false }
      // Only probe what the saved metadata doesn't already carry. Re-probing
      // opens a <video> per source, on every reopen, for dimensions sitting
      // right there in the project file — and those elements land in the same
      // media pipeline the export's hardware encoder has to share.
      if (!a.width || !a.height) probeAssetSize(a.id, a.url, a.kind)
      if (!a.peaks?.length) probeAssetAudio(a.id, a.url, a.kind)
      return a
    }
    return { ...m, url: '', missing: true }
  })
}

/** Add media by absolute path (desktop). Reloads automatically on reopen.
 *  Returns the new asset ids, in the order given. */
export function addAssetsFromPaths(paths: string[]): string[] {
  if (!paths.length) return []
  const srcForPath = platform.value.srcForPath ?? ((p: string) => p)
  const added: Asset[] = paths.map((p) => ({
    id: 'asset_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: baseName(p),
    kind: kindOf({ name: baseName(p), type: '' } as File),
    ext: extUpper(baseName(p)),
    size: 0,
    url: srcForPath(p),
    missing: false,
    addedAt: Date.now(),
    path: p,
  }))
  assets.value = [...assets.value, ...added]
  added.forEach((a) => {
    probeAssetSize(a.id, a.url, a.kind)
    probeAssetAudio(a.id, a.url, a.kind)
    if (a.kind === 'video' || a.kind === 'audio') probeDuration(a.url, a.kind).then((d) => retargetAsset(a.id, d))
  })
  return added.map((a) => a.id)
}

// --- audio channel probing ---
let audioCtx: AudioContext | null = null
function getAudioCtx(): AudioContext {
  return (audioCtx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)())
}

/** Waveform buckets stored per asset (kept small — this is persisted JSON). */
const WAVE_BUCKETS = 600

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

/**
 * Fallback for containers decodeAudioData can't demux (e.g. MKV): play the
 * media muted at speed through an AnalyserNode and sample peak amplitude into
 * time buckets. Only works if the browser can actually play the file; resolves
 * undefined otherwise. Best-effort, coarse, but gives a real volume shape.
 */
function capturePeaksLive(src: string, revoke = false): Promise<number[] | undefined> {
  return new Promise((resolve) => {
    const url = src
    const el = document.createElement('video')
    el.src = url
    el.muted = true
    el.preload = 'auto'
    let done = false
    const finish = (peaks?: number[]) => {
      if (done) return
      done = true
      el.pause()
      el.removeAttribute('src')
      el.load()
      if (revoke) URL.revokeObjectURL(url)
      resolve(peaks)
    }
    el.addEventListener('error', () => finish(), { once: true })
    el.addEventListener('loadedmetadata', () => {
      const dur = el.duration
      if (!isFinite(dur) || dur <= 0) return finish()
      let ctx: AudioContext, analyser: AnalyserNode, src: MediaElementAudioSourceNode
      try {
        ctx = getAudioCtx()
        ctx.resume()
        src = ctx.createMediaElementSource(el)
        analyser = ctx.createAnalyser()
        analyser.fftSize = 2048
        const g = ctx.createGain()
        g.gain.value = 0 // keep it silent but flowing
        src.connect(analyser)
        analyser.connect(g)
        g.connect(ctx.destination)
      } catch {
        return finish()
      }
      const peaks = new Float32Array(WAVE_BUCKETS)
      const buf = new Float32Array(analyser.fftSize)
      let raf = 0
      const sample = () => {
        analyser.getFloatTimeDomainData(buf)
        let max = 0
        for (const v of buf) {
          const a = Math.abs(v)
          if (a > max) max = a
        }
        const i = Math.min(WAVE_BUCKETS - 1, Math.floor((el.currentTime / dur) * WAVE_BUCKETS))
        if (max > peaks[i]) peaks[i] = max
        raf = requestAnimationFrame(sample)
      }
      el.playbackRate = 6 // faster than realtime; browser may clamp
      el.addEventListener('ended', () => {
        cancelAnimationFrame(raf)
        finish(Array.from(peaks, (v) => Math.round(v * 1000) / 1000))
      })
      el.play().then(() => sample(), () => finish())
    })
  })
}

/**
 * Best-effort audio analysis: channel count + a volume waveform. WAV channels
 * come from the header (cheap, any size). Full decode (for peaks / non-WAV
 * channels) only runs on reasonably small files — decodeAudioData holds the
 * whole PCM in RAM, so we never do that for multi-GB media. Containers it can't
 * demux (MKV) fall back to live capture.
 */
async function analyzeAudio(
  file: File,
  ext: string,
): Promise<{ channels?: number; peaks?: number[] }> {
  const out: { channels?: number; peaks?: number[] } = {}
  try {
    if (ext === 'wav') {
      const head = new DataView(await file.slice(0, 44).arrayBuffer())
      const ch = head.getUint16(22, true)
      if (ch >= 1 && ch <= 64) out.channels = ch
    }
    // decodeAudioData needs the whole file in RAM, so cap it — but generously,
    // since video audio is what we want here (transient, discarded after peaks).
    if (file.size <= 250 * 1024 * 1024) {
      const audio = await getAudioCtx().decodeAudioData(await file.arrayBuffer())
      out.channels = audio.numberOfChannels
      out.peaks = computePeaks(audio)
    }
  } catch {
    /* decode failed (e.g. MKV) — try live capture below */
  }
  if (!out.peaks) {
    const blobUrl = URL.createObjectURL(file)
    const live = await capturePeaksLive(blobUrl, true)
    if (live) out.peaks = live
  }
  return out
}

/**
 * Same analysis for media we only have a URL for — desktop assets are loaded by
 * path through the asset protocol, so there's no File to hand to `analyzeAudio`.
 * That's why path-backed audio showed no waveform at all.
 *
 * decodeAudioData needs the whole file in RAM, so the size is checked first and
 * anything large (or unknown) goes through live capture instead.
 */
async function analyzeAudioUrl(url: string): Promise<{ channels?: number; peaks?: number[] }> {
  const CAP = 250 * 1024 * 1024
  try {
    const head = await fetch(url, { method: 'HEAD' })
    const len = Number(head.headers.get('content-length') ?? NaN)
    if (Number.isFinite(len) && len > 0 && len <= CAP) {
      const buf = await (await fetch(url)).arrayBuffer()
      const audio = await getAudioCtx().decodeAudioData(buf)
      return { channels: audio.numberOfChannels, peaks: computePeaks(audio) }
    }
  } catch {
    /* HEAD unsupported, too big, or undecodable — fall through to live capture */
  }
  const live = await capturePeaksLive(url)
  return live ? { peaks: live } : {}
}

/** compute + store the waveform for a path-backed audio/video asset */
function probeAssetAudio(id: string, url: string, kind: AssetKind) {
  if (kind !== 'audio' && kind !== 'video') return
  analyzeAudioUrl(url).then((data) => {
    if (data.peaks || data.channels) setAssetAudio(id, data)
  })
}

function setAssetAudio(id: string, data: { channels?: number; peaks?: number[] }) {
  assets.value = assets.value.map((a) => (a.id === id ? { ...a, ...data } : a))
}
function setAssetSize(id: string, w: number, h: number) {
  assets.value = assets.value.map((a) => (a.id === id ? { ...a, width: w, height: h } : a))
}
/** probe + store natural dimensions for a visual asset (image/video) */
function probeAssetSize(id: string, url: string, kind: AssetKind) {
  if (kind !== 'image' && kind !== 'video') return
  probeSize(url, kind).then((s) => s && setAssetSize(id, s.w, s.h))
}

function extLower(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}
function extUpper(name: string): string {
  const e = extLower(name)
  return e ? e.toUpperCase() : 'FILE'
}
function kindOf(file: File): AssetKind {
  const t = typeFor(extLower(file.name))
  if (t) return t.kind
  const m = file.type
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('audio/')) return 'audio'
  return 'other'
}

/** Add media from picked/dropped files. Returns the new asset ids, in order. */
export function addAssetsFromFiles(files: FileList | File[]): string[] {
  const list = Array.from(files)
  if (list.length === 0) return []
  const added: Asset[] = list.map((f) => ({
    id: 'asset_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: f.name,
    kind: kindOf(f),
    ext: extUpper(f.name),
    size: f.size,
    url: URL.createObjectURL(f),
    missing: false,
    addedAt: Date.now(),
  }))
  assets.value = [...assets.value, ...added]
  // analyze audio + video (channels + volume waveform) in the background
  added.forEach((a) => {
    if (a.kind === 'audio' || a.kind === 'video') {
      const i = added.indexOf(a)
      analyzeAudio(list[i], extLower(list[i].name)).then((data) => {
        if (data.channels || data.peaks) setAssetAudio(a.id, data)
      })
    }
    probeAssetSize(a.id, a.url, a.kind)
  })
  return added.map((a) => a.id)
}

/** Add an audio asset produced by extraction (e.g. detached from a video). */
export function addExtractedAudio(e: {
  url: string
  name: string
  ext: string
  size: number
  channels?: number
  peaks?: number[]
}): string {
  const id = 'asset_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const asset: Asset = {
    id,
    name: e.name,
    kind: 'audio',
    ext: e.ext.toUpperCase(),
    size: e.size,
    url: e.url,
    missing: false,
    addedAt: Date.now(),
    channels: e.channels,
    peaks: e.peaks,
  }
  assets.value = [...assets.value, asset]
  return id
}

export function removeAsset(id: string) {
  const a = assets.value.find((x) => x.id === id)
  if (a?.url) URL.revokeObjectURL(a.url)
  clearThumbs(id)
  assets.value = assets.value.filter((x) => x.id !== id)
}

/** Replace / relink an asset's media in place (keeps id + position). */
export function replaceAsset(id: string, file: File) {
  const old = assets.value.find((x) => x.id === id)
  if (old?.url) URL.revokeObjectURL(old.url)
  clearThumbs(id)
  const url = URL.createObjectURL(file)
  const rk = kindOf(file)
  assets.value = assets.value.map((a) =>
    a.id === id
      ? {
          ...a,
          name: file.name,
          kind: rk,
          ext: extUpper(file.name),
          size: file.size,
          url,
          missing: false,
          addedAt: Date.now(),
          channels: undefined,
          peaks: undefined,
        }
      : a,
  )
  if (rk === 'audio' || rk === 'video') {
    analyzeAudio(file, extLower(file.name)).then((data) => {
      if (data.channels || data.peaks) setAssetAudio(id, data)
    })
    // re-fit objects using this source to the new file's length (updates the
    // Properties max amounts for Beginning / Length)
    probeDuration(url, rk).then((dur) => retargetAsset(id, dur))
  }
  probeAssetSize(id, url, rk)
}

export function iconFor(a: Asset): string {
  const t = typeFor(a.ext.toLowerCase())
  if (t?.icon) return t.icon
  return a.kind === 'video' ? 'theaters' : 'insert_drive_file'
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let b = bytes
  let i = -1
  do {
    b /= 1024
    i++
  } while (b >= 1024 && i < units.length - 1)
  return `${b.toFixed(b < 10 ? 1 : 0)} ${units[i]}`
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
