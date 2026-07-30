// Desktop store: plain files under ~/.viewport/ (see src-tauri/src/store.rs).
import type { Store } from '@shared/logic/storage/store'
import { invoke } from './bridge'

export const tauriStore: Store = {
  read: (key) => invoke<string | null>('store_read', { key }),
  write: (key, data) => invoke<void>('store_write', { key, data }),
  remove: (key) => invoke<void>('store_remove', { key }),
  list: (dir) => invoke<string[]>('store_list', { dir }),
  describe: () => invoke<string>('store_dir'),
}
