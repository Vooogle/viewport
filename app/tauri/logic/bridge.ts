// Thin wrapper over the global Tauri v2 API (window.__TAURI__, enabled by
// `app.withGlobalTauri` in tauri.conf.json). Only app/tauri code uses this.
//
// Everything except window controls goes through `core.invoke` to our own Rust
// commands — plugin JS globals aren't relied on, so nothing silently no-ops.
interface TauriWindow {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
}
interface TauriGlobal {
  core?: {
    convertFileSrc: (path: string, protocol?: string) => string
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  }
  window?: { getCurrentWindow: () => TauriWindow }
  event?: {
    listen: <T>(name: string, cb: (e: { payload: T }) => void) => Promise<() => void>
  }
}
function api(): TauriGlobal | null {
  return typeof window !== 'undefined' ? ((window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null) : null
}

export const isTauri = api() != null

export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const c = api()?.core
  if (!c) throw new Error('not running under Tauri')
  return c.invoke(cmd, args) as Promise<T>
}

/** file path → a URL the webview can load (asset protocol). */
export function srcForPath(path: string): string {
  const t = api()
  return t?.core ? t.core.convertFileSrc(path) : path
}

/** native open dialog → absolute paths (so projects can reload their media). */
export function pickMediaPaths(): Promise<string[]> {
  return invoke<string[]>('pick_media_paths')
}
/** native save dialog → chosen path, or null if cancelled. */
export function saveDialog(defaultName: string, ext: string): Promise<string | null> {
  return invoke<string | null>('pick_save_path', { defaultName, ext })
}
/** native open dialog for one file of a given type → path, or null. */
export function openDialog(label: string, ext: string): Promise<string | null> {
  return invoke<string | null>('pick_open_path', { label, ext })
}

// --- project bundles (.viewport.zip): manifest + media, streamed by Rust ---
export interface BundleEntry {
  /** absolute path of the source on this machine */
  path: string
  /** name to store it under inside the archive's media/ folder */
  name: string
}
export const bundleWrite = (out: string, manifest: string, files: BundleEntry[]) =>
  invoke<void>('bundle_write', { out, manifest, files })
export interface OpenedBundle {
  manifest: string
  /** [name in archive, absolute path it was unpacked to] */
  media: [string, string][]
}
export const bundleRead = (path: string, projectId: string) =>
  invoke<OpenedBundle>('bundle_read', { path, projectId })

// --- window chrome (frameless: decorations off in tauri.conf) ---
function win(): TauriWindow | null {
  const w = api()?.window
  return w ? w.getCurrentWindow() : null
}
export const winMinimize = () => void win()?.minimize()
export const winToggleMax = () => void win()?.toggleMaximize()
export const winClose = () => void win()?.close()

// --- video export: frames are piped straight into ffmpeg's stdin ---
export const ffmpegAvailable = () => invoke<boolean>('ffmpeg_available')
/** fetch a private copy of ffmpeg into the app data dir (first export only). */
export const downloadFfmpeg = () => invoke<void>('download_ffmpeg')
/** [receivedBytes, totalBytes] as the download runs; returns an unlisten fn. */
export function onFfmpegProgress(cb: (received: number, total: number) => void): Promise<() => void> {
  const ev = api()?.event
  if (!ev) return Promise.resolve(() => {})
  return ev.listen<[number, number]>('ffmpeg-download', (e) => cb(e.payload[0], e.payload[1]))
}
/** every encoder + container this ffmpeg build supports */
export const ffmpegCaps = () => invoke<{ encoders: string[]; muxers: string[] }>('ffmpeg_caps')
/** default folder for exports (Videos), so we never write to the CWD */
export const defaultExportDir = () => invoke<string>('default_export_dir')
/** extract a source's audio to a temp WAV natively; returns its path */
export const extractAudio = (input: string) => invoke<string>('extract_audio', { input })
/** decode just the seconds of a source the timeline uses to a 48 kHz WAV
 *  (cached beside the proxies); returns its path. For the export mixdown — the
 *  webview can neither afford nor always decode a whole source. */
export const extractAudioSpan = (input: string, start: number, duration: number) =>
  invoke<string>('extract_audio_span', { input, start, duration })
/** small audio-only stand-in for a source, for the preview mixer (cached) */
export const makeAudioProxy = (input: string) => invoke<string>('audio_proxy', { input })
/** transcode a source to an all-intra proxy scaled to the export box (cached);
 *  fps is the source's frame rate, 0 when it couldn't be parsed */
export interface ProxyOut { path: string; fps: number }
/** `threads` caps ffmpeg's workers; omit it to let the export have the machine. */
export const makeProxy = (input: string, width: number, height: number, threads?: number) =>
  invoke<ProxyOut>('make_proxy', { input, width, height, threads })
/** kill the proxy transcode in flight — a cancelled export must not leave one
 *  running, or everything after it competes with a full-speed ffmpeg */
export const cancelProxy = () => invoke<void>('cancel_proxy')
/** bytes held by cached proxies, and a way to drop them */
export const proxySize = () => invoke<number>('proxy_size')
export const clearProxies = () => invoke<void>('clear_proxies')
/** which ffmpeg binary is in use (capability differs a lot between builds) */
export interface FfInfo { path: string; version: string; ours: boolean }
export const ffmpegInfo = () => invoke<FfInfo | null>('ffmpeg_info')
/** live check: does each encoder actually open here, and if not, why */
export interface EncoderProbe { name: string; ok: boolean; reason: string }
export const probeEncoders = (names: string[]) => invoke<EncoderProbe[]>('probe_encoders', { names })
export const exportBegin = (out: string, settings: unknown) =>
  invoke<void>('export_begin', { out, settings })
/** Stage the mixed-down WAV as raw bytes (see exportFrame on why not base64).
 *  Streamed in chunks: a half-hour mix is ~360MB and one message that size
 *  wedges the webview and the event-loop thread alike. */
export const exportAudioBegin = () => invoke<void>('export_audio_begin')
export function exportAudioChunk(bytes: Uint8Array): Promise<void> {
  const c = api()?.core
  if (!c) throw new Error('not running under Tauri')
  return c.invoke('export_audio_chunk', bytes as unknown as Record<string, unknown>) as Promise<void>
}
export const exportAudioEnd = () => invoke<void>('export_audio_end')
/** Raw RGBA frame. Passed straight through as the payload — wrapping it in an
 *  object would make Tauri serialise it as JSON instead of an octet-stream. */
export function exportFrame(pixels: Uint8Array): Promise<void> {
  const c = api()?.core
  if (!c) throw new Error('not running under Tauri')
  return c.invoke('export_frame', pixels as unknown as Record<string, unknown>) as Promise<void>
}
export const exportEnd = () => invoke<void>('export_end')
export const exportCancel = () => invoke<void>('export_cancel')
