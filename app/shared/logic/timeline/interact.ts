// Is the user mid-gesture on the timeline?
//
// Zooming and panning re-render the ruler and every clip, and most of that cost
// is detail nobody can read while the view is moving: filmstrip frames, each of
// which is a decode, and the minor tick marks. So detail is dropped for the
// length of the gesture and comes back the moment it settles.
//
// Nothing about the project changes here — only how much is drawn — so a gesture
// that never settles costs you a plainer timeline and nothing else.
import { signal } from '@preact/signals'

/** true while a wheel/scroll gesture is in flight, and briefly after. */
export const interacting = signal(false)

/** How long after the last event to call it settled. Long enough to bridge the
 *  gaps between wheel notches, short enough that detail feels immediate. */
const SETTLE_MS = 160
let timer: ReturnType<typeof setTimeout> | undefined

/** Call from every wheel / scroll handler that moves the timeline. */
export function poke() {
  if (!interacting.value) interacting.value = true
  clearTimeout(timer)
  timer = setTimeout(() => (interacting.value = false), SETTLE_MS)
}
