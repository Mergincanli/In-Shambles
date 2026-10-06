import type { KeyRouter } from "./keyboard";

/**
 * Pointer lock (docs/06 §7 "Input", M2 design §2 "Mouse"): raw, unaccelerated counts where the
 * browser offers them (`unadjustedMovement`), plain pointer lock otherwise (Firefox, or a system
 * that refuses raw input). Mouse buttons route through the binds (`Mouse0`..`Mouse4`) only while
 * locked, so the click that takes the lock never fires.
 */
export class PointerLock {
  private isLocked = false;
  /** Whether the last lock came with raw input (false after a fallback). */
  raw = false;

  constructor(
    private readonly el: HTMLElement,
    private readonly onChange: (locked: boolean) => void,
  ) {
    const doc = el.ownerDocument;
    doc.addEventListener("pointerlockchange", () => {
      const locked = doc.pointerLockElement === el;
      if (locked === this.isLocked) return;
      this.isLocked = locked;
      this.onChange(locked);
    });
    doc.addEventListener("pointerlockerror", () => {
      if (this.raw) this.requestPlain();
    });
  }

  get locked(): boolean {
    return this.isLocked;
  }

  /** Asks for the lock (needs a user gesture: a click or a key press). */
  request(): void {
    if (this.isLocked) return;
    this.raw = true;
    try {
      const result: unknown = this.el.requestPointerLock({ unadjustedMovement: true });
      // Older engines return nothing; newer ones a promise that rejects without raw support.
      if (result instanceof Promise) result.catch(() => this.requestPlain());
    } catch {
      this.requestPlain();
    }
  }

  exit(): void {
    if (this.isLocked) this.el.ownerDocument.exitPointerLock();
  }

  private requestPlain(): void {
    this.raw = false;
    try {
      const result: unknown = this.el.requestPointerLock();
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      // No lock (no gesture yet, or not supported): the click-to-play prompt stays up.
    }
  }
}

/** Routes mouse buttons to `router` while `lock` holds, and clicks on the canvas take the lock. */
export function attachMouseButtons(
  canvas: HTMLElement,
  lock: PointerLock,
  router: KeyRouter,
  canLock: () => boolean,
): () => void {
  const doc = canvas.ownerDocument;
  const down = (e: MouseEvent) => {
    if (lock.locked) {
      if (router.keyDown(`Mouse${e.button}`)) e.preventDefault();
    } else if (e.target === canvas && canLock()) {
      lock.request();
    }
  };
  const up = (e: MouseEvent) => {
    router.keyUp(`Mouse${e.button}`);
  };
  const menu = (e: Event) => {
    if (lock.locked) e.preventDefault();
  };
  doc.addEventListener("mousedown", down);
  doc.addEventListener("mouseup", up);
  doc.addEventListener("contextmenu", menu);
  return () => {
    doc.removeEventListener("mousedown", down);
    doc.removeEventListener("mouseup", up);
    doc.removeEventListener("contextmenu", menu);
  };
}
