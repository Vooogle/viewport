// Per-project persistence. Each project keeps its own assets (metadata only —
// blobs can't survive, so they reload as blank slots to relink) and timeline.
// Switching projects loads that project's data; edits save back to it.
import { effect } from '@preact/signals'
import { currentProject } from './project'
import { assets, assetsMeta, hydrateAssets, type AssetMeta } from '../tools/files/assets'
import { timeline, clearHistory, type TimelineData, type Clip } from '../timeline/timeline'
import { luts, lutsMeta, hydrateLuts, type LutMeta } from '../render/lut'
import { platform } from '../platform/platform'
import { readJson, writeJson, projectKey } from '../storage/store'
import { startTask } from '../ui/progress'

interface ProjectData {
  assets: AssetMeta[]
  timeline: TimelineData
  /** loaded LUTs — where they came from, never their contents (see lut.ts) */
  luts?: LutMeta[]
}

const legacyKey = (id: string) => `viewport.project.${id}`

/**
 * `muted` became volume 0.
 *
 * It was a flag that overrode an animatable property, so a muted object ignored
 * its own volume keyframes — and nothing in the UI could clear it, which meant
 * detaching audio from a source whose audio couldn't be extracted lost the
 * sound with no way back. Silence is now a level, which is a thing you can see,
 * change and animate.
 */
function migrateMuted(t: TimelineData) {
  for (const track of t.tracks)
    for (const c of track.clips as (Clip & { muted?: boolean })[]) {
      if (!c.muted) continue
      delete c.muted
      c.volume = 0
      // a curve left behind would fight the zero it was traded for
      if (c.anim?.volume) delete c.anim.volume
    }
}
/**
 * Hue is gone — the tone curve is the per-channel control now.
 *
 * It was an angle, then three scalars, and the scalars turned out to be a curve
 * channel with a constant slope: the same job the curve editor was already
 * doing with handles you can see. Neither shape converts into a curve
 * honestly — a curve holds points, and inventing them would put a shape on the
 * timeline that nobody drew — so the old values are dropped along with any
 * keyframes over them. Everything else on the grade is untouched.
 */
const DEAD_GRADE = ['hue', 'hueR', 'hueG', 'hueB']
function migrateHue(t: TimelineData) {
  for (const track of t.tracks)
    for (const c of track.clips) {
      const g = c.grade as Record<string, number> | undefined
      if (g) {
        for (const k of DEAD_GRADE) delete g[k]
        if (!Object.keys(g).length) delete c.grade
      }
      if (c.anim) {
        for (const k of DEAD_GRADE) delete c.anim[k]
        if (!Object.keys(c.anim).length) delete c.anim
      }
    }
}

let loading = false

/** Quiet period after the last edit before an autosave runs. Every timeline
 *  signal write used to hit the disk, so one clip drag wrote the whole project
 *  once per frame. */
const DEBOUNCE_MS = 700
/** Floor on how long the indicator stays up. The write itself is usually
 *  instant, and a bar that appears and vanishes in the same frame reads as a
 *  glitch rather than as "saved". */
const SHOW_MS = 600

let timer: ReturnType<typeof setTimeout> | undefined
let saving = false
let again = false

/** Write the open project now. `label` distinguishes a manual save in the UI. */
export async function saveProject(label = 'Saving project…'): Promise<void> {
  const p = currentProject.value
  if (!p || loading) return
  clearTimeout(timer)
  // A save already in flight: let it finish, then run once more for whatever
  // changed in the meantime. Two concurrent writers would race on one file.
  if (saving) {
    again = true
    return
  }
  saving = true
  const task = startTask('Project', label)
  const t0 = performance.now()
  try {
    const data: ProjectData = { assets: assetsMeta(), timeline: timeline.value, luts: lutsMeta() }
    await writeJson(projectKey(p.id), data)
  } catch {
    task.step('Could not save the project', null)
  } finally {
    const held = performance.now() - t0
    if (held < SHOW_MS) await new Promise((r) => setTimeout(r, SHOW_MS - held))
    task.done()
    saving = false
    if (again) {
      again = false
      queueSave()
    }
  }
}

function queueSave() {
  if (!currentProject.value || loading) return
  clearTimeout(timer)
  timer = setTimeout(() => void saveProject('Autosaving…'), DEBOUNCE_MS)
}

async function load(id: string, fps: number) {
  // held across the await: signal writes below would otherwise be seen as edits
  // and saved straight back over the project we're still loading
  loading = true
  let data = await readJson<ProjectData | null>(projectKey(id), null)
  if (!data) {
    // one-time migration out of localStorage
    try {
      const raw = localStorage.getItem(legacyKey(id))
      if (raw) {
        data = JSON.parse(raw) as ProjectData
        await writeJson(projectKey(id), data)
        localStorage.removeItem(legacyKey(id))
      }
    } catch {
      /* nothing to migrate */
    }
  }
  hydrateAssets(data?.assets ?? [])
  // Fire and forget: a LUT re-reads from disk, and holding the load on it would
  // hold the whole project open behind a file that may not be there any more.
  void hydrateLuts(data?.luts ?? [], platform.value.srcForPath)
  if (data?.timeline) {
    migrateMuted(data.timeline)
    migrateHue(data.timeline)
  }
  timeline.value = data?.timeline ?? { fps, duration: 60, tracks: [] }
  clearHistory() // undo shouldn't cross project boundaries
  loading = false
}

export function installProjectStore() {
  let prev: string | null = null
  // load a project's data when it becomes current
  effect(() => {
    const p = currentProject.value
    if (p && p.id !== prev) {
      prev = p.id
      void load(p.id, p.fps)
    }
  })
  // persist assets + timeline edits back to the current project
  effect(() => {
    assets.value
    timeline.value
    luts.value
    queueSave()
  })
}
