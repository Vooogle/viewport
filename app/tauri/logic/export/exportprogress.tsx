// Blocking export dialog. Covers the app for the whole export: the timeline is
// read live while frames render, so editing mid-export would change the output
// halfway through. There's no backdrop-dismiss and no Escape — Cancel is the
// only way out, and it stops the encode properly rather than orphaning ffmpeg.
import { exportState, closeExport, requestCancel, clock } from './progress'

const pct = (v: number | null) => (v == null ? '' : `${Math.round(v * 100)}%`)

export function ExportProgress() {
  const s = exportState.value
  if (!s) return null
  const finished = s.stage === 'done' || s.stage === 'error'
  const failed = s.stage === 'error'

  return (
    // no onPointerDown-to-close: this one is deliberately modal
    <div class="modal modal--top">
      <div class="modal__box exp-run">
        <div class="exp-run__head">
          <span class="exp-run__title">
            {failed ? 'Export failed' : finished ? 'Export complete' : 'Exporting'}
          </span>
          <span class="exp-run__pct">{finished ? '' : pct(s.value)}</span>
        </div>

        <div class="exp-run__bar">
          <div
            class={'exp-run__fill' + (s.value == null ? ' is-indeterminate' : '') + (failed ? ' is-error' : '')}
            style={s.value == null ? undefined : { width: `${Math.min(100, s.value * 100)}%` }}
          />
        </div>

        <div class="exp-run__detail">{s.detail}</div>

        {/* the numbers that actually tell you how it's going */}
        {!finished && (
          <div class="exp-run__stats">
            <Stat label="Elapsed" value={clock(s.elapsedMs)} />
            <Stat label="Remaining" value={s.etaMs == null ? '—' : clock(s.etaMs)} />
            <Stat label="Rate" value={s.fps ? `${s.fps.toFixed(1)} fps` : '—'} />
            <Stat
              label="Frames"
              value={s.total ? `${s.frame.toLocaleString()} / ${s.total.toLocaleString()}` : '—'}
            />
          </div>
        )}

        {s.stage === 'render' && s.cost.seek + s.cost.render + s.cost.read + s.cost.send > 0 && (
          <div class="exp-run__meta">
            per frame — seek {s.cost.seek.toFixed(0)}ms · draw {s.cost.render.toFixed(0)}ms · readback{' '}
            {s.cost.read.toFixed(0)}ms · encoder {s.cost.send.toFixed(0)}ms · pipe{' '}
            {s.cost.pipe.toFixed(0)}ms
          </div>
        )}
        <div class="exp-run__meta">{s.summary}</div>
        <div class="exp-run__meta exp-run__path" title={s.out}>
          {s.out}
        </div>

        <div class="modal__actions">
          {finished ? (
            <button class="crop__btn crop__btn--primary" onClick={closeExport}>
              Close
            </button>
          ) : (
            <button class="crop__btn" disabled={s.cancelled} onClick={requestCancel}>
              {s.cancelled ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div class="exp-run__stat">
      <span class="exp-run__statLabel">{label}</span>
      <span class="exp-run__statValue">{value}</span>
    </div>
  )
}
