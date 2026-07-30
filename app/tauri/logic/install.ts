// Register the Tauri desktop platform into the shared registry: media reloads by
// path, native file picker, frameless window controls, and ffmpeg video export.
import { setPlatform } from '@shared/logic/platform/platform'
import { addMenuItem, menus } from '@shared/logic/window/ui-api'
import {
  isTauri,
  srcForPath,
  pickMediaPaths,
  makeProxy,
  makeAudioProxy,
  winMinimize,
  winToggleMax,
  winClose,
} from './bridge'
import { exportVideo } from './export/video'
import { exportBundle, openBundle } from './bundle'
import { DesktopOverlays } from './export/overlays'
import { setMediaOps } from '@shared/logic/media/media'
import { tauriMediaOps } from './media'
import { setStore } from '@shared/logic/storage/store'
import { tauriStore } from './store'

export function installTauriPlatform() {
  if (!isTauri) return // running the tauri bundle in a plain browser (dev) — stay web
  // replaces the WebAudio implementation installed by installWebPlatform()
  setMediaOps(tauriMediaOps)
  // files under ~/.viewport instead of the webview's localStorage
  setStore(tauriStore)
  setPlatform({
    name: 'tauri',
    isDesktop: true,
    srcForPath,
    pickMedia: pickMediaPaths,
    windowControls: { minimize: winMinimize, toggleMaximize: winToggleMax, close: winClose },
    exportVideo,
    exportBundle,
    openBundle,
    // Optional by design: no ffmpeg yet, or a source it can't read, just means
    // the preview keeps using the original.
    proxyFor: async (path, width, height) => {
      try {
        // Half the cores, at least one. This runs in the background while
        // someone is working, and a transcode that takes every core starves the
        // audio decoders with everything else — heard as the preview cutting
        // out. The export's own proxy passes no cap and keeps the machine.
        const cores = navigator.hardwareConcurrency || 4
        const p = await makeProxy(path, width, height, Math.max(1, Math.floor(cores / 2)))
        return { url: srcForPath(p.path), fps: p.fps }
      } catch {
        return null
      }
    },
    audioProxyFor: async (path) => {
      try {
        return srcForPath(await makeAudioProxy(path))
      } catch {
        return null
      }
    },
    overlays: DesktopOverlays,
  })
  // Opening a bundle needs a filesystem, so the item only exists on desktop —
  // added through the same public API a plugin would use. It belongs beside
  // Export Project, being the other half of that trade, so it's placed by
  // looking that item up rather than by a fixed index that a menu edit breaks.
  const file = menus.value.find((m) => m.id === 'file')
  const after = file?.items.findIndex((i) => i.id === 'exportProject') ?? -1
  addMenuItem(
    'file',
    { id: 'openProject', label: 'Open Exported Project', action: () => void openBundle() },
    after >= 0 ? after + 1 : undefined,
  )
}
