/**
 * The renderer-process entry, `@framers/sql-storage-adapter/electron/renderer`: the adapter a window uses over IPC,
 * and nothing from the main process (better-sqlite3, the window manager, recovery, migration).
 *
 * @module
 */
export {
  ElectronRendererAdapter,
  createElectronRendererAdapter,
  isElectronRenderer,
  isPreloadApiAvailable,
  type ElectronRendererAdapterOptions,
} from './electronRendererAdapter';
export type { DbChangeEvent, SyncStatus } from './ipc/types';
