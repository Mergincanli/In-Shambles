import {
  CHANNEL_RELIABLE,
  type CloseHandler,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_QUEUED_UNRELIABLE,
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
import type { RawData, WebSocket } from "ws";

/** WebSocket close codes the server sends (RFC 6455 §7.4.1). */
export const WS_CLOSE_NORMAL = 1000;
export const WS_CLOSE_GOING_AWAY = 1001;
export const WS_CLOSE_UNSUPPORTED = 1003;
export const WS_CLOSE_POLICY = 1008;
export const WS_CLOSE_TOO_BIG = 1009;

/** Longest close reason in UTF-8 bytes: a close frame's payload is ≤ 125 B, 2 of them the code. */
export const WS_CLOSE_REASON_MAX = 123;

/**
 * Most reliable messages a client may have waiting for the next poll (D-030; design value). An
 * honest client sends a handful per handshake and almost none after; past it the socket closes.
 */
export const WS_MAX_QUEUED_RELIABLE = 64;

/**
 * Send-buffer limits (`sv_sendBufferDrop`, `sv_sendBufferClose`; ESTIMATEs, docs/06 §8). One
 * object shared by every transport of a listener, so a changed value applies to all.
 */
export class WsLimits {
  /** Past this many bytes waiting in the socket, unreliable sends are dropped (counted lost). */
  sendBufferDrop = 32768;
  /** Past this many, the socket closes 1008 "too slow"; reliable sends never drop. */
  sendBufferClose = 1048576;
}

/**
 * The part of a `ws` WebSocket the transport drives, so the unit tests can pass a fake. The
 * listener wires the socket's events into `receive` and `peerClosed` (`attachWs`).
 */
export interface WsSocket {
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** Due time of every arrival: the inbox is FIFO, both channels interleaved as on the socket. */
const DUE = new Float64Array(1);
const EMPTY = new Uint8Array(0);

function ignoreMessage(_d: Uint8Array, _len: number, _reliable: boolean): void {}
function ignoreClose(_reason: string): void {}

/** `reason` cut to at most WS_CLOSE_REASON_MAX UTF-8 bytes, never inside a surrogate pair. */
export function closeReason(reason: string): string {
  let r = reason;
  while (Buffer.byteLength(r, "utf8") > WS_CLOSE_REASON_MAX) {
    r = r.slice(0, -1);
    const last = r.charCodeAt(r.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) r = r.slice(0, -1);
  }
  return r;
}

/**
 * The server end of a WebSocket (docs/05 §3.1, D-030). One socket carries both channels with no
 * extra bytes: a message's channel is its type's (`MSG_CHANNEL`); a type that is no message
 * arrives as unreliable, and the match strikes it. Binary frames only.
 *
 * Arrivals are copied into a pooled `PacketQueue` until `poll()`: at most MAX_QUEUED_UNRELIABLE
 * unreliable messages (the oldest dropped as lost) and WS_MAX_QUEUED_RELIABLE reliable ones (past
 * that the socket closes 1008). An unreliable message over MAX_UNRELIABLE_BYTES is queued as a
 * zero-length message, which no decoder accepts, so the match strikes it without parsing it.
 *
 * A send copies the packet into one fresh Buffer that `ws` keeps until it is flushed: with the
 * received Buffers, the one allocation per packet at this boundary (D-030 extends D-026's
 * boundary rule). A socket that does not drain loses unreliable sends past
 * `sendBufferDrop` bytes and is closed past `sendBufferClose` (checked on every send and poll).
 *
 * Closing: `close(reason)` (a KICK goes first, from the match) closes the socket with
 * `closeCode` (1000; 1001 at shutdown) and the reason cut to 123 B; nothing more is delivered.
 * A close from the client, or one this side forces (text frame, flood, too slow), is delivered
 * from `poll()` behind what arrived before it, as D-026 asks.
 */
export class WsTransport implements Transport {
  /** The code `close()` sends; the listener sets 1001 when the server shuts down. */
  closeCode = WS_CLOSE_NORMAL;
  private readonly inbox = new PacketQueue();
  private reliableQueued = 0;
  private messageCb: MessageHandler = ignoreMessage;
  private closeCb: CloseHandler = ignoreClose;
  private readonly counters = new TransportStats();
  private open = true;
  /** A close is queued behind the arrivals: accept nothing more, deliver it from `poll()`. */
  private closing = false;
  private closingReason = "";

  constructor(
    private readonly socket: WsSocket,
    private readonly limits: WsLimits,
  ) {}

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

  /**
   * Delivers what arrived before this call, in arrival order; a close ends the delivery. The match
   * polls every session every tick, so the "too slow" limit is checked here too: it holds in every
   * session state, also before the match sends a session anything.
   */
  poll(): void {
    if (this.open && !this.closing && this.socket.bufferedAmount > this.limits.sendBufferClose) {
      this.fail(WS_CLOSE_POLICY, "too slow");
    }
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
    // A forced close already closed the socket with its own code.
    if (!wasClosing) this.closeSocket(this.closeCode, reason);
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

  /**
   * One WebSocket message from the socket (`isBinary` false for a text frame, which closes the
   * socket 1003). `data` is ws's `RawData`: a Buffer with the listener's `nodebuffer` binary
   * type, an ArrayBuffer or fragments otherwise.
   */
  receive(data: Uint8Array | ArrayBuffer | readonly Uint8Array[], isBinary: boolean): void {
    if (!this.open || this.closing) return;
    if (!isBinary) {
      this.fail(WS_CLOSE_UNSUPPORTED, "binary messages only");
      return;
    }
    let bytes: Uint8Array;
    if (data instanceof Uint8Array) bytes = data;
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else bytes = Buffer.concat(data);
    const len = bytes.length;
    // ws refuses bigger frames (maxPayload); a socket without that cap is closed the same way.
    if (len > MAX_CLIENT_MESSAGE_BYTES) {
      this.fail(WS_CLOSE_TOO_BIG, "message too big");
      return;
    }
    const inbox = this.inbox;
    if (len > 0 && MSG_CHANNEL[bytes[0] as number] === CHANNEL_RELIABLE) {
      if (this.reliableQueued >= WS_MAX_QUEUED_RELIABLE) {
        this.fail(WS_CLOSE_POLICY, "too many reliable messages");
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

  /** The socket closed from the other side (or failed): delivered behind what arrived before. */
  peerClosed(code: number, reason: string): void {
    if (!this.open || this.closing) return;
    this.queueClose(reason !== "" ? reason : `connection closed (${code})`);
  }

  private send(d: Uint8Array, len: number, reliable: boolean): void {
    if (!this.open || this.closing || !validPacketLength(d, len, reliable)) return;
    const buffered = this.socket.bufferedAmount;
    if (buffered > this.limits.sendBufferClose) {
      this.fail(WS_CLOSE_POLICY, "too slow");
      return;
    }
    if (!reliable && buffered > this.limits.sendBufferDrop) {
      this.counters.lost++;
      return;
    }
    // One copy (memcpy) that ws keeps until it is flushed; the view is part of that boundary cost.
    this.socket.send(Buffer.from(len === d.length ? d : d.subarray(0, len)));
    this.counters.sent++;
    this.counters.sentBytes += len;
  }

  /** Closes the socket with `code` now and tells the user from its next poll. */
  private fail(code: number, reason: string): void {
    this.queueClose(reason);
    this.closeSocket(code, reason);
  }

  private queueClose(reason: string): void {
    this.closing = true;
    this.closingReason = reason;
    this.inbox.push(EMPTY, 0, PACKET_CLOSE, DUE, 0);
  }

  private closeSocket(code: number, reason: string): void {
    try {
      this.socket.close(code, closeReason(reason));
    } catch {
      // Already closing or closed: nothing left to tell the peer.
    }
  }

  private shut(): void {
    this.open = false;
    this.inbox.clear();
    this.reliableQueued = 0;
  }
}

/**
 * A transport on a `ws` socket that just opened: sets the binary type and feeds the socket's
 * messages and close into it (the listener has already attached `ignoreWsErrors`).
 */
export function attachWs(ws: WebSocket, limits: WsLimits): WsTransport {
  ws.binaryType = "nodebuffer";
  const t = new WsTransport(ws, limits);
  ws.on("message", (data: RawData, isBinary: boolean) => t.receive(data, isBinary));
  ws.on("close", (code: number, reason: Buffer) => t.peerClosed(code, reason.toString("utf8")));
  return t;
}

/** ws emits "error" before it closes a socket (a bad frame, a reset); the close reports it. */
export function ignoreWsErrors(ws: WebSocket): void {
  ws.on("error", ignoreError);
}

function ignoreError(_e: Error): void {}
