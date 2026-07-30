// Where user data lives.
//
// Desktop writes plain files under ~/.viewport/ so projects can be found, backed
// up and hand-edited. The browser has no filesystem, so it keeps the same keys
// in localStorage — which is also why everything here stays small JSON: media
// never goes through this, only metadata and paths.
//
//   settings.json          preferences
//   projects/<id>.json     one file per project
//
// The API is async because the desktop backend crosses an IPC boundary; the web
// backend just resolves immediately.

export interface Store {
  read(key: string): Promise<string | null>
  write(key: string, data: string): Promise<void>
  remove(key: string): Promise<void>
  /** file names (no extension) directly inside a folder key */
  list(dir: string): Promise<string[]>
  /** human-readable location, for showing the user where their files are */
  describe(): Promise<string>
}

const LS_PREFIX = 'viewport.store.'

/** Browser fallback: same key space, backed by localStorage. */
export const webStore: Store = {
  async read(key) {
    try {
      return localStorage.getItem(LS_PREFIX + key)
    } catch {
      return null
    }
  },
  async write(key, data) {
    try {
      localStorage.setItem(LS_PREFIX + key, data)
    } catch {
      /* storage full or disabled — the edit stays in memory */
    }
  },
  async remove(key) {
    try {
      localStorage.removeItem(LS_PREFIX + key)
    } catch {
      /* ignore */
    }
  },
  async list(dir) {
    const out: string[] = []
    const prefix = LS_PREFIX + (dir.endsWith('/') ? dir : dir + '/')
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k?.startsWith(prefix)) out.push(k.slice(prefix.length))
      }
    } catch {
      /* ignore */
    }
    return out
  },
  async describe() {
    return 'browser storage'
  },
}

let impl: Store = webStore
export function setStore(s: Store) {
  impl = s
}
export function store(): Store {
  return impl
}

// --- convenience helpers ---

export async function readJson<T>(key: string, fallback: T): Promise<T> {
  const raw = await impl.read(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback // corrupt file shouldn't wipe the app out
  }
}

export function writeJson(key: string, value: unknown): Promise<void> {
  return impl.write(key, JSON.stringify(value))
}

export const SETTINGS_KEY = 'settings.json'
export const projectKey = (id: string) => `projects/${id}.json`
