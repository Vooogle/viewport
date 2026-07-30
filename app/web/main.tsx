import { render } from 'preact'
import { App, loadUserData } from '@shared/logic/app'
import '@shared/logic/api' // exposes window.viewport for runtime plugins
import { installWebPlatform } from './logic/platform'
import { installZoomLock } from '@shared/logic/prefs/preferences'
import { installAudioMixer } from '@shared/logic/viewport/audiomix'
import './styles.css'

installWebPlatform() // register web media ops (WebAudio/WebCodecs) before mount
installZoomLock() // block browser zoom when the Lock zoom pref is on
installAudioMixer() // preview audio playback (volume/pan synced to playhead)
// settings + projects come from the registered store, so load after install
void loadUserData()
render(<App />, document.getElementById('app')!)
