import {
  DevAssertError,
  MAX_QUEUED_UNRELIABLE,
  MAX_RELIABLE_BYTES,
  MAX_UNRELIABLE_BYTES,
  MSG_CMD,
  MSG_HELLO,
  MSG_INPUT,
  MSG_PING,
  MSG_PONG,
  MSG_PRINT,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  type Transport,
} from "@game/shared";
import { expect, it } from "vitest";

/**
 * The transport contract (docs/05 §3.1, D-026, D-030), written once and run against every pair:
 * the loopback, `PortTransport` over a real MessageChannel and `WebSocketTransport` against the
 * server's `WsTransport` over a real localhost socket (M3 design §5 "Transport contract"). The
 * message types are real ones, because a WebSocket takes the channel from the type byte.
 */

/** Two connected ends; `client` speaks as a client (its types), `server` as the server. */
export interface TransportPair {
  readonly client: Transport;
  readonly server: Transport;
  /** Polls both ends until `cond` holds (a real socket needs the event loop to run). */
  settle(cond: () => boolean, what: string): Promise<void>;
  dispose(): Promise<void>;
}

/** One delivery as the receiver saw it (a copy: `d` is only valid during the callback). */
export interface Arrival {
  readonly bytes: number[];
  readonly reliable: boolean;
}

/** Records what `t` delivers and its close reason. */
export function record(t: Transport): { got: Arrival[]; closed: string[] } {
  const got: Arrival[] = [];
  const closed: string[] = [];
  t.onMessage((d, len, reliable) => got.push({ bytes: [...d.subarray(0, len)], reliable }));
  t.onClose((reason) => closed.push(reason));
  return { got, closed };
}

/** A message of `type`, `len` bytes, its payload numbered by `seq`. */
export function message(type: number, len: number, seq: number): Uint8Array {
  const d = new Uint8Array(len);
  d[0] = type;
  for (let i = 1; i < len; i++) d[i] = (seq + i) & 0xff;
  return d;
}

/** Resolves once `cond()` holds after `poll()`, checking every 2 ms; rejects after `ms`. */
export async function settleBy(
  poll: () => void,
  cond: () => boolean,
  what: string,
  ms = 3000,
): Promise<void> {
  const until = performance.now() + ms;
  for (;;) {
    poll();
    if (cond()) return;
    if (performance.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** The contract's cases for one kind of pair, inside the caller's `describe`. */
export function transportContract(makePair: () => Promise<TransportPair>): void {
  it("delivers reliable messages in order, both ways, byte for byte", async () => {
    const p = await makePair();
    try {
      const atServer = record(p.server);
      const atClient = record(p.client);
      for (let i = 0; i < 40; i++) {
        const c = message(MSG_CMD, 3 + i * 25, i);
        p.client.sendReliable(c, c.length);
        const s = message(MSG_PRINT, 3 + i * 30, i);
        p.server.sendReliable(s, s.length);
      }
      await p.settle(() => atServer.got.length === 40 && atClient.got.length === 40, "40 + 40");
      for (let i = 0; i < 40; i++) {
        expect(atServer.got[i]).toEqual({
          bytes: [...message(MSG_CMD, 3 + i * 25, i)],
          reliable: true,
        });
        expect(atClient.got[i]).toEqual({
          bytes: [...message(MSG_PRINT, 3 + i * 30, i)],
          reliable: true,
        });
      }
    } finally {
      await p.dispose();
    }
  });

  it("carries both channels, each message flagged with its own", async () => {
    const p = await makePair();
    try {
      const atServer = record(p.server);
      const atClient = record(p.client);
      const up = [MSG_HELLO, MSG_INPUT, MSG_CMD, MSG_PING];
      const down = [MSG_WELCOME, MSG_SNAPSHOT, MSG_PRINT, MSG_PONG];
      for (let i = 0; i < 4; i++) {
        const u = message(up[i] as number, 20, i);
        if (i % 2 === 0) p.client.sendReliable(u, u.length);
        else p.client.sendUnreliable(u, u.length);
        const d = message(down[i] as number, 30, i);
        if (i % 2 === 0) p.server.sendReliable(d, d.length);
        else p.server.sendUnreliable(d, d.length);
      }
      await p.settle(() => atServer.got.length === 4 && atClient.got.length === 4, "4 + 4");
      // Unreliable messages may overtake reliable ones (two MessagePorts), so compare by type.
      const byType = (got: Arrival[]) =>
        got.map((a) => [a.bytes[0], a.reliable]).sort((x, y) => Number(x[0]) - Number(y[0]));
      expect(byType(atServer.got)).toEqual([
        [MSG_HELLO, true],
        [MSG_INPUT, false],
        [MSG_PING, false],
        [MSG_CMD, true],
      ]);
      expect(byType(atClient.got)).toEqual([
        [MSG_WELCOME, true],
        [MSG_SNAPSHOT, false],
        [MSG_PONG, false],
        [MSG_PRINT, true],
      ]);
      expect(p.client.stats()).toMatchObject({ sent: 4, sentBytes: 80, delivered: 4 });
      expect(p.server.stats()).toMatchObject({ sent: 4, sentBytes: 120, delivered: 4 });
    } finally {
      await p.dispose();
    }
  });

  it("copies on send: the sender's buffer is free again when the send returns", async () => {
    const p = await makePair();
    try {
      const atServer = record(p.server);
      const buf = new Uint8Array(64);
      for (let i = 0; i < 20; i++) {
        buf.set(message(i % 2 === 0 ? MSG_INPUT : MSG_CMD, 64, i));
        if (i % 2 === 0) p.client.sendUnreliable(buf, 40);
        else p.client.sendReliable(buf, 64);
        buf.fill(0xee);
      }
      await p.settle(() => atServer.got.length === 20, "20 messages");
      const sorted = [...atServer.got].sort(
        (a, b) => (a.bytes[1] as number) - (b.bytes[1] as number),
      );
      for (let i = 0; i < 20; i++) {
        const want = message(i % 2 === 0 ? MSG_INPUT : MSG_CMD, 64, i).subarray(
          0,
          i % 2 === 0 ? 40 : 64,
        );
        expect(sorted[i]?.bytes).toEqual([...want]);
      }
    } finally {
      await p.dispose();
    }
  });

  it("refuses a send past its channel's size, sending nothing", async () => {
    const p = await makePair();
    try {
      const big = message(MSG_INPUT, MAX_RELIABLE_BYTES + 1, 0);
      expect(() => p.client.sendUnreliable(big, MAX_UNRELIABLE_BYTES + 1)).toThrow(DevAssertError);
      expect(() => p.server.sendReliable(big, MAX_RELIABLE_BYTES + 1)).toThrow(DevAssertError);
      expect(() => p.client.sendReliable(big, 0)).toThrow(DevAssertError);
      expect(p.client.stats().sent).toBe(0);
      expect(p.server.stats().sent).toBe(0);
    } finally {
      await p.dispose();
    }
  });

  it("holds at most 256 unreliable messages for a receiver that doesn't poll, and every reliable one", async () => {
    const p = await makePair();
    try {
      const atClient = record(p.client);
      const extra = 20;
      for (let i = 0; i < MAX_QUEUED_UNRELIABLE + extra; i++) {
        const d = message(MSG_SNAPSHOT, 42, i);
        p.server.sendUnreliable(d, d.length);
        if (i % 50 === 0) {
          const r = message(MSG_PRINT, 10, i);
          p.server.sendReliable(r, r.length);
        }
      }
      // The drops happen as messages arrive, before any poll.
      await settleBy(
        () => {},
        () => p.client.stats().lost >= extra,
        "the receiver's drops",
      );
      await p.settle(
        () => atClient.got.length === MAX_QUEUED_UNRELIABLE + 6,
        "the newest 256 and 6 reliable",
      );
      expect(p.client.stats().lost).toBe(extra);
      const snaps = atClient.got.filter((a) => !a.reliable);
      // The oldest were dropped: the first kept one is number `extra`.
      expect(snaps[0]?.bytes[1]).toBe((extra + 1) & 0xff);
      expect(atClient.got.filter((a) => a.reliable)).toHaveLength(6);
    } finally {
      await p.dispose();
    }
  });

  it("closes from the client with a reason, after what it sent before", async () => {
    const p = await makePair();
    try {
      const atServer = record(p.server);
      const atClient = record(p.client);
      const c = message(MSG_CMD, 12, 1);
      p.client.sendReliable(c, c.length);
      p.client.close("left the server");
      expect(p.client.isOpen()).toBe(false);
      p.client.sendReliable(c, c.length);
      await p.settle(() => atServer.closed.length === 1, "the server's onClose");
      expect(atServer.got.map((a) => a.bytes[0])).toEqual([MSG_CMD]);
      expect(atServer.closed).toEqual(["left the server"]);
      expect(p.server.isOpen()).toBe(false);
      // Our own close is never reported back to us.
      expect(atClient.closed).toEqual([]);
    } finally {
      await p.dispose();
    }
  });

  it("closes from the server with a reason, after what it sent before", async () => {
    const p = await makePair();
    try {
      const atClient = record(p.client);
      const k = message(MSG_PRINT, 30, 2);
      p.server.sendReliable(k, k.length);
      p.server.close("server shutting down");
      await p.settle(() => atClient.closed.length === 1, "the client's onClose");
      expect(atClient.got.map((a) => a.bytes[0])).toEqual([MSG_PRINT]);
      expect(atClient.closed).toEqual(["server shutting down"]);
      expect(p.client.isOpen()).toBe(false);
    } finally {
      await p.dispose();
    }
  });
}
