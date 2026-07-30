// Fixed stack of small progress bars (bottom-right). Shows each active task's
// name, live step, and either a determinate fill or an indeterminate marquee.
import { tasks } from './progress'

export function ProgressBars() {
  const list = tasks.value
  if (!list.length) return null
  return (
    <div class="prog">
      {list.map((t) => (
        <div class="prog__item" key={t.id}>
          <div class="prog__top">
            <span class="prog__label">{t.label}</span>
            {t.value != null && <span class="prog__pct">{Math.round(t.value * 100)}%</span>}
          </div>
          <div class={'prog__bar' + (t.value == null ? ' is-indef' : '')}>
            <div
              class="prog__fill"
              style={t.value == null ? undefined : { width: `${Math.round(t.value * 100)}%` }}
            />
          </div>
          {t.detail && <div class="prog__detail">{t.detail}</div>}
        </div>
      ))}
    </div>
  )
}
