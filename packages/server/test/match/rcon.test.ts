import {
  buildCollisionWorld,
  createLoopbackPair,
  PRINT_ERROR,
  PRINT_INFO,
  TEXT_MAX,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import type { RconGate } from "../../src/match/host";
import { STRIKE_RCON } from "../../src/match/limits";
import { Match, type MatchOptions } from "../../src/match/match";
import { SESSION_ACTIVE, SESSION_CLOSED } from "../../src/match/session";
import { loadMap, TEST_BUILD, TestClient } from "./fixtures";

// D-042 (M3 design §2.10, §5 "Server"): `rcon <password> <command…>` runs the command as an admin
// of the sender's match when the password checks; a wrong one costs STRIKE_RCON points and a
// PRINT; with no checker rcon is disabled; a gate that refuses is not even asked to check. The
// password never reaches the match's log or any PRINT.

const cmap = loadMap("movement_lab");
const world = buildCollisionWorld(cmap);
const PASSWORD = "s3cret pass";

function newMatch(options: Partial<MatchOptions> = {}): { match: Match; logs: string[] } {
  const logs: string[] = [];
  const match = new Match({
    cmap,
    world,
    buildHash: TEST_BUILD,
    primer: false,
    rcon: (p) => p === PASSWORD,
    log: (_lvl, msg) => logs.push(msg),
    events: (_lvl, ev, fields) => logs.push(`${ev} ${JSON.stringify(fields)}`),
    ...options,
  });
  return { match, logs };
}

function run(match: Match, clients: readonly TestClient[], n: number): void {
  for (let i = 0; i < n; i++) {
    match.tick();
    for (const c of clients) c.poll();
  }
}

/** A non-admin client that has spawned. */
function joined(match: Match, admin = false): TestClient {
  const [clientEnd, serverEnd] = createLoopbackPair();
  const client = new TestClient(clientEnd);
  match.connect(serverEnd, admin);
  client.hello();
  run(match, [client], 1);
  client.ready();
  run(match, [client], 1);
  return client;
}

function texts(c: TestClient): string[] {
  return c.prints.map((p) => p.text);
}

/** A gate that records what it is asked and refuses `locked` ids. */
class TestGate implements RconGate {
  readonly asked: number[] = [];
  readonly results: [number, boolean][] = [];
  readonly locked = new Set<number>();
  allow(id: number): boolean {
    this.asked.push(id);
    return !this.locked.has(id);
  }
  result(id: number, ok: boolean): void {
    this.results.push([id, ok]);
  }
}

describe("rcon (D-042)", () => {
  it("a right password runs set as admin of the match: CVARS broadcast, block hash changes", () => {
    const { match, logs } = newMatch();
    const a = joined(match);
    const b = joined(match);
    run(match, [a, b], 1);
    const before = match.cvarHash;
    a.cmd(`rcon "${PASSWORD}" set pm_gravity 400`);
    run(match, [a, b], 2);
    expect(match.cvars.get("pm_gravity")).toBe(400);
    expect(match.cvarHash).not.toBe(before);
    expect(texts(a)).toEqual(["pm_gravity = 400"]);
    expect(b.prints).toHaveLength(0);
    expect(b.cvars).toHaveLength(1);
    expect(match.metrics.rconOk).toBe(1);
    expect(match.session(0)?.stats.strikes).toBe(0);
    expect(logs.join("\n")).not.toContain(PASSWORD);
  });

  it("a non-admin's plain set is refused and the block hash stays", () => {
    const { match } = newMatch();
    const a = joined(match);
    const before = match.cvarHash;
    a.cmd("set pm_gravity 400");
    a.cmd("status");
    a.cmd("kick 0");
    a.cmd("metrics reset");
    run(match, [a], 2);
    expect(match.cvarHash).toBe(before);
    expect(match.cvars.get("pm_gravity")).toBe(800);
    expect(a.prints.map((p) => p.level)).toEqual([
      PRINT_ERROR,
      PRINT_ERROR,
      PRINT_ERROR,
      PRINT_ERROR,
    ]);
    expect(texts(a).every((t) => t.includes("only an admin") && t.includes("rcon"))).toBe(true);
    expect(match.session(0)?.state).toBe(SESSION_ACTIVE);
  });

  it("a wrong password strikes 10 and PRINTs; three in a row kick", () => {
    const { match, logs } = newMatch();
    const a = joined(match);
    a.cmd('rcon "guess-1" set pm_gravity 400');
    run(match, [a], 1);
    expect(texts(a)).toEqual(["rcon: wrong password"]);
    expect(match.session(0)?.stats.strikes).toBe(STRIKE_RCON);
    expect(match.cvars.get("pm_gravity")).toBe(800);
    a.cmd("rcon guess-2 status");
    a.cmd("rcon guess-3 status");
    run(match, [a], 1);
    expect(a.kicks[0]?.reason).toBe("too many bad packets");
    expect(match.metrics.rconFailed).toBe(3);
    expect(logs.join("\n")).not.toMatch(/guess-|pm_gravity 400/);
  });

  it("is disabled without a checker: refused without a strike", () => {
    const { match } = newMatch({ rcon: undefined });
    const a = joined(match);
    a.cmd(`rcon "${PASSWORD}" set pm_gravity 400`);
    run(match, [a], 1);
    expect(texts(a)).toEqual(["rcon is disabled on this server"]);
    expect(match.cvars.get("pm_gravity")).toBe(800);
    expect(match.session(0)?.stats.strikes).toBe(0);
  });

  it("asks the gate first: a locked sender is refused without a check, unstruck", () => {
    const gate = new TestGate();
    let checks = 0;
    const { match } = newMatch({
      rconGate: gate,
      rcon: (p) => {
        checks++;
        return p === PASSWORD;
      },
    });
    const a = joined(match);
    const b = joined(match);
    a.cmd("rcon wrong status");
    run(match, [a, b], 1);
    expect(gate.results).toEqual([[0, false]]);
    gate.locked.add(0);
    a.cmd(`rcon "${PASSWORD}" set pm_gravity 400`);
    b.cmd(`rcon "${PASSWORD}" set pm_gravity 300`);
    run(match, [a, b], 2);
    expect(texts(a)).toEqual([
      "rcon: wrong password",
      "rcon: too many wrong passwords from your address; wait",
    ]);
    expect(checks).toBe(2);
    expect(gate.asked).toEqual([0, 0, 1]);
    expect(gate.results).toEqual([
      [0, false],
      [1, true],
    ]);
    expect(match.cvars.get("pm_gravity")).toBe(300);
    expect(match.session(0)?.stats.strikes).toBe(STRIKE_RCON);
    expect(match.metrics.rconLocked).toBe(1);
  });

  it("status, kick and metrics reset run as admin of this match only", () => {
    let resets = 0;
    const { match } = newMatch({
      metricsReset: () => {
        resets++;
        return "metrics reset: match main";
      },
    });
    const a = joined(match);
    const b = joined(match);
    a.cmd(`rcon "${PASSWORD}" status`);
    run(match, [a, b], 1);
    const status = texts(a)[0] ?? "";
    expect(status.split("\n")).toEqual([
      `movement_lab, tick ${match.serverTick - 1}, 2 of 32 players`,
      `#0 active team 1 strikes 0 build ${TEST_BUILD}`,
      `#1 active team 2 strikes 0 build ${TEST_BUILD}`,
    ]);
    a.cmd(`rcon "${PASSWORD}" metrics reset`);
    a.cmd(`rcon "${PASSWORD}" kick 1 "go away"`);
    a.cmd(`rcon "${PASSWORD}" kick 9`);
    a.cmd(`rcon "${PASSWORD}" kick x`);
    run(match, [a, b], 2);
    expect(texts(a).slice(1)).toEqual([
      "metrics reset: match main",
      "client 1 kicked: go away",
      "kick: no client 9",
      "usage: kick <client id> [reason]",
    ]);
    expect(resets).toBe(1);
    expect(b.kicks[0]?.reason).toBe("go away");
    expect(match.session(1)).toBeUndefined();
    // A match without metrics says so.
    const { match: bare } = newMatch();
    const c = joined(bare);
    c.cmd(`rcon "${PASSWORD}" metrics reset`);
    run(bare, [c], 1);
    expect(texts(c)).toEqual(["metrics reset: this server keeps no metrics"]);
  });

  it("an admin kicking itself gets no reply on the closed session", () => {
    const { match } = newMatch();
    const a = joined(match);
    a.cmd(`rcon "${PASSWORD}" kick 0`);
    run(match, [a], 1);
    expect(a.kicks[0]?.reason).toBe("kicked by an admin");
    expect(a.prints).toHaveLength(0);
    expect(match.session(0)?.state ?? SESSION_CLOSED).toBe(SESSION_CLOSED);
  });

  it("splits a long status into PRINTs at line ends", () => {
    const { match } = newMatch();
    const clients: TestClient[] = [];
    for (let i = 0; i < 32; i++) clients.push(joined(match));
    clients[0]?.cmd(`rcon "${PASSWORD}" status`);
    run(match, clients, 1);
    const prints = clients[0]?.prints ?? [];
    expect(prints.length).toBeGreaterThan(1);
    for (const p of prints) {
      expect(p.level).toBe(PRINT_INFO);
      expect(p.text.length).toBeLessThanOrEqual(TEXT_MAX);
    }
    const lines = prints.flatMap((p) => p.text.split("\n"));
    expect(lines).toHaveLength(33);
    expect(lines[32]).toMatch(/^#31 active team 2 /);
  });

  it("usage without a password or a command; the Worker's admin client needs no rcon", () => {
    const gate = new TestGate();
    let checks = 0;
    const { match } = newMatch({
      rconGate: gate,
      rcon: () => {
        checks++;
        return false;
      },
    });
    const a = joined(match);
    a.cmd("rcon");
    a.cmd(`rcon "${PASSWORD}"`);
    a.cmd('rcon "" status');
    run(match, [a], 1);
    expect(texts(a)).toEqual([
      "usage: rcon <command> (with rcon_password set)",
      "usage: rcon <command> (with rcon_password set)",
      "usage: rcon <command> (with rcon_password set)",
    ]);
    // None of them is a guess: no check, no strike, nothing counted against the address.
    expect([checks, gate.asked, gate.results]).toEqual([0, [], []]);
    expect(match.session(0)?.stats.strikes).toBe(0);
    const w = newMatch({ rcon: undefined }).match;
    const admin = joined(w, true);
    admin.cmd("set pm_gravity 500");
    admin.cmd("status");
    run(w, [admin], 1);
    expect(w.cvars.get("pm_gravity")).toBe(500);
    expect(texts(admin)[1]).toMatch(
      /^movement_lab, tick \d+, 1 of 32 players\n#0 active team 1 strikes 0 admin build /,
    );
  });
});
