// Browser fallback for Export Project: a .viewport.json of the settings,
// timeline and asset references, with no media in it.
//
// Desktop uses bundles instead (app/tauri/logic/bundle.ts), which carry the
// files and so actually survive being sent to someone else. The browser has no
// filesystem to stream multi-GB media out of, so it can only describe the
// project and let the other end relink.
//
// Neither of these renders a video — that's the Export button on the utility
// bar, which runs the ffmpeg/WebCodecs pipeline.
import { currentProject } from './project'
import { timeline } from '../timeline/timeline'
import { assetsMeta } from '../tools/files/assets'

export function exportProject() {
  const p = currentProject.value
  if (!p) return
  const data = {
    app: 'viewport',
    format: 1,
    exportedAt: new Date().toISOString(),
    project: p,
    timeline: timeline.value,
    assets: assetsMeta(),
  }
  const name = (p.title || 'project').replace(/[^\w.-]+/g, '_')
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}.viewport.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
