import {
  CvarFlag,
  type CvarRegistry,
  PRINT_ERROR,
  PRINT_INFO,
  type SetResult,
  TEXT_MAX,
} from "@game/shared";

/**
 * Console commands a client may send as CMD (M2 design §2, D-027). A client's `set`, `reset` or
 * `toggle` on a REPLICATED cvar is not applied locally: it travels here, the match applies it to
 * the server's registry, and the CVARS broadcast that follows updates every client's mirror at an
 * effective tick. Changing a cvar needs the admin flag (the Worker's one client has it; M3 decides
 * authorization for the Node server). `cvars` asks for the current block again (a client whose
 * snapshot hash stays different) and is open to everyone. Rare: parsing allocates.
 */

export interface CommandResult {
  /** PRINT level of the reply. */
  readonly level: number;
  /** Reply text for the issuing client, at most TEXT_MAX chars. */
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

/** Runs one CMD's text against the server's registry. */
export function runServerCommand(text: string, cvars: CvarRegistry, admin: boolean): CommandResult {
  const tokens = tokenizeCommand(text);
  if (tokens === null) return reply(PRINT_ERROR, "unterminated quote");
  const verb = (tokens[0] ?? "").toLowerCase();
  if (verb === "") return reply(PRINT_ERROR, "empty command");
  if (verb === "cvars") return reply(PRINT_INFO, "", true);
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
  if (!admin) return reply(PRINT_ERROR, `${verb}: only an admin may change server cvars`);
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
