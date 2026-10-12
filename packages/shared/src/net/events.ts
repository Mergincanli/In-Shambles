import { MATCH_MAX_CLIENTS, TEAM_2 } from "../sim/entity";
import type { BitReader, BitWriter } from "./bitstream";
import {
  EV_LEAVE_REASON_MAX,
  EVK_MAX,
  EVK_PLAYER_JOIN,
  EVK_PLAYER_LEAVE,
  EVK_SERVER_STATS,
  MSG_EVENTS,
} from "./protocol";

/**
 * EVENTS (S→C, reliable; docs/05 §3.6, §10, D-043): the server's roster and its tick times, as a
 * list of small records. `count` 6 bits (1–63), then per event `kind` 4 bits and its payload:
 *
 * - PLAYER_JOIN: clientId 6, team 2 (0–2);
 * - PLAYER_LEAVE: clientId 6, reason 2 (0 left, 1 timed out, 2 kicked; 3 is refused);
 * - SERVER_STATS: tickP50Us 16, tickP99Us 16, tickMaxUs 16 (each saturated at 65535 by the
 *   server), players 7 (0–64).
 *
 * Kinds 0 and 4–15 are refused: reserved for M6's combat feed and M7's round state. A tick with
 * more than 63 events for one client sends several messages. Encode and decode allocate nothing,
 * refused packets included: the records are pooled and every field is a small integer. The kinds
 * (`EVK_*`) and leave reasons (`EV_LEAVE_*`) live in `protocol.ts` with the other message ids.
 */

/** Events one EVENTS message carries at most (the 6-bit count). */
export const EVENTS_MAX_PER_MSG = 63;
export const EVENTS_COUNT_BITS = 6;
export const EVENT_KIND_BITS = 4;
/** Client ids (0–63, `MATCH_MAX_CLIENTS` slots) and the stats' player count (0–64). */
export const EVENT_CLIENT_BITS = 6;
export const EVENT_PLAYERS_BITS = 7;
/** A stats time's width; the server saturates a longer tick at the largest value. */
export const EVENT_TICK_US_BITS = 16;
export const EVENT_TICK_US_MAX = 0xffff;

/** Bits of one event of `kind`, kind field included (0 for a kind the protocol refuses). */
export function eventBits(kind: number): number {
  if (kind === EVK_PLAYER_JOIN || kind === EVK_PLAYER_LEAVE) {
    return EVENT_KIND_BITS + EVENT_CLIENT_BITS + 2;
  }
  if (kind === EVK_SERVER_STATS) {
    return EVENT_KIND_BITS + 3 * EVENT_TICK_US_BITS + EVENT_PLAYERS_BITS;
  }
  return 0;
}

/**
 * One event: `kind` and the fields its payload has (the others stay 0). JOIN: `clientId`, `team`.
 * LEAVE: `clientId`, `reason`. SERVER_STATS: the three tick times (µs) and `players`.
 */
export class EventRecord {
  kind = 0;
  clientId = 0;
  team = 0;
  reason = 0;
  tickP50Us = 0;
  tickP99Us = 0;
  tickMaxUs = 0;
  players = 0;

  clear(): void {
    this.kind = 0;
    this.clientId = 0;
    this.team = 0;
    this.reason = 0;
    this.tickP50Us = 0;
    this.tickP99Us = 0;
    this.tickMaxUs = 0;
    this.players = 0;
  }
}

/** An EVENTS message: `count` records of the pooled `events` in use. */
export class EventsMsg {
  count = 0;
  readonly events: readonly EventRecord[] = Array.from(
    { length: EVENTS_MAX_PER_MSG },
    () => new EventRecord(),
  );

  /** The next record, cleared, with `count` counting it; null when the message is full. */
  add(kind: number): EventRecord | null {
    if (this.count >= EVENTS_MAX_PER_MSG) return null;
    const e = this.events[this.count++] as EventRecord;
    e.clear();
    e.kind = kind;
    return e;
  }
}

/** Refuses (the writer's error flag) a count outside 1–63 or any field its layout can't carry. */
export function encodeEvents(w: BitWriter, m: EventsMsg): boolean {
  const n = m.count;
  if (n < 1 || n > EVENTS_MAX_PER_MSG) {
    w.fail();
    return false;
  }
  w.writeBits(MSG_EVENTS, 8);
  w.writeBits(n, EVENTS_COUNT_BITS);
  const events = m.events;
  for (let i = 0; i < n; i++) {
    const e = events[i] as EventRecord;
    const kind = e.kind;
    w.writeBits(kind, EVENT_KIND_BITS);
    if (kind === EVK_PLAYER_JOIN) {
      if (e.clientId >= MATCH_MAX_CLIENTS || e.team > TEAM_2) w.fail();
      w.writeBits(e.clientId, EVENT_CLIENT_BITS);
      w.writeBits(e.team, 2);
    } else if (kind === EVK_PLAYER_LEAVE) {
      if (e.clientId >= MATCH_MAX_CLIENTS || e.reason > EV_LEAVE_REASON_MAX) w.fail();
      w.writeBits(e.clientId, EVENT_CLIENT_BITS);
      w.writeBits(e.reason, 2);
    } else if (kind === EVK_SERVER_STATS) {
      if (e.players > MATCH_MAX_CLIENTS) w.fail();
      w.writeBits(e.tickP50Us, EVENT_TICK_US_BITS);
      w.writeBits(e.tickP99Us, EVENT_TICK_US_BITS);
      w.writeBits(e.tickMaxUs, EVENT_TICK_US_BITS);
      w.writeBits(e.players, EVENT_PLAYERS_BITS);
    } else {
      w.fail();
    }
  }
  return !w.error;
}

/**
 * False on a short read, a wrong type byte, a count of 0, a refused kind, a team or reason of 3,
 * players past 64 or bits left after the message; `out` is then partial. The fields a record's
 * kind has no use for are 0, so an accepted message re-encodes to the same bytes.
 */
export function decodeEvents(r: BitReader, out: EventsMsg): boolean {
  if (r.readBits(8) !== MSG_EVENTS) return false;
  const n = r.readBits(EVENTS_COUNT_BITS);
  if (n < 1) return false;
  out.count = 0;
  for (let i = 0; i < n; i++) {
    const kind = r.readBits(EVENT_KIND_BITS);
    if (kind < 1 || kind > EVK_MAX) return false;
    const e = out.add(kind) as EventRecord;
    if (kind === EVK_PLAYER_JOIN) {
      e.clientId = r.readBits(EVENT_CLIENT_BITS);
      e.team = r.readBits(2);
      if (e.team > TEAM_2) return false;
    } else if (kind === EVK_PLAYER_LEAVE) {
      e.clientId = r.readBits(EVENT_CLIENT_BITS);
      e.reason = r.readBits(2);
      if (e.reason > EV_LEAVE_REASON_MAX) return false;
    } else {
      e.tickP50Us = r.readBits(EVENT_TICK_US_BITS);
      e.tickP99Us = r.readBits(EVENT_TICK_US_BITS);
      e.tickMaxUs = r.readBits(EVENT_TICK_US_BITS);
      e.players = r.readBits(EVENT_PLAYERS_BITS);
      if (e.players > MATCH_MAX_CLIENTS) return false;
    }
  }
  return r.atEnd();
}
