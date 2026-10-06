import {
  ClientSim,
  CONN_ACTIVE,
  CONN_CLOSED,
  CONN_CONNECTING,
  CONN_SPAWNING,
  CONN_SYNCING,
  createScriptedInput,
  HANDSHAKE_PINGS,
  MixedInput,
  NeutralInput,
  SCRIPTED_INPUTS,
  STAT_STRIKES,
  StrafeCircuit,
} from "@game/client/net";
import { Match } from "@game/server";
import {
  BitWriter,
  createLoopbackPair,
  encodePong,
  encodeSnapshot,
  MAX_RELIABLE_BYTES,
  PlayerState,
  PongMsg,
  SnapshotMsg,
  UserCmd,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { loadCourse } from "../../src/scenarios/course";
import { HARNESS_BUILD, NetHarness } from "./harness";

// The client's session outside the NET acceptance runs: the handshake states, refusals, kicks and
// malformed packets (M2 design §1 connection.ts), and the scripted inputs (scriptedInput.ts).

const course = loadCourse("movement_lab");

/** A client on movement_lab over a bare loopback pair, its clock under the test's control. */
function bareClient(buildHash = HARNESS_BUILD) {
  const [clientEnd, serverEnd] = createLoopbackPair();
  const now = { t: 0 };
  const client = new ClientSim({
    transport: clientEnd,
    cmap: course.cmap,
    world: course.world,
    buildHash,
    clock: () => now.t,
  });
  return { client, serverEnd, now };
}

describe("client session", () => {
  it("walks HELLO → WELCOME → five pings → READY → spawn, then predicts", () => {
    const { client, serverEnd, now } = bareClient();
    const match = new Match({ cmap: course.cmap, world: course.world, buildHash: HARNESS_BUILD });
    match.connect(serverEnd, true);
    expect(client.sendCommand("cvars")).toBe(false);
    client.connect();
    expect(client.state).toBe(CONN_CONNECTING);
    const seen = new Set<number>([client.state]);
    for (let i = 0; i < 400 && client.state !== CONN_ACTIVE; i++) {
      now.t += 1000 / 144;
      if (i % 2 === 0) match.tick();
      client.frame();
      seen.add(client.state);
    }
    expect([...seen]).toEqual([CONN_CONNECTING, CONN_SYNCING, CONN_SPAWNING, CONN_ACTIVE]);
    expect(client.clock.sampleCount).toBeGreaterThanOrEqual(HANDSHAKE_PINGS);
    expect(client.connection.clientId).toBe(0);
    const spawn = match.session(0)?.spawnTick ?? -1;
    expect(client.startTick).toBe(spawn + client.clock.leadTicks(client.settings.inputBuffer));
    expect(client.predictor.latestTick).toBeGreaterThanOrEqual(client.startTick);
  });

  it("refuses a WELCOME for another map", () => {
    const { client, serverEnd, now } = bareClient();
    const other = loadCourse("jump_lab");
    const match = new Match({ cmap: other.cmap, world: other.world, buildHash: HARNESS_BUILD });
    match.connect(serverEnd, true);
    client.connect();
    for (let i = 0; i < 10; i++) {
      now.t += 10;
      match.tick();
      client.frame();
    }
    expect(client.state).toBe(CONN_CLOSED);
    expect(client.connection.closeReason).toMatch(/^server runs map jump_lab/);
  });

  it("reports the server's kick", () => {
    const { client, serverEnd, now } = bareClient("other-build");
    const match = new Match({ cmap: course.cmap, world: course.world, buildHash: HARNESS_BUILD });
    match.connect(serverEnd, true);
    client.connect();
    for (let i = 0; i < 10; i++) {
      now.t += 10;
      match.tick();
      client.frame();
    }
    expect(client.closed).toBe(true);
    expect(client.connection.closeReason).toMatch(/^kicked: build other-build/);
  });

  it("drops malformed packets, wrong channels and messages out of state with a strike", () => {
    const { client, serverEnd, now } = bareClient();
    client.connect();
    const w = new BitWriter(MAX_RELIABLE_BYTES);
    // A snapshot before WELCOME is out of state; on the reliable channel it is on the wrong one.
    const snap = new SnapshotMsg();
    snap.state.stamina = 100;
    encodeSnapshot(w, snap);
    serverEnd.sendUnreliable(w.bytes, w.byteLength);
    serverEnd.sendReliable(w.bytes, w.byteLength);
    w.reset();
    encodePong(w, new PongMsg());
    serverEnd.sendReliable(w.bytes, w.byteLength);
    serverEnd.sendUnreliable(new Uint8Array([99, 1, 2]), 3);
    serverEnd.sendReliable(new Uint8Array([2, 1]), 2);
    now.t += 10;
    client.frame();
    // The out-of-state snapshot decodes, so it is ignored without a strike.
    expect(client.stats.totals[STAT_STRIKES]).toBe(4);
    expect(client.state).toBe(CONN_CONNECTING);
    expect(client.predictor.latestTick).toBe(-1);
  });

  it("closes when the server's transport closes", () => {
    const { client, serverEnd, now } = bareClient();
    client.connect();
    serverEnd.close("server shutting down");
    now.t += 10;
    client.frame();
    expect(client.closed).toBe(true);
    expect(client.connection.closeReason).toBe("server shutting down");
  });

  it("smooths a correction into the render offset instead of jumping", () => {
    // Drop the client's inputs for a stretch: the server starves, the prediction is corrected.
    const h = new NetHarness({ input: new StrafeCircuit() });
    h.runTicks(400);
    const session = h.match.session(0);
    expect(session).toBeDefined();
    const queue = session?.queue;
    for (let i = 0; i < 12; i++) {
      queue?.reset((h.match.serverTick as number) + 2);
      h.run(1000 / 60);
    }
    h.run(1000);
    const t = h.totals();
    expect(t.corrections).toBeGreaterThan(0);
    expect(Math.max(...h.frames.offset)).toBeGreaterThan(0);
    // It decays: the last frame's offset is gone.
    expect(h.frames.offset.at(-1)).toBe(0);
  });
});

describe("scripted input", () => {
  it("knows its names", () => {
    for (const name of SCRIPTED_INPUTS) expect(createScriptedInput(name)).not.toBeNull();
    expect(createScriptedInput("nope")).toBeNull();
    expect(createScriptedInput("idle")).toBeInstanceOf(NeutralInput);
  });

  it("is a pure function of its sample count and the states it sees", () => {
    for (const make of [() => new StrafeCircuit(), () => new MixedInput()]) {
      const a = make();
      const b = make();
      const ps = new PlayerState();
      ps.viewYaw = 1234;
      const ca = new UserCmd();
      const cb = new UserCmd();
      for (let i = 0; i < 2000; i++) {
        ps.flags = i % 37 < 3 ? 1 : 0;
        ps.velocity[0] = (i % 50) * 10;
        ps.velocity[1] = 120;
        ps.origin[0] = i;
        a.sample(ca, ps);
        b.sample(cb, ps);
        expect(cb).toEqual(ca);
      }
    }
  });

  it("the circuit stands still first, then strafe-jumps", () => {
    const s = new StrafeCircuit({ idleTicks: 3 });
    const ps = new PlayerState();
    ps.flags = 1;
    ps.viewYaw = 500;
    const c = new UserCmd();
    for (let i = 0; i < 3; i++) {
      s.sample(c, ps);
      expect([c.forward, c.right, c.buttons, c.yaw]).toEqual([0, 0, 0, 500]);
    }
    s.sample(c, ps);
    expect(c.forward).toBe(127);
    expect(c.buttons).not.toBe(0);
  });
});
