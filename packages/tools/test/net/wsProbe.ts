import { request } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

/**
 * Raw WebSocket upgrades for NET-10 (b) (M3 design §5): what the server's one upgrade handler
 * answers (101, or its HTTP refusal) with headers a browser would not let a page choose, the
 * upgraded socket kept open so a test can hold many at once. Test-only: it allocates freely.
 */

/**
 * The header a test's `peerAddress` hook reads to stand for a client address (never the server's
 * own rule).
 */
export const TEST_PEER_HEADER = "x-test-peer";

export interface Upgrade {
  /** 101 when the socket opened, else the HTTP refusal (403, 404, 429, 503). */
  readonly status: number;
  /** The upgraded socket (101 only), open until the test destroys it. */
  readonly socket: Duplex | null;
}

/** Asks `port` to upgrade `path` with `headers` added; resolves with the answer. */
export function upgrade(
  port: number,
  headers: Readonly<Record<string, string>> = {},
  path = "/",
): Promise<Upgrade> {
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
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.on("error", () => {});
      resolve({ status: res.statusCode ?? 0, socket });
    });
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, socket: null });
    });
    req.on("error", reject);
    req.end();
  });
}

/** `n` upgrades of `path` sent at once (none waits for another's answer), in sending order. */
export function upgradeAtOnce(
  n: number,
  port: number,
  headers: Readonly<Record<string, string>> = {},
  path = "/",
): Promise<Upgrade[]> {
  const all: Promise<Upgrade>[] = [];
  for (let i = 0; i < n; i++) all.push(upgrade(port, headers, path));
  return Promise.all(all);
}

/** Destroys every open socket of `ups`. */
export function closeAll(ups: readonly Upgrade[]): void {
  for (const u of ups) u.socket?.destroy();
}

/**
 * An upgrade of `path` with `headers` from a peer that never closes its side (allowHalfOpen), as
 * a hostile client would: resolves with the answer's status code once it arrives, the socket left
 * open (the caller destroys it).
 */
export function halfOpenUpgrade(
  port: number,
  path = "/",
  headers: Readonly<Record<string, string>> = {},
): Promise<{ readonly status: number; readonly socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    let head = "";
    socket.on("error", reject);
    socket.on("data", (d: Buffer) => {
      head += d.toString("latin1");
      const m = /^HTTP\/1\.1 (\d{3}) /.exec(head);
      if (m) resolve({ status: Number(m[1]), socket });
    });
    const extra = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`,
    );
  });
}

/**
 * `n` TCP connections to `port` that send nothing (`partial` false) or an HTTP request line and
 * one header with no end (`partial` true), resolved once each is connected, left open.
 */
export async function rawConnections(port: number, n: number, partial: boolean): Promise<Socket[]> {
  const all: Promise<Socket>[] = [];
  for (let i = 0; i < n; i++) {
    all.push(
      new Promise((resolve, reject) => {
        let connected = false;
        const socket = connect({ port, host: "127.0.0.1" }, () => {
          connected = true;
          if (partial) socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n");
          resolve(socket);
        });
        // A server out of descriptors resets what it can't hold: only a failed connect fails.
        socket.on("error", (e) => {
          if (!connected) reject(e);
        });
      }),
    );
  }
  return Promise.all(all);
}
