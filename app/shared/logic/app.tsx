// Viewport — root layout.
// [ topbar                            ]
// [ dock:top (full width)             ]
// [ dock:left | content | dock:right  ]
// [ dock:bottom (full width)          ]
import { TopBar } from './window/topbar'
import { Content } from './window/content'
import { Rail } from './window/rail'
import { DragLayer } from './window/draglayer'
import { getToolbarAt, type Dock } from './window/ui-api'
import { installDefaultUI } from './window/ui-defaults'
import { installTools } from './tools/install-tools'
import { installLayouts } from './window/ui-layouts'
import { ConfirmDialog } from './ui/confirm'
import { currentProject, showProjects, loadProjects } from './project/project'
import { loadPrefs } from './prefs/preferences'
import { ProjectDialog } from './project/project-dialog'
import { loadPreviews } from './project/preview'
import { ProjectSettingsDialog } from './project/project-settings'
import { KeybindsDialog } from './prefs/keybinds'
import { PreferencesDialog } from './prefs/preferences'
import { ProgressBars } from './ui/progressbar'
import { installProjectStore } from './project/project-store'
import { installShortcuts } from './prefs/shortcuts'
import { installActions } from './prefs/actions'
import { AssetDragGhost } from './timeline/assetdrag'
import { ClipMenu } from './timeline/timelineview'
import { CropDialog } from './viewport/cropdialog'
import { platform } from './platform/platform'

installDefaultUI()
installTools()
installLayouts()
installProjectStore()
installActions()
installShortcuts()

/**
 * Read the user's saved data. Called by each platform entry AFTER it registers
 * its store — at module scope this would run against the default (browser)
 * backend and miss ~/.viewport entirely on desktop.
 */
export async function loadUserData() {
  await loadPrefs()
  await loadProjects()
  await loadPreviews() // project card thumbnails (IndexedDB, not the store)
}

function DockSlot({ dock }: { dock: Dock }) {
  const bar = getToolbarAt(dock)
  return bar && bar.open ? <Rail bar={bar} /> : null
}

export function App() {
  // dialogs owned by the running platform (desktop export settings, …)
  const Overlays = platform.value.overlays
  return (
    <div class="app">
      <TopBar />
      <div class="app__body">
        <DockSlot dock="top" />
        <div class="app__mid">
          <DockSlot dock="left" />
          <Content />
          <DockSlot dock="right" />
        </div>
        <DockSlot dock="bottom" />
      </div>
      <DragLayer />
      <AssetDragGhost />
      <ConfirmDialog />
      <ClipMenu />
      <CropDialog />
      {(currentProject.value === null || showProjects.value) && <ProjectDialog />}
      <KeybindsDialog />
      <ProjectSettingsDialog />
      <PreferencesDialog />
      {Overlays && <Overlays />}
      <ProgressBars />
    </div>
  )
}
