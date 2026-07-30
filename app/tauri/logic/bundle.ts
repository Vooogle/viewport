// Project bundles: one .viewport.zip holding the manifest and every media file
// the project uses, so a project can be moved between machines intact.
//
// The plain .viewport.json export only records where the media WAS, which is
// useless on another machine. A bundle carries the media, and opening one
// unpacks it under ~/.viewport/media/<project id>/ and rewrites the asset paths
// to point there — so the reopened project is self-contained rather than
// depending on wherever the original files happened to live.
//
// Rust does the archiving (see bundle.rs): media is routinely gigabytes and must
// stream, which the webview cannot do.
import { currentProject, importProject, type Project } from '@shared/logic/project/project'
import { timeline, type TimelineData } from '@shared/logic/timeline/timeline'
import { assetsMeta, type AssetMeta } from '@shared/logic/tools/files/assets'
import { writeJson, projectKey } from '@shared/logic/storage/store'
import { startTask } from '@shared/logic/ui/progress'
import { askConfirm } from '@shared/logic/ui/confirm'
import { bundleWrite, bundleRead, saveDialog, openDialog, type BundleEntry } from './bridge'

const FORMAT = 2

interface Manifest {
  app: 'viewport'
  format: number
  exportedAt: string
  project: Project
  timeline: TimelineData
  /** asset metadata, with `path` rewritten to the name inside the archive */
  assets: AssetMeta[]
}

const baseName = (p: string) => p.split(/[\\/]/).pop() || p

/** Unique name for each source inside the archive. Two projects folders can
 *  easily hold different files called `clip.mp4`. */
function archiveNames(metas: AssetMeta[]): Map<string, string> {
  const out = new Map<string, string>()
  const taken = new Set<string>()
  for (const a of metas) {
    if (!a.path) continue
    const base = baseName(a.path)
    let name = base
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      const dot = base.lastIndexOf('.')
      name = dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`
    }
    taken.add(name.toLowerCase())
    out.set(a.id, name)
  }
  return out
}

/** Write the open project and its media to a .viewport.zip the user picks. */
export async function exportBundle() {
  const p = currentProject.value
  if (!p) return
  const metas = assetsMeta()
  const names = archiveNames(metas)
  const missing = metas.filter((a) => !a.path).length
  if (missing) {
    const ok = await askConfirm(
      `${missing} of this project's ${metas.length} sources have no file on disk and can't be ` +
        `included. The bundle will still open, with those slots empty to relink.`,
      'Continue',
    )
    if (!ok) return
  }

  const suggested = (p.title || 'project').replace(/[^\w.-]+/g, '_')
  const out = await saveDialog(`${suggested}.viewport`, 'zip')
  if (!out) return

  const manifest: Manifest = {
    app: 'viewport',
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    project: p,
    timeline: timeline.value,
    // paths become archive-relative names; opening maps them back to real files
    assets: metas.map((a) => ({ ...a, path: names.get(a.id) })),
  }
  const files: BundleEntry[] = metas
    .filter((a) => a.path)
    .map((a) => ({ path: a.path!, name: names.get(a.id)! }))

  const task = startTask('Export project', `Packing ${files.length} file${files.length === 1 ? '' : 's'}…`)
  try {
    await bundleWrite(out, JSON.stringify(manifest), files)
    task.step('Saved', 1)
  } catch (e) {
    task.step(`Export failed: ${(e as Error).message || e}`, null)
    await askConfirm(`Could not write the bundle:\n\n${(e as Error).message || e}`, 'OK')
  } finally {
    setTimeout(() => task.done(), 900)
  }
}

/** Open a .viewport.zip as a new project, unpacking its media alongside it. */
export async function openBundle() {
  const path = await openDialog('Viewport project', 'zip')
  if (!path) return

  // The id has to exist before unpacking: the media lands in a folder named
  // after it, and the manifest's own id may already be in use here.
  const id = 'proj_' + Date.now().toString(36)
  const task = startTask('Open project', 'Unpacking…')
  try {
    const b = await bundleRead(path, id)
    const data = JSON.parse(b.manifest) as Manifest
    if (data.app !== 'viewport' || !data.project) throw new Error('not a Viewport project bundle')

    const byName = new Map(b.media)
    // archive names become the real paths they were unpacked to; a source that
    // wasn't in the archive stays pathless and reopens as a slot to relink
    const assets = (data.assets ?? []).map((a) => ({
      ...a,
      path: a.path ? byName.get(a.path) : undefined,
    }))
    const project: Project = { ...data.project, id, createdAt: Date.now() }

    // written before the project becomes current: switching to it triggers the
    // load, which has to find this already on disk
    await writeJson(projectKey(id), { assets, timeline: data.timeline })
    importProject(project)
    task.step(`Opened “${project.title}”`, 1)
  } catch (e) {
    task.step(`Could not open: ${(e as Error).message || e}`, null)
    await askConfirm(`Could not open that bundle:\n\n${(e as Error).message || e}`, 'OK')
  } finally {
    setTimeout(() => task.done(), 900)
  }
}
