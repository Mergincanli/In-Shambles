import {
  DevAssertError,
  MAX_QUEUED_UNRELIABLE,
  MAX_RELIABLE_BYTES,
  MAX_UNRELIABLE_BYTES,
  MSG_CVARS,
  MSG_KICK,
  MSG_PONG,
  MSG_SNAPSHOT,
  MSG_WELCOME,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  clientCloseReason,
  peerCloseReason,
  type SocketLike,
  WebSocketTransport,
  WS_CLOSE_ABNORMAL,
  WS_CLOSE_NORMAL,
  WS_CLOSE_REASON_MAX,
  WS_CONNECTING,
  WS_MAX_QUEUED_RELIABLE,
  WS_OPEN,
} from "../../src/net/webSocketTransport";

// The client end of a WebSocket with a fake socket (M3 design §2.6, D-030): the channel from the
// type byte, the inbox caps, sends before and after the socket opens, and the close mapping. The
// same transport on Node's real WebSocket runs in packages/tools/test/net/transport-contract.

/** A browser WebSocket stand-in: records sends (copied, as the API does) and closes. */
class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = WS_CONNECTING;
  readonly sent: number[][] = [];
  readonly views: Uint8Array[] = [];
  readonly closes: [number | undefined, string | undefined][] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  send(data: Uint8Array): void {
    if (this.readyState !== WS_OPEN) throw new Error("InvalidStateError");
    this.sent.push([...data]);
    this.views.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closes.push([code, reason]);
  }
  open(): void {
    this.readyState = WS_OPEN;
    this.onopen?.({});
  }
  message(data: unknown): void {
    this.onmessage?.({ data });
  }
  peerClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

interface Got {
  type: number;
  len: number;
  reliable: boolean;
}

function rig(open = true) {
  const socket = new FakeSocket();
  if (open) socket.readyState = WS_OPEN;
  const t = new WebSocketTransport(socket);
  const got: Got[] = [];
  const closed: string[] = [];
  t.onMessage((d, len, reliable) =>
    got.push({ type: len > 0 ? (d[0] as number) : 0, len, reliable }),
  );
  t.onClose((reason) => closed.push(reason));
  return { socket, t, got, closed };
}

function msg(type: number, len = 4): ArrayBuffer {
  const b = new Uint8Array(len);
  b[0] = type;
  for (let i = 1; i < len; i++) b[i] = i & 0xff;
  return b.buffer;
}

describe("WebSocketTransport (fake socket)", () => {
  it("asks for ArrayBuffers and takes each message's channel from its type byte", () => {
    const { socket, t, got } = rig();
    expect(socket.binaryType).toBe("arraybuffer");
    socket.message(msg(MSG_WELCOME));
    socket.message(msg(MSG_SNAPSHOT, 42));
    socket.message(msg(MSG_CVARS));
    socket.message(msg(MSG_PONG, 7));
    // A type that is no message, and an empty frame, arrive as unreliable for the connection to
    // strike.
    socket.message(msg(200));
    socket.message(new ArrayBuffer(0));
    expect(got).toEqual([]);
    t.poll();
    expect(got).toEqual([
      { type: MSG_WELCOME, len: 4, reliable: true },
      { type: MSG_SNAPSHOT, len: 42, reliable: false },
      { type: MSG_CVARS, len: 4, reliable: true },
      { type: MSG_PONG, len: 7, reliable: false },
      { type: 200, len: 4, reliable: false },
      { type: 0, len: 0, reliable: false },
    ]);
    expect(t.stats().delivered).toBe(6);
  });

  it("copies arrivals: the received buffer may change after the event", () => {
    const { socket, t } = rig();
    const buf = msg(MSG_SNAPSHOT, 8);
    socket.message(buf);
    new Uint8Array(buf).fill(9);
    let first = -1;
    t.onMessage((d) => {
      first = d[1] as number;
    });
    t.poll();
    expect(first).toBe(1);
  });

  it("sends a view of the caller's bytes, and refuses invalid lengths", () => {
    const { socket, t } = rig();
    const d = new Uint8Array(64);
    d[0] = 4;
    d[5] = 77;
    t.sendUnreliable(d, 6);
    t.sendReliable(d, 64);
    expect(socket.sent.map((s) => s.length)).toEqual([6, 64]);
    expect(socket.sent[0]?.[5]).toBe(77);
    expect(t.stats()).toMatchObject({ sent: 2, sentBytes: 70 });
    expect(() => t.sendUnreliable(d, 0)).toThrow(DevAssertError);
    expect(() => t.sendUnreliable(new Uint8Array(1300), MAX_UNRELIABLE_BYTES + 1)).toThrow(
      DevAssertError,
    );
    expect(socket.sent).toHaveLength(2);
  });

  it("reuses its view of the sender's buffer while buffer and length repeat", () => {
    const { socket, t } = rig();
    const w = new Uint8Array(1200);
    for (let i = 0; i < 4; i++) {
      w[0] = 4;
      w[1] = i;
      t.sendUnreliable(w, 55);
    }
    t.sendUnreliable(w, 3);
    t.sendUnreliable(new Uint8Array(1200), 3);
    // A PING between INPUTs (same writer, another length) keeps the INPUT's view, and its own.
    t.sendUnreliable(w, 55);
    t.sendUnreliable(w, 3);
    const v = socket.views;
    expect(v[1]).toBe(v[0]);
    expect(v[3]).toBe(v[0]);
    expect(v[4]).not.toBe(v[0]);
    expect(v[5]).not.toBe(v[4]);
    expect(v[6]).toBe(v[0]);
    expect(v[7]).toBe(v[4]);
    // Each send still carried that moment's bytes.
    expect(socket.sent.map((s) => s[1])).toEqual([0, 1, 2, 3, 3, 0, 3, 3]);
  });

  it("holds reliable sends until the socket opens and drops unreliable ones as lost", () => {
    const { socket, t } = rig(false);
    const d = new Uint8Array([1, 2, 3, 4]);
    t.sendReliable(d, 4);
    d[1] = 99;
    t.sendUnreliable(d, 4);
    t.sendReliable(d, 2);
    expect(socket.sent).toEqual([]);
    // Counted as sent when made, the unreliable one also as lost.
    expect(t.stats()).toMatchObject({ sent: 3, sentBytes: 10, lost: 1 });
    socket.open();
    // In order, and as they were when sent (copied).
    expect(socket.sent).toEqual([
      [1, 2, 3, 4],
      [1, 99],
    ]);
    t.sendUnreliable(d, 3);
    expect(socket.sent).toHaveLength(3);
  });

  it("queues an unreliable message over 1200 B as zero-length and closes past 16384 B", () => {
    const { socket, t, got, closed } = rig();
    socket.message(msg(MSG_SNAPSHOT, MAX_UNRELIABLE_BYTES));
    socket.message(msg(MSG_SNAPSHOT, MAX_UNRELIABLE_BYTES + 1));
    socket.message(msg(MSG_CVARS, MAX_RELIABLE_BYTES));
    socket.message(msg(MSG_CVARS, MAX_RELIABLE_BYTES + 1));
    // Nothing after the close is taken.
    socket.message(msg(MSG_PONG, 7));
    expect(socket.closes).toEqual([[WS_CLOSE_NORMAL, "message too big"]]);
    expect(t.isOpen()).toBe(true);
    t.poll();
    expect(got).toEqual([
      { type: MSG_SNAPSHOT, len: MAX_UNRELIABLE_BYTES, reliable: false },
      { type: 0, len: 0, reliable: false },
      { type: MSG_CVARS, len: MAX_RELIABLE_BYTES, reliable: true },
    ]);
    expect(closed).toEqual(["message too big"]);
    expect(t.isOpen()).toBe(false);
  });

  it("closes on a text frame (or anything but an ArrayBuffer)", () => {
    const { socket, t, closed } = rig();
    socket.message("hello");
    t.poll();
    expect(socket.closes).toEqual([[WS_CLOSE_NORMAL, "binary messages only"]]);
    expect(closed).toEqual(["binary messages only"]);
  });

  it("keeps the newest 256 unreliable messages and the reliable ones among them", () => {
    const { socket, t, got } = rig();
    socket.message(msg(MSG_WELCOME));
    for (let i = 0; i < MAX_QUEUED_UNRELIABLE + 10; i++) socket.message(msg(MSG_SNAPSHOT, 8 + i));
    socket.message(msg(MSG_KICK));
    t.poll();
    expect(t.stats().lost).toBe(10);
    expect(got).toHaveLength(MAX_QUEUED_UNRELIABLE + 2);
    expect(got[0]).toEqual({ type: MSG_WELCOME, len: 4, reliable: true });
    expect(got[1]?.len).toBe(8 + 10);
    expect(got.at(-1)).toEqual({ type: MSG_KICK, len: 4, reliable: true });
  });

  it("closes past 64 reliable messages waiting, and counts them down on poll", () => {
    // The server's cap mirrored (M3 design §2.6, D-030).
    expect(WS_MAX_QUEUED_RELIABLE).toBe(64);
    const { socket, t, closed } = rig();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < WS_MAX_QUEUED_RELIABLE; i++) socket.message(msg(MSG_CVARS));
      t.poll();
    }
    expect(socket.closes).toEqual([]);
    for (let i = 0; i <= WS_MAX_QUEUED_RELIABLE; i++) socket.message(msg(MSG_CVARS));
    expect(socket.closes).toEqual([[WS_CLOSE_NORMAL, "too many reliable messages"]]);
    t.poll();
    expect(closed).toEqual(["too many reliable messages"]);
  });

  it("delivers the server's close behind what came before it, with its reason", () => {
    const { socket, t, got, closed } = rig();
    socket.message(msg(MSG_KICK));
    socket.peerClose(WS_CLOSE_NORMAL, "kicked for a test");
    socket.message(msg(MSG_PONG, 7));
    t.poll();
    expect(got.map((g) => g.type)).toEqual([MSG_KICK]);
    expect(closed).toEqual(["kicked for a test"]);
    // Nothing more: no second close, no sends, no socket close of our own.
    t.poll();
    t.sendReliable(new Uint8Array([1]), 1);
    t.close("again");
    expect(closed).toHaveLength(1);
    expect(socket.sent).toEqual([]);
    expect(socket.closes).toEqual([]);
  });

  it("maps closes without a reason: never opened, dropped, other codes", () => {
    expect(peerCloseReason(false, WS_CLOSE_ABNORMAL, "")).toBe("could not connect to the server");
    expect(peerCloseReason(true, WS_CLOSE_ABNORMAL, "")).toBe("connection lost");
    expect(peerCloseReason(true, 1001, "")).toBe("connection closed (1001)");
    expect(peerCloseReason(true, 1001, "server shutting down")).toBe("server shutting down");
    // A refused connection reports an error, then (maybe) a close: one close, delivered once.
    const { socket, t, closed } = rig(false);
    socket.onerror?.({});
    socket.peerClose(WS_CLOSE_ABNORMAL);
    t.poll();
    expect(closed).toEqual(["could not connect to the server"]);
  });

  it("closes its socket once with 1000 and the reason cut to 123 bytes", () => {
    const { socket, t, closed } = rig();
    socket.message(msg(MSG_KICK));
    t.close(`kicked: ${"x".repeat(200)}`);
    t.close("twice");
    t.poll();
    expect(socket.closes).toHaveLength(1);
    expect(socket.closes[0]?.[0]).toBe(WS_CLOSE_NORMAL);
    expect(socket.closes[0]?.[1]).toHaveLength(WS_CLOSE_REASON_MAX);
    // Our own close is never reported back to us, and drops what was waiting.
    expect(closed).toEqual([]);
    expect(t.isOpen()).toBe(false);
    // Multi-byte text: cut by UTF-8 bytes, never inside a surrogate pair.
    expect(clientCloseReason("é".repeat(100))).toHaveLength(61);
    const emoji = clientCloseReason(`${"a".repeat(121)}😀`);
    expect(emoji).toBe("a".repeat(121));
    expect(clientCloseReason("short")).toBe("short");
  });

  it("reuses its inbox slots", () => {
    const { socket, t } = rig();
    for (let round = 0; round < 50; round++) {
      for (let i = 0; i < 20; i++) socket.message(msg(i % 4 === 0 ? MSG_CVARS : MSG_SNAPSHOT, 50));
      t.poll();
    }
    const pooled = t.poolSize();
    for (let round = 0; round < 50; round++) {
      for (let i = 0; i < 20; i++) socket.message(msg(MSG_SNAPSHOT, 50));
      t.poll();
    }
    expect(t.poolSize()).toBe(pooled);
  });
});
