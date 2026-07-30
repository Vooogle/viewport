// Renders the active tool inside the Tool Panel.
import { tools, activeToolId } from './tools'

export function ToolHost() {
  const tool = tools.value.find((t) => t.id === activeToolId.value)
  if (!tool) return <div class="panel__placeholder">No tool</div>
  const C = tool.Component
  return <C />
}
