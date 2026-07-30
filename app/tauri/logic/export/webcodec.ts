// Encode in the webview instead of shipping raw pixels to ffmpeg.
//
// A raw 1080p frame is 3.1MB — ~19ms just to cross the IPC boundary. Encoded
// it's tens of KB, and it comes straight off the canvas as a VideoFrame, which
// also skips the readPixels stall. ffmpeg still muxes and still owns the audio;
// it just copies an H.264 stream instead of encoding one.
//
// H.264 only. Anything else (ProRes, GIF, AV1) uses the raw-frame path.

/** Minimal surface of the WebCodecs types we touch, so this builds without
 *  depending on the DOM lib shipping them. */
interface EncodedChunk {
  byteLength: number
  type: 'key' | 'delta'
  copyTo: (dest: ArrayBufferView) => void
}
interface EncoderInit {
  output: (chunk: EncodedChunk) => void
  error: (e: Error) => void
}
interface EncoderConfig {
  codec: string
  width: number
  height: number
  framerate?: number
  bitrate?: number
  latencyMode?: 'quality' | 'realtime'
  /** `require-hardware` is draft-only, kept on purpose: if honoured we get a
   *  rejection naming the reason instead of `prefer-hardware`'s silent software
   *  fallback, and if not, the rejected enum tells us the same thing. */
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software' | 'require-hardware'
  avc?: { format: 'annexb' | 'avc' }
}
interface Encoder {
  configure: (c: EncoderConfig) => void
  encode: (frame: unknown, opts?: { keyFrame?: boolean }) => void
  flush: () => Promise<void>
  close: () => void
  encodeQueueSize: number
  ondequeue: (() => void) | null
}
type EncoderCtor = {
  new (init: EncoderInit): Encoder
  isConfigSupported: (c: EncoderConfig) => Promise<{ supported?: boolean }>
}

const VE = () => (globalThis as unknown as { VideoEncoder?: EncoderCtor }).VideoEncoder
const VF = () =>
  (globalThis as unknown as { VideoFrame?: new (src: unknown, init: object) => { close: () => void } })
    .VideoFrame

/**
 * H.264 codec string for a frame size. The level has to be high enough for the
 * resolution and rate or `isConfigSupported` rejects it outright, and there is
 * no cost to naming a higher one than strictly needed.
 */
function avcLevel(width: number, height: number, fps: number): number {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16) * fps
  return mbs > 983040 ? 0x33 /* 5.1 */ : mbs > 245760 ? 0x2a /* 4.2 */ : mbs > 122880 ? 0x28 /* 4.0 */ : 0x1f
}

/** profile_idc + constraint byte, as the codec string spells them */
const PROFILES = {
  high: ['64', '00'],
  main: ['4d', '00'],
  baseline: ['42', 'e0'], // constrained baseline
} as const

function codecString(profile: keyof typeof PROFILES, level: number): string {
  const [idc, constraint] = PROFILES[profile]
  return `avc1.${idc}${constraint}${level.toString(16).padStart(2, '0')}`
}

function avcCodec(width: number, height: number, fps: number): string {
  return codecString('high', avcLevel(width, height, fps))
}

export interface WebCodecPlan {
  codec: string
  bitrate: number
  /** encoded stream ffmpeg should expect on stdin */
  wire: 'h264'
  /** the exact configuration the browser confirmed, used verbatim to configure */
  config: EncoderConfig
}

/**
 * Can this export run through WebCodecs, and with what settings?
 *
 * H.264 only, and only when the browser confirms the exact config. WebCodecs has
 * no CRF, so a CRF export is converted to the dialog's default bitrate — anything
 * that actually needs constant quality should stay on ffmpeg.
 */
export async function planWebCodecs(
  vCodec: string,
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<WebCodecPlan | null> {
  // Only answers "is this config usable". The dialog's Encode Path setting
  // decides which path actually runs.
  const Ctor = VE()
  if (!Ctor || !VF()) return null
  // only the H.264 encoders — everything else keeps the ffmpeg path
  if (!/^(libx264|libopenh264|h264_)/.test(vCodec)) return null
  if (!bitrate || bitrate <= 0) return null

  const codec = avcCodec(width, height, fps)
  // `realtime` on an offline export, deliberately: it's what makes Chromium pick
  // the accelerated Media Foundation path. Software H.264 at 1080p60 runs about
  // a tenth of NVENC's speed. Bitrate governs quality either way; realtime only
  // costs B-frames and reference depth.
  const config: EncoderConfig = {
    codec,
    width,
    height,
    framerate: fps,
    bitrate,
    latencyMode: 'realtime',
    hardwareAcceleration: 'prefer-hardware',
    // an elementary stream with in-band SPS/PPS, which is what `-f h264` wants
    avc: { format: 'annexb' },
  }
  try {
    const r = await Ctor.isConfigSupported(config)
    if (!r?.supported) return null
  } catch {
    return null
  }
  return { codec, bitrate, wire: 'h264', config }
}

/**
 * Cost of one frame on the WebCodecs path, ms, measured on real project frames.
 *
 * Counts only what this path adds — waiting on the encoder, capturing the canvas.
 * Render and seek are excluded since both paths pay them equally. Warmup frames
 * are skipped, and the chunks are thrown away; this measures drain rate only.
 */
export async function probeEncoderCost(
  plan: WebCodecPlan,
  render: (t: number) => Promise<void>,
  canvas: HTMLCanvasElement,
  fps: number,
  frames = 30,
  warmup = 6,
): Promise<number> {
  const enc = createFrameEncoder(plan, fps, async () => {})
  let total = 0
  let counted = 0
  try {
    for (let i = 0; i < frames; i++) {
      await render(i / fps)
      const r = await enc.encode(canvas, i)
      if (i >= warmup) {
        total += r.encWaitMs + r.pipeWaitMs + r.captureMs
        counted++
      }
    }
  } finally {
    enc.close()
  }
  return counted ? total / counted : Infinity
}

/** Per-frame cost above which the encoder is certainly not hardware. Hardware
 *  H.264 costs ~1ms at 1080p, so this is several times over — a merely-busy GPU
 *  can't trip it. */
const SOFT_MS_PER_MP = 4
export const softThreshold = (w: number, h: number) => (SOFT_MS_PER_MP * w * h) / 1e6

export interface EncoderAttempt {
  label: string
  /** what `isConfigSupported` answered */
  supported: boolean
  /** first error from isConfigSupported / configure / encode, verbatim */
  error?: string
  /** measured ms/frame, or null if it never got that far */
  ms: number | null
}

export interface EncoderTuning {
  /** the configuration that actually measured fastest */
  plan: WebCodecPlan
  /** its measured per-frame cost, ms */
  ms: number
  /** what won, for the summary */
  label: string
  /** every candidate measured as software — there is no hardware path here */
  allSoftware: boolean
  /** every candidate, in the order tried — the diagnostic record */
  attempts: EncoderAttempt[]
}

/**
 * Find a configuration this machine will actually encode in hardware.
 *
 * WebCodecs won't tell you what you got: `prefer-hardware` falls back silently
 * and `isConfigSupported` answers "supported", not "accelerated". So measure the
 * clock instead. If the config we want hits hardware speed, stop — that's the
 * common case, one probe. If not, Chromium routes different latencyMode /
 * hardwareAcceleration combinations to different encoders, so try them and keep
 * the fastest rather than shipping an 80-minute export on a bad first guess.
 */
export async function tuneEncoder(
  plan: WebCodecPlan,
  render: (t: number) => Promise<void>,
  canvas: HTMLCanvasElement,
  fps: number,
  onTry?: (label: string) => void,
): Promise<EncoderTuning> {
  const Ctor = VE()!
  const { width, height } = plan.config
  const limit = softThreshold(width, height)
  const attempts: EncoderAttempt[] = []

  /** Run one candidate end to end, recording whatever went wrong. Nothing here
   *  is allowed to throw: a candidate failing is a RESULT, not an error. */
  async function attempt(label: string, config: EncoderConfig): Promise<number | null> {
    const rec: EncoderAttempt = { label, supported: false, ms: null }
    attempts.push(rec)
    try {
      const r = await Ctor.isConfigSupported(config)
      rec.supported = !!r?.supported
      if (!rec.supported) {
        rec.error = 'isConfigSupported returned supported: false'
        return null
      }
    } catch (e) {
      // an unknown enum value lands here as a TypeError from WebIDL
      rec.error = `isConfigSupported threw: ${(e as Error).message || e}`
      return null
    }
    onTry?.(label)
    try {
      rec.ms = await probeEncoderCost({ ...plan, config }, render, canvas, fps)
      return rec.ms
    } catch (e) {
      rec.error = `configure/encode threw: ${(e as Error).message || e}`
      return null
    }
  }

  const base = await attempt('prefer-hardware, realtime', plan.config)
  let best: { plan: WebCodecPlan; ms: number; label: string } | null =
    base == null ? null : { plan, ms: base, label: 'prefer-hardware, realtime' }
  if (best && best.ms <= limit) return { ...best, allSoftware: false, attempts }

  // Slow. Separate the codec from the scene: re-encode the frame already on the
  // canvas, nothing else moving. No seek, no decode, no upload.
  //   still slow    → these pixels are the cost, i.e. a software codec. Levers
  //                   are bitrate and the ffmpeg path.
  //   suddenly fast → the encoder is fine; sourcing each frame is the cost,
  //                   which points at decode and the proxy recipe.
  attempts.push({
    label: 'same frame re-encoded, no decode (diagnostic)',
    supported: true,
    ms: await probeStaticCost(plan, canvas, fps),
  })

  const alts: { label: string; config: EncoderConfig }[] = [
    // Draft-spec value. If honoured, the failure names a reason instead of
    // silently degrading — which is the whole difficulty with `prefer-hardware`.
    {
      label: 'require-hardware, realtime',
      config: { ...plan.config, hardwareAcceleration: 'require-hardware' },
    },
    { label: 'prefer-hardware, quality', config: { ...plan.config, latencyMode: 'quality' } },
    {
      label: 'no-preference, realtime',
      config: { ...plan.config, hardwareAcceleration: 'no-preference' },
    },
    { label: 'main profile, realtime', config: { ...plan.config, codec: codecString('main', avcLevel(width, height, fps)) } },
    { label: 'baseline profile, realtime', config: { ...plan.config, codec: codecString('baseline', avcLevel(width, height, fps)) } },
    // CONTROL, always run. If explicit software costs the same as
    // `prefer-hardware`, then `prefer-hardware` was never hardware — the one
    // comparison that settles a question the spec gives no API for.
    {
      label: 'prefer-software, realtime (control)',
      config: { ...plan.config, hardwareAcceleration: 'prefer-software' },
    },
  ]
  for (const a of alts) {
    const ms = await attempt(a.label, a.config)
    if (ms != null && (!best || ms < best.ms))
      best = { plan: { ...plan, config: a.config }, ms, label: a.label }
    // stop early only on a genuine hardware result; the control is last, so a
    // fast finding always beats it to the exit
    if (best && best.ms <= limit) break
  }
  if (!best) throw new Error(attempts.map((a) => `${a.label}: ${a.error}`).join(' | '))
  // Decide against the CONTROL, not a constant. An absolute threshold only says
  // "this frame is slow", and a heavy scene is slow on any encoder. Matching
  // explicit software means hardware never engaged; beating it means hardware is
  // working and the remaining cost isn't the codec's fault.
  const control = attempts.find((a) => a.label.includes('control'))?.ms ?? null
  const allSoftware = control != null && best.ms > control * 0.85
  return { ...best, allSoftware, attempts }
}

/**
 * Encoder cost with the pipeline held still: encode the SAME canvas repeatedly,
 * so no seek, decode or texture upload happens between frames.
 *
 * Separates "this config is slow" from "sourcing each frame is expensive".
 * `probeEncoderCost` re-renders every frame, so scene cost leaks into the
 * encoder queue and reads as encoder time.
 */
export async function probeStaticCost(
  plan: WebCodecPlan,
  canvas: HTMLCanvasElement,
  fps: number,
  frames = 30,
  warmup = 6,
): Promise<number> {
  const enc = createFrameEncoder(plan, fps, async () => {})
  let total = 0
  let counted = 0
  try {
    for (let i = 0; i < frames; i++) {
      const r = await enc.encode(canvas, i)
      if (i >= warmup) {
        total += r.encWaitMs + r.pipeWaitMs + r.captureMs
        counted++
      }
    }
  } finally {
    enc.close()
  }
  return counted ? total / counted : Infinity
}

/** How many encoded chunks may be in flight to ffmpeg before the frame loop
 *  waits. Enough to keep the pipe busy, small enough to stay bounded. */
const SEND_WINDOW = 8

export interface FrameSink {
  /** hand one encoded chunk onward; awaited so back-pressure reaches the caller */
  (bytes: Uint8Array): Promise<void>
}

/**
 * Drives a VideoEncoder over the export's frames.
 *
 * Chunks come out on a callback rather than in step with `encode()`, so they are
 * queued and drained in order — the muxer needs them in encode order, which is
 * the order the callback fires. Sending is serialised against that queue so a
 * slow pipe applies back-pressure instead of growing it without bound.
 */
export function createFrameEncoder(
  plan: WebCodecPlan,
  fps: number,
  send: FrameSink,
  /** seconds between forced keyframes; matters for seeking in the output */
  gopSeconds = 2,
) {
  const Ctor = VE()!
  const FrameCtor = VF()!
  let failed: Error | null = null
  let pending: Promise<void> = Promise.resolve()
  /** chunks handed to `send` but not yet acknowledged */
  let outstanding = 0
  /** one entry per unacknowledged chunk, oldest first — lets the frame loop wait
   *  for just enough of them to get back under the window, rather than for all */
  const inflight: Promise<void>[] = []
  /** set before teardown, so nothing more is written on this encoder's behalf */
  let closed = false

  const enc = new Ctor({
    output: (chunk) => {
      // A cancelled encoder keeps emitting what it had queued. Sending those
      // would hand the NEXT export's ffmpeg frames from a dead session — a
      // corrupt file, and a pipe already full before it renders anything.
      if (closed) return
      const buf = new Uint8Array(chunk.byteLength)
      chunk.copyTo(buf)
      outstanding++
      // chain rather than fire-and-forget: order is the muxer's contract
      pending = pending
        .then(() => (closed ? undefined : send(buf)))
        .catch((e) => {
          failed ??= e as Error
        })
        .then(() => {
          outstanding--
          // links resolve in the order they were chained, so the one finishing
          // here is always the head
          inflight.shift()
        })
      inflight.push(pending)
    },
    error: (e) => {
      failed ??= e
    },
  })
  // verbatim: this is the configuration isConfigSupported actually confirmed
  enc.configure(plan.config)

  const gop = Math.max(1, Math.round(gopSeconds * fps))
  const usPerFrame = 1e6 / fps

  /**
   * Wait until the encoder has room, so we don't queue the whole timeline.
   *
   * The timeout is a poll, not a safety net, and must stay short: a fast encoder
   * can drain in the gap between the `while` check and attaching `ondequeue`, so
   * the waking event is already gone and we fall through to the timer. At NVENC
   * speeds that turned a 1ms frame into a full timer sleep. Re-checking the
   * queue AFTER attaching closes the race; the 1ms fallback bounds any miss.
   */
  async function drain(limit: number) {
    while (enc.encodeQueueSize > limit && !failed) {
      await new Promise<void>((r) => {
        let done = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const fire = () => {
          if (done) return
          done = true
          enc.ondequeue = null
          clearTimeout(timer)
          r()
        }
        // ondequeue is not universally implemented; don't hang if it never fires
        enc.ondequeue = fire
        // drained while we were attaching — that event is gone, don't wait for it
        if (enc.encodeQueueSize <= limit || failed) return fire()
        timer = setTimeout(fire, 1)
      })
    }
  }

  // A VideoEncoder holds a hardware session. Leak one (export throws, or is
  // cancelled mid-loop) and the next export contends with it or drops to
  // software — the app gets slower with every cancelled export until restart.
  // So: idempotent, and always reachable.
  function shutdown() {
    if (closed) return
    // set first: closing the encoder can emit whatever it still holds, and
    // those chunks belong to an export that no longer exists
    closed = true
    try {
      enc.close()
    } catch {
      /* already closed or errored out — nothing left to release */
    }
  }

  return {
    /**
     * The three costs, kept separate.
     *
     * `encWaitMs` (waiting on the codec) and `pipeWaitMs` (waiting on bytes
     * reaching ffmpeg) were once one number, which made a slow export
     * unattributable — one is a codec and a bitrate, the other is ours to fix.
     * `captureMs` is VideoFrame construction, which forces a GPU sync, so the
     * whole draw pass lands there and the draw phase reads as free.
     */
    async encode(canvas: HTMLCanvasElement, index: number) {
      if (failed) throw failed
      const t0 = performance.now()
      await drain(4)
      const t1 = performance.now()
      // Chunks leaving the encoder queue still have to cross to ffmpeg, and
      // nothing else here waits for that — unbounded, the chain grows for the
      // whole export. Wait only until back under the window: awaiting `pending`
      // (the chain's tail) meant waiting for EVERY chunk, which emptied the pipe
      // and left the next frames nothing to overlap with.
      while (outstanding > SEND_WINDOW && !failed && inflight.length) await inflight[0]
      const t2 = performance.now()
      const frame = new FrameCtor(canvas, {
        timestamp: Math.round(index * usPerFrame),
        duration: Math.round(usPerFrame),
      })
      try {
        enc.encode(frame, { keyFrame: index % gop === 0 })
      } finally {
        frame.close() // the encoder has taken what it needs; holding on leaks GPU memory
      }
      const t3 = performance.now()
      return { encWaitMs: t1 - t0, pipeWaitMs: t2 - t1, captureMs: t3 - t2 }
    },
    /** flush the encoder, then wait for every chunk it produced to be sent */
    async finish() {
      try {
        await enc.flush()
        await pending
      } finally {
        shutdown()
      }
      if (failed) throw failed
    },
    /** release the hardware session without flushing — for the abandoned case */
    close: shutdown,
    get error() {
      return failed
    },
  }
}
