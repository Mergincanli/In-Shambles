import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ClientSim,
  createScriptedInput,
  STAT_CORRECTIONS,
  STAT_STARVED,
  STAT_STARVED_CORRECTIONS,
  TICK_MS,
  WebSocketTransport,
} from "@game/client/net";
import { describe, expect, it } from "vitest";
import { fromRoot } from "../src/paths";
import { loadCourse } from "../src/scenarios/course";

// The match loop's yield on a late wake (D-027) on the real Node server: the server from source
// in a child process, one ClientSim on Node's WebSocket at about 60 fps on lan, and 8 stalls of
// the server's host, 90 ms each, one a second: a busy-wait inside a signal callback (a JS-side
// stall, as a GC or a long I/O callback makes; `stall-hook.mjs`) and a SIGSTOP, in turn. Node runs
// an overdue timer before the socket reads that piled up in both, so without the yield the
// catch-up ticks past the input buffer repeated cmds that were waiting in the socket (the
// headless NET-04 stall test encodes that order; this holds Node to it). Each stall's window (the
// second after it) is judged only when the client's own frames stayed inside the input buffer:
// this process shares the host, and a late frame starves by design.

const STALLS = 8;
const STALL_MS = 90;
const SETTLE_MS = 3000;
const POSIX = process.platform !== "win32";
const hook = pathToFileURL(fileURLToPath(new URL("./stall-hook.mjs", import.meta.url))).href;

interface Server {
  readonly child: ChildProcess;
  readonly port: number;
  readonly buildHash: string;
}

function startServer(): Promise<Server> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--import", hook, "src/node/main.ts", "--port", "0"],
    { cwd: fromRoot("packages", "server"), env: { ...process.env, STALL_MS: String(STALL_MS) } },
  );
  let output = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening line:\n${output}`)), 20_000);
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      const line = output.split("\n").find((l) => l.includes('"ev":"listening"'));
      if (line === undefined) return;
      clearTimeout(timer);
      const l = JSON.parse(line) as { port: number; buildHash: string };
      resolve({ child, port: l.port, buildHash: l.buildHash });
    });
    child.once("exit", (code) => reject(new Error(`server exited (${code}):\n${output}`)));
  });
}

describe("real Node server stalls: the catch-up ticks get the cmds sent meanwhile (D-027)", () => {
  it.skipIf(!POSIX)(
    `starves no cmd of a 60 fps lan client over ${STALLS} stalls of ${STALL_MS} ms`,
    async () => {
      const server = await startServer();
      const child = server.child;
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
      let asked: string | null = null;
      const client = new ClientSim({
        transport: new WebSocketTransport(ws),
        buildHash: server.buildHash,
        clock: () => performance.now(),
        input: createScriptedInput("circle") ?? undefined,
        onMapRequest: (name) => {
          asked = name;
        },
      });
      const t = client.stats.totals;
      const buffer = client.settings.inputBuffer * TICK_MS;
      const windows: { kind: string; starved: number; maxFrameMs: number }[] = [];
      let last = Number.NaN;
      let activeAt = Number.NaN;
      let stalls = 0;
      let nextStall = Number.NaN;
      let window: { kind: string; starved0: number; maxFrameMs: number } | null = null;
      try {
        client.connect();
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, TICK_MS - 1));
          client.frame();
          const now = client.now[0] as number;
          if (window !== null && !Number.isNaN(last)) {
            window.maxFrameMs = Math.max(window.maxFrameMs, now - last);
          }
          last = now;
          if (asked !== null && client.map === null) client.provideMap(loadCourse(asked).cmap);
          if (client.closed) throw new Error(`closed: ${client.connection.closeReason}`);
          if (client.active && Number.isNaN(activeAt)) {
            activeAt = now;
            nextStall = now + SETTLE_MS;
          }
          if (Number.isNaN(activeAt) && now > 10_000) throw new Error("never became active");
          if (Number.isNaN(nextStall) || now < nextStall) continue;
          if (window !== null) {
            const starved = (t[STAT_STARVED] as number) - window.starved0;
            windows.push({ kind: window.kind, starved, maxFrameMs: Math.round(window.maxFrameMs) });
            window = null;
          }
          if (stalls === STALLS) break;
          const kind = stalls % 2 === 0 ? "busy" : "sigstop";
          window = { kind, starved0: t[STAT_STARVED] as number, maxFrameMs: 0 };
          if (kind === "busy") child.kill("SIGUSR2");
          else {
            child.kill("SIGSTOP");
            setTimeout(() => child.kill("SIGCONT"), STALL_MS);
          }
          stalls++;
          nextStall = now + 1000;
        }
        const metrics = (await (await fetch(`http://127.0.0.1:${server.port}/metrics`)).json()) as {
          process: { loopYields: number };
        };
        const judged = windows.filter((w) => w.maxFrameMs <= buffer);
        const detail = JSON.stringify({ windows, loopYields: metrics.process.loopYields });
        console.log(`server stalls: ${detail}`);
        expect(
          judged.length,
          `too few windows with on-time frames: ${detail}`,
        ).toBeGreaterThanOrEqual(STALLS / 2);
        expect(
          judged.map((w) => w.starved),
          detail,
        ).toEqual(judged.map(() => 0));
        expect((t[STAT_CORRECTIONS] as number) - (t[STAT_STARVED_CORRECTIONS] as number)).toBe(0);
        // Every stall made a late wake, and it yielded (without the yield: 0, and 15 starved cmds
        // over the 8 windows, in both kinds of stall).
        expect(metrics.process.loopYields, detail).toBeGreaterThanOrEqual(STALLS);
      } finally {
        client.disconnect();
        child.kill("SIGCONT");
        child.kill("SIGKILL");
      }
    },
    60_000,
  );
});
