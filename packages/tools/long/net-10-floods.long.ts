import { type ChildProcess, spawn } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { type RunningServer, startServer } from "@game/server/node";
import { afterEach, describe, expect, it } from "vitest";
import { fromRoot } from "../src/paths";
import {
  closeAll,
  halfOpenUpgrade,
  rawConnections,
  TEST_PEER_HEADER,
  upgrade,
  upgradeAtOnce,
} from "../test/net/wsProbe";

// NET-10 (b), floods (D-048, M3 review): the server process stays healthy against sockets that
// never authenticate. Refused upgrades (404, 403, 429, 503) from peers that keep their side open
// are destroyed, so they hold no descriptor; one admitted client flooding tiny frames at link
// speed from another thread leaves the shared tick loop on time (its reads are paused past the
// inbox's capacity); and a server child at `ulimit -n 256` outlives a pile of idle and
// partial-header TCP connections that runs it out of descriptors, then serves `/status` and
// admits upgrades again. Those connections are counted by neither `sv_maxTotalClients` nor
// `sv_maxPerIp` (both hold at the upgrade, D-041/D-047): admission still holds for upgrades among
// them; capping raw connections per address is M9's (D-048). The flood leg judges the loop on the
// wall clock, so this file runs in the long tier's real-time group (vitest.long.config.ts).

const TIMEOUT_MS = 30_000;
const POSIX = process.platform !== "win32";
const PEER = "203.0.113.9";

let server: RunningServer | null = null;
const opened: Socket[] = [];
let child: ChildProcess | null = null;

afterEach(async () => {
  for (const s of opened.splice(0)) s.destroy();
  await server?.stop();
  server = null;
  child?.kill("SIGKILL");
  child = null;
});

async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 5000) {
  const end = performance.now() + ms;
  while (!(await cond())) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function connections(s: RunningServer): Promise<number> {
  return new Promise((resolve, reject) =>
    s.listener.http.getConnections((e, n) => (e ? reject(e) : resolve(n))),
  );
}

describe("NET-10 (b) floods: the process survives hostile sockets (D-048)", () => {
  it(
    "destroys refused upgrades (404, 403, 429, 503) whose peers keep their side open",
    async () => {
      server = await startServer({
        args: [
          "--port",
          "0",
          "--set",
          "sv_maxPerIp=1",
          "--set",
          "sv_maxTotalClients=2",
          "--set",
          "sv_allowedOrigins=https://play.example",
          "--set",
          "sv_helloTimeout=3600",
        ],
        cwd: fromRoot("packages", "server"),
        primer: false,
        rconPassword: "",
        peerAddress: (req: IncomingMessage) =>
          (req.headers[TEST_PEER_HEADER] as string | undefined) ?? req.socket.remoteAddress ?? "",
      });
      const s = server;
      const port = s.listener.port;
      const peer = { [TEST_PEER_HEADER]: PEER };
      const admitted = [await upgrade(port, peer)];
      const refused = (n: number, path: string, headers: Record<string, string>) =>
        Promise.all(Array.from({ length: n }, () => halfOpenUpgrade(port, path, headers)));
      const tooMany = await refused(10, "/", peer);
      admitted.push(await upgrade(port));
      expect(admitted.map((u) => u.status)).toEqual([101, 101]);
      const full = await refused(10, "/", {});
      const notFound = await refused(10, "/nope", {});
      const forbidden = await refused(10, "/", { Origin: "https://evil.example" });
      const all = [...tooMany, ...full, ...notFound, ...forbidden];
      for (const r of all) opened.push(r.socket);
      expect(all.map((r) => r.status)).toEqual([
        ...Array(10).fill(429),
        ...Array(10).fill(503),
        ...Array(10).fill(404),
        ...Array(10).fill(403),
      ]);
      // A bare end() left all 40 open, counted nowhere, for as long as their peers stayed.
      await until(async () => (await connections(s)) === 2, "only the 2 admitted left");
      expect(s.listener.totalConnections).toBe(2);
      closeAll(admitted);
    },
    TIMEOUT_MS,
  );

  it(
    "keeps the tick loop on time while an admitted client floods tiny frames from another thread",
    async () => {
      server = await startServer({
        args: ["--port", "0"],
        cwd: fromRoot("packages", "server"),
        primer: false,
        rconPassword: "",
      });
      const s = server;
      const FLOOD_MS = 2000;
      const eld = monitorEventLoopDelay({ resolution: 1 });
      let ticks0 = 0;
      let dropped0 = 0;
      let t0 = 0;
      const worker = new Worker(new URL("./frame-flood.mjs", import.meta.url), {
        workerData: { port: s.listener.port, path: "/", ms: FLOOD_MS },
      });
      const result = await new Promise<{ upgraded: boolean; bytes: number }>((resolve, reject) => {
        worker.on("message", (m: { kind: string; upgraded: boolean; bytes: number }) => {
          if (m.kind === "done") return resolve(m);
          // The window opens with the flood, after the worker's own start-up.
          ticks0 = s.loop.stats.ticks;
          dropped0 = s.loop.stats.dropped;
          t0 = performance.now();
          eld.enable();
        });
        worker.once("error", reject);
      });
      eld.disable();
      const wallMs = performance.now() - t0;
      await worker.terminate();
      const ran = s.loop.stats.ticks - ticks0;
      const dropped = s.loop.stats.dropped - dropped0;
      const due = (wallMs * 60) / 1000;
      const p99 = eld.percentile(99) / 1e6;
      console.log(
        `NET-10 (b) flood: ${(result.bytes / 1e6).toFixed(1)} MB offered in ` +
          `${wallMs.toFixed(0)} ms; ${ran} ticks run of ${due.toFixed(0)} due, ${dropped} ` +
          `dropped; event loop delay p99 ${p99.toFixed(1)} ms, max ${(eld.max / 1e6).toFixed(1)} ms`,
      );
      expect(result.upgraded).toBe(true);
      expect(dropped).toBe(0);
      expect(ran).toBeGreaterThanOrEqual(Math.floor(due * 0.9));
      // Without the read pause ws parsed every frame on the loop's thread, some 40 MB in 2 s
      // here: p99 14-16 ms of delay, a tick's work late most of the time; with it 1.5-2 ms.
      expect(p99).toBeLessThan(6);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!POSIX)(
    "outlives running out of descriptors on idle and partial-header connections, then recovers",
    async () => {
      // The server from source at 256 descriptors (a probe of the review: about 22 at rest).
      const proc = spawn(
        "sh",
        [
          "-c",
          'ulimit -n 256 && exec "$0" --import tsx src/node/main.ts "$@"',
          process.execPath,
          "--port",
          "0",
          "--set",
          "sv_maxTotalClients=4",
        ],
        { cwd: fromRoot("packages", "server"), env: { ...process.env, SV_RCON_PASSWORD: "" } },
      );
      child = proc;
      let output = "";
      let exited: number | null = null;
      proc.stdout?.on("data", (d) => {
        output += String(d);
      });
      proc.stderr?.on("data", (d) => {
        output += String(d);
      });
      proc.once("exit", (code) => {
        exited = code ?? -1;
      });
      await until(
        () => output.includes('"ev":"listening"') || exited !== null,
        "listening",
        20_000,
      );
      expect(exited, output).toBeNull();
      const line = output.split("\n").find((l) => l.includes('"ev":"listening"')) as string;
      const port = (JSON.parse(line) as { port: number }).port;

      // 100 idle and 100 partial-header connections take no admission slot: exactly
      // sv_maxTotalClients of 6 upgrades among them get through.
      opened.push(...(await rawConnections(port, 100, false)));
      opened.push(...(await rawConnections(port, 100, true)));
      const ups = await upgradeAtOnce(6, port);
      expect(ups.filter((u) => u.status === 101)).toHaveLength(4);
      expect(ups.filter((u) => u.status === 503)).toHaveLength(2);
      closeAll(ups);
      // 200 more run the process out of descriptors; two memory samples (1 s apart) later it is
      // still up (the sample's EMFILE used to end it, exit 1).
      opened.push(...(await rawConnections(port, 200, false)));
      await new Promise((r) => setTimeout(r, 3500));
      expect(exited, output).toBeNull();
      // Once the flood ends it serves again.
      for (const s of opened.splice(0)) s.destroy();
      await until(
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${port}/status`)).status === 200;
          } catch {
            return false;
          }
        },
        "/status again",
        10_000,
      );
      const again = await upgradeAtOnce(4, port);
      expect(again.map((u) => u.status)).toEqual([101, 101, 101, 101]);
      closeAll(again);
      expect(exited, output).toBeNull();
      proc.kill("SIGTERM");
      await until(() => exited !== null, "the shutdown", 10_000);
      expect(exited, output).toBe(0);
      child = null;
    },
    60_000,
  );
});
