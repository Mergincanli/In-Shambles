/**
 * Protocol v1 constants (docs/05 §3.2–§3.6, D-026). Any change to a message layout bumps
 * PROTOCOL_VERSION and updates docs/05 §3.6 in the same change (.claude/rules/netcode.md).
 */

/** u16 on the wire, in HELLO and WELCOME. */
export const PROTOCOL_VERSION = 1;

/** The u8 type byte that leads every message. 0 is never a message, so a zeroed buffer is bad. */
export const MSG_HELLO = 1;
export const MSG_WELCOME = 2;
export const MSG_READY = 3;
export const MSG_INPUT = 4;
export const MSG_SNAPSHOT = 5;
export const MSG_PING = 6;
export const MSG_PONG = 7;
export const MSG_CVARS = 8;
export const MSG_CMD = 9;
export const MSG_PRINT = 10;
export const MSG_KICK = 11;
export const MSG_TYPE_MAX = MSG_KICK;

/**
 * Largest unreliable packet (INPUT, SNAPSHOT, PING, PONG): datagram-safe under a 1280 B IPv6 MTU
 * with room for headers, and above the 1100 B snapshot budget (docs/05 §4.3).
 */
export const MAX_UNRELIABLE_BYTES = 1200;

/** Largest reliable message (WELCOME and CVARS carry the cvar block; CMD, PRINT, KICK text). */
export const MAX_RELIABLE_BYTES = 16384;

/** Short ASCII strings (build hash, map name, cvar names): a u6 length, 7 bits per char. */
export const SHORT_TEXT_MAX = 63;

/** Console text (CMD, PRINT, KICK): a u10 length, 8 bits per char (Latin-1). */
export const TEXT_MAX = 1023;

/** String cvar values in the replicated block: a u8 length, 7-bit ASCII. */
export const CVAR_STRING_MAX = 255;

/** INPUT carries the newest 1–4 cmds (docs/05 §3.4: N = 4 for redundancy). */
export const INPUT_MAX_CMDS = 4;

/** Older cmds in an INPUT are a u8 tick offset back from the newest. */
export const INPUT_TICK_BACK_MAX = 255;

/** SNAPSHOT flag bits. */
export const SNAP_FLAG_STARVED = 1 << 0;
export const SNAP_FLAG_TELEPORT = 1 << 1;
export const SNAP_FLAG_MASK = SNAP_FLAG_STARVED | SNAP_FLAG_TELEPORT;

/** PRINT levels (u2; 3 is not used and rejected). */
export const PRINT_INFO = 0;
export const PRINT_WARN = 1;
export const PRINT_ERROR = 2;
