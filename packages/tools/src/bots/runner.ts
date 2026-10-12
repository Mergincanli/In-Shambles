import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClientSim,
  type CmdSampler,
  JM_CHECKED,
  JM_VIOLATIONS,
  RC_DT_MS,
  RemoteJumpMeter,
  RouteInput,
  STAT_CORRECTION_DIST,
  STAT_CORRECTION_MAX,
  STAT_CORRECTIONS,
  STAT_COUNT,
  STAT_HARD_RESYNCS,
  STAT_REMOTE_EXTRAPOLATED,
  STAT_REMOTE_FRAMES,
  STAT_REMOTE_HELD,
  STAT_SNAPSHOTS,
  STAT_SNAPSHOTS_LOST,
  STAT_STARVED,
  STAT_STARVED_CORRECTIONS,
  STAT_STRIKES,
  STAT_TELEPORTS,
  TICK_MS,
  WebSocketTransport,
} from "@game/client/net";
import { findNetProfile, NET_PROFILES, type NetProfile, NetSimTransport } from "@game/shared";
import { loadCourse } from "../scenarios/course";
import { buildRefusal, buildWarning } from "./builds";
import {
  type HostGate,
  type HostLoad,
  holdNice,
  hostGate,
  hostLoad,
  lowerPriority,
  processNice,
} from "./host";
import { HumanPlayer, type PageStatus } from "./human";
import { createBotInput } from "./routes";
import { type ServerChild, serverChildArgs, startServerChild } from "./serverChild";
import {
  aggregate,
  type BotNumbers,
  type BotsSummary,
  evaluateChecks,
  type HumanNumbers,
  humanNumbers,
  r3,
  type SummaryConfig,
  type SummaryServer,
  summaryPasses,
  writeSummary,
} from "./summary";
import { BotTap, histogramMax, histogramPercentile } from "./tap";

/**
 * The bots runner (M3 design §2.15, D-036): N headless clients in one process, each a `ClientSim`
 * over its own net simulator (the profile, seeded `seed + i`) over a `WebSocketTransport` on
 * Node's built-in WebSocket, so bots exercise the same client code and the same socket path as a
 * browser. One `setTimeout` chain frames them all at 60 Hz, each at its own phase. Each loads the
 * map WELCOME names from disk. Before connecting, the runner reads the target match's
 * `maxClients` from `GET /status` and refuses a count that does not fit.
 *
 * Timeline: the host gate → the server child (if any) → `/status` and the count check → this
 * process lowers its priority → the human stand-in's page (`--human`: its build hash must be the
 * server's) → the bots connect (100 ms apart) → every bot active and the human playing with every
 * bot drawn (or the join timeout) → the measured window of `minutes` → read the server's metrics
 * → disconnect → the summary. Without `--server` it starts the server itself (serverChild.ts) and
 * reads the run window from its `--metrics-out` file after stopping it; with `--server` it reads
 * `GET /metrics` at the window's start and end, so the counters and traffic are the bots'
 * window's. A server that stops answering, or a child that died, still leaves a summary, with the
 * server's numbers missing and the reason.
 */

/** Frames per second each bot runs (design: 60 Hz). */
export const BOT_FRAME_HZ = 60;
const FRAME_MS = 1000 / BOT_FRAME_HZ;
/** Gap between two bots' connects, ms (as the multi-client baseline joins). */
const JOIN_GAP_MS = 100;
/** How long every bot may take to become active, ms. */
const JOIN_TIMEOUT_MS = 20_000;
/** The server child's discarded start (design: 10 s; at most a quarter of a short run). */
const DISCARD_S = 10;
/** How often the generators' priority is re-held (host.ts holdNice), ms. */
const NICE_HOLD_MS = 1000;
/** Progress lines while the window runs, ms apart. */
const PROGRESS_MS = 10_000;
/**
 * Map names a bot loads from `content/maps` (the server's own rule, `node/maps.ts`): WELCOME's
 * name comes off the wire, so a hostile `--server` must not reach a path outside the folder.
 */
const MAP_NAME = /^[a-z0-9_]{1,63}$/;

export interface BotRunOptions {
  readonly count: number;
  /** A `NET_PROFILES` name. */
  readonly profile: string;
  /** The measured window, minutes (fractions allowed). */
  readonly minutes: number;
  readonly map: string;
  /** `ws://host:port[/path]`; null starts the server as a child. */
  readonly server: string | null;
  readonly seed: number;
  /** A headless browser player as well (human.ts, D-045). */
  readonly human: boolean;
  /**
   * Judges the code as it is: refuses a stale server bundle (when it starts the server) or client
   * build (`--human`), and a host that fails the gate (default false; the CLI's `--strict`).
   */
  readonly strict?: boolean;
  /**
   * The host gate (host.ts): the 1-minute load per core before the run, a judged check (default
   * false, as for in-process tests whose host is busy by design; the CLI always gates).
   */
  readonly hostGate?: boolean;
  /**
   * The niceness this process lowers itself to once its server child runs (bots, `vite preview`
   * and Chromium with it); 0, the default, leaves it (the CLI: 10, D-045).
   */
  readonly nice?: number;
  /** Where `<stamp>.json` and `.md` go; null writes nothing. */
  readonly outDir: string | null;
  /** Progress lines; none when absent. */
  readonly log?: (text: string) => void;
  /** Ends the window early (Ctrl+C): the summary covers what ran. */
  readonly abort?: AbortSignal;
  /** Called with the server child once it listens (tests stop it mid-run). */
  readonly onServerChild?: (child: ServerChild) => void;
  /**
   * The pmove primer (D-040) at the first bot's ClientSim, once per process (default true, as in
   * play). In-process tests pass false to save its cost; it never changes a result.
   */
  readonly primer?: boolean;
  /** The host's load and cores as the gate reads them (tests pass a busy host). */
  readonly hostLoad?: () => HostLoad;
}

/**
 * A run the runner will not start: a bad option, a count the match can't hold, a stale build
 * (under `--strict`, or a human's page of another build).
 */
export class BotsRefused extends Error {
  override name = "BotsRefused";
}

/** A `--strict` run that FAILs before it starts: the host gate (exit 1, never a skip). */
export class BotsFailed extends Error {
  override name = "BotsFailed";
}

/** One match as `GET /status` lists it. */
export interface StatusMatch {
  readonly name: string;
  readonly map: string;
  readonly players: number;
  readonly maxClients: number;
}

export interface ServerStatus {
  readonly buildHash: string;
  readonly protocol: number;
  readonly matches: readonly StatusMatch[];
}

/**
 * Why `count` bots (plus a human) don't fit `match`, or null when they do. Players already in the
 * match count against its `maxClients` too. The human needs the match to itself and the bots: its
 * joined check is the server's players = bots + 1 and its page drawing exactly the bots.
 */
export function checkCount(count: number, human: boolean, match: StatusMatch): string | null {
  const who = `count ${count}${human ? " + human" : ""}`;
  if (human && match.players > 0) {
    return (
      `--human: match ${match.name} already holds ${match.players} players; the human's joined ` +
      "check needs a match with only the bots"
    );
  }
  if (count + (human ? 1 : 0) + match.players <= match.maxClients) return null;
  const already = match.players > 0 ? ` + ${match.players} players already in` : "";
  return `${who}${already} > maxClients ${match.maxClients} on match ${match.name}`;
}

/** Why the human's page may not play against this server, or null: it must be the same build. */
export function hashRefusal(pageHash: string, serverHash: string): string | null {
  return pageHash === serverHash ? null : `rebuild: preview ${pageHash} ≠ server ${serverHash}`;
}

/** A named match's path (D-047): the server's own rule (`/m/<name>`, wsListener.ts). */
const MATCH_PATH = /^\/m\/([a-z0-9_]{1,32})$/;

/**
 * The `/status` URL of a server's WebSocket URL (`ws://host:port/…` → `http://host:port/status`).
 * The URL must address a match the way the server's listener does: `/` (or nothing) for the
 * default match, `/m/<name>` for a named one, no query string (D-047); anything else the server
 * would refuse with a 404, so it is refused here with the reason.
 */
export function statusUrl(server: string, page = "status"): string {
  let u: URL;
  try {
    u = new URL(server);
  } catch {
    throw new BotsRefused(`--server ${server}: not a URL (expected ws://host:port)`);
  }
  if (u.protocol !== "ws:") throw new BotsRefused(`--server ${server}: expected ws://host:port`);
  // URL reports a bare `?` or `#` as "", so the raw text is checked too (a fragment would make
  // WebSocket throw at connect, a query string is refused by the server).
  const extra = server.includes("?") || server.includes("#");
  if (extra || (u.pathname !== "/" && !MATCH_PATH.test(u.pathname))) {
    throw new BotsRefused(
      `--server ${server}: expected ws://host:port or ws://host:port/m/<match> (D-047)`,
    );
  }
  return `http://${u.host}/${page}`;
}

/** The match a WebSocket URL addresses: `/m/<name>` names one (D-047), `/` the default. */
export function matchOf(server: string, status: ServerStatus): StatusMatch {
  const path = new URL(server).pathname;
  const named = MATCH_PATH.exec(path)?.[1];
  const match =
    named === undefined ? status.matches[0] : status.matches.find((m) => m.name === named);
  if (match === undefined) {
    throw new BotsRefused(`--server ${server}: no match ${named ?? "(default)"} on that server`);
  }
  return match;
}

/** A server page as JSON; a server that does not answer is a BotsRefused with the cause. */
async function getJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : String(e);
    throw new BotsRefused(`${url}: no server answering (${cause})`);
  }
  if (!res.ok) throw new BotsRefused(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** `getJson`, or the reason it failed. */
async function tryJson(url: string): Promise<{ json: unknown } | { error: string }> {
  try {
    return { json: await getJson(url) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Checks the options that need no server. */
export function validateOptions(o: BotRunOptions): NetProfile {
  const most = o.human ? 63 : 64;
  if (!Number.isInteger(o.count) || o.count < 1 || o.count > most) {
    throw new BotsRefused(
      `--count ${o.count}: expected 1–${most}${o.human ? " with --human" : ""}`,
    );
  }
  const profile = findNetProfile(o.profile);
  if (profile === undefined) {
    throw new BotsRefused(
      `--profile ${o.profile}: expected one of ${NET_PROFILES.map((p) => p.name).join(", ")}`,
    );
  }
  if (!(o.minutes > 0) || !Number.isFinite(o.minutes)) {
    throw new BotsRefused(`--minutes ${o.minutes}: expected a positive number`);
  }
  if (!MAP_NAME.test(o.map)) throw new BotsRefused(`--map ${o.map}: expected a map id`);
  return profile;
}

/** One bot: its client, link, tap and the numbers of the measured window. */
class Bot {
  readonly client: ClientSim;
  readonly tap: BotTap;
  readonly sim: NetSimTransport;
  nextFrameAt = 0;
  joined = false;
  /** Why its session closed, once it did. */
  closed: string | null = null;
  /** Totals, tap counters and snapshot sizes when the window began. */
  private readonly base = new Float64Array(STAT_COUNT);
  private readonly sizesBase: Uint32Array;
  private readonly tapBase = new Float64Array(4);
  private readonly second = new Float64Array(STAT_COUNT);
  /** Down bytes and the time at the last 1 s sample, the peak rate (B/s), buffer health. */
  private lastDown = 0;
  private lastSampleAt = 0;
  private peakDown = 0;
  private bufferSum = 0;
  private bufferSamples = 0;
  private bufferLow = Number.POSITIVE_INFINITY;
  private maxCorrection = 0;
  private measuring = false;
  /**
   * NET-05's criterion on what this bot draws of the others (D-037), judged on its frames that
   * are not long (past the input buffer: the event loop's stall, as the page leaves out its own).
   */
  private readonly jumps = new RemoteJumpMeter();
  private jumpsBase = 0;
  private judgedBase = 0;
  /** The interpolation delay at each 1 s sample: sum, count and largest (ticks). */
  private delaySum = 0;
  private delaySamples = 0;
  private delayMax = 0;

  constructor(
    readonly id: number,
    readonly url: string,
    readonly input: CmdSampler,
    profile: NetProfile,
    seed: number,
    buildHash: string,
    primer: boolean,
  ) {
    const ws = new WebSocket(url);
    this.tap = new BotTap(new WebSocketTransport(ws));
    const pump = () => this.sim.pump();
    this.sim = new NetSimTransport(
      this.tap,
      profile,
      () => performance.now(),
      seed,
      (at) => {
        setTimeout(pump, Math.max(0, at - performance.now()));
      },
    );
    this.sizesBase = new Uint32Array(this.tap.snapshotSizes.length);
    this.client = new ClientSim({
      transport: this.sim,
      buildHash,
      clock: () => performance.now(),
      input,
      primer,
      webSocket: true,
      onMapRequest: (name) => {
        // Thrown here, ClientSim ends the session with the reason.
        if (!MAP_NAME.test(name)) throw new Error(`refused map name ${JSON.stringify(name)}`);
        const course = loadCourse(name);
        this.client.provideMap(course.cmap, course.world);
      },
      onClosed: (reason) => {
        this.closed = reason;
      },
    });
  }

  frame(): void {
    const c = this.client;
    if (c.closed) return;
    c.frame();
    c.updateRemotes();
    if (!c.active) return;
    this.joined = true;
    const long = (c.remotes.clock.t[RC_DT_MS] as number) > c.settings.inputBuffer * TICK_MS;
    this.jumps.measure(c.remotes, !long);
  }

  /**
   * About once a second while measuring (`now`, ms): the peak down rate over the time since the
   * last sample, the largest correction, the input buffer's health.
   */
  sampleSecond(now: number): void {
    if (!this.measuring || this.client.closed) return;
    const down = this.tap.bytesDown;
    const dt = (now - this.lastSampleAt) / 1000;
    if (dt > 0.5) this.peakDown = Math.max(this.peakDown, (down - this.lastDown) / dt);
    this.lastDown = down;
    this.lastSampleAt = now;
    this.client.stats.lastSecond(this.second);
    this.maxCorrection = Math.max(this.maxCorrection, this.second[STAT_CORRECTION_MAX] as number);
    const clock = this.client.clock;
    this.bufferSum += clock.bufferHealth;
    this.bufferSamples++;
    this.bufferLow = Math.min(this.bufferLow, clock.bufferLow);
    if (this.client.active) {
      const d = this.client.remotes.delayTicks;
      this.delaySum += d;
      this.delaySamples++;
      this.delayMax = Math.max(this.delayMax, d);
    }
  }

  begin(): void {
    this.measuring = true;
    this.base.set(this.client.stats.totals);
    this.sizesBase.set(this.tap.snapshotSizes);
    const t = this.tap;
    this.tapBase[0] = t.bytesDown;
    this.tapBase[1] = t.bytesUp;
    this.tapBase[2] = t.snapshots;
    this.tapBase[3] = t.fullSnapshots;
    this.lastDown = t.bytesDown;
    this.lastSampleAt = performance.now();
    this.jumpsBase = this.jumps.t[JM_VIOLATIONS] as number;
    this.judgedBase = this.jumps.t[JM_CHECKED] as number;
  }

  numbers(seconds: number): BotNumbers {
    const t = this.client.stats.totals;
    const d = (stat: number) => (t[stat] as number) - (this.base[stat] as number);
    const corrections = d(STAT_CORRECTIONS);
    // Corrections with no starve since the previous snapshot received (D-050): a starve's own
    // correction counts as starved even when the snapshot of the starved tick was lost.
    const mispredictions = corrections - d(STAT_STARVED_CORRECTIONS);
    const sizes = this.tap.snapshotSizes.slice();
    for (let i = 0; i < sizes.length; i++)
      sizes[i] = (sizes[i] as number) - (this.sizesBase[i] as number);
    const snapshots = this.tap.snapshots - (this.tapBase[2] as number);
    const full = this.tap.fullSnapshots - (this.tapBase[3] as number);
    const route = this.input instanceof RouteInput ? this.input : null;
    const remoteFrames = d(STAT_REMOTE_FRAMES);
    return {
      id: this.id,
      behaviour: route === null ? "walk" : "route",
      joined: this.joined,
      closed: this.closed,
      seconds: r3(seconds),
      snapshots: d(STAT_SNAPSHOTS),
      snapshotsLost: d(STAT_SNAPSHOTS_LOST),
      correctionsPerS: r3(seconds > 0 ? corrections / seconds : 0),
      meanCorrection: r3(corrections > 0 ? d(STAT_CORRECTION_DIST) / corrections : 0),
      maxCorrection: r3(this.maxCorrection),
      mispredictions,
      starved: d(STAT_STARVED),
      hardResyncs: d(STAT_HARD_RESYNCS),
      teleports: d(STAT_TELEPORTS),
      strikes: d(STAT_STRIKES),
      bufferMean: r3(this.bufferSamples > 0 ? this.bufferSum / this.bufferSamples : 0),
      bufferLow: this.bufferSamples > 0 ? this.bufferLow : 0,
      kbDownPerS: r3(
        seconds > 0 ? (this.tap.bytesDown - (this.tapBase[0] as number)) / seconds / 1000 : 0,
      ),
      kbDownPeak: r3(this.peakDown / 1000),
      kbUpPerS: r3(
        seconds > 0 ? (this.tap.bytesUp - (this.tapBase[1] as number)) / seconds / 1000 : 0,
      ),
      snapshotBytes: {
        p50: histogramPercentile(sizes, 50),
        p95: histogramPercentile(sizes, 95),
        max: histogramMax(sizes),
      },
      deltaShare: r3(snapshots > 0 ? (snapshots - full) / snapshots : 0),
      interpDelay: {
        mean: r3(this.delaySamples > 0 ? this.delaySum / this.delaySamples : 0),
        max: this.delayMax,
      },
      extrapolatedShare: r3(
        remoteFrames > 0 ? (d(STAT_REMOTE_EXTRAPOLATED) + d(STAT_REMOTE_HELD)) / remoteFrames : 0,
      ),
      remoteJumps: (this.jumps.t[JM_VIOLATIONS] as number) - this.jumpsBase,
      remoteJudged: (this.jumps.t[JM_CHECKED] as number) - this.judgedBase,
      laps: route === null ? null : route.laps,
      stuckShare:
        route === null
          ? null
          : r3(route.movingTicks > 0 ? route.stuckTicks / route.movingTicks : 0),
    };
  }
}

/**
 * Frames every bot at 60 Hz from one `setTimeout` chain: bot i of N's frames are offset by i/N of
 * a frame, so the bots' sends spread over the frame like separate clients'. A bot more than a
 * frame late skips ahead instead of running a burst of frames. Once a second each bot samples its
 * peaks. Bots join it as they are made (`add`), each just before it connects.
 */
class FrameLoop {
  private timer: NodeJS.Timeout | null = null;
  private nextSecond = 0;
  private readonly bots: Bot[] = [];

  constructor(private readonly planned: number) {
    this.nextSecond = performance.now() + 1000;
    this.wake();
  }

  add(b: Bot): void {
    b.nextFrameAt = performance.now() + (this.bots.length * FRAME_MS) / this.planned;
    this.bots.push(b);
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private wake = (): void => {
    const now = performance.now();
    let next = Number.POSITIVE_INFINITY;
    for (const b of this.bots) {
      if (now >= b.nextFrameAt) {
        b.frame();
        b.nextFrameAt += FRAME_MS;
        if (b.nextFrameAt < now) b.nextFrameAt = now + FRAME_MS;
      }
      next = Math.min(next, b.nextFrameAt);
    }
    // No bot yet (they join through `add`): look again a frame from now.
    if (next === Number.POSITIVE_INFINITY) next = now + FRAME_MS;
    if (now >= this.nextSecond) {
      for (const b of this.bots) b.sampleSecond(now);
      this.nextSecond += 1000;
    }
    this.timer = setTimeout(this.wake, Math.max(1, Math.ceil(next - performance.now())));
  };
}

function sleep(ms: number, abort?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (abort?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      abort?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    abort?.addEventListener("abort", done, { once: true });
  });
}

interface MetricsJson {
  process: {
    runS: number;
    tickUs: { p50: number; p95: number; p99: number; max: number };
    gc: { count: number; maxMs: number };
    memoryMB: {
      heapUsed: number;
      external: number;
      rss: number;
      peakHeapExternal: number;
      peakRss: number;
    };
    cpuMsPerWallS: number;
    droppedTicks: number;
  };
  matches: Record<
    string,
    {
      /** The match's own run window, s: a per-match `metrics reset` restarts it alone. */
      runS: number;
      starved: number;
      snapshots: number;
      fullSnapshots: number;
      deferredSnapshots: number;
      deferredEntities: number;
      maxStaleness: number;
      snapshotOverflow: number;
      strikes: number;
      kicks: number;
      rateLimited: number;
      inputPackets: number;
      inputLost: number;
      traffic: { bytesIn: number; bytesOut: number; kbInPerS: number; kbOutPerS: number };
    }
  >;
}

/**
 * `/metrics` (or the `--metrics-out` file) as the summary's server section. With `begin` (a
 * `--server`'s `/metrics` when the bots' window opened) the counters and traffic are end minus
 * start over the time between the two readings, unless the run window restarted in between (then
 * they already lie inside the bots' window). A restart shows as a window that grew by less than
 * the `betweenS` seconds between the readings (less a second of slack): a `--metrics-discard`
 * ending, or a console `metrics reset`, after the start reading (the 4 × 16 load leg's servers
 * discard their first 10 s while the bots join). The process's counters follow the process's
 * window, the match's its own (a per-match `metrics reset <match>` restarts that one alone).
 * `sinceConnectS` is the time since the first bot connected, at the end reading: a longer run
 * window began before the bots.
 */
/** How much less than the time between two readings a run window may have grown, s. */
const RESTART_SLACK_S = 1;

export function serverSection(
  metrics: unknown,
  matchName: string,
  source: string,
  players: number,
  begin: unknown,
  sinceConnectS: number,
  betweenS = 0,
): SummaryServer {
  const m = metrics as MetricsJson;
  const p = m.process;
  const match = m.matches[matchName];
  if (match === undefined) throw new Error(`server metrics have no match ${matchName}`);
  const b = begin as MetricsJson | null;
  const bm = b?.matches[matchName];
  const kept = (end: number, start: number) => end >= start + betweenS - RESTART_SLACK_S;
  const pDelta = b !== null && kept(p.runS, b.process.runS);
  const delta = bm !== undefined && kept(match.runS, bm.runS);
  const sinceP = (end: number, start: number | undefined) =>
    pDelta ? end - (start as number) : end;
  const since = (end: number, start: number | undefined) => (delta ? end - (start as number) : end);
  const deltaS = delta ? match.runS - (bm as { runS: number }).runS : match.runS;
  const kb = (bytes: number, perS: number) =>
    delta ? r3(deltaS > 0 ? bytes / deltaS / 1000 : 0) : perS;
  return {
    source,
    runS: p.runS,
    beforeBotsS: r3(Math.max(0, p.runS - sinceConnectS)),
    players,
    tickUs: { p50: p.tickUs.p50, p95: p.tickUs.p95, p99: p.tickUs.p99, max: p.tickUs.max },
    gc: { count: p.gc.count, maxMs: p.gc.maxMs },
    memoryMB: {
      heapUsed: p.memoryMB.heapUsed,
      external: p.memoryMB.external,
      rss: p.memoryMB.rss,
      peakHeapExternal: p.memoryMB.peakHeapExternal,
      peakRss: p.memoryMB.peakRss,
    },
    cpuMsPerWallS: p.cpuMsPerWallS,
    droppedTicks: sinceP(p.droppedTicks, b?.process.droppedTicks),
    starved: since(match.starved, bm?.starved),
    fullSnapshots: since(match.fullSnapshots, bm?.fullSnapshots),
    snapshots: since(match.snapshots, bm?.snapshots),
    deferredSnapshots: since(match.deferredSnapshots, bm?.deferredSnapshots),
    deferredEntities: since(match.deferredEntities, bm?.deferredEntities),
    // A running maximum since the match started, not a window's.
    maxStaleness: match.maxStaleness,
    snapshotOverflow: since(match.snapshotOverflow, bm?.snapshotOverflow),
    strikes: since(match.strikes, bm?.strikes),
    kicks: since(match.kicks, bm?.kicks),
    rateLimited: since(match.rateLimited, bm?.rateLimited),
    inputLossPct: lossPct(
      since(match.inputLost, bm?.inputLost),
      since(match.inputPackets, bm?.inputPackets),
    ),
    kbOutPerS: kb(since(match.traffic.bytesOut, bm?.traffic.bytesOut), match.traffic.kbOutPerS),
    kbInPerS: kb(since(match.traffic.bytesIn, bm?.traffic.bytesIn), match.traffic.kbInPerS),
  };
}

/** INPUT packets lost of those sent (received + lost), percent to 3 decimals (D-041). */
function lossPct(lost: number, received: number): number {
  return lost + received > 0 ? r3((100 * lost) / (lost + received)) : 0;
}

export interface BotRunResult {
  readonly summary: BotsSummary;
  /** The written files, when `outDir` was given. */
  readonly files: { readonly json: string; readonly md: string } | null;
}

/** Runs the bots and returns (and writes) the summary. Throws BotsRefused on a refused run. */
export async function runBots(o: BotRunOptions): Promise<BotRunResult> {
  const profile = validateOptions(o);
  const strict = o.strict ?? false;
  const stale = buildRefusal({ strict, human: o.human, ownServer: o.server === null });
  if (stale !== null) throw new BotsRefused(stale);
  const log = o.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const readHost = o.hostLoad ?? hostLoad;
  const hostStart = readHost();
  const loadStart = hostStart.load1;
  const gate: HostGate | null = o.hostGate === true ? hostGate(loadStart, hostStart.cpus) : null;
  if (gate !== null && !gate.pass && strict) throw new BotsFailed(`host gate: ${gate.text}`);
  const runS = o.minutes * 60;

  let child: ServerChild | null = null;
  let metricsDir: string | null = null;
  let url: string;
  let serverName: string;
  if (o.server === null) {
    metricsDir = mkdtempSync(join(tmpdir(), "bots-metrics-"));
    const discard = Math.min(DISCARD_S, runS / 4);
    child = await startServerChild(
      serverChildArgs(o.count, o.map, join(metricsDir, "metrics.json"), discard),
    );
    url = `ws://127.0.0.1:${child.port}/`;
    serverName = `child (${child.kind})`;
    o.onServerChild?.(child);
  } else {
    url = o.server;
    serverName = o.server;
  }
  const serverPid = new Set(child?.child.pid === undefined ? [] : [child.child.pid]);
  let relowered = 0;
  let holder: NodeJS.Timeout | null = null;
  const bots: Bot[] = [];
  let loop: FrameLoop | null = null;
  let human: HumanPlayer | null = null;
  try {
    const status = (await getJson(statusUrl(url))) as ServerStatus;
    const match = matchOf(url, status);
    const refused = checkCount(o.count, o.human, match);
    if (refused !== null) throw new BotsRefused(refused);
    // The child's hash is the one its listening line named (D-036); /status must agree.
    const buildHash = child?.buildHash ?? status.buildHash;
    if (buildHash !== status.buildHash) {
      throw new Error(`build hash: listening ${buildHash} ≠ /status ${status.buildHash}`);
    }
    // The generators below the server (D-045): once the run will happen (a refused run keeps its
    // caller's priority) and after the child is spawned, so the server keeps its own…
    const nice = (o.nice ?? 0) > 0 ? lowerPriority(o.nice as number) : null;
    // …and held there: Chromium raises its own threads where it may (holdNice).
    if (nice !== null) {
      holder = setInterval(() => {
        relowered += holdNice(nice, serverPid);
      }, NICE_HOLD_MS);
      holder.unref();
    }
    const serverNice = child?.child.pid === undefined ? null : processNice(child.child.pid);
    log(
      `bots: ${o.count}${o.human ? " + human" : ""} on ${match.map} (match ${match.name}, ` +
        `maxClients ${match.maxClients}) at ${profile.name}, server ${serverName}, build ` +
        `${buildHash}${nice === null ? "" : `, generators at nice ${nice}`}` +
        `${serverNice === null ? "" : `, server at nice ${serverNice}`}`,
    );
    if (gate !== null && !gate.pass) log(`bots: FAIL host gate: ${gate.text}`);
    const warning = buildWarning({ strict, human: o.human });
    if (warning !== null) log(`bots: ${warning}`);
    if (o.human) {
      human = await HumanPlayer.start(url, profile.name);
      const wrongBuild = hashRefusal(await human.buildHash(), buildHash);
      if (wrongBuild !== null) throw new BotsRefused(wrongBuild);
      if (nice !== null) relowered += holdNice(nice, serverPid);
    }

    // Each bot's socket opens as it is made, and the server's hello timeout (`sv_helloTimeout`,
    // 2 s, D-041) runs from the open: so each is made right before it connects, never all first.
    loop = new FrameLoop(o.count);
    const connectStart = performance.now();
    for (let i = 0; i < o.count; i++) {
      const b = new Bot(
        i,
        url,
        createBotInput(match.map, i, o.seed),
        profile,
        o.seed + i,
        buildHash,
        o.primer ?? true,
      );
      bots.push(b);
      loop.add(b);
      b.client.connect();
      await sleep(JOIN_GAP_MS);
    }
    const joinStart = performance.now();
    while (
      !bots.every((b) => b.joined || b.closed !== null) &&
      performance.now() - joinStart < JOIN_TIMEOUT_MS &&
      !o.abort?.aborted
    ) {
      await sleep(50);
    }
    const joined = bots.filter((b) => b.joined).length;
    // The human is in once its page plays (past its idle start) and draws every bot.
    let humanStart: PageStatus | null = null;
    if (human !== null) {
      const left = Math.max(1000, JOIN_TIMEOUT_MS - (performance.now() - joinStart));
      humanStart = await human.waitFor(
        (s) => s.state === "running" && Number(s.remotes) === o.count && Number(s.distance) > 0,
        left,
      );
      log(`bots: human ${humanStart === null ? "did not join" : "joined"}`);
    }
    log(`bots: ${joined} of ${o.count} joined; measuring ${o.minutes} min`);

    // A --server's counters at the window's start, so the summary's are the bots' window's.
    const begin = child === null ? await tryJson(statusUrl(url, "metrics")) : null;
    const beginAt = performance.now();
    for (const b of bots) b.begin();
    const windowStart = performance.now();
    while (!o.abort?.aborted) {
      const left = runS * 1000 - (performance.now() - windowStart);
      if (left <= 0) break;
      await sleep(Math.min(PROGRESS_MS, left), o.abort);
      const elapsed = (performance.now() - windowStart) / 1000;
      if (elapsed < runS - 0.5) {
        const active = bots.filter((b) => b.client.active).length;
        log(`bots: ${elapsed.toFixed(0)} s of ${runS.toFixed(0)}, ${active} active`);
      }
    }
    const seconds = (performance.now() - windowStart) / 1000;
    const numbers = bots.map((b) => b.numbers(seconds));
    const humanEnd = human === null ? null : await human.status();

    // The server's run window: GET /metrics now, or the child's file once it stopped. A server
    // that no longer answers leaves the server section out, with the reason.
    let serverMissing = "none";
    const endStatus = await tryJson(statusUrl(url));
    const players =
      "json" in endStatus
        ? matchOf(url, endStatus.json as ServerStatus).players
        : bots.filter((b) => b.client.active).length;
    let server: SummaryServer | null = null;
    if (child === null) {
      const end = await tryJson(statusUrl(url, "metrics"));
      const sinceConnectS = (performance.now() - connectStart) / 1000;
      if ("json" in end) {
        const start = begin !== null && "json" in begin ? begin.json : null;
        const betweenS = (performance.now() - beginAt) / 1000;
        server = serverSection(
          end.json,
          match.name,
          "GET /metrics",
          players,
          start,
          sinceConnectS,
          betweenS,
        );
      } else {
        serverMissing = end.error;
      }
    }
    let humanNums: HumanNumbers | null = null;
    if (human !== null && humanEnd !== null) {
      humanNums = humanNumbers(humanStart, humanEnd, players, human.errors.slice());
      await human.close();
      human = null;
    }
    for (const b of bots) b.client.disconnect("bots run over");
    await sleep(200);
    loop.stop();
    loop = null;
    if (child !== null && metricsDir !== null) {
      const died = child.died();
      const code = await child.stop();
      const sinceConnectS = (performance.now() - connectStart) / 1000;
      const file = join(metricsDir, "metrics.json");
      if (died) {
        serverMissing = `the server child exited (code ${code}) during the run`;
      } else if (!existsSync(file)) {
        serverMissing = `the server child wrote no metrics file (exit code ${code})`;
      } else {
        server = serverSection(
          JSON.parse(readFileSync(file, "utf8")),
          match.name,
          "--metrics-out",
          players,
          null,
          sinceConnectS,
        );
      }
      child = null;
    }

    if (relowered > 0) log(`bots: held ${relowered} raised generator threads at nice ${nice}`);
    const config: SummaryConfig = {
      count: o.count,
      profile: profile.name,
      minutes: o.minutes,
      map: match.map,
      match: match.name,
      server: serverName,
      seed: o.seed,
      human: o.human,
      buildHash,
      maxClients: match.maxClients,
    };
    const agg = aggregate(numbers);
    const checks = evaluateChecks(config, server, agg, serverMissing, { gate, human: humanNums });
    const summary: BotsSummary = {
      startedAt,
      config,
      host: {
        cpus: hostStart.cpus,
        loadAvg1Start: r3(loadStart),
        loadAvg1End: r3(readHost().load1),
        node: process.versions.node,
        platform: `${process.platform}-${process.arch}`,
        nice,
        serverNice,
      },
      server,
      aggregate: agg,
      human: humanNums,
      bots: numbers,
      checks,
      pass: summaryPasses(checks),
    };
    const files = o.outDir === null ? null : writeSummary(o.outDir, summary);
    return { summary, files };
  } finally {
    if (holder !== null) clearInterval(holder);
    await human?.close();
    loop?.stop();
    for (const b of bots) if (!b.client.closed) b.client.disconnect("bots run over");
    await child?.stop();
    if (metricsDir !== null) rmSync(metricsDir, { recursive: true, force: true });
  }
}
