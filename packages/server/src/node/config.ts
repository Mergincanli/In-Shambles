import { parseArgs } from "node:util";
import type { CvarRegistry } from "@game/shared";
import { tokenizeCommand } from "../match/commands";
import { SessionLimits } from "../match/limits";
import { AdmissionLimits, parseOrigins } from "../transport/wsListener";
import { WsLimits } from "../transport/wsTransport";
import { isReservedFileName, RESERVED_FILE_REASON } from "./fileNames";
import { MATCH_NAME } from "./matchSet";

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

/**
 * A match to create (D-047, M3 design §2.17): `match_add <name> <map> [maxClients]` in server.cfg
 * or on stdin, `--match <name>=<map>[:<maxClients>]` on the command line.
 */
export interface MatchSpec {
  /** A MATCH_NAME: what `/m/<name>` and `@<name>` address. */
  readonly name: string;
  readonly map: string;
  /** Players it admits, 1–64; null = `sv_maxClients`. */
  readonly maxClients: number | null;
  /** `server.cfg:3`, `--match`, `console`. */
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
  /** `--metrics-out <file>`: the run windows as JSON at shutdown (D-029); null = none. */
  readonly metricsOut: string | null;
  /** `--metrics-discard <s>`: the run window starts this many seconds after listen; 0 = at listen. */
  readonly metricsDiscardS: number;
  /** Each `--match <name>=<map>[:<maxClients>]`, in order (after server.cfg's, D-047). */
  readonly matches: readonly MatchSpec[];
}

/**
 * The longest `--metrics-discard`, s (a day; design value): far below `setTimeout`'s 2^31 − 1 ms,
 * past which Node would fire the reset after 1 ms instead.
 */
export const METRICS_DISCARD_MAX_S = 86_400;

/** Map ids a match may name (the server's own rule, node/maps.ts). */
const MAP_ID = /^[a-z0-9_]{1,63}$/;

/**
 * Checks a match's name, map (a map id, never a Windows device name: D-051) and player cap as
 * typed (`maxClients` text, or null for `sv_maxClients`): the spec, or the reason it is refused,
 * prefixed with `source`.
 */
export function matchSpec(
  name: string,
  map: string,
  maxClients: string | null,
  source: string,
): MatchSpec | string {
  if (!MATCH_NAME.test(name)) {
    return `${source}: "${name}" is not a match name (a-z, 0-9 and _, 1–32 chars)`;
  }
  if (!MAP_ID.test(map)) return `${source}: "${map}" is not a map id`;
  if (isReservedFileName(map)) return `${source}: "${map}" ${RESERVED_FILE_REASON}`;
  let cap: number | null = null;
  if (maxClients !== null) {
    cap = /^\d{1,2}$/.test(maxClients) ? Number(maxClients) : Number.NaN;
    if (!(cap >= 1 && cap <= 64)) {
      return `${source}: maxClients ${maxClients}: expected 1 to 64`;
    }
  }
  return { name, map, maxClients: cap, source };
}

/** `<name>=<map>[:<maxClients>]` (`--match`), or a ConfigError. */
function parseMatchFlag(item: string): MatchSpec {
  const eq = item.indexOf("=");
  if (eq <= 0) throw new ConfigError(`--match ${item}: expected <name>=<map>[:<maxClients>]`);
  const rest = item.slice(eq + 1);
  const colon = rest.indexOf(":");
  const spec = matchSpec(
    item.slice(0, eq),
    colon < 0 ? rest : rest.slice(0, colon),
    colon < 0 ? null : rest.slice(colon + 1),
    "--match",
  );
  if (typeof spec === "string") throw new ConfigError(spec);
  return spec;
}

/**
 * Parses the server's flags: `--cfg <file>`, `--port <n>` (= `--set sv_port=<n>`), `--map <name>`
 * (= `--set sv_map=<name>`), `--maps <dir>`, repeatable `--set <cvar>=<value>`, repeatable
 * `--match <name>=<map>[:<maxClients>]` (D-047), `--metrics-out <file>` and `--metrics-discard
 * <s>`. Anything else is a ConfigError.
 */
export function parseCommandLine(args: readonly string[]): CommandLine {
  let parsed: ReturnType<typeof parseFlags>;
  try {
    parsed = parseFlags(args);
  } catch (e) {
    // PowerShell passes an unquoted comma list as arguments of their own (D-051).
    const positional = (e as { code?: unknown }).code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL";
    throw new ConfigError(
      `${e instanceof Error ? e.message : String(e)}${positional ? COMMA_HINT : ""}`,
    );
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
  let metricsDiscardS = 0;
  if (v["metrics-discard"] !== undefined) {
    const text = v["metrics-discard"];
    metricsDiscardS = Number(text);
    if (
      text.trim() === "" ||
      !Number.isFinite(metricsDiscardS) ||
      metricsDiscardS < 0 ||
      metricsDiscardS > METRICS_DISCARD_MAX_S
    ) {
      throw new ConfigError(
        `--metrics-discard ${text}: expected seconds from 0 to ${METRICS_DISCARD_MAX_S}`,
      );
    }
  }
  const matches: MatchSpec[] = [];
  for (const item of v.match ?? []) matches.push(parseMatchFlag(item));
  return {
    cfg: v.cfg ?? null,
    mapsDir: v.maps ?? null,
    sets,
    metricsOut: v["metrics-out"] ?? null,
    metricsDiscardS,
    matches,
  };
}

/** What a stray argument's error adds: PowerShell's comma operator splits an unquoted list. */
const COMMA_HINT =
  ' (in PowerShell, quote a value that holds commas: --set "sv_allowedOrigins=https://a,https://b")';

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
      match: { type: "string", multiple: true },
      "metrics-out": { type: "string" },
      "metrics-discard": { type: "string" },
    },
  });
}

/** A `set <cvar> <value>` line of server.cfg. */
export interface CfgSet extends CvarAssignment {
  readonly kind: "set";
}

/** A `match_add <name> <map> [maxClients]` line of server.cfg (D-047). */
export interface CfgMatchAdd {
  readonly kind: "match_add";
  readonly spec: MatchSpec;
}

/**
 * An `@<name> <command…>` line of server.cfg (D-047): one of the match's admin commands (a
 * `set` on its replicated cvars, `record`, …), run once the match exists.
 */
export interface CfgMatchLine {
  readonly kind: "match";
  readonly match: string;
  /** The command after the prefix, as written. */
  readonly text: string;
  readonly source: string;
}

export type CfgEntry = CfgSet | CfgMatchAdd | CfgMatchLine;

/**
 * Parses `server.cfg` (D-029, D-047): one `set <cvar> <value>`, `match_add <name> <map>
 * [maxClients]` or `@<match> <command…>` per line, tokenized like the console (double quotes group
 * a value with spaces; unquoted words are joined with one space); blank lines and lines starting
 * with `//` or `#` are comments. A comment after a value is refused rather than read into the
 * value. `file` names the file in error messages. What each line does (the template, the default
 * match, a named one) is `startServer`'s: this only checks the form.
 */
export function parseServerCfg(text: string, file: string): CfgEntry[] {
  const out: CfgEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line === "" || line.startsWith("//") || line.startsWith("#")) continue;
    const source = `${file}:${i + 1}`;
    const tokens = tokenizeCommand(line);
    if (tokens === null) throw new ConfigError(`${source}: unterminated quote`);
    for (let t = 1; t < tokens.length; t++) {
      const word = tokens[t] as string;
      if (word.startsWith("//") || word.startsWith("#")) {
        throw new ConfigError(`${source}: a comment must be on a line of its own`);
      }
    }
    const head = tokens[0] ?? "";
    if (head.startsWith("@")) {
      const match = head.slice(1);
      if (!MATCH_NAME.test(match)) {
        throw new ConfigError(`${source}: "${match}" is not a match name`);
      }
      const rest = line.slice(line.indexOf(head) + head.length).trim();
      if (rest === "") throw new ConfigError(`${source}: usage: @<match> <command…>`);
      out.push({ kind: "match", match, text: rest, source });
      continue;
    }
    const command = head.toLowerCase();
    if (command === "match_add") {
      if (tokens.length < 3 || tokens.length > 4) {
        throw new ConfigError(`${source}: usage: match_add <name> <map> [maxClients]`);
      }
      const spec = matchSpec(tokens[1] as string, tokens[2] as string, tokens[3] ?? null, source);
      if (typeof spec === "string") throw new ConfigError(spec);
      out.push({ kind: "match_add", spec });
      continue;
    }
    if (command === "quit") {
      // D-051: the console's (stdin) alone; a cfg line would stop the server it configures.
      throw new ConfigError(`${source}: quit is the console's (stdin) alone, not server.cfg's`);
    }
    if (command !== "set") throw new ConfigError(`${source}: unknown command ${head}`);
    const name = tokens[1];
    if (name === undefined || tokens.length < 3) {
      throw new ConfigError(`${source}: usage: set <cvar> <value>`);
    }
    out.push({ kind: "set", name, value: tokens.slice(2).join(" "), source });
  }
  return out;
}

/**
 * A server.cfg's text from its bytes (D-051): UTF-8 (a BOM dropped), or UTF-16LE with its BOM,
 * which Windows PowerShell 5.1's `>` and `Out-File` write. UTF-16BE, and NUL bytes without a BOM
 * (UTF-16 that lost it), are a ConfigError that says to save the file as UTF-8. `file` names it.
 */
export function decodeServerCfg(bytes: Uint8Array, file: string): string {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b[0] === 0xff && b[1] === 0xfe) return b.toString("utf16le", 2);
  if (b[0] === 0xfe && b[1] === 0xff) {
    throw new ConfigError(`${file}: UTF-16 BE text; save it as UTF-8`);
  }
  if (b.includes(0)) {
    throw new ConfigError(`${file}: NUL bytes (UTF-16 without a BOM?); save it as UTF-8`);
  }
  return b.toString("utf8", b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0);
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

/**
 * The session limits every match of the server applies (D-041): timeouts, the starved-cmd limit,
 * strike levels and bucket sizes from their SERVER cvars. A kick level not above the warn level
 * would kick before it ever warned: a ConfigError.
 */
export function sessionLimits(cvars: CvarRegistry): SessionLimits {
  const l = new SessionLimits();
  l.timeout = cvars.getNumber("sv_timeout", l.timeout);
  l.helloTimeout = cvars.getNumber("sv_helloTimeout", l.helloTimeout);
  l.handshakeTimeout = cvars.getNumber("sv_handshakeTimeout", l.handshakeTimeout);
  l.starveNeutralTicks = cvars.getNumber("sv_starveNeutralTicks", l.starveNeutralTicks);
  l.strikeWarn = cvars.getNumber("sv_strikeWarn", l.strikeWarn);
  l.strikeKick = cvars.getNumber("sv_strikeKick", l.strikeKick);
  l.inputBurst = cvars.getNumber("sv_inputBurst", l.inputBurst);
  l.reliableBurst = cvars.getNumber("sv_reliableBurst", l.reliableBurst);
  if (l.strikeKick <= l.strikeWarn) {
    throw new ConfigError(
      `sv_strikeKick (${l.strikeKick}) must be above sv_strikeWarn (${l.strikeWarn})`,
    );
  }
  return l;
}

/**
 * Who the listener admits (D-041, D-047): `sv_maxPerIp`, the `sv_allowedOrigins` list and
 * `sv_maxTotalClients`.
 */
export function admissionLimits(cvars: CvarRegistry): AdmissionLimits {
  const a = new AdmissionLimits();
  a.maxPerIp = cvars.getNumber("sv_maxPerIp", a.maxPerIp);
  a.allowedOrigins = parseOrigins(String(cvars.get("sv_allowedOrigins") ?? ""));
  a.maxTotal = cvars.getNumber("sv_maxTotalClients", a.maxTotal);
  return a;
}
