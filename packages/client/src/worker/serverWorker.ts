import { Match, startMatchLoop, TickHistogram } from "@game/server";
import { decodeCmap, setDevAsserts, TICK_RATE } from "@game/shared";
import { PortTransport } from "../net/portTransport";
import type { WorkerOutMsg, WorkerStartMsg } from "./messages";
import { workerCvars } from "./workerCvars";
import { createWorkerHost } from "./workerHost";

/**
 * The offline server (docs/06 §4, M2 design §1): the environment-agnostic `Match` from
 * @game/server, running in a dedicated Worker so the page's frame loop never waits on it. The
 * page's client is its only session, and an admin (D-027), so console cvar changes reach it.
 * Offline play is a sandbox: `sv_cheats` starts at 1, so third person and the debug views work
 * (D-042); there is no rcon (the client is admin already). Each tick is timed here, and once a
 * second its p50/p99/max go to the match (`reportTickStats`), whose SERVER_STATS events show them
 * in the client's netgraph (D-043), as the Node server's do, but only as fine as the browser's
 * timer: the page is not cross-origin isolated, so Chromium steps `performance.now` by 100 µs
 * (others coarser) and a short tick often reads 0.
 */

function post(m: WorkerOutMsg): void {
  postMessage(m);
}

function fail(e: unknown): void {
  post({ type: "error", message: e instanceof Error ? e.message : String(e) });
}

let started = false;

addEventListener("message", (event: MessageEvent<WorkerStartMsg>) => {
  const m = event.data;
  if (started || m?.type !== "start") return;
  started = true;
  try {
    setDevAsserts(m.devAsserts);
    const cmap = decodeCmap(new Uint8Array(m.cmap));
    const log = (level: "info" | "warn" | "error", msg: string) =>
      post({ type: "log", level, msg });
    // No timeouts (D-041): the page's one client may sit in a hidden tab for as long as it likes.
    const match = new Match({
      cmap,
      cvars: workerCvars(),
      buildHash: m.buildHash,
      log,
      timeouts: false,
    });
    match.connect(new PortTransport(m.unreliable, m.reliable), true);
    const ticks = new TickHistogram();
    let timed = 0;
    const loop = startMatchLoop(
      {
        tick: () => {
          try {
            const start = performance.now();
            match.tick();
            ticks.record(((performance.now() - start) * 1000 + 0.5) | 0);
            if (++timed % TICK_RATE === 0) {
              ticks.endSecond();
              match.reportTickStats(ticks.lastP50Us, ticks.lastP99Us, ticks.lastMaxUs);
            }
          } catch (e) {
            loop.stop();
            fail(e);
          }
        },
      },
      createWorkerHost(log),
    );
    log("info", `server running ${cmap.name} (${cmap.contentHash})`);
  } catch (e) {
    fail(e);
  }
});
