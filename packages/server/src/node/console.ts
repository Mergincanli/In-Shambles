import { createInterface } from "node:readline";
import { CvarRegistry, PRINT_ERROR } from "@game/shared";
import { type AdminReply, tokenizeCommand } from "../match/commands";
import type { Match } from "../match/match";
import type { JsonLog } from "./log";
import { registerServerCvars } from "./serverCvars";

/**
 * The admin console on stdin (D-029): each line is handed to `onLine`. Returns a function that
 * stops reading. The end of the input (stdin closed, `< /dev/null`) only ends the console, and so
 * does a read error (a console window closing, D-051). Once stopped, no line runs, not even one
 * that came in the same read as the line that stopped it (`quit\nrecord x\n`: readline would
 * still hand `record x` over after its close, and it would run after the shutdown; D-051).
 */
export function startConsole(
  input: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): () => void {
  const rl = createInterface({ input, terminal: false });
  let open = true;
  const stop = () => {
    open = false;
    rl.close();
  };
  rl.on("line", (line) => {
    if (open) onLine(line);
  });
  rl.on("error", stop);
  return stop;
}

/** A match the console can address: its name and the match. */
export interface ConsoleMatch {
  readonly name: string;
  readonly match: Match;
}

/**
 * What the console does beyond the match's own commands: the process's actions (D-047). These are
 * stdin's (and, but for `quit`, server.cfg's), never rcon's (D-042, D-051).
 */
export interface ConsoleProcess {
  /**
   * The bare `metrics reset`: starts the metrics run window again for the process and every
   * match (M3 design §2.14). Returns the reply.
   */
  metricsReset(): string;
  /** `@<match> metrics reset`: that match's run window alone. Returns the reply. */
  matchMetricsReset(name: string): string;
  /** `matches`: one line per match (name, map, players, maxClients). */
  matches(): string;
  /** `match_add <name> <map> [maxClients]`, the arguments as typed. */
  matchAdd(args: readonly string[]): AdminReply;
  /** `match_remove <name>`. */
  matchRemove(name: string): AdminReply;
  /**
   * `quit` (D-051): stops the process as SIGINT and SIGTERM do (main.ts: the shutdown, then exit
   * 0), so a parent can stop the server on any platform (on Windows a signal ends a child without
   * running its handler). Null for a server inside another program (tests), which stops it.
   */
  readonly quit: (() => void) | null;
}

/** Where console lines go: the matches by name, and the process's own commands when it has any. */
export interface ConsoleHost {
  /** The match named `name`, or the default match for null; undefined when there is none. */
  match(name: string | null): ConsoleMatch | undefined;
  readonly process?: ConsoleProcess;
}

/** The Node server's own SERVER cvars (built on first use): the console's startup settings. */
let startupCvars: CvarRegistry | null = null;

/** Whether `name` is one of the Node server's SERVER cvars (`sv_port`, `sv_maxClients`, …). */
function isStartupCvar(name: string): boolean {
  if (startupCvars === null) {
    startupCvars = new CvarRegistry();
    registerServerCvars(startupCvars);
  }
  return startupCvars.has(name);
}

/**
 * The process commands (D-047, D-051): never sent to a match, never with an `@<match>` prefix.
 * `quit` is stdin's alone: server.cfg and rcon refuse it.
 */
const PROCESS_COMMANDS = new Set(["matches", "match_add", "match_remove", "quit"]);

/**
 * Runs one console line as an admin (D-029, D-042, D-047). An `@<name>` prefix sends the rest to
 * that match, else match commands go to the default match: `set`, `reset`, `toggle` on replicated
 * cvars (the CVARS broadcast following on the next tick), `status`, `kick <id> [reason]`,
 * `record [name]` and `stoprecord` (D-044), and `metrics reset`, which with a prefix restarts that
 * match's run window alone and without one the process's and every match's. The process commands
 * `matches`, `match_add`, `match_remove` and `quit` (D-051: the process's graceful stop, its reply
 * logged before the shutdown line) take no prefix. `set`, `reset` or `toggle` of one of
 * the server's own SERVER cvars (read once at startup, docs/06 §8) replies that it is a startup
 * setting. The reply is logged as `{"ev":"console"}`, with `match` when a match answered.
 */
export function runConsoleLine(line: string, host: ConsoleHost, log: JsonLog): void {
  let text = line.trim();
  if (text === "") return;
  let named: string | null = null;
  if (text.startsWith("@")) {
    const space = text.search(/\s/);
    named = space < 0 ? text.slice(1) : text.slice(1, space);
    text = space < 0 ? "" : text.slice(space).trim();
    if (text === "") {
      log("error", "console", { text: "usage: @<match> <command…>" });
      return;
    }
  }
  const tokens = tokenizeCommand(text);
  const head = tokens?.[0]?.toLowerCase() ?? "";
  const proc = host.process;
  if (PROCESS_COMMANDS.has(head)) {
    if (named !== null) {
      log("error", "console", { text: `${head} is a process command: no @<match> prefix` });
      return;
    }
    if (proc === undefined) {
      log("error", "console", { text: `${head}: this console has no process commands` });
      return;
    }
    const args = (tokens as string[]).slice(1);
    if (head === "quit" && args.length === 0 && proc.quit !== null) {
      log("info", "console", { text: "quit: shutting down" });
      proc.quit();
      return;
    }
    let reply: AdminReply;
    if (head === "quit") {
      reply = {
        ok: false,
        text:
          args.length > 0
            ? "usage: quit"
            : "quit: this server runs inside another program, which stops it",
      };
    } else if (head === "matches") reply = { ok: true, text: proc.matches() };
    else if (head === "match_add") reply = proc.matchAdd(args);
    else if (args.length !== 1) reply = { ok: false, text: "usage: match_remove <name>" };
    else reply = proc.matchRemove(args[0] as string);
    log(reply.ok ? "info" : "error", "console", { text: reply.text });
    return;
  }
  const target = host.match(named);
  if (target === undefined) {
    log("error", "console", { text: `no match ${named ?? "(default)"}` });
    return;
  }
  if (
    proc !== undefined &&
    tokens !== null &&
    tokens.length === 2 &&
    head === "metrics" &&
    tokens[1]?.toLowerCase() === "reset"
  ) {
    if (named === null) log("info", "console", { text: proc.metricsReset() });
    else log("info", "console", { match: target.name, text: proc.matchMetricsReset(target.name) });
    return;
  }
  const cvar = tokens?.[1];
  if (
    (head === "set" || head === "reset" || head === "toggle") &&
    cvar !== undefined &&
    !target.match.cvars.has(cvar) &&
    isStartupCvar(cvar)
  ) {
    log("error", "console", {
      text: `${cvar} is a startup setting: set it in server.cfg or with --set, then restart the server`,
    });
    return;
  }
  const result = target.match.runAdminCommand(text);
  if (result.text === "") return;
  log(result.level === PRINT_ERROR ? "error" : "info", "console", {
    match: target.name,
    text: result.text,
  });
}
