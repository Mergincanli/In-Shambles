import {
  EV_DEATH_FALL,
  EV_HIT_BOOT,
  EV_LEAVE_KICKED,
  EV_LEAVE_LEFT,
  EV_LEAVE_TIMED_OUT,
  EVK_HIT_CONFIRM,
  EVK_PLAYER_DEATH,
  EVK_PLAYER_JOIN,
  EVK_PLAYER_LEAVE,
  EVK_SERVER_STATS,
  EventsMsg,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  NOTICES_MAX,
  Roster,
  SV_PLAYERS,
  SV_REPORTS,
  SV_TICK_MAX_US,
  SV_TICK_P50_US,
  SV_TICK_P99_US,
} from "../../src/net/roster";

// The client's roster from EVENTS (D-043): the burst up to its own JOIN is silent, later JOINs and
// LEAVEs become notices, SERVER_STATS land in `server`.

function msg(...events: [number, number, number][]): EventsMsg {
  const m = new EventsMsg();
  for (const [kind, id, value] of events) {
    const e = m.add(kind);
    if (e === null) throw new Error("full");
    if (kind === EVK_SERVER_STATS) {
      e.tickP50Us = id;
      e.tickP99Us = value;
      e.tickMaxUs = value * 2;
      e.players = 3;
    } else {
      e.clientId = id;
      if (kind === EVK_PLAYER_JOIN) e.team = value;
      else e.reason = value;
    }
  }
  return m;
}

describe("Roster (D-043)", () => {
  it("takes the burst silently, announces itself, then announces every JOIN and LEAVE", () => {
    const r = new Roster();
    const notices: string[] = [];
    const SELF = 2;
    r.apply(
      msg([EVK_PLAYER_JOIN, 0, 1], [EVK_PLAYER_JOIN, 1, 2], [EVK_PLAYER_JOIN, SELF, 1]),
      SELF,
      notices,
    );
    expect(notices).toEqual(["you joined team 1"]);
    expect([r.count, r.burstDone, r.team[1]]).toEqual([3, true, 2]);
    r.apply(
      msg(
        [EVK_PLAYER_JOIN, 5, 2],
        [EVK_PLAYER_LEAVE, 0, EV_LEAVE_LEFT],
        [EVK_PLAYER_LEAVE, 1, EV_LEAVE_TIMED_OUT],
        [EVK_PLAYER_LEAVE, 5, EV_LEAVE_KICKED],
      ),
      SELF,
      notices,
    );
    expect(notices.slice(1)).toEqual([
      "player 5 joined team 2",
      "player 0 left",
      "player 1 timed out",
      "player 5 was kicked",
    ]);
    expect([r.count, r.joined[0], r.joined[2], r.team[5]]).toEqual([1, 0, 1, 0]);
  });

  it("counts each player once: a repeated JOIN or a LEAVE of someone absent leaves count alone", () => {
    const r = new Roster();
    const notices: string[] = [];
    r.apply(msg([EVK_PLAYER_JOIN, 0, 1], [EVK_PLAYER_JOIN, 0, 1]), 0, notices);
    expect(r.count).toBe(1);
    r.apply(msg([EVK_PLAYER_JOIN, 4, 2], [EVK_PLAYER_JOIN, 4, 1]), 0, notices);
    expect([r.count, r.team[4]]).toEqual([2, 1]);
    r.apply(msg([EVK_PLAYER_LEAVE, 7, EV_LEAVE_LEFT]), 0, notices);
    expect(r.count).toBe(2);
    r.apply(
      msg([EVK_PLAYER_LEAVE, 4, EV_LEAVE_LEFT], [EVK_PLAYER_LEAVE, 4, EV_LEAVE_LEFT]),
      0,
      notices,
    );
    expect([r.count, r.joined[4]]).toEqual([1, 0]);
  });

  it("keeps the last SERVER_STATS and counts them; a reset forgets everything", () => {
    const r = new Roster();
    const notices: string[] = [];
    r.apply(msg([EVK_SERVER_STATS, 40, 120]), 0, notices);
    r.apply(msg([EVK_SERVER_STATS, 41, 130]), 0, notices);
    expect([...r.server]).toEqual([41, 130, 260, 3, 2]);
    expect([SV_TICK_P50_US, SV_TICK_P99_US, SV_TICK_MAX_US, SV_PLAYERS, SV_REPORTS]).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(notices).toEqual([]);
    r.reset();
    expect([...r.server, r.count, r.burstDone]).toEqual([0, 0, 0, 0, 0, 0, false]);
  });

  it("takes PLAYER_DEATH and HIT_CONFIRM (protocol v4) without touching the roster or stats", () => {
    const r = new Roster();
    const notices: string[] = [];
    r.apply(msg([EVK_PLAYER_JOIN, 4, 1], [EVK_SERVER_STATS, 40, 120]), 4, notices);
    const before = [...r.server, r.count, ...r.team];
    const m = new EventsMsg();
    const death = m.add(EVK_PLAYER_DEATH);
    const hit = m.add(EVK_HIT_CONFIRM);
    if (death === null || hit === null) throw new Error("full");
    death.victim = 4;
    death.cause = EV_DEATH_FALL;
    hit.victim = 7;
    hit.cause = EV_HIT_BOOT;
    r.apply(m, 4, notices);
    expect([...r.server, r.count, ...r.team]).toEqual(before);
    expect(notices).toEqual(["you joined team 1"]);
  });

  it("keeps at most NOTICES_MAX notices when nobody drains them, dropping the oldest", () => {
    const r = new Roster();
    const notices: string[] = [];
    r.apply(msg([EVK_PLAYER_JOIN, 0, 1]), 0, notices);
    for (let i = 0; i < NOTICES_MAX + 10; i++) {
      r.apply(msg([EVK_PLAYER_JOIN, 1, 2], [EVK_PLAYER_LEAVE, 1, EV_LEAVE_LEFT]), 0, notices);
    }
    expect(notices).toHaveLength(NOTICES_MAX);
    expect(notices.at(-1)).toBe("player 1 left");
    expect(r.count).toBe(1);
  });
});
