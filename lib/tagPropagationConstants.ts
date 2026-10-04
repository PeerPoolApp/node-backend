/**
 * Tag affinity propagation knobs (job + profile visibility).
 * Tune here; mirror PROFILE_TAG_THRESHOLD on the Vue side for client display.
 */

/** Score ≥ this appears on profile / friend / user rows. */
export const PROFILE_TAG_THRESHOLD = 40

/** Points added per event hashtag when an ended joined event is applied. */
export const EVENT_TAG_BUMP = 12

/**
 * Points added per community hashtag (lesser than event).
 * Only when event visibility is community or channel.
 */
export const COMMUNITY_TAG_BUMP = 4

/** Points subtracted from tags not bumped in this apply (floor 0). */
export const UNUSED_TAG_DECAY = 2

/** Max visible tags on profile / friend row DTOs. */
export const PROFILE_TAG_DISPLAY_CAP = 8

/** Batch size for ended events per job run. */
export const TAG_PROPAGATION_BATCH = 50
