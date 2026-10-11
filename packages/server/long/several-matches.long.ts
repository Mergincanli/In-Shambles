import { mkdtempSync, readdirSync, readFileSync, rmSync, write } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  EVK_SERVER_STATS,
  frameDigest,
  MSG_CVARS,
  validateDemo,
  type WorldFrame,
} from "@game/shared";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { type RunningServer, type StartOptions, startServer } from "../src/node/server";
import { TestClient } from "../test/match/fixtures";
import { httpJson, NodeWsClient, until, upgradeStatus } from "../test/node/wsClient";

// Several matches per process (D-047, M3 design §2.17 and §5 "Several matches"): the Node server
// in process on port 0 with matches `a` (arena_greybox) and `b` (movement_lab), real sockets,
// clients by path. Each match keeps its own map, client ids, snapshots, log lines, metrics, rcon
// scope, block hash and demo files; one loop stall drops ticks in both and is logged once with
// both names; the process limits (sv_maxTotalClients) span both, a full match KICKs, and
// `match_remove` KICKs one match's clients while the other plays on. NET-10 (b)'s listener legs
// for several matches (404, simultaneous upgrades past sv_maxTotalClients, an upgrade to a match
// removed mid-handshake) are in packages/tools/long/net-10-abuse.long.ts; the fast smoke in
// test/node/server.test.ts, the digest isolation in test/node/matchSet.test.ts.

const serverDir = fileURLToPath(new URL("..", import.meta.url));
const TWO = ["--match", "a=arena_greybox", "--match", "b=movement_lab"];
const TIMEOUT_MS = 20_000;

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

/** The two-match server, its log lines parsed and stdin fed through `input`. */
async function start(args: string[] = [], options: StartOptions = {}) {
  const lines: Line[] = [];
  const input = new PassThrough();
  running = await startServer({
    args: ["--port", "0", ...TWO, ...args],
    cwd: serverDir,
    write: (line) => lines.push(JSON.parse(line) as Line),
    console: input,
    primer: false,
    rconPassword: "",
    ...options,
  });
  return { server: running, lines, input, port: running.listener.port };
}

/** A client on `path` that said HELLO, got WELCOME and (unless `ready` is false) READY. */
async function enter(server: RunningServer, path: string, ready = true): Promise<TestClient> {
  const ws = await NodeWsClient.connect(`ws://127.0.0.1:${server.listener.port}${path}`);
  sockets.push(ws);
  const c = new TestClient(ws);
  c.hello(server.buildHash);
  await poll(c, () => c.welcomes.length === 1 || c.closed !== null, "WELCOME");
  if (ready && c.closed === null) {
    c.ready();
    await poll(c, () => c.snapshots.length >= 2, "snapshots");
  }
  return c;
}

function poll(c: TestClient, cond: () => boolean, what: string): Promise<void> {
  return until(() => {
    c.poll();
    return cond();
  }, what);
}

type Metrics = {
  process: { runS: number; connections: number; traffic: { bytesOut: number } };
  matches: Record<string, { runS: number; players: number; traffic: { bytesOut: number } }>;
};

describe("several matches per process (D-047)", () => {
  it(
    "keeps each match's map, ids, players, snapshots, logs, status and metrics apart",
    async () => {
      const { server, lines, port } = await start();
      const a: TestClient[] = [];
      const b: TestClient[] = [];
      // `/` and `/m/a` both reach a, the default match.
      for (const path of ["/", "/m/a", "/m/a"]) a.push(await enter(server, path));
      for (let i = 0; i < 3; i++) b.push(await enter(server, "/m/b"));
      for (const [list, map] of [
        [a, "arena_greybox"],
        [b, "movement_lab"],
      ] as const) {
        expect(list.map((c) => c.welcomes[0]?.mapName)).toEqual([map, map, map]);
        expect(list.map((c) => c.welcomes[0]?.clientId)).toEqual([0, 1, 2]);
      }
      // Every client's newest snapshot holds its own match's world as it saw it: no player of
      // the other match in it, whatever the shared client ids.
      for (const [list, name] of [
        [a, "a"],
        [b, "b"],
      ] as const) {
        await new Promise((r) => setTimeout(r, 100));
        const match = server.matches[name]?.match;
        for (let id = 0; id < list.length; id++) {
          const c = list[id] as TestClient;
          c.poll();
          const snap = c.lastSnapshot();
          const world = match?.history.get(snap.serverTick);
          expect(world, `${name} #${id} tick ${snap.serverTick}`).toBeDefined();
          expect(frameDigest(snap.frame, id)).toBe(frameDigest(world as WorldFrame, id));
          let present = 0;
          for (let s = 0; s < 64; s++) present += snap.frame.present[s] as number;
          expect(present).toBe(3);
          expect(c.bad + c.noBaseline).toBe(0);
        }
      }
      // And not b's: the same ids, other players.
      const snapA = (a[0] as TestClient).lastSnapshot();
      const other = server.matches.b?.match.history.get(snapA.serverTick);
      if (other !== null && other !== undefined) {
        expect(frameDigest(snapA.frame, 0)).not.toBe(frameDigest(other, 0));
      }
      expect(((await httpJson(port, "/status")).body as { matches: unknown[] }).matches).toEqual([
        { name: "a", map: "arena_greybox", players: 3, maxClients: 32 },
        { name: "b", map: "movement_lab", players: 3, maxClients: 32 },
      ]);
      // Match-scoped lines carry their match.
      for (const ev of ["connect", "welcome", "ready"]) {
        const tagged = lines.filter((l) => l.ev === ev).map((l) => l.match);
        expect(tagged.sort(), ev).toEqual(["a", "a", "a", "b", "b", "b"]);
      }
      // SERVER_STATS carry each match's own players.
      await poll(
        b[0] as TestClient,
        () => (b[0] as TestClient).events.some((e) => e.kind === EVK_SERVER_STATS),
        "b's SERVER_STATS",
      );
      expect((b[0] as TestClient).events.find((e) => e.kind === EVK_SERVER_STATS)?.players).toBe(3);
      // Per-match and process metrics: the process's traffic is both matches'.
      const m = (await httpJson(port, "/metrics")).body as Metrics;
      expect(Object.keys(m.matches)).toEqual(["a", "b"]);
      expect([m.matches.a?.players, m.matches.b?.players]).toEqual([3, 3]);
      expect(m.process.connections).toBe(6);
      const sum = (m.matches.a?.traffic.bytesOut ?? 0) + (m.matches.b?.traffic.bytesOut ?? 0);
      // Read in one pass, between ticks: the sum is exact.
      expect(m.process.traffic.bytesOut).toBe(sum);
      expect(server.matches.a?.ticks.run.count).toBeGreaterThan(0);
      expect(server.matches.b?.ticks.run.count).toBe(server.matches.a?.ticks.run.count);
    },
    TIMEOUT_MS,
  );

  it(
    "scopes rcon to the sender's match: metrics reset and a cvar change leave b and the process",
    async () => {
      const { server, lines, input, port } = await start([], { rconPassword: "pw" });
      const a = await enter(server, "/m/a");
      const b = await enter(server, "/m/b");
      const hashB = server.matches.b?.match.cvarHash;
      const hashA = server.matches.a?.match.cvarHash;
      expect(hashA).toBe(hashB);
      await new Promise((r) => setTimeout(r, 100));
      a.cmd('rcon "pw" metrics reset');
      await poll(a, () => a.prints.length === 1, "the reset's reply");
      expect(a.prints[0]?.text).toBe("metrics reset: match a");
      expect(lines.find((l) => l.ev === "metrics_reset")).toMatchObject({ match: "a" });
      const m = (await httpJson(port, "/metrics")).body as Metrics;
      expect((m.matches.b?.runS ?? 0) - (m.matches.a?.runS ?? 0)).toBeGreaterThan(0.08);
      expect(Math.abs(m.process.runS - (m.matches.b?.runS ?? 0))).toBeLessThan(0.001);
      // From b, rcon resets b's window (its own gate and reset): a's and the process's stay.
      await new Promise((r) => setTimeout(r, 100));
      b.cmd('rcon "pw" metrics reset');
      await poll(b, () => b.prints.length === 1, "b's reply");
      expect(b.prints[0]?.text).toBe("metrics reset: match b");
      const runs = async () => {
        const w = (await httpJson(port, "/metrics")).body as Metrics;
        return { p: w.process.runS, a: w.matches.a?.runS ?? 0, b: w.matches.b?.runS ?? 0 };
      };
      let r = await runs();
      expect(r.a - r.b).toBeGreaterThan(0.08);
      expect(r.p - r.a).toBeGreaterThan(0.08);
      // So does stdin's `@b metrics reset`, and nothing else.
      await new Promise((r) => setTimeout(r, 100));
      input.write("@b metrics reset\n");
      await until(() => lines.some((l) => l.ev === "console"), "the console reply");
      expect(lines.find((l) => l.ev === "console")).toMatchObject({
        match: "b",
        text: "metrics reset: match b",
      });
      r = await runs();
      expect(r.a - r.b).toBeGreaterThan(0.16);
      expect(r.p - r.a).toBeGreaterThan(0.08);
      // A wrong password from b is b's client's, at its own address.
      b.cmd('rcon "nope" status');
      await until(() => lines.some((l) => l.ev === "rcon_fail"), "rcon_fail");
      expect(lines.find((l) => l.ev === "rcon_fail")).toMatchObject({
        match: "b",
        client: 0,
        ip: "127.0.0.1",
        failures: 1,
      });
      await poll(b, () => b.prints.length === 2, "b's refusal");

      const cvarsB = b.cvars.length;
      b.typeLog = [];
      const cvarsA = a.cvars.length;
      a.cmd('rcon "pw" set pm_gravity 400');
      await poll(a, () => a.cvars.length === cvarsA + 1, "a's CVARS");
      expect(server.matches.a?.match.cvarHash).not.toBe(hashA);
      expect(server.matches.b?.match.cvarHash).toBe(hashB);
      expect(server.matches.b?.match.cvars.get("pm_gravity")).toBe(800);
      // b heard nothing of it.
      await new Promise((r) => setTimeout(r, 100));
      b.poll();
      expect(b.cvars.length).toBe(cvarsB);
      expect(b.typeLog).not.toContain(MSG_CVARS);
    },
    TIMEOUT_MS,
  );

  it(
    "drops a stall's ticks in every match, logged as one tick_drop naming both",
    async () => {
      const { server, lines } = await start();
      await until(() => (server.matches.b?.match.serverTick ?? 0) > 10, "ticks");
      const before = lines.filter((l) => l.ev === "tick_drop").length;
      const droppedBefore = server.loop.stats.dropped;
      const ticksA = server.matches.a?.match.serverTick ?? 0;
      const ticksB = server.matches.b?.match.serverTick ?? 0;
      const t0 = performance.now();
      // Block the event loop: 300 ms is 18 ticks, past the catch-up cap of 5.
      const end = performance.now() + 300;
      while (performance.now() < end) {}
      await until(() => lines.filter((l) => l.ev === "tick_drop").length > before, "tick_drop");
      // Both matches lost the same ticks: they stay in step, and the one line says how many.
      await new Promise((r) => setTimeout(r, 50));
      const a = server.matches.a?.match.serverTick ?? 0;
      const b = server.matches.b?.match.serverTick ?? 0;
      const due = ((performance.now() - t0) * 60) / 1000;
      const drops = lines.filter((l) => l.ev === "tick_drop").slice(before);
      expect(drops).toHaveLength(1);
      expect(drops[0]?.matches).toEqual(["a", "b"]);
      const dropped = drops[0]?.dropped as number;
      expect(dropped).toBe(server.loop.stats.dropped - droppedBefore);
      expect(dropped).toBeGreaterThan(5);
      expect(a - ticksA).toBe(b - ticksB);
      // Every tick due since t0 was either run or dropped (one either side for the edges).
      expect(Math.abs(a - ticksA + dropped - due)).toBeLessThanOrEqual(2);
    },
    TIMEOUT_MS,
  );

  it(
    "routes @<match> lines, lists matches, adds one at runtime, and keeps the last",
    async () => {
      const { server, lines, input, port } = await start();
      const replies = () => lines.filter((l) => l.ev === "console");
      input.write("@b set pm_gravity 600\n@b status\nstatus\nmatch_add c movement_lab 4\n");
      await until(() => replies().length === 4, "the replies");
      expect(server.matches.b?.match.cvars.get("pm_gravity")).toBe(600);
      expect(server.matches.a?.match.cvars.get("pm_gravity")).toBe(800);
      expect(replies().map((l) => l.match)).toEqual(["b", "b", "a", undefined]);
      expect(String(replies()[1]?.text)).toMatch(/^movement_lab, tick \d+, 0 of 32 players$/);
      expect(String(replies()[2]?.text)).toMatch(/^arena_greybox, tick \d+, 0 of 32 players$/);
      expect(replies()[3]?.text).toBe("match c added: movement_lab, 4 players");
      expect(lines.find((l) => l.ev === "match_add")).toMatchObject({
        match: "c",
        map: "movement_lab",
        maxClients: 4,
      });
      // The new match copies the template, not b's change; it plays by path at once.
      expect(server.matches.c?.match.cvars.get("pm_gravity")).toBe(800);
      const c = await enter(server, "/m/c");
      expect(c.welcomes[0]).toMatchObject({ mapName: "movement_lab", clientId: 0 });
      // Its metrics windows start at match_add: c's join is counted, before any /metrics read.
      const mc = ((await httpJson(port, "/metrics")).body as Metrics).matches.c;
      expect(mc?.traffic.bytesOut).toBeGreaterThan(0);
      expect(mc?.players).toBe(1);
      input.write(
        "matches\nmatch_add c movement_lab\nmatch_add e nope\nmatch_add d arena_greybox\n" +
          "@zz status\n@c matches\n",
      );
      await until(() => replies().length === 10, "the second replies");
      expect(
        replies()
          .slice(4)
          .map((l) => l.text),
      ).toEqual([
        "a: arena_greybox, 0 of 32 players\nb: movement_lab, 0 of 32 players\n" +
          "c: movement_lab, 1 of 4 players",
        "match_add: match c exists",
        expect.stringMatching(/^match_add: map nope: cannot read /),
        "match d added: arena_greybox, 32 players",
        "no match zz",
        "matches is a process command: no @<match> prefix",
      ]);
      // sv_maxMatches 4: a fifth is refused.
      input.write("match_add e movement_lab\nmatch_remove a\nmatch_remove b\nmatch_remove c\n");
      input.write("match_remove d\n");
      await until(() => replies().length === 15, "the removals");
      expect(
        replies()
          .slice(10)
          .map((l) => l.text),
      ).toEqual([
        "match_add: the server runs sv_maxMatches 4 matches",
        "match a removed (0 kicked)",
        "match b removed (0 kicked)",
        "match c removed (1 kicked)",
        "match_remove: d is the last match; it cannot be removed",
      ]);
      // `/` now reaches d, the oldest match left.
      expect(server.set.default?.name).toBe("d");
      const d = await enter(server, "/", false);
      expect(d.welcomes[0]?.mapName).toBe("arena_greybox");
      expect(await upgradeStatus(port, "/m/a")).toBe(404);
      expect(((await httpJson(port, "/metrics")).body as Metrics).matches).toHaveProperty("d");
    },
    TIMEOUT_MS,
  );

  it(
    "holds sv_maxTotalClients across matches (503) and KICKs past a full match",
    async () => {
      const { server, port } = await start([
        "--set",
        "sv_maxTotalClients=5",
        "--match",
        "c=movement_lab:2",
      ]);
      const open: TestClient[] = [];
      for (const path of ["/m/a", "/m/b", "/m/b", "/m/c", "/m/c"]) {
        open.push(await enter(server, path, false));
      }
      expect(server.listener.totalConnections).toBe(5);
      expect(await upgradeStatus(port, "/m/a")).toBe(503);
      expect(await upgradeStatus(port, "/m/b")).toBe(503);
      // An unknown name is 404 first, whatever the count.
      expect(await upgradeStatus(port, "/m/zz")).toBe(404);
      // A slot freed anywhere is a connection for any match: the full match c KICKs its third.
      (sockets[0] as NodeWsClient).ws.close();
      await until(() => server.listener.totalConnections === 4, "the freed connection");
      const third = await enter(server, "/m/c", false);
      expect(third.welcomes).toEqual([]);
      await poll(third, () => third.closed !== null, "the kick");
      expect(third.kicks.map((k) => k.reason)).toEqual(["server full"]);
      for (const c of open.slice(1)) expect(c.kicks).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "match_remove b KICKs b's clients 'match closed' while a plays on",
    async () => {
      const { server, lines, input, port } = await start();
      const a = await enter(server, "/m/a");
      const b1 = await enter(server, "/m/b");
      const b2 = await enter(server, "/m/b");
      const tick = server.matches.a?.match.serverTick ?? 0;
      input.write("match_remove b\n");
      await until(() => lines.some((l) => l.ev === "match_remove"), "match_remove");
      expect(lines.find((l) => l.ev === "match_remove")).toMatchObject({ match: "b", kicked: 2 });
      for (const c of [b1, b2]) {
        await poll(c, () => c.closed !== null, "b's close");
        expect(c.kicks.map((k) => k.reason)).toEqual(["match closed"]);
      }
      const kicks = lines.filter((l) => l.ev === "kick");
      expect(kicks.map((l) => [l.match, l.reason])).toEqual([
        ["b", "match closed"],
        ["b", "match closed"],
      ]);
      await poll(a, () => (a.lastSnapshot().serverTick ?? 0) > tick + 30, "a's snapshots");
      expect(a.kicks).toEqual([]);
      expect(a.bad + a.noBaseline).toBe(0);
      const status = (await httpJson(port, "/status")).body as { matches: { name: string }[] };
      expect(status.matches.map((m) => m.name)).toEqual(["a"]);
      const m = (await httpJson(port, "/metrics")).body as Metrics;
      expect(Object.keys(m.matches)).toEqual(["a"]);
      // b's traffic stays in the process's run window.
      expect(m.process.traffic.bytesOut).toBeGreaterThan(m.matches.a?.traffic.bytesOut ?? 0);
      await until(() => server.listener.connections === 1, "b's sockets closed");
    },
    TIMEOUT_MS,
  );

  it(
    "names each match's demo files after it, and flushes a removed match's demo",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "several-matches-demos-"));
      onTestFinished(() => rmSync(root, { recursive: true, force: true }));
      // A slow disk for the first write after `slowNext` is set: b's END flush at match_remove,
      // so shutdown must wait for a removed match's demo, not only for a's.
      let slowNext = false;
      const { server, input, lines } = await start(["--set", "sv_autoRecord=1"], {
        demosDir: join(root, "demos"),
        demoWrite: (fd, buf, off, len, pos, cb) => {
          const ms = slowNext ? 800 : 0;
          slowNext = false;
          setTimeout(() => write(fd, buf, off, len, pos, (e, n) => cb(e, n)), ms);
        },
      });
      expect(server.matches.a?.match.recording).toMatch(
        /^demos\/a-arena_greybox-\d{8}-\d{6}\.demo$/,
      );
      expect(server.matches.b?.match.recording).toMatch(
        /^demos\/b-movement_lab-\d{8}-\d{6}\.demo$/,
      );
      await until(() => (server.matches.b?.match.serverTick ?? 0) > 30, "ticks");
      const sinkB = server.matches.b?.demos.last;
      slowNext = true;
      input.write("@a record extra\nmatch_remove b\n");
      await until(() => lines.some((l) => l.ev === "match_remove"), "match_remove");
      expect(slowNext).toBe(false);
      expect(lines.find((l) => l.ev === "console")).toMatchObject({
        match: "a",
        text: `record: already recording ${server.matches.a?.match.recording}`,
      });
      await server.stop();
      running = null;
      expect(sinkB?.written).toBeGreaterThan(0);
      expect(sinkB?.flushed).toBe(sinkB?.written);
      const files = readdirSync(join(root, "demos")).sort();
      expect(files).toHaveLength(2);
      expect(files[0]).toMatch(/^a-arena_greybox-/);
      expect(files[1]).toMatch(/^b-movement_lab-/);
      for (const f of files) {
        const check = validateDemo(new Uint8Array(readFileSync(join(root, "demos", f))));
        expect(check.ok, check.ok ? f : `${f}: ${check.error}`).toBe(true);
      }
    },
    TIMEOUT_MS,
  );
});
