import {
  EV_LEAVE_KICKED,
  EV_LEAVE_TIMED_OUT,
  EVK_PLAYER_JOIN,
  EVK_PLAYER_LEAVE,
  EVK_SERVER_STATS,
  type EventRecord,
  type EventsMsg,
  MATCH_MAX_CLIENTS,
} from "@game/shared";

/** Slots of `Roster.server`: SERVER_STATS' tick times (µs) and players, and how many came. */
export const SV_TICK_P50_US = 0;
export const SV_TICK_P99_US = 1;
export const SV_TICK_MAX_US = 2;
export const SV_PLAYERS = 3;
export const SV_REPORTS = 4;
export const SV_COUNT = 5;

/** Notices kept for the page to drain; past it the oldest go (nobody may be draining: a bot). */
export const NOTICES_MAX = 64;

function leaveText(reason: number): string {
  if (reason === EV_LEAVE_TIMED_OUT) return "timed out";
  if (reason === EV_LEAVE_KICKED) return "was kicked";
  return "left";
}

/**
 * The match as EVENTS tell it (D-043, docs/05 §10): who has joined and on which team, and the
 * server's last SERVER_STATS (its tick times and players), for the netgraph and the scoreboard to
 * come. The server sends a joiner a JOIN for every player present and then its own, so events up
 * to the client's own JOIN are the roster burst; JOINs and LEAVEs after it are news, and each one
 * becomes a console notice. Fixed shape; the notices' text allocates (rare).
 */
export class Roster {
  /** Per slot: 1 while that player is in the match. */
  readonly joined = new Uint8Array(MATCH_MAX_CLIENTS);
  /** Per slot: its team (TEAM_*), as its JOIN said. */
  readonly team = new Uint8Array(MATCH_MAX_CLIENTS);
  /** Players joined (popcount of `joined`). */
  count = 0;
  /** The client's own JOIN arrived: the burst is over. */
  burstDone = false;
  /** SV_*: the last SERVER_STATS, and the count of them so far. */
  readonly server = new Int32Array(SV_COUNT);

  /** Applies `m`'s events in order; `self` is this client's id, notices go to `notices`. */
  apply(m: EventsMsg, self: number, notices: string[]): void {
    for (let i = 0; i < m.count; i++) this.applyOne(m.events[i] as EventRecord, self, notices);
  }

  reset(): void {
    this.joined.fill(0);
    this.team.fill(0);
    this.count = 0;
    this.burstDone = false;
    this.server.fill(0);
  }

  private applyOne(e: EventRecord, self: number, notices: string[]): void {
    const id = e.clientId;
    if (e.kind === EVK_PLAYER_JOIN) {
      if (this.joined[id] === 0) this.count++;
      this.joined[id] = 1;
      this.team[id] = e.team;
      if (id === self) {
        this.burstDone = true;
        notice(notices, `you joined team ${e.team}`);
      } else if (this.burstDone) {
        notice(notices, `player ${id} joined team ${e.team}`);
      }
    } else if (e.kind === EVK_PLAYER_LEAVE) {
      if (this.joined[id] === 1) this.count--;
      this.joined[id] = 0;
      this.team[id] = 0;
      notice(notices, `player ${id} ${leaveText(e.reason)}`);
    } else if (e.kind === EVK_SERVER_STATS) {
      const s = this.server;
      s[SV_TICK_P50_US] = e.tickP50Us;
      s[SV_TICK_P99_US] = e.tickP99Us;
      s[SV_TICK_MAX_US] = e.tickMaxUs;
      s[SV_PLAYERS] = e.players;
      s[SV_REPORTS] = (s[SV_REPORTS] as number) + 1;
    }
    // PLAYER_DEATH and HIT_CONFIRM (protocol v4, D-053) decode but change nothing yet: the death's
    // console line comes with deaths (M4 increment 7), the impact sound with the boot (13).
  }
}

function notice(notices: string[], text: string): void {
  if (notices.length >= NOTICES_MAX) notices.shift();
  notices.push(text);
}
