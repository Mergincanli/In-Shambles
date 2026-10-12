import type { ClientSim, CmdSampler } from "@game/client/net";
import type { Match } from "@game/server";
import type { NetProfile, NetSimTransport, PlayerState, Transport } from "@game/shared";
import { type FrameLog, type FrameModel, type HarnessClient, MultiHarness } from "./multiHarness";

export {
  FRAME_HZ,
  FRAMES_144HZ,
  FRAMES_BROWSER_HITCHES,
  FRAMES_CRAWLING_HOST,
  FRAMES_SLOW_HOST,
  FRAMES_SLOWER_HOST,
  FrameLog,
  type FrameModel,
  framesSwitchingAt,
  HARNESS_BUILD,
} from "./multiHarness";

/**
 * The one-client NET harness (M2 design §5, D-025), now a facade over `MultiHarness` (M3 design
 * §1 tools) so NET-03, NET-04 and the client tests run unchanged: the real `Match` from
 * @game/server and the real client net code (`ClientSim`) over an in-memory loopback pair,
 * optionally impaired by `NetSimTransport` on the client's end, all on one fake clock. The event
 * loop runs the server's own match loop (through a fake `LoopHost`), the simulator's wakes and
 * client frames at 144 Hz (or `frameHz`) ± 1 ms jitter, or as a frame model draws them
 * (`frameIntervalMs`), in time order, so a seed gives one run: the same run as before the facade.
 *
 * It records the server's state of the player after every tick, the client's prediction of every
 * tick (the first one, and the one standing when the tick's snapshot was reconciled), and per frame
 * the drawn position, the player's speed and the render offset. The client is admin, as the
 * Worker's one client is.
 */

export interface HarnessOptions {
  readonly input: CmdSampler;
  /** `lan` (the default) runs over the bare loopback pair, anything else through NetSim. */
  readonly profile?: NetProfile;
  readonly seed?: number;
  readonly map?: string;
  /** Client frame rate (FRAME_HZ by default); each frame still jitters by ±1 ms. */
  readonly frameHz?: number;
  /**
   * Draws each frame gap instead of `frameHz` (from the harness's generator, so a seed is one
   * run); FRAMES_144HZ by default.
   */
  readonly frameIntervalMs?: FrameModel;
  /** Wraps the client's transport (after NetSim), e.g. to drop or rewrite what it receives. */
  readonly wrap?: (t: Transport) => Transport;
  /** False keeps the clock's dilation at 0 (NET-07's control). Default true. */
  readonly dilation?: boolean;
  /** The pmove primer at the match and the client (MultiHarnessOptions.primer). */
  readonly primer?: boolean;
}

export class NetHarness {
  readonly multi: MultiHarness;
  readonly player: HarnessClient;

  constructor(options: HarnessOptions) {
    this.multi = new MultiHarness({
      map: options.map,
      seed: options.seed,
      ...(options.primer === undefined ? {} : { primer: options.primer }),
    });
    this.player = this.multi.addClient({
      input: options.input,
      profile: options.profile,
      frameHz: options.frameHz,
      frameIntervalMs: options.frameIntervalMs,
      wrap: options.wrap,
      dilation: options.dilation,
      admin: true,
      record: true,
    });
  }

  get match(): Match {
    return this.multi.match;
  }
  get client(): ClientSim {
    return this.player.client;
  }
  get sim(): NetSimTransport | null {
    return this.player.sim;
  }
  get profile(): NetProfile {
    return this.player.profile;
  }
  /** The server's state of the player after each tick, by tick. */
  get server(): Map<number, PlayerState> {
    return this.player.server;
  }
  /** Server ticks that repeated a cmd because ours had not arrived. */
  get serverStarved(): number[] {
    return this.player.serverStarved;
  }
  /** The client's first prediction of each tick. */
  get firstPredicted(): Map<number, PlayerState> {
    return this.player.firstPredicted;
  }
  /** The prediction standing for each tick once the newest snapshot reached it. */
  get finalPredicted(): Map<number, PlayerState> {
    return this.player.finalPredicted;
  }
  /** Each tick that was the client's newest snapshot after some frame (its reconcile point). */
  get snapshotTicks(): number[] {
    return this.player.snapshotTicks;
  }
  get frames(): FrameLog {
    return this.player.frames;
  }
  /** Every movement event the client filed (ClientSim.events), across frames, oldest first. */
  get events(): { tick: number; type: number; value: number; jumped: boolean }[] {
    return this.player.events;
  }
  get now(): number {
    return this.multi.now;
  }
  /** Runs before every server tick (tests move the player or change the match here). */
  get beforeServerTick(): (() => void) | null {
    return this.multi.beforeServerTick;
  }
  set beforeServerTick(cb: (() => void) | null) {
    this.multi.beforeServerTick = cb;
  }

  /** Runs the event loop for `ms` of simulated time. */
  run(ms: number): void {
    this.multi.run(ms);
  }

  /** Runs until the client has predicted `ticks` ticks past its startup fill (or `maxMs` passed). */
  runTicks(ticks: number, maxMs = 120_000): void {
    const c = this.player.client;
    try {
      this.multi.runUntil(
        () => c.active && c.predictor.latestTick - c.startTick >= ticks,
        maxMs,
        `${ticks} predicted ticks`,
      );
    } catch (e) {
      throw new Error(`${(e as Error).message} (state ${c.state})`);
    }
  }

  stop(): void {
    this.multi.stop();
  }

  /** Stalls the client for `ms` from now (a GC, a tab switch): one frame then spans the gap. */
  hitch(ms: number): void {
    this.player.hitch(ms);
  }

  /** Ticks where the server's state differs from `predictions` (both recorded). */
  mismatches(predictions: Map<number, PlayerState>, fromTick = 0): number[] {
    return this.player.mismatches(predictions, fromTick);
  }

  /** Snapshot ticks reconciled with whose standing prediction still differs from the server's. */
  unreconciled(): number[] {
    return this.player.unreconciled();
  }

  /** How many ticks the client's newest prediction leads the server's newest tick. */
  lead(): number {
    return this.player.lead();
  }

  /** Ticks with both a server state and a prediction in `predictions`. */
  compared(predictions: Map<number, PlayerState>): number {
    return this.player.compared(predictions);
  }

  totals(): ReturnType<HarnessClient["totals"]> {
    return this.player.totals();
  }
}
