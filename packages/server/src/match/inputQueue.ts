import { copyUserCmd, UserCmd } from "@game/shared";

/**
 * Ticks a queue holds at once, from the next tick to simulate (M2 design §2 "InputQueue"; a
 * design constant). About 1 s at 60 Hz: a cmd further ahead than that is a broken or hostile
 * client clock, not latency.
 */
export const INPUT_QUEUE_HORIZON = 64;
const SLOT_MASK = INPUT_QUEUE_HORIZON - 1;

/**
 * One client's received cmds keyed by tick (docs/05 §8.1 step 1): slot `tick & 63`, with
 * `slotTick` saying which tick a slot holds, so a stale slot never passes for a newer tick. A slot
 * keeps its tick after the cmd is taken, so with 4× input redundancy (docs/05 §3.4) the copies
 * that arrive after their tick was simulated still count as duplicates; `late` counts only cmds
 * for a tick the match had to simulate without them (starved). Cmds beyond the horizon are
 * dropped too. Allocation-free after construction.
 */
export class InputQueue {
  private readonly slots: UserCmd[] = [];
  private readonly slotTick = new Int32Array(INPUT_QUEUE_HORIZON).fill(-1);
  /** 1 once the slot's cmd was taken: it stays as a record that its tick had its own cmd. */
  private readonly slotTaken = new Uint8Array(INPUT_QUEUE_HORIZON);
  /** The lowest tick still accepted: the next one the match simulates for this client. */
  private nextTick = 0;
  /**
   * The newest cmd tick received, accepted or not, for `inputBufferHealth` (docs/05 §8.2); capped
   * at the horizon, so a hostile tick can't pin it. Starts one below the first tick to take (the
   * spawn tick), so health counts 0, −1, −2 … until the client's first cmd arrives.
   */
  newestTick = -1;
  /** Cmds stored. */
  accepted = 0;
  /** Copies of a cmd already stored or simulated (redundancy, or a duplicated datagram). */
  duplicates = 0;
  /** Cmds for a tick already simulated with a repeated cmd (or too old to tell). */
  late = 0;
  /** Cmds INPUT_QUEUE_HORIZON or more ticks past the next tick. */
  early = 0;

  constructor() {
    for (let i = 0; i < INPUT_QUEUE_HORIZON; i++) this.slots.push(new UserCmd());
  }

  /** Forgets every cmd and counter; `nextTick` is the first tick that will be taken (a spawn). */
  reset(nextTick: number): void {
    this.slotTick.fill(-1);
    this.slotTaken.fill(0);
    this.nextTick = nextTick;
    this.newestTick = nextTick - 1;
    this.accepted = 0;
    this.duplicates = 0;
    this.late = 0;
    this.early = 0;
  }

  get next(): number {
    return this.nextTick;
  }

  /** Stores a copy of `cmd` under `cmd.tick`; false when it is a duplicate, late or too early. */
  push(cmd: UserCmd): boolean {
    const tick = cmd.tick;
    const newest = Math.min(tick, this.nextTick + INPUT_QUEUE_HORIZON);
    if (newest > this.newestTick) this.newestTick = newest;
    const i = tick & SLOT_MASK;
    if (tick < this.nextTick) {
      if (this.slotTick[i] === tick) this.duplicates++;
      else this.late++;
      return false;
    }
    if (tick >= this.nextTick + INPUT_QUEUE_HORIZON) {
      this.early++;
      return false;
    }
    if (this.slotTick[i] === tick) {
      this.duplicates++;
      return false;
    }
    copyUserCmd(this.slots[i] as UserCmd, cmd);
    this.slotTick[i] = tick;
    this.slotTaken[i] = 0;
    this.accepted++;
    return true;
  }

  /**
   * Copies the cmd for `tick` into `out` and returns true, or returns false (out untouched) when
   * none arrived. Either way ticks up to `tick` are closed: later cmds for them are dropped.
   */
  take(tick: number, out: UserCmd): boolean {
    if (tick + 1 > this.nextTick) this.nextTick = tick + 1;
    const i = tick & SLOT_MASK;
    if (this.slotTick[i] !== tick || this.slotTaken[i] !== 0) return false;
    copyUserCmd(out, this.slots[i] as UserCmd);
    this.slotTaken[i] = 1;
    return true;
  }
}
