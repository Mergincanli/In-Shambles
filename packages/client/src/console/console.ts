import { type Binds, isToggleConsole } from "./binds";

/** Lines the console keeps; older ones scroll away for good. */
export const CONSOLE_MAX_LINES = 400;
/** Lines of input history (ArrowUp / ArrowDown). */
export const CONSOLE_HISTORY = 50;

export interface ConsoleOptions {
  readonly binds: Binds;
  /** Runs one entered line (commands.ts). */
  readonly run: (line: string) => void;
  /** After it opened or closed: the page releases keys and the pointer lock, or takes it back. */
  readonly onToggle: (open: boolean) => void;
}

/**
 * The drop-down console (docs/06 §6, M2 design §2): an output log and one input line. While it is
 * open it owns the keyboard; the key bound to `toggleconsole` (Backquote) closes it from the input
 * too, and Escape does as well (and both still do from the page when the input lost focus:
 * input/keyboard.ts). The commands themselves are DOM-free (commands.ts).
 */
export class GameConsole {
  readonly el: HTMLDivElement;
  readonly output: HTMLDivElement;
  readonly input: HTMLInputElement;
  private isOpen = false;
  private readonly history: string[] = [];
  /** Position in `history` while browsing it; history.length = the line being typed. */
  private browse = 0;

  constructor(
    parent: HTMLElement,
    private readonly options: ConsoleOptions,
  ) {
    const doc = parent.ownerDocument;
    this.el = doc.createElement("div");
    this.el.id = "console";
    this.el.hidden = true;
    this.output = doc.createElement("div");
    this.output.id = "console-output";
    this.input = doc.createElement("input");
    this.input.id = "console-input";
    this.input.type = "text";
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.setAttribute("aria-label", "console");
    this.el.append(this.output, this.input);
    parent.append(this.el);
    this.input.addEventListener("keydown", (e) => this.onKey(e));
  }

  get open(): boolean {
    return this.isOpen;
  }

  setOpen(open: boolean): void {
    if (open === this.isOpen) return;
    this.isOpen = open;
    this.el.hidden = !open;
    if (open) {
      this.input.focus();
      this.output.scrollTop = this.output.scrollHeight;
    } else {
      this.input.blur();
    }
    this.options.onToggle(open);
  }

  toggle(): void {
    this.setOpen(!this.isOpen);
  }

  print(text: string): void {
    const doc = this.el.ownerDocument;
    for (const line of text.split("\n")) {
      const row = doc.createElement("div");
      row.textContent = line;
      this.output.append(row);
    }
    while (this.output.childElementCount > CONSOLE_MAX_LINES) {
      this.output.firstElementChild?.remove();
    }
    this.output.scrollTop = this.output.scrollHeight;
  }

  clear(): void {
    this.output.replaceChildren();
  }

  private onKey(e: KeyboardEvent): void {
    // The console owns these keys: the page's key routing must not see them (it would reopen
    // the console the toggle key just closed).
    e.stopPropagation();
    if (e.code === "Escape" || isToggleConsole(this.options.binds.commandFor(e.code))) {
      e.preventDefault();
      // A held toggle key's repeats must not close what its first press just opened.
      if (!e.repeat) this.setOpen(false);
      return;
    }
    if (e.key === "Tab") {
      // Keeps the focus in the input (there is no completion yet).
      e.preventDefault();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const line = this.input.value.trim();
      this.input.value = "";
      if (line === "") return;
      this.print(`] ${line}`);
      if (this.history[this.history.length - 1] !== line) this.history.push(line);
      if (this.history.length > CONSOLE_HISTORY) this.history.shift();
      this.browse = this.history.length;
      this.options.run(line);
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const n = this.history.length;
      this.browse = Math.min(n, Math.max(0, this.browse + (e.key === "ArrowUp" ? -1 : 1)));
      this.input.value = this.history[this.browse] ?? "";
    }
  }
}
