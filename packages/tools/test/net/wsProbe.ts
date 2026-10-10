import { request } from "node:http";
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

/** `n` upgrades sent at once (none waits for another's answer), in sending order. */
export function upgradeAtOnce(
  n: number,
  port: number,
  headers: Readonly<Record<string, string>> = {},
): Promise<Upgrade[]> {
  const all: Promise<Upgrade>[] = [];
  for (let i = 0; i < n; i++) all.push(upgrade(port, headers));
  return Promise.all(all);
}

/** Destroys every open socket of `ups`. */
export function closeAll(ups: readonly Upgrade[]): void {
  for (const u of ups) u.socket?.destroy();
}
