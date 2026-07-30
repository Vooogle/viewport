// Minimal promise-based confirm dialog. askConfirm() resolves true/false.
// Render <ConfirmDialog/> once near the app root.
import { signal } from '@preact/signals'

interface ConfirmReq {
  message: string
  confirmLabel: string
  resolve: (ok: boolean) => void
}

const req = signal<ConfirmReq | null>(null)

export function askConfirm(message: string, confirmLabel = 'Delete'): Promise<boolean> {
  return new Promise((resolve) => {
    req.value = { message, confirmLabel, resolve }
  })
}

export function ConfirmDialog() {
  const r = req.value
  if (!r) return null
  const done = (ok: boolean) => {
    r.resolve(ok)
    req.value = null
  }
  return (
    <div class="modal modal--ask" onMouseDown={() => done(false)}>
      <div class="modal__box" onMouseDown={(e) => e.stopPropagation()}>
        <div class="modal__msg">{r.message}</div>
        <div class="modal__actions">
          <button class="btn" onClick={() => done(false)}>
            Cancel
          </button>
          <button class="btn btn--danger" onClick={() => done(true)}>
            {r.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
