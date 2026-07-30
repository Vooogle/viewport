// Platform capability registry. Shared/UI code reads this; each platform entry
// (app/web, app/tauri, app/capacitor) fills in what it supports at startup.
// Keeps platform-specific code (native fs, ffmpeg, window chrome) out of shared.
import { signal } from '@preact/signals'
import type { ComponentType } from 'preact'

export interface WindowControls {
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
}

export interface Platform {
  name: 'web' | 'tauri' | 'capacitor'
  /** desktop shells can reload media by path + render/export natively */
  isDesktop: boolean
  /** present → we draw our own titlebar (frameless window) */
  windowControls?: WindowControls
  /** present → the Export button renders a video; else the project file is saved */
  exportVideo?: () => Promise<void>
  /** present → the project can be bundled with its media into one portable file
   *  (needs a filesystem to stream gigabytes; the browser export stays JSON) */
  exportBundle?: () => Promise<void>
  /** present → a project bundle on disk can be opened as a new project */
  openBundle?: () => Promise<void>
  /** map an absolute file path to a webview-loadable URL (desktop asset protocol) */
  srcForPath?: (path: string) => string
  /** native file picker → absolute paths (so projects can reload media) */
  pickMedia?: () => Promise<string[]>
  /** Build (or fetch from cache) a small all-intra stand-in for a source, used
   *  to keep the preview real-time on heavy timelines. Needs a filesystem and
   *  ffmpeg, so it's desktop-only; without it the preview uses the originals. */
  proxyFor?: (path: string, width: number, height: number) => Promise<{ url: string; fps: number } | null>
  /** Build (or fetch from cache) a small audio-only stand-in, for the preview
   *  mixer. Same deal as `proxyFor`: without it the mixer plays the original,
   *  which the webview cannot always decode and is slow to seek in. */
  audioProxyFor?: (path: string) => Promise<string | null>
  /** platform-owned dialogs mounted at the app root (e.g. the export settings) */
  overlays?: ComponentType
}

/** default: plain web (sandboxed browser). */
export const platform = signal<Platform>({ name: 'web', isDesktop: false })

export function setPlatform(p: Platform) {
  platform.value = p
}
