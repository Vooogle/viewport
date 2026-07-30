// Panel views. Renders the split tree with resizable dividers.
import { Fragment } from 'preact'
import { useRef } from 'preact/hooks'
import {
  panelTree,
  resizeSplit,
  highlightPanel,
  panelContent,
  titleFor,
  MIN,
  type PanelNode,
  type PanelSplit,
} from './panels'
import { onDrag } from '../ui/pointerdrag'

function Leaf({ id }: { id: string }) {
  const highlighted = highlightPanel.value === id
  const Content = panelContent.value[id]
  return (
    <div class={'panel' + (highlighted ? ' is-highlight' : '')}>
      {Content ? <Content /> : <div class="panel__placeholder">{titleFor(id)}</div>}
    </div>
  )
}

function Split({ node }: { node: PanelSplit }) {
  const ref = useRef<HTMLDivElement>(null)
  const row = node.dir === 'row'

  const startResize = (i: number, e: PointerEvent) => {
    e.preventDefault()
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const total = row ? rect.width : rect.height
    const startPos = row ? e.clientX : e.clientY
    const start = [...node.sizes]

    const move = (ev: PointerEvent) => {
      const pos = row ? ev.clientX : ev.clientY
      let delta = (pos - startPos) / total
      delta = Math.max(delta, MIN - start[i])
      delta = Math.min(delta, start[i + 1] - MIN)
      const sizes = [...start]
      sizes[i] = start[i] + delta
      sizes[i + 1] = start[i + 1] - delta
      resizeSplit(node.id, sizes)
    }
    const up = () => {
      document.body.classList.remove('is-resizing')
    }
    document.body.classList.add('is-resizing')
    onDrag(move, up)
  }

  return (
    <div ref={ref} class={`split split--${node.dir}`}>
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          <div class="split__cell" style={{ flexGrow: node.sizes[i], flexBasis: 0 }}>
            <Node node={child} />
          </div>
          {i < node.children.length - 1 && (
            <div
              class={`divider divider--${node.dir}`}
              onPointerDown={(e) => startResize(i, e as unknown as PointerEvent)}
            />
          )}
        </Fragment>
      ))}
    </div>
  )
}

function Node({ node }: { node: PanelNode }) {
  return node.kind === 'leaf' ? <Leaf id={node.id} /> : <Split node={node} />
}

export function PanelRoot() {
  return <Node node={panelTree.value} />
}
