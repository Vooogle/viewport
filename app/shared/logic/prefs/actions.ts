// Maps keybind ids -> functions. Shortcuts dispatch these when a combo fires.
import {
  undo,
  redo,
  seekBy,
  frameStep,
  splitClip,
  splitAllAt,
  gapAt,
  closeGap,
  closeAllGaps,
  removeSelected,
  copyClip,
  cutClip,
  pasteClip,
  linkSelected,
  unlinkSelected,
  selectedClipId,
  playhead,
} from '../timeline/timeline'
import {
  animatingClipId,
  animPlayhead,
  animSeekBy,
  animFrameStep,
  animJumpKey,
  removeSelectedKeys,
  copySelectedKeys,
  pasteKeys,
} from '../timeline/anim'

import { saveProject } from '../project/project-store'

export const actions = new Map<string, () => void>()

export function registerAction(id: string, fn: () => void) {
  actions.set(id, fn)
}

export function installActions() {
  registerAction('undo', undo)
  registerAction('redo', redo)
  registerAction('save', () => void saveProject())
  // seeking: local anim playhead while animating, else the main playhead
  const anim = () => animatingClipId.value != null
  registerAction('frameLeft', () => (anim() ? animFrameStep(-1) : frameStep(-1)))
  registerAction('frameRight', () => (anim() ? animFrameStep(1) : frameStep(1)))
  registerAction('seek5Left', () => (anim() ? animJumpKey(-1) : seekBy(-5)))
  registerAction('seek5Right', () => (anim() ? animJumpKey(1) : seekBy(5)))
  registerAction('seek1Left', () => (anim() ? animSeekBy(-1) : seekBy(-1)))
  registerAction('seek1Right', () => (anim() ? animSeekBy(1) : seekBy(1)))
  registerAction('cut', () => {
    const id = selectedClipId.value
    if (id) splitClip(id, playhead.value)
  })
  registerAction('cutAll', () => splitAllAt(playhead.value))
  // dead air: close the one the playhead is sitting in, or all of them
  registerAction('closeGap', () => {
    const g = gapAt(playhead.value)
    if (g) closeGap(g)
  })
  registerAction('closeAllGaps', closeAllGaps)
  // Delete / Copy / Cut / Paste cross over: keyframes while animating, else objects
  registerAction('deleteObject', () => {
    const a = animatingClipId.value
    if (a) removeSelectedKeys(a)
    else removeSelected()
  })
  registerAction('copy', () => {
    const a = animatingClipId.value
    if (a) copySelectedKeys(a)
    else copyClip()
  })
  registerAction('cutObject', () => {
    const a = animatingClipId.value
    if (a) {
      copySelectedKeys(a)
      removeSelectedKeys(a)
    } else cutClip()
  })
  registerAction('paste', () => {
    const a = animatingClipId.value
    if (a) pasteKeys(a, animPlayhead.value)
    else pasteClip()
  })
  registerAction('link', () => linkSelected())
  registerAction('unlink', () => unlinkSelected())
  // clipLeft / clipRight (edge nudges) — wired later
}
