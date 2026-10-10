import type { IncomingMessage } from "node:http";
import { type RunningServer, startServer } from "@game/server/node";
import { BitWriter, CmdMsg, encodeCmd, encodeHello, HelloMsg } from "@game/shared";
import { afterEach, describe, expect, it } from "vitest";
import { fromRoot } from "../src/paths";
import { closeAll, TEST_PEER_HEADER, upgrade, upgradeAtOnce } from "../test/net/wsProbe";

// NET-10 (b) (M3 design §5, §2.6, §2.13, D-030, D-041): the Node server in process on real
// sockets, with lowered timeouts via its config: frames past the 2048 B cap and past the client's
// 16384 B receive cap are closed 1009, a text frame 1003, a 1300 B INPUT is struck as oversized
// (six kick), a connection that never says HELLO is KICKed after sv_helloTimeout, a reliable
// flood is closed or kicked, sv_maxPerIp holds for one injected non-loopback address both one
// after another and with 20 upgrades in flight at once (loopback exempt), and sv_allowedOrigins
// refuses other browser origins. Unknown paths and query strings (404), sv_maxTotalClients (503)
// and an upgrade to a match removed mid-handshake (1001) come with several matches (increment
// 17); rcon lockout across reconnects with rcon (increment 14).

const TIMEOUT_MS = 20_000;
const PEER = "203.0.113.7";

let server: RunningServer | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  await server?.stop();
  server = null;
});

/** The server with `sets` (`--set name=value`), counting each upgrade under TEST_PEER_HEADER. */
async function start(sets: readonly string[] = []): Promise<RunningServer> {
  server = await startServer({
    args: ["--port", "0", ...sets.flatMap((s) => ["--set", s])],
    cwd: fromRoot("packages", "server"),
    primer: false,
    peerAddress: (req: IncomingMessage) =>
      (req.headers[TEST_PEER_HEADER] as string | undefined) ?? req.socket.remoteAddress ?? "",
  });
  return server;
}

interface Closed {
  readonly code: number;
  readonly reason: string;
}

/** Opens a WebSocket to `server`; resolves once it is open. */
function open(s: RunningServer): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.listener.port}/`);
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
});
