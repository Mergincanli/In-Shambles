import { actionOf, type Binds, isToggleConsole } from "../console/binds";
import type { ActionState } from "./sampler";

/**
 * Keys to binds (docs/06 §6, M2 design §2): a key's press holds its `+action` until that same key
 * comes up, even if it was rebound in between, or runs its command once. `KeyRouter` is DOM-free
 * (Node tests); `attachKeyboard` wires it to the page.
 */
export class KeyRouter {
  /** The action each held key pressed (−1: it ran a command), by lowercased code. */
  private readonly down = new Map<string, number>();

  constructor(
    private readonly binds: Binds,
    private readonly actions: ActionState,
    private readonly run: (command: string) => void,
  ) {}

  /**
   * A key or mouse button went down; returns whether it is bound (the page then keeps it).
   * `repeat` (KeyboardEvent.repeat) never runs a command: after releaseAll forgot the key, a held
   * Backquote would otherwise flip the console at the auto-repeat rate. A held `+action` key
   * picks its action back up instead.
   */
  keyDown(code: string, repeat = false): boolean {
    const key = code.toLowerCase();
    // Auto-repeat: the first press already acted.
    if (this.down.has(key)) return true;
    const command = this.binds.commandFor(code);
    if (command === undefined) return false;
    const action = actionOf(command);
    if (action < 0 && repeat) return true;
    this.down.set(key, action);
    if (action >= 0) this.actions.press(action);
    else this.run(command);
    return true;
  }

  /** Whether `code` closes an open console: Escape, or a key bound to toggleconsole. */
  isConsoleKey(code: string): boolean {
    return code === "Escape" || isToggleConsole(this.binds.commandFor(code));
  }

  /** A key or mouse button came up; returns whether it was pressed bound or is bound now. */
  keyUp(code: string): boolean {
    const key = code.toLowerCase();
    const action = this.down.get(key);
    if (action === undefined) return this.binds.commandFor(code) !== undefined;
    this.down.delete(key);
    if (action >= 0) this.actions.release(action);
    return true;
  }

  /** Every key up (the tab went hidden, the window lost focus, the console opened). */
  releaseAll(): void {
    this.down.clear();
    this.actions.releaseAll();
  }

  /** Keys currently held through a bind. */
  get heldCount(): number {
    return this.down.size;
  }
}

/** The parts of `window` attachKeyboard uses (a fake in Node tests). */
export type KeyboardWindow = Pick<Window, "addEventListener" | "removeEventListener"> & {
  readonly document: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
};

export interface KeyboardOptions {
  /** While true the console owns the keyboard: nothing reaches the router. */
  readonly consoleOpen: () => boolean;
  /** Closes the console. */
  readonly closeConsole: () => void;
}

/**
 * Routes the page's key events to `router`. Bound keys call preventDefault (Space must not
 * scroll, Backquote must not type). Presses with Ctrl, Meta or Alt are left to the browser (and
 * those keys cannot be bound); their releases still route, so nothing stays held. While the
 * console is open its input handles its own keys; one that reaches the window means the input
 * lost focus (a click on the view, Tab), so the console keys still close it from here. A hidden
 * tab or a lost focus releases every key. Returns a detach.
 */
export function attachKeyboard(
  win: KeyboardWindow,
  router: KeyRouter,
  options: KeyboardOptions,
): () => void {
  const down = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (options.consoleOpen()) {
      if (!e.repeat && router.isConsoleKey(e.code)) {
        e.preventDefault();
        options.closeConsole();
      }
      return;
    }
    if (router.keyDown(e.code, e.repeat)) e.preventDefault();
  };
  const up = (e: KeyboardEvent) => {
    if (router.keyUp(e.code) && !options.consoleOpen()) e.preventDefault();
  };
  const release = () => router.releaseAll();
  const visibility = () => {
    if (win.document.visibilityState === "hidden") router.releaseAll();
  };
  win.addEventListener("keydown", down);
  win.addEventListener("keyup", up);
  win.addEventListener("blur", release);
  win.document.addEventListener("visibilitychange", visibility);
  return () => {
    win.removeEventListener("keydown", down);
    win.removeEventListener("keyup", up);
    win.removeEventListener("blur", release);
    win.document.removeEventListener("visibilitychange", visibility);
  };
}
