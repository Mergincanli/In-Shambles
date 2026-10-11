import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type RunningServer, startServer } from "@game/server/node";
import {
  BitReader,
  BitWriter,
  CmdMsg,
  decodePrint,
  encodeCmd,
  encodeHello,
  HelloMsg,
  MSG_PRINT,
  PrintMsg,
} from "@game/shared";
import { afterEach, describe, expect, it } from "vitest";
import { fromRoot } from "../src/paths";
import { closeAll, TEST_PEER_HEADER, upgrade, upgradeAtOnce } from "../test/net/wsProbe";

type HandleUpgrade = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  cb: (ws: unknown) => void,
) => void;

// NET-10 (b) (M3 design §5, §2.6, §2.13, D-030, D-041): the Node server in process on real
// sockets, with lowered timeouts via its config: frames past the 2048 B cap and past the client's
// 16384 B receive cap are closed 1009, a text frame 1003, a 1300 B INPUT is struck as oversized
// (six kick), a connection that never says HELLO is KICKed after sv_helloTimeout, a reliable
// flood is closed or kicked, sv_maxPerIp holds for one injected non-loopback address both one
// after another and with 20 upgrades in flight at once (loopback exempt), and sv_allowedOrigins
// refuses other browser origins. With several matches (D-047): unknown paths, names and query
// strings get 404 before any socket opens, sv_maxTotalClients holds across matches with N
// upgrades at once (exactly the limit admitted, the rest 503) and counts handshakes still in
// flight, and an upgrade whose match is removed while its handshake is in flight closes 1001
// "match closed". rcon's lockout (D-042) holds per address across reconnects: a fresh session
// does not reset it, and a locked address is refused even with the right password.

const TIMEOUT_MS = 20_000;

/** Holds every handshake `s` starts, as a slow client's would be, until the test runs its entry. */
function holdHandshakes(s: RunningServer): (() => void)[] {
  const wss = (s.listener as unknown as { wss: { handleUpgrade: HandleUpgrade } }).wss;
  const real = wss.handleUpgrade.bind(wss);
  const held: (() => void)[] = [];
  wss.handleUpgrade = (...a) => {
    held.push(() => real(...a));
  };
  return held;
}
const PEER = "203.0.113.7";

let server: RunningServer | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  await server?.stop();
  server = null;
});

/** The server with `sets` (`--set name=value`), counting each upgrade under TEST_PEER_HEADER. */
async function start(
  sets: readonly string[] = [],
  rconPassword = "",
  write?: (line: string) => void,
  args: readonly string[] = [],
): Promise<RunningServer> {
  server = await startServer({
    args: ["--port", "0", ...sets.flatMap((s) => ["--set", s]), ...args],
    cwd: fromRoot("packages", "server"),
    primer: false,
    rconPassword,
    ...(write === undefined ? {} : { write }),
    peerAddress: (req: IncomingMessage) =>
      (req.headers[TEST_PEER_HEADER] as string | undefined) ?? req.socket.remoteAddress ?? "",
  });
  return server;
}

interface Closed {
  readonly code: number;
  readonly reason: string;
}

/** Opens a WebSocket to `server` on `path`; resolves once it is open. */
function open(s: RunningServer, path = "/"): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.listener.port}${path}`);
    ws.binaryType = "arraybuffer";
    sockets.push(ws);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("could not open"));
  });
}

/** Resolves with the close the server sent `ws`. */
function closed(ws: WebSocket): Promise<Closed> {
  return new Promise((resolve) => {
    ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason }));
  });
}

function helloBytes(build: string): Uint8Array {
  const w = new BitWriter(64);
  const m = new HelloMsg();
  m.buildHash = build;
  encodeHello(w, m);
  return w.bytes.slice(0, w.byteLength);
}

function cmdBytes(text: string): Uint8Array {
  const w = new BitWriter(1100);
  const m = new CmdMsg();
  m.text = text;
  encodeCmd(w, m);
  return w.bytes.slice(0, w.byteLength);
}

/** The rcon replies among the PRINTs `ws` receives (not the strike warning), as they arrive. */
function printsOf(ws: WebSocket): string[] {
  const out: string[] = [];
  const r = new BitReader();
  const m = new PrintMsg();
  ws.addEventListener("message", (e) => {
    const bytes = new Uint8Array(e.data as ArrayBuffer);
    if (bytes[0] !== MSG_PRINT) return;
    r.reset(bytes, bytes.length);
    // The strike warning (two wrong passwords are 20 points, past sv_strikeWarn) is left out.
    if (decodePrint(r, m) && !m.text.startsWith("too many bad packets")) out.push(m.text);
  });
  return out;
}

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("NET-10 (b): abuse on real sockets (D-030, D-041)", () => {
  it(
    "closes oversized frames 1009 and text frames 1003",
    async () => {
      const s = await start();
      for (const [data, code] of [
        [new Uint8Array(2049), 1009],
        [new Uint8Array(16_385), 1009],
        ["a text frame", 1003],
      ] as const) {
        const ws = await open(s);
        const done = closed(ws);
        ws.send(data);
        expect((await done).code, String(data.length)).toBe(code);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "strikes a 1300 B INPUT as oversized: six of them KICK",
    async () => {
      const s = await start();
      const ws = await open(s);
      const done = closed(ws);
      const big = new Uint8Array(1300);
      big[0] = 4;
      for (let i = 0; i < 6; i++) ws.send(big);
      expect(await done).toEqual({ code: 1000, reason: "too many bad packets" });
    },
    TIMEOUT_MS,
  );

  it(
    "KICKs a connection without HELLO at sv_helloTimeout, and one without READY later",
    async () => {
      const s = await start(["sv_helloTimeout=12", "sv_handshakeTimeout=60", "sv_timeout=300"]);
      const silent = await open(s);
      const silentDone = closed(silent);
      const stuck = await open(s);
      const stuckDone = closed(stuck);
      stuck.send(helloBytes(s.buildHash));
      const t0 = performance.now();
      expect(await silentDone).toEqual({ code: 1000, reason: "handshake timed out" });
      // 12 ticks ≈ 0.2 s; generous for a busy host.
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(await stuckDone).toEqual({ code: 1000, reason: "handshake timed out" });
    },
    TIMEOUT_MS,
  );

  it(
    "closes or KICKs a reliable flood",
    async () => {
      const s = await start();
      const ws = await open(s);
      const done = closed(ws);
      ws.send(helloBytes(s.buildHash));
      const cmd = cmdBytes("help");
      for (let i = 0; i < 200; i++) ws.send(cmd);
      const c = await done;
      expect(["1008 too many reliable messages", "1000 too many bad packets"]).toContain(
        `${c.code} ${c.reason}`,
      );
      // The slot is free again.
      await new Promise((r) => setTimeout(r, 100));
      expect(s.matches.main?.match.sessionCount).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    "holds sv_maxPerIp for one address, one after another and 20 at once; loopback is exempt",
    async () => {
      const s = await start(["sv_maxPerIp=8"]);
      const port = s.listener.port;
      const peer = { [TEST_PEER_HEADER]: PEER };
      // One after another: 8 open, the rest 429; closing one lets the next in.
      const seq = [];
      for (let i = 0; i < 20; i++) seq.push(await upgrade(port, peer));
      expect(seq.map((u) => u.status)).toEqual([...Array(8).fill(101), ...Array(12).fill(429)]);
      expect(s.listener.connectionsFrom(PEER)).toBe(8);
      seq[0]?.socket?.destroy();
      for (let i = 0; i < 100 && s.listener.connectionsFrom(PEER) === 8; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const again = await upgrade(port, peer);
      expect(again.status).toBe(101);
      closeAll([...seq, again]);
      for (let i = 0; i < 100 && s.listener.connectionsFrom(PEER) > 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(s.listener.connectionsFrom(PEER)).toBe(0);
      // 20 at once: upgrades in flight count, so exactly 8 get through.
      const burst = await upgradeAtOnce(20, port, peer);
      expect(burst.filter((u) => u.status === 101)).toHaveLength(8);
      expect(burst.filter((u) => u.status === 429)).toHaveLength(12);
      closeAll(burst);
      // Loopback: 20 at once, all admitted (the match KICKs past sv_maxClients, not the listener).
      const local = await upgradeAtOnce(20, port);
      expect(local.every((u) => u.status === 101)).toBe(true);
      closeAll(local);
    },
    TIMEOUT_MS,
  );

  it(
    "refuses browser origins sv_allowedOrigins doesn't list (403); no Origin passes",
    async () => {
      // Entries are matched as browsers send origins: lowercase, no trailing slash.
      const s = await start(["sv_allowedOrigins=https://Play.example/,http://localhost:5173"]);
      const port = s.listener.port;
      const ups = [
        await upgrade(port, { Origin: "https://play.example" }),
        await upgrade(port, { Origin: "http://localhost:5173" }),
        await upgrade(port, { Origin: "https://evil.example" }),
        await upgrade(port),
      ];
      expect(ups.map((u) => u.status)).toEqual([101, 101, 403, 101]);
      closeAll(ups);
    },
    TIMEOUT_MS,
  );
  it(
    "keeps the rcon lockout across reconnects from one address (D-042)",
    async () => {
      const lines: string[] = [];
      const s = await start([], "right one", (line) => lines.push(line));
      const LOCKED = "rcon: too many wrong passwords from your address; wait";
      /** A fresh session past HELLO, and the PRINTs it gets. */
      const session = async () => {
        const ws = await open(s);
        const prints = printsOf(ws);
        ws.send(helloBytes(s.buildHash));
        return { ws, prints };
      };
      const a = await session();
      a.ws.send(cmdBytes("rcon guess-1 status"));
      a.ws.send(cmdBytes("rcon guess-2 status"));
      await until(() => a.prints.length === 2, "two refusals");
      expect(a.prints).toEqual(["rcon: wrong password", "rcon: wrong password"]);
      // A second session from the same address while the first is still there (another client
      // id, so a guard keyed by id would pass it): its strikes start at 0, its rcon failures don't.
      const b = await session();
      b.ws.send(cmdBytes("rcon guess-3 status"));
      b.ws.send(cmdBytes('rcon "right one" status'));
      await until(() => b.prints.length === 2, "the third failure and the lockout");
      const thirdAt = performance.now();
      expect(b.prints).toEqual(["rcon: wrong password", LOCKED]);
      a.ws.close();
      b.ws.close();
      const c = await session();
      c.ws.send(cmdBytes('rcon "right one" status'));
      await until(() => c.prints.length === 1, "the lockout again");
      expect(c.prints).toEqual([LOCKED]);
      // 2^(3 − 3) s after the third failure the right password works again.
      await new Promise((r) => setTimeout(r, Math.max(0, 1050 - (performance.now() - thirdAt))));
      c.ws.send(cmdBytes('rcon "right one" set pm_gravity 400'));
      await until(() => c.prints.length === 2, "the command's reply");
      expect(c.prints[1]).toBe("pm_gravity = 400");
      expect(s.matches.main?.match.cvars.get("pm_gravity")).toBe(400);
      const fails = lines.map((l) => JSON.parse(l)).filter((l) => l.ev === "rcon_fail");
      expect(fails.map((l) => [l.client, l.ip, l.failures, l.lockoutS])).toEqual([
        [0, "127.0.0.1", 1, 0],
        [0, "127.0.0.1", 2, 0],
        [1, "127.0.0.1", 3, 1],
      ]);
      const all = lines.join("\n");
      expect(all).not.toContain("right one");
      expect(all).not.toContain("guess-");
    },
    TIMEOUT_MS,
  );

  it(
    "refuses unknown paths, match names and query strings with 404 before a socket opens (D-047)",
    async () => {
      const s = await start([], "", undefined, ["--match", "a=movement_lab"]);
      const port = s.listener.port;
      const paths = ["/m/b", "/m/a?x", "/?m=a", "/m", "/m/a/", "/match/a", "/m/A", "/x/../m/a"];
      const ups = await Promise.all(paths.map((p) => upgrade(port, {}, p)));
      expect(ups.map((u) => u.status)).toEqual(paths.map(() => 404));
      expect(s.listener.totalConnections).toBe(0);
      expect(s.matches.a?.match.sessionCount).toBe(0);
      const ok = await Promise.all([upgrade(port, {}, "/"), upgrade(port, {}, "/m/a")]);
      expect(ok.map((u) => u.status)).toEqual([101, 101]);
      closeAll(ok);
    },
    TIMEOUT_MS,
  );

  it(
    "admits exactly sv_maxTotalClients of N simultaneous upgrades across matches; the rest get 503 (D-047)",
    async () => {
      const s = await start(["sv_maxTotalClients=5"], "", undefined, [
        "--match",
        "a=movement_lab",
        "--match",
        "b=movement_lab",
      ]);
      const port = s.listener.port;
      // Loopback is exempt from sv_maxPerIp, not from the process's total.
      const ups = await Promise.all([
        ...Array.from({ length: 6 }, () => upgrade(port, {}, "/m/a")),
        ...Array.from({ length: 6 }, () => upgrade(port, {}, "/m/b")),
      ]);
      const statuses = ups.map((u) => u.status);
      expect(statuses.filter((c) => c === 101)).toHaveLength(5);
      expect(statuses.filter((c) => c === 503)).toHaveLength(7);
      expect(s.listener.totalConnections).toBe(5);
      closeAll(ups);
      await until(() => s.listener.totalConnections === 0, "the closed sockets released");
      // Freed: the next ones are admitted again.
      const again = await upgradeAtOnce(5, port, {}, "/m/b");
      expect(again.map((u) => u.status)).toEqual([101, 101, 101, 101, 101]);
      closeAll(again);
    },
    TIMEOUT_MS,
  );

  it(
    "counts upgrades still in their handshake against sv_maxTotalClients (503, D-047)",
    async () => {
      const s = await start(["sv_maxTotalClients=2"], "", undefined, [
        "--match",
        "a=movement_lab",
        "--match",
        "b=movement_lab",
      ]);
      const port = s.listener.port;
      const held = holdHandshakes(s);
      const first = [upgrade(port, {}, "/m/a"), upgrade(port, {}, "/m/b")];
      await until(() => held.length === 2, "the held handshakes");
      // Neither socket is open yet: the third is refused on the two in flight alone.
      expect((await upgrade(port, {}, "/m/a")).status).toBe(503);
      for (const go of held.splice(0)) go();
      const ups = await Promise.all(first);
      expect(ups.map((u) => u.status)).toEqual([101, 101]);
      closeAll(ups);
    },
    TIMEOUT_MS,
  );

  it(
    'closes an upgrade whose match was removed during its handshake 1001 "match closed" (D-047)',
    async () => {
      const s = await start([], "", undefined, [
        "--match",
        "a=movement_lab",
        "--match",
        "b=movement_lab",
        "--match",
        "c=movement_lab",
      ]);
      const held = holdHandshakes(s);
      // `/` names the default match, a, when it asks: a's removal closes it too, rather than
      // handing it to c, the default by the time its handshake completes.
      const closing = [open(s, "/m/b").then(closed), open(s, "/").then(closed)];
      await until(() => held.length === 2, "the held handshakes");
      expect(s.listener.totalConnections).toBe(2);
      expect(s.removeMatch("b")).toEqual({ ok: true, text: "match b removed (0 kicked)" });
      expect(s.removeMatch("a")).toEqual({ ok: true, text: "match a removed (0 kicked)" });
      for (const go of held.splice(0)) go();
      expect(await Promise.all(closing)).toEqual([
        { code: 1001, reason: "match closed" },
        { code: 1001, reason: "match closed" },
      ]);
      expect(s.matches.c?.match.sessionCount).toBe(0);
      await until(() => s.listener.totalConnections === 0, "the sockets released");
    },
    TIMEOUT_MS,
  );
});
