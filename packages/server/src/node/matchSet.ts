import type { Tickable } from "../match/loop";
import { type PassClock, type ServerMatch, TimedPass } from "./host";
import type { JsonLog } from "./log";

/** A match name (D-047, M3 design §2.17): what `/m/<name>`, `@<name>` and `match_add` take. */
export const MATCH_NAME = /^[a-z0-9_]{1,32}$/;

/**
 * The matches of one server process (D-047, M3 design §2.17): named, in creation order, all on one
 * loop and one port. The set is the loop's `Tickable`: every pass ticks each match once, in
 * creation order, through its `TimedPass` (each match timed into its own histogram and the whole
 * pass into the process's, the NET-09 judge). Matches share no state, so a match's results never
 * depend on its neighbours; they share the loop's time, so one slow match lengthens every pass and
 * a catch-up drop drops the same ticks in all of them (`tick_drop` names each). The default match,
 * which `/` and an unprefixed console line address, is the oldest one left. Adding and removing
 * happen between ticks (a console line, a config line): a pass never sees the list change.
 */
export class MatchSet<M extends ServerMatch = ServerMatch> implements Tickable {
  /** The matches in creation order (the pass reads this array; the set alone changes it). */
  readonly list: M[] = [];
  readonly pass: TimedPass;
  private readonly byName = new Map<string, M>();

  constructor(log: JsonLog, clock?: PassClock) {
    this.pass = new TimedPass(this.list, log, clock);
  }

  tick(): void {
    this.pass.tick();
  }

  /** The oldest match left: the one `/` and unprefixed console lines address. */
  get default(): M | undefined {
    return this.list[0];
  }

  get size(): number {
    return this.list.length;
  }

  /** The match named `name` (a Map lookup: no name reaches an object's prototype). */
  get(name: string): M | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Appends `m`, the newest match; throws on a name taken or not a MATCH_NAME (callers check). */
  add(m: M): void {
    if (!MATCH_NAME.test(m.name)) throw new Error(`"${m.name}" is not a match name`);
    if (this.byName.has(m.name)) throw new Error(`match ${m.name} exists`);
    this.list.push(m);
    this.byName.set(m.name, m);
  }

  /** Takes the match named `name` out of the set and returns it; undefined when there is none. */
  remove(name: string): M | undefined {
    const m = this.byName.get(name);
    if (m === undefined) return undefined;
    this.byName.delete(name);
    this.list.splice(this.list.indexOf(m), 1);
    return m;
  }
}
