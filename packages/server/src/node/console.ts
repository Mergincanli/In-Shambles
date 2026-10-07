import { createInterface } from "node:readline";
import { PRINT_ERROR } from "@game/shared";
import { runServerCommand } from "../match/commands";
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

/**
 * Runs one console line on `match` as an admin: the server commands a client may send (`set`,
 * `reset`, `toggle` on replicated cvars; the CVARS broadcast follows on the next tick). The reply
 * is logged as `{"ev":"console"}`.
 */
export function runConsoleLine(line: string, name: string, match: Match, log: JsonLog): void {
  const text = line.trim();
  if (text === "") return;
  const result = runServerCommand(text, match.cvars, true);
  if (result.text === "") return;
  log(result.level === PRINT_ERROR ? "error" : "info", "console", {
    match: name,
    text: result.text,
  });
}
