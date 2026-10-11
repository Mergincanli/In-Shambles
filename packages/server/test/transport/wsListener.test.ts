import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AdmissionLimits, type ListenerTarget, WsListener } from "../../src/transport/wsListener";
import { WsLimits } from "../../src/transport/wsTransport";
import { httpJson, until } from "../node/wsClient";

// The listener against floods (M3 review, D-048): a refused upgrade's socket is destroyed even
// when its peer keeps its side open, a listening-socket error after the bind is reported and not
// thrown, and a JSON page that can't be built answers 500 while the server goes on.

const listeners: WsListener[] = [];
const peers: Socket[] = [];

afterEach(async () => {
  for (const p of peers.splice(0)) p.destroy();
  for (const l of listeners.splice(0)) await l.close(100);
});

async function start(target: Partial<ListenerTarget> = {}, admission = new AdmissionLimits()) {
  const errors: Error[] = [];
  const listener = new WsListener({
    host: "127.0.0.1",
    port: 0,
    limits: new WsLimits(),
    admission,
    onError: (e) => errors.push(e),
    target: {
      matchFor: (name) => (name === "" ? "main" : null),
      accept: () => {},
      status: () => ({ ok: true }),
      metrics: () => ({ ok: true }),
      ...target,
    },
  });
  await listener.listen();
  listeners.push(listener);
  return { listener, errors, port: listener.port };
}

/** The server's open TCP connections (refused, upgrading or open). */
function connections(listener: WsListener): Promise<number> {
  return new Promise((resolve, reject) =>
    listener.http.getConnections((e, n) => (e ? reject(e) : resolve(n))),
  );
}

/**
 * An upgrade of `path` from a peer that never closes its side (allowHalfOpen): resolves with the
 * answer's status line once it arrives, the socket left open.
 */
function halfOpenUpgrade(port: number, path: string, origin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    peers.push(socket);
    let head = "";
    socket.on("error", reject);
    socket.on("data", (d: Buffer) => {
      head += d.toString();
      const end = head.indexOf("\r\n");
      if (end >= 0) resolve(head.slice(0, end));
    });
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        (origin === undefined ? "" : `Origin: ${origin}\r\n`) +
        "\r\n",
    );
  });
}

describe("WsListener under floods (D-048)", () => {
  it("destroys a refused upgrade's socket although its peer keeps its side open", async () => {
    const admission = new AdmissionLimits();
    admission.allowedOrigins = ["https://play.example.org"];
    const { listener, port } = await start({}, admission);
    const answers = await Promise.all([
      ...Array.from({ length: 10 }, () => halfOpenUpgrade(port, "/nope")),
      ...Array.from({ length: 10 }, () => halfOpenUpgrade(port, "/", "https://evil.example")),
    ]);
    expect(answers.filter((a) => a.startsWith("HTTP/1.1 404 "))).toHaveLength(10);
    expect(answers.filter((a) => a.startsWith("HTTP/1.1 403 "))).toHaveLength(10);
    // A bare end() left all 20 open, counted nowhere, for as long as the peers stayed.
    let open = -1;
    await until(() => {
      void connections(listener).then((n) => {
        open = n;
      });
      return open === 0;
    }, "the refused sockets to close");
    expect(listener.totalConnections).toBe(0);
  });

  it("reports a listening-socket error after the bind instead of throwing it", async () => {
    const { listener, errors, port } = await start();
    const emfile = Object.assign(new Error("accept EMFILE"), { code: "EMFILE" });
    expect(() => listener.http.emit("error", emfile)).not.toThrow();
    expect(errors).toEqual([emfile]);
    expect((await httpJson(port, "/status")).status).toBe(200);
  });

  it("answers 500 when a page can't be built, and goes on serving", async () => {
    const { port } = await start({
      metrics: () => {
        throw new Error("EMFILE: too many open files, uv_resident_set_memory");
      },
    });
    expect(await httpJson(port, "/metrics")).toEqual({
      status: 500,
      body: { error: "internal error" },
    });
    expect(await httpJson(port, "/status")).toEqual({ status: 200, body: { ok: true } });
  });
});
