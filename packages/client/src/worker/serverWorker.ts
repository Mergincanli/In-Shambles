import { Match, startMatchLoop } from "@game/server";
import { decodeCmap, setDevAsserts } from "@game/shared";
import { PortTransport } from "../net/portTransport";
import type { WorkerOutMsg, WorkerStartMsg } from "./messages";
import { createWorkerHost } from "./workerHost";

/**
 * The offline server (docs/06 §4, M2 design §1): the environment-agnostic `Match` from
 * @game/server, running in a dedicated Worker so the page's frame loop never waits on it. The
 * page's client is its only session, and an admin (D-027), so console cvar changes reach it.
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
    const match = new Match({ cmap, buildHash: m.buildHash, log, timeouts: false });
    match.connect(new PortTransport(m.unreliable, m.reliable), true);
    const loop = startMatchLoop(
      {
        tick: () => {
          try {
            match.tick();
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
