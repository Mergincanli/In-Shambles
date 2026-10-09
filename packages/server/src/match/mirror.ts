import { FrameRing, type WorldFrame } from "@game/shared";
import type { WorldHistory } from "./history";

/**
 * What one client was sent, for each sent tick whose frame was not plain (M3 design §2.3, D-046):
 * a frame is plain when it equals the world frame of its tick (nothing left out), so it needs no
 * copy; one where the byte-budget scheduler left players out is stored here as the client holds
 * it, every slot absent, fresh (the world's row, stamp = the tick), copied (a left-out player
 * keeps its baseline's row, serial and stamp, copied at send time, so a chain of deferrals never
 * reaches past the 64-frame history) or pending (stamp 0). The ring's tick marks tell the two
 * kinds apart: a sent tick it holds was mirrored, any other sent tick was plain.
 *
 * About 225 KB each (64 frames of 64 slots). Only sessions of a match that admits more than 37
 * players get one (below that every frame is plain by construction), from the match's pool.
 */
export class ClientMirror {
  readonly ring = new FrameRing();

  /** Forgets every frame (a new session takes it). */
  reset(): void {
    this.ring.clear();
  }
}

/**
 * A match's spare mirrors (D-046): a leaving session returns its mirror and the next one to
 * connect takes it, so a match allocates at most one per slot it ever filled at once.
 */
export class MirrorPool {
  private readonly free: ClientMirror[] = [];
  /** Mirrors created so far (0 in a match that never admitted more than 37 players). */
  allocated = 0;

  acquire(): ClientMirror {
    const m = this.free.pop();
    if (m !== undefined) {
      m.reset();
      return m;
    }
    this.allocated++;
    return new ClientMirror();
  }

  release(m: ClientMirror): void {
    m.reset();
    this.free.push(m);
  }

  /** Mirrors waiting to be reused. */
  get spare(): number {
    return this.free.length;
  }
}

/**
 * The frame a client holds for its sent tick `tick` (the M3 design's `MirrorView`): its mirror's
 * frame when the tick was mirrored, else the world frame of the tick (a plain frame); null when
 * neither is held. The receiver's own row is the world's in both. No allocation.
 */
export function sentFrame(
  history: WorldHistory,
  mirror: ClientMirror | null,
  tick: number,
): WorldFrame | null {
  if (mirror !== null) {
    const f = mirror.ring.get(tick);
    if (f !== null) return f;
  }
  return history.get(tick);
}
