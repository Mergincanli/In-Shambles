import {
  BUTTON_JUMP,
  buildCollisionWorld,
  CvarRegistry,
  createLoopbackPair,
  frameDigest,
  PMOVE_CVARS,
  PmoveParams,
  pmovePrimed,
  primePmoveOnce,
  registerPmoveCvars,
  UserCmd,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { Match } from "../../src/match/match";
import { loadMap, TEST_BUILD, TestClient } from "./fixtures";

// The pmove primer at match construction (D-040, M3 design §2.11, §5 "Primer"): it is inert. A
// 1000-tick match on movement_lab with two scripted players gives the same world frames, the same
// snapshots and the same per-session events whether the match primed pmove or not, and building
// the primed match touches neither its registry nor its sessions. Vitest gives this file its own
// module instances, so the unprimed match runs first, on a pmove nobody has primed.

const cmap = loadMap("movement_lab");
const world = buildCollisionWorld(cmap);
const TICKS = 1000;

interface Run {
  /**
   * Per tick: the world frame's digest, then each client's newest snapshot as it decoded it (the
   * other player's entity record carries its movement events).
   */
  digests: number[];
  /** The registry's version at the end. */
  version: number;
  /** The match's movement parameters right after construction, every field by name. */
  params: Record<string, number>;
}

function paramsOf(p: PmoveParams): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of PMOVE_CVARS) out[row.field] = p[row.field];
  out.version = p.version;
  return out;
}

function cmdFor(id: number, tick: number): UserCmd {
  const c = new UserCmd();
  c.tick = tick;
  c.forward = 127;
  c.right = id === 0 ? 127 : -127;
  c.yaw = (tick * (id === 0 ? 300 : -220)) & 0xffff;
  c.pitch = (((tick * 37) % 4000) - 2000) & 0xffff;
  c.buttons = (tick + id * 7) % 45 < 2 ? BUTTON_JUMP : 0;
  return c;
}

function play(primer: boolean): Run {
  const cvars = new CvarRegistry();
  registerPmoveCvars(cvars);
  const version = cvars.version;
  const match = new Match({ cmap, world, cvars, buildHash: TEST_BUILD, primer });
  // Construction left the registry as it was, primer or not; the parameters the primer read
  // (the match's own, live) are compared across the two runs below.
  expect(cvars.version).toBe(version);
  const params = paramsOf(match.params);
  const clients: TestClient[] = [];
  for (let i = 0; i < 2; i++) {
    const [c, s] = createLoopbackPair();
    match.connect(s);
    const tc = new TestClient(c);
    tc.hello();
    clients.push(tc);
  }
  match.tick();
  for (const c of clients) {
    c.poll();
    c.ready();
  }
  const digests: number[] = [];
  for (let t = 0; t < TICKS; t++) {
    const tick = match.serverTick + 1;
    for (let id = 0; id < clients.length; id++) {
      const c = clients[id] as TestClient;
      const ack = c.snapshots.at(-1)?.serverTick ?? 0;
      c.input([cmdFor(id, tick + 1), cmdFor(id, tick)], ack);
    }
    match.tick();
    digests.push(frameDigest(match.worldFrame, -1));
    for (let id = 0; id < clients.length; id++) {
      const c = clients[id] as TestClient;
      c.poll();
      const snap = c.snapshots.at(-1);
      digests.push(snap === undefined ? 0 : frameDigest(snap.frame, id));
    }
  }
  for (const c of clients) expect(c.bad + c.noBaseline).toBe(0);
  return { digests, version: cvars.version, params };
}

describe("pmove primer at Match construction (D-040)", () => {
  it("is inert: a 1000-tick match digests the same with and without it", () => {
    expect(pmovePrimed()).toBe(false);
    const plain = play(false);
    expect(pmovePrimed()).toBe(false);
    const primed = play(true);
    expect(pmovePrimed()).toBe(true);
    // Once per module instance: a later match, or a direct call, finds it done.
    expect(primePmoveOnce(new PmoveParams())).toBe(false);
    expect(primed.digests).toHaveLength(3 * TICKS);
    expect(primed.digests).toEqual(plain.digests);
    expect(primed.version).toBe(plain.version);
    // The primer wrote none of the match's parameters (a step, ladder or pool field the open-floor
    // play below never meets included).
    expect(primed.params).toEqual(plain.params);
    // The players moved: the digests are not one repeated value.
    expect(new Set(plain.digests).size).toBeGreaterThan(TICKS);
  });
});
