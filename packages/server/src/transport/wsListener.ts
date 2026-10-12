import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { MAX_CLIENT_MESSAGE_BYTES } from "@game/shared";
import { type WebSocket, WebSocketServer } from "ws";
import {
  attachWs,
  ignoreWsErrors,
  WS_CLOSE_GOING_AWAY,
  type WsLimits,
  type WsTransport,
} from "./wsTransport";

/** What the listener serves: the matches sockets join and the two JSON pages. */
export interface ListenerTarget {
  /**
   * The name of the match that answers to `name`, the match part of an upgrade path ("" for `/`:
   * the default match's name), or null (HTTP 404). Asked before the upgrade and, with the name it
   * gave, again once the upgrade completes, so a `/` upgrade whose default match was removed
   * meanwhile closes 1001 rather than joining whichever match is the default by then.
   */
  matchFor(name: string): string | null;
  /** A socket upgraded for match `name` (`matchFor(name)` was just `name`): hand it over. */
  accept(name: string, transport: WsTransport, remoteAddress: string): void;
  /** `GET /status`. */
  status(): unknown;
  /** `GET /metrics`. */
  metrics(): unknown;
}

/**
 * Who may open a socket (D-041; `sv_maxPerIp`, `sv_allowedOrigins`, docs/06 §8), checked by the
 * upgrade handler before any socket opens.
 */
export class AdmissionLimits {
  /** Connections one address may hold, upgrades still in flight included; loopback is exempt. */
  maxPerIp = 8;
  /** Browser origins allowed to connect; empty = any. A request without Origin always passes. */
  allowedOrigins: readonly string[] = [];
  /**
   * Connections the whole process may hold across its matches (`sv_maxTotalClients`, D-047),
   * upgrades still in flight included; loopback counts too.
   */
  maxTotal = 64;
}

export interface ListenOptions {
  readonly host: string;
  /** 0 picks a free port (tests, bots); `WsListener.port` tells which. */
  readonly port: number;
  readonly limits: WsLimits;
  /** The defaults when absent. */
  readonly admission?: AdmissionLimits;
  readonly target: ListenerTarget;
  /**
   * The address an upgrade is counted under: the TCP peer's (`socket.remoteAddress`) unless a
   * test injects another, to stand for many clients on one non-loopback address. Never a header:
   * a client could forge it.
   */
  readonly peerAddress?: (req: IncomingMessage, socket: Duplex) => string;
  /**
   * An error of the listening socket once it is bound (an `accept` that fails with EMFILE when a
   * flood holds every file descriptor): reported here, never thrown, so the process keeps
   * serving the connections it has.
   */
  readonly onError?: (e: Error) => void;
}

/** Whether `ip` is a loopback address (127.0.0.0/8, ::1, IPv4-mapped 127.x), exempt per address. */
export function isLoopback(ip: string): boolean {
  return ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.");
}

/**
 * The origins `sv_allowedOrigins` lists: comma-separated, spaces trimmed, empty ones dropped, each
 * in the form a browser sends (`normalizeOrigin`), so "https://Play.example.org/" still matches.
 */
export function parseOrigins(text: string): string[] {
  return text
    .split(",")
    .map(normalizeOrigin)
    .filter((o) => o !== "");
}

/** An origin as browsers serialise it: lowercase, no trailing slash (scheme://host[:port]). */
export function normalizeOrigin(origin: string): string {
  const o = origin.trim().toLowerCase();
  return o.endsWith("/") ? o.slice(0, -1) : o;
}

/** `/m/<name>`: a named match's path (D-047; the name as `MATCH_NAME` in node/matchSet.ts). */
const MATCH_PATH = /^\/m\/([a-z0-9_]{1,32})$/;

/**
 * The match name an upgrade path addresses, or null (HTTP 404): "" for `/` (the default match),
 * the name for `/m/<name>` (D-047, M3 design §2.17). Anything else is refused, a query string
 * too, so nothing rides in on the URL.
 */
export function matchNameForPath(url: string | undefined): string | null {
  if (url === undefined || url.includes("?")) return null;
  if (url === "/") return "";
  return MATCH_PATH.exec(url)?.[1] ?? null;
}

/**
 * How long a refused upgrade's answer may take to flush before its socket is destroyed anyway
 * (design value): a peer that never reads can't hold the descriptor.
 */
const REFUSE_FLUSH_MS = 1000;

/**
 * Writes a bare HTTP refusal on a socket that asked to upgrade, and drops it: destroyed once the
 * answer is flushed (or after REFUSE_FLUSH_MS), as `ws` does. The HTTP server's sockets allow
 * half-open connections and nothing watches one handed to `upgrade`, so a bare `end()` would leave
 * the socket open, counted nowhere, for as long as the peer keeps its side open.
 */
function refuseUpgrade(socket: Duplex, status: number, text: string): void {
  const timer = setTimeout(() => socket.destroy(), REFUSE_FLUSH_MS);
  timer.unref();
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => {
    clearTimeout(timer);
    socket.destroy();
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

/**
 * The server's one port (D-030): an `http.Server` with a `ws` WebSocketServer in `noServer` mode
 * behind a single `upgrade` handler, so every check runs before a socket opens (ws refuses
 * `server` and `noServer` together, so it can't attach a second, unchecked handler). In order the
 * handler resolves the path to a match (else 404), refuses a browser origin `sv_allowedOrigins`
 * doesn't list (403), an address already holding `sv_maxPerIp` connections (429; loopback
 * exempt) and, once the process holds `sv_maxTotalClients` across its matches, any upgrade (503
 * "server full", D-047), and only then calls `handleUpgrade`. Both counts cover upgrades in
 * flight as well as open sockets: each is taken before the handshake and given back when the TCP
 * socket closes, however it ends, so simultaneous upgrades can't slip past a limit (D-041).
 * Once the upgrade completes the handler looks the match up again (a match removed meanwhile
 * closes the socket 1001). Frames past MAX_CLIENT_MESSAGE_BYTES are closed by ws (1009); no
 * compression; no automatic pongs; ws sets TCP noDelay. Plain HTTP serves `GET /status` and
 * `GET /metrics` as JSON.
 */
export class WsListener {
  readonly http: Server;
  readonly wss: WebSocketServer;
  /** Open sockets, so shutdown can wait for their closing handshakes. */
  private readonly sockets = new Map<WebSocket, WsTransport>();
  private closing = false;
  /** Connections per counted address (open or upgrading). */
  private readonly perIp = new Map<string, number>();
  /** Connections of every address, loopback included (open or upgrading; `sv_maxTotalClients`). */
  private total = 0;
  private readonly admission: AdmissionLimits;
  /** Called when the last open socket closes (shutdown waits on it). */
  private drained: (() => void) | null = null;

  constructor(private readonly options: ListenOptions) {
    this.admission = options.admission ?? new AdmissionLimits();
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_CLIENT_MESSAGE_BYTES,
      perMessageDeflate: false,
      clientTracking: false,
      skipUTF8Validation: true,
      // The protocol has its own PING/PONG; an automatic pong to every WebSocket ping would let a
      // client that never reads grow the send buffer before the match sends it anything.
      autoPong: false,
    });
    this.http = createServer((req, res) => this.request(req, res));
    this.http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) =>
      this.upgrade(req, socket, head),
    );
  }

  /** The bound port (after `listen`). */
  get port(): number {
    return (this.http.address() as AddressInfo).port;
  }

  /** The send-buffer limits every transport of this listener shares. */
  get limits(): WsLimits {
    return this.options.limits;
  }

  /** Open WebSocket connections. */
  get connections(): number {
    return this.sockets.size;
  }

  /** Connections (open or upgrading) counted for `ip` (0 for a loopback address). */
  connectionsFrom(ip: string): number {
    return this.perIp.get(ip) ?? 0;
  }

  /** Connections (open or upgrading) of the whole process, against `sv_maxTotalClients`. */
  get totalConnections(): number {
    return this.total;
  }

  /** Binds the port; rejects on a bind error (EADDRINUSE, EACCES). */
  listen(): Promise<this> {
    return new Promise((resolve, reject) => {
      const onError = (e: Error) => reject(e);
      this.http.once("error", onError);
      this.http.listen(this.options.port, this.options.host, () => {
        this.http.off("error", onError);
        // From here an error (EMFILE on accept) is reported, not thrown: an "error" event
        // without a listener would end the process and every match in it.
        this.http.on("error", (e: Error) => this.options.onError?.(e));
        resolve(this);
      });
    });
  }

  /**
   * Stops accepting: new connections and upgrades are refused, and every open transport will
   * close with 1001 ("going away") when its match closes it (the server KICKs first).
   */
  stopAccepting(): void {
    if (this.closing) return;
    this.closing = true;
    this.http.close();
    this.http.closeIdleConnections();
    for (const t of this.sockets.values()) t.closeCode = WS_CLOSE_GOING_AWAY;
  }

  /**
   * Waits up to `timeoutMs` for the open sockets to finish their closing handshakes, then
   * terminates the rest and drops the remaining HTTP connections.
   */
  async close(timeoutMs: number): Promise<void> {
    this.stopAccepting();
    const sockets = this.sockets;
    if (sockets.size > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, timeoutMs);
        this.drained = done;
        function done(): void {
          clearTimeout(timer);
          resolve();
        }
      });
      this.drained = null;
      for (const ws of sockets.keys()) ws.terminate();
    }
    this.http.closeAllConnections();
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => socket.destroy());
    const target = this.options.target;
    const path = matchNameForPath(req.url);
    const name = path === null ? null : target.matchFor(path);
    if (name === null) {
      refuseUpgrade(socket, 404, "Not Found");
      return;
    }
    if (this.closing) {
      refuseUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    const origins = this.admission.allowedOrigins;
    const origin = req.headers.origin;
    if (origins.length > 0 && origin !== undefined && !origins.includes(normalizeOrigin(origin))) {
      refuseUpgrade(socket, 403, "Forbidden");
      return;
    }
    const peer = this.options.peerAddress;
    const remoteAddress =
      peer === undefined ? ((socket as Socket).remoteAddress ?? "") : peer(req, socket);
    if (!isLoopback(remoteAddress)) {
      const held = this.perIp.get(remoteAddress) ?? 0;
      if (held >= this.admission.maxPerIp) {
        refuseUpgrade(socket, 429, "Too Many Requests");
        return;
      }
    }
    // Counted the same way across every match (D-047): taken before the handshake, given back
    // when the TCP socket closes.
    if (this.total >= this.admission.maxTotal) {
      refuseUpgrade(socket, 503, "server full");
      return;
    }
    this.total++;
    if (!isLoopback(remoteAddress)) {
      this.perIp.set(remoteAddress, (this.perIp.get(remoteAddress) ?? 0) + 1);
      socket.once("close", () => this.release(remoteAddress));
    }
    socket.once("close", () => {
      this.total--;
    });
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ignoreWsErrors(ws);
      if (this.closing || target.matchFor(name) !== name) {
        ws.close(WS_CLOSE_GOING_AWAY, this.closing ? "server shutting down" : "match closed");
        return;
      }
      const t = attachWs(ws, this.options.limits);
      this.sockets.set(ws, t);
      ws.on("close", () => {
        this.sockets.delete(ws);
        if (this.sockets.size === 0) this.drained?.();
      });
      target.accept(name, t, remoteAddress);
    });
  }

  private release(ip: string): void {
    const held = (this.perIp.get(ip) ?? 1) - 1;
    if (held > 0) this.perIp.set(ip, held);
    else this.perIp.delete(ip);
  }

  private request(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? "/").split("?")[0];
    const target = this.options.target;
    if (path !== "/status" && path !== "/metrics") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let body: unknown;
    try {
      body = path === "/status" ? target.status() : target.metrics();
    } catch {
      // A page that can't be built (the process out of descriptors) answers 500 and the server
      // goes on.
      sendJson(res, 500, { error: "internal error" });
      return;
    }
    sendJson(res, 200, body);
  }
}

/** Creates the listener and binds its port. */
export function listen(options: ListenOptions): Promise<WsListener> {
  return new WsListener(options).listen();
}
