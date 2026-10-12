/**
 * Entity numbers are i16 on the wire (docs/03 §6 `groundEntity`). Real entities use 0 and up; the
 * two ends of the range are reserved.
 */

/** No entity: an airborne player's ground, a trace that hit nothing. */
export const ENTITY_NONE = -1;

/** The static world (brushes). The top of the i16 range, so it never collides with a real slot. */
export const ENTITY_WORLD = 32767;

/**
 * Player slots per match (D-034, design: "Cap 64, default 32"): client ids, and the entity ids of
 * players in snapshots, are 0..MATCH_MAX_CLIENTS − 1. WELCOME's u8 and the snapshot's 7-bit entity
 * count hold them. How many a match admits is `sv_maxClients` (default 32).
 */
export const MATCH_MAX_CLIENTS = 64;

/** Teams (D-034): auto-balanced and cosmetic until M7. 3 is never a team (refused on the wire). */
export const TEAM_NONE = 0;
export const TEAM_1 = 1;
export const TEAM_2 = 2;

/**
 * The movement flags a remote player's entity carries (M3 design §2.1): every `PMF_*` bit but
 * PMF_JUMP_HELD (bit 5) and PMF_CROUCH_PRESSED_IN_AIR (bit 6), which only the owner's prediction
 * reads. Written as a literal because playerState.ts imports this module (a test pins it to the
 * PMF_* constants).
 */
export const ENTITY_FLAG_MASK = 0x39f;
