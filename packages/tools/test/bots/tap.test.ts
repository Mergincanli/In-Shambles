import {
  type CloseHandler,
  type MessageHandler,
  MSG_SNAPSHOT,
  type Transport,
  TransportStats,
  wsWireBytes,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { BotTap, histogramMax, histogramPercentile } from "../../src/bots/tap";

// A bot's socket tap (D-036): bytes with WebSocket framing both ways (masked up, not down), only
// the sends the socket took, snapshots by size and by kind (full when the header's baseBack bits,
// byte 5's low 6, are 0), and the size histogram's percentiles the summary reports.

/** A socket stand-in: refuses sends while `refusing`, delivers what a test pushes. */
class FakeSocket implements Transport {
  refusing = false;
  private handler: MessageHandler | null = null;
  private readonly counters = new TransportStats();

  sendUnreliable(_d: Uint8Array, len: number): void {
    this.take(len);
  }
  sendReliable(_d: Uint8Array, len: number): void {
    this.take(len);
  }
  onMessage(cb: MessageHandler): void {
    this.handler = cb;
  }
  onClose(_cb: CloseHandler): void {}
  poll(): void {}
  close(): void {}
  isOpen(): boolean {
    return true;
  }
  stats(): TransportStats {
    return this.counters;
  }
  deliver(d: Uint8Array, reliable = false): void {
    this.handler?.(d, d.length, reliable);
  }
  private take(len: number): void {
    if (this.refusing) return;
    this.counters.sent++;
    this.counters.sentBytes += len;
  }
}

function snapshot(len: number, baseBack: number): Uint8Array {
  const d = new Uint8Array(len);
  d[0] = MSG_SNAPSHOT;
  d[5] = baseBack | 0x40; // bits 6-7 belong to the next field: only the low 6 tell the kind
  return d;
}

describe("BotTap", () => {
  it("counts down bytes with unmasked framing, snapshots by size and full or delta", () => {
    const socket = new FakeSocket();
    const tap = new BotTap(socket);
    const seen: number[] = [];
    tap.onMessage((_d, len) => seen.push(len));
    socket.deliver(snapshot(436, 0));
    socket.deliver(snapshot(200, 3));
    socket.deliver(snapshot(130, 0));
    socket.deliver(new Uint8Array([MSG_SNAPSHOT + 1, 0, 0, 0, 0, 0, 0]), true);
    expect(seen).toEqual([436, 200, 130, 7]);
    expect(tap.messagesDown).toBe(4);
    expect(tap.bytesDown).toBe(
      wsWireBytes(436, false) + wsWireBytes(200, false) + wsWireBytes(130, false) + 7 + 2,
    );
    expect(wsWireBytes(436, false)).toBe(440);
    expect(tap.snapshots).toBe(3);
    expect(tap.fullSnapshots).toBe(2);
    expect(histogramMax(tap.snapshotSizes)).toBe(436);
    expect(histogramPercentile(tap.snapshotSizes, 50)).toBe(200);
  });

  it("counts up bytes with masked framing, only for sends the socket took", () => {
    const socket = new FakeSocket();
    const tap = new BotTap(socket);
    const d = new Uint8Array(64);
    tap.sendUnreliable(d, 55);
    tap.sendReliable(d, 20);
    socket.refusing = true;
    tap.sendUnreliable(d, 55);
    tap.sendReliable(d, 20);
    expect(tap.messagesUp).toBe(2);
    expect(tap.bytesUp).toBe(55 + 6 + 20 + 6);
  });
});

describe("the snapshot size histogram", () => {
  const hist = (sizes: number[]) => {
    const h = new Uint32Array(1200);
    for (const s of sizes) h[s] = (h[s] as number) + 1;
    return h;
  };

  it("is 0 when empty", () => {
    expect(histogramPercentile(hist([]), 50)).toBe(0);
    expect(histogramMax(hist([]))).toBe(0);
  });

  it("takes the nearest rank: the smallest size with at least percent of the counts", () => {
    expect(histogramPercentile(hist([90]), 1)).toBe(90);
    expect(histogramPercentile(hist([90]), 100)).toBe(90);
    // 10 sizes 1..10: p50 is the 5th, p95 the 10th (rank ceil(9.5)), p10 the 1st.
    const ten = hist([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(histogramPercentile(ten, 50)).toBe(5);
    expect(histogramPercentile(ten, 51)).toBe(6);
    expect(histogramPercentile(ten, 95)).toBe(10);
    expect(histogramPercentile(ten, 10)).toBe(1);
    expect(histogramMax(ten)).toBe(10);
    // Repeats count: three 100s and one 900.
    expect(histogramPercentile(hist([100, 100, 100, 900]), 75)).toBe(100);
    expect(histogramPercentile(hist([100, 100, 100, 900]), 76)).toBe(900);
  });
});
