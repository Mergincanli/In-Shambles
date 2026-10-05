/**
 * Entity numbers are i16 on the wire (docs/03 §6 `groundEntity`). Real entities use 0 and up; the
 * two ends of the range are reserved.
 */

/** No entity: an airborne player's ground, a trace that hit nothing. */
export const ENTITY_NONE = -1;

/** The static world (brushes). The top of the i16 range, so it never collides with a real slot. */
export const ENTITY_WORLD = 32767;
