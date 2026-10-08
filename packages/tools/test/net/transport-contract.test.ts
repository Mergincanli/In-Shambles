import { type PortLike, PortTransport, WebSocketTransport } from "@game/client/net";
import {
  listen,
  WsLimits,
  type WsListener,
  type WsSocket,
  type WsTransport,
} from "@game/server/node";
import {
  createLoopbackPair,
  findNetProfile,
  MSG_CMD,
  MSG_CVARS,
  MSG_PING,
  NetSimTransport,
  type Transport,
} from "@game/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { message, record, settleBy, transportContract } from "./transportContract";

// The transport contract on every pair (M3 design §5 "Transport contract", D-026, D-030): the
// in-memory loopback, PortTransport over a real MessageChannel (the Worker's link), and the
// client's WebSocketTransport on Node's built-in WebSocket against the server's WsTransport on a
// real localhost socket. Then what only a WebSocket has: the client's receive cap, a refused
// upgrade, and the net simulator wrapped around a real socket.

describe("transport contract: loopback pair", () => {
  transportContract(async () => {
    const [client, server] = createLoopbackPair();
    return {
      client,
      server,
      settle: (cond, what) => settleBy(() => pollBoth(client, server), cond, what),
      dispose: async () => {},
    };
  });
});

describe("transport contract: PortTransport over a MessageChannel", () => {
  transportContract(async () => {
    const unreliable = new MessageChannel();
    const reliable = new MessageChannel();
    const client = new PortTransport(
      unreliable.port1 as unknown as PortLike,
      reliable.port1 as unknown as PortLike,
    );
    const server = new PortTransport(
      unreliable.port2 as unknown as PortLike,
      reliable.port2 as unknown as PortLike,
    );
    return {
      client,
      server,
      settle: (cond, what) => settleBy(() => pollBoth(client, server), cond, what),
      dispose: async () => {
        for (const port of [unreliable.port1, unreliable.port2, reliable.port1, reliable.port2]) {
          port.close();
        }
      },
    };
  });
});

/** Server ends handed over by the listener, in connection order. */
const accepted: WsTransport[] = [];
let listener: WsListener | null = null;
const opened: WebSocket[] = [];

beforeAll(async () => {
  listener = await listen({
    host: "127.0.0.1",
    port: 0,
    limits: new WsLimits(),
    target: {
      hasMatch: (name) => name === "",
      accept: (_name, t) => accepted.push(t),
      status: () => ({}),
      metrics: () => ({}),
    },
  });
});

afterAll(async () => {
  for (const ws of opened) ws.close();
  await listener?.close(500);
});

/** A client end on Node's WebSocket to the test listener, and the server end it got. */
async function wsPair(path = "/"): Promise<{ client: WebSocketTransport; server: WsTransport }> {
  const before = accepted.length;
  const ws = new WebSocket(`ws://127.0.0.1:${listener?.port}${path}`);
  opened.push(ws);
  const client = new WebSocketTransport(ws);
  // Both ends open: before its open event the client drops unreliable sends (as it should).
  await settleBy(
    () => {},
    () => accepted.length > before && ws.readyState === WebSocket.OPEN,
    "the server end",
  );
  return { client, server: accepted[before] as WsTransport };
}

function pollBoth(a: Transport, b: Transport): void {
  a.poll();
  b.poll();
}

describe("transport contract: WebSocket (client) to WsTransport (server), real localhost socket", () => {
  transportContract(async () => {
    const { client, server } = await wsPair();
    return {
      client,
      server,
      settle: (cond, what) => settleBy(() => pollBoth(client, server), cond, what),
      dispose: async () => {
        client.close();
        server.close();
      },
    };
  });

  it("sends HELLO written before the socket opened, once it opens", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${listener?.port}/`);
    opened.push(ws);
    const client = new WebSocketTransport(ws);
    const hello = message(1, 10, 3);
    client.sendReliable(hello, hello.length);
    const before = accepted.length;
    await settleBy(
      () => {},
      () => accepted.length > before,
      "the server end",
    );
    const atServer = record(accepted[before] as WsTransport);
    await settleBy(
      () => accepted[before]?.poll(),
      () => atServer.got.length === 1,
      "HELLO",
    );
    expect(atServer.got[0]?.bytes).toEqual([...hello]);
    client.close();
  });

  it("closes on a message past 16384 B, after what came before it", async () => {
    const { client, server } = await wsPair();
    const atClient = record(client);
    const cvars = message(MSG_CVARS, 100, 0);
    server.sendReliable(cvars, cvars.length);
    // The server never sends one (its sends stop at 16384 B), so the test reaches past it.
    const socket = (server as unknown as { socket: WsSocket }).socket;
    socket.send(Buffer.from(message(MSG_CVARS, 16385, 0)));
    await settleBy(
      () => client.poll(),
      () => atClient.closed.length === 1,
      "the client's close",
    );
    expect(atClient.got.map((a) => a.bytes.length)).toEqual([100]);
    expect(atClient.closed).toEqual(["message too big"]);
    server.close();
  });

  it("reports a refused upgrade as a failed connection", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${listener?.port}/nowhere`);
    opened.push(ws);
    const client = new WebSocketTransport(ws);
    const atClient = record(client);
    const ping = message(MSG_PING, 3, 0);
    client.sendUnreliable(ping, ping.length);
    await settleBy(
      () => client.poll(),
      () => atClient.closed.length === 1,
      "the close",
    );
    expect(atClient.closed).toEqual(["could not connect to the server"]);
    expect(client.stats().lost).toBe(1);
  });

  it("runs under the net simulator: reliable in order and late, unreliable delayed or lost", async () => {
    const { client: ws, server } = await wsPair();
    const profile = findNetProfile("wan-100-loss1");
    if (profile === undefined) throw new Error("no wan-100-loss1");
    const pump = () => netsim.pump();
    const netsim: NetSimTransport = new NetSimTransport(
      ws,
      profile,
      () => performance.now(),
      7,
      (at) => setTimeout(pump, Math.max(0, at - performance.now())),
    );
    const atServer = record(server);
    const sentAt = performance.now();
    for (let i = 0; i < 100; i++) {
      const d = message(i % 10 === 0 ? MSG_CMD : MSG_PING, 8, i);
      if (i % 10 === 0) netsim.sendReliable(d, d.length);
      else netsim.sendUnreliable(d, d.length);
    }
    const firstAt = { t: 0 };
    await settleBy(
      () => {
        server.poll();
        if (firstAt.t === 0 && atServer.got.length > 0) firstAt.t = performance.now();
      },
      () =>
        atServer.got.filter((a) => a.reliable).length === 10 && performance.now() - sentAt > 300,
      "the reliable ten",
    );
    const reliable = atServer.got.filter((a) => a.reliable).map((a) => a.bytes[1]);
    expect(reliable).toEqual([...Array(10).keys()].map((k) => (k * 10 + 1) & 0xff));
    const unreliable = atServer.got.filter((a) => !a.reliable).length;
    expect(unreliable).toBeLessThanOrEqual(90);
    expect(unreliable + netsim.stats().lost).toBe(90 + netsim.stats().duplicated);
    // One way is 50 ms ± 10 on this profile.
    expect(firstAt.t - sentAt).toBeGreaterThanOrEqual(profile.delayMs - profile.jitterMs - 1);
    netsim.close();
    server.close();
  });
});
