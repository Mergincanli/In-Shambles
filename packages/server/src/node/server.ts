import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { CvarRegistry, PROTOCOL_VERSION, registerPmoveCvars } from "@game/shared";
import { MatchLoop } from "../match/loop";
import { MATCH_DEFAULT_MAX_CLIENTS, MATCH_MAX_CLIENTS, Match } from "../match/match";
import { TickHistogram } from "../match/tickStats";
import { WsListener } from "../transport/wsListener";
import { WireTraffic, type WsTransport } from "../transport/wsTransport";
import { isBundledServer, serverBuildHash } from "./buildHash";
import {
  applyAssignments,
  ConfigError,
  parseCommandLine,
  parseServerCfg,
  sendLimits,
} from "./config";
import { runConsoleLine, startConsole } from "./console";
import { createNodeHost, type ServerMatch, TimedPass } from "./host";
import { createJsonLog, type JsonLog, matchLog } from "./log";
import { defaultMapsDir, loadMap } from "./maps";
import { ServerMetrics } from "./metrics";
import { registerServerCvars } from "./serverCvars";

/** The one match's name until a process runs several (D-047). */
export const DEFAULT_MATCH = "main";

/** How long shutdown waits for clients to finish their closing handshakes (design value). */
const SHUTDOWN_CLOSE_MS = 1000;

export interface StartOptions {
  /** Command-line flags (D-029; `parseCommandLine`). */
  readonly args?: readonly string[];
  /** Receives each JSON log line (stdout in the process); dropped when absent. */
  readonly write?: (line: string) => void;
  /** Where `server.cfg` and relative paths resolve; the process's working directory by default. */
  readonly cwd?: string;
  /** Read admin console lines from this stream (stdin in the process); none when absent. */
  readonly console?: NodeJS.ReadableStream;
}

export interface RunningServer {
  /** The process's matches by name: `main` until several matches arrive (D-047). */
  readonly matches: Readonly<Record<string, ServerMatch>>;
  readonly listener: WsListener;
  readonly loop: MatchLoop;
  readonly pass: TimedPass;
  /** SERVER cvars (`sv_*`). */
  readonly cvars: CvarRegistry;
  readonly buildHash: string;
  readonly log: JsonLog;
  /** GC, memory, traffic and the run and interval windows (D-029, D-036). */
  readonly metrics: ServerMetrics;
  /**
   * Graceful shutdown (D-029): stop accepting, KICK every client "server shutting down" and close
   * its socket 1001, stop the loop, write `--metrics-out`, and wait (bounded) for the sockets to
   * close. Idempotent.
   */
  stop(signal?: string): Promise<void>;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Starts the dedicated server (D-029): flags and `server.cfg` → SERVER cvars and the match's
 * replicated template → the map → the match (`main`) → the listener → the loop, then logs
 * `server_ok` and `listening` (M3 design §2.14). Throws a ConfigError (or a map
 * or bind error) instead of starting with a setting other than the one written.
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
  const cfgPath = cli.cfg === null ? resolve(cwd, "server.cfg") : resolve(cwd, cli.cfg);
  if (existsSync(cfgPath)) {
    applyAssignments(parseServerCfg(readFileSync(cfgPath, "utf8"), cfgPath), [cvars, template]);
  } else if (cli.cfg !== null) {
    throw new ConfigError(`--cfg ${cli.cfg}: no such file`);
  }
  applyAssignments(cli.sets, [cvars, template]);

  const mapsDir = cli.mapsDir === null ? defaultMapsDir(cwd) : resolve(cwd, cli.mapsDir);
  if (mapsDir === null) throw new ConfigError("no content/maps found; pass --maps <dir>");
  const mapName = String(cvars.get("sv_map"));
  const cmap = loadMap(mapName, mapsDir);
  const buildHash = serverBuildHash();

  const maxClients = cvars.getNumber("sv_maxClients", MATCH_DEFAULT_MAX_CLIENTS);
  const main: ServerMatch = {
    name: DEFAULT_MATCH,
    match: new Match({
      cmap,
      cvars: template,
      buildHash,
      strictBuild: cvars.getNumber("sv_strictBuild", 1) === 1,
      maxClients,
      log: matchLog(log, DEFAULT_MATCH),
    }),
    ticks: new TickHistogram(),
    traffic: new WireTraffic(),
  };
  const matches: Record<string, ServerMatch> = { [DEFAULT_MATCH]: main };
  const list = [main];

  const limits = sendLimits(cvars);
  const pass = new TimedPass(list, log);

  const listener = new WsListener({
    host: String(cvars.get("sv_host")),
    port: cvars.getNumber("sv_port", 0),
    limits,
    target: {
      hasMatch: (name) => name === "" || Object.hasOwn(matches, name),
      accept: (name, transport: WsTransport, ip) => {
        const m = matches[name === "" ? DEFAULT_MATCH : name] as ServerMatch;
        transport.traffic = m.traffic;
        const s = m.match.connect(transport);
        log("info", "connect", { match: m.name, client: s === null ? null : s.clientId, ip });
      },
      status: () => ({
        buildHash,
        protocol: PROTOCOL_VERSION,
        matches: list.map((m) => ({
          name: m.name,
          map: m.match.mapName,
          players: m.match.sessionCount,
          maxClients: m.match.maxClients,
        })),
      }),
      metrics: () => metrics.json(),
    },
  });
  await listener.listen();

  const loop = new MatchLoop(pass, createNodeHost(log, pass));
  pass.loopStats = loop.stats;
  const metrics = new ServerMetrics(
    { matches: list, pass, loop: () => loop.stats, connections: () => listener.connections },
    log,
  );
  metrics.gc.start();
  const timers = startMetricsTimers(metrics, cvars.getNumber("sv_metricsInterval", 10), cli, log);
  loop.start();
  log("info", "server_ok", { startupMs: round3(performance.now()) });
  log("info", "listening", {
    port: listener.port,
    buildHash,
    matches: list.map((m) => ({ name: m.name, map: m.match.mapName })),
  });
  const stopConsole =
    options.console === undefined
      ? () => {}
      : startConsole(options.console, (line) =>
          runConsoleLine(line, main.name, main.match, log, {
            metricsReset: () => {
              metrics.resetRun();
              log("info", "metrics_reset", { reason: "console", matches: list.length });
              return `metrics reset: the process and ${list.length} match${list.length === 1 ? "" : "es"}`;
            },
          }),
        );
  const metricsOut = cli.metricsOut === null ? null : resolve(cwd, cli.metricsOut);

  let stopping: Promise<void> | null = null;
  const stop = (signal?: string): Promise<void> => {
    if (stopping !== null) return stopping;
    log("info", "shutdown", signal === undefined ? {} : { signal });
    stopConsole();
    listener.stopAccepting();
    for (const m of list) kickAll(m.match, "server shutting down");
    loop.stop();
    timers.stop();
    metrics.gc.stop();
    if (metricsOut !== null) writeMetrics(metricsOut, buildHash, metrics, log);
    stopping = listener.close(SHUTDOWN_CLOSE_MS);
    return stopping;
  };

  return { matches, listener, loop, pass, cvars, buildHash, log, metrics, stop };
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
