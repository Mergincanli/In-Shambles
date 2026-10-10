import {
  ClientSim,
  createScriptedInput,
  STAT_CORRECTIONS,
  STAT_HARD_RESYNCS,
  STAT_SNAPSHOTS,
  STAT_STARVED,
  STAT_STARVED_CORRECTIONS,
  STAT_STRIKES,
  TICK_MS,
  WebSocketTransport,
} from "@game/client/net";
import { startServer } from "@game/server/node";
import { describe, expect, it } from "vitest";
import { fromRoot } from "../../src/paths";
import { loadCourse } from "../../src/scenarios/course";

// The client over a real WebSocket (M3 design §5 "Real-ws integration", D-030, D-031): one
// ClientSim on Node's built-in WebSocket, wrapped in nothing (lan), against the Node server
// started in-process on a free port. The client loads the map WELCOME names and plays the circle
// bot for 3 s on real time, judged by the e2e prediction-health rule (packages/client/e2e/
// health.ts): no correction on an on-time snapshot ever; at most one hard resync in an on-time
// frame before the bot moves and none after; starved cmds, their corrections and other hard
// resyncs only after frames longer than the input buffer (the test host's timer jitter).

const RUN_MS = 3000;

describe("client over a real WebSocket to the Node server (D-031)", () => {
  it("loads the server's map, joins and predicts for 3 s with a healthy prediction", async () => {
    const server = await startServer({
      args: ["--port", "0"],
      cwd: fromRoot("packages", "server"),
      primer: false,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${server.listener.port}/`);
    let asked: [string, string] | null = null;
    const client = new ClientSim({
      primer: false,
      transport: new WebSocketTransport(ws),
      buildHash: server.buildHash,
      clock: () => performance.now(),
      input: createScriptedInput("circle") ?? undefined,
      onMapRequest: (name, hash) => {
        asked = [name, hash];
      },
    });
    const t = client.stats.totals;
    let longFrames = 0;
    let onTimeResyncs = 0;
    let last = Number.NaN;
    let activeAt = Number.NaN;
    let spawnX = Number.NaN;
    /** On-time hard resyncs when the bot first left its spawn (NaN until then). */
    let onTimeAtMoving = Number.NaN;
    const startedAt = performance.now();
    try {
      client.connect();
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, TICK_MS));
        const resyncs = t[STAT_HARD_RESYNCS] as number;
        client.frame();
        const now = client.now[0] as number;
        const long = !Number.isNaN(last) && now - last > client.settings.inputBuffer * TICK_MS;
        last = now;
        if (long) longFrames++;
        else if ((t[STAT_HARD_RESYNCS] as number) > resyncs) onTimeResyncs++;
        // Handed over a frame later, as the page's fetch would.
        if (asked !== null && client.map === null) {
          const [name] = asked as [string, string];
          expect(client.provideMap(loadCourse(name).cmap)).toBeNull();
        }
        if (client.closed) throw new Error(`closed: ${client.connection.closeReason}`);
        if (client.active && Number.isNaN(activeAt)) {
          activeAt = now;
          spawnX = client.predictor.state.origin[0] as number;
        }
        if (
          Number.isNaN(onTimeAtMoving) &&
          !Number.isNaN(spawnX) &&
          (client.predictor.state.origin[0] as number) !== spawnX
        ) {
          onTimeAtMoving = onTimeResyncs;
        }
        if (!Number.isNaN(activeAt) && now - activeAt >= RUN_MS) break;
        if (Number.isNaN(activeAt) && now - startedAt > 5000)
          throw new Error("never became active");
      }
      expect(asked).toEqual(["arena_greybox", loadCourse("arena_greybox").cmap.contentHash]);
      expect(client.connection.clientId).toBe(0);
      const detail = JSON.stringify({ longFrames, onTimeResyncs, onTimeAtMoving, totals: [...t] });
      expect(t[STAT_SNAPSHOTS] as number, detail).toBeGreaterThan(120);
      expect(t[STAT_STRIKES], detail).toBe(0);
      expect(
        (t[STAT_CORRECTIONS] as number) - (t[STAT_STARVED_CORRECTIONS] as number),
        detail,
      ).toBe(0);
      // As health.ts: one on-time resync may settle the start, none once the bot moves.
      expect(onTimeAtMoving, detail).toBeLessThanOrEqual(1);
      expect(onTimeResyncs - onTimeAtMoving, detail).toBe(0);
      if (longFrames === 0) expect(t[STAT_STARVED], detail).toBe(0);
      expect(server.matches.main?.match.sessionCount).toBe(1);
      // The circle bot left its spawn (it idles 1.5 s, then circles at speed).
      expect(Number.isNaN(onTimeAtMoving), detail).toBe(false);
      const moved = Math.abs((client.predictor.state.origin[0] as number) - spawnX);
      expect(moved, detail).toBeGreaterThan(0);
    } finally {
      client.disconnect();
      await server.stop();
    }
  }, 15_000);
});
