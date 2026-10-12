import { describe, expect, it } from "vitest";
import {
  MatchRconGate,
  RCON_FORGET_MS,
  RCON_MAX_LOCKOUT_MS,
  RconGuard,
  rconChecker,
  rconLockoutMs,
  validRconPassword,
} from "../../src/node/rconGuard";

// The rcon guard (D-042, M3 design §2.10, §4 "Security"): per remote address, across matches, the
// lockout min(2^(n − 3) s, 600 s) from the 3rd failure, refusal without a check while locked, and
// a reset after 10 min without failures once the lockout is over; the constant-time checker; the
// password's rules.

describe("rconLockoutMs", () => {
  it("is 0 for two failures, then 1 s, 2 s, 4 s … capped at 600 s", () => {
    expect([1, 2, 3, 4, 5, 6].map(rconLockoutMs)).toEqual([0, 0, 1000, 2000, 4000, 8000]);
    expect(rconLockoutMs(12)).toBe(512_000);
    expect(rconLockoutMs(13)).toBe(RCON_MAX_LOCKOUT_MS);
    expect(rconLockoutMs(1000)).toBe(600_000);
  });
});

describe("RconGuard", () => {
  it("backs off per address and lets others through", () => {
    const clock = { ms: 0 };
    const g = new RconGuard(() => clock.ms);
    expect(g.result("1.2.3.4", false)).toEqual({ failures: 1, lockoutMs: 0 });
    expect(g.allow("1.2.3.4")).toBe(true);
    expect(g.result("1.2.3.4", false)).toEqual({ failures: 2, lockoutMs: 0 });
    expect(g.allow("1.2.3.4")).toBe(true);
    expect(g.result("1.2.3.4", false)).toEqual({ failures: 3, lockoutMs: 1000 });
    expect(g.allow("1.2.3.4")).toBe(false);
    expect(g.allow("5.6.7.8")).toBe(true);
    clock.ms = 999;
    expect(g.allow("1.2.3.4")).toBe(false);
    clock.ms = 1000;
    expect(g.allow("1.2.3.4")).toBe(true);
    expect(g.result("1.2.3.4", false)).toEqual({ failures: 4, lockoutMs: 2000 });
    clock.ms = 2999;
    expect(g.allow("1.2.3.4")).toBe(false);
    clock.ms = 3000;
    expect(g.allow("1.2.3.4")).toBe(true);
  });

  it("holds the 600 s cap: forgets an address only 10 min after its lockout ended", () => {
    const clock = { ms: 0 };
    const g = new RconGuard(() => clock.ms);
    // Each failure as soon as the last lockout ends: the 13th reaches the 600 s cap.
    let lockout = 0;
    for (let i = 1; i <= 13; i++) {
      clock.ms += lockout;
      expect(g.allow("a"), String(i)).toBe(true);
      lockout = g.result("a", false).lockoutMs;
    }
    expect(lockout).toBe(RCON_MAX_LOCKOUT_MS);
    expect(g.allow("a")).toBe(false);
    clock.ms += RCON_MAX_LOCKOUT_MS - 1;
    expect(g.allow("a")).toBe(false);
    clock.ms += 1;
    // The capped lockout is over, and the address is still remembered: the next guess is locked
    // for 600 s again, so a sustained guesser gets one guess per 10 min.
    expect(g.allow("a")).toBe(true);
    expect(g.result("a", false)).toEqual({ failures: 14, lockoutMs: RCON_MAX_LOCKOUT_MS });
    // 10 min without a failure after that lockout's end forget it.
    clock.ms += RCON_MAX_LOCKOUT_MS + RCON_FORGET_MS - 1;
    expect(g.size).toBe(1);
    expect(g.allow("a")).toBe(true);
    expect(g.result("a", false)).toEqual({ failures: 15, lockoutMs: RCON_MAX_LOCKOUT_MS });
    clock.ms += RCON_MAX_LOCKOUT_MS + RCON_FORGET_MS;
    expect(g.result("a", false)).toEqual({ failures: 1, lockoutMs: 0 });
  });

  it("forgets 10 min after an unlocked failure, never on a right password", () => {
    const clock = { ms: 0 };
    const g = new RconGuard(() => clock.ms);
    g.result("a", false);
    g.result("a", false);
    // A right password (maybe another host behind the same address) clears nothing.
    expect(g.result("a", true)).toEqual({ failures: 2, lockoutMs: 0 });
    expect(g.result("a", false)).toEqual({ failures: 3, lockoutMs: 1000 });
    clock.ms = 1000 + RCON_FORGET_MS - 1;
    expect(g.result("a", false)).toEqual({ failures: 4, lockoutMs: 2000 });
    clock.ms += 2000 + RCON_FORGET_MS;
    expect(g.result("a", true)).toEqual({ failures: 0, lockoutMs: 0 });
    expect(g.size).toBe(0);
    expect(g.result("a", false)).toEqual({ failures: 1, lockoutMs: 0 });
  });

  it("sweeps forgotten addresses once it remembers 1024, keeping recent ones", () => {
    const clock = { ms: 0 };
    const g = new RconGuard(() => clock.ms);
    for (let i = 0; i < 1023; i++) g.result(`10.0.${i >> 8}.${i & 255}`, false);
    clock.ms = RCON_FORGET_MS - 1;
    g.result("192.0.2.1", false);
    expect(g.size).toBe(1024);
    clock.ms = RCON_FORGET_MS;
    g.result("192.0.2.2", false);
    // The 1023 old ones went; the recent one and the new one stay.
    expect(g.size).toBe(2);
    expect(g.result("192.0.2.1", false)).toEqual({ failures: 2, lockoutMs: 0 });
  });

  it("keys by address across matches and logs failures with the ip, never the text", () => {
    const clock = { ms: 0 };
    const g = new RconGuard(() => clock.ms);
    const lines: [string, unknown][] = [];
    const log = (_lvl: string, ev: string, fields?: unknown) => lines.push([ev, fields]);
    const a = new MatchRconGate(g, "a", log);
    const b = new MatchRconGate(g, "b", log);
    a.addresses[0] = "9.9.9.9";
    b.addresses[3] = "9.9.9.9";
    a.result(0, false);
    b.result(3, false);
    a.result(0, false);
    expect(b.allow(3)).toBe(false);
    expect(lines).toEqual([
      ["rcon_fail", { match: "a", client: 0, ip: "9.9.9.9", failures: 1, lockoutS: 0 }],
      ["rcon_fail", { match: "b", client: 3, ip: "9.9.9.9", failures: 2, lockoutS: 0 }],
      ["rcon_fail", { match: "a", client: 0, ip: "9.9.9.9", failures: 3, lockoutS: 1 }],
    ]);
    a.result(0, true);
    expect(lines).toHaveLength(3);
    // A success logs nothing and lifts no lockout.
    expect(b.allow(3)).toBe(false);
    clock.ms = 1000;
    expect(b.allow(3)).toBe(true);
  });
});

describe("rconChecker and validRconPassword", () => {
  it("is null (rcon disabled) when unset or empty, else checks exactly", () => {
    expect(rconChecker(undefined)).toBeNull();
    expect(rconChecker("")).toBeNull();
    const check = rconChecker("pass word");
    expect(check?.("pass word")).toBe(true);
    for (const guess of ["", "pass", "pass word ", "Pass word", "x".repeat(4096)]) {
      expect(check?.(guess), guess).toBe(false);
    }
  });

  it("refuses passwords the client cannot send", () => {
    expect(validRconPassword(undefined)).toEqual({ ok: true, password: "" });
    expect(validRconPassword("a b!~")).toEqual({ ok: true, password: "a b!~" });
    for (const bad of ['a"b', "tab\there", "é", "x".repeat(256)]) {
      expect(validRconPassword(bad).ok, bad).toBe(false);
    }
  });
});
