// Project store + presets. A project is small metadata (title/resolution/fps);
// media lives elsewhere (OPFS, later). Metadata persists to ~/.viewport/ on
// desktop (localStorage in the browser) — see logic/storage/store.ts.
import { signal } from '@preact/signals'
import { readJson, writeJson, store, projectKey } from '../storage/store'

export interface Project {
  id: string
  title: string
  width: number
  height: number
  fps: number
  createdAt: number
}

export const projects = signal<Project[]>([])
export const currentProject = signal<Project | null>(null)

// dialog visibility (independent of whether a project is open)
export const showProjects = signal(false)
export const projectStartView = signal<'list' | 'new'>('list')
export function openProjects() {
  projectStartView.value = 'list'
  showProjects.value = true
}
export function openNewProject() {
  projectStartView.value = 'new'
  showProjects.value = true
}
export function closeProjects() {
  showProjects.value = false
}

const LS = 'viewport.projects' // legacy key, read once for migration
const INDEX_KEY = 'projects.json'

function persist() {
  void writeJson(INDEX_KEY, projects.value)
}

export async function loadProjects() {
  let list = await readJson<Project[] | null>(INDEX_KEY, null)
  if (!list) {
    // one-time migration out of localStorage
    try {
      const raw = localStorage.getItem(LS)
      if (raw) {
        list = JSON.parse(raw) as Project[]
        await writeJson(INDEX_KEY, list)
        localStorage.removeItem(LS)
      }
    } catch {
      /* nothing to migrate */
    }
  }
  if (list) projects.value = list
}

export function createProject(def: { title: string; width: number; height: number; fps: number }): Project {
  const p: Project = {
    id: 'proj_' + Date.now().toString(36),
    title: def.title.trim() || 'Untitled',
    width: def.width,
    height: def.height,
    fps: def.fps,
    createdAt: Date.now(),
  }
  projects.value = [p, ...projects.value]
  currentProject.value = p
  showProjects.value = false
  persist()
  return p
}

/** Live-edit the open project (viewport aspect/resolution/fps). Persists. */
export function updateProject(patch: Partial<Pick<Project, 'title' | 'width' | 'height' | 'fps'>>) {
  const p = currentProject.value
  if (!p) return
  const next: Project = { ...p, ...patch }
  currentProject.value = next
  projects.value = projects.value.map((x) => (x.id === p.id ? next : x))
  persist()
}

/** Add a project that came from somewhere else (an opened bundle) and switch to
 *  it. Its data must already be on disk — becoming current triggers the load. */
export function importProject(p: Project) {
  projects.value = [p, ...projects.value.filter((x) => x.id !== p.id)]
  persist()
  currentProject.value = p
  showProjects.value = false
}

export function openProject(id: string) {
  const p = projects.value.find((x) => x.id === id)
  if (p) {
    currentProject.value = p
    showProjects.value = false
  }
}

export function deleteProject(id: string) {
  projects.value = projects.value.filter((x) => x.id !== id)
  persist()
  void store().remove(projectKey(id)) // drop its assets/timeline
  try {
    localStorage.removeItem(`viewport.project.${id}`) // legacy copy, if any
  } catch {
    /* ignore */
  }
  // if the open project was deleted, fall back to the project chooser
  if (currentProject.value?.id === id) currentProject.value = null
}

// --- aspect ratios + resolution presets (defined in landscape) ---
export interface Ratio {
  id: string
  w: number
  h: number
}
export const RATIOS: Ratio[] = [
  { id: '16:9', w: 16, h: 9 },
  { id: '1:1', w: 1, h: 1 },
  { id: '4:3', w: 4, h: 3 },
]

export interface Preset {
  label: string
  w: number
  h: number
}
export const PRESETS: Record<string, Preset[]> = {
  '16:9': [
    { label: '720p', w: 1280, h: 720 },
    { label: '1080p', w: 1920, h: 1080 },
    { label: '1440p', w: 2560, h: 1440 },
    { label: '4K', w: 3840, h: 2160 },
  ],
  '1:1': [
    { label: '720', w: 720, h: 720 },
    { label: '1080', w: 1080, h: 1080 },
    { label: '1440', w: 1440, h: 1440 },
    { label: '2160', w: 2160, h: 2160 },
  ],
  '4:3': [
    { label: '480p', w: 640, h: 480 },
    { label: '768p', w: 1024, h: 768 },
    { label: '1080p', w: 1440, h: 1080 },
    { label: '1536p', w: 2048, h: 1536 },
  ],
}

export const FPS_PRESETS = [24, 25, 30, 50, 60]
