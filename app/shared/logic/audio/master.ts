// The master bus, shared by the preview mixer and the export mixdown.
//
// Objects were connected straight to the destination, which sums them and then
// clips anything past full scale — heard as crackle. That is not a rare corner:
// modern sources are mastered right up against 0 dBFS (the footage this was
// found on peaks at 1.055 on its own), so a single loud object can clip, and two
// overlapping ones certainly will.
//
// A limiter on the master holds the sum inside range instead. It sits in one
// place because the preview and the export have to agree — an export that
// crackles where the preview didn't, or the reverse, is worse than either.
//
// Deliberately gentle: this is protection, not a sound. Under the threshold it
// does nothing at all, so ordinary material passes through untouched.

/**
 * Build the master chain for a context and return the node to connect voices to.
 *
 * Works for both an AudioContext and an OfflineAudioContext — the export renders
 * through exactly the same graph the preview plays through.
 */
export function masterBus(ctx: BaseAudioContext): AudioNode {
  const limiter = ctx.createDynamicsCompressor()
  // -2 dBFS: enough headroom to catch inter-sample peaks, low enough that
  // nothing normal ever reaches it
  limiter.threshold.value = -2
  limiter.knee.value = 0 // hard knee — a limiter, not a compressor
  limiter.ratio.value = 20
  limiter.attack.value = 0.003 // fast enough to catch a transient
  limiter.release.value = 0.25
  limiter.connect(ctx.destination)
  return limiter
}
