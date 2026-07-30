// Tool registry. Tools live in the Tool Panel; the active one is shown.
// Toolbar buttons (Files, Properties, …) switch the active tool.
import { signal } from '@preact/signals'
import type { FunctionComponent } from 'preact'

export interface Tool {
  id: string
  title: string
  icon: string
  Component: FunctionComponent
}

export const tools = signal<Tool[]>([])
export const activeToolId = signal<string | null>(null)

export function registerTool(tool: Tool) {
  if (tools.value.some((t) => t.id === tool.id)) return
  tools.value = [...tools.value, tool]
  if (!activeToolId.value) activeToolId.value = tool.id
}

export function setActiveTool(id: string) {
  activeToolId.value = id
}
