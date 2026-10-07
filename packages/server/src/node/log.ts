import type { LogLevel, MatchLog } from "../match/host";

/** Extra fields of a log line (JSON values). */
export type LogFields = Readonly<Record<string, unknown>>;

/** Writes one structured log line: level, event name and fields. */
export type JsonLog = (lvl: LogLevel, ev: string, fields?: LogFields) => void;

/**
 * The server's JSON-lines logger (D-029, docs/06 §8): one object per line,
 * `{"t":<ISO time>,"lvl":…,"ev":…, …fields}`, so tools and log stores parse it without a format.
 * `t` is wall-clock time, for people reading logs; nothing in the simulation reads it.
 */
export function createJsonLog(
  write: (line: string) => void,
  clock: () => Date = () => new Date(),
): JsonLog {
  return (lvl, ev, fields) => {
    write(JSON.stringify({ t: clock().toISOString(), lvl, ev, ...fields }));
  };
}

/** A match's text log as JSON lines: `{"ev":"log","match":<name>,"msg":…}`. */
export function matchLog(log: JsonLog, match: string): MatchLog {
  return (level, msg) => log(level, "log", { match, msg });
}
