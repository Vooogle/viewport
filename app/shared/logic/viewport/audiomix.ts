// Preview audio mixer. Plays every audible object (audio-only, or a video whose
// audio isn't detached) synced to the playhead, routed through per-object gain
// (Volume) + stereo pan (Pan), both sampled live so keyframes are heard. Uses a
// standalone <audio> per voice (the scene <video> stays muted). Pitch isn't
// applied yet — needs a time-stretch; volume/pan are enough for the flow.
import { effect } from '@preact/signals'
import { timeline, playhead, playing, isSilent, mediaStalled } from '../timeline/timeline'
import { sampleClip } from '../timeline/anim'
import { assets } from '../tools/files/assets'
import { mediaExclusive } from '../media/exclusive'
import { masterBus } from '../audio/master'
import { previewAudio } from '../render/proxies'

interface Voice {
  el: HTMLAudioElement
  src: MediaElementAudioSourceNode
  gain: GainNode
  pan: StereoPannerNode
  url: string
}

/** How far ahead of its clip a voice is created and parked on its in-point. */
const PREROLL = 1.5
/** How many silent voices to keep parked before handing their decoders back. */
const IDLE_KEEP = 8

let ctx: AudioContext | null = null
/** limiter every voice feeds; rebuilt with the context */
let master: AudioNode | null = null
const voices = new Map<string, Voice>()

function makeVoice(clipId: string, url: string): Voice {
  const el = new Audio(url)
  el.preload = 'auto'
  el.crossOrigin = 'anonymous'
  // A source the webview can't demux fails here and nowhere else: the object
  // keeps its picture (which comes from the proxy) and simply makes no sound.
  // Said out loud, so it looks like a file problem rather than a mixer bug.
  el.onerror = () => console.warn('[audio] no playable audio in', url, el.error?.message ?? '')
  const src = ctx!.createMediaElementSource(el)
  const gain = ctx!.createGain()
  const pan = ctx!.createStereoPanner()
  src.connect(gain).connect(pan).connect(master!)
  const v: Voice = { el, src, gain, pan, url }
  voices.set(clipId, v)
  return v
}
function dropVoice(clipId: string) {
  const v = voices.get(clipId)
  if (!v) return
  try {
    v.el.pause()
    v.src.disconnect()
    v.gain.disconnect()
    v.pan.disconnect()
  } catch {
    /* already torn down */
  }
  voices.delete(clipId)
}

function sync() {
  const t = playhead.value
  const isPlaying = playing.value
  // A buffering video holds the transport: the playhead stops while the
  // decoders catch up. The voices used to keep running through that, so every
  // stall put their clocks ahead of the playhead by however long it lasted —
  // and the moment it cleared, the drift was past tolerance and they were
  // yanked back. That seek is the audio "cutting out" mid-playback. Held with
  // the transport instead, they come back in sync and nothing is seeked.
  const rolling = isPlaying && !mediaStalled.value
  // An export owns the media pipeline. Every voice is an <audio> element with
  // its own decoder in it, and the export mixes its own audio from scratch —
  // these are pure cost while it runs. Dropping them (rather than pausing)
  // hands the decoders back; they're rebuilt on the next sync afterwards.
  if (mediaExclusive.value) {
    for (const id of [...voices.keys()]) dropVoice(id)
    return
  }
  if (!ctx) {
    // create lazily; only meaningful once playback starts (needs a user gesture)
    if (!isPlaying) return
    ctx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    master = masterBus(ctx)
  }
  if (isPlaying && ctx.state === 'suspended') ctx.resume()

  const active = new Set<string>()
  /** voice id → seconds between the playhead and its clip, for the idle ones */
  const away = new Map<string, number>()
  for (const track of timeline.value.tracks) {
    for (const c of track.clips) {
      if (isSilent(c)) continue // turned all the way down, and not animated
      const inRange = t >= c.start && t < c.start + c.duration
      // Get the element on its feet BEFORE the playhead reaches it. A fresh
      // <audio> has no metadata, and currentTime cannot be set until it does —
      // so one created at the moment its clip starts either begins late or, if
      // started anyway, plays the file from the beginning instead of the clip's
      // in-point. Which is why the object at 0 sounded right and later ones did
      // not: at 0 the in-point IS the start of the file.
      const soon = isPlaying && t >= c.start - PREROLL && t < c.start
      if (!inRange && !soon) {
        if (voices.has(c.id)) away.set(c.id, t < c.start ? c.start - t : t - (c.start + c.duration))
        continue
      }
      const a = assets.value.find((x) => x.id === c.assetId)
      if (!a || a.missing || a.kind === 'image') continue
      active.add(c.id)
      const local = Math.max(0, t - c.start)
      const want = (c.in ?? 0) + local
      // The audio stand-in when there is one, the original otherwise. Same
      // timebase either way — it's a straight re-encode of the whole track —
      // so nothing else here changes. It's what the object sounds like at all
      // for media the webview can't demux, and it turns a seek inside a
      // multi-GB video into a seek inside a few MB of AAC.
      const url = previewAudio.value[c.assetId ?? ''] ?? a.url
      let v = voices.get(c.id)
      if (v && v.url !== url) {
        dropVoice(c.id)
        v = undefined
      }
      if (!v) v = makeVoice(c.id, url)
      if (!inRange) {
        // pre-roll: silent, parked on its in-point, ready to be played
        if (!v.el.paused) v.el.pause()
        if (v.el.readyState >= 1 && !v.el.seeking && Math.abs(v.el.currentTime - want) > 0.05)
          v.el.currentTime = want
        continue
      }
      // Ramped, not assigned. A direct write to an AudioParam is a step change
      // at whatever point of the waveform the frame lands on, and this runs
      // once per animation frame — so an animated volume was sixty steps a
      // second, heard as crackle. The time constant is short enough to still
      // land on the keyframe.
      const now = ctx.currentTime
      v.gain.gain.setTargetAtTime(Math.max(0, sampleClip(c, 'volume', local)), now, 0.01)
      v.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, sampleClip(c, 'pan', local))), now, 0.01)
      // pitch: placeholder via playbackRate (preservesPitch off actually shifts
      // pitch, but also changes tempo → drifts; real fix is a time-stretch).
      const semis = sampleClip(c, 'pitch', local)
      const rate = Math.pow(2, semis / 12)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(v.el as any).preservesPitch = semis === 0
      v.el.playbackRate = rate
      // looser resync when pitched, since the rate makes the clock run off
      const resync = Math.abs(rate - 1) > 1e-3 ? 0.6 : 0.3
      if (rolling) {
        // Until metadata lands, currentTime writes are dropped — starting it
        // now would play from the top of the file. The playhead ticks, so the
        // next sync starts it as soon as it can be placed correctly.
        if (v.el.readyState < 1) {
          /* not yet */
        } else if (v.el.paused) {
          // only when it isn't already there: coming back from a stall, the
          // voice is parked exactly where it should resume, and seeking to the
          // position it already holds costs a decoder re-prime for nothing
          if (!v.el.seeking && Math.abs(v.el.currentTime - want) > 0.05) v.el.currentTime = want
          v.el.play().catch(() => {})
          // a seek in flight would be restarted by another assignment, leaving
          // the decoder permanently catching up
        } else if (!v.el.seeking && Math.abs(v.el.currentTime - want) > resync) {
          v.el.currentTime = want // re-sync drift
        }
      } else if (!v.el.paused) {
        v.el.pause()
      }
    }
  }
  // silence voices no longer active
  for (const [id, v] of voices) if (!active.has(id) && !v.el.paused) v.el.pause()

  // An idle voice is not free — it's an <audio> element with a decoder in it,
  // and they were kept for good: every object ever reached still held one. Past
  // a working set the media pipeline starves, and what starves is the elements
  // that ARE playing, heard as sound dropping out partway through a long
  // timeline. Voices whose object is gone from the timeline go straight away;
  // the rest are trimmed farthest-from-the-playhead first, so scrubbing around
  // one spot doesn't churn.
  const idle = [...voices.keys()].filter((id) => !active.has(id))
  for (const id of idle) if (!away.has(id)) dropVoice(id)
  let over = idle.filter((id) => away.has(id)).length - IDLE_KEEP
  if (over > 0)
    for (const [id] of [...away].sort((a, b) => b[1] - a[1])) {
      if (over <= 0) break
      if (active.has(id)) continue
      dropVoice(id)
      over--
    }
}

let installed = false
/** Start the mixer (idempotent). Reacts to playhead / play state / edits. */
export function installAudioMixer() {
  if (installed) return
  installed = true
  effect(sync)
}
