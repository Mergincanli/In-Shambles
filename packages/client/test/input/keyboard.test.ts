import { describe, expect, it } from "vitest";
import { ACTION_FORWARD, ACTION_JUMP, Binds } from "../../src/console/binds";
import { attachKeyboard, type KeyboardWindow, KeyRouter } from "../../src/input/keyboard";
import { ActionState } from "../../src/input/sampler";

/** A window stand-in: EventTargets plus a settable visibilityState. */
function fakeWindow() {
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  const win = Object.assign(new EventTarget(), { document: doc });
  return { win, doc };
}

interface KeyInit {
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly repeat?: boolean;
}

function key(target: EventTarget, type: "keydown" | "keyup", code: string, init: KeyInit = {}) {
  const e = Object.assign(new Event(type, { cancelable: true }), {
    code,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
    repeat: init.repeat ?? false,
  });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

function rig() {
  const { win, doc } = fakeWindow();
  const actions = new ActionState();
  const binds = new Binds();
  const ran: string[] = [];
  const router = new KeyRouter(binds, actions, (c) => ran.push(c));
  const state = { open: false, closed: 0 };
  const detach = attachKeyboard(win as unknown as KeyboardWindow, router, {
    consoleOpen: () => state.open,
    closeConsole: () => {
      state.open = false;
      state.closed++;
    },
  });
  return { win, doc, actions, binds, ran, router, state, detach };
}

describe("attachKeyboard (docs/06 §6)", () => {
  it("keeps bound keys from the browser and leaves the rest alone", () => {
    const r = rig();
    expect(key(r.win, "keydown", "Space")).toBe(true);
    expect(r.actions.held[ACTION_JUMP]).toBe(1);
    expect(key(r.win, "keyup", "Space")).toBe(true);
    expect(key(r.win, "keydown", "KeyQ")).toBe(false);
    expect(key(r.win, "keyup", "KeyQ")).toBe(false);
  });

  it("leaves Ctrl, Alt and Meta presses to the browser but still routes their releases", () => {
    const r = rig();
    expect(key(r.win, "keydown", "KeyW", { ctrlKey: true })).toBe(false);
    expect(key(r.win, "keydown", "KeyW", { altKey: true })).toBe(false);
    expect(key(r.win, "keydown", "KeyW", { metaKey: true })).toBe(false);
    expect(r.actions.held[ACTION_FORWARD]).toBe(0);
    key(r.win, "keydown", "KeyW");
    expect(key(r.win, "keyup", "KeyW", { ctrlKey: true })).toBe(true);
    expect(r.actions.held[ACTION_FORWARD]).toBe(0);
  });

  it("sends nothing to the router while the console is open, but still routes releases", () => {
    const r = rig();
    key(r.win, "keydown", "KeyW");
    r.state.open = true;
    expect(key(r.win, "keydown", "KeyD")).toBe(false);
    expect(r.router.heldCount).toBe(1);
    // The release still routes (the page does not keep it while the console is open).
    expect(key(r.win, "keyup", "KeyW")).toBe(false);
    expect(r.router.heldCount).toBe(0);
  });

  it("closes the console from the page when its input lost focus: Escape or the toggle key", () => {
    const r = rig();
    for (const code of ["Escape", "Backquote"]) {
      r.state.open = true;
      expect(key(r.win, "keydown", code, { repeat: true })).toBe(false);
      expect(r.state.open).toBe(true);
      expect(key(r.win, "keydown", code)).toBe(true);
      expect(r.state.open).toBe(false);
    }
    expect(r.state.closed).toBe(2);
    // Closing does not run the bind as well.
    expect(r.ran).toEqual([]);
  });

  it("never reruns the console toggle from an auto-repeat", () => {
    const r = rig();
    key(r.win, "keydown", "Backquote");
    expect(r.ran).toEqual(["toggleconsole"]);
    // The console opening released every key: the router forgot Backquote.
    r.router.releaseAll();
    for (let i = 0; i < 6; i++) key(r.win, "keydown", "Backquote", { repeat: true });
    expect(r.ran).toEqual(["toggleconsole"]);
  });

  it("releases every key when the tab goes hidden or the window loses focus", () => {
    const r = rig();
    key(r.win, "keydown", "KeyW");
    key(r.win, "keydown", "Space");
    r.doc.dispatchEvent(new Event("visibilitychange"));
    expect(r.router.heldCount).toBe(2);
    r.doc.visibilityState = "hidden";
    r.doc.dispatchEvent(new Event("visibilitychange"));
    expect(r.router.heldCount).toBe(0);
    key(r.win, "keydown", "KeyW");
    r.win.dispatchEvent(new Event("blur"));
    expect(r.router.heldCount).toBe(0);
    expect(r.actions.held[ACTION_FORWARD]).toBe(0);
  });

  it("detaches", () => {
    const r = rig();
    r.detach();
    expect(key(r.win, "keydown", "KeyW")).toBe(false);
    expect(r.router.heldCount).toBe(0);
  });
});
