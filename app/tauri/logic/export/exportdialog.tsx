// Export settings, laid out the way OBS does its Recording panel: right-aligned
// labels, one wide field per row, a path + Browse row, named quality levels
// instead of raw CRF numbers, and a single "Video Encoder" list that folds
// hardware/software and codec together ("Hardware (NVENC, H.264)").
//
// Lists come from what the running ffmpeg reports, and each encoder is probed
// live for whether it opens on this machine — but a failing one stays pickable
// and says why, because a probe only speaks for one machine at one moment.
import { signal } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'
import { currentProject, FPS_PRESETS } from '@shared/logic/project/project'
import { contentEnd } from '@shared/logic/timeline/timeline'
import { askConfirm } from '@shared/logic/ui/confirm'
import { startTask } from '@shared/logic/ui/progress'
import {
  ffmpegCaps,
  ffmpegInfo,
  probeEncoders,
  downloadFfmpeg,
  onFfmpegProgress,
  saveDialog,
  defaultExportDir,
  type EncoderProbe,
  type FfInfo,
} from '../bridge'
import {
  availableAudio,
  availableContainers,
  defaultBitrate,
  encoderOptions,
  estimateSize,
  presetsFor,
  pickDefaultEncoder,
  supportsQuality,
  CONTAINERS,
  DITHERS,
  QUALITY_PRESETS,
  RESOLUTIONS,
  VIDEO_CODECS,
  type Caps,
  type Container,
  type EncoderOption,
  type ExportSettings,
  type EncodePath,
} from './settings'

export type RunExport = (settings: ExportSettings, out: string) => Promise<void>

const runner = signal<RunExport | null>(null)
export function openExportDialog(run: RunExport) {
  runner.value = run
}

/**
 * Encode Path, remembered for the session.
 *
 * Module level, not component state: the dialog is unmounted between exports,
 * so a choice made here used to be forgotten the moment it ran and the next
 * export silently went back to Auto — i.e. picking "In-app encoder" appeared to
 * do nothing at all. This is a property of the machine, not of one export.
 */
const encodePathPref = signal<EncodePath>('auto')

/** mounted at the app root via `platform.overlays` */
export function ExportDialog() {
  const run = runner.value
  if (!run) return null
  return <ExportInner run={run} />
}

const close = () => (runner.value = null)
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
const mb = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(0)} MB`)
const MB = (n: number) => (n / 1048576).toFixed(0)

function ExportInner({ run }: { run: RunExport }) {
  const project = currentProject.value!
  const duration = contentEnd()

  const [caps, setCaps] = useState<Caps | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [probes, setProbes] = useState<Map<string, EncoderProbe> | null>(null)
  const [info, setInfo] = useState<FfInfo | null>(null)
  const [swapping, setSwapping] = useState(false)

  const [path, setPath] = useState('')
  const [dir, setDir] = useState('')
  const [container, setContainer] = useState<Container>('mp4')
  const [encKey, setEncKey] = useState('')
  const [encoderPinned, setEncoderPinned] = useState(false)
  const [quality, setQuality] = useState('high')
  const [crf, setCrf] = useState(18)
  const [mbps, setMbps] = useState(0)
  const [preset, setPreset] = useState('')
  const [pixFmt, setPixFmt] = useState('yuv420p')
  const [resH, setResH] = useState<number | null>(null)
  const [fps, setFps] = useState(project.fps ?? 30)
  const [aCodec, setACodec] = useState<string | null>('aac')
  const [aBitrate, setABitrate] = useState(192)
  const [dither, setDither] = useState('bayer')
  const [extra, setExtra] = useState('')
  const encodePath = encodePathPref.value
  const setEncodePath = (v: EncodePath) => (encodePathPref.value = v)

  function load() {
    setProbes(null)
    void ffmpegInfo().then(setInfo)
    void defaultExportDir().then(setDir).catch(() => setDir(''))
    ffmpegCaps()
      .then((c) => {
        setCaps(c)
        const mine = VIDEO_CODECS.flatMap((v) => v.encoders.map((e) => e.name)).filter((n) =>
          c.encoders.includes(n),
        )
        probeEncoders(mine)
          .then((rs) => setProbes(new Map(rs.map((r) => [r.name, r]))))
          .catch(() => setProbes(new Map()))
      })
      .catch((e) => setError((e as Error).message || String(e)))
  }
  useEffect(load, [])

  const height = even(resH ?? project.height)
  const width = even((project.width / project.height) * height)
  const ext = CONTAINERS.find((c) => c.id === container)!.ext

  const options: EncoderOption[] = caps ? encoderOptions(caps, container) : []
  const opt = options.find((o) => o.key === encKey) ?? options[0]
  const codec = opt?.codec
  const encoder = opt?.enc.name ?? ''
  const isGif = container === 'gif'
  const canQuality = codec ? supportsQuality(codec, encoder) : false
  const presetInfo = presetsFor(opt?.enc)
  const qp = QUALITY_PRESETS.find((q) => q.id === quality) ?? QUALITY_PRESETS[1]
  const custom = quality === 'custom'
  // Any manual edit to a quality-affecting control drops into Custom, so the
  // named presets always describe what's actually set.
  const touch = () => {
    if (quality !== 'custom') setQuality('custom')
  }
  // Separate from `custom`: "the user has taken over the ENCODER choice", which
  // is the only thing that should stop this dialog steering to hardware. It used
  // to be `custom` itself, so setting an audio codec, an audio bitrate or a
  // custom ffmpeg flag silently froze the video encoder on whatever was selected
  // at that moment — and before the probe lands, that is a software encoder.
  // On a machine with working NVENC that is the difference between 137fps and
  // 23fps, decided by whether you touched an unrelated dropdown.
  const pin = () => setEncoderPinned(true)

  const audios = caps ? availableAudio(caps, container) : []
  const audio = audios.find((a) => a.id === aCodec) ?? null

  // keep the encoder valid when the container changes
  useEffect(() => {
    if (options.length && !options.some((o) => o.key === encKey)) setEncKey(options[0].key)
  }, [caps, container])

  // preset values are encoder-specific ("veryslow" means nothing to NVENC)
  useEffect(() => {
    setPreset(presetInfo ? presetInfo.default : '')
    if (codec?.pixFmts.length) setPixFmt(codec.pixFmts[0])
    if (codec?.quality) setCrf(codec.quality.default)
  }, [encKey])

  useEffect(() => {
    setMbps(Math.round(defaultBitrate(width, height, fps) / 1e6))
  }, [width, height, fps])

  // A preset picks the encoder for you: hardware when this machine can actually
  // open it (much faster), software for lossless since no GPU encoder does it.
  // Only an explicit encoder choice stops it — see `pin`.
  useEffect(() => {
    if (!probes || !options.length || encoderPinned) return
    const works = (n: string) => probes.get(n)?.ok !== false
    const best = pickDefaultEncoder(options, works, !!qp.lossless)
    if (best && best.key !== encKey) setEncKey(best.key)
  }, [probes, caps, container, quality, encoderPinned])

  // Default output path, which must be ABSOLUTE: a bare filename resolves
  // against the process's working directory — src-tauri/ under `tauri dev` —
  // and writing a video there trips the file watcher, which rebuilds and
  // restarts the app in the middle of the export.
  useEffect(() => {
    const name = (project.title || 'export').replace(/[^\w.-]+/g, '_')
    const sep = dir.includes('\\') ? '\\' : '/'
    setPath((p) =>
      p ? p.replace(/\.[^.\\/]+$/, `.${ext}`) : dir ? `${dir}${sep}${name}.${ext}` : `${name}.${ext}`,
    )
  }, [ext, dir])

  const effCrf = custom
    ? crf
    : qp.lossless
      ? (codec?.quality?.min ?? 0) // true lossless, not just "very high"
      : Math.max(0, (codec?.quality?.default ?? 18) + qp.crf)
  const effBitrate = custom
    ? Math.round(mbps * 1e6)
    : Math.round(defaultBitrate(width, height, fps) * qp.mul)
  const useCrf = !isGif && canQuality

  const settings = (): ExportSettings => ({
    container,
    fps,
    width,
    height,
    vCodec: encoder,
    crf: useCrf ? effCrf : undefined,
    vBitrate: !isGif && !useCrf ? effBitrate : undefined,
    preset: presetInfo && preset ? preset : undefined,
    presetFlag: presetInfo && preset ? presetInfo.flag : undefined,
    pixFmt: codec?.pixFmts.length ? pixFmt : undefined,
    aCodec: isGif ? undefined : (aCodec ?? undefined),
    aBitrate: audio?.bitrates ? aBitrate * 1000 : undefined,
    dither: isGif ? dither : undefined,
    extraArgs: extra.trim() || undefined,
    encodePath,
  })

  const est = estimateSize(settings(), duration)

  async function browse() {
    const p = await saveDialog(path || `export.${ext}`, ext)
    if (p) setPath(p)
  }

  async function useOwnBuild() {
    setSwapping(true)
    const task = startTask('Video encoder', 'Downloading…')
    let unlisten = () => {}
    try {
      unlisten = await onFfmpegProgress((r, t) =>
        task.step(t ? `Downloading ${MB(r)} / ${MB(t)} MB…` : 'Downloading…', t ? r / t : null),
      )
      await downloadFfmpeg()
      task.step('Ready', 1)
      load()
    } catch (e) {
      task.step(`Failed: ${(e as Error).message}`, null)
    } finally {
      unlisten()
      task.done()
      setSwapping(false)
    }
  }

  async function start() {
    if (!encoder) return void (await askConfirm('No usable encoder for that combination.', 'OK'))
    if (!path) return void (await askConfirm('Choose where to save the file first.', 'OK'))
    const s = settings()
    close()
    await run(s, path)
  }

  if (error) {
    return (
      <Shell>
        <p class="exp__error">Could not read the encoder list: {error}</p>
      </Shell>
    )
  }
  if (!caps) {
    return (
      <Shell>
        <p class="exp__hint">Reading available encoders…</p>
      </Shell>
    )
  }

  const failed = probes?.get(encoder)?.ok === false
  // Until the probe lands nothing is known about this machine, and `options[0]`
  // — a SOFTWARE encoder, since the list is sorted safe-first — is what's
  // selected. Exporting in that window silently gets you the software encoder
  // even on a box whose NVENC works perfectly. The probe spawns one ffmpeg per
  // encoder, so the window is seconds on a cold start: long enough to lose.
  const probing = !probes

  return (
    <Shell onExport={start} exportDisabled={probing} exportLabel={probing ? 'Checking encoders…' : 'Export'}>
      <h3 class="exp__title">Export</h3>

      {/* the headline choice — everything below is refinement of it */}
      {!isGif && (
        <div class="exp__hero">
          {QUALITY_PRESETS.filter((q) => q.id !== 'custom' || custom).map((q) => (
            <button
              key={q.id}
              class={'exp__heroBtn' + (quality === q.id ? ' is-on' : '')}
              onClick={() => setQuality(q.id)}
            >
              <span class="exp__heroName">{q.label.split(' — ')[0]}</span>
              <span class="exp__heroSub">{q.label.split(' — ')[1] ?? 'your settings'}</span>
            </button>
          ))}
        </div>
      )}

      <Row label="Output File">
        <input
          class="exp__input"
          value={path}
          placeholder={`export.${ext}`}
          onInput={(e) => setPath((e.target as HTMLInputElement).value)}
        />
        <button class="exp__browse" onClick={browse}>
          Browse
        </button>
      </Row>

      <Row label="Format">
        <Select value={container} onChange={(v) => setContainer(v as Container)}>
          {availableContainers(caps).map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
      </Row>

      {!isGif && (
        <>
          <Row label="Video Encoder">
            <Select value={opt?.key ?? ''} onChange={(v) => { touch(); pin(); setEncKey(v) }}>
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                  {probes?.get(o.enc.name)?.ok === false ? ' — unavailable' : ''}
                </option>
              ))}
            </Select>
          </Row>
          {failed && (
            <Row label="">
              <div class="exp__warnbox">
                <span class="exp__warn">{probes!.get(encoder)!.reason}</span>
                {!info?.ours && (
                  <button class="exp__browse" disabled={swapping} onClick={useOwnBuild}>
                    {swapping ? 'Downloading…' : "Use Viewport's ffmpeg"}
                  </button>
                )}
              </div>
            </Row>
          )}

          <Row label="Encode Path">
            <Select value={encodePath} onChange={(v) => setEncodePath(v as EncodePath)}>
              <option value="auto">Auto — measure both, use the faster</option>
              <option value="webcodecs">In-app encoder (no frame copy to ffmpeg)</option>
              <option value="ffmpeg">ffmpeg (raw frames over IPC)</option>
            </Select>
          </Row>

          <Row label="Audio Encoder">
            <Select value={aCodec ?? ''} onChange={(v) => { touch(); setACodec(v === '' ? null : v) }}>
              <option value="">No audio</option>
              {audios.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {a.id === 'aac' ? ' (Default)' : ''}
                </option>
              ))}
            </Select>
          </Row>
          {audio?.bitrates && (
            <Row label="Audio Bitrate">
              <Select value={String(aBitrate)} onChange={(v) => { touch(); setABitrate(+v) }}>
                {audio.bitrates.map((b) => (
                  <option key={b} value={String(b)}>
                    {b} kbps
                  </option>
                ))}
              </Select>
            </Row>
          )}
        </>
      )}

      <Row label="Resolution">
        <Select value={String(resH ?? '')} onChange={(v) => setResH(v === '' ? null : +v)}>
          {RESOLUTIONS.map((r) => (
            <option key={r.label} value={String(r.height ?? '')}>
              {r.label}
              {r.height == null ? ` (${even(project.width)} × ${even(project.height)})` : ''}
            </option>
          ))}
        </Select>
      </Row>

      <Row label="Frame Rate">
        {/* same chips + free-entry input as the New Project dialog */}
        <div class="fps-row">
          {FPS_PRESETS.map((f) => (
            <button key={f} class={'fps-chip' + (fps === f ? ' is-active' : '')} onClick={() => setFps(f)}>
              {f}
            </button>
          ))}
          <input
            class="exp__input fps-input"
            type="number"
            min={1}
            value={fps}
            onInput={(e) => setFps(Math.max(1, +(e.target as HTMLInputElement).value))}
          />
        </div>
      </Row>

      {isGif && (
        <Row label="Dithering">
          <Select value={dither} onChange={setDither}>
            {DITHERS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </Row>
      )}

      {custom && !isGif && (
        <>
          {useCrf ? (
            <Row label={codec?.quality?.label ?? 'CRF'}>
              <input
                class="exp__range"
                type="range"
                min={codec?.quality?.min ?? 0}
                max={codec?.quality?.max ?? 51}
                value={crf}
                onInput={(e) => { touch(); pin(); setCrf(+(e.target as HTMLInputElement).value) }}
              />
              <span class="exp__note">{crf} — lower is better</span>
            </Row>
          ) : (
            <Row label="Bitrate">
              <input
                class="exp__input exp__input--num"
                type="number"
                min={1}
                value={mbps}
                onInput={(e) => { touch(); pin(); setMbps(Math.max(1, +(e.target as HTMLInputElement).value)) }}
              />
              <span class="exp__note">Mbps</span>
            </Row>
          )}
          {presetInfo && (
            <Row label="Encoder Preset">
              <Select value={preset} onChange={(v) => { touch(); pin(); setPreset(v) }}>
                {presetInfo.values.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Row>
          )}
          {codec && codec.pixFmts.length > 1 && (
            <Row label="Color Format">
              <Select value={pixFmt} onChange={(v) => { touch(); pin(); setPixFmt(v) }}>
                {codec.pixFmts.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Row>
          )}
        </>
      )}

      <Row label="Custom ffmpeg Settings">
        <input
          class="exp__input"
          value={extra}
          placeholder="e.g. -tune film -g 120"
          onInput={(e) => { touch(); setExtra((e.target as HTMLInputElement).value) }}
        />
      </Row>

      <div class="exp__summary">
        <span>
          {Math.round(duration * fps)} frames · {duration.toFixed(1)}s · {width} × {height}
        </span>
        <span>{est == null ? 'Size depends on content' : `≈ ${mb(est)}`}</span>
      </div>
      {info && (
        <div class="exp__ffinfo" title={info.path}>
          ffmpeg {info.version} · {info.ours ? 'bundled' : 'system'}
        </div>
      )}
    </Shell>
  )
}

// --- presentation ---

function Shell({
  children,
  onExport,
  exportDisabled,
  exportLabel = 'Export',
}: {
  children: preact.ComponentChildren
  onExport?: () => void
  exportDisabled?: boolean
  exportLabel?: string
}) {
  return (
    <div class="modal" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="modal__box exp__box">
        <div class="exp__body">{children}</div>
        <div class="modal__actions">
          <button class="crop__btn" onClick={close}>
            Cancel
          </button>
          {onExport && (
            <button class="crop__btn crop__btn--primary" disabled={exportDisabled} onClick={onExport}>
              {exportLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <div class="exp__row">
      <label class="exp__label">{label}</label>
      <div class="exp__field">{children}</div>
    </div>
  )
}

function Select({
  value,
  onChange,
  children,
}: {
  value: string
  onChange: (v: string) => void
  children: preact.ComponentChildren
}) {
  return (
    <select class="exp__select" value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
      {children}
    </select>
  )
}
