// Top bar. Full-width header: logo + menu bar (File/Edit/Plugins/View/Help).
// Under Tauri the OS titlebar is off (frameless) — the header is the drag region
// and hosts our own minimize / maximize / close buttons.
import logoWhite from '../../assets/icons/logo/logo_viewport_8x8_white.png'
import logoBlack from '../../assets/icons/logo/logo_viewport_8x8_black.png'
import { MenuBar } from './menubar'
import { Icon } from '../ui/icon'
import { platform } from '../platform/platform'

export function TopBar() {
  // render both; CSS shows the one matching the active theme (white on dark, black on light)
  const wc = platform.value.windowControls // present on frameless desktop shells
  // Tauri hit-tests the element under the pointer, so every non-interactive part
  // of the bar needs the attribute — not just the header.
  const drag = wc ? { 'data-tauri-drag-region': '' } : {}
  return (
    <header
      class="topbar"
      {...drag}
      // double-click the bar to maximize, but not when it lands on a menu/button
      onDblClick={
        wc
          ? (e: MouseEvent) => {
              if ((e.target as HTMLElement).closest('[data-tauri-drag-region]')) wc.toggleMaximize()
            }
          : undefined
      }
    >
      <div class="topbar__brand" {...drag}>
        <img class="topbar__logo topbar__logo--dark" src={logoWhite} alt="Viewport" width={18} height={18} />
        <img class="topbar__logo topbar__logo--light" src={logoBlack} alt="" width={18} height={18} />
      </div>
      <MenuBar />
      <div class="topbar__drag" {...drag} />
      {wc && (
        <div class="topbar__win">
          <button class="winbtn" title="Minimize" onClick={wc.minimize}>
            <Icon name="minimize" size={16} />
          </button>
          <button class="winbtn" title="Maximize" onClick={wc.toggleMaximize}>
            <Icon name="maximize" size={14} />
          </button>
          <button class="winbtn winbtn--close" title="Close" onClick={wc.close}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
    </header>
  )
}
