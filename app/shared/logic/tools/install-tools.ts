// Register core tools and mount the tool host in the Tool Panel (id '2').
import { registerTool } from './tools'
import { ToolHost } from './toolhost'
import { FilesTool } from './files/files'
import { PropertiesTool } from '../properties/properties'
import { TextTool } from '../text/texttool'
import { setPanelContent } from '../window/panels'
import { TimelineTool } from '../timeline/timelineview'
import { ViewportTool } from '../viewport/viewportview'

let done = false

export function installTools() {
  if (done) return
  done = true
  registerTool({ id: 'files', title: 'Files', icon: 'files', Component: FilesTool })
  registerTool({ id: 'properties', title: 'Properties', icon: 'asset_properties', Component: PropertiesTool })
  registerTool({ id: 'text', title: 'Text', icon: 'text', Component: TextTool })
  setPanelContent('2', ToolHost) // Tool Panel hosts the active tool
  setPanelContent('1', TimelineTool) // Timeline panel
  setPanelContent('3', ViewportTool) // Viewport panel
}
