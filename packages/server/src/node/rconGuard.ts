import { createHash, timingSafeEqual } from "node:crypto";
import { MATCH_MAX_CLIENTS } from "@game/shared";
import type { RconGate } from "../match/host";
import type { JsonLog } from "./log";

/**
 * rcon authorization on the dedicated server (D-042, M3 design §2.10): the password check and the
 * per-address lockout after wrong ones. Runs once per rcon command, never per tick: it allocates.
 */

/** Failures an address may make before each further one locks it out (design value). */
export const RCON_FREE_FAILURES = 2;
/** The longest lockout, ms (design value: 600 s). */
export const RCON_MAX_LOCKOUT_MS = 600_000;
/**
 * An address that went this long without a failure starts again from none (design: 10 min),
 * counted from the end of its lockout: a locked address cannot fail, so counting from the failure
 * would forget it just as a capped lockout ends and let the 2 free guesses and the ramp start over.
 */
export const RCON_FORGET_MS = 600_000;
/** Records past which a new address first sweeps out the forgotten ones (a memory bound). */
const SWEEP_AT = 1024;

/**
 * The lockout after an address's `failures`-th wrong password, ms: none for the first two, then
 * min(2^(failures − 3) s, 600 s) from the third on (1 s, 2 s, 4 s, …).
 */
export function rconLockoutMs(failures: number): number {
  if (failures <= RCON_FREE_FAILURES) return 0;
  const exp = failures - RCON_FREE_FAILURES - 1;
  // 2^10 s is past the cap: no need to build a larger power.
  return exp >= 10 ? RCON_MAX_LOCKOUT_MS : Math.min(RCON_MAX_LOCKOUT_MS, 1000 * 2 ** exp);
}

/**
 * A constant-time check against `password` (`SV_RCON_PASSWORD`), or null when it is unset or
 * empty, which disables rcon. Both sides are hashed first, so the comparison takes the same time
 * whatever the guess's length and wherever it first differs.
 */
export function rconChecker(password: string | undefined): ((guess: string) => boolean) | null {
  if (password === undefined || password === "") return null;
  const want = createHash("sha256").update(password, "utf8").digest();
  return (guess) => timingSafeEqual(createHash("sha256").update(guess, "utf8").digest(), want);
}

interface AddressRecord {
  failures: number;
  /** Monotonic ms of the last failure. */
  lastFailure: number;
  /** Monotonic ms until which rcon from the address is refused unchecked. */
  lockedUntil: number;
}

/**
 * Wrong rcon passwords per remote address, across every match of the process (D-042): from the
 * third failure each one locks the address out for `rconLockoutMs`; while locked, rcon is refused
 * without checking the password; ten minutes without a failure once the lockout is over forget the
 * address. A right password forgets nothing: behind a shared address it would clear another
 * host's failures. `now` is the monotonic clock (ms).
 */
export class RconGuard {
  private readonly records = new Map<string, AddressRecord>();

  constructor(private readonly now: () => number) {}

  /** Whether `address` may try a password now. */
  allow(address: string): boolean {
    const r = this.current(address);
    return r === undefined || this.now() >= r.lockedUntil;
  }

  /**
   * Records a check's outcome for `address`; returns the failures counted and the lockout (ms) a
   * failure started, for the `rcon_fail` log line.
   */
  result(address: string, ok: boolean): { failures: number; lockoutMs: number } {
    if (ok) {
      const r = this.current(address);
      return { failures: r === undefined ? 0 : r.failures, lockoutMs: 0 };
    }
    const now = this.now();
    let r = this.current(address);
    if (r === undefined) {
      if (this.records.size >= SWEEP_AT) this.sweep(now);
      r = { failures: 0, lastFailure: now, lockedUntil: 0 };
      this.records.set(address, r);
    }
    r.failures++;
    r.lastFailure = now;
    const lockoutMs = rconLockoutMs(r.failures);
    r.lockedUntil = now + lockoutMs;
    return { failures: r.failures, lockoutMs };
  }

  /** Addresses remembered (tests). */
  get size(): number {
    return this.records.size;
  }

  /** The address's record, dropped once it is RCON_FORGET_MS past its lockout's end. */
  private current(address: string): AddressRecord | undefined {
    const r = this.records.get(address);
    if (r === undefined) return undefined;
    if (forgotten(r, this.now())) {
      this.records.delete(address);
      return undefined;
    }
    return r;
  }

  private sweep(now: number): void {
    for (const [address, r] of this.records) {
      if (forgotten(r, now)) this.records.delete(address);
    }
  }
}

/** Whether `r` went RCON_FORGET_MS without a failure since it could fail again. */
function forgotten(r: AddressRecord, now: number): boolean {
  return now - Math.max(r.lastFailure, r.lockedUntil) >= RCON_FORGET_MS;
}

/**
 * One match's side of the guard (its `MatchOptions.rconGate`): the match names clients by id, the
 * guard counts by remote address, so the listener records each client's address here when it
 * connects. Wrong passwords are logged as `rcon_fail` with the address, never with the text.
 */
export class MatchRconGate implements RconGate {
  /** Each client id's remote address, as the listener counted it (`sv_maxPerIp`). */
  readonly addresses: string[] = new Array<string>(MATCH_MAX_CLIENTS).fill("");

  constructor(
    private readonly guard: RconGuard,
    private readonly match: string,
    private readonly log: JsonLog,
  ) {}

  allow(clientId: number): boolean {
    return this.guard.allow(this.addresses[clientId] ?? "");
  }

  result(clientId: number, ok: boolean): void {
    const ip = this.addresses[clientId] ?? "";
    const r = this.guard.result(ip, ok);
    if (ok) return;
    this.log("warn", "rcon_fail", {
      match: this.match,
      client: clientId,
      ip,
      failures: r.failures,
      lockoutS: r.lockoutMs / 1000,
    });
  }
}

/**
 * `SV_RCON_PASSWORD` as the server takes it (D-042): unset or empty disables rcon; anything else
 * must be printable ASCII without a double quote (the client sends it as one quoted token), at
 * most 255 chars. Returns the password, or the reason it cannot be used.
 */
export function validRconPassword(
  password: string | undefined,
): { ok: true; password: string } | { ok: false; error: string } {
  const p = password ?? "";
  if (p.length > 255) return { ok: false, error: "SV_RCON_PASSWORD is longer than 255 chars" };
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c < 0x20 || c > 0x7e || c === 0x22) {
      return {
        ok: false,
        error: "SV_RCON_PASSWORD must be printable ASCII without double quotes",
      };
    }
  }
  return { ok: true, password: p };
}
