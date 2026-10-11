import { createInterface } from "node:readline";
import { PRINT_ERROR } from "@game/shared";
import { tokenizeCommand } from "../match/commands";
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

/** What the console does beyond the match's own commands: process-level actions. */
export interface ConsoleProcess {
  /**
   * `metrics reset`: starts the metrics run window again for the process and every match
   * (M3 design §2.14). The process-wide reset is stdin's alone: rcon's resets only the sender's
   * match (D-042). Returns the reply.
   */
  metricsReset(): string;
}

/**
 * Runs one console line as an admin: `metrics reset` on the process (`proc`), else on `match` the
 * commands an admin client may send (`set`, `reset`, `toggle` on replicated cvars, the CVARS
 * broadcast following on the next tick; `status`; `kick <id> [reason]`; D-042; `record [name]`
 * and `stoprecord`, D-044). The reply is logged as `{"ev":"console"}`.
 */
export function runConsoleLine(
  line: string,
  name: string,
  match: Match,
  log: JsonLog,
  proc?: ConsoleProcess,
): void {
  const text = line.trim();
  if (text === "") return;
  const tokens = tokenizeCommand(text);
  if (
    proc !== undefined &&
    tokens !== null &&
    tokens.length === 2 &&
    tokens[0]?.toLowerCase() === "metrics" &&
    tokens[1]?.toLowerCase() === "reset"
  ) {
    log("info", "console", { text: proc.metricsReset() });
    return;
  }
  const result = match.runAdminCommand(text);
  if (result.text === "") return;
  log(result.level === PRINT_ERROR ? "error" : "info", "console", {
    match: name,
    text: result.text,
  });
}
