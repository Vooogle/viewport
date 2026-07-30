// Project preview thumbnails for the Projects dialog.
//
// The picture is a real frame off the scene renderer — the same one the export
// uses — so a card shows the composite (transforms, text, video frames), not a
// bare source thumbnail.
//
// Only the OPEN project can be captured: the renderer reads the live `timeline`
// and `assets` signals, and loading another project's data to draw it would
// clobber the one being edited. So a project gets its picture while it's open
// and keeps it afterwards; one that has never been opened shows a placeholder.
//
// Stored in IndexedDB, not with the project JSON — that file is small metadata
// the desktop build writes as plain text under ~/.viewport, and a base64 JPEG
// per project has no business in it.
import { signal } from '@preact/signals'
import { createRenderer } from '../render/scene'
import { mediaExclusive } from '../media/exclusive'
import { playhead, timeline } from '../timeline/timeline'
import type { Project } from './project'

/** dataURL per project id, for the dialog to read. */
export const previews = signal<Record<string, string>>({})

/** Longest edge of a stored preview. Big enough for a card on a HiDPI screen,
 *  small enough that the JPEG stays tens of KB. */
const MAX_EDGE = 480
const QUALITY = 0.72

const DB_NAME = 'viewport-previews'
const STORE = 'previews'

function open(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
      }
      req.onsuccess = () => res(req.result)
      req.onerror = () => res(null)
    } catch {
      res(null) // private mode, or storage disabled — previews are optional
    }
  })
}

/** Read every stored preview into the signal. Called once at startup. */
export async function loadPreviews() {
  const db = await open()
  if (!db) return
  try {
    const tx = db.transaction(STORE, 'readonly').objectStore(STORE)
    const keys = tx.getAllKeys()
    const vals = tx.getAll()
    await new Promise((r) => (vals.onsuccess = r))
    const out: Record<string, string> = {}
    ;(keys.result as string[]).forEach((k, i) => (out[k] = (vals.result as string[])[i]))
    previews.value = out
  } catch {
    /* unreadable store — the dialog just shows placeholders */
  }
}

function put(id: string, data: string) {
  previews.value = { ...previews.value, [id]: data }
  void open().then((db) => {
    if (!db) return
    try {
      db.transaction(STORE, 'readwrite').objectStore(STORE).put(data, id)
    } catch {
      /* ignore — the in-memory copy still works for this session */
    }
  })
}

/** Forget a project's picture (it was deleted). */
export function dropPreview(id: string) {
  const next = { ...previews.value }
  delete next[id]
  previews.value = next
  void open().then((db) => {
    if (!db) return
    try {
      db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id)
    } catch {
      /* ignore */
    }
  })
}

/** Preview size for a project, longest edge capped, both edges even. */
function previewSize(p: Project): { w: number; h: number } {
  const s = Math.min(1, MAX_EDGE / Math.max(p.width, p.height))
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  return { w: even(p.width * s), h: even(p.height * s) }
}

/**
 * When to draw the frame.
 *
 * The playhead is the honest answer — it's what you were last looking at. But
 * park it in a gap (or past the end) and the card is a black square, which tells
 * you nothing about which project it is. So fall back to the first moment
 * something is actually on screen.
 */
function captureTime(at: number): number {
  const visual = timeline.value.tracks.flatMap((tr) => tr.clips.filter((c) => !c.audioOnly))
  if (!visual.length) return at
  if (visual.some((c) => at >= c.start && at < c.start + c.duration)) return at
  return Math.min(...visual.map((c) => c.start))
}

let capturing = false

/**
 * Draw the open project at the current playhead and store the result.
 *
 * Quiet about failure: a preview is decoration, and a project that can't render
 * one (no GPU context, media still loading) must still open normally.
 */
export async function capturePreview(project: Project, at = playhead.value) {
  // An export owns the media pipeline; opening decoders here would take
  // hardware encoding away from it. The picture can wait.
  if (capturing || mediaExclusive.value) return
  capturing = true
  const { w, h } = previewSize(project)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  let renderer
  try {
    // packed=false leaves the frame in the default framebuffer, which is what
    // toDataURL reads; the packed path would hand back planar YUV instead.
    renderer = await createRenderer(canvas, project, undefined, false)
    await renderer.render(Math.max(0, captureTime(at)))
    put(project.id, canvas.toDataURL('image/jpeg', QUALITY))
  } catch {
    /* no context, undecodable media, … — keep whatever picture we had */
  } finally {
    renderer?.dispose()
    capturing = false
  }
}
