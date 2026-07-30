// Desktop (Tauri) entry. Same shared App as the web build, plus the desktop
// platform registration (native paths, window chrome, ffmpeg export). The Tauri
// webview is Chromium/WebView2, so the web media ops (WebCodecs/WebAudio) apply.
import { render } from 'preact'
import { App, loadUserData } from '@shared/logic/app'
import '@shared/logic/api' // exposes window.viewport for runtime plugins
import { installWebPlatform } from '../web/logic/platform'
import { installTauriPlatform } from './logic/install'
import { checkForUpdateOnStartup } from './logic/update'
import { installAudioMixer } from '@shared/logic/viewport/audiomix'
import '../web/styles.css'

installWebPlatform() // media ops (WebCodecs/WebAudio) — available in the webview
installTauriPlatform() // desktop: paths, window controls, ffmpeg export
installAudioMixer()
// ~/.viewport is only wired up by installTauriPlatform above
void loadUserData()
render(<App />, document.getElementById('app')!)
// after mount, so the check never delays first paint
void checkForUpdateOnStartup()
