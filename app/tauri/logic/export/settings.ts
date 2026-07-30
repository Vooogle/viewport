// What the export dialog can offer, and how a choice becomes ffmpeg flags.
//
// Nothing here is assumed to exist: ffmpeg builds differ enormously (a distro
// build has libx264, the LGPL one we download does not), so every codec lists
// candidate encoders and the dialog keeps only those the running ffmpeg reports.

export type Container = 'mp4' | 'mov' | 'mkv' | 'webm' | 'gif'

/** The speed↔size knob, which every encoder family spells differently: x264 and
 *  Quick Sync take words ("veryslow"), NVENC takes p1–p7, AMF takes a quality
 *  word on a different flag, VP9/AV1 take a `-cpu-used` number, and several take
 *  nothing at all. Getting this wrong is a hard failure ("Unable to parse
 *  'preset' option value 'veryslow'"), so the values live on the ENCODER. */
export const PRESETS: Record<string, { values: string[]; default: string }> = {
  x264: {
    values: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'],
    default: 'medium',
  },
  qsv: { values: ['veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'], default: 'medium' },
  nvenc: { values: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], default: 'p4' },
  amf: { values: ['speed', 'balanced', 'quality'], default: 'balanced' },
  vpx: { values: ['0', '1', '2', '3', '4', '5'], default: '2' },
  svtav1: { values: ['0', '2', '4', '6', '8', '10', '12'], default: '6' },
  aom: { values: ['0', '1', '2', '3', '4', '5', '6', '7', '8'], default: '4' },
}

export interface Encoder {
  name: string
  label: string
  hw?: boolean
  /** key into PRESETS; absent → this encoder has no speed knob */
  presets?: keyof typeof PRESETS
}

export interface VideoCodec {
  id: string
  /** compact name for the combined encoder picker, e.g. "H.264" */
  short: string
  label: string
  /** encoders to try, best quality first; hardware ones are marked */
  encoders: Encoder[]
  containers: Container[]
  /** constant-quality range for the software encoder (lower = better) */
  quality?: { min: number; max: number; default: number; label: string }
  pixFmts: string[]
}

export interface AudioCodec {
  id: string
  label: string
  containers: Container[]
  /** null = lossless, no bitrate choice */
  bitrates: number[] | null
}

export const CONTAINERS: { id: Container; label: string; ext: string; muxer: string }[] = [
  { id: 'mp4', label: 'MPEG-4 (.mp4)', ext: 'mp4', muxer: 'mp4' },
  { id: 'mkv', label: 'Matroska Video (.mkv)', ext: 'mkv', muxer: 'matroska' },
  { id: 'mov', label: 'QuickTime (.mov)', ext: 'mov', muxer: 'mov' },
  { id: 'webm', label: 'WebM (.webm)', ext: 'webm', muxer: 'webm' },
  { id: 'gif', label: 'Animated GIF (.gif)', ext: 'gif', muxer: 'gif' },
]

/** Named quality levels instead of raw CRF numbers. Each shifts the codec's own
 *  default: CRF where the encoder supports it, or a bitrate multiplier for the
 *  hardware encoders that only do target bitrate. */
export interface QualityPreset {
  id: string
  label: string
  /** offset applied to the codec's default CRF (higher = smaller/worse) */
  crf: number
  /** multiplier on the computed bitrate, for encoders with no CRF mode */
  mul: number
  /** pin to the codec's minimum CRF and prefer a lossless-capable encoder */
  lossless?: boolean
}

export const QUALITY_PRESETS: QualityPreset[] = [
  { id: 'low', label: 'Low — small file', crf: 8, mul: 0.4 },
  { id: 'medium', label: 'Medium — balanced', crf: 3, mul: 0.8 },
  { id: 'high', label: 'High — recommended', crf: -2, mul: 1.6 },
  { id: 'lossless', label: 'Lossless — very large file', crf: 0, mul: 8, lossless: true },
  { id: 'custom', label: 'Custom', crf: 0, mul: 1 },
]

/** Encoders that can genuinely encode losslessly (CRF/Q 0 is not enough on the
 *  hardware ones, and libopenh264 has no lossless mode at all). */
const LOSSLESS_CAPABLE = ['libx264', 'libx265', 'prores_ks', 'prores', 'libsvtav1']
export const isLosslessCapable = (enc: string) => LOSSLESS_CAPABLE.includes(enc)

export const VIDEO_CODECS: VideoCodec[] = [
  {
    id: 'h264',
    short: 'H.264',
    label: 'H.264 / AVC',
    encoders: [
      { name: 'libx264', label: 'x264', presets: 'x264' },
      { name: 'libopenh264', label: 'OpenH264' },
      { name: 'h264_nvenc', label: 'NVIDIA NVENC', hw: true, presets: 'nvenc' },
      { name: 'h264_qsv', label: 'Intel Quick Sync', hw: true, presets: 'qsv' },
      { name: 'h264_amf', label: 'AMD AMF', hw: true, presets: 'amf' },
      { name: 'h264_videotoolbox', label: 'Apple VideoToolbox', hw: true },
      { name: 'h264_mf', label: 'Media Foundation', hw: true },
      { name: 'h264_vaapi', label: 'VA-API', hw: true },
    ],
    containers: ['mp4', 'mov', 'mkv'],
    quality: { min: 0, max: 51, default: 18, label: 'CRF' },
    pixFmts: ['yuv420p', 'yuv422p', 'yuv444p'],
  },
  {
    id: 'hevc',
    short: 'H.265',
    label: 'H.265 / HEVC',
    encoders: [
      { name: 'libx265', label: 'x265', presets: 'x264' },
      { name: 'hevc_nvenc', label: 'NVIDIA NVENC', hw: true, presets: 'nvenc' },
      { name: 'hevc_qsv', label: 'Intel Quick Sync', hw: true, presets: 'qsv' },
      { name: 'hevc_amf', label: 'AMD AMF', hw: true, presets: 'amf' },
      { name: 'hevc_videotoolbox', label: 'Apple VideoToolbox', hw: true },
      { name: 'hevc_mf', label: 'Media Foundation', hw: true },
      { name: 'hevc_vaapi', label: 'VA-API', hw: true },
    ],
    containers: ['mp4', 'mov', 'mkv'],
    quality: { min: 0, max: 51, default: 23, label: 'CRF' },
    pixFmts: ['yuv420p', 'yuv420p10le', 'yuv444p'],
  },
  {
    id: 'vp9',
    short: 'VP9',
    label: 'VP9',
    encoders: [
      { name: 'libvpx-vp9', label: 'libvpx', presets: 'vpx' },
      { name: 'vp9_qsv', label: 'Intel Quick Sync', hw: true, presets: 'qsv' },
      { name: 'vp9_vaapi', label: 'VA-API', hw: true },
    ],
    containers: ['webm', 'mkv'],
    quality: { min: 0, max: 63, default: 31, label: 'CRF' },
    pixFmts: ['yuv420p', 'yuv422p', 'yuv444p'],
  },
  {
    id: 'av1',
    short: 'AV1',
    label: 'AV1',
    encoders: [
      { name: 'libsvtav1', label: 'SVT-AV1', presets: 'svtav1' },
      { name: 'libaom-av1', label: 'libaom (slow)', presets: 'aom' },
      { name: 'av1_nvenc', label: 'NVIDIA NVENC', hw: true, presets: 'nvenc' },
      { name: 'av1_qsv', label: 'Intel Quick Sync', hw: true, presets: 'qsv' },
    ],
    containers: ['mp4', 'mkv', 'webm'],
    quality: { min: 0, max: 63, default: 30, label: 'CRF' },
    pixFmts: ['yuv420p', 'yuv420p10le'],
  },
  {
    id: 'prores',
    short: 'ProRes',
    label: 'ProRes (editing / master)',
    encoders: [
      { name: 'prores_ks', label: 'ProRes KS' },
      { name: 'prores', label: 'ProRes' },
    ],
    containers: ['mov', 'mkv'],
    quality: { min: 0, max: 32, default: 11, label: 'Q' },
    pixFmts: ['yuv422p10le', 'yuv444p10le'],
  },
  {
    id: 'gif',
    short: 'GIF',
    label: 'Animated GIF',
    encoders: [{ name: 'gif', label: 'GIF' }],
    containers: ['gif'],
    pixFmts: [],
  },
]

export const AUDIO_CODECS: AudioCodec[] = [
  { id: 'aac', label: 'AAC', containers: ['mp4', 'mov', 'mkv'], bitrates: [96, 128, 160, 192, 256, 320] },
  { id: 'libopus', label: 'Opus', containers: ['webm', 'mkv', 'mp4'], bitrates: [64, 96, 128, 160, 192, 256] },
  { id: 'libmp3lame', label: 'MP3', containers: ['mkv', 'mov'], bitrates: [128, 192, 256, 320] },
  { id: 'flac', label: 'FLAC (lossless)', containers: ['mkv', 'mov'], bitrates: null },
  { id: 'alac', label: 'ALAC (lossless)', containers: ['mov', 'mkv'], bitrates: null },
  { id: 'pcm_s16le', label: 'PCM 16-bit (uncompressed)', containers: ['mov', 'mkv'], bitrates: null },
]

export const RESOLUTIONS: { label: string; height: number | null }[] = [
  { label: 'Project', height: null },
  { label: '2160p (4K)', height: 2160 },
  { label: '1440p', height: 1440 },
  { label: '1080p', height: 1080 },
  { label: '720p', height: 720 },
  { label: '480p', height: 480 },
]

export const DITHERS = ['bayer', 'floyd_steinberg', 'sierra2_4a', 'none']

/** what the dialog produces and Rust consumes */
/**
 * Where the frame gets turned into H.264.
 *
 * `webcodecs` encodes in the webview and hands ffmpeg a finished stream to mux,
 * which avoids copying raw frames across the IPC boundary entirely. `ffmpeg`
 * packs frames as yuv420p on the GPU and sends those instead. Neither wins
 * everywhere — the browser gives no way to request a hardware encoder or to
 * find out whether it did, and a software one's speed depends heavily on the
 * content, while the raw path's cost only tracks frame size.
 */
export type EncodePath = 'auto' | 'webcodecs' | 'ffmpeg'

export interface ExportSettings {
  container: Container
  fps: number
  width: number
  height: number
  vCodec: string
  /** wire format of the raw frames on stdin — set by the renderer, not the UI */
  rawPixFmt?: 'rgba' | 'yuv420p'
  /** whether ffmpeg encodes our frames or just muxes an already-encoded stream */
  wire?: 'rawvideo' | 'h264'
  /** which side does the encoding — 'auto' measures both and takes the faster */
  encodePath?: EncodePath
  crf?: number
  vBitrate?: number
  preset?: string
  /** which flag `preset` belongs on — chosen here, never guessed downstream */
  presetFlag?: string
  pixFmt?: string
  profile?: string
  aCodec?: string
  aBitrate?: number
  dither?: string
  /** raw ffmpeg flags, appended last so they override everything */
  extraArgs?: string
}

/** Encoders this ffmpeg reports; used to filter every list above. */
export interface Caps {
  encoders: string[]
  muxers: string[]
}

export const codecById = (id: string) => VIDEO_CODECS.find((c) => c.id === id)

/** The ffmpeg flag each preset family lives on. AMF is the odd one out. */
const PRESET_FLAG: Record<string, string> = {
  x264: '-preset',
  qsv: '-preset',
  nvenc: '-preset',
  amf: '-quality',
  vpx: '-cpu-used',
  svtav1: '-preset',
  aom: '-cpu-used',
}

/** One row of the combined "Video Encoder" picker: hardware/software + codec. */
export interface EncoderOption {
  key: string
  label: string
  codec: VideoCodec
  enc: Encoder
}

/** Every encoder usable in this container, flattened the way OBS presents it:
 *  "Hardware (NVENC, H.264)" rather than separate codec and encoder dropdowns. */
export function encoderOptions(caps: Caps, container: Container): EncoderOption[] {
  const out: EncoderOption[] = []
  for (const codec of availableCodecs(caps, container))
    for (const enc of availableEncoders(caps, codec))
      out.push({
        key: `${codec.id}:${enc.name}`,
        label: `${enc.hw ? 'Hardware' : 'Software'} (${enc.label}, ${codec.short})`,
        codec,
        enc,
      })
  // software first, matching the safe default
  return out.sort((a, b) => Number(a.enc.hw ?? false) - Number(b.enc.hw ?? false))
}

/** Speed/effort options for a specific encoder, or null if it has none. */
export function presetsFor(enc: Encoder | undefined) {
  if (!enc?.presets) return null
  const p = PRESETS[enc.presets]
  return { ...p, flag: PRESET_FLAG[enc.presets] }
}

/** Video codecs usable in `container` with the encoders this ffmpeg has. */
export function availableCodecs(caps: Caps, container: Container): VideoCodec[] {
  return VIDEO_CODECS.filter(
    (c) => c.containers.includes(container) && c.encoders.some((e) => caps.encoders.includes(e.name)),
  )
}

/** Encoders for a codec that this ffmpeg actually has, best first. */
export function availableEncoders(caps: Caps, codec: VideoCodec) {
  return codec.encoders.filter((e) => caps.encoders.includes(e.name))
}

export function availableAudio(caps: Caps, container: Container): AudioCodec[] {
  if (container === 'gif') return []
  return AUDIO_CODECS.filter((a) => a.containers.includes(container) && caps.encoders.includes(a.id))
}

export function availableContainers(caps: Caps): typeof CONTAINERS {
  return CONTAINERS.filter((c) => caps.muxers.includes(c.muxer) && availableCodecs(caps, c.id).length > 0)
}

/** Hardware encoders have no CRF mode, so those fall back to a target bitrate. */
export function supportsQuality(codec: VideoCodec, encoder: string): boolean {
  if (!codec.quality) return false
  return (
    encoder.startsWith('libx26') ||
    encoder.startsWith('libvpx') ||
    encoder.startsWith('libsvtav1') ||
    encoder.startsWith('libaom') ||
    encoder.startsWith('prores') ||
    encoder.includes('videotoolbox')
  )
}

/**
 * Best default encoder for this machine.
 *
 * Hardware first — it encodes far faster and is the reason to have a GPU in the
 * loop — but only if the live probe says it actually opens here. Lossless has to
 * ignore that and take a software encoder, since the hardware ones can't do it.
 */
export function pickDefaultEncoder(
  options: EncoderOption[],
  works: (name: string) => boolean,
  lossless = false,
): EncoderOption | undefined {
  const usable = options.filter((o) => works(o.enc.name))
  const pool = usable.length ? usable : options
  if (lossless) return pool.find((o) => isLosslessCapable(o.enc.name)) ?? pool[0]
  return pool.find((o) => o.enc.hw) ?? pool[0]
}

/** Sensible default bitrate for a size/rate — roughly 0.12 bits per pixel. */
export function defaultBitrate(w: number, h: number, fps: number): number {
  return Math.round(Math.min(60e6, Math.max(2e6, w * h * fps * 0.12)))
}

/** Rough output size in bytes, for the dialog's estimate. */
export function estimateSize(s: ExportSettings, seconds: number): number | null {
  if (s.vBitrate == null) return null // constant quality — can't predict
  // aBitrate is ALREADY bits per second (the dialog converts from the kbps it
  // shows). Scaling it again turned 192 kbps of audio into 192 Mbps and made a
  // half-hour export read as 46 GB.
  const audio = s.aBitrate ?? 0
  return ((s.vBitrate + audio) / 8) * seconds
}
