// In-place updates from GitHub Releases (vooogle/viewport).
//
// Tauri's updater fetches `latest.json` from the newest published release,
// verifies its minisign signature against the pubkey in tauri.conf.json, then
// downloads and installs the platform bundle. Nothing is reinstalled by hand.
//
// Only the formats that can replace themselves are updatable: NSIS on Windows,
// AppImage on Linux, .app on macOS. A .deb/.rpm install is owned by the system
// package manager, so those users update through it instead.
import { askConfirm } from '@shared/logic/ui/confirm'
import { startTask } from '@shared/logic/ui/progress'
import { prefs } from '@shared/logic/prefs/preferences'

interface UpdateHandle {
  version: string
  body?: string
  downloadAndInstall: (cb?: (p: DownloadEvent) => void) => Promise<void>
}
type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

interface UpdaterGlobal {
  updater?: { check: () => Promise<UpdateHandle | null> }
  process?: { relaunch: () => Promise<void> }
}
function api(): UpdaterGlobal | null {
  return typeof window !== 'undefined'
    ? ((window as unknown as { __TAURI__?: UpdaterGlobal }).__TAURI__ ?? null)
    : null
}

/** Is there a newer release? Returns null when up to date or unreachable. */
export async function checkForUpdate(): Promise<UpdateHandle | null> {
  const u = api()?.updater
  if (!u) return null
  try {
    return await u.check()
  } catch {
    // offline, rate-limited, or no release published yet — never worth a dialog
    return null
  }
}

/** Download + install, then relaunch into the new version. */
export async function installUpdate(update: UpdateHandle) {
  const task = startTask('Update', `Downloading ${update.version}…`)
  let total = 0
  let got = 0
  try {
    await update.downloadAndInstall((p) => {
      if (p.event === 'Started') total = p.data.contentLength ?? 0
      else if (p.event === 'Progress') {
        got += p.data.chunkLength
        const mb = (n: number) => (n / 1048576).toFixed(0)
        task.step(
          total ? `Downloading ${mb(got)} / ${mb(total)} MB…` : `Downloading ${mb(got)} MB…`,
          total ? got / total : null,
        )
      } else task.step('Installing…', 1)
    })
    task.done()
    if (await askConfirm(`Viewport ${update.version} is ready. Restart now?`, 'Restart')) {
      await api()?.process?.relaunch()
    }
  } catch (e) {
    task.step(`Update failed: ${(e as Error).message}`, null)
    task.done()
    await askConfirm(
      `Could not install the update: ${(e as Error).message}\n\n` +
        'You can download it manually from the Releases page.',
      'OK',
    )
  }
}

/**
 * Startup check. Silent when there's nothing new, and skipped entirely when the
 * user has turned off update requests in Preferences — that pref exists to stop
 * the app phoning home, so it must gate the network call itself, not just the UI.
 */
export async function checkForUpdateOnStartup() {
  if (!prefs.value.updateRequests) return
  const update = await checkForUpdate()
  if (!update) return
  const go = await askConfirm(
    `Viewport ${update.version} is available.\n\n${(update.body ?? '').slice(0, 400)}`,
    'Update',
  )
  if (go) await installUpdate(update)
}
