import {
  CvarFlag,
  type CvarRegistry,
  PRINT_ERROR,
  PRINT_INFO,
  type SetResult,
  TEXT_MAX,
} from "@game/shared";

/**
 * Console commands a client may send as CMD (M2 design §2, D-027, D-042). A client's `set`, `reset`
 * or `toggle` on a REPLICATED cvar is not applied locally: it travels here, the match applies it to
 * the server's registry, and the CVARS broadcast that follows updates every client's mirror at an
 * effective tick. Changing a cvar, `status`, `kick` and `metrics reset` need the admin flag: the
 * Worker's one client and the stdin console have it; a client of the dedicated server gets it for
 * one command at a time through `rcon <password> <command…>` (`parseRcon`; the match checks the
 * password). `cvars` asks for the current block again (a client whose snapshot hash stays
 * different) and is open to everyone. Every command acts on one match only; the process's own
 * commands are the stdin console's (node/console.ts). Rare: parsing allocates.
 */

export interface CommandResult {
  /** PRINT level of the reply. */
  readonly level: number;
  /**
   * Reply text for the issuing client: at most TEXT_MAX chars, except `status`, whose lines the
   * match sends as several PRINTs (`Match` splits at line ends).
   */
  readonly text: string;
  /** Send the current cvar block to the issuing client. */
  readonly resendCvars: boolean;
}

/**
 * Splits console text into tokens at whitespace; double quotes group a token that may hold
 * spaces (`set sv_hostname "my server"`). Returns null for an unterminated quote.
 */
export function tokenizeCommand(text: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c <= 0x20) {
      i++;
      continue;
    }
    if (c === 0x22) {
      const end = text.indexOf('"', i + 1);
      if (end < 0) return null;
      out.push(text.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < n && text.charCodeAt(j) > 0x20 && text.charCodeAt(j) !== 0x22) j++;
    out.push(text.slice(i, j));
    i = j;
  }
  return out;
}

function reply(level: number, text: string, resendCvars = false): CommandResult {
  return { level, text: text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text, resendCvars };
}

function describeSet(name: string, r: SetResult, input: string): CommandResult {
  if (r.ok) {
    let text = `${name} = ${String(r.value)}`;
    if (r.clamped) text += " (clamped)";
    if (r.latched) text += " (latched: applies on map restart)";
    return reply(PRINT_INFO, text);
  }
  if (r.error === "type") return reply(PRINT_ERROR, `${name}: "${input}" is not a valid value`);
  if (r.error === "cheat") return reply(PRINT_ERROR, `${name} is cheat protected`);
  return reply(PRINT_ERROR, `unknown cvar ${name}`);
}

/**
 * What the admin commands act on besides the cvars: the match itself (`Match` implements it). The
 * host's metrics are the match's `metricsReset` option.
 */
export interface MatchAdmin {
  /** `status`: the match and one line per session. */
  status(): string;
  /** `kick <id> [reason]`: KICKs client `id`; false when there is no such session. */
  kickClient(id: number, reason: string): boolean;
  /** `metrics reset` for this match only; null when its host keeps no metrics (the Worker). */
  metricsReset(): string | null;
}

/** One `rcon` line (D-042): the password and the command it carries, as typed. */
export interface RconRequest {
  /** "" when the line has none. */
  readonly password: string;
  /** The rest of the line after the password, quoting kept; "" when there is none. */
  readonly command: string;
}

/**
 * The end of the token that starts at or after `from` (whitespace skipped), and its text, into
 * `out`; false when there is none or its quote is unterminated.
 */
function readToken(text: string, from: number, out: { text: string; end: number }): boolean {
  let i = from;
  const n = text.length;
  while (i < n && text.charCodeAt(i) <= 0x20) i++;
  if (i >= n) return false;
  if (text.charCodeAt(i) === 0x22) {
    const close = text.indexOf('"', i + 1);
    if (close < 0) return false;
    out.text = text.slice(i + 1, close);
    out.end = close + 1;
    return true;
  }
  let j = i;
  while (j < n && text.charCodeAt(j) > 0x20 && text.charCodeAt(j) !== 0x22) j++;
  out.text = text.slice(i, j);
  out.end = j;
  return true;
}

/**
 * Splits `rcon <password> <command…>` (M3 design §2.10): null when `text` is not an rcon line. The
 * password is one token (quoted when it holds spaces); the command is the raw rest of the line,
 * so its own quoting survives for `runServerCommand`.
 */
export function parseRcon(text: string): RconRequest | null {
  const tok = { text: "", end: 0 };
  if (!readToken(text, 0, tok) || tok.text.toLowerCase() !== "rcon") return null;
  if (!readToken(text, tok.end, tok)) return { password: "", command: "" };
  const password = tok.text;
  return { password, command: text.slice(tok.end).trim() };
}

/** "set: only an admin may …": what a non-admin hears, with the way to become one. */
function adminOnly(verb: string, what: string): CommandResult {
  return reply(PRINT_ERROR, `${verb}: only an admin may ${what} (use rcon ${verb} ...)`);
}

/**
 * Runs one command's text against the server's registry and, for `status`, `kick` and
 * `metrics reset`, against `match` (null: those reply that there is no match here). `admin`: the
 * Worker's client, the stdin console, or a client's command that came through a correct `rcon`.
 */
export function runServerCommand(
  text: string,
  cvars: CvarRegistry,
  admin: boolean,
  match: MatchAdmin | null = null,
): CommandResult {
  const tokens = tokenizeCommand(text);
  if (tokens === null) return reply(PRINT_ERROR, "unterminated quote");
  const verb = (tokens[0] ?? "").toLowerCase();
  if (verb === "") return reply(PRINT_ERROR, "empty command");
  if (verb === "cvars") return reply(PRINT_INFO, "", true);
  if (verb === "rcon") return reply(PRINT_ERROR, "rcon: this console already runs as admin");
  if (verb === "status" || verb === "kick" || verb === "metrics") {
    return matchCommand(verb, tokens, admin, match);
  }
  if (verb !== "set" && verb !== "reset" && verb !== "toggle") {
    return reply(PRINT_ERROR, `unknown server command ${tokens[0] ?? ""}`);
  }
  const name = tokens[1];
  if (name === undefined || (verb === "set" && tokens.length < 3)) {
    return reply(
      PRINT_ERROR,
      verb === "set" ? "usage: set <cvar> <value>" : `usage: ${verb} <cvar>`,
    );
  }
  if (!admin) return adminOnly(verb, "change server cvars");
  const info = cvars.info(name);
  if (info === undefined) return reply(PRINT_ERROR, `unknown cvar ${name}`);
  const def = info.def;
  if (((def.flags ?? 0) & CvarFlag.REPLICATED) === 0) {
    return reply(PRINT_ERROR, `${def.name} is not a replicated cvar`);
  }
  if (verb === "reset") return describeSet(def.name, cvars.reset(def.name), "");
  if (verb === "toggle") {
    const v = info.value;
    if (typeof v === "string") return reply(PRINT_ERROR, `${def.name}: cannot toggle a string`);
    const next = typeof v === "boolean" ? !v : v === 0 ? 1 : 0;
    return describeSet(def.name, cvars.set(def.name, next), String(next));
  }
  const input = tokens.slice(2).join(" ");
  return describeSet(def.name, cvars.setFromString(def.name, input), input);
}

const CLIENT_ID = /^\d{1,2}$/;

/** `status`, `kick <id> [reason]` and `metrics reset`: admin commands on this match only. */
function matchCommand(
  verb: string,
  tokens: readonly string[],
  admin: boolean,
  match: MatchAdmin | null,
): CommandResult {
  if (verb === "metrics" && (tokens.length !== 2 || tokens[1]?.toLowerCase() !== "reset")) {
    return reply(PRINT_ERROR, "usage: metrics reset");
  }
  const id = tokens[1] ?? "";
  if (verb === "kick" && !CLIENT_ID.test(id)) {
    return reply(PRINT_ERROR, "usage: kick <client id> [reason]");
  }
  if (!admin) {
    const what =
      verb === "status" ? "list the players" : verb === "kick" ? "kick" : "reset metrics";
    return adminOnly(verb === "metrics" ? "metrics reset" : verb, what);
  }
  if (match === null) return reply(PRINT_ERROR, `${verb}: there is no match here`);
  if (verb === "status") return { level: PRINT_INFO, text: match.status(), resendCvars: false };
  if (verb === "kick") {
    const reason = tokens.slice(2).join(" ") || "kicked by an admin";
    return match.kickClient(Number(id), reason)
      ? reply(PRINT_INFO, `client ${Number(id)} kicked: ${reason}`)
      : reply(PRINT_ERROR, `kick: no client ${Number(id)}`);
  }
  const done = match.metricsReset();
  return done === null
    ? reply(PRINT_ERROR, "metrics reset: this server keeps no metrics")
    : reply(PRINT_INFO, done);
}
