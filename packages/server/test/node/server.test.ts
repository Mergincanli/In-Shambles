import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  write,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { EVK_PLAYER_JOIN, EVK_SERVER_STATS, PROTOCOL_VERSION, validateDemo } from "@game/shared";
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
/** `rconPassword` null: none given, so the server reads SV_RCON_PASSWORD from the environment. */
async function start(
  args: string[] = [],
  console?: NodeJS.ReadableStream,
  rconPassword: string | null = "",
) {
  const lines: Line[] = [];
  running = await startServer({
    args: ["--port", "0", ...args],
    cwd: serverDir,
    write: (line) => lines.push(JSON.parse(line) as Line),
    ...(console === undefined ? {} : { console }),
    primer: false,
    ...(rconPassword === null ? {} : { rconPassword }),
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
    // The pmove primer's time (D-040): 0, as these servers start without it (the process smoke
    // checks a real one).
    expect(lines[0]?.primerMs).toBe(0);
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
    // The kick is its own structured line (D-041), with the strike score it left with.
    expect(lines.slice(at + 1).map(({ t: _t, ...rest }) => rest)).toEqual([
      {
        lvl: "info",
        ev: "kick",
        match: "main",
        client: 0,
        reason: "server shutting down",
        strikes: 0,
      },
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

  it("logs a listening-socket error (EMFILE on accept) and keeps ticking (D-048)", async () => {
    const { server, lines, port } = await start();
    const emfile = Object.assign(new Error("accept EMFILE"), { code: "EMFILE" });
    for (let i = 0; i < 5; i++) server.listener.http.emit("error", emfile);
    // At most one line a second, with the count since the last.
    expect(lines.filter((l) => l.ev === "listener_error")).toEqual([
      expect.objectContaining({ lvl: "error", msg: "accept EMFILE", count: 1 }),
    ]);
    const tick = server.matches.main?.match.serverTick ?? 0;
    await until(() => (server.matches.main?.match.serverTick ?? 0) > tick + 5, "more ticks");
    expect((await httpJson(port, "/status")).status).toBe(200);
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

  it("answers a set of a SERVER cvar that it is a startup setting, not an unknown cvar", async () => {
    const input = new PassThrough();
    const { lines } = await start([], input);
    const replies = () => lines.filter((l) => l.ev === "console");
    input.write("set sv_maxClients 40\nreset sv_timeout\ntoggle sv_strictBuild\nset sv_nope 1\n");
    await until(() => replies().length === 4, "the four console replies");
    const texts = replies().map((l) => [l.lvl, l.text]);
    expect(texts.slice(0, 3)).toEqual(
      ["sv_maxClients", "sv_timeout", "sv_strictBuild"].map((name) => [
        "error",
        `${name} is a startup setting: set it in server.cfg or with --set, then restart the server`,
      ]),
    );
    expect(texts[3]).toEqual(["error", "unknown cvar sv_nope"]);
  });

  it("runs rcon as admin of the sender's match; a wrong password logs rcon_fail with the ip only (D-042)", async () => {
    const input = new PassThrough();
    const { server, lines, port } = await start([], input, "open sesame");
    const c = await client(port);
    c.hello(server.buildHash);
    await poll(c, () => c.welcomes.length === 1, "WELCOME");
    c.ready();
    await poll(c, () => c.snapshots.length >= 5, "snapshots");
    c.cmd("set pm_gravity 400");
    c.cmd('rcon "open sesame" set pm_gravity 400');
    await poll(c, () => c.prints.length === 2, "the replies");
    expect(c.prints.map((p) => p.text)).toEqual([
      "set: only an admin may change server cvars (use rcon set ...)",
      "pm_gravity = 400",
    ]);
    expect(server.matches.main?.match.cvars.get("pm_gravity")).toBe(400);
    // rcon's metrics reset is the match's alone; the process window keeps running.
    await new Promise((r) => setTimeout(r, 60));
    c.cmd('rcon "open sesame" metrics reset');
    await poll(c, () => c.prints.length === 3, "the reset's reply");
    expect(c.prints[2]?.text).toBe("metrics reset: match main");
    expect(lines.find((l) => l.ev === "metrics_reset")).toMatchObject({
      reason: "rcon",
      match: "main",
    });
    type Run = { process: { runS: number }; matches: { main: { runS: number } } };
    const m = (await httpJson(port, "/metrics")).body as Run;
    expect(m.process.runS - m.matches.main.runS).toBeGreaterThan(0.04);
    c.cmd("rcon hunter2 status");
    await poll(c, () => c.prints.length === 4, "the refusal");
    expect(c.prints[3]?.text).toBe("rcon: wrong password");
    expect(lines.find((l) => l.ev === "rcon_fail")).toMatchObject({
      lvl: "warn",
      match: "main",
      client: 0,
      ip: "127.0.0.1",
      failures: 1,
    });
    // stdin's bare metrics reset is the process's and every match's.
    input.write("metrics reset\n");
    await until(() => lines.some((l) => l.ev === "console"), "the console reply");
    expect(lines.find((l) => l.ev === "console")?.text).toBe(
      "metrics reset: the process and 1 match",
    );
    const after = (await httpJson(port, "/metrics")).body as Run;
    expect(Math.abs(after.process.runS - after.matches.main.runS)).toBeLessThan(0.001);
    const text = JSON.stringify(lines);
    expect(text).not.toContain("open sesame");
    expect(text).not.toContain("hunter2");
  });

  it("takes the rcon password from SV_RCON_PASSWORD when no option gives one", async () => {
    const before = process.env.SV_RCON_PASSWORD;
    process.env.SV_RCON_PASSWORD = "from env";
    onTestFinished(() => {
      if (before === undefined) delete process.env.SV_RCON_PASSWORD;
      else process.env.SV_RCON_PASSWORD = before;
    });
    const { server, port } = await start([], undefined, null);
    const c = await client(port);
    c.hello(server.buildHash);
    await poll(c, () => c.welcomes.length === 1, "WELCOME");
    c.cmd('rcon "from env" set pm_gravity 410');
    await poll(c, () => c.prints.length === 1, "the reply");
    expect(c.prints[0]?.text).toBe("pm_gravity = 410");
  });

  it("refuses rcon when no password is set, and a password the client could not send", async () => {
    const { server, port } = await start();
    const c = await client(port);
    c.hello(server.buildHash);
    await poll(c, () => c.welcomes.length === 1, "WELCOME");
    c.cmd('rcon "" status');
    c.cmd("rcon x status");
    await poll(c, () => c.prints.length === 2, "the replies");
    expect(c.prints.map((p) => p.text)).toEqual([
      "rcon is disabled on this server",
      "rcon is disabled on this server",
    ]);
    await server.stop();
    running = null;
    await expect(start([], undefined, 'quo"te')).rejects.toThrow(/double quotes/);
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
    // The pass hands the match its tick times once a second (D-043), on its own 60-pass count, not
    // the metrics timer's: wait for the first report. The client hears the tick-60 SERVER_STATS
    // (zeros when it beats the first report) with itself in it.
    await until(() => (server.matches.main?.match.tickTimes[2] ?? 0) > 0, "reportTickStats");
    await poll(c, () => c.events.some((e) => e.kind === EVK_SERVER_STATS), "SERVER_STATS");
    expect(c.events.find((e) => e.kind === EVK_SERVER_STATS)?.players).toBe(1);
    expect(c.events[0]).toMatchObject({ kind: EVK_PLAYER_JOIN, clientId: 0 });

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
    // The default match by name too (D-047).
    expect(await upgradeStatus(port, "/m/main")).toBe(101);
    await until(() => connects() === 2, "the named upgrade's connect line");
    for (const path of [
      "/nope",
      "/?connect=1",
      "//",
      "/m/nope",
      "/m/",
      "/m/main/",
      "/m/Main",
      "/m/main?x=1",
      "/m/__proto__",
      "/m/constructor",
    ]) {
      expect(await upgradeStatus(port, path), path).toBe(404);
    }
    // None of the refused upgrades reached a match.
    expect(connects()).toBe(2);
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

  it("resolves the flags' relative paths against argsCwd, the default server.cfg against cwd", async () => {
    // main.ts passes INIT_CWD: `pnpm dev:server --cfg x.cfg` typed at the repo root, run by pnpm
    // from packages/server, reads the root's x.cfg and writes --metrics-out there too.
    const typedIn = mkdtempSync(join(tmpdir(), "server-args-cwd-"));
    onTestFinished(() => rmSync(typedIn, { recursive: true, force: true }));
    writeFileSync(join(typedIn, "x.cfg"), "set pm_gravity 450\n");
    const server = await startServer({
      args: ["--port", "0", "--cfg", "x.cfg", "--metrics-out", "out/m.json"],
      cwd: serverDir,
      argsCwd: typedIn,
      primer: false,
      rconPassword: "",
    });
    expect(server.matches.main?.match.cvars.get("pm_gravity")).toBe(450);
    await server.stop();
    expect(existsSync(join(typedIn, "out", "m.json"))).toBe(true);
    expect(existsSync(join(serverDir, "out"))).toBe(false);
    // No --cfg: packages/server/server.cfg (cwd), not one in the typed-in directory.
    writeFileSync(join(typedIn, "server.cfg"), "set pm_gravity 1\n");
    const plain = await startServer({
      args: ["--port", "0"],
      cwd: serverDir,
      argsCwd: typedIn,
      primer: false,
      rconPassword: "",
    });
    expect(plain.matches.main?.match.cvars.get("pm_gravity")).not.toBe(1);
    await plain.stop();
  });
});

describe("sv_autoRecord (D-044)", () => {
  it("records the Node server's whole run, closed by a shutdown that waits for the file", async () => {
    const root = mkdtempSync(join(tmpdir(), "server-autorecord-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const server = await startServer({
      args: ["--port", "0", "--set", "sv_autoRecord=1"],
      cwd: serverDir,
      write: () => {},
      primer: false,
      rconPassword: "",
      demosDir: join(root, "demos"),
      // A slow disk: shutdown must still wait for the file.
      demoWrite: (fd, buf, off, len, pos, cb) =>
        setTimeout(() => write(fd, buf, off, len, pos, (e, n) => cb(e, n)), 150),
    });
    const match = server.matches.main?.match;
    expect(match?.recording).toMatch(/^demos\/main-arena_greybox-\d{8}-\d{6}\.demo$/);
    await until(() => (match?.serverTick ?? 0) > 0, "a tick");
    const demos = server.matches.main?.demos;
    const sink = demos?.last;
    await server.stop();
    // stop() resolves only once the demo is on disk and closed.
    expect(sink?.written).toBeGreaterThan(0);
    expect(sink?.flushed).toBe(sink?.written);
    expect(demos?.pending.size).toBe(0);
    const files = readdirSync(join(root, "demos"));
    expect(files).toHaveLength(1);
    const check = validateDemo(
      new Uint8Array(readFileSync(join(root, "demos", files[0] as string))),
    );
    expect(check.ok, check.ok ? "" : check.error).toBe(true);
  });
});

describe("a refused start (D-044, D-047)", () => {
  it("leaves no demo file behind: a bad cfg line after a record, a bind error, sv_autoRecord", async () => {
    const root = mkdtempSync(join(tmpdir(), "server-refused-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const demosDir = join(root, "demos");
    const run = (port: number, cfg: string) => {
      writeFileSync(join(root, "r.cfg"), cfg);
      return startServer({
        args: ["--port", String(port), "--cfg", join(root, "r.cfg"), "--set", "sv_autoRecord=1"],
        cwd: serverDir,
        primer: false,
        rconPassword: "",
        demosDir,
      });
    };
    const files = () => (existsSync(demosDir) ? readdirSync(demosDir) : []);
    await expect(run(0, "match_add a movement_lab\n@zz status\n")).rejects.toThrow(/no match zz/);
    await expect(
      run(0, "match_add a movement_lab\nmatch_add b movement_lab\n@a record x\n@b nope\n"),
    ).rejects.toThrow(/r\.cfg:4: /);
    expect(files()).toEqual([]);
    const taken = await run(0, "match_add a movement_lab\n");
    onTestFinished(() => taken.stop());
    expect(files()).toHaveLength(1);
    await expect(run(taken.listener.port, "match_add b movement_lab\n")).rejects.toThrow(
      /EADDRINUSE/,
    );
    expect(files()).toHaveLength(1);
  });
});

describe("several matches per process (D-047): the fast smoke", () => {
  it("serves two matches by path, lists them, and removes one with its clients KICKed", async () => {
    const input = new PassThrough();
    const { server, lines, port } = await start(
      ["--match", "a=arena_greybox", "--match", "b=movement_lab:2"],
      input,
    );
    expect(lines[1]?.matches).toEqual([
      { name: "a", map: "arena_greybox" },
      { name: "b", map: "movement_lab" },
    ]);
    // `/` is the default match, the first created; `/m/<name>` any match.
    const a = await client(port, "/");
    const b = await client(port, "/m/b");
    for (const c of [a, b]) c.hello(server.buildHash);
    await poll(a, () => a.welcomes.length === 1, "a's WELCOME");
    await poll(b, () => b.welcomes.length === 1, "b's WELCOME");
    expect([a.welcomes[0]?.mapName, a.welcomes[0]?.clientId]).toEqual(["arena_greybox", 0]);
    expect([b.welcomes[0]?.mapName, b.welcomes[0]?.clientId]).toEqual(["movement_lab", 0]);
    expect(((await httpJson(port, "/status")).body as { matches: unknown[] }).matches).toEqual([
      { name: "a", map: "arena_greybox", players: 1, maxClients: 32 },
      { name: "b", map: "movement_lab", players: 1, maxClients: 2 },
    ]);
    expect(await upgradeStatus(port, "/m/main")).toBe(404);
    expect(lines.filter((l) => l.ev === "connect").map((l) => l.match)).toEqual(["a", "b"]);

    input.write("matches\n@b status\nmatch_remove b\nmatch_remove a\n@a match_remove a\n");
    await until(() => lines.filter((l) => l.ev === "console").length === 5, "the replies");
    const replies = lines.filter((l) => l.ev === "console").map((l) => [l.match, l.text]);
    expect(replies).toEqual([
      [undefined, "a: arena_greybox, 1 of 32 players\nb: movement_lab, 1 of 2 players"],
      ["b", expect.stringMatching(/^movement_lab, tick \d+, 1 of 2 players\n#0 /)],
      [undefined, "match b removed (1 kicked)"],
      [undefined, "match_remove: a is the last match; it cannot be removed"],
      [undefined, "match_remove is a process command: no @<match> prefix"],
    ]);
    expect(lines.find((l) => l.ev === "match_remove")).toMatchObject({ match: "b", kicked: 1 });
    await poll(b, () => b.closed !== null, "b's close");
    expect(b.kicks.map((k) => k.reason)).toEqual(["match closed"]);
    expect(Object.keys(server.matches)).toEqual(["a"]);
    expect(await upgradeStatus(port, "/m/b")).toBe(404);
    // a plays on.
    a.ready();
    await poll(a, () => a.snapshots.length >= 3, "a's snapshots");
    expect(a.kicks).toEqual([]);
  });

  it("builds matches from server.cfg and --match, the template before the first match_add (D-047)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "server-matches-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const cfg = join(dir, "m.cfg");
    writeFileSync(
      cfg,
      [
        "set pm_gravity 700",
        "match_add a arena_greybox",
        // After a match_add: a replicated set goes to the default match, a SERVER one to the
        // process.
        "set pm_jumpVelocity 300",
        "set sv_maxPerIp 5",
        "match_add b movement_lab 2",
        "@b set pm_gravity 500",
        "@b set pm_airAccelerate 5",
        "set pm_airAccelerate 4",
        "@c set sv_cheats 1",
      ].join("\n"),
    );
    const { server } = await start([
      "--cfg",
      cfg,
      "--match",
      "c=movement_lab",
      // The command line overrides the cfg (D-029), its match lines included.
      "--set",
      "pm_airAccelerate=2",
    ]);
    const m = (name: string) => server.matches[name]?.match;
    expect(server.set.list.map((x) => x.name)).toEqual(["a", "b", "c"]);
    expect([m("a")?.cvars.get("pm_gravity"), m("a")?.cvars.get("pm_jumpVelocity")]).toEqual([
      700, 300,
    ]);
    expect([m("b")?.cvars.get("pm_gravity"), m("b")?.cvars.get("pm_jumpVelocity")]).toEqual([
      500, 270,
    ]);
    expect([m("c")?.cvars.get("pm_gravity"), m("c")?.cvars.get("sv_cheats")]).toEqual([700, 1]);
    expect([m("a")?.maxClients, m("b")?.maxClients]).toEqual([32, 2]);
    expect(server.cvars.get("sv_maxPerIp")).toBe(5);
    // Each match its own registry; the template stays as configured.
    expect(server.template.get("pm_gravity")).toBe(700);
    expect(server.template.get("pm_jumpVelocity")).toBe(270);
    for (const name of ["a", "b", "c"]) expect(m(name)?.cvars.get("pm_airAccelerate")).toBe(2);
    expect(server.template.get("pm_airAccelerate")).toBe(2);
  });

  it("refuses a configuration with too many matches, a name twice or a line for no match", async () => {
    const run = (args: string[]) =>
      startServer({ args: ["--port", "0", ...args], cwd: serverDir, primer: false });
    await expect(
      run(["--set", "sv_maxMatches=1", "--match", "a=movement_lab", "--match", "b=movement_lab"]),
    ).rejects.toThrow("2 matches configured; sv_maxMatches is 1");
    await expect(run(["--match", "a=movement_lab", "--match", "a=arena_greybox"])).rejects.toThrow(
      "--match: match a exists",
    );
    await expect(run(["--match", "a=nope"])).rejects.toThrow(/map nope: cannot read/);
    const dir = mkdtempSync(join(tmpdir(), "server-matches-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "x.cfg"), "@x status\n");
    await expect(run(["--cfg", join(dir, "x.cfg")])).rejects.toThrow(/x\.cfg:1: no match x$/);
    writeFileSync(join(dir, "y.cfg"), "@main set sv_port 1\n");
    await expect(run(["--cfg", join(dir, "y.cfg")])).rejects.toThrow(
      /y\.cfg:1: unknown cvar sv_port$/,
    );
  });
});
