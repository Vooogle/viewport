// Content region — the editable panel area between the rails.
// Future: splittable panels like VS Code (default 3 — timeline bottom [1],
// generic tool left-top [2], viewport right-top [3]). For now: one empty panel.
import { PanelRoot } from './panelviews'

export function Content() {
  return (
    <main class="content">
      <PanelRoot />
    </main>
  )
}
