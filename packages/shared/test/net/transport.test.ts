import { describe, expect, it } from "vitest";
import { DevAssertError } from "../../src/debug/assert";
import { MAX_RELIABLE_BYTES, MAX_UNRELIABLE_BYTES } from "../../src/net/protocol";
import { createLoopbackPair, type LoopbackEndpoint } from "../../src/net/transport";

interface Received {
  bytes: number[];
  reliable: boolean;
}

function collect(end: LoopbackEndpoint): Received[] {
  const got: Received[] = [];
  end.onMessage((d, len, reliable) =>
    got.push({ bytes: Array.from(d.subarray(0, len)), reliable }),
  );
  return got;
}

function packet(...bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

describe("createLoopbackPair", () => {
  it("delivers on poll only, in send order, both channels interleaved", () => {
    const [a, b] = createLoopbackPair();
    const got = collect(b);
    a.sendUnreliable(packet(1, 2), 2);
    a.sendReliable(packet(3), 1);
    a.sendUnreliable(packet(4, 5, 6), 2);
    expect(got).toEqual([]);
    b.poll();
    expect(got).toEqual([
      { bytes: [1, 2], reliable: false },
      { bytes: [3], reliable: true },
      { bytes: [4, 5], reliable: false },
    ]);
    b.poll();
    expect(got).toHaveLength(3);
  });

  it("copies on send, so the sender may reuse its buffer at once", () => {
    const [a, b] = createLoopbackPair();
    const got = collect(b);
    const buf = packet(7, 7);
    a.sendUnreliable(buf, 2);
    buf[0] = 9;
    a.sendUnreliable(buf, 2);
    b.poll();
    expect(got.map((m) => m.bytes)).toEqual([
      [7, 7],
      [9, 7],
    ]);
  });

  it("works both ways and counts packets and bytes on each side", () => {
    const [a, b] = createLoopbackPair();
    const atA = collect(a);
    const atB = collect(b);
    a.sendReliable(packet(1, 2, 3), 3);
    b.sendUnreliable(packet(4), 1);
    a.poll();
    b.poll();
    expect(atA.map((m) => m.bytes)).toEqual([[4]]);
    expect(atB.map((m) => m.bytes)).toEqual([[1, 2, 3]]);
    expect(a.stats()).toMatchObject({ sent: 1, sentBytes: 3, delivered: 1, deliveredBytes: 1 });
    expect(b.stats()).toMatchObject({ sent: 1, sentBytes: 1, delivered: 1, deliveredBytes: 3 });
    expect(a.stats()).toMatchObject({ lost: 0, duplicated: 0, reordered: 0 });
    expect(a.stats()).toBe(a.stats());
  });

  it("delivers what was queued when poll started; sends from a callback wait", () => {
    const [a, b] = createLoopbackPair();
    const got: number[] = [];
    b.onMessage((d) => {
      got.push(d[0] as number);
      if (d[0] === 1) a.sendUnreliable(packet(2), 1);
    });
    a.sendUnreliable(packet(1), 1);
    b.poll();
    expect(got).toEqual([1]);
    b.poll();
    expect(got).toEqual([1, 2]);
  });

  it("survives a poll from inside a callback, and keeps its pool intact", () => {
    const [a, b] = createLoopbackPair();
    const got: number[] = [];
    let depth = 0;
    b.onMessage((d) => {
      got.push(d[0] as number);
      if (depth++ === 0) b.poll();
    });
    a.sendUnreliable(packet(1), 1);
    a.sendUnreliable(packet(2), 1);
    a.sendUnreliable(packet(3), 1);
    b.poll();
    expect(got).toEqual([1, 2, 3]);
    expect(b.stats()).toMatchObject({ delivered: 3, deliveredBytes: 3 });
    for (let i = 0; i < 40; i++) a.sendUnreliable(packet(i), 1);
    b.poll();
    expect(got).toHaveLength(43);
  });

  it("refuses empty, oversized and out-of-buffer packets (a sender bug)", () => {
    const [a, b] = createLoopbackPair();
    const got = collect(b);
    expect(() => a.sendUnreliable(packet(1), 0)).toThrow(DevAssertError);
    expect(() => a.sendUnreliable(packet(1), 2)).toThrow(DevAssertError);
    expect(() => a.sendUnreliable(packet(1, 2), 1.5)).toThrow(DevAssertError);
    expect(() => a.sendUnreliable(packet(1), Number.NaN)).toThrow(DevAssertError);
    expect(() =>
      a.sendUnreliable(new Uint8Array(MAX_UNRELIABLE_BYTES + 1), MAX_UNRELIABLE_BYTES + 1),
    ).toThrow(DevAssertError);
    expect(() =>
      a.sendReliable(new Uint8Array(MAX_RELIABLE_BYTES + 1), MAX_RELIABLE_BYTES + 1),
    ).toThrow(DevAssertError);
    a.sendUnreliable(new Uint8Array(MAX_UNRELIABLE_BYTES), MAX_UNRELIABLE_BYTES);
    a.sendReliable(new Uint8Array(MAX_RELIABLE_BYTES), MAX_RELIABLE_BYTES);
    b.poll();
    expect(got.map((m) => m.bytes.length)).toEqual([MAX_UNRELIABLE_BYTES, MAX_RELIABLE_BYTES]);
    expect(a.stats().sent).toBe(2);
  });

  it("pools its slots: no new slot or buffer after warm-up", () => {
    const [a, b] = createLoopbackPair();
    const seen = new Set<Uint8Array>();
    b.onMessage((d) => seen.add(d));
    const big = new Uint8Array(MAX_RELIABLE_BYTES);
    const packet = new Uint8Array(MAX_UNRELIABLE_BYTES);
    const round = (i: number, reliableEvery: number) => {
      // Up to 40 packets in flight, of every unreliable size.
      const n = 1 + (i % 40);
      for (let k = 0; k < n; k++)
        a.sendUnreliable(packet, 1 + ((i * 41 + k) % MAX_UNRELIABLE_BYTES));
      if (i % reliableEvery === 0) a.sendReliable(packet, 1 + (i % MAX_UNRELIABLE_BYTES));
      b.poll();
    };
    // Round 119 is the first to hold 41 packets at once (40 unreliable and a reliable one).
    for (let i = 0; i < 280; i++) round(i, 7);
    const pool = b.poolSize();
    const buffers = seen.size;
    expect(buffers).toBeLessThanOrEqual(pool);
    for (let i = 280; i < 5000; i++) round(i, 7);
    expect(b.poolSize()).toBe(pool);
    expect(seen.size).toBe(buffers);
    // A reliable message past the unreliable limit grows one slot, once per slot at most.
    for (let i = 0; i < 2000; i++) {
      round(i, 1);
      if (i % 16 === 0) a.sendReliable(big, 2000 + i);
      b.poll();
    }
    expect(b.poolSize()).toBe(pool);
    expect(seen.size).toBeGreaterThan(buffers);
    expect(seen.size).toBeLessThanOrEqual(2 * pool);
  });

  describe("close", () => {
    it("the peer gets what was sent before the close, then onClose with the reason", () => {
      const [a, b] = createLoopbackPair();
      const got = collect(b);
      const closes: string[] = [];
      b.onClose((reason) => closes.push(reason));
      a.sendReliable(packet(1), 1);
      a.close("kicked: bad version");
      a.sendReliable(packet(2), 1);
      expect(a.isOpen()).toBe(false);
      expect(b.isOpen()).toBe(true);
      b.poll();
      expect(got.map((m) => m.bytes)).toEqual([[1]]);
      expect(closes).toEqual(["kicked: bad version"]);
      expect(b.isOpen()).toBe(false);
      b.poll();
      expect(closes).toHaveLength(1);
    });

    it("drops what the closing side had not yet delivered, and later sends both ways", () => {
      const [a, b] = createLoopbackPair();
      const atA = collect(a);
      const closesA: string[] = [];
      a.onClose((reason) => closesA.push(reason));
      b.sendUnreliable(packet(1), 1);
      a.close();
      b.sendUnreliable(packet(2), 1);
      a.poll();
      b.poll();
      b.sendUnreliable(packet(3), 1);
      a.poll();
      expect(atA).toEqual([]);
      expect(closesA).toEqual([]);
      expect(b.stats().sent).toBe(1);
      a.close();
      b.close();
    });

    it("closing from inside a callback stops the delivery at once", () => {
      const [a, b] = createLoopbackPair();
      const got: number[] = [];
      b.onMessage((d) => {
        got.push(d[0] as number);
        b.close();
      });
      a.sendUnreliable(packet(1), 1);
      a.sendUnreliable(packet(2), 1);
      b.poll();
      expect(got).toEqual([1]);
      expect(a.isOpen()).toBe(true);
      a.poll();
      expect(a.isOpen()).toBe(false);
    });

    it("a reply sent by the peer before it saw the close is dropped", () => {
      const [a, b] = createLoopbackPair();
      const atA = collect(a);
      a.close("bye");
      b.sendReliable(packet(9), 1);
      b.poll();
      a.poll();
      expect(atA).toEqual([]);
      expect(b.stats().sent).toBe(0);
    });
  });
});
