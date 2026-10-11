import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  type Cmap,
  CvarRegistry,
  PmoveParams,
  PRINT_ERROR,
  PROTOCOL_VERSION,
  primePmoveOnce,
  refreshPmoveParams,
  registerPmoveCvars,
  registerServerReplicatedCvars,
} from "@game/shared";
import { type AdminReply, tokenizeCommand } from "../match/commands";
import { MatchLoop } from "../match/loop";
import { MATCH_DEFAULT_MAX_CLIENTS, MATCH_MAX_CLIENTS, Match } from "../match/match";
import { TickHistogram } from "../match/tickStats";
import { WsListener } from "../transport/wsListener";
import { WireTraffic, type WsTransport } from "../transport/wsTransport";
import { isBundledServer, serverBuildHash } from "./buildHash";
import {
  admissionLimits,
  applyAssignments,
  type CfgEntry,
  type CfgMatchLine,
  type CfgSet,
  ConfigError,
  type MatchSpec,
  matchSpec,
  parseCommandLine,
  parseServerCfg,
  sendLimits,
  sessionLimits,
} from "./config";
import { type ConsoleHost, runConsoleLine, startConsole } from "./console";
import { type DemoWriteFn, DemoWriter, defaultDemosDir, type FileDemoSink } from "./demoWriter";
import { createNodeHost, type ServerMatch, type TimedPass } from "./host";
import { createJsonLog, type JsonLog, matchLog } from "./log";
import { defaultMapsDir, loadMap } from "./maps";
import { MatchSet } from "./matchSet";
import { ServerMetrics } from "./metrics";
import { MatchRconGate, RconGuard, rconChecker, validRconPassword } from "./rconGuard";
import { registerServerCvars } from "./serverCvars";

/**
 * The match a process runs when none is configured (D-047): `main`, on `sv_map` with
 * `sv_maxClients`.
 */
export const DEFAULT_MATCH = "main";

/** How long shutdown waits for clients to finish their closing handshakes (design value). */
const SHUTDOWN_CLOSE_MS = 1000;

/** The KICK and close reason of a removed match's sessions and its late upgrades (D-047). */
export const MATCH_CLOSED = "match closed";

export interface StartOptions {
  /** Command-line flags (D-029; `parseCommandLine`). */
  readonly args?: readonly string[];
  /** Receives each JSON log line (stdout in the process); dropped when absent. */
  readonly write?: (line: string) => void;
  /** Where `server.cfg` and relative paths resolve; the process's working directory by default. */
  readonly cwd?: string;
  /** Read admin console lines from this stream (stdin in the process); none when absent. */
  readonly console?: NodeJS.ReadableStream;
  /**
   * Run the pmove primer (D-040) before the first match (default true). In-process tests that
   * start many servers pass false; `server_ok` then reports `primerMs` 0.
   */
  readonly primer?: boolean;
  /**
   * Tests only: the address each upgrade is counted under for `sv_maxPerIp` (D-041), in place of
   * the TCP peer's, so one test can stand for many clients on one non-loopback address.
   */
  readonly peerAddress?: (req: IncomingMessage) => string;
  /**
   * The rcon password (D-042); the `SV_RCON_PASSWORD` environment variable when absent. Unset or
   * empty disables rcon.
   */
  readonly rconPassword?: string;
  /**
   * Where `record` writes demos (D-044): the repository's `demos/` by default. Never chosen by a
   * command (rcon names a file, not a folder).
   */
  readonly demosDir?: string;
  /** The demo files' writes (`fs.write`; a test passes a slow disk). */
  readonly demoWrite?: DemoWriteFn;
}

/** One match of the process (D-047) with its own rcon gate and demo files. */
export interface HostedMatch extends ServerMatch {
  /** Its clients' addresses for the process's rcon lockout (D-042). */
  readonly gate: MatchRconGate;
  /** Its demo files (D-044): `<match>-<map>-<utc>.demo` by default. */
  readonly demos: DemoWriter;
}

export interface RunningServer {
  /**
   * The process's matches by name, kept current as matches are added and removed (D-047; a
   * null-prototype record, so any match name is an own key). `main` when none is configured.
   */
  readonly matches: Readonly<Record<string, HostedMatch>>;
  /** The same matches in creation order, on the loop (D-047). */
  readonly set: MatchSet<HostedMatch>;
  readonly listener: WsListener;
  readonly loop: MatchLoop;
  readonly pass: TimedPass;
  /** SERVER cvars (`sv_*`). */
  readonly cvars: CvarRegistry;
  /** The replicated cvars every new match starts from (D-047). */
  readonly template: CvarRegistry;
  readonly buildHash: string;
  readonly log: JsonLog;
  /** GC, memory, traffic and the run and interval windows (D-029, D-036). */
  readonly metrics: ServerMetrics;
  /** Wrong rcon passwords per remote address, across every match (D-042). */
  readonly rconGuard: RconGuard;
  /**
   * `match_add` (D-047): creates a match on `spec` (its map loaded now, its cvars copied from
   * the template, recording at once under `sv_autoRecord`), logged `match_add`. Refused with the
   * reason when the name is taken, the process runs `sv_maxMatches` already or the map does not
   * load.
   */
  addMatch(spec: MatchSpec): AdminReply;
  /**
   * `match_remove` (D-047): ends the match's demo, KICKs its sessions "match closed" (LEAVE
   * reason kicked), takes it off the loop and the listener (an upgrade to it still in flight then
   * closes 1001 "match closed"), logged `match_remove`. The last match cannot be removed.
   */
  removeMatch(name: string): AdminReply;
  /**
   * Graceful shutdown (D-029): stop accepting, KICK every client "server shutting down" and close
   * its socket 1001, stop the loop, write `--metrics-out`, and wait (bounded) for the sockets to
   * close and every demo file to be on disk. Idempotent.
   */
  stop(signal?: string): Promise<void>;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** A new match's replicated cvars: the template's values (D-047), in a registry of its own. */
function copyTemplate(template: CvarRegistry): CvarRegistry {
  const reg = new CvarRegistry();
  registerPmoveCvars(reg);
  registerServerReplicatedCvars(reg);
  for (const info of template.list()) {
    // A latched value applies when a match starts, as on a map restart.
    const value = info.latched ?? info.value;
    if (!reg.setReplicated(info.def.name, value)) reg.set(info.def.name, value);
  }
  return reg;
}

/**
 * Starts the dedicated server (D-029, D-047): flags and `server.cfg` → SERVER cvars and the
 * replicated template every match copies → the pmove primer (D-040) → the matches (server.cfg's
 * `match_add` lines, then `--match` flags; `main` on `sv_map` when there are none), then the
 * cfg's lines for them (`@<match> …`, and replicated `set`s after the first `match_add`, which go
 * to the default match) → the listener → the loop, then logs `server_ok` (with `startupMs` and
 * `primerMs`) and `listening` (M3 design §2.14). Throws a ConfigError (or a map or bind error)
 * instead of starting with a setting other than the one written.
 */
export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const cwd = options.cwd ?? process.cwd();
  const write = options.write ?? (() => {});
  const log = createJsonLog(write);

  const cli = parseCommandLine(options.args ?? []);
  const cvars = new CvarRegistry();
  registerServerCvars(cvars);
  // From source a mismatched build only warns (D-031): `pnpm dev` and `pnpm dev:server` compute
  // their hashes when each starts. server.cfg or a flag may still set it.
  if (!isBundledServer()) cvars.set("sv_strictBuild", 0);
  const template = new CvarRegistry();
  registerPmoveCvars(template);
  registerServerReplicatedCvars(template);
  const cfgPath = cli.cfg === null ? resolve(cwd, "server.cfg") : resolve(cwd, cli.cfg);
  let cfg: CfgEntry[] = [];
  if (existsSync(cfgPath)) cfg = parseServerCfg(readFileSync(cfgPath, "utf8"), cfgPath);
  else if (cli.cfg !== null) throw new ConfigError(`--cfg ${cli.cfg}: no such file`);
  // SERVER sets are the process's wherever they stand; replicated ones before the first
  // match_add set the template; the rest wait for the matches (below).
  const firstAdd = cfg.findIndex((e) => e.kind === "match_add");
  const later: (CfgSet | CfgMatchLine)[] = [];
  for (let i = 0; i < cfg.length; i++) {
    const e = cfg[i] as CfgEntry;
    if (e.kind === "set" && (firstAdd < 0 || i < firstAdd))
      applyAssignments([e], [cvars, template]);
    else if (e.kind === "set" && cvars.has(e.name)) applyAssignments([e], [cvars]);
    else if (e.kind !== "match_add") later.push(e);
  }
  applyAssignments(cli.sets, [cvars, template]);

  const mapsDir = cli.mapsDir === null ? defaultMapsDir(cwd) : resolve(cwd, cli.mapsDir);
  if (mapsDir === null) throw new ConfigError("no content/maps found; pass --maps <dir>");
  const specs: MatchSpec[] = [];
  for (const e of cfg) if (e.kind === "match_add") specs.push(e.spec);
  specs.push(...cli.matches);
  if (specs.length === 0) {
    specs.push({
      name: DEFAULT_MATCH,
      map: String(cvars.get("sv_map")),
      maxClients: null,
      source: "sv_map",
    });
  }
  const maxMatches = cvars.getNumber("sv_maxMatches", 4);
  if (specs.length > maxMatches) {
    throw new ConfigError(`${specs.length} matches configured; sv_maxMatches is ${maxMatches}`);
  }
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.name)) throw new ConfigError(`${spec.source}: match ${spec.name} exists`);
    seen.add(spec.name);
  }
  // Before any map loads or file opens: an `@` line for a match nobody creates.
  for (const e of later) {
    if (e.kind === "match" && !seen.has(e.match)) {
      throw new ConfigError(`${e.source}: no match ${e.match}`);
    }
  }
  const cmaps = specs.map((spec) => loadMap(spec.map, mapsDir));
  const buildHash = serverBuildHash();
  // Checked before the primer, so a bad setting stops the server without paying for it.
  const limits = sendLimits(cvars);
  const security = sessionLimits(cvars);
  const admission = admissionLimits(cvars);
  const rconPassword = validRconPassword(options.rconPassword ?? process.env.SV_RCON_PASSWORD);
  if (!rconPassword.ok) throw new ConfigError(rconPassword.error);
  const rcon = rconChecker(rconPassword.password);
  const rconGuard = new RconGuard(() => performance.now());

  // The pmove primer (D-040) runs once per process, timed here for `server_ok`: every match's own
  // call at construction then finds it done. Parameters from the template, as the matches' are.
  const primerStart = performance.now();
  const primerParams = new PmoveParams();
  refreshPmoveParams(template, primerParams);
  const primer = options.primer ?? true;
  const primerMs = primer && primePmoveOnce(primerParams) ? performance.now() - primerStart : 0;

  const defaultMaxClients = cvars.getNumber("sv_maxClients", MATCH_DEFAULT_MAX_CLIENTS);
  const strictBuild = cvars.getNumber("sv_strictBuild", 1) === 1;
  const autoRecord = cvars.getNumber("sv_autoRecord", 0) === 1;
  const demosDir =
    options.demosDir === undefined ? defaultDemosDir(cwd) : resolve(cwd, options.demosDir);
  const set = new MatchSet<HostedMatch>(log);
  const pass = set.pass;
  const matches: Record<string, HostedMatch> = Object.create(null);
  // Created before the matches' first metrics reset can run (the listener and the console come
  // after it); `metrics` is assigned once the loop exists.
  let metrics: ServerMetrics | null = null;
  // Demo files of removed matches still being written: shutdown waits for them too.
  const draining = new Set<Promise<void>>();

  /** A match on `spec` and `cmap`, not yet in the set. Throws on a map WELCOME can't carry. */
  const createMatch = (spec: MatchSpec, cmap: Cmap): HostedMatch => {
    const name = spec.name;
    const gate = new MatchRconGate(rconGuard, name, log);
    const demos = new DemoWriter(demosDir, log, name, undefined, options.demoWrite);
    const match = new Match({
      cmap,
      cvars: copyTemplate(template),
      buildHash,
      strictBuild,
      maxClients: spec.maxClients ?? defaultMaxClients,
      log: matchLog(log, name),
      events: (lvl, ev, fields) => log(lvl, ev, { match: name, ...fields }),
      // D-041: unlike the Worker, a dedicated server times out silent and stuck sessions.
      timeouts: true,
      limits: security,
      primer,
      // D-042: rcon runs as an admin of this match only, and resets this match's metrics only.
      ...(rcon === null ? {} : { rcon, rconGate: gate }),
      metricsReset: () => {
        metrics?.resetMatchRun(name);
        log("info", "metrics_reset", { reason: "rcon", match: name });
        return `metrics reset: match ${name}`;
      },
      demos,
    });
    return { name, match, ticks: new TickHistogram(), traffic: new WireTraffic(), gate, demos };
  };
  /** Puts `m` on the loop, the listener and the metrics. */
  const install = (m: HostedMatch): void => {
    set.add(m);
    matches[m.name] = m;
    metrics?.addMatch(m);
  };
  /** sv_autoRecord (D-044): the match's whole life, from its first tick to its end. */
  const autoRecordOf = (m: HostedMatch): string | null => {
    if (!autoRecord) return null;
    const r = m.match.record(null);
    return r.ok ? null : `sv_autoRecord: ${r.text}`;
  };

  for (let i = 0; i < specs.length; i++) {
    install(createMatch(specs[i] as MatchSpec, cmaps[i] as Cmap));
  }
  // From here a refused start leaves no demo file and no file open (a cfg `@<match> record`
  // line has opened one by now): it ends every match's demo, waits for it, deletes it, then
  // closes the listener if it was bound and rethrows.
  let bound = false;
  const abandon = async (e: unknown): Promise<never> => {
    const sinks: FileDemoSink[] = [];
    for (const m of set.list) {
      m.match.stopRecording();
      for (const sink of m.demos.pending) sinks.push(sink);
    }
    await Promise.all(sinks.map((sink) => sink.done));
    for (const sink of sinks) rmSync(sink.path, { force: true });
    if (bound) await listener.close(0);
    throw e;
  };
  try {
    // The cfg's lines for the matches, in file order: `@<match> …` to that match, a replicated
    // `set` after the first match_add to the default match.
    for (const e of later) {
      const m = e.kind === "match" ? set.get(e.match) : set.default;
      if (m === undefined)
        throw new ConfigError(`${e.source}: no match ${e.kind === "match" ? e.match : ""}`);
      if (e.kind === "set") {
        applyAssignments([e], [m.match.cvars]);
        continue;
      }
      const tokens = tokenizeCommand(e.text);
      if (tokens?.[0]?.toLowerCase() === "set" && tokens.length >= 3) {
        const assignment = { name: tokens[1] as string, value: tokens.slice(2).join(" ") };
        applyAssignments([{ ...assignment, source: e.source }], [m.match.cvars]);
        continue;
      }
      const r = m.match.runAdminCommand(e.text);
      if (r.level === PRINT_ERROR) throw new ConfigError(`${e.source}: ${r.text}`);
    }
    // The command line overrides server.cfg (D-029): its replicated sets win over the cfg's match
    // lines too (they already reached the template, so runtime matches get them as well).
    const cliReplicated = cli.sets.filter((a) => !cvars.has(a.name));
    if (cliReplicated.length > 0) {
      for (const m of set.list) applyAssignments(cliReplicated, [m.match.cvars]);
    }
  } catch (e) {
    return abandon(e);
  }

  const addMatch = (spec: MatchSpec): AdminReply => {
    if (set.has(spec.name)) return { ok: false, text: `match_add: match ${spec.name} exists` };
    if (set.size >= maxMatches) {
      return { ok: false, text: `match_add: the server runs sv_maxMatches ${maxMatches} matches` };
    }
    let m: HostedMatch;
    try {
      m = createMatch(spec, loadMap(spec.map, mapsDir));
    } catch (e) {
      return { ok: false, text: `match_add: ${e instanceof Error ? e.message : String(e)}` };
    }
    install(m);
    const why = autoRecordOf(m);
    log("info", "match_add", {
      match: m.name,
      map: m.match.mapName,
      maxClients: m.match.maxClients,
      source: spec.source,
    });
    const text = `match ${m.name} added: ${m.match.mapName}, ${m.match.maxClients} players`;
    return { ok: true, text: why === null ? text : `${text} (${why})` };
  };
  const removeMatch = (name: string): AdminReply => {
    const m = set.get(name);
    if (m === undefined) return { ok: false, text: `match_remove: no match ${name}` };
    if (set.size === 1) {
      return { ok: false, text: `match_remove: ${name} is the last match; it cannot be removed` };
    }
    const kicked = m.match.close(MATCH_CLOSED);
    metrics?.removeMatch(m);
    set.remove(name);
    delete matches[name];
    for (const sink of m.demos.pending) {
      const done = sink.done.then(() => {
        draining.delete(done);
      });
      draining.add(done);
    }
    log("info", "match_remove", { match: name, kicked });
    return { ok: true, text: `match ${name} removed (${kicked} kicked)` };
  };

  const listener = new WsListener({
    host: String(cvars.get("sv_host")),
    port: cvars.getNumber("sv_port", 0),
    limits,
    admission,
    ...(options.peerAddress === undefined ? {} : { peerAddress: options.peerAddress }),
    target: {
      matchFor: (name) => (name === "" ? (set.default?.name ?? null) : set.has(name) ? name : null),
      accept: (name, transport: WsTransport, ip) => {
        const m = set.get(name) as HostedMatch;
        transport.traffic = m.traffic;
        const s = m.match.connect(transport);
        if (s !== null) m.gate.addresses[s.clientId] = ip;
        log("info", "connect", { match: m.name, client: s === null ? null : s.clientId, ip });
      },
      status: () => ({
        buildHash,
        protocol: PROTOCOL_VERSION,
        matches: set.list.map(statusOf),
      }),
      metrics: () => (metrics as ServerMetrics).json(),
    },
  });
  try {
    await listener.listen();
    bound = true;
    // Recording starts once the server is sure to run: no demo of a start that fails.
    for (const m of set.list) {
      const why = autoRecordOf(m);
      if (why !== null) throw new ConfigError(why);
    }
  } catch (e) {
    return abandon(e);
  }

  const loop = new MatchLoop(set, createNodeHost(log, pass));
  pass.loopStats = loop.stats;
  const serverMetrics = new ServerMetrics(
    { matches: set.list, pass, loop: () => loop.stats, connections: () => listener.connections },
    log,
  );
  metrics = serverMetrics;
  serverMetrics.gc.start();
  const timers = startMetricsTimers(
    serverMetrics,
    cvars.getNumber("sv_metricsInterval", 10),
    cli,
    log,
  );
  loop.start();
  log("info", "server_ok", { startupMs: round3(performance.now()), primerMs: round3(primerMs) });
  log("info", "listening", {
    port: listener.port,
    buildHash,
    matches: set.list.map((m) => ({ name: m.name, map: m.match.mapName })),
  });
  const consoleHost: ConsoleHost = {
    match: (name) => (name === null ? set.default : set.get(name)),
    process: {
      metricsReset: () => {
        serverMetrics.resetRun();
        const n = set.size;
        log("info", "metrics_reset", { reason: "console", matches: n });
        return `metrics reset: the process and ${n} match${n === 1 ? "" : "es"}`;
      },
      matchMetricsReset: (name) => {
        serverMetrics.resetMatchRun(name);
        log("info", "metrics_reset", { reason: "console", match: name });
        return `metrics reset: match ${name}`;
      },
      matches: () =>
        set.list
          .map(
            (m) =>
              `${m.name}: ${m.match.mapName}, ${m.match.sessionCount} of ${m.match.maxClients} players`,
          )
          .join("\n"),
      matchAdd: (args) => {
        if (args.length < 2 || args.length > 3) {
          return { ok: false, text: "usage: match_add <name> <map> [maxClients]" };
        }
        const spec = matchSpec(args[0] as string, args[1] as string, args[2] ?? null, "match_add");
        return typeof spec === "string" ? { ok: false, text: spec } : addMatch(spec);
      },
      matchRemove: removeMatch,
    },
  };
  const stopConsole =
    options.console === undefined
      ? () => {}
      : startConsole(options.console, (line) => runConsoleLine(line, consoleHost, log));
  const metricsOut = cli.metricsOut === null ? null : resolve(cwd, cli.metricsOut);

  let stopping: Promise<void> | null = null;
  const stop = (signal?: string): Promise<void> => {
    if (stopping !== null) return stopping;
    log("info", "shutdown", signal === undefined ? {} : { signal });
    stopConsole();
    listener.stopAccepting();
    // The demos end first (their END records), so the shutdown kicks are not in them.
    for (const m of set.list) m.match.stopRecording();
    for (const m of set.list) kickAll(m.match, "server shutting down");
    loop.stop();
    timers.stop();
    serverMetrics.gc.stop();
    if (metricsOut !== null) writeMetrics(metricsOut, buildHash, serverMetrics, log);
    const files: Promise<void>[] = [...draining];
    for (const m of set.list) for (const sink of m.demos.pending) files.push(sink.done);
    stopping = Promise.all([listener.close(SHUTDOWN_CLOSE_MS), Promise.all(files)]).then(() => {});
    return stopping;
  };

  return {
    matches,
    set,
    listener,
    loop,
    pass,
    cvars,
    template,
    buildHash,
    log,
    metrics: serverMetrics,
    rconGuard,
    addMatch,
    removeMatch,
    stop,
  };
}

/** A match's `/status` entry. */
function statusOf(m: ServerMatch) {
  return {
    name: m.name,
    map: m.match.mapName,
    players: m.match.sessionCount,
    maxClients: m.match.maxClients,
  };
}

/** Seconds between the memory samples that give the metrics windows their peaks. */
const MEMORY_SAMPLE_S = 1;

/**
 * The metrics timers (D-029): a memory sample every second (the windows' peaks), one `metrics`
 * line set every `intervalS` seconds (0 = none) and, with `--metrics-discard`, the run window's
 * restart that many seconds after listen. One-shot timers, unref'd so they never keep the process
 * alive; they run on the event loop between ticks, never inside one.
 */
function startMetricsTimers(
  metrics: ServerMetrics,
  intervalS: number,
  cli: { readonly metricsDiscardS: number },
  log: JsonLog,
): { stop(): void } {
  let line: NodeJS.Timeout | null = null;
  let discard: NodeJS.Timeout | null = null;
  let sample: NodeJS.Timeout | null = null;
  const armSample = () => {
    sample = setTimeout(() => {
      metrics.sampleMemory();
      armSample();
    }, MEMORY_SAMPLE_S * 1000);
    sample.unref();
  };
  armSample();
  const arm = () => {
    line = setTimeout(() => {
      metrics.logInterval();
      arm();
    }, intervalS * 1000);
    line.unref();
  };
  if (intervalS > 0) arm();
  if (cli.metricsDiscardS > 0) {
    discard = setTimeout(() => {
      discard = null;
      metrics.resetRun();
      log("info", "metrics_reset", { reason: "discard", discardS: cli.metricsDiscardS });
    }, cli.metricsDiscardS * 1000);
    discard.unref();
  }
  return {
    stop: () => {
      if (line !== null) clearTimeout(line);
      if (discard !== null) clearTimeout(discard);
      if (sample !== null) clearTimeout(sample);
      line = null;
      discard = null;
      sample = null;
    },
  };
}

/**
 * Writes the run windows (`/metrics`'s JSON plus the build hash) to `file` at shutdown, creating
 * its folder. A failure is logged, not thrown: shutdown goes on.
 */
function writeMetrics(file: string, buildHash: string, metrics: ServerMetrics, log: JsonLog): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ buildHash, ...metrics.json() }, null, 2)}\n`);
    log("info", "metrics_written", { file });
  } catch (e) {
    log("error", "error", { msg: `--metrics-out ${file}: ${e instanceof Error ? e.message : e}` });
  }
}

/** KICKs every session of `match` with `reason` (each socket then closes). */
function kickAll(match: Match, reason: string): void {
  for (let id = 0; id < MATCH_MAX_CLIENTS; id++) {
    const s = match.session(id);
    if (s !== undefined) match.kick(s, reason);
  }
}
