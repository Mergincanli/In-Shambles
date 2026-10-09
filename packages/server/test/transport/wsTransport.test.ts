import { EventEmitter } from "node:events";
import {
  DevAssertError,
  MAX_QUEUED_UNRELIABLE,
  MAX_UNRELIABLE_BYTES,
  MSG_CMD,
  MSG_HELLO,
  MSG_INPUT,
  MSG_PING,
  MSG_READY,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import {
  attachWs,
  closeReason,
  WireTraffic,
  WS_CLOSE_GOING_AWAY,
  WS_CLOSE_NORMAL,
  WS_CLOSE_POLICY,
  WS_CLOSE_TOO_BIG,
  WS_CLOSE_UNSUPPORTED,
  WS_MAX_QUEUED_RELIABLE,
  WsLimits,
  type WsSocket,
  WsTransport,
} from "../../src/transport/wsTransport";

/** A `ws` socket stand-in: records sends and closes; `bufferedAmount` is set by the test. */
class FakeSocket implements WsSocket {
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  readonly closes: [number | undefined, string | undefined][] = [];
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closes.push([code, reason]);
  }
}

interface Got {
  type: number;
  len: number;
  reliable: boolean;
  bytes: number[];
}

function rig() {
  const socket = new FakeSocket();
  const t = new WsTransport(socket, new WsLimits());
  const got: Got[] = [];
  const closed: string[] = [];
  t.onMessage((d, len, reliable) =>
    got.push({
      type: len > 0 ? (d[0] as number) : 0,
      len,
      reliable,
      bytes: [...d.subarray(0, len)],
    }),
  );
  t.onClose((reason) => closed.push(reason));
  return { socket, t, got, closed };
}

function msg(type: number, len = 4): Buffer {
  const b = Buffer.alloc(len);
  b[0] = type;
  for (let i = 1; i < len; i++) b[i] = i & 0xff;
  return b;
}

describe("WsTransport (fake ws)", () => {
  it("takes each message's channel from its type byte and delivers only on poll", () => {
    const { t, got } = rig();
    t.receive(msg(MSG_HELLO), true);
    t.receive(msg(MSG_INPUT), true);
    t.receive(msg(MSG_CMD), true);
    t.receive(msg(MSG_PING), true);
    expect(got).toEqual([]);
    t.poll();
    expect(got.map((g) => [g.type, g.reliable])).toEqual([
      [MSG_HELLO, true],
      [MSG_INPUT, false],
      [MSG_CMD, true],
      [MSG_PING, false],
    ]);
    expect(got[0]?.bytes).toEqual([...msg(MSG_HELLO)]);
    expect(t.stats().delivered).toBe(4);
    expect(t.stats().deliveredBytes).toBe(16);
  });

  it("delivers unknown types and empty frames as unreliable (the match strikes them)", () => {
    const { t, got } = rig();
    t.receive(msg(0), true);
    t.receive(msg(200), true);
    t.receive(Buffer.alloc(0), true);
    t.poll();
    expect(got.map((g) => [g.type, g.len, g.reliable])).toEqual([
      [0, 4, false],
      [200, 4, false],
      [0, 0, false],
    ]);
  });

  it("accepts ArrayBuffer and fragment arrivals like Buffers", () => {
    const { t, got } = rig();
    const ab = new ArrayBuffer(3);
    new Uint8Array(ab).set([MSG_PING, 1, 2]);
    t.receive(ab, true);
    t.receive([Buffer.from([MSG_HELLO, 9]), Buffer.from([8, 7])], true);
    t.poll();
    expect(got.map((g) => g.bytes)).toEqual([
      [MSG_PING, 1, 2],
      [MSG_HELLO, 9, 8, 7],
    ]);
  });

  it("copies arrivals: the socket may reuse its buffer before the poll", () => {
    const { t, got } = rig();
    const b = msg(MSG_PING);
    t.receive(b, true);
    b.fill(0xee);
    t.poll();
    expect(got[0]?.bytes).toEqual([...msg(MSG_PING)]);
  });

  it("queues an unreliable message over 1200 B as a zero-length message", () => {
    const { t, got } = rig();
    t.receive(msg(MSG_INPUT, MAX_UNRELIABLE_BYTES + 1), true);
    t.receive(msg(MSG_INPUT, MAX_UNRELIABLE_BYTES), true);
    t.poll();
    expect(got.map((g) => [g.len, g.reliable])).toEqual([
      [0, false],
      [MAX_UNRELIABLE_BYTES, false],
    ]);
  });

  it("closes 1009 on a message past 2048 B (ws's maxPayload), delivered as a close", () => {
    const { t, socket, got, closed } = rig();
    t.receive(msg(MSG_PING), true);
    t.receive(msg(MSG_CMD, 2049), true);
    t.receive(msg(MSG_PING), true);
    expect(socket.closes).toEqual([[WS_CLOSE_TOO_BIG, "message too big"]]);
    t.poll();
    expect(got).toHaveLength(1);
    expect(closed).toEqual(["message too big"]);
    expect(t.isOpen()).toBe(false);
  });

  it("keeps the newest 256 unreliable messages and counts the dropped as lost", () => {
    const { t, got } = rig();
    t.receive(msg(MSG_HELLO), true);
    for (let i = 0; i < MAX_QUEUED_UNRELIABLE + 10; i++) {
      const b = msg(MSG_INPUT);
      b[1] = i & 0xff;
      b[2] = i >> 8;
      t.receive(b, true);
    }
    t.poll();
    expect(t.stats().lost).toBe(10);
    expect(got).toHaveLength(MAX_QUEUED_UNRELIABLE + 1);
    // The reliable message keeps its place; the unreliable ones are the newest, in order.
    expect(got[0]?.type).toBe(MSG_HELLO);
    expect(got[1]?.bytes.slice(1, 3)).toEqual([10, 0]);
    expect(got.at(-1)?.bytes.slice(1, 3)).toEqual([(MAX_QUEUED_UNRELIABLE + 9) & 0xff, 1]);
  });

  it("closes 1008 past 64 reliable messages between polls, after delivering what came first", () => {
    const { t, socket, got, closed } = rig();
    for (let i = 0; i < WS_MAX_QUEUED_RELIABLE; i++) t.receive(msg(MSG_CMD), true);
    expect(socket.closes).toEqual([]);
    t.poll();
    for (let i = 0; i < WS_MAX_QUEUED_RELIABLE; i++) t.receive(msg(MSG_CMD), true);
    expect(socket.closes).toEqual([]);
    t.receive(msg(MSG_READY), true);
    t.receive(msg(MSG_PING), true);
    expect(socket.closes).toEqual([[WS_CLOSE_POLICY, "too many reliable messages"]]);
    t.poll();
    expect(got).toHaveLength(2 * WS_MAX_QUEUED_RELIABLE);
    expect(closed).toEqual(["too many reliable messages"]);
  });

  it("closes 1003 on a text frame", () => {
    const { t, socket, got, closed } = rig();
    t.receive(Buffer.from("hello"), false);
    expect(socket.closes).toEqual([[WS_CLOSE_UNSUPPORTED, "binary messages only"]]);
    t.poll();
    expect(got).toEqual([]);
    expect(closed).toEqual(["binary messages only"]);
  });

  it("sends one copy per packet, with only the used length", () => {
    const { t, socket } = rig();
    const buf = new Uint8Array(64).fill(7);
    buf[0] = MSG_PING;
    t.sendUnreliable(buf, 5);
    t.sendReliable(buf, 3);
    buf.fill(0);
    expect(socket.sent.map((s) => [...s])).toEqual([
      [MSG_PING, 7, 7, 7, 7],
      [MSG_PING, 7, 7],
    ]);
    expect(t.stats().sent).toBe(2);
    expect(t.stats().sentBytes).toBe(8);
  });

  it("adds its wire traffic, payload plus framing, to its match's counter (D-036)", () => {
    const { socket, t } = rig();
    const traffic = new WireTraffic();
    t.receive(msg(MSG_INPUT, 55), true);
    t.traffic = traffic;
    // A client's frames are masked: 55 + 2 + 4 and 200 + 4 + 4.
    t.receive(msg(MSG_INPUT, 55), true);
    t.receive(msg(MSG_CMD, 200), true);
    // The server's are not: 436 + 4 and 20 + 2. A send dropped by backpressure is not counted.
    t.sendUnreliable(msg(MSG_INPUT, 436), 436);
    t.sendReliable(msg(MSG_CMD, 20), 20);
    socket.bufferedAmount = new WsLimits().sendBufferDrop + 1;
    t.sendUnreliable(msg(MSG_INPUT, 436), 436);
    expect(traffic).toEqual({
      bytesIn: 61 + 208,
      bytesOut: 440 + 22,
      messagesIn: 2,
      messagesOut: 2,
    });
  });

  it("drops unreliable sends past sv_sendBufferDrop, never reliable ones", () => {
    const { t, socket } = rig();
    const buf = new Uint8Array([MSG_PING, 1, 2]);
    socket.bufferedAmount = 32768;
    t.sendUnreliable(buf, 3);
    expect(socket.sent).toHaveLength(1);
    socket.bufferedAmount = 32769;
    t.sendUnreliable(buf, 3);
    t.sendReliable(buf, 3);
    expect(socket.sent).toHaveLength(2);
    expect(t.stats().lost).toBe(1);
    expect(socket.closes).toEqual([]);
  });

  it("closes 1008 'too slow' past sv_sendBufferClose and reports the close on poll", () => {
    const { t, socket, closed } = rig();
    const buf = new Uint8Array([MSG_PING, 1, 2]);
    socket.bufferedAmount = 1048577;
    t.sendReliable(buf, 3);
    expect(socket.sent).toEqual([]);
    expect(socket.closes).toEqual([[WS_CLOSE_POLICY, "too slow"]]);
    t.sendReliable(buf, 3);
    expect(socket.sent).toEqual([]);
    t.poll();
    expect(closed).toEqual(["too slow"]);
    // Closing an already-closed transport sends no second close frame.
    t.close("kicked");
    expect(socket.closes).toHaveLength(1);
  });

  it("still sends at exactly sv_sendBufferClose bytes waiting", () => {
    const { t, socket } = rig();
    const buf = new Uint8Array([MSG_PING, 1, 2]);
    socket.bufferedAmount = 1048576;
    t.sendReliable(buf, 3);
    t.poll();
    expect(socket.sent).toHaveLength(1);
    expect(socket.closes).toEqual([]);
    expect(t.isOpen()).toBe(true);
  });

  it("closes 'too slow' from poll too, when the match has sent it nothing", () => {
    const { t, socket, got, closed } = rig();
    t.receive(msg(MSG_PING), true);
    socket.bufferedAmount = 1048577;
    t.poll();
    expect(socket.closes).toEqual([[WS_CLOSE_POLICY, "too slow"]]);
    // What arrived first is still delivered, then the close.
    expect(got.map((g) => g.type)).toEqual([MSG_PING]);
    expect(closed).toEqual(["too slow"]);
  });

  it("refuses a length its channel doesn't allow (a dev assert) and sends nothing", () => {
    const { t, socket } = rig();
    const buf = new Uint8Array(MAX_UNRELIABLE_BYTES + 8).fill(MSG_PING);
    expect(() => t.sendUnreliable(buf, MAX_UNRELIABLE_BYTES + 1)).toThrow(DevAssertError);
    expect(() => t.sendReliable(buf, 0)).toThrow(DevAssertError);
    expect(() => t.sendUnreliable(buf, buf.length + 1)).toThrow(DevAssertError);
    expect(socket.sent).toEqual([]);
    expect(t.stats().sent).toBe(0);
    t.sendUnreliable(buf, MAX_UNRELIABLE_BYTES);
    expect(socket.sent.map((b) => b.length)).toEqual([MAX_UNRELIABLE_BYTES]);
  });

  it("sends no second close frame when closed while a forced close waits for poll", () => {
    const { t, socket, closed } = rig();
    t.receive(Buffer.from("text"), false);
    t.close("kicked");
    expect(socket.closes).toEqual([[WS_CLOSE_UNSUPPORTED, "binary messages only"]]);
    t.poll();
    expect(closed).toEqual([]);
  });

  it("closes with 1000 (or the shutdown's 1001) and a reason cut to 123 bytes", () => {
    const a = rig();
    a.t.close("kicked: flood");
    expect(a.socket.closes).toEqual([[WS_CLOSE_NORMAL, "kicked: flood"]]);
    const b = rig();
    b.t.closeCode = WS_CLOSE_GOING_AWAY;
    b.t.close("é".repeat(100));
    const [code, reason] = b.socket.closes[0] ?? [];
    expect(code).toBe(WS_CLOSE_GOING_AWAY);
    expect(reason).toBe("é".repeat(61));
    expect(Buffer.byteLength(closeReason("x".repeat(200)))).toBe(123);
    // A cut never leaves half a surrogate pair.
    expect(closeReason(`${"x".repeat(122)}😀`)).toBe("x".repeat(122));
  });

  it("delivers nothing and sends nothing after close()", () => {
    const { t, socket, got, closed } = rig();
    t.receive(msg(MSG_PING), true);
    t.close("bye");
    t.receive(msg(MSG_PING), true);
    t.peerClosed(1000, "late");
    t.poll();
    t.sendReliable(new Uint8Array([MSG_PING]), 1);
    expect(got).toEqual([]);
    expect(closed).toEqual([]);
    expect(socket.sent).toEqual([]);
    expect(t.isOpen()).toBe(false);
  });

  it("delivers the peer's close behind the messages that came before it", () => {
    const { t, got, closed } = rig();
    t.receive(msg(MSG_PING), true);
    t.receive(msg(MSG_HELLO), true);
    t.peerClosed(1006, "");
    t.receive(msg(MSG_PING), true);
    expect(t.isOpen()).toBe(true);
    t.poll();
    expect(got.map((g) => g.type)).toEqual([MSG_PING, MSG_HELLO]);
    expect(closed).toEqual(["connection closed (1006)"]);
    expect(t.isOpen()).toBe(false);
  });

  it("attachWs sets nodebuffer and feeds the socket's messages and close in", () => {
    const ws = Object.assign(new EventEmitter(), {
      binaryType: "blob",
      bufferedAmount: 0,
      send: () => {},
      close: () => {},
    });
    const t = attachWs(ws as unknown as WebSocket, new WsLimits());
    expect(ws.binaryType).toBe("nodebuffer");
    const got: number[] = [];
    const closed: string[] = [];
    t.onMessage((d) => got.push(d[0] as number));
    t.onClose((r) => closed.push(r));
    ws.emit("message", msg(MSG_PING), true);
    ws.emit("close", 1001, Buffer.from("bye"));
    t.poll();
    expect(got).toEqual([MSG_PING]);
    expect(closed).toEqual(["bye"]);
  });

  it("reuses its inbox slots once warm", () => {
    const { t } = rig();
    const burst = () => {
      for (let i = 0; i < 40; i++) t.receive(msg(i % 2 === 0 ? MSG_PING : MSG_CMD, 300), true);
      t.poll();
    };
    burst();
    const slots = t.poolSize();
    for (let i = 0; i < 50; i++) burst();
    expect(t.poolSize()).toBe(slots);
  });
});
