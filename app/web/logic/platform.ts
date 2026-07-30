// Registers the web platform's media operations into the shared MediaOps slot.
// Imported once at startup (main.tsx) before the app mounts.
import { setMediaOps } from '@shared/logic/media/media'
import { detachAudioWeb } from './timeline/audio_detach'

export function installWebPlatform() {
  setMediaOps({
    detachAudio: detachAudioWeb,
  })
}
