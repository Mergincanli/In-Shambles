import { request } from "node:http";
import { connect, type Socket } from "node:net";
import {
  CHANNEL_RELIABLE,
  type CloseHandler,
  type MessageHandler,
  MSG_CHANNEL,
  type Transport,
  TransportStats,
} from "@game/shared";

/**
 * A test client's end of a real WebSocket, on Node's built-in (browser-compatible) WebSocket:
 * the channel comes from the type byte, as on the server. Arrivals wait for `poll()`. Test-only:
 * it allocates freely (the client transport with its contract is increment 2's).
 */
export class NodeWsClient implements Transport {
  readonly arrivals: { bytes: Uint8Array; reliable: boolean }[] = [];
  /** The close event's code and reason once the socket closed. */
  closeCode: number | null = null;
  closeReason = "";
  private messageCb: MessageHandler = () => {};
  private closeCb: CloseHandler = () => {};
  private closeDelivered = false;
  private readonly counters = new TransportStats();

  private constructor(readonly ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      const reliable = bytes.length > 0 && MSG_CHANNEL[bytes[0] as number] === CHANNEL_RELIABLE;
      this.arrivals.push({ bytes, reliable });
    };
    ws.onerror = () => {};
    ws.onclose = (event: { code: number; reason: string }) => {
      this.closeCode = event.code;
      this.closeReason = event.reason;
    };
  }

  /** Opens `url`; rejects if it can't (refused connection or upgrade). */
  static connect(url: string): Promise<NodeWsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new NodeWsClient(ws));
      // Node's WebSocket reports a refused connection or upgrade with an error and no close.
      ws.onerror = () => reject(new Error(`could not open ${url}`));
    });
  }

  sendUnreliable(d: Uint8Array, len: number): void {
    this.send(d, len);
  }

  sendReliable(d: Uint8Array, len: number): void {
    this.send(d, len);
  }

  onMessage(cb: MessageHandler): void {
    this.messageCb = cb;
  }

  onClose(cb: CloseHandler): void {
    this.closeCb = cb;
  }

  poll(): void {
    const batch = this.arrivals.splice(0);
    for (const a of batch) {
      this.counters.delivered++;
      this.messageCb(a.bytes, a.bytes.length, a.reliable);
    }
    if (this.closeCode !== null && !this.closeDelivered) {
      this.closeDelivered = true;
      this.closeCb(this.closeReason);
    }
  }

  close(reason = ""): void {
    this.ws.close(1000, reason);
  }

  isOpen(): boolean {
    return this.closeCode === null;
  }

  stats(): TransportStats {
    return this.counters;
  }

  private send(d: Uint8Array, len: number): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(d.slice(0, len));
    this.counters.sent++;
  }
}

/** Resolves once `cond()` holds, checking every 5 ms; rejects after `ms` with `what`. */
export function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (cond()) resolve();
      else if (Date.now() - start > ms) reject(new Error(`timed out waiting for ${what}`));
      else setTimeout(check, 5);
    };
    check();
  });
}

/** The status code a WebSocket upgrade request to `path` gets (101 when it is accepted). */
export function upgradeStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

/** GETs (or sends `method` to) `path` on the server; resolves with status and parsed JSON body. */
export async function httpJson(
  port: number,
  path: string,
  method = "GET",
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return { status: res.status, body: await res.json() };
}

/** A raw TCP connection upgraded to a WebSocket on `/`, for frames the WebSocket API can't send. */
export interface RawSocket {
  readonly socket: Socket;
  /** Bytes the server sent after its 101 response. */
  received(): number;
}

/** Opens a raw TCP socket on `port`, upgrades it on `/`, and counts what arrives afterwards. */
export function rawUpgrade(port: number): Promise<RawSocket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let head = Buffer.alloc(0);
    let after = 0;
    let upgraded = false;
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => {
      if (upgraded) {
        after += chunk.length;
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      if (!head.subarray(0, 12).toString().endsWith("101")) {
        reject(new Error(`upgrade refused: ${head.toString()}`));
        return;
      }
      upgraded = true;
      after = head.length - end - 4;
      resolve({ socket, received: () => after });
    });
    socket.write(
      "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
  });
}

/** One masked client frame (FIN set) with `opcode` and a payload under 126 bytes. */
export function maskedFrame(opcode: number, payload: Uint8Array): Buffer {
  const mask = [0x12, 0x34, 0x56, 0x78];
  const out = Buffer.alloc(6 + payload.length);
  out[0] = 0x80 | opcode;
  out[1] = 0x80 | payload.length;
  for (let i = 0; i < 4; i++) out[2 + i] = mask[i] as number;
  for (let i = 0; i < payload.length; i++) {
    out[6 + i] = (payload[i] as number) ^ (mask[i & 3] as number);
  }
  return out;
}
