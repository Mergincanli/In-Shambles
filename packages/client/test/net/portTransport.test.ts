import { DevAssertError } from "@game/shared";
import { describe, expect, it } from "vitest";
import { type PortLike, type PortMessageHandler, PortTransport } from "../../src/net/portTransport";

/** One end of a fake MessageChannel: posts queue at the peer until `flush()` dispatches them. */
class FakePort implements PortLike {
  onmessage: PortMessageHandler | null = null;
  peer: FakePort | null = null;
  readonly queue: unknown[] = [];
  transferred = 0;

  postMessage(message: unknown, transfer: ArrayBuffer[]): void {
    this.transferred += transfer.length;
    this.peer?.queue.push(message);
  }

  flush(): void {
    for (const m of this.queue.splice(0)) this.onmessage?.({ data: m });
  }
}

function channel(): [FakePort, FakePort] {
  const a = new FakePort();
  const b = new FakePort();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

function pair() {
  const [ua, ub] = channel();
  const [ra, rb] = channel();
  const a = new PortTransport(ua, ra);
  const b = new PortTransport(ub, rb);
  const flush = () => {
    for (const p of [ua, ub, ra, rb]) p.flush();
  };
  return { a, b, flush, ports: [ua, ub, ra, rb] };
}

describe("PortTransport (docs/05 §3.1, D-026)", () => {
  it("copies and transfers each packet, and delivers on poll with its channel", () => {
    const { a, b, flush, ports } = pair();
    const got: [number[], boolean][] = [];
    b.onMessage((d, len, reliable) => got.push([Array.from(d.subarray(0, len)), reliable]));
    const buf = new Uint8Array([1, 2, 3, 4]);
    a.sendUnreliable(buf, 2);
    buf[0] = 9;
    a.sendReliable(buf, 3);
    flush();
    expect(got).toEqual([]);
    b.poll();
    expect(got).toEqual([
      [[1, 2], false],
      [[9, 2, 3], true],
    ]);
    expect(ports[0]?.transferred).toBe(1);
    expect(ports[2]?.transferred).toBe(1);
    const sa = a.stats();
    const sb = b.stats();
    expect([sa.sent, sa.sentBytes, sb.delivered, sb.deliveredBytes]).toEqual([2, 5, 2, 5]);
  });

  it("refuses bad lengths like every transport", () => {
    const { a } = pair();
    expect(() => a.sendUnreliable(new Uint8Array(4), 0)).toThrow(DevAssertError);
    expect(() => a.sendReliable(new Uint8Array(4), 5)).toThrow(DevAssertError);
  });

  it("closes gracefully: reliable messages sent first arrive, then onClose, then nothing", () => {
    const { a, b, flush } = pair();
    const got: number[] = [];
    let closed: string | null = null;
    b.onMessage((d) => got.push(d[0] as number));
    b.onClose((reason) => {
      closed = reason;
    });
    a.sendReliable(new Uint8Array([7]), 1);
    a.close("bye");
    expect(a.isOpen()).toBe(false);
    a.sendReliable(new Uint8Array([8]), 1);
    flush();
    b.poll();
    expect(got).toEqual([7]);
    expect(closed).toBe("bye");
    expect(b.isOpen()).toBe(false);
    b.sendReliable(new Uint8Array([1]), 1);
    flush();
    b.poll();
    expect(got).toEqual([7]);
  });

  it("ignores data that is neither a packet nor, on the reliable port, a close", () => {
    const { b, ports } = pair();
    const got: number[] = [];
    b.onMessage((d) => got.push(d.length));
    ports[1]?.onmessage?.({ data: "not on this port" });
    ports[3]?.onmessage?.({ data: { x: 1 } });
    b.poll();
    expect(got).toEqual([]);
    expect(b.isOpen()).toBe(true);
  });

  it("queues arrivals in a ring of reused slots that grows by doubling and keeps their order", () => {
    const { a, b, flush } = pair();
    const inboxOf = (t: PortTransport) => (t as unknown as { inbox: unknown[] }).inbox;
    const got: number[] = [];
    b.onMessage((d) => got.push(d[0] as number));
    let next = 0;
    // Wrap the ring several times with partial drains, then overfill it past its slots.
    for (const burst of [10, 10, 10, 40, 3, 70]) {
      for (let i = 0; i < burst; i++) {
        a.sendUnreliable(new Uint8Array([next++ & 0xff]), 1);
        flush();
      }
      b.poll();
    }
    expect(got).toEqual(Array.from({ length: next }, (_, i) => i & 0xff));
    const slots = inboxOf(b);
    expect(slots.length).toBe(128);
    // Steady state: the same slots serve every later poll, and an empty poll touches nothing.
    for (let i = 0; i < 50; i++) {
      a.sendReliable(new Uint8Array([i]), 1);
      flush();
      b.poll();
      b.poll();
    }
    expect(inboxOf(b)).toBe(slots);
    expect(got.length).toBe(next + 50);
  });
});

// The browser wiring (increment 11) passes real MessagePorts: they must fit PortLike.
const _portFits = (p: MessagePort): PortLike => p;
void _portFits;
