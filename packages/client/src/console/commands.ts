import { tokenizeCommand } from "@game/server";
import {
  CvarFlag,
  type CvarInfo,
  type CvarRegistry,
  findNetProfile,
  NET_PROFILES,
  type NetProfile,
  type SetResult,
  TEXT_MAX,
} from "@game/shared";
import type { CorrectionLog } from "../net/predictor";
import { actionOf, type Binds, isKeyCode } from "./binds";
import { RCON_PASSWORD_CVAR } from "./clientCvars";

/**
 * The client console's commands (docs/06 §6, M2 design §2 "Console"). DOM-free: console.ts feeds
 * it lines and shows what it prints. Commands are rare, so parsing allocates freely.
 *
 * A `set`, `reset` or `toggle` on a REPLICATED cvar is never applied here (D-027): the client's
 * copy mirrors the server, so the line goes to the server as CMD, and the server's CVARS
 * broadcast changes the mirror at an effective tick. The server's PRINT reply shows up in the
 * console. Any other cvar is the client's own and changes at once, unless it is CHEAT and the
 * server's `sv_cheats` is 0 (D-042). `rcon <command…>` sends the command with `rcon_password` for
 * the server to run as admin of this match; the password is never printed.
 */

/** The simulated link on the client's end of the connection (NetSimTransport). */
export interface NetProfileControl {
  profile(): NetProfile;
  setProfile(profile: NetProfile): void;
}

export interface ConsoleHost {
  /** The client's registry: its own cvars plus the mirror of the server's replicated ones. */
  readonly cvars: CvarRegistry;
  readonly binds: Binds;
  print(text: string): void;
  clear(): void;
  toggleConsole(): void;
  /** Sends a CMD to the server; false when there is no session to send it on. */
  sendServer(text: string): boolean;
  /** Null when the link is not simulated (net_profile then says so). */
  readonly net: NetProfileControl | null;
  /** The prediction's correction log, for `net_corrections`; null without a client. */
  readonly corrections: CorrectionLog | null;
  /** Where this session plays, for `connect` alone: a server's ws:// URL or the local Worker. */
  readonly server: string;
  /** Whether that session is still open (a kick, a lost link or `disconnect` ends it). */
  connected(): boolean;
  /**
   * Starts a session on the server at `address` (D-031; the page reloads with `?connect=`).
   * Returns why it can't, or null.
   */
  connect(address: string): string | null;
  /** Ends the session; false when there is none. */
  disconnect(): boolean;
}

/** Every command and its usage, for `help` and docs/06 §6. */
export const CONSOLE_COMMANDS: readonly (readonly [string, string])[] = Object.freeze([
  ["set", "set <cvar> <value>: change a cvar (a replicated one on the server)"],
  ["toggle", "toggle <cvar>: flip a bool, or a number between 0 and 1"],
  ["reset", "reset <cvar>: back to its default"],
  ["cvarlist", "cvarlist [prefix]: list cvars with their flags and values"],
  ["bind", "bind <code> [command]: show or set what a key runs (KeyboardEvent.code, Mouse0..4)"],
  ["unbind", "unbind <code>: remove a key's bind (one key always keeps toggleconsole)"],
  ["net_profile", "net_profile [name]: show or switch the simulated network profile"],
  ["net_corrections", "net_corrections: the newest prediction corrections and what differed"],
  ["connect", "connect [ws://host[:port]]: show the server, or play on another (the page reloads)"],
  ["disconnect", "disconnect: leave the server"],
  ["rcon", "rcon <command…>: run a server command as admin, with rcon_password (set it first)"],
  ["clear", "clear: empty the console"],
  ["toggleconsole", "toggleconsole: open or close the console"],
  ["help", "help: this list; a cvar's name alone shows its value"],
]);

function flagLetters(flags: number): string {
  return (
    (flags & CvarFlag.ARCHIVE ? "A" : "-") +
    (flags & CvarFlag.REPLICATED ? "R" : "-") +
    (flags & CvarFlag.CHEAT ? "C" : "-") +
    (flags & CvarFlag.LATCH ? "L" : "-") +
    (flags & CvarFlag.SERVER ? "S" : "-")
  );
}

function isReplicated(info: CvarInfo): boolean {
  return ((info.def.flags ?? 0) & CvarFlag.REPLICATED) !== 0;
}

/** A token as the server's tokenizer reads it back: quoted when it holds spaces or is empty. */
function quoteToken(text: string): string {
  return text === "" || /\s/.test(text) ? `"${text}"` : text;
}

/** Shown instead of the rcon password's value. */
const HIDDEN = "(hidden)";

function isSecret(name: string): boolean {
  return name.toLowerCase() === RCON_PASSWORD_CVAR.toLowerCase();
}

/** The rcon password's name anywhere in a text, any case. */
const SECRET_NAME = /rcon_password/i;

/**
 * What the console echoes and keeps in its history for an entered line (D-042). The decision
 * follows the tokens `runConsoleCommand` reads (`set "rcon_password"x` sets it too): a line with
 * anything after the token that names `rcon_password` is echoed with the rest hidden and kept out
 * of the history (`history` null), and so is one that holds the name inside a longer token (a
 * bind's command) or that does not parse; the bare name, `reset rcon_password` and any other line
 * as they are.
 */
export function consoleEcho(line: string): { echo: string; history: string | null } {
  const m = SECRET_NAME.exec(line);
  if (m === null) return { echo: line, history: line };
  const tokens = tokenizeCommand(line);
  if (tokens === null) {
    return { echo: `${line.slice(0, m.index + m[0].length).trim()} ${HIDDEN}`, history: null };
  }
  let i = 0;
  while (i < tokens.length && !SECRET_NAME.test(tokens[i] as string)) i++;
  const named = isSecret(tokens[i] as string);
  if (named && i === tokens.length - 1) return { echo: line, history: line };
  const shown = tokens.slice(0, named ? i + 1 : i).map(quoteToken);
  shown.push(HIDDEN);
  return { echo: shown.join(" "), history: null };
}

function describeSet(name: string, r: SetResult, input: string): string {
  if (r.ok && isSecret(name)) return `${name} set`;
  if (r.ok) {
    let text = `${name} = ${String(r.value)}`;
    if (r.clamped) text += " (clamped)";
    if (r.latched) text += " (latched: applies on map restart)";
    return text;
  }
  if (r.error === "type") return `${name}: "${input}" is not a valid value`;
  if (r.error === "cheat") return `${name} is cheat protected: the server's sv_cheats is 0`;
  return `unknown cvar ${name}`;
}

/**
 * `rcon <command…>` (D-042, M3 design §2.10): CMD `rcon "<rcon_password>" <command…>`, the command
 * as typed (its own quoting kept). The server runs it as admin of this match when the password is
 * right; a wrong one costs strike points, so an unset password is refused here.
 */
function rcon(text: string, first: string, args: readonly string[], host: ConsoleHost): void {
  if (args.length === 0) {
    host.print("usage: rcon <command…>");
    return;
  }
  if (!host.connected()) {
    host.print("rcon: not connected");
    return;
  }
  const password = host.cvars.get(RCON_PASSWORD_CVAR);
  if (typeof password !== "string" || password === "") {
    host.print("rcon: set rcon_password first");
    return;
  }
  // The server's own rule for its password (node/rconGuard.ts validRconPassword): no other could
  // be right, and a double quote would end the token.
  if (!/^[\x20\x21\x23-\x7e]+$/.test(password)) {
    host.print("rcon: rcon_password must be printable ASCII without double quotes");
    return;
  }
  const raw = text.trimStart();
  const command = raw.startsWith(first)
    ? raw.slice(first.length).trim()
    : args.map(quoteToken).join(" ");
  if (!host.sendServer(`rcon "${password}" ${command}`)) {
    host.print(
      `rcon: the command does not fit one message (${TEXT_MAX} Latin-1 chars with the password)`,
    );
  }
}

/** The correction log, oldest first: each snapshot tick, the distance and the fields that differed. */
function netCorrections(host: ConsoleHost): void {
  const log = host.corrections;
  if (log === null) {
    host.print("no prediction to report on");
    return;
  }
  host.print(`${log.total} corrections; the newest ${log.count}:`);
  for (let i = 0; i < log.count; i++) {
    const r = log.at(i);
    const d = Math.round(r.distance * 100) / 100;
    host.print(`tick ${r.tick} (to ${r.latestTick}) ${d} u: ${r.diff().join(", ")}`);
  }
}

function describeProfile(p: NetProfile): string {
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  return (
    `${p.name}: ${p.delayMs} ms ±${p.jitterMs} each way, loss ${pct(p.loss)}, ` +
    `duplicate ${pct(p.duplicate)}, reorder ${pct(p.reorder)}`
  );
}

/** Runs one console line. */
export function runConsoleCommand(text: string, host: ConsoleHost): void {
  const tokens = tokenizeCommand(text);
  if (tokens === null) {
    host.print("unterminated quote");
    return;
  }
  const [first, ...args] = tokens;
  if (first === undefined) return;
  const verb = first.toLowerCase();
  switch (verb) {
    case "set":
    case "reset":
    case "toggle":
      changeCvar(verb, args, host);
      return;
    case "cvarlist":
      cvarList(args[0] ?? "", host);
      return;
    case "bind":
      bind(args, host);
      return;
    case "unbind":
      if (args[0] === undefined) host.print("usage: unbind <code>");
      else if (host.binds.isLastConsoleKey(args[0])) {
        host.print(
          `${args[0]} is the last key bound to toggleconsole; bind another key to it first`,
        );
      } else if (host.binds.unbind(args[0])) host.print(`${args[0]} unbound`);
      else host.print(`${args[0]} is not bound`);
      return;
    case "net_profile":
      netProfile(args[0], host);
      return;
    case "net_corrections":
      netCorrections(host);
      return;
    case "connect":
      if (args[0] === undefined) {
        host.print(
          host.connected() ? `playing on ${host.server}` : `not connected (last: ${host.server})`,
        );
      } else {
        const why = host.connect(args[0]);
        if (why !== null) host.print(`connect: ${why}`);
      }
      return;
    case "disconnect":
      if (!host.disconnect()) host.print("disconnect: not connected");
      return;
    case "rcon":
      rcon(text, first, args, host);
      return;
    case "clear":
      host.clear();
      return;
    case "toggleconsole":
      host.toggleConsole();
      return;
    case "help":
      for (const [, usage] of CONSOLE_COMMANDS) host.print(usage);
      return;
  }
  const info = host.cvars.info(first);
  if (info !== undefined && args.length === 0) {
    const d = info.def;
    const kind = isReplicated(info) ? ", replicated: set on the server" : "";
    const value = isSecret(d.name) ? HIDDEN : String(info.value);
    host.print(`${d.name} = ${value} (default ${String(d.default)}${kind}): ${d.description}`);
    return;
  }
  host.print(`unknown command ${first} (try help)`);
}

function changeCvar(verb: "set" | "reset" | "toggle", args: string[], host: ConsoleHost): void {
  const name = args[0];
  if (name === undefined || (verb === "set" && args.length < 2)) {
    host.print(verb === "set" ? "usage: set <cvar> <value>" : `usage: ${verb} <cvar>`);
    return;
  }
  const reg = host.cvars;
  const info = reg.info(name);
  if (info === undefined) {
    host.print(`unknown cvar ${name}`);
    return;
  }
  const def = info.def;
  const input = args.slice(1).join(" ");
  if (isReplicated(info)) {
    const line = verb === "set" ? `set ${def.name} ${quoteToken(input)}` : `${verb} ${def.name}`;
    // tokenizeCommand never yields a double quote, so the requoted line reads back the same.
    if (!host.sendServer(line)) host.print(`${def.name} is a server cvar: not connected`);
    return;
  }
  if (verb === "reset") {
    host.print(describeSet(def.name, reg.reset(def.name), ""));
    return;
  }
  if (verb === "toggle") {
    const v = info.value;
    if (typeof v === "string") {
      host.print(`${def.name}: cannot toggle a string`);
      return;
    }
    const next = typeof v === "boolean" ? !v : v === 0 ? 1 : 0;
    host.print(describeSet(def.name, reg.set(def.name, next), String(next)));
    return;
  }
  host.print(describeSet(def.name, reg.setFromString(def.name, input), input));
}

function cvarList(prefix: string, host: ConsoleHost): void {
  const list = host.cvars.list(prefix);
  for (const info of list) {
    const d = info.def;
    const value = isSecret(d.name) ? HIDDEN : String(info.value);
    host.print(`${flagLetters(d.flags ?? 0)} ${d.name} ${value}`);
  }
  host.print(`${list.length} cvars${prefix === "" ? "" : ` starting with ${prefix}`}`);
}

function bind(args: string[], host: ConsoleHost): void {
  const code = args[0];
  if (code === undefined) {
    host.print("usage: bind <code> [command]");
    return;
  }
  if (!isKeyCode(code)) {
    host.print(`${code} is not a key code (KeyW, Space, ArrowUp, Mouse0)`);
    return;
  }
  if (args.length === 1) {
    const command = host.binds.commandFor(code);
    host.print(command === undefined ? `${code} is not bound` : `${code} = ${command}`);
    return;
  }
  const command = args.slice(1).join(" ");
  if (SECRET_NAME.test(command)) {
    // Binds are saved (app/settings.ts); the password never is (D-042).
    host.print("bind: a bind cannot hold rcon_password: binds are saved, the password never is");
    return;
  }
  if (command.startsWith("+") && actionOf(command) < 0) {
    host.print(`unknown action ${command}`);
    return;
  }
  const why = host.binds.refusal(code, command);
  if (why !== null) {
    host.print(`bind: ${why}`);
    return;
  }
  host.binds.bind(code, command);
  host.print(`${code} = ${command.trim()}`);
}

function netProfile(name: string | undefined, host: ConsoleHost): void {
  const net = host.net;
  if (net === null) {
    host.print("net_profile: this connection has no network simulator");
    return;
  }
  if (name === undefined) {
    host.print(`net_profile ${describeProfile(net.profile())}`);
    host.print(`profiles: ${NET_PROFILES.map((p) => p.name).join(", ")}`);
    return;
  }
  const p = findNetProfile(name);
  if (p === undefined) {
    host.print(`unknown profile ${name}; profiles: ${NET_PROFILES.map((x) => x.name).join(", ")}`);
    return;
  }
  net.setProfile(p);
  host.print(`net_profile ${describeProfile(p)}`);
}
