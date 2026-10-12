import { describe, expect, it } from "vitest";
import { wsWireBytes } from "../../src/net/protocol";

// RFC 6455 §5.2 framing, as the bandwidth accounting counts it (D-036): 2 B of header up to
// 125 B, 4 B up to 65535 B, 10 B beyond; a client's frames carry a 4 B mask on top.
describe("wsWireBytes", () => {
  it.each([
    [0, false, 2],
    [125, false, 127],
    [126, false, 130],
    [436, false, 440],
    [65535, false, 65539],
    [65536, false, 65546],
    [55, true, 61],
    [125, true, 131],
    [126, true, 134],
    [1026, true, 1034],
  ])("%i B payload, masked %s → %i B on the wire", (payload, masked, wire) => {
    expect(wsWireBytes(payload, masked)).toBe(wire);
  });
});
