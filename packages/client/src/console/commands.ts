import { tokenizeCommand } from "@game/server";
import {
  CvarFlag,
  type CvarInfo,
  type CvarRegistry,
  findNetProfile,
  NET_PROFILES,
  type NetProfile,
  type SetResult,
} from "@game/shared";
import type { CorrectionLog } from "../net/predictor";
import { actionOf, type Binds, isKeyCode } from "./binds";

/**
 * The client console's commands (docs/06 §6, M2 design §2 "Console"). DOM-free: console.ts feeds
 * it lines and shows what it prints. Commands are rare, so parsing allocates freely.
 *
 * A `set`, `reset` or `toggle` on a REPLICATED cvar is never applied here (D-027): the client's
 * copy mirrors the server, so the line goes to the server as CMD, and the server's CVARS
 * broadcast changes the mirror at an effective tick. The server's PRINT reply shows up in the
 * console. Any other cvar is the client's own and changes at once.
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

function describeSet(name: string, r: SetResult, input: string): string {
  if (r.ok) {
    let text = `${name} = ${String(r.value)}`;
    if (r.clamped) text += " (clamped)";
    if (r.latched) text += " (latched: applies on map restart)";
    return text;
  }
  if (r.error === "type") return `${name}: "${input}" is not a valid value`;
  if (r.error === "cheat") return `${name} is cheat protected`;
  return `unknown cvar ${name}`;
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
    host.print(
      `${d.name} = ${String(info.value)} (default ${String(d.default)}${kind}): ${d.description}`,
    );
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
    host.print(`${flagLetters(d.flags ?? 0)} ${d.name} ${String(info.value)}`);
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
