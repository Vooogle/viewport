// Content panel system — a binary-ish split tree.
// A node is either a leaf (a panel) or a split (row/col of child nodes with
// fractional sizes). Panels resize via dividers; the API adds/removes panels
// anywhere by splitting a target leaf.
import { signal } from '@preact/signals'
import type { FunctionComponent } from 'preact'

export type Dir = 'row' | 'col'
export type Side = 'left' | 'right' | 'top' | 'bottom'

export interface PanelLeaf {
  kind: 'leaf'
  id: string
  title?: string
}
export interface PanelSplit {
  kind: 'split'
  id: string
  dir: Dir
  /** fraction of the split each child gets; sums to 1 */
  sizes: number[]
  children: PanelNode[]
}
export type PanelNode = PanelLeaf | PanelSplit

const MIN = 0.05
let idCounter = 0
const genId = () => `split_${++idCounter}`

/** Known panels + display names. The tree holds only the open ones;
 *  "open" is derived from tree membership (single source of truth). */
export interface PanelInfo {
  id: string
  title: string
  /** where to re-add when reopened from a closed state */
  reopenSide: Side
}
export const panelInfo = signal<PanelInfo[]>([
  { id: '2', title: 'Tool Panel', reopenSide: 'left' },
  { id: '3', title: 'Viewport', reopenSide: 'right' },
  { id: '1', title: 'Timeline', reopenSide: 'bottom' },
])
export function titleFor(id: string): string {
  return panelInfo.value.find((p) => p.id === id)?.title ?? id
}
/** Register a panel type so it shows a name in View > Panels and can reopen. */
export function registerPanel(info: PanelInfo) {
  if (panelInfo.value.some((p) => p.id === info.id)) return
  panelInfo.value = [...panelInfo.value, info]
}

/** id of the panel to outline (hovered in View > Panels). */
export const highlightPanel = signal<string | null>(null)

/** Component rendered inside a panel, keyed by panel id. Unset = placeholder. */
export const panelContent = signal<Record<string, FunctionComponent>>({})
export function setPanelContent(id: string, comp: FunctionComponent) {
  panelContent.value = { ...panelContent.value, [id]: comp }
}

// Default: [2][3] over [1]
export const panelTree = signal<PanelNode>({
  kind: 'split',
  id: 'root',
  dir: 'col',
  sizes: [0.62, 0.38],
  children: [
    {
      kind: 'split',
      id: 'top',
      dir: 'row',
      sizes: [1 / 3, 2 / 3],
      children: [
        { kind: 'leaf', id: '2' },
        { kind: 'leaf', id: '3' },
      ],
    },
    { kind: 'leaf', id: '1' },
  ],
})

/** Replace the whole tree (e.g. restoring a saved/persisted layout) and keep
 *  the id counter ahead of any restored split ids to avoid collisions. */
export function setPanelTree(node: PanelNode) {
  const walk = (n: PanelNode) => {
    if (n.kind === 'split') {
      const m = /^split_(\d+)$/.exec(n.id)
      if (m) idCounter = Math.max(idCounter, Number(m[1]))
      n.children.forEach(walk)
    }
  }
  walk(node)
  panelTree.value = node
}

/** Update the sizes array of one split by id. */
export function resizeSplit(id: string, sizes: number[]) {
  const walk = (n: PanelNode): PanelNode => {
    if (n.kind !== 'split') return n
    if (n.id === id) return { ...n, sizes }
    return { ...n, children: n.children.map(walk) }
  }
  panelTree.value = walk(panelTree.value)
}

/** Split the leaf `targetId`, inserting a new panel on `side`. */
export function addPanel(targetId: string, side: Side, panel: { id: string; title?: string }) {
  const dir: Dir = side === 'left' || side === 'right' ? 'row' : 'col'
  const before = side === 'left' || side === 'top'
  const leaf: PanelLeaf = { kind: 'leaf', id: panel.id, title: panel.title }

  const walk = (n: PanelNode): PanelNode => {
    if (n.kind === 'leaf') {
      if (n.id !== targetId) return n
      const children = before ? [leaf, n] : [n, leaf]
      return { kind: 'split', id: genId(), dir, sizes: [0.5, 0.5], children }
    }
    return { ...n, children: n.children.map(walk) }
  }
  panelTree.value = walk(panelTree.value)
}

/** Replace the panel at `targetId` in place (swap what it shows). */
export function replacePanel(targetId: string, panel: { id: string; title?: string }) {
  const walk = (n: PanelNode): PanelNode => {
    if (n.kind === 'leaf') {
      if (n.id !== targetId) return n
      return { kind: 'leaf', id: panel.id, title: panel.title }
    }
    return { ...n, children: n.children.map(walk) }
  }
  panelTree.value = walk(panelTree.value)
}

/** Remove a panel by id, collapsing any split left with a single child. */
export function removePanel(id: string) {
  const walk = (n: PanelNode): PanelNode | null => {
    if (n.kind === 'leaf') return n.id === id ? null : n
    const kids: PanelNode[] = []
    const sizes: number[] = []
    n.children.forEach((c, i) => {
      const r = walk(c)
      if (r) {
        kids.push(r)
        sizes.push(n.sizes[i])
      }
    })
    if (kids.length === 0) return null
    if (kids.length === 1) return kids[0]
    const sum = sizes.reduce((a, b) => a + b, 0)
    return { ...n, children: kids, sizes: sizes.map((s) => s / sum) }
  }
  const next = walk(panelTree.value)
  if (next) panelTree.value = next
}

/** Is a panel currently in the tree (open)? */
export function hasPanel(id: string): boolean {
  let found = false
  const walk = (n: PanelNode) => {
    if (n.kind === 'leaf') {
      if (n.id === id) found = true
    } else n.children.forEach(walk)
  }
  walk(panelTree.value)
  return found
}

/** First leaf id in the tree (fallback target for reopening). */
function firstLeafId(n: PanelNode): string {
  return n.kind === 'leaf' ? n.id : firstLeafId(n.children[0])
}

/** Close (remove) or reopen a panel by id. */
export function togglePanel(id: string) {
  if (hasPanel(id)) {
    removePanel(id)
  } else {
    const info = panelInfo.value.find((p) => p.id === id)
    addPanel(firstLeafId(panelTree.value), info?.reopenSide ?? 'right', {
      id,
      title: info?.title,
    })
  }
}

export { MIN }
