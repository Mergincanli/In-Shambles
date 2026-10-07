import {
  type CloseHandler,
  MAX_QUEUED_UNRELIABLE,
  type MessageHandler,
  type Transport,
  TransportStats,
  validPacketLength,
} from "@game/shared";

/**
 * A `MessagePort` as this module needs it: structural, so the client's net code stays DOM-free
 * (tsconfig.net.json) while a real port, or a fake one in tests, fits. The handler is declared
 * bivariantly so a DOM `MessagePort`, whose handler takes a `MessageEvent`, is assignable.
 */
export type PortMessageHandler = {
  bivarianceHack(event: { readonly data: unknown }): void;
}["bivarianceHack"];

export interface PortLike {
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  onmessage: PortMessageHandler | null;
}

/** An arrival waiting for `poll()`: a packet, or the peer's close (`bytes` null). Reused. */
class Arrival {
  bytes: Uint8Array | null = null;
  reliable = false;
  reason = "";
}

/** Initial inbox slots; the ring doubles past them, like the loopback pool. */
const INBOX_SLOTS = 16;

function ignoreMessage(_d: Uint8Array, _len: number, _reliable: boolean): void {}
function ignoreClose(_reason: string): void {}

/**
 * The transport between the page and the server Worker (docs/05 §2, §3.1; D-026): one
 * `MessageChannel` port per channel. A send copies the packet into a fresh ArrayBuffer and
 * transfers it, the one allocation per packet at the postMessage boundary (the receiving side
 * wraps the transferred buffer in its view); arrivals wait in a ring of reused slots until
 * `poll()` hands them to the callback, as on every transport. A port delivers in
 * order and never drops, so the reliable port keeps the reliable channel's contract; the close
 * travels on it as a string, behind every reliable message sent before it. Unreliable packets
 * travel on their own port and may overtake reliable ones, which datagrams allow. Past
 * MAX_QUEUED_UNRELIABLE waiting unreliable packets the oldest is dropped as lost: the page stops
 * polling in a hidden tab while the Worker keeps sending.
 */
export class PortTransport implements Transport {
  /** Ring of arrival slots: `count` waiting from `head`, the length a power of two. */
  private inbox: Arrival[] = [];
  private head = 0;
  private count = 0;
  /** Unreliable packets waiting, capped at MAX_QUEUED_UNRELIABLE (a hidden tab stops polling). */
  private unreliableCount = 0;
  private messageCb: MessageHandler = ignoreMessage;
  private closeCb: CloseHandler = ignoreClose;
  private readonly counters = new TransportStats();
  private open = true;

  constructor(
    private readonly unreliable: PortLike,
    private readonly reliable: PortLike,
  ) {
    for (let i = 0; i < INBOX_SLOTS; i++) this.inbox.push(new Arrival());
    unreliable.onmessage = (event) => this.arrive(event.data, false);
    reliable.onmessage = (event) => this.arrive(event.data, true);
  }

  sendUnreliable(d: Uint8Array, len: number): void {
    this.send(this.unreliable, d, len, false);
  }

  sendReliable(d: Uint8Array, len: number): void {
    this.send(this.reliable, d, len, true);
  }

  onMessage(cb: MessageHandler): void {
    this.messageCb = cb;
  }

  onClose(cb: CloseHandler): void {
    this.closeCb = cb;
  }

  /** Delivers what arrived before this call, in arrival order; a close ends the delivery. */
  poll(): void {
    let n = this.count;
    while (n > 0 && this.open) {
      const inbox = this.inbox;
      const a = inbox[this.head] as Arrival;
      this.head = (this.head + 1) & (inbox.length - 1);
      this.count--;
      n--;
      const bytes = a.bytes;
      a.bytes = null;
      if (bytes === null) {
        const reason = a.reason;
        this.shut();
        this.closeCb(reason);
        break;
      }
      if (!a.reliable) this.unreliableCount--;
      this.counters.delivered++;
      this.counters.deliveredBytes += bytes.length;
      this.messageCb(bytes, bytes.length, a.reliable);
    }
  }

  close(reason = ""): void {
    if (!this.open) return;
    this.reliable.postMessage(reason, []);
    this.shut();
  }

  isOpen(): boolean {
    return this.open;
  }

  stats(): TransportStats {
    return this.counters;
  }

  private shut(): void {
    this.open = false;
    for (let i = 0; i < this.inbox.length; i++) (this.inbox[i] as Arrival).bytes = null;
    this.head = 0;
    this.count = 0;
    this.unreliableCount = 0;
    this.unreliable.onmessage = null;
    this.reliable.onmessage = null;
  }

  private send(port: PortLike, d: Uint8Array, len: number, reliable: boolean): void {
    if (!this.open || !validPacketLength(d, len, reliable)) return;
    const buffer = d.slice(0, len).buffer;
    port.postMessage(buffer, [buffer]);
    this.counters.sent++;
    this.counters.sentBytes += len;
  }

  private arrive(data: unknown, reliable: boolean): void {
    if (!this.open) return;
    if (data instanceof ArrayBuffer) {
      if (!reliable) {
        if (this.unreliableCount >= MAX_QUEUED_UNRELIABLE) this.dropOldestUnreliable();
        this.unreliableCount++;
      }
      this.slot(reliable, "").bytes = new Uint8Array(data);
    } else if (reliable && typeof data === "string") {
      this.slot(reliable, data);
    }
  }

  /**
   * Drops the first waiting unreliable packet as lost, keeping the order of the reliable arrivals
   * ahead of it, so a backlog keeps its newest packets and the ring stops growing.
   */
  private dropOldestUnreliable(): void {
    const inbox = this.inbox;
    const mask = inbox.length - 1;
    let i = 0;
    while (i < this.count && (inbox[(this.head + i) & mask] as Arrival).reliable) i++;
    if (i === this.count) return;
    const dropped = inbox[(this.head + i) & mask] as Arrival;
    dropped.bytes = null;
    for (; i > 0; i--) inbox[(this.head + i) & mask] = inbox[(this.head + i - 1) & mask] as Arrival;
    inbox[this.head] = dropped;
    this.head = (this.head + 1) & mask;
    this.count--;
    this.unreliableCount--;
    this.counters.lost++;
  }

  /** The next free inbox slot, filled with `reliable` and `reason` (`bytes` null). */
  private slot(reliable: boolean, reason: string): Arrival {
    let inbox = this.inbox;
    if (this.count === inbox.length) {
      // Full: unroll the ring into one twice as long.
      const grown: Arrival[] = [];
      for (let i = 0; i < inbox.length; i++) {
        grown.push(inbox[(this.head + i) & (inbox.length - 1)] as Arrival);
      }
      for (let i = inbox.length; i < inbox.length * 2; i++) grown.push(new Arrival());
      this.inbox = grown;
      inbox = grown;
      this.head = 0;
    }
    const a = inbox[(this.head + this.count) & (inbox.length - 1)] as Arrival;
    this.count++;
    a.bytes = null;
    a.reliable = reliable;
    a.reason = reason;
    return a;
  }
}
