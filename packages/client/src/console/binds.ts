/**
 * Key binds (docs/06 §6, M2 design §2 "Default binds"): physical keys by `KeyboardEvent.code`, so
 * AZERTY and QWERTZ players press the same places, plus `Mouse0`..`Mouse4` for mouse buttons.
 * A bind holds a console line: a `+action` (held while the key is down) or a command run on the
 * press. Codes match ignoring case, as console input does; each keeps the spelling it was bound
 * with for listing. DOM-free, so the console's tests run in Node.
 */

/** Actions a `+name` bind holds down (input/sampler.ts maps them to UserCmd axes and buttons). */
export const ACTIONS = [
  "forward",
  "back",
  "moveleft",
  "moveright",
  "jump",
  "crouch",
  "walk",
  "sprint",
  "attack",
] as const;
export type ActionName = (typeof ACTIONS)[number];

export const ACTION_FORWARD = 0;
export const ACTION_BACK = 1;
export const ACTION_MOVELEFT = 2;
export const ACTION_MOVERIGHT = 3;
export const ACTION_JUMP = 4;
export const ACTION_CROUCH = 5;
export const ACTION_WALK = 6;
/** Inert until sprint lands in M4: sent as BUTTON_SPRINT, which pmove ignores for now. */
export const ACTION_SPRINT = 7;
/** Inert until combat: sent as BUTTON_ATTACK. */
export const ACTION_ATTACK = 8;
export const ACTION_COUNT = ACTIONS.length;

/** The action index of a `+name` command, or −1 when `command` is not one. */
export function actionOf(command: string): number {
  if (command.charCodeAt(0) !== 0x2b) return -1;
  return (ACTIONS as readonly string[]).indexOf(command.slice(1).toLowerCase());
}

/**
 * The defaults (M2 design §2). No Ctrl binds: the browser keeps Ctrl+W and its kin for itself.
 * Sprint and attack are bound so the keys already feel right; both stay inert in M2.
 */
export const DEFAULT_BINDS: readonly (readonly [code: string, command: string])[] = Object.freeze([
  ["KeyW", "+forward"],
  ["KeyS", "+back"],
  ["KeyA", "+moveleft"],
  ["KeyD", "+moveright"],
  ["Space", "+jump"],
  ["KeyC", "+crouch"],
  ["KeyX", "+walk"],
  ["ShiftLeft", "+sprint"],
  ["Mouse0", "+attack"],
  ["Backquote", "toggleconsole"],
]);

/** The command that opens and closes the console; it works with the console's input focused. */
export const TOGGLE_CONSOLE = "toggleconsole";

/** Whether a bind's command toggles the console (verbs match ignoring case, as the console's). */
export function isToggleConsole(command: string | undefined): boolean {
  return command !== undefined && /^\s*toggleconsole(\s|$)/i.test(command);
}

/** What a key code looks like: `KeyW`, `Digit1`, `ArrowUp`, `F5`, `Mouse0`. */
const CODE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

export function isKeyCode(code: string): boolean {
  return CODE.test(code);
}

/**
 * Ctrl, Alt and Meta cannot be bound: the browser keeps their combinations (Ctrl+W closes the
 * tab), so the page drops every key pressed with one held, which would also drop the movement
 * keys pressed during a Ctrl crouch. Shift is fine (+sprint).
 */
const MODIFIER = /^(control|alt|meta|os)(left|right)$/i;

export function isModifierCode(code: string): boolean {
  return MODIFIER.test(code);
}

interface Bind {
  readonly code: string;
  readonly command: string;
}

export class Binds {
  /** Keyed by the lowercased code. */
  private readonly map = new Map<string, Bind>();
  private changes = 0;

  constructor(defaults: readonly (readonly [string, string])[] = DEFAULT_BINDS) {
    for (const [code, command] of defaults) this.map.set(code.toLowerCase(), { code, command });
  }

  /** Bumped by every change, so settings.ts saves only after one. */
  get version(): number {
    return this.changes;
  }

  /** The command bound to `code`, or undefined. Called per key event: it lowercases the code. */
  commandFor(code: string): string | undefined {
    return this.map.get(code.toLowerCase())?.command;
  }

  /**
   * Why `code` cannot be bound to `command`, or null when it can: a code that is not one, a
   * modifier key, an empty command, or taking `toggleconsole` off the last key that has it (the
   * console would be gone for good: settings.ts saves the binds, and only the console edits them).
   */
  refusal(code: string, command: string): string | null {
    if (!isKeyCode(code)) return `${code} is not a key code (KeyW, Space, ArrowUp, Mouse0)`;
    if (isModifierCode(code)) {
      return `${code} cannot be bound: the browser keeps Ctrl, Alt and Meta combinations`;
    }
    if (command.trim() === "") return "the command is empty (unbind removes a bind)";
    if (!isToggleConsole(command) && this.isLastConsoleKey(code)) {
      return `${code} is the last key bound to toggleconsole; bind another key to it first`;
    }
    return null;
  }

  /** Whether `code` is the only key bound to toggleconsole. */
  isLastConsoleKey(code: string): boolean {
    const key = code.toLowerCase();
    if (!isToggleConsole(this.map.get(key)?.command)) return false;
    for (const [k, b] of this.map) if (k !== key && isToggleConsole(b.command)) return false;
    return true;
  }

  /** False, changing nothing, when `refusal` gives a reason. */
  bind(code: string, command: string): boolean {
    if (this.refusal(code, command) !== null) return false;
    const text = command.trim();
    const key = code.toLowerCase();
    const old = this.map.get(key);
    if (old?.command === text) return true;
    // A rebind keeps the code's earlier spelling (`bind keyw` must not rename KeyW).
    this.map.set(key, { code: old?.code ?? code, command: text });
    this.changes++;
    return true;
  }

  /** Whether `code` was bound and is now not (the last toggleconsole key stays: see `refusal`). */
  unbind(code: string): boolean {
    if (this.isLastConsoleKey(code)) return false;
    const removed = this.map.delete(code.toLowerCase());
    if (removed) this.changes++;
    return removed;
  }

  /** Every bind as [code, command], sorted by code. */
  list(): [string, string][] {
    return [...this.map.values()]
      .map((b): [string, string] => [b.code, b.command])
      .sort((a, b) => (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : 1));
  }

  /** Whether the binds are exactly DEFAULT_BINDS (settings.ts then stores none). */
  isDefault(): boolean {
    if (this.map.size !== DEFAULT_BINDS.length) return false;
    for (const [code, command] of DEFAULT_BINDS) {
      if (this.map.get(code.toLowerCase())?.command !== command) return false;
    }
    return true;
  }

  /**
   * Replaces every bind with `entries` (stored settings) when all of them can be bound and one
   * toggles the console; otherwise changes nothing (a stored set with a bad entry is not the
   * player's, and keeping part of it could drop the console key). Returns why it refused, or null.
   */
  replaceAll(entries: readonly (readonly [string, string])[]): string | null {
    let opensConsole = false;
    const scratch = new Binds([]);
    for (const [code, command] of entries) {
      const why = scratch.refusal(code, command);
      if (why !== null) return why;
      scratch.map.set(code.toLowerCase(), { code, command: command.trim() });
      if (isToggleConsole(command)) opensConsole = true;
    }
    if (!opensConsole) return "no key toggles the console";
    this.map.clear();
    for (const [key, b] of scratch.map) this.map.set(key, b);
    this.changes++;
    return null;
  }
}
