// Viewport public API — the single, stable surface for plugins (and core code).
// Import { viewport } from '@shared/logic/api', or use the window.viewport global
// at runtime. Internal modules may change; this grouping is the contract.
import * as ui from './window/ui-api'
import * as panels from './window/panels'
import * as layouts from './window/ui-layouts'
import * as files from './tools/files/assets'
import * as toolsApi from './tools/tools'
import * as tl from './timeline/timeline'
import * as proj from './project/project'
import * as actionsApi from './prefs/actions'
import * as keybinds from './prefs/keybinds'
import * as plugins from './plugins/plugins'
import * as progress from './ui/progress'
import * as anim from './timeline/anim'
import * as preferences from './prefs/preferences'

export const viewport = {
  toolbars: {
    add: ui.addToolbar,
    remove: ui.removeToolbar,
    setDock: ui.setToolbarDock,
    get: ui.getToolbar,
    at: ui.getToolbarAt,
    MAX: ui.MAX_TOOLBARS,
    DOCKS: ui.DOCKS,
  },
  buttons: {
    add: ui.addButton,
    remove: ui.removeButton,
    move: ui.moveButton,
  },
  menus: {
    add: ui.addMenu,
    remove: ui.removeMenu,
    addItem: ui.addMenuItem,
    removeItem: ui.removeMenuItem,
  },
  panels: {
    add: panels.addPanel,
    remove: panels.removePanel,
    replace: panels.replacePanel,
    toggle: panels.togglePanel,
    has: panels.hasPanel,
    register: panels.registerPanel,
  },
  layouts: {
    save: layouts.saveCurrentLayout,
    load: layouts.loadLayout,
    update: layouts.updateLayout,
    remove: layouts.deleteLayout,
    reset: layouts.resetLayout,
  },
  files: {
    add: files.addAssetsFromFiles,
    remove: files.removeAsset,
    replace: files.replaceAsset,
    registerType: files.registerFileType,
    isSupported: files.isSupported,
  },
  tools: {
    register: toolsApi.registerTool,
    setActive: toolsApi.setActiveTool,
    active: toolsApi.activeToolId,
    all: toolsApi.tools,
  },
  timeline: {
    data: tl.timeline,
    // tracks
    addTrack: tl.addTrack,
    removeTrack: tl.removeTrack,
    renameTrack: tl.renameTrack,
    moveTrack: tl.moveTrack,
    setTrackHeight: tl.setTrackHeight,
    trackLetter: tl.trackLetter,
    // objects (clips)
    addClip: tl.addClip,
    removeClip: tl.removeClip,
    moveClip: tl.setClipPos,
    setStart: tl.setClipStart,
    setDuration: tl.setClipDuration,
    setIn: tl.setClipIn,
    setVolume: tl.setClipVolume,
    setPitch: tl.setClipPitch,
    setPan: tl.setClipPan,
    setTransform: tl.setClipXform,
    setLayer: tl.setClipLayer,
    setGroupLayer: tl.setGroupLayer,
    trimStart: tl.trimClipStart,
    split: tl.splitClip,
    splitAllAt: tl.splitAllAt,
    copy: tl.copyClip,
    cut: tl.cutClip,
    paste: tl.pasteClip,
    detachAudio: tl.detachAudio,
    revealChannels: tl.revealChannels,
    layerOf: tl.clipLayer,
    find: tl.findClip,
    selected: tl.selectedClipId,
    // linking (groups)
    link: tl.linkSelected,
    unlink: tl.unlinkSelected,
    setGroup: tl.setGroup,
    groupOf: tl.groupOf,
    groupMembers: tl.groupMembers,
    isLinked: tl.isLinked,
    // playback
    playhead: tl.playhead,
    playing: tl.playing,
    play: tl.play,
    pause: tl.pause,
    togglePlay: tl.togglePlay,
    seekBy: tl.seekBy,
    frameStep: tl.frameStep,
    jumpToEdge: tl.jumpToEdge,
    contentEnd: tl.contentEnd,
    // ruler + snapping + history
    ruler: { unit: tl.rulerUnit, step: tl.rulerStep },
    snapPoints: tl.snapPoints,
    snapValue: tl.snapValue,
    history: { undo: tl.undo, redo: tl.redo, snapshot: tl.snapshot, clear: tl.clearHistory },
    MIN_CLIP: tl.MIN_CLIP,
    TRACK_H: tl.TRACK_H,
    SEGMENT_PX: tl.SEGMENT_PX,
  },
  project: {
    list: proj.projects,
    current: proj.currentProject,
    create: proj.createProject,
    open: proj.openProject,
    delete: proj.deleteProject,
    update: proj.updateProject,
    openDialog: proj.openProjects,
    openNew: proj.openNewProject,
    close: proj.closeProjects,
    RATIOS: proj.RATIOS,
    PRESETS: proj.PRESETS,
    FPS_PRESETS: proj.FPS_PRESETS,
  },
  actions: {
    register: actionsApi.registerAction,
    map: actionsApi.actions,
  },
  prefs: {
    data: preferences.prefs,
    set: preferences.setPref,
    open: preferences.openPrefs,
  },
  keybinds: {
    data: keybinds.keybinds,
    open: keybinds.openKeybinds,
    register: keybinds.registerBind,
    make: keybinds.makeBind,
    find: keybinds.findBind,
    matches: keybinds.matchesBind,
    setCombo: keybinds.setCombo,
    addCombo: keybinds.addCombo,
    removeCombo: keybinds.removeCombo,
    revert: keybinds.revertBind,
  },
  progress: {
    start: progress.startTask,
    tasks: progress.tasks,
  },
  anim: {
    props: anim.ANIM_PROPS,
    open: anim.startAnimating,
    close: anim.stopAnimating,
    editing: anim.animatingClipId,
    addProp: anim.addAnimProp,
    removeProp: anim.removeAnimProp,
    addKey: anim.addKeyframe,
    removeKey: anim.removeKeyframe,
    moveKey: anim.moveKeyframe,
    setKeyValue: anim.setKeyframeValue,
    setKeyInterp: anim.setKeyframeInterp,
    setKeyHandles: anim.setKeyframeHandles,
    muteProp: anim.toggleAnimMuted,
    sample: anim.sampleClip,
    apply: anim.applyProp,
    playhead: anim.animPlayhead,
  },
  plugins: {
    register: plugins.registerPlugin,
    unregister: plugins.unregisterPlugin,
    list: plugins.listPlugins,
  },
} as const

export type ViewportAPI = typeof viewport

// re-export the public types plugins need
export type { Dock, ButtonDef, ToolbarDef, MenuDef, MenuItemDef } from './window/ui-api'
export type { PanelNode, PanelInfo, Side } from './window/panels'
export type { Asset, AssetKind, FileType } from './tools/files/assets'
export type { Tool } from './tools/tools'
export type { Clip, Track, TimelineData, RulerUnit } from './timeline/timeline'
export type { Project, Ratio, Preset } from './project/project'
export type { Keybind, KbCategory } from './prefs/keybinds'
export type { Task, TaskHandle } from './ui/progress'
export type { Keyframe, AnimTrack, AnimProp, Interp } from './timeline/anim'
export type { Plugin } from './plugins/plugins'

// expose for runtime-loaded plugins (non-module scripts)
declare global {
  // eslint-disable-next-line no-var
  var viewport: ViewportAPI
}
;(globalThis as unknown as { viewport: ViewportAPI }).viewport = viewport
