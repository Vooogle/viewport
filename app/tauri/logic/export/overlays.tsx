// Desktop-owned dialogs, mounted at the app root via platform.overlays.
import { ExportDialog } from './exportdialog'
import { ExportProgress } from './exportprogress'

export function DesktopOverlays() {
  return (
    <>
      <ExportDialog />
      <ExportProgress />
    </>
  )
}
