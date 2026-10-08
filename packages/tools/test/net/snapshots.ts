import {
  type BitReader,
  type BitWriter,
  decodeSnapshotBody,
  decodeSnapshotHeader,
  encodeSnapshot,
  type PlayerState,
  playerStateToSlot,
  SnapshotHeader,
  WorldFrame,
} from "@game/shared";

/**
 * Snapshots a test reads or writes by hand (protocol v2, D-033): a header and a frame, for one
 * receiver. Tests rewrite what a client receives with it, or speak for the server.
 */
export class HandSnapshot {
  readonly header = new SnapshotHeader();
  readonly frame = new WorldFrame();

  constructor(public selfId: number) {}

  /** Header and body as the receiver reads them; false when they don't decode. */
  decode(r: BitReader): boolean {
    return (
      decodeSnapshotHeader(r, this.header) &&
      decodeSnapshotBody(r, this.header, null, this.selfId, this.frame)
    );
  }

  encode(w: BitWriter): boolean {
    w.reset();
    return encodeSnapshot(w, this.header, this.frame, null, this.selfId);
  }

  /**
   * Makes it a snapshot of `tick` holding only the receiver, in state `ps` with teleport counter
   * `teleportSeq`, and the other header fields given.
   */
  local(
    tick: number,
    ps: Readonly<PlayerState>,
    fields: { health?: number; cvarHash?: number; flags?: number; teleportSeq?: number } = {},
  ): this {
    if (this.selfId < 0) throw new Error("a spectator snapshot has no local player");
    const h = this.header;
    h.serverTick = tick;
    h.baseBack = 0;
    h.flags = fields.flags ?? 0;
    h.cvarHash = fields.cvarHash ?? 0;
    h.inputBufferHealth = fields.health ?? 0;
    const f = this.frame;
    f.clear();
    f.setPresent(this.selfId, tick);
    playerStateToSlot(f, this.selfId, ps);
    f.teleportSeq[this.selfId] = fields.teleportSeq ?? 0;
    return this;
  }
}
