/** Cvar flags (docs/06 §6). Combine with `|`. */
export const CvarFlag = {
  NONE: 0,
  /** Persisted client setting. */
  ARCHIVE: 1 << 0,
  /** Server-owned, sent to clients, used by prediction. */
  REPLICATED: 1 << 1,
  /** Dev only: changeable only when cheats are allowed. */
  CHEAT: 1 << 2,
  /** Server-only. */
  SERVER: 1 << 3,
  /** New values apply on map restart (`applyLatched`). */
  LATCH: 1 << 4,
} as const;
