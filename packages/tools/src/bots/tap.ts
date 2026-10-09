import {
  MAX_RELIABLE_BYTES,
  type MessageHandler,
  MSG_SNAPSHOT,
  type Transport,
  type TransportStats,
  wsWireBytes,
} from "@game/shared";

/**
 * A bot's socket traffic (D-036): sits between its net simulator and its `WebSocketTransport`, so
 * it counts what really crosses the socket, payload plus WebSocket framing (a client's frames are
 * masked): every message the server sent down (before the simulated link drops any) and every
 * message the simulator let through up. Snapshots are also counted by size and by kind (full:
 * `baseBack` 0, the header's 6 bits after the type byte and the 32-bit tick).
 */
export class BotTap implements Transport {
  bytesDown = 0;
  bytesUp = 0;
  messagesDown = 0;
  messagesUp = 0;
  snapshots = 0;
  fullSnapshots = 0;
  /** Snapshots by payload size, B. */
  readonly snapshotSizes = new Uint32Array(MAX_RELIABLE_BYTES + 1);

  constructor(readonly inner: Transport) {}

  sendUnreliable(d: Uint8Array, len: number): void {
    const sent = this.inner.stats().sent;
    this.inner.sendUnreliable(d, len);
    if (this.inner.stats().sent > sent) this.up(len);
  }

  sendReliable(d: Uint8Array, len: number): void {
    const sent = this.inner.stats().sent;
    this.inner.sendReliable(d, len);
    if (this.inner.stats().sent > sent) this.up(len);
  }

  onMessage(cb: MessageHandler): void {
    this.inner.onMessage((d, len, reliable) => {
      this.bytesDown += wsWireBytes(len, false);
      this.messagesDown++;
      if (len > 5 && d[0] === MSG_SNAPSHOT) {
        this.snapshots++;
        if (((d[5] as number) & 63) === 0) this.fullSnapshots++;
        const at = Math.min(len, MAX_RELIABLE_BYTES);
        this.snapshotSizes[at] = (this.snapshotSizes[at] as number) + 1;
      }
      cb(d, len, reliable);
    });
  }

  onClose(cb: (reason: string) => void): void {
    this.inner.onClose(cb);
  }

  poll(): void {
    this.inner.poll();
  }

  close(reason?: string): void {
    this.inner.close(reason);
  }

  isOpen(): boolean {
    return this.inner.isOpen();
  }

  stats(): TransportStats {
    return this.inner.stats();
  }

  private up(len: number): void {
    this.bytesUp += wsWireBytes(len, true);
    this.messagesUp++;
  }
}

/** The nearest-rank `percent` percentile of a size histogram (`counts[size]`), 0 when empty. */
export function histogramPercentile(counts: Uint32Array, percent: number): number {
  let n = 0;
  for (let i = 0; i < counts.length; i++) n += counts[i] as number;
  if (n === 0) return 0;
  const rank = Math.max(1, Math.ceil((n * percent) / 100));
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    seen += counts[i] as number;
    if (seen >= rank) return i;
  }
  return counts.length - 1;
}

/** The largest size a histogram holds, 0 when empty. */
export function histogramMax(counts: Uint32Array): number {
  for (let i = counts.length - 1; i >= 0; i--) if ((counts[i] as number) > 0) return i;
  return 0;
}
