// Dragging an asset from the Files tool onto a timeline lane.
// Lightweight pointer-drag (separate from the toolbar drag system): a lane's
// pointerup reads `dragAsset` and drops a clip; the ghost follows the cursor.
import { signal } from '@preact/signals'
import type { Asset } from '../tools/files/assets'

/** The asset actively being dragged (past threshold), or null. */
export const dragAsset = signal<Asset | null>(null)
/** Current cursor position while dragging (for the ghost). */
export const dragPos = signal<{ x: number; y: number }>({ x: 0, y: 0 })
/** Track id the cursor is over, so that lane can highlight. */
export const dragOverTrack = signal<string | null>(null)

let pending: { asset: Asset; x: number; y: number } | null = null

export function beginAssetDrag(asset: Asset, e: PointerEvent) {
  if (e.button !== 0 || asset.missing || !asset.url) return
  pending = { asset, x: e.clientX, y: e.clientY }
  dragPos.value = { x: e.clientX, y: e.clientY }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

function onMove(e: PointerEvent) {
  dragPos.value = { x: e.clientX, y: e.clientY }
  if (pending && !dragAsset.value && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > 4) {
    dragAsset.value = pending.asset
  }
}

function onUp() {
  // Lane pointerup handlers (bubble) run before this window handler, so the
  // drop has already been read from dragAsset by the time we clear it.
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  pending = null
  dragAsset.value = null
  dragOverTrack.value = null
}

export function AssetDragGhost() {
  const a = dragAsset.value
  if (!a) return null
  const { x, y } = dragPos.value
  return (
    <div class="asset-ghost" style={{ left: `${x + 12}px`, top: `${y + 12}px` }}>
      {a.kind === 'image' ? (
        <img src={a.url} alt="" />
      ) : a.kind === 'video' ? (
        <video src={a.url} muted preload="metadata" />
      ) : null}
      <span class="asset-ghost__name">{a.name}</span>
    </div>
  )
}
