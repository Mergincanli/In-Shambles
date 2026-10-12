/**
 * Protocol constants (docs/05 §3.2–§3.6; v1 D-026, v2 D-033, v3 D-050). Any change to a message
 * layout bumps PROTOCOL_VERSION and updates docs/05 §3.6 in the same change
 * (.claude/rules/netcode.md).
 */

/**
 * u16 on the wire, in HELLO and WELCOME. v2 (D-033) changed SNAPSHOT: the player list and the
 * teleport counter. Its delta forms (D-038), deferred list (D-046) and the EVENTS message (D-043)
 * joined within v2: nothing shipped between those increments. v3 (D-050) gives the high half of
 * SNAPSHOT's flags byte to the receiver's starve counter; every other layout is v2's.
 */
export const PROTOCOL_VERSION = 3;

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
/** S→C reliable: roster changes and server tick times (D-043; `events.ts`). */
export const MSG_EVENTS = 12;
export const MSG_TYPE_MAX = MSG_EVENTS;

/** `MSG_CHANNEL` values: which channel a message type travels on (docs/05 §3.3). */
export const CHANNEL_UNKNOWN = -1;
export const CHANNEL_UNRELIABLE = 0;
export const CHANNEL_RELIABLE = 1;

/**
 * Message type → channel, for every u8 type byte (`CHANNEL_UNKNOWN` for types that are no
 * message). A WebSocket carries both channels on one socket with no extra bytes (D-030), so its
 * receiver learns the channel from the type byte; a receiver still strikes a message on the wrong
 * channel, so this table only labels what arrived. Read-only by convention.
 */
export const MSG_CHANNEL: Int8Array = new Int8Array(256).fill(CHANNEL_UNKNOWN);
for (const type of [
  MSG_HELLO,
  MSG_WELCOME,
  MSG_READY,
  MSG_CVARS,
  MSG_CMD,
  MSG_PRINT,
  MSG_KICK,
  MSG_EVENTS,
]) {
  MSG_CHANNEL[type] = CHANNEL_RELIABLE;
}
for (const type of [MSG_INPUT, MSG_SNAPSHOT, MSG_PING, MSG_PONG]) {
  MSG_CHANNEL[type] = CHANNEL_UNRELIABLE;
}

/**
 * Largest unreliable packet (INPUT, SNAPSHOT, PING, PONG): datagram-safe under a 1280 B IPv6 MTU
 * with room for headers, and above the 1100 B snapshot budget (docs/05 §4.3).
 */
export const MAX_UNRELIABLE_BYTES = 1200;

/** Largest reliable message (WELCOME and CVARS carry the cvar block; CMD, PRINT, KICK text). */
export const MAX_RELIABLE_BYTES = 16384;

/**
 * Largest message a client may send (D-030; design value): the WebSocket server's frame cap, above
 * the largest client message (a CMD of TEXT_MAX chars, 1026 B), so a bigger frame is an attack.
 */
export const MAX_CLIENT_MESSAGE_BYTES = 2048;

/**
 * Bytes a message of `payload` bytes costs on a WebSocket, framing included (D-036 bandwidth
 * accounting; FACT, RFC 6455 §5.2): a 2 B header, plus 2 B of extended length from 126 B and 8 B
 * from 65536 B, plus the 4 B mask on every frame a client sends (`masked`). One frame per message:
 * nothing here fragments.
 */
export function wsWireBytes(payload: number, masked: boolean): number {
  const header = payload < 126 ? 2 : payload < 65536 ? 4 : 10;
  return payload + header + (masked ? 4 : 0);
}

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

/**
 * SNAPSHOT flag bits (D-033): the low half of the flags byte (`SNAP_FLAG_BITS`); the high half is
 * the starve counter (D-050). Bit 1 was v1's teleport flag; the header's teleport counter replaced
 * it (D-035), and it must be 0.
 */
/**
 * The server repeated a cmd of this client's that had not arrived, at this snapshot's tick
 * (docs/05 §8.1). The starve counter counts every such tick, so a lost snapshot can't hide one.
 */
export const SNAP_FLAG_STARVED = 1 << 0;
/** Every player, no local block: demo files only (D-044); a live connection drops it. */
export const SNAP_FLAG_SPECTATOR = 1 << 2;
/**
 * A deferred-id list follows the entities (D-046): players the byte-budget scheduler left out of
 * this snapshot. Never with SPECTATOR. The encoder sets it exactly when it lists an id.
 */
export const SNAP_FLAG_DEFERRED = 1 << 3;
/** The flags a snapshot may carry. */
export const SNAP_FLAG_MASK = SNAP_FLAG_STARVED | SNAP_FLAG_SPECTATOR | SNAP_FLAG_DEFERRED;
/** The flags' width on the wire: bits 0–3 of the flags byte. */
export const SNAP_FLAG_BITS = 4;

/**
 * The starve counter (D-050): bits 4–7 of SNAPSHOT's flags byte, after the flag bits. The server
 * steps a client's counter on every tick it starves that client (wrapping at 16) and writes it
 * into every snapshot it sends that client, as D-035's teleport counter does for spawns, so a lost
 * snapshot can't hide a starve: the client counts (new − last seen) & SNAP_STARVE_SEQ_MASK starves
 * since the snapshot before. 0 in a spectator snapshot, which has no receiver.
 */
export const SNAP_STARVE_SEQ_BITS = 4;
export const SNAP_STARVE_SEQ_MASK = (1 << SNAP_STARVE_SEQ_BITS) - 1;

/** Snapshots each end keeps, and so the oldest baseline a delta may use (docs/05 §4.3). */
export const SNAPSHOT_HISTORY = 64;

/** A live snapshot's size cap (docs/05 §4.3, docs/10 §4.2): datagram-safe. */
export const MAX_SNAPSHOT_BYTES = 1100;
export const SNAP_BUDGET_BITS = MAX_SNAPSHOT_BYTES * 8;

/** A spectator snapshot's cap (design): up to 64 players, in demo files only, never on a socket. */
export const MAX_SPECTATOR_SNAPSHOT_BYTES = 2048;

/**
 * Delta class widths (M3 design §2.1, design values; D-038): a class-coded axis is class 0 (same
 * as the baseline), 1 (a signed difference of the D1 width), 2 (of the D2 width) or 3 (the
 * absolute value at the full width: origin i21, local velocity i20, entity velocity i16).
 */
export const SNAP_ORIGIN_D1 = 7;
export const SNAP_ORIGIN_D2 = 13;
export const SNAP_LOCAL_VELOCITY_D1 = 7;
export const SNAP_LOCAL_VELOCITY_D2 = 13;
export const SNAP_ENTITY_VELOCITY_D1 = 6;
export const SNAP_ENTITY_VELOCITY_D2 = 11;

/** PRINT levels (u2; 3 is not used and rejected). */
export const PRINT_INFO = 0;
export const PRINT_WARN = 1;
export const PRINT_ERROR = 2;

/** EVENTS kinds (4 bits; D-043, `events.ts`): 0 and 4–15 are refused, reserved for M6/M7. */
export const EVK_PLAYER_JOIN = 1;
export const EVK_PLAYER_LEAVE = 2;
export const EVK_SERVER_STATS = 3;
/** The highest kind this protocol carries. */
export const EVK_MAX = EVK_SERVER_STATS;

/** PLAYER_LEAVE reasons (2 bits; 3 is refused). */
export const EV_LEAVE_LEFT = 0;
export const EV_LEAVE_TIMED_OUT = 1;
export const EV_LEAVE_KICKED = 2;
export const EV_LEAVE_REASON_MAX = EV_LEAVE_KICKED;
