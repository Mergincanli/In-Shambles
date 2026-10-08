import {
  CHANNEL_RELIABLE,
  type CloseHandler,
  MAX_QUEUED_UNRELIABLE,
  MAX_RELIABLE_BYTES,
  MAX_UNRELIABLE_BYTES,
  type MessageHandler,
  MSG_CHANNEL,
  PACKET_CLOSE,
  PACKET_RELIABLE,
  PacketQueue,
  type Transport,
  TransportStats,
  validPacketLength,
} from "@game/shared";

/** `SocketLike.readyState` values (the WebSocket API's). */
export const WS_CONNECTING = 0;
export const WS_OPEN = 1;

/**
 * The only close code a page may send besides 3000–4999 (the WebSocket API throws on others), so
 * every close this side starts is 1000 with the reason saying why.
 */
export const WS_CLOSE_NORMAL = 1000;
/** RFC 6455 §7.4.1: the connection dropped without a close frame. */
export const WS_CLOSE_ABNORMAL = 1006;

/** Longest close reason in UTF-8 bytes: a close frame's payload is ≤ 125 B, 2 of them the code. */
export const WS_CLOSE_REASON_MAX = 123;

/**
 * Most reliable messages the server may have waiting for the client's next poll (D-030; the
 * server's cap mirrored). The server sends a handful per handshake and almost none after.
 */
export const WS_MAX_QUEUED_RELIABLE = 64;

/** A handler the DOM types declare with an event argument, declared bivariantly to fit them. */
type Handler<E> = { bivarianceHack(event: E): void }["bivarianceHack"];

/**
 * A WebSocket as this module needs it (M3 design §2.6): structural, so the client's net code
 * stays DOM-free (tsconfig.net.json) while the browser's WebSocket, Node's built-in one (bots,
 * tests) or a fake fits. The close event is structural too: Node's types have no CloseEvent.
 */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  /** The WebSocket API takes no view of a SharedArrayBuffer; the transport's bytes never are. */
  send(data: Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  onopen: Handler<unknown> | null;
  onmessage: Handler<{ readonly data: unknown }> | null;
  onclose: Handler<{ readonly code: number; readonly reason: string }> | null;
  onerror: Handler<unknown> | null;
}

/** Due time of every arrival: the inbox is FIFO, both channels interleaved as on the socket. */
const DUE = new Float64Array(1);
const EMPTY = new Uint8Array(0) as Uint8Array<ArrayBuffer>;

function ignoreMessage(_d: Uint8Array, _len: number, _reliable: boolean): void {}
function ignoreClose(_reason: string): void {}

/** UTF-8 length of `s` (no TextEncoder: lib ES2023 only). */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** `reason` cut to at most WS_CLOSE_REASON_MAX UTF-8 bytes, never inside a surrogate pair. */
export function clientCloseReason(reason: string): string {
  let r = reason;
  while (utf8Length(r) > WS_CLOSE_REASON_MAX) {
    r = r.slice(0, -1);
    const last = r.charCodeAt(r.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) r = r.slice(0, -1);
  }
  return r;
}

/**
 * What the player reads when the socket closed from the server's side (M3 design §2.6): the
 * server's reason when it gave one; a refused or failed connection, or one that dropped without a
 * close frame, says so.
 */
export function peerCloseReason(opened: boolean, code: number, reason: string): string {
  if (!opened) return "could not connect to the server";
  if (reason !== "") return reason;
  if (code === WS_CLOSE_ABNORMAL) return "connection lost";
  return `connection closed (${code})`;
}

/**
 * The client end of a WebSocket (docs/05 §3.1, D-030): the browser's, or Node's built-in one for
 * bots and tests. One socket carries both channels with no extra bytes: a message's channel is
 * its type's (`MSG_CHANNEL`), and a type that is no message arrives as unreliable for the
 * connection to strike. Binary frames only.
 *
 * Arrivals are copied into a pooled `PacketQueue` until `poll()`, with the server's caps: at most
 * MAX_QUEUED_UNRELIABLE unreliable messages (the oldest dropped as lost) and
 * WS_MAX_QUEUED_RELIABLE reliable ones (past that the socket closes). An unreliable message over
 * MAX_UNRELIABLE_BYTES is queued as a zero-length message, which no decoder accepts; a message
 * over MAX_RELIABLE_BYTES, or a text frame, closes the socket. The received ArrayBuffer, its
 * event and the view over it are the boundary's allocation (D-030 extends D-026); a send hands the
 * socket a view of the caller's buffer, which the WebSocket API copies before `send` returns.
 *
 * Sends before the socket opens: reliable ones (HELLO) are copied and sent on open, unreliable
 * ones are dropped as lost. `close(reason)` closes with 1000 and the reason cut to 123 B. A close
 * from the server, or one this side forces, is delivered from `poll()` behind what arrived
 * before it, as D-026 asks.
 */
export class WebSocketTransport implements Transport {
  private readonly inbox = new PacketQueue();
  /** Reliable sends made before the socket opened, sent in order once it does. */
  private readonly outbox = new PacketQueue();
  private reliableQueued = 0;
  private messageCb: MessageHandler = ignoreMessage;
  private closeCb: CloseHandler = ignoreClose;
  private readonly counters = new TransportStats();
  private open = true;
  private opened: boolean;
  /** A close is queued behind the arrivals: accept nothing more, deliver it from `poll()`. */
  private closing = false;
  private closingReason = "";
  /**
   * Views of the callers' buffers, one per recent length, reused while buffer and length repeat:
   * the connection encodes every message into one writer, so INPUT, PING and CMD each keep their
   * own view and steady sends allocate nothing here (the WebSocket's own copy is the boundary's).
   * Replaced round-robin when a fifth shape comes.
   */
  private readonly views: Uint8Array<ArrayBuffer>[] = [EMPTY, EMPTY, EMPTY, EMPTY];
  private nextView = 0;

  constructor(private readonly socket: SocketLike) {
    socket.binaryType = "arraybuffer";
    this.opened = socket.readyState === WS_OPEN;
    socket.onopen = () => this.onOpen();
    socket.onmessage = (event) => this.receive(event.data);
    socket.onclose = (event) => this.peerClosed(event.code, event.reason);
    // A failed connection reports an error first; the close (when it comes) says the rest.
    socket.onerror = () => {
      if (!this.opened) this.peerClosed(WS_CLOSE_ABNORMAL, "");
    };
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

  /** Delivers what arrived before this call, in arrival order; a close ends the delivery. */
  poll(): void {
    const inbox = this.inbox;
    let n = inbox.length;
    while (n > 0 && this.open && inbox.length > 0) {
      n--;
      const id = inbox.take();
      const flags = inbox.flagsOf(id);
      if ((flags & PACKET_CLOSE) !== 0) {
        inbox.release(id);
        this.shut();
        this.closeCb(this.closingReason);
        return;
      }
      const len = inbox.lengthOf(id);
      const reliable = (flags & PACKET_RELIABLE) !== 0;
      if (reliable) this.reliableQueued--;
      this.counters.delivered++;
      this.counters.deliveredBytes += len;
      this.messageCb(inbox.bytesOf(id), len, reliable);
      inbox.release(id);
    }
  }

  close(reason = ""): void {
    if (!this.open) return;
    const wasClosing = this.closing;
    this.shut();
    // A forced close already closed the socket.
    if (!wasClosing) this.closeSocket(reason);
  }

  isOpen(): boolean {
    return this.open;
  }

  stats(): TransportStats {
    return this.counters;
  }

  /** Pooled inbox slots (constant after warm-up; the pooling test reads it). */
  poolSize(): number {
    return this.inbox.slotCount;
  }

  private onOpen(): void {
    if (!this.open || this.closing || this.opened) return;
    this.opened = true;
    const out = this.outbox;
    while (out.length > 0) {
      const id = out.take();
      this.socket.send(out.bytesOf(id).subarray(0, out.lengthOf(id)) as Uint8Array<ArrayBuffer>);
      out.release(id);
    }
  }

  private receive(data: unknown): void {
    if (!this.open || this.closing) return;
    if (!(data instanceof ArrayBuffer)) {
      this.fail("binary messages only");
      return;
    }
    // The view is part of the boundary's allocation, with the event and its buffer.
    this.receiveBytes(new Uint8Array(data));
  }

  /**
   * One binary message past the boundary (the socket's `onmessage`; the allocation workload
   * drives it with preallocated views): queued for `poll()` under the caps.
   */
  receiveBytes(bytes: Uint8Array): void {
    if (!this.open || this.closing) return;
    const len = bytes.length;
    if (len > MAX_RELIABLE_BYTES) {
      this.fail("message too big");
      return;
    }
    const inbox = this.inbox;
    if (len > 0 && MSG_CHANNEL[bytes[0] as number] === CHANNEL_RELIABLE) {
      if (this.reliableQueued >= WS_MAX_QUEUED_RELIABLE) {
        this.fail("too many reliable messages");
        return;
      }
      this.reliableQueued++;
      inbox.push(bytes, len, PACKET_RELIABLE, DUE, 0);
      return;
    }
    if (inbox.unreliableLength >= MAX_QUEUED_UNRELIABLE) {
      inbox.dropOldestUnreliable();
      this.counters.lost++;
    }
    inbox.push(bytes, len > MAX_UNRELIABLE_BYTES ? 0 : len, 0, DUE, 0);
  }

  /** The socket closed from the other side (or never opened): delivered behind the arrivals. */
  private peerClosed(code: number, reason: string): void {
    if (!this.open || this.closing) return;
    this.queueClose(peerCloseReason(this.opened, code, reason));
  }

  private send(d: Uint8Array, len: number, reliable: boolean): void {
    if (!this.open || this.closing || !validPacketLength(d, len, reliable)) return;
    if (!this.opened) {
      if (reliable) this.outbox.push(d, len, PACKET_RELIABLE, DUE, 0);
      else this.counters.lost++;
      this.counters.sent++;
      this.counters.sentBytes += len;
      return;
    }
    // A view, no copy: the WebSocket API copies the bytes before send returns (the transport
    // contract tests check it on Node's), so the caller's encode buffer is free again.
    this.socket.send(this.viewOf(d, len));
    this.counters.sent++;
    this.counters.sentBytes += len;
  }

  /** The first `len` bytes of `d` as a cached view (see `views`). */
  private viewOf(d: Uint8Array, len: number): Uint8Array<ArrayBuffer> {
    const views = this.views;
    for (let i = 0; i < views.length; i++) {
      const v = views[i] as Uint8Array<ArrayBuffer>;
      if (v.buffer === d.buffer && v.byteOffset === d.byteOffset && v.length === len) return v;
    }
    const v = d.subarray(0, len) as Uint8Array<ArrayBuffer>;
    views[this.nextView] = v;
    this.nextView = (this.nextView + 1) % views.length;
    return v;
  }

  /** Closes the socket now and tells the user from its next poll. */
  private fail(reason: string): void {
    this.queueClose(reason);
    this.closeSocket(reason);
  }

  private queueClose(reason: string): void {
    this.closing = true;
    this.closingReason = reason;
    this.inbox.push(EMPTY, 0, PACKET_CLOSE, DUE, 0);
  }

  private closeSocket(reason: string): void {
    try {
      this.socket.close(WS_CLOSE_NORMAL, clientCloseReason(reason));
    } catch {
      // Already closing or closed: nothing left to tell the peer.
    }
  }

  private shut(): void {
    this.open = false;
    this.inbox.clear();
    this.outbox.clear();
    this.reliableQueued = 0;
  }
}
