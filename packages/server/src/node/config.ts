import { parseArgs } from "node:util";
import type { CvarRegistry } from "@game/shared";
import { tokenizeCommand } from "../match/commands";
import { WsLimits } from "../transport/wsTransport";

/** A bad `server.cfg` line or command-line flag; the server refuses to start with it. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/** One `set` to apply, with where it came from (for error messages). */
export interface CvarAssignment {
  readonly name: string;
  readonly value: string;
  /** `server.cfg:3`, `--port`, `--set`. */
  readonly source: string;
}

/** What the command line asks for (D-029). */
export interface CommandLine {
  /** `--cfg <file>`; null = `server.cfg` in the working directory, if there is one. */
  readonly cfg: string | null;
  /** `--maps <dir>`; null = the repository's `content/maps`. */
  readonly mapsDir: string | null;
  /** `--port`, `--map`, then each `--set name=value`, in that order (they override the cfg). */
  readonly sets: readonly CvarAssignment[];
}

/**
 * Parses the server's flags: `--cfg <file>`, `--port <n>` (= `--set sv_port=<n>`), `--map <name>`
 * (= `--set sv_map=<name>`), `--maps <dir>` and repeatable `--set <cvar>=<value>`. Anything else
 * is a ConfigError.
 */
export function parseCommandLine(args: readonly string[]): CommandLine {
  let parsed: ReturnType<typeof parseFlags>;
  try {
    parsed = parseFlags(args);
  } catch (e) {
    throw new ConfigError(e instanceof Error ? e.message : String(e));
  }
  const v = parsed.values;
  const sets: CvarAssignment[] = [];
  if (v.port !== undefined) sets.push({ name: "sv_port", value: v.port, source: "--port" });
  if (v.map !== undefined) sets.push({ name: "sv_map", value: v.map, source: "--map" });
  for (const item of v.set ?? []) {
    const eq = item.indexOf("=");
    if (eq <= 0) throw new ConfigError(`--set ${item}: expected <cvar>=<value>`);
    sets.push({ name: item.slice(0, eq), value: item.slice(eq + 1), source: "--set" });
  }
  return { cfg: v.cfg ?? null, mapsDir: v.maps ?? null, sets };
}

function parseFlags(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      cfg: { type: "string" },
      port: { type: "string" },
      map: { type: "string" },
      maps: { type: "string" },
      set: { type: "string", multiple: true },
    },
  });
}

/**
 * Parses `server.cfg` (D-029): one `set <cvar> <value>` per line, tokenized like the console
 * (double quotes group a value with spaces; unquoted words are joined with one space); blank
 * lines and lines starting with `//` or `#` are comments. A comment after a value is refused
 * rather than read into the value. `file` names the file in error messages.
 */
export function parseServerCfg(text: string, file: string): CvarAssignment[] {
  const out: CvarAssignment[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line === "" || line.startsWith("//") || line.startsWith("#")) continue;
    const source = `${file}:${i + 1}`;
    const tokens = tokenizeCommand(line);
    if (tokens === null) throw new ConfigError(`${source}: unterminated quote`);
    if ((tokens[0] ?? "").toLowerCase() !== "set") {
      throw new ConfigError(`${source}: unknown command ${tokens[0] ?? ""}`);
    }
    const name = tokens[1];
    if (name === undefined || tokens.length < 3) {
      throw new ConfigError(`${source}: usage: set <cvar> <value>`);
    }
    for (let t = 2; t < tokens.length; t++) {
      const word = tokens[t] as string;
      if (word.startsWith("//") || word.startsWith("#")) {
        throw new ConfigError(`${source}: a comment must be on a line of its own`);
      }
    }
    out.push({ name, value: tokens.slice(2).join(" "), source });
  }
  return out;
}

/**
 * Applies `sets` in order, each to the first registry that has the cvar: the server's own
 * (`sv_*`) or the match's (`pm_*`, replicated to clients). An unknown cvar, a value of the wrong
 * type, or one out of the cvar's range (the registry would clamp it) is a ConfigError: a server
 * must not start with a setting other than the one written.
 */
export function applyAssignments(
  sets: readonly CvarAssignment[],
  registries: readonly CvarRegistry[],
): void {
  for (const a of sets) {
    const reg = registries.find((r) => r.has(a.name));
    if (reg === undefined) throw new ConfigError(`${a.source}: unknown cvar ${a.name}`);
    const r = reg.setFromString(a.name, a.value);
    if (!r.ok) {
      throw new ConfigError(`${a.source}: ${a.name}: "${a.value}" is not a valid value`);
    }
    if (r.clamped) {
      const def = reg.info(a.name)?.def;
      throw new ConfigError(
        `${a.source}: ${a.name} ${a.value} is out of range (${def?.min ?? "-∞"}…${def?.max ?? "∞"})`,
      );
    }
  }
}

/**
 * The send-buffer limits the server's transports share (D-030), from `sv_sendBufferDrop` and
 * `sv_sendBufferClose`. The close limit must be above the drop limit, or a slow client would be
 * closed before it ever lost a snapshot: a ConfigError.
 */
export function sendLimits(cvars: CvarRegistry): WsLimits {
  const limits = new WsLimits();
  limits.sendBufferDrop = cvars.getNumber("sv_sendBufferDrop", limits.sendBufferDrop);
  limits.sendBufferClose = cvars.getNumber("sv_sendBufferClose", limits.sendBufferClose);
  if (limits.sendBufferClose <= limits.sendBufferDrop) {
    throw new ConfigError(
      `sv_sendBufferClose (${limits.sendBufferClose}) must be above sv_sendBufferDrop (${limits.sendBufferDrop})`,
    );
  }
  return limits;
}
