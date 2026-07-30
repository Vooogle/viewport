// Plugin registry. A plugin gets the public `viewport` API on activate and
// uses it to add toolbars, buttons, menus, panels, etc.
import { viewport, type ViewportAPI } from '../api'

export interface Plugin {
  id: string
  name?: string
  activate(vp: ViewportAPI): void
  deactivate?(): void
}

const active = new Map<string, Plugin>()

export function registerPlugin(plugin: Plugin) {
  if (active.has(plugin.id)) return
  try {
    plugin.activate(viewport)
    active.set(plugin.id, plugin)
  } catch (err) {
    console.error(`[plugin] "${plugin.id}" failed to activate:`, err)
  }
}

export function unregisterPlugin(id: string) {
  const plugin = active.get(id)
  if (!plugin) return
  try {
    plugin.deactivate?.()
  } catch (err) {
    console.error(`[plugin] "${id}" failed to deactivate:`, err)
  }
  active.delete(id)
}

export function listPlugins(): Plugin[] {
  return [...active.values()]
}
