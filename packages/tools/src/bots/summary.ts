import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOST_GATE_LOAD_PER_CORE, type HostGate } from "./host";

/**
 * A bots run's summary (M3 design §2.15, D-036): the configuration, the server's run window, every
 * bot's numbers and their aggregate, the host, and PASS/FAIL against the budgets of docs/10 §4
 * (server §4.1, network §4.2) and the prediction's health (no strike, no misprediction); with
 * D-045 the host gate and, with `--human`, the human stand-in's own section and checks. Written
 * as `<stamp>.json` and `<stamp>.md`. Bandwidth is payload plus WebSocket framing as it crossed
 * each bot's socket, KB = 1000 B.
 */

export interface SummaryConfig {
  readonly count: number;
  readonly profile: string;
  readonly minutes: number;
  readonly map: string;
  readonly match: string;
  /** "child (dist)", "child (tsx)" or the `--server` URL. */
  readonly server: string;
  readonly seed: number;
  readonly human: boolean;
  readonly buildHash: string;
  readonly maxClients: number;
}

export interface SummaryServer {
  /** Where the numbers come from: the child's `--metrics-out` file or `GET /metrics`. */
  readonly source: string;
  /** The server's run window, s: its tick times, GC, memory peak and CPU cover it. */
  readonly runS: number;
  /**
   * How long before the bots' first connect that window began, s (0: it began after). A window
   * that holds time before the bots (a `--server` up since earlier) is reported, not judged.
   */
  readonly beforeBotsS: number;
  readonly players: number;
  readonly tickUs: {
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
    readonly max: number;
  };
  readonly gc: { readonly count: number; readonly maxMs: number };
  /** The sample at the end and the window's peaks (1 s samples) of heapUsed + external and RSS. */
  readonly memoryMB: {
    readonly heapUsed: number;
    readonly external: number;
    readonly rss: number;
    readonly peakHeapExternal: number;
    readonly peakRss: number;
  };
  readonly cpuMsPerWallS: number;
  /**
   * The counters and traffic below: a child's run window (from its discard, inside the bots'
   * window, to its shutdown), or a `--server`'s change between the readings at the bots' window's
   * start and end.
   */
  readonly droppedTicks: number;
  readonly starved: number;
  readonly fullSnapshots: number;
  /**
   * The byte-budget scheduler (D-046; 0 at 37 players or fewer): snapshots sent, those that left
   * players out and the players left out; the largest staleness of a remote at send since the
   * match started (2 at most) and snapshots whose encode failed (0 by the bound).
   */
  readonly snapshots: number;
  readonly deferredSnapshots: number;
  readonly deferredEntities: number;
  readonly maxStaleness: number;
  readonly snapshotOverflow: number;
  readonly strikes: number;
  readonly kicks: number;
  /** Packets the server's rate limits dropped, and the INPUT loss it saw, % (D-041). */
  readonly rateLimited: number;
  readonly inputLossPct: number;
  readonly kbOutPerS: number;
  readonly kbInPerS: number;
}

export interface BotNumbers {
  readonly id: number;
  /** "route" or "walk". */
  readonly behaviour: string;
  readonly joined: boolean;
  /** Why its session closed during the run, or null. */
  readonly closed: string | null;
  readonly seconds: number;
  readonly snapshots: number;
  readonly snapshotsLost: number;
  readonly correctionsPerS: number;
  readonly meanCorrection: number;
  readonly maxCorrection: number;
  /** Corrections on snapshots the server did not flag starved: the sim disagreed (NET-03). */
  readonly mispredictions: number;
  readonly starved: number;
  readonly hardResyncs: number;
  readonly teleports: number;
  readonly strikes: number;
  readonly bufferMean: number;
  readonly bufferLow: number;
  readonly kbDownPerS: number;
  readonly kbDownPeak: number;
  readonly kbUpPerS: number;
  readonly snapshotBytes: { readonly p50: number; readonly p95: number; readonly max: number };
  /** Share of the snapshots that were deltas (D-038). */
  readonly deltaShare: number;
  /** The remote interpolation delay over the 1 s samples, ticks (D-037). */
  readonly interpDelay: { readonly mean: number; readonly max: number };
  /** Share of the remote-frames drawn extrapolated or held (past the newest snapshot). */
  readonly extrapolatedShare: number;
  /** NET-05 violations: frames where a remote it drew jumped (M3 design §2.8 criterion). */
  readonly remoteJumps: number;
  /** The remote-frames NET-05 judged (those of frames that were not long): what 0 jumps is of. */
  readonly remoteJudged: number;
  /** Route bots: laps and the share of moving time spent stuck. */
  readonly laps: number | null;
  readonly stuckShare: number | null;
}

export interface SummaryAggregate {
  readonly joined: number;
  readonly closed: number;
  readonly correctionsPerS: { readonly mean: number; readonly max: number };
  readonly meanCorrection: number;
  readonly maxCorrection: number;
  readonly mispredictions: number;
  readonly starved: number;
  readonly hardResyncs: number;
  readonly strikes: number;
  readonly bufferMean: number;
  readonly bufferLow: number;
  readonly kbDownPerS: { readonly mean: number; readonly max: number };
  readonly kbDownPeak: number;
  readonly kbUpPerS: { readonly mean: number; readonly max: number };
  readonly snapshotBytes: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly deltaShare: number;
  readonly interpDelay: { readonly mean: number; readonly max: number };
  /** The worst bot's. */
  readonly extrapolatedShare: number;
  /** Summed over the bots. */
  readonly remoteJumps: number;
  /** Summed over the bots. */
  readonly remoteJudged: number;
}

export interface SummaryHost {
  readonly cpus: number;
  readonly loadAvg1Start: number;
  readonly loadAvg1End: number;
  readonly node: string;
  readonly platform: string;
  /** The generators' niceness the run reached (host.ts), or null when it left its own. */
  readonly nice: number | null;
  /**
   * The server child's least favoured thread niceness once the generators were lowered (it keeps
   * its own, below theirs), or null with `--server` or without `/proc`.
   */
  readonly serverNice: number | null;
}

/**
 * The human stand-in (`--human`, D-045): the page's autotest status at the window's start and
 * end (`app/game.ts`) and what the summary judges of it. Totals the page counts from its start
 * (mispredictions, NET-05 violations) are judged whole, as the e2e judges them; rates over the
 * window by the page's own clock (`statusAt`).
 */
export interface HumanNumbers {
  /** The page ran with every bot drawn when the window began. */
  readonly joined: boolean;
  /** Why the page's session ended during the run, or null. */
  readonly closed: string | null;
  /** The server's players at the end (the bots + 1 when the human stayed). */
  readonly players: number;
  readonly seconds: number;
  readonly fps: number;
  /** Frames longer than the input buffer, of all frames in the window (D-028). */
  readonly longShare: number;
  readonly correctionsPerS: number;
  readonly meanCorrection: number;
  /** Corrections on snapshots the server did not flag starved, since the page started. */
  readonly mispredictions: number;
  readonly starved: number;
  readonly hardResyncs: number;
  /** Remotes drawn at the end. */
  readonly remotes: number;
  /** NET-05 violations on frames that were not long, since the page started. */
  readonly remoteJumps: number;
  readonly remoteJudged: number;
  /** The interpolation delay at the end, ticks. */
  readonly interpDelay: number;
  readonly extrapolatedShare: number;
  /** Console and page errors. */
  readonly errors: readonly string[];
  readonly start: Readonly<Record<string, string>>;
  readonly end: Readonly<Record<string, string>>;
}

/** The human's numbers from two status readings (null when the page never reached the window). */
export function humanNumbers(
  start: Readonly<Record<string, string>> | null,
  end: Readonly<Record<string, string>>,
  players: number,
  errors: readonly string[],
): HumanNumbers {
  const a = start ?? {};
  const n = (s: Readonly<Record<string, string>>, key: string) => Number(s[key] ?? 0) || 0;
  const grew = (key: string) => n(end, key) - n(a, key);
  const seconds = grew("statusAt") / 1000;
  const frames = grew("frames");
  const corrections = grew("corrections");
  const remoteFrames = grew("remoteFrames");
  const closed =
    end.state === "error" || end.state === "closed" ? (end.error ?? end.state ?? "") : null;
  return {
    joined: start !== null,
    closed,
    players,
    seconds: r3(seconds),
    fps: r3(seconds > 0 ? frames / seconds : 0),
    longShare: r3(frames > 0 ? grew("longFrames") / frames : 0),
    correctionsPerS: r3(seconds > 0 ? corrections / seconds : 0),
    meanCorrection: r3(corrections > 0 ? grew("correctionDist") / corrections : 0),
    mispredictions: n(end, "corrections") - n(end, "starvedCorrections"),
    starved: grew("starved"),
    hardResyncs: grew("hardResyncs"),
    remotes: n(end, "remotes"),
    remoteJumps: n(end, "remoteJumps"),
    remoteJudged: grew("remoteJudged"),
    interpDelay: n(end, "interpDelay"),
    extrapolatedShare: r3(remoteFrames > 0 ? grew("extrapolations") / remoteFrames : 0),
    errors,
    start: a,
    end,
  };
}

export interface SummaryCheck {
  readonly name: string;
  readonly target: string;
  readonly value: string;
  readonly pass: boolean;
  /** False for a number reported but not judged (its window is not the bots'); PASS ignores it. */
  readonly judged: boolean;
}

export interface BotsSummary {
  readonly startedAt: string;
  readonly config: SummaryConfig;
  readonly host: SummaryHost;
  readonly server: SummaryServer | null;
  readonly aggregate: SummaryAggregate;
  /** The human stand-in, with `--human`. */
  readonly human: HumanNumbers | null;
  readonly bots: readonly BotNumbers[];
  readonly checks: readonly SummaryCheck[];
  readonly pass: boolean;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function max(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : Math.max(...xs);
}

/** Rounds to 3 decimals, so the JSON stays readable. */
export function r3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** The bots' aggregate: means and worsts over the bots that joined. */
export function aggregate(bots: readonly BotNumbers[]): SummaryAggregate {
  const b = bots.filter((x) => x.joined);
  const of = (f: (x: BotNumbers) => number) => b.map(f);
  return {
    joined: b.length,
    closed: bots.filter((x) => x.closed !== null).length,
    correctionsPerS: {
      mean: r3(mean(of((x) => x.correctionsPerS))),
      max: max(of((x) => x.correctionsPerS)),
    },
    meanCorrection: max(of((x) => x.meanCorrection)),
    maxCorrection: max(of((x) => x.maxCorrection)),
    mispredictions: of((x) => x.mispredictions).reduce((a, c) => a + c, 0),
    starved: of((x) => x.starved).reduce((a, c) => a + c, 0),
    hardResyncs: of((x) => x.hardResyncs).reduce((a, c) => a + c, 0),
    strikes: of((x) => x.strikes).reduce((a, c) => a + c, 0),
    bufferMean: r3(mean(of((x) => x.bufferMean))),
    bufferLow: b.length === 0 ? 0 : Math.min(...of((x) => x.bufferLow)),
    kbDownPerS: { mean: r3(mean(of((x) => x.kbDownPerS))), max: max(of((x) => x.kbDownPerS)) },
    kbDownPeak: max(of((x) => x.kbDownPeak)),
    kbUpPerS: { mean: r3(mean(of((x) => x.kbUpPerS))), max: max(of((x) => x.kbUpPerS)) },
    snapshotBytes: {
      p50: max(of((x) => x.snapshotBytes.p50)),
      p95: max(of((x) => x.snapshotBytes.p95)),
      max: max(of((x) => x.snapshotBytes.max)),
    },
    deltaShare: r3(mean(of((x) => x.deltaShare))),
    interpDelay: {
      mean: r3(mean(of((x) => x.interpDelay.mean))),
      max: max(of((x) => x.interpDelay.max)),
    },
    extrapolatedShare: max(of((x) => x.extrapolatedShare)),
    remoteJumps: of((x) => x.remoteJumps).reduce((a, c) => a + c, 0),
    remoteJudged: of((x) => x.remoteJudged).reduce((a, c) => a + c, 0),
  };
}

/**
 * PASS/FAIL against docs/10 §4: the server's tick p50/p99, GC pause and memory (§4.1, judged on
 * its run window; the window's peak heapUsed + external, RSS reported) and each client's down/up
 * bandwidth and snapshot size (§4.2, the worst bot); plus every bot joined and stayed, the
 * prediction's health (D-036): no strike on either side and no misprediction, a correction on a
 * snapshot the server did not flag starved (the e2e rule, docs/10 §1), and smooth remotes
 * (D-037): no NET-05 violation in what the bots drew of each other. The §4.1 numbers of a run
 * window that began before the bots are reported, not judged. `serverMissing` says why there are
 * no server numbers, when there are none.
 */
export function evaluateChecks(
  config: SummaryConfig,
  server: SummaryServer | null,
  agg: SummaryAggregate,
  serverMissing = "none",
  extra: { readonly gate?: HostGate | null; readonly human?: HumanNumbers | null } = {},
): SummaryCheck[] {
  const checks: SummaryCheck[] = [];
  const add = (name: string, target: string, value: string, pass: boolean, judged = true) =>
    checks.push({ name, target, value, pass, judged });
  const gate = extra.gate ?? null;
  if (gate !== null) {
    add(
      "host gate (1-minute load before the run)",
      `≤ ${HOST_GATE_LOAD_PER_CORE} per core`,
      gate.text,
      gate.pass,
    );
  }
  add(
    "bots joined and stayed",
    `${config.count}`,
    `${agg.joined} joined, ${agg.closed} closed`,
    agg.joined === config.count && agg.closed === 0,
  );
  if (server === null) {
    add("server metrics", "read", serverMissing, false);
  } else {
    const judged = server.beforeBotsS <= 0;
    add(
      "server tick p50",
      "≤ 1.5 ms",
      `${(server.tickUs.p50 / 1000).toFixed(3)} ms`,
      server.tickUs.p50 <= 1500,
      judged,
    );
    add(
      "server tick p99",
      "≤ 4 ms",
      `${(server.tickUs.p99 / 1000).toFixed(3)} ms`,
      server.tickUs.p99 <= 4000,
      judged,
    );
    add(
      "server GC pause max",
      "≤ 8 ms",
      `${server.gc.maxMs.toFixed(3)} ms`,
      server.gc.maxMs <= 8,
      judged,
    );
    const mem = server.memoryMB.peakHeapExternal;
    add(
      "server memory (peak heapUsed + external)",
      "≤ 150 MB",
      `${mem.toFixed(1)} MB`,
      mem <= 150,
      judged,
    );
    add("server strikes", "0", `${server.strikes}`, server.strikes === 0);
  }
  add(
    "down per client (average)",
    "≤ 32 KB/s",
    `${agg.kbDownPerS.max.toFixed(2)} KB/s`,
    agg.kbDownPerS.max <= 32,
  );
  add(
    "down per client (peak 1 s)",
    "≤ 48 KB/s",
    `${agg.kbDownPeak.toFixed(2)} KB/s`,
    agg.kbDownPeak <= 48,
  );
  add("up per client", "≤ 8 KB/s", `${agg.kbUpPerS.max.toFixed(2)} KB/s`, agg.kbUpPerS.max <= 8);
  add("snapshot size", "≤ 1100 B", `${agg.snapshotBytes.max} B`, agg.snapshotBytes.max <= 1100);
  add("bot strikes", "0", `${agg.strikes}`, agg.strikes === 0);
  add(
    "mispredictions (corrections not on a starved snapshot)",
    "0",
    `${agg.mispredictions}`,
    agg.mispredictions === 0,
  );
  add("remote jumps (NET-05 violations)", "0", `${agg.remoteJumps}`, agg.remoteJumps === 0);
  const h = extra.human ?? null;
  if (h !== null) humanChecks(config, h, add);
  return checks;
}

/**
 * The human stand-in's checks (D-045, M3 design §5 "16 + 1"): it joined and stayed (the server
 * holds the bots + 1, the page draws every bot), its prediction within NET-04's bounds (under 1
 * correction a second, a mean under 2 u) with no misprediction, its remotes smooth (no NET-05
 * violation) at a 2–6 tick delay, and no page error. The rest of the e2e health rule (resyncs and
 * starves against frame timing) is the load test's, from the readings the summary keeps.
 */
function humanChecks(
  config: SummaryConfig,
  h: HumanNumbers,
  add: (name: string, target: string, value: string, pass: boolean) => void,
): void {
  add(
    "human joined and stayed",
    `players ${config.count + 1}, remotes ${config.count}`,
    `players ${h.players}, remotes ${h.remotes}${h.joined ? "" : ", never joined"}` +
      (h.closed === null ? "" : `, closed: ${h.closed}`),
    h.joined && h.closed === null && h.players === config.count + 1 && h.remotes === config.count,
  );
  add(
    "human corrections per s (NET-04)",
    "< 1",
    h.correctionsPerS.toFixed(3),
    h.correctionsPerS < 1,
  );
  add(
    "human mean correction (NET-04)",
    "< 2 u",
    `${h.meanCorrection.toFixed(3)} u`,
    h.meanCorrection < 2,
  );
  add("human mispredictions", "0", `${h.mispredictions}`, h.mispredictions === 0);
  add("human remote jumps (NET-05 violations)", "0", `${h.remoteJumps}`, h.remoteJumps === 0);
  add(
    "human interp delay",
    "2–6 ticks",
    `${h.interpDelay} ticks`,
    h.interpDelay >= 2 && h.interpDelay <= 6,
  );
  add("human page errors", "0", `${h.errors.length}`, h.errors.length === 0);
}

/** A run passes when every judged check does. */
export function summaryPasses(checks: readonly SummaryCheck[]): boolean {
  return checks.every((c) => !c.judged || c.pass);
}

function row(cells: readonly (string | number)[]): string {
  return `| ${cells.join(" | ")} |`;
}

function header(cells: readonly string[]): string {
  return `${row(cells)}\n${row(cells.map(() => "---"))}`;
}

/** The markdown summary: deterministic for a given summary object (golden-tested). */
export function summaryMarkdown(s: BotsSummary): string {
  const c = s.config;
  const out: string[] = [];
  out.push(`# Bots run ${s.startedAt}: ${s.pass ? "PASS" : "FAIL"}`);
  out.push("");
  out.push(
    `${c.count} bots${c.human ? " + 1 human" : ""} on \`${c.map}\` (match \`${c.match}\`, maxClients ` +
      `${c.maxClients}) at \`${c.profile}\` for ${c.minutes} min, seed ${c.seed}; server ${c.server}, ` +
      `build \`${c.buildHash}\`. Host: ${s.host.cpus} CPUs, load ${s.host.loadAvg1Start.toFixed(2)} → ` +
      `${s.host.loadAvg1End.toFixed(2)} (1 min), Node ${s.host.node} on ${s.host.platform}` +
      `${s.host.nice === null ? "" : `, generators at nice ${s.host.nice}`}` +
      `${s.host.serverNice === null ? "" : `, server at nice ${s.host.serverNice}`}.`,
  );
  out.push("");
  out.push("## Checks (docs/10 §4, prediction health)");
  out.push("");
  out.push(header(["Check", "Target", "Measured", "Result"]));
  for (const k of s.checks) {
    const result = k.pass ? "PASS" : "FAIL";
    out.push(row([k.name, k.target, k.value, k.judged ? result : `${result} (not judged)`]));
  }
  out.push("");
  out.push("## Server (run window)");
  out.push("");
  const v = s.server;
  if (v === null) {
    out.push("No server metrics.");
  } else {
    out.push(header(["Metric", "Value"]));
    out.push(row(["source", v.source]));
    out.push(
      row([
        "run window",
        `${v.runS.toFixed(1)} s` +
          (v.beforeBotsS > 0
            ? `, from ${v.beforeBotsS.toFixed(1)} s before the bots (tick, GC and memory not judged)`
            : "") +
          `, ${v.players} players at the end`,
      ]),
    );
    out.push(
      row([
        "tick p50 / p95 / p99 / max",
        `${v.tickUs.p50} / ${v.tickUs.p95} / ${v.tickUs.p99} / ${v.tickUs.max} µs`,
      ]),
    );
    out.push(row(["GC", `${v.gc.count} pauses, max ${v.gc.maxMs.toFixed(3)} ms`]));
    out.push(
      row([
        "memory",
        `peak heapUsed + external ${v.memoryMB.peakHeapExternal.toFixed(1)} MB, peak RSS ${v.memoryMB.peakRss.toFixed(1)} MB; at the end heapUsed ${v.memoryMB.heapUsed.toFixed(1)} MB + external ${v.memoryMB.external.toFixed(1)} MB, RSS ${v.memoryMB.rss.toFixed(1)} MB`,
      ]),
    );
    out.push(row(["CPU", `${v.cpuMsPerWallS.toFixed(0)} ms per wall s`]));
    out.push(
      row(["traffic", `${v.kbOutPerS.toFixed(2)} KB/s out, ${v.kbInPerS.toFixed(2)} KB/s in`]),
    );
    out.push(
      row([
        "counters",
        `dropped ticks ${v.droppedTicks}, starved ${v.starved}, full snapshots ${v.fullSnapshots}, strikes ${v.strikes}, rate-limited ${v.rateLimited}, kicks ${v.kicks}, input loss ${v.inputLossPct.toFixed(2)}%`,
      ]),
    );
    const share = v.snapshots === 0 ? 0 : (100 * v.deferredSnapshots) / v.snapshots;
    out.push(
      row([
        "scheduler (D-046)",
        `${v.deferredEntities} players left out of ${v.deferredSnapshots} of ${v.snapshots} snapshots (${share.toFixed(1)}%), max staleness ${v.maxStaleness}, snapshot overflows ${v.snapshotOverflow}`,
      ]),
    );
  }
  out.push("");
  const a = s.aggregate;
  out.push("## Bots (aggregate)");
  out.push("");
  out.push(header(["Metric", "Value"]));
  out.push(row(["joined / closed", `${a.joined} / ${a.closed}`]));
  out.push(
    row([
      "corrections per s (mean / worst)",
      `${a.correctionsPerS.mean.toFixed(3)} / ${a.correctionsPerS.max.toFixed(3)}`,
    ]),
  );
  out.push(
    row([
      "correction (worst mean / max)",
      `${a.meanCorrection.toFixed(3)} / ${a.maxCorrection.toFixed(3)} u`,
    ]),
  );
  out.push(
    row([
      "mispredictions / starved / hard resyncs / strikes",
      `${a.mispredictions} / ${a.starved} / ${a.hardResyncs} / ${a.strikes}`,
    ]),
  );
  out.push(
    row(["input buffer (mean / lowest)", `${a.bufferMean.toFixed(2)} / ${a.bufferLow} ticks`]),
  );
  out.push(
    row([
      "down per client (mean / worst / peak 1 s)",
      `${a.kbDownPerS.mean.toFixed(2)} / ${a.kbDownPerS.max.toFixed(2)} / ${a.kbDownPeak.toFixed(2)} KB/s`,
    ]),
  );
  out.push(
    row([
      "up per client (mean / worst)",
      `${a.kbUpPerS.mean.toFixed(2)} / ${a.kbUpPerS.max.toFixed(2)} KB/s`,
    ]),
  );
  out.push(
    row([
      "snapshot p50 / p95 / max",
      `${a.snapshotBytes.p50} / ${a.snapshotBytes.p95} / ${a.snapshotBytes.max} B`,
    ]),
  );
  out.push(row(["delta share", `${(a.deltaShare * 100).toFixed(1)}%`]));
  out.push(
    row([
      "interp delay (mean / max)",
      `${a.interpDelay.mean.toFixed(2)} / ${a.interpDelay.max} ticks`,
    ]),
  );
  out.push(
    row([
      "remotes extrapolated or held (worst) / NET-05 violations",
      `${(a.extrapolatedShare * 100).toFixed(2)}% / ${a.remoteJumps} of ${a.remoteJudged} judged`,
    ]),
  );
  out.push("");
  const h = s.human;
  if (h !== null) {
    out.push("## Human (headless Chromium)");
    out.push("");
    out.push(header(["Metric", "Value"]));
    out.push(
      row([
        "joined / players / remotes",
        `${h.joined ? "yes" : "no"} / ${h.players} / ${h.remotes}` +
          (h.closed === null ? "" : `; closed: ${h.closed}`),
      ]),
    );
    out.push(row(["frames", `${h.fps.toFixed(1)} fps, ${(h.longShare * 100).toFixed(1)}% long`]));
    out.push(
      row([
        "corrections per s / mean",
        `${h.correctionsPerS.toFixed(3)} / ${h.meanCorrection.toFixed(3)} u`,
      ]),
    );
    out.push(
      row([
        "mispredictions / starved / hard resyncs",
        `${h.mispredictions} / ${h.starved} / ${h.hardResyncs}`,
      ]),
    );
    out.push(
      row([
        "interp delay / extrapolated or held / NET-05 violations",
        `${h.interpDelay} ticks / ${(h.extrapolatedShare * 100).toFixed(2)}% / ${h.remoteJumps} of ${h.remoteJudged} judged`,
      ]),
    );
    out.push(row(["page errors", h.errors.length === 0 ? "none" : h.errors.join("; ")]));
    out.push("");
  }
  out.push("## Bots");
  out.push("");
  out.push(
    header([
      "Bot",
      "Kind",
      "Corr/s",
      "Mean / max corr (u)",
      "Starved",
      "Resyncs",
      "Buffer mean / low",
      "Down / peak / up (KB/s)",
      "Snapshot p50 / max (B)",
      "Interp (ticks) / extrap / jumps",
      "Laps / stuck",
      "Closed",
    ]),
  );
  for (const b of s.bots) {
    out.push(
      row([
        b.id,
        b.behaviour,
        b.correctionsPerS.toFixed(3),
        `${b.meanCorrection.toFixed(2)} / ${b.maxCorrection.toFixed(2)}`,
        b.starved,
        b.hardResyncs,
        `${b.bufferMean.toFixed(2)} / ${b.bufferLow}`,
        `${b.kbDownPerS.toFixed(2)} / ${b.kbDownPeak.toFixed(2)} / ${b.kbUpPerS.toFixed(2)}`,
        `${b.snapshotBytes.p50} / ${b.snapshotBytes.max}`,
        `${b.interpDelay.mean.toFixed(1)} / ${(b.extrapolatedShare * 100).toFixed(2)}% / ${b.remoteJumps}`,
        b.laps === null ? "–" : `${b.laps} / ${((b.stuckShare ?? 0) * 100).toFixed(1)}%`,
        b.joined ? (b.closed ?? "–") : "never joined",
      ]),
    );
  }
  out.push("");
  return out.join("\n");
}

/** `2026-10-09T01:02:03.456Z` → `2026-10-09T01-02-03Z`, a file name on every system. */
export function reportStamp(iso: string): string {
  return `${iso.slice(0, 19).replace(/:/g, "-")}Z`;
}

/** Writes `<dir>/<stamp>.json` and `.md`; returns both paths. */
export function writeSummary(dir: string, s: BotsSummary): { json: string; md: string } {
  mkdirSync(dir, { recursive: true });
  const stamp = reportStamp(s.startedAt);
  const json = join(dir, `${stamp}.json`);
  const md = join(dir, `${stamp}.md`);
  writeFileSync(json, `${JSON.stringify(s, null, 2)}\n`);
  writeFileSync(md, summaryMarkdown(s));
  return { json, md };
}
