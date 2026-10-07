import { DEV_ASSERT } from "../debug/assert";
import { PLAYER_STATE_RING_CAPACITY } from "../sim/playerState";
import { PACKET_RELIABLE, PacketQueue } from "./packetQueue";
import { MAX_RELIABLE_BYTES, MAX_UNRELIABLE_BYTES } from "./protocol";

/**
 * The transport abstraction (docs/05 §3.1, D-026). One message per packet, as bytes plus a length
 * so senders reuse one encode buffer. Nothing is delivered from inside a send: `poll()` hands the
 * queued messages to the `onMessage` callback at a fixed point of the caller's loop, and `d` is
 * valid only during that callback (the transport reuses it). The reliable channel is ordered and
 * lossless; the unreliable one may lose, duplicate or reorder packets (it does under NetSim), so
 * every protocol rule assumes datagrams (docs/05 §0).
 */
export type MessageHandler = (d: Uint8Array, len: number, reliable: boolean) => void;

/** Called once, from `poll()`, when the other side closed: after what it sent before closing. */
export type CloseHandler = (reason: string) => void;

export interface Transport {
  /** At most MAX_UNRELIABLE_BYTES; inputs, snapshots, pings. */
  sendUnreliable(d: Uint8Array, len: number): void;
  /** At most MAX_RELIABLE_BYTES; handshake, cvars, console text. */
  sendReliable(d: Uint8Array, len: number): void;
  onMessage(cb: MessageHandler): void;
  onClose(cb: CloseHandler): void;
  /** Delivers queued messages (and a close) to the callbacks. */
  poll(): void;
  /**
   * Ends the connection: later sends are dropped and nothing more is delivered here. The other
   * side still receives what this side sent before, then its `onClose` fires.
   */
  close(reason?: string): void;
  isOpen(): boolean;
  /** Live counters (the same object every call). */
  stats(): TransportStats;
}

/**
 * The most unreliable packets a receiver holds for its next `poll()` (docs/05 §3.1). Past it the
 * oldest is dropped as lost, so a receiver that stops polling (a hidden tab, while the Worker
 * keeps sending a snapshot every tick) keeps bounded memory. Two state rings' worth, about 4 s of
 * snapshots: a backlog older than the ring only ends in a hard resync from the newest anyway
 * (§8). Reliable messages are never dropped.
 */
export const MAX_QUEUED_UNRELIABLE = 2 * PLAYER_STATE_RING_CAPACITY;

/**
 * Packet counters as seen by the transport's user: what it sent and what reached its callback.
 * The impairment counts are NetSim's (both directions) and stay 0 elsewhere, except `lost`, which
 * also counts the unreliable packets a receiver dropped past `MAX_QUEUED_UNRELIABLE`.
 */
export class TransportStats {
  sent = 0;
  sentBytes = 0;
  delivered = 0;
  deliveredBytes = 0;
  lost = 0;
  duplicated = 0;
  reordered = 0;

  reset(): void {
    this.sent = 0;
    this.sentBytes = 0;
    this.delivered = 0;
    this.deliveredBytes = 0;
    this.lost = 0;
    this.duplicated = 0;
    this.reordered = 0;
  }
}

function ignoreMessage(_d: Uint8Array, _len: number, _reliable: boolean): void {}
function ignoreClose(_reason: string): void {}

/**
 * Whether `len` is a sendable length for `d` on a channel. Callers drop a bad send: it is a
 * sender bug (the codecs never produce one), asserted in dev builds.
 */
export function validPacketLength(d: Uint8Array, len: number, reliable: boolean): boolean {
  const max = reliable ? MAX_RELIABLE_BYTES : MAX_UNRELIABLE_BYTES;
  if ((len | 0) === len && len >= 1 && len <= max && len <= d.length) return true;
  DEV_ASSERT(false, "packet length out of range for its channel", len);
  return false;
}

/** Due time of every loopback packet: delivery order is send order. */
const NOW = new Float64Array(1);

/**
 * One end of an in-memory connection (`createLoopbackPair`). A send copies into a pooled slot of
 * the peer's inbox, which the peer's `poll()` drains in send order, both channels interleaved as
 * on one socket. After warm-up it allocates nothing.
 */
export class LoopbackEndpoint implements Transport {
  private readonly inbox = new PacketQueue();
  private peer: LoopbackEndpoint | null = null;
  private messageCb: MessageHandler = ignoreMessage;
  private closeCb: CloseHandler = ignoreClose;
  private readonly counters = new TransportStats();
  private open = true;
  /** The peer closed: deliver its last messages, then close here and report `peerReason`. */
  private peerClosed = false;
  private peerReason = "";

  /** @internal Wires the pair; `createLoopbackPair` calls it once. */
  connect(peer: LoopbackEndpoint): void {
    this.peer = peer;
  }

  sendUnreliable(d: Uint8Array, len: number): void {
    this.send(d, len, false);
  }

  sendReliable(d: Uint8Array, len: number): void {
    this.send(d, len, true);
  }

  onMessage(cb: MessageHandler): void {
    this.messageCb = cb;
  }

  onClose(cb: CloseHandler): void {
    this.closeCb = cb;
  }

  /** Delivers the messages queued when it starts; ones sent meanwhile wait for the next poll. */
  poll(): void {
    const inbox = this.inbox;
    let n = inbox.length;
    // `inbox.length` too: a callback may poll again, draining the queue under this loop.
    while (n > 0 && this.open && inbox.length > 0) {
      n--;
      const id = inbox.take();
      const len = inbox.lengthOf(id);
      this.counters.delivered++;
      this.counters.deliveredBytes += len;
      this.messageCb(inbox.bytesOf(id), len, (inbox.flagsOf(id) & PACKET_RELIABLE) !== 0);
      inbox.release(id);
    }
    if (this.open && this.peerClosed && inbox.length === 0) {
      this.open = false;
      this.closeCb(this.peerReason);
    }
  }

  /** Drops what was not yet delivered here; the peer still gets what this side sent before. */
  close(reason = ""): void {
    if (!this.open) return;
    this.open = false;
    this.inbox.clear();
    const peer = this.peer;
    if (peer?.open && !peer.peerClosed) {
      peer.peerClosed = true;
      peer.peerReason = reason;
    }
  }

  isOpen(): boolean {
    return this.open;
  }

  stats(): TransportStats {
    return this.counters;
  }

  /** Pooled slots in this end's inbox (constant after warm-up; the pooling test reads it). */
  poolSize(): number {
    return this.inbox.slotCount;
  }

  private send(d: Uint8Array, len: number, reliable: boolean): void {
    const peer = this.peer;
    if (!this.open || this.peerClosed || peer === null || !peer.open) return;
    if (!validPacketLength(d, len, reliable)) return;
    this.counters.sent++;
    this.counters.sentBytes += len;
    const inbox = peer.inbox;
    if (!reliable && inbox.unreliableLength >= MAX_QUEUED_UNRELIABLE) {
      inbox.dropOldestUnreliable();
      peer.counters.lost++;
    }
    inbox.push(d, len, reliable ? PACKET_RELIABLE : 0, NOW, 0);
  }
}

/** Two connected in-memory endpoints: what one sends, the other's `poll()` delivers. */
export function createLoopbackPair(): [LoopbackEndpoint, LoopbackEndpoint] {
  const a = new LoopbackEndpoint();
  const b = new LoopbackEndpoint();
  a.connect(b);
  b.connect(a);
  return [a, b];
}
