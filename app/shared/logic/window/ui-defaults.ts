// Core default chrome, registered through the public UI API.
// Doubles as the reference example for how plugins add toolbars / buttons / menus.
import { addToolbar, addMenu } from './ui-api'
import { resetLayout, saveCurrentLayout } from './ui-layouts'
import { setActiveTool } from '../tools/tools'
import { openProjects, openNewProject } from '../project/project'
import { openKeybinds } from '../prefs/keybinds'
import { openPrefs } from '../prefs/preferences'
import { exportProject } from '../project/export'
import { saveProject } from '../project/project-store'
import { openProjectSettings } from '../project/project-settings'
import { platform } from '../platform/platform'
import { askConfirm } from '../ui/confirm'

let done = false

/**
 * The Export button renders the timeline to a video file.
 *
 * It is NOT the project export — that's File > Export Project, which packs the
 * project and its media into a bundle to hand to someone else. This used to
 * fall back to that when no renderer was registered, so in the browser the
 * render button quietly wrote a project file instead. Two different jobs.
 */
function renderVideo() {
  const render = platform.value.exportVideo
  if (render) return void render()
  void askConfirm('Rendering to a video file needs the desktop app for now.', 'OK')
}

export function installDefaultUI() {
  if (done) return
  done = true

  // --- toolbars (max 4, one per edge) ---
  addToolbar({
    id: 'tools',
    name: 'Toolbar',
    dock: 'left',
    buttons: [
      { id: 'files', icon: 'files', label: 'Files', onClick: () => setActiveTool('files') },
      { id: 'properties', icon: 'asset_properties', label: 'Properties', onClick: () => setActiveTool('properties') },
      { id: 'text', icon: 'text', label: 'Text', onClick: () => setActiveTool('text') },
    ],
  })
  addToolbar({
    id: 'utility',
    name: 'Utility Bar',
    dock: 'right',
    buttons: [
      { id: 'export', icon: 'export', label: 'Export', onClick: renderVideo },
    ],
  })

  // --- top-bar menus (items added as features land) ---
  addMenu({
    id: 'file',
    label: 'File',
    items: [
      { id: 'save', label: 'Save Project', action: () => void saveProject() },
      { id: 'settings', label: 'This Project', action: openProjectSettings },
      { id: 'projects', label: 'Projects', action: openProjects, separatorBefore: true },
      { id: 'new', label: 'New Project', action: openNewProject },
      // Hand the whole project to someone else to edit — not a video render,
      // which is the Export button on the utility bar. Desktop packs the media
      // into the zip; the browser can only write the manifest, having no
      // filesystem to stream gigabytes out of. The matching `Open Exported
      // Project` is desktop-only and adds itself after this (see install.ts).
      {
        id: 'exportProject',
        label: 'Export Project',
        separatorBefore: true,
        action: () => void (platform.value.exportBundle?.() ?? exportProject()),
      },
      {
        id: 'prefs',
        label: 'Preferences',
        separatorBefore: true,
        submenu: [
          { id: 'general', label: 'General', action: openPrefs },
          { id: 'keybinds', label: 'Keybinds', action: openKeybinds },
        ],
      },
    ],
  })
  // Edit / Plugins / Help are hidden until they have something in them —
  // plugins register their own menus through the public API.
  addMenu({
    id: 'view',
    label: 'View',
    items: [
      { id: 'toolbars', label: 'Toolbars', dynamic: 'toolbars' },
      { id: 'panels', label: 'Panels', dynamic: 'panels' },
      {
        id: 'layout',
        label: 'Layout',
        submenu: [
          { id: 'reset', label: 'Reset Layout', action: resetLayout },
          { id: 'save', label: 'Save Layout', action: saveCurrentLayout, keepOpen: true },
          { id: 'list', label: 'Layouts', dynamic: 'layouts', separatorBefore: true },
        ],
      },
    ],
  })
}
