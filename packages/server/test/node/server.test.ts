import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@game/shared";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { type RunningServer, startServer } from "../../src/node/server";
import { TestClient } from "../match/fixtures";
import { httpJson, maskedFrame, NodeWsClient, rawUpgrade, until, upgradeStatus } from "./wsClient";

const serverDir = fileURLToPath(new URL("../..", import.meta.url));

interface Line {
  lvl: string;
  ev: string;
  [key: string]: unknown;
}

let running: RunningServer | null = null;
const sockets: NodeWsClient[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.ws.close();
  await running?.stop();
  running = null;
});

/** An in-process server on a free port; its JSON log lines are parsed into `lines`. */
async function start(args: string[] = [], console?: NodeJS.ReadableStream) {
  const lines: Line[] = [];
  running = await startServer({
    args: ["--port", "0", ...args],
    cwd: serverDir,
    write: (line) => lines.push(JSON.parse(line) as Line),
    ...(console === undefined ? {} : { console }),
  });
  return { server: running, lines, port: running.listener.port };
}

async function client(port: number, path = "/"): Promise<TestClient> {
  const ws = await NodeWsClient.connect(`ws://127.0.0.1:${port}${path}`);
  sockets.push(ws);
  return new TestClient(ws);
}

/** Polls `c` until `cond` holds. */
function poll(c: TestClient, cond: () => boolean, what: string): Promise<void> {
  return until(() => {
    c.poll();
    return cond();
  }, what);
}

describe("Node server (in process, real WebSocket)", () => {
  it("logs JSON lines and plays the M2 handshake over a WebSocket on /", async () => {
    const { server, lines, port } = await start();
    expect(lines.map((l) => l.ev).slice(0, 2)).toEqual(["server_ok", "listening"]);
    expect(lines[0]?.startupMs).toEqual(expect.any(Number));
    expect(lines[1]).toMatchObject({
      lvl: "info",
      port,
      buildHash: server.buildHash,
      matches: [{ name: "main", map: "arena_greybox" }],
    });
    expect(typeof lines[1]?.t).toBe("string");
    expect(Number.isNaN(Date.parse(lines[1]?.t as string))).toBe(false);

    const c = await client(port);
    c.hello(server.buildHash);
    await poll(c, () => c.welcomes.length === 1, "WELCOME");
    expect(c.welcomes[0]).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      clientId: 0,
      mapName: "arena_greybox",
    });
    c.ready();
    await poll(c, () => c.snapshots.length >= 3, "snapshots");
    expect(c.bad).toBe(0);
    expect(lines.find((l) => l.ev === "connect")).toMatchObject({
      match: "main",
      client: 0,
      ip: expect.stringMatching(/127\.0\.0\.1/),
    });

    const status = await httpJson(port, "/status");
    expect(status).toEqual({
      status: 200,
      body: {
        buildHash: server.buildHash,
        protocol: PROTOCOL_VERSION,
        matches: [{ name: "main", map: "arena_greybox", players: 1, maxClients: 32 }],
      },
    });
    const metrics = (await httpJson(port, "/metrics")).body as {
      process: {
        passes: number;
        loopYields: number;
        tickUs: { count: number; p99: number };
        memoryMB: object;
      };
      matches: { main: { serverTick: number; players: number; snapshots: number } };
    };
    expect(metrics.process.passes).toBeGreaterThan(0);
    expect(metrics.process.loopYields).toBeGreaterThanOrEqual(0);
    expect(metrics.process.tickUs.count).toBe(metrics.process.passes);
    expect(metrics.process.memoryMB).toHaveProperty("heapUsed");
    expect(metrics.matches.main.serverTick).toBeGreaterThan(0);
    expect(metrics.matches.main.players).toBe(1);
    expect(metrics.matches.main.snapshots).toBeGreaterThan(0);
  });

  it("reports the effective sv_maxClients in /status, up to 64 (D-034, D-046)", async () => {
    const statusOf = async (port: number) =>
      ((await httpJson(port, "/status")).body as { matches: { maxClients: number }[] }).matches[0]
        ?.maxClients;
    {
      const { server, port } = await start(["--set", "sv_maxClients=4"]);
      expect(server.matches.main?.match.maxClients).toBe(4);
      expect(await statusOf(port)).toBe(4);
      expect(server.matches.main?.match.mirrors.allocated).toBe(0);
      await server.stop();
    }
    const { server, lines, port } = await start(["--set", "sv_maxClients=64"]);
    expect(server.cvars.get("sv_maxClients")).toBe(64);
    expect(server.matches.main?.match.maxClients).toBe(64);
    expect(await statusOf(port)).toBe(64);
    expect(lines.slice(0, 2).map((l) => l.ev)).toEqual(["server_ok", "listening"]);
    await server.stop();
    await expect(start(["--set", "sv_maxClients=65"])).rejects.toThrow(/sv_maxClients/);
  });

  it("shuts down gracefully: KICK, then close 1001, then a shutdown line", async () => {
    const { server, lines, port } = await start();
    const c = await client(port);
    c.hello(server.buildHash);
    await poll(c, () => c.welcomes.length === 1, "WELCOME");
    const first = server.stop("SIGTERM");
    // A second stop (a second signal) joins the first.
    expect(server.stop("SIGINT")).toBe(first);
    await first;
    running = null;
    // Every closing handshake finished before stop() resolved: none was cut off by a timeout.
    expect(server.listener.connections).toBe(0);
    const ws = sockets[0] as NodeWsClient;
    await poll(c, () => c.closed !== null, "close");
    expect(c.kicks.map((k) => k.reason)).toEqual(["server shutting down"]);
    expect(ws.closeCode).toBe(1001);
    expect(ws.closeReason).toBe("server shutting down");
    expect(lines.filter((l) => l.ev === "shutdown")).toHaveLength(1);
    const at = lines.findIndex((l) => l.ev === "shutdown");
    expect(lines[at]).toMatchObject({ lvl: "info", signal: "SIGTERM" });
    expect(lines.slice(at + 1).map((l) => l.msg)).toEqual([
      "client 0 kicked: server shutting down",
    ]);
    // The loop stopped: the match ticks no more.
    expect(server.loop.isRunning).toBe(false);
    const tick = server.matches.main?.match.serverTick;
    await new Promise((r) => setTimeout(r, 100));
    expect(server.matches.main?.match.serverTick).toBe(tick);
    // The port is released and no new connection is accepted.
    await expect(NodeWsClient.connect(`ws://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it("refuses an upgrade with 503 once it is shutting down", async () => {
    const { server } = await start();
    server.listener.stopAccepting();
    // An upgrade on a connection opened before the stop (keep-alive) still reaches the handler.
    const out: string[] = [];
    const socket = new PassThrough();
    socket.on("data", (d: Buffer) => out.push(d.toString()));
    const req = { url: "/", headers: {} } as IncomingMessage;
    server.listener.http.emit("upgrade", req, socket, Buffer.alloc(0));
    expect(out.join("")).toMatch(/^HTTP\/1\.1 503 /);
    expect(server.matches.main?.match.sessionCount).toBe(0);
  });

  it("frees the match slot when a client closes its socket", async () => {
    const { server, port } = await start();
    const c = await client(port);
    c.hello(server.buildHash);
    await poll(c, () => c.welcomes.length === 1, "WELCOME");
    const match = server.matches.main?.match;
    expect(match?.sessionCount).toBe(1);
    (sockets[0] as NodeWsClient).ws.close(1000, "bye");
    await until(() => match?.sessionCount === 0, "the slot freed", 3000);
    expect(
      ((await httpJson(port, "/status")).body as { matches: { players: number }[] }).matches,
    ).toMatchObject([{ players: 0 }]);
    // The freed id is the next client's.
    const d = await client(port);
    d.hello(server.buildHash);
    await poll(d, () => d.welcomes.length === 1, "WELCOME");
    expect(d.welcomes[0]?.clientId).toBe(0);
  });

  it("sends no pong to WebSocket pings: a client that never reads can't fill its buffer", async () => {
    const { server, port } = await start();
    const raw = await rawUpgrade(port);
    onTestFinished(() => {
      raw.socket.destroy();
    });
    const ping = maskedFrame(0x9, new Uint8Array(125));
    for (let i = 0; i < 200; i++) raw.socket.write(ping);
    await until(() => server.matches.main?.match.sessionCount === 1, "the session");
    await new Promise((r) => setTimeout(r, 150));
    expect(raw.received()).toBe(0);
    expect(raw.socket.destroyed).toBe(false);
  });

  it("runs admin console lines on the match and logs the reply", async () => {
    const input = new PassThrough();
    const { server, lines } = await start([], input);
    input.write("set pm_gravity 400\n");
    await until(() => lines.some((l) => l.ev === "console"), "the console reply");
    expect(server.matches.main?.match.cvars.get("pm_gravity")).toBe(400);
    expect(lines.find((l) => l.ev === "console")).toMatchObject({
      lvl: "info",
      match: "main",
      text: "pm_gravity = 400",
    });
  });

  it("keeps metrics: wire traffic, metrics lines, a discarded start, metrics reset and --metrics-out (D-029, D-036)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "server-metrics-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const input = new PassThrough();
    const out = join(dir, "sub", "metrics.json");
    const { server, lines, port } = await start(
      ["--set", "sv_metricsInterval=1", "--metrics-out", out, "--metrics-discard", "0.2"],
      input,
    );
    const c = await client(port);
    c.hello(server.buildHash);
    await poll(c, () => c.welcomes.length === 1, "WELCOME");
    c.ready();
    await until(
      () => lines.some((l) => l.ev === "metrics_reset" && l.reason === "discard"),
      "the discard's reset",
    );
    await poll(c, () => c.snapshots.length >= 30, "snapshots");
    c.ping(1);
    await poll(c, () => (server.matches.main?.traffic.messagesIn ?? 0) >= 3, "the ping");
    // Within 1 s of listen, one line for the match and one for the process.
    await until(() => lines.filter((l) => l.ev === "metrics").length >= 2, "metrics lines");
    const [matchLine, processLine] = lines.filter((l) => l.ev === "metrics");
    expect(matchLine).toMatchObject({ match: "main", players: 1, tickUs: expect.any(Object) });
    expect(processLine).toMatchObject({ gc: expect.any(Object), memoryMB: expect.any(Object) });
    expect(processLine?.match).toBeUndefined();

    type Traffic = { bytesIn: number; bytesOut: number };
    type Metrics = {
      process: { runS: number; traffic: Traffic; gc: { count: number }; tickUs: { count: number } };
      matches: {
        main: {
          fullSnapshots: number;
          snapshots: number;
          traffic: Traffic;
          tickUs: { count: number };
        };
      };
    };
    const metrics = (await httpJson(port, "/metrics")).body as Metrics;
    const main = metrics.matches.main;
    expect(main.fullSnapshots).toBe(main.snapshots);
    expect(main.snapshots).toBeGreaterThan(0);
    // Every snapshot (37 B alone in the match) plus its 2 B frame header went out on its socket.
    expect(main.traffic.bytesOut).toBeGreaterThanOrEqual(main.snapshots * 39);
    expect(main.traffic.bytesIn).toBeGreaterThan(0);
    expect(metrics.process.traffic).toEqual(main.traffic);
    // The run window started at the discard, 0.2 s after listen.
    expect(metrics.process.runS).toBeLessThan(
      (Date.now() - Date.parse(lines[1]?.t as string)) / 1000 - 0.15,
    );

    input.write("metrics reset\n");
    await until(() => lines.some((l) => l.ev === "console"), "the console reply");
    const resetAt = performance.now();
    // The process and the match each started their window at the reset.
    const after = (await httpJson(port, "/metrics")).body as Metrics;
    // Without the reset it would hold the ≥ 0.8 s since the discard (the metrics lines came first).
    expect(after.process.runS).toBeLessThan((performance.now() - resetAt) / 1000 + 0.3);
    expect(after.process.tickUs.count).toBeLessThan(metrics.process.tickUs.count);
    expect(after.matches.main.tickUs.count).toBeLessThan(metrics.matches.main.tickUs.count);
    expect(after.matches.main.snapshots).toBeLessThan(metrics.matches.main.snapshots);
    expect(lines.find((l) => l.ev === "console")?.text).toBe(
      "metrics reset: the process and 1 match",
    );
    expect(lines.filter((l) => l.ev === "metrics_reset").map((l) => l.reason)).toEqual([
      "discard",
      "console",
    ]);

    await server.stop("SIGTERM");
    running = null;
    const file = JSON.parse(readFileSync(out, "utf8")) as {
      buildHash: string;
      process: { passes: number; runS: number; tickUs: { count: number } };
      matches: { main: { map: string } };
    };
    expect(file.buildHash).toBe(server.buildHash);
    // The passes and the tick histogram cover the same window: the one since the reset.
    expect(file.process.passes).toBe(file.process.tickUs.count);
    expect(file.process.runS).toBeLessThan((performance.now() - resetAt) / 1000 + 0.3);
    expect(file.matches.main.map).toBe("arena_greybox");
    expect(lines.find((l) => l.ev === "metrics_written")).toMatchObject({ file: out });
  });

  it("refuses unknown paths and query strings with HTTP 404 before any socket opens", async () => {
    const { port, lines } = await start();
    const connects = () => lines.filter((l) => l.ev === "connect").length;
    expect(await upgradeStatus(port, "/")).toBe(101);
    await until(() => connects() === 1, "the accepted upgrade's connect line");
    expect(await upgradeStatus(port, "/m/main")).toBe(404);
    expect(await upgradeStatus(port, "/nope")).toBe(404);
    expect(await upgradeStatus(port, "/?connect=1")).toBe(404);
    expect(await upgradeStatus(port, "//")).toBe(404);
    // None of the refused upgrades reached a match.
    expect(connects()).toBe(1);
    expect((await httpJson(port, "/nope")).status).toBe(404);
    expect((await httpJson(port, "/status", "POST")).status).toBe(405);
  });

  it("builds the listener in noServer mode behind one upgrade handler", async () => {
    const { server } = await start();
    const wss = server.listener.wss as unknown as { options: Record<string, unknown> };
    expect(wss.options).toMatchObject({
      noServer: true,
      maxPayload: 2048,
      perMessageDeflate: false,
      clientTracking: false,
      skipUTF8Validation: true,
      autoPong: false,
    });
    expect(server.listener.http.listenerCount("upgrade")).toBe(1);
  });

  it("from source, lets another build in with a warning (sv_strictBuild 0, D-031)", async () => {
    const { server, port } = await start();
    expect(server.cvars.get("sv_strictBuild")).toBe(0);
    expect(server.matches.main?.match.strictBuild).toBe(false);
    const c = await client(port);
    c.hello("someone-else");
    await poll(c, () => c.welcomes.length === 1 && c.prints.length === 1, "WELCOME and PRINT");
    expect(c.kicks).toEqual([]);
    expect(c.prints[0]?.text).toMatch(
      new RegExp(`^build someone-else differs from the server's ${server.buildHash};`),
    );
  });

  it("KICKs a client with another build under sv_strictBuild 1, and closes oversized and text frames", async () => {
    const { server, port } = await start(["--set", "sv_strictBuild=1"]);
    const c = await client(port);
    c.hello("someone-else");
    await poll(c, () => c.closed !== null, "kick");
    expect(c.kicks[0]?.reason).toBe(
      `build someone-else does not match the server's ${server.buildHash}`,
    );
    expect((sockets[0] as NodeWsClient).closeCode).toBe(1000);

    const big = await NodeWsClient.connect(`ws://127.0.0.1:${port}/`);
    sockets.push(big);
    big.ws.send(new Uint8Array(2049));
    await until(() => big.closeCode !== null, "1009");
    expect(big.closeCode).toBe(1009);

    const text = await NodeWsClient.connect(`ws://127.0.0.1:${port}/`);
    sockets.push(text);
    text.ws.send("hello");
    await until(() => text.closeCode !== null, "1003");
    expect(text.closeCode).toBe(1003);
  });

  it("applies server.cfg, then the command line, to the server's and the match's cvars", async () => {
    const dir = mkdtempSync(join(tmpdir(), "server-cfg-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(
      join(dir, "test.cfg"),
      [
        "set pm_gravity 500",
        "set pm_jumpVelocity 300",
        "set sv_sendBufferDrop 2048",
        "set sv_sendBufferClose 4096",
        "set sv_port 28700",
      ].join("\n"),
    );
    const { server } = await start([
      "--cfg",
      join(dir, "test.cfg"),
      "--set",
      "pm_gravity=400",
      "--set",
      "sv_sendBufferDrop=3000",
    ]);
    // --port 0 (from start) and the --set flags win over the cfg; the rest comes from the cfg.
    expect(server.cvars.get("sv_port")).toBe(0);
    expect(server.matches.main?.match.cvars.get("pm_gravity")).toBe(400);
    expect(server.matches.main?.match.cvars.get("pm_jumpVelocity")).toBe(300);
    expect(server.cvars.get("sv_sendBufferDrop")).toBe(3000);
    expect(server.cvars.get("sv_sendBufferClose")).toBe(4096);
    // The transports' limits carry them.
    expect(server.listener.limits).toMatchObject({ sendBufferDrop: 3000, sendBufferClose: 4096 });
  });

  it("refuses to start on a bad setting or map", async () => {
    await expect(
      startServer({ args: ["--port", "0", "--set", "sv_nope=1"], cwd: serverDir }),
    ).rejects.toThrow(/--set: unknown cvar sv_nope/);
    await expect(
      startServer({ args: ["--port", "0", "--map", "../x"], cwd: serverDir }),
    ).rejects.toThrow(/not a map id/);
    await expect(
      startServer({ args: ["--port", "0", "--map", "nope"], cwd: serverDir }),
    ).rejects.toThrow(/cannot read/);
    await expect(
      startServer({ args: ["--port", "0", "--cfg", "missing.cfg"], cwd: serverDir }),
    ).rejects.toThrow(/no such file/);
    await expect(
      startServer({ args: ["--port", "0", "--set", "sv_sendBufferClose=2048"], cwd: serverDir }),
    ).rejects.toThrow(/sv_sendBufferClose \(2048\) must be above sv_sendBufferDrop \(32768\)/);
  });
});
