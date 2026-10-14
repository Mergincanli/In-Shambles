import { MATCH_MAX_CLIENTS, TEAM_2 } from "../sim/entity";
import type { BitReader, BitWriter } from "./bitstream";
import {
  EV_DEATH_CAUSE_MAX,
  EV_HIT_CAUSE_MAX,
  EV_LEAVE_REASON_MAX,
  EVK_HIT_CONFIRM,
  EVK_MAX,
  EVK_PLAYER_DEATH,
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
 *   server), players 7 (0–64);
 * - PLAYER_DEATH (v4, D-053): victim 6, cause 3 (EV_DEATH_*; 5–7 refused), hasKiller 1, killer 6
 *   only when hasKiller (otherwise 0 in the record);
 * - HIT_CONFIRM (v4): victim 6, cause 3 (EV_HIT_*; 2–7 refused).
 *
 * Kinds 0 and 6–15 are refused: reserved for the rest of M6's combat feed and M7's round state. A
 * tick with more than 63 events for one client sends several messages. Encode and decode allocate
 * nothing, refused packets included: the records are pooled and every field is a small integer. The
 * kinds (`EVK_*`) and leave reasons (`EV_LEAVE_*`) live in `protocol.ts` with the other message
 * ids.
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

/** PLAYER_DEATH and HIT_CONFIRM causes. */
export const EVENT_CAUSE_BITS = 3;

/**
 * Bits of one event of `kind`, kind field included, at its largest (PLAYER_DEATH with a killer);
 * 0 for a kind the protocol refuses.
 */
export function eventBits(kind: number): number {
  if (kind === EVK_PLAYER_DEATH) {
    return EVENT_KIND_BITS + EVENT_CLIENT_BITS + EVENT_CAUSE_BITS + 1 + EVENT_CLIENT_BITS;
  }
  if (kind === EVK_HIT_CONFIRM) return EVENT_KIND_BITS + EVENT_CLIENT_BITS + EVENT_CAUSE_BITS;
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
 * PLAYER_DEATH: `victim`, `cause`, `hasKiller` (0 or 1) and `killer` (0 without one). HIT_CONFIRM:
 * `victim`, `cause`.
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
  victim = 0;
  cause = 0;
  hasKiller = 0;
  killer = 0;

  clear(): void {
    this.kind = 0;
    this.clientId = 0;
    this.team = 0;
    this.reason = 0;
    this.tickP50Us = 0;
    this.tickP99Us = 0;
    this.tickMaxUs = 0;
    this.players = 0;
    this.victim = 0;
    this.cause = 0;
    this.hasKiller = 0;
    this.killer = 0;
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
    } else if (kind === EVK_PLAYER_DEATH) {
      if (e.victim >= MATCH_MAX_CLIENTS || e.cause > EV_DEATH_CAUSE_MAX) w.fail();
      // A killer field without hasKiller would not survive the round trip.
      if (e.hasKiller > 1 || (e.hasKiller === 0 && e.killer !== 0)) w.fail();
      if (e.killer >= MATCH_MAX_CLIENTS) w.fail();
      w.writeBits(e.victim, EVENT_CLIENT_BITS);
      w.writeBits(e.cause, EVENT_CAUSE_BITS);
      w.writeBits(e.hasKiller, 1);
      if (e.hasKiller === 1) w.writeBits(e.killer, EVENT_CLIENT_BITS);
    } else if (kind === EVK_HIT_CONFIRM) {
      if (e.victim >= MATCH_MAX_CLIENTS || e.cause > EV_HIT_CAUSE_MAX) w.fail();
      w.writeBits(e.victim, EVENT_CLIENT_BITS);
      w.writeBits(e.cause, EVENT_CAUSE_BITS);
    } else {
      w.fail();
    }
  }
  return !w.error;
}

/**
 * False on a short read, a wrong type byte, a count of 0, a refused kind, a team or reason of 3,
 * players past 64, a death cause past 4, a hit cause past 1 or bits left after the message; `out`
 * is then partial. The fields a record's
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
    } else if (kind === EVK_PLAYER_DEATH) {
      e.victim = r.readBits(EVENT_CLIENT_BITS);
      e.cause = r.readBits(EVENT_CAUSE_BITS);
      e.hasKiller = r.readBits(1);
      if (e.hasKiller === 1) e.killer = r.readBits(EVENT_CLIENT_BITS);
      if (e.cause > EV_DEATH_CAUSE_MAX) return false;
    } else if (kind === EVK_HIT_CONFIRM) {
      e.victim = r.readBits(EVENT_CLIENT_BITS);
      e.cause = r.readBits(EVENT_CAUSE_BITS);
      if (e.cause > EV_HIT_CAUSE_MAX) return false;
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
