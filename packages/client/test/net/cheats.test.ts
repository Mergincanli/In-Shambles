import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Match } from "@game/server";
import {
  buildCollisionWorld,
  CvarRegistry,
  createLoopbackPair,
  decodeCmap,
  registerPmoveCvars,
  registerServerReplicatedCvars,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { registerClientCvars } from "../../src/console/clientCvars";
import { ClientSim } from "../../src/net";
import { workerCvars } from "../../src/worker/workerCvars";

// D-042 (M3 design §2.10): the client's CHEAT cvars follow the server's replicated sv_cheats, set
// on every block apply (WELCOME and CVARS): 0 on a dedicated server, 1 in the Worker.

const mapUrl = new URL("../../../../content/maps/movement_lab.cmap", import.meta.url);
const cmap = decodeCmap(new Uint8Array(readFileSync(fileURLToPath(mapUrl))));
const world = buildCollisionWorld(cmap);
const BUILD = "cheats-test";

function session(serverCvars: CvarRegistry) {
  const [clientEnd, serverEnd] = createLoopbackPair();
  const match = new Match({ cmap, world, cvars: serverCvars, buildHash: BUILD, primer: false });
  match.connect(serverEnd, true);
  const cvars = new CvarRegistry();
  registerPmoveCvars(cvars);
  registerServerReplicatedCvars(cvars);
  registerClientCvars(cvars);
  const changes: boolean[] = [];
  const now = { t: 0 };
  const client = new ClientSim({
    primer: false,
    transport: clientEnd,
    cmap,
    world,
    buildHash: BUILD,
    clock: () => now.t,
    cvars,
    onCheatsChanged: (on) => changes.push(on),
  });
  client.connect();
  const run = (ticks: number) => {
    for (let i = 0; i < ticks; i++) {
      now.t += 1000 / 60;
      match.tick();
      client.frame();
    }
  };
  return { match, client, cvars, changes, run };
}

function dedicated(): CvarRegistry {
  const reg = new CvarRegistry();
  registerPmoveCvars(reg);
  registerServerReplicatedCvars(reg);
  return reg;
}

describe("CHEAT cvars follow the server's sv_cheats (D-042)", () => {
  it("stay refused on a dedicated server's default (sv_cheats 0)", () => {
    const s = session(dedicated());
    s.run(30);
    expect(s.client.active).toBe(true);
    expect(s.cvars.get("sv_cheats")).toBe(0);
    expect(s.cvars.cheatsAllowed()).toBe(false);
    expect(s.cvars.set("cl_thirdPerson", true)).toEqual({ ok: false, error: "cheat" });
    expect(s.changes).toEqual([]);
  });

  it("work in the Worker (sv_cheats 1), and reset when an admin sets sv_cheats 0", () => {
    const s = session(workerCvars());
    s.run(30);
    expect(s.cvars.get("sv_cheats")).toBe(1);
    expect(s.cvars.cheatsAllowed()).toBe(true);
    expect(s.changes).toEqual([true]);
    expect(s.cvars.set("cl_thirdPerson", true).ok).toBe(true);
    expect(s.cvars.set("r_debugHull", true).ok).toBe(true);
    // The admin client's set travels as CMD; the CVARS broadcast turns cheats off.
    s.client.sendCommand("set sv_cheats 0");
    s.run(10);
    expect(s.cvars.get("sv_cheats")).toBe(0);
    expect(s.cvars.cheatsAllowed()).toBe(false);
    expect([s.cvars.get("cl_thirdPerson"), s.cvars.get("r_debugHull")]).toEqual([false, false]);
    expect(s.changes).toEqual([true, false]);
    // Turned back on: allowed again, the values stay at their defaults until set.
    s.client.sendCommand("toggle sv_cheats");
    s.run(10);
    expect(s.cvars.cheatsAllowed()).toBe(true);
    expect(s.cvars.get("cl_thirdPerson")).toBe(false);
    expect(s.changes).toEqual([true, false, true]);
    expect(s.client.predictor.corrections.total).toBe(0);
  });
});
