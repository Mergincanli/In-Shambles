import { createInterface } from "node:readline";
import { PRINT_ERROR } from "@game/shared";
import { type AdminReply, tokenizeCommand } from "../match/commands";
import type { Match } from "../match/match";
import type { JsonLog } from "./log";

/**
 * The admin console on stdin (D-029): each line is handed to `onLine`. Returns a function that
 * stops reading. The end of the input (stdin closed, `< /dev/null`) only ends the console.
 */
export function startConsole(
  input: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): () => void {
  const rl = createInterface({ input, terminal: false });
  rl.on("line", onLine);
  return () => rl.close();
}

/** A match the console can address: its name and the match. */
export interface ConsoleMatch {
  readonly name: string;
  readonly match: Match;
}

/**
 * What the console does beyond the match's own commands: the process's actions (D-047). These are
 * stdin's and server.cfg's alone, never rcon's (D-042).
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
}

/** Where console lines go: the matches by name, and the process's own commands when it has any. */
export interface ConsoleHost {
  /** The match named `name`, or the default match for null; undefined when there is none. */
  match(name: string | null): ConsoleMatch | undefined;
  readonly process?: ConsoleProcess;
}

/** The process commands (D-047): never sent to a match, never with an `@<match>` prefix. */
const PROCESS_COMMANDS = new Set(["matches", "match_add", "match_remove"]);

/**
 * Runs one console line as an admin (D-029, D-042, D-047). An `@<name>` prefix sends the rest to
 * that match, else match commands go to the default match: `set`, `reset`, `toggle` on replicated
 * cvars (the CVARS broadcast following on the next tick), `status`, `kick <id> [reason]`,
 * `record [name]` and `stoprecord` (D-044), and `metrics reset`, which with a prefix restarts that
 * match's run window alone and without one the process's and every match's. The process commands
 * `matches`, `match_add` and `match_remove` take no prefix. The reply is logged as
 * `{"ev":"console"}`, with `match` when a match answered.
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
    let reply: AdminReply;
    if (head === "matches") reply = { ok: true, text: proc.matches() };
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
  const result = target.match.runAdminCommand(text);
  if (result.text === "") return;
  log(result.level === PRINT_ERROR ? "error" : "info", "console", {
    match: target.name,
    text: result.text,
  });
}
