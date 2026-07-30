// Lightweight task/progress store. Any long op calls startTask() and drives a
// handle; a small bar (ProgressBars) renders every active task with its live
// detail text. value is 0..1, or null for an indeterminate (marquee) bar.
import { signal } from '@preact/signals'

export interface Task {
  id: string
  /** overall name, e.g. "Detach audio" */
  label: string
  /** live step, e.g. "Decoding audio…" */
  detail: string
  /** 0..1, or null = indeterminate */
  value: number | null
}

export const tasks = signal<Task[]>([])

export interface TaskHandle {
  id: string
  /** set the live step text and (optionally) the value */
  step(detail: string, value?: number | null): void
  /** set just the value (0..1 or null) */
  set(value: number | null): void
  /** remove the task */
  done(): void
}

let n = 0
export function startTask(label: string, detail = '', value: number | null = null): TaskHandle {
  const id = `t${++n}`
  tasks.value = [...tasks.value, { id, label, detail, value }]
  const patch = (p: Partial<Task>) => {
    tasks.value = tasks.value.map((t) => (t.id === id ? { ...t, ...p } : t))
  }
  return {
    id,
    step: (detail, value) => patch(value === undefined ? { detail } : { detail, value }),
    set: (value) => patch({ value }),
    done: () => {
      tasks.value = tasks.value.filter((t) => t.id !== id)
    },
  }
}
