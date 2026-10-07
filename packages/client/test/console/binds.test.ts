import { describe, expect, it } from "vitest";
import {
  ACTION_ATTACK,
  ACTION_FORWARD,
  ACTION_JUMP,
  ACTIONS,
  actionOf,
  Binds,
  DEFAULT_BINDS,
  isKeyCode,
  isModifierCode,
  isToggleConsole,
} from "../../src/console/binds";

describe("binds (M2 design §2)", () => {
  it("default to WASD, Space, C, X, ShiftLeft, Mouse0 and Backquote, with no Ctrl binds", () => {
    const b = new Binds();
    expect(Object.fromEntries(b.list())).toEqual({
      Backquote: "toggleconsole",
      KeyA: "+moveleft",
      KeyC: "+crouch",
      KeyD: "+moveright",
      KeyS: "+back",
      KeyW: "+forward",
      KeyX: "+walk",
      Mouse0: "+attack",
      ShiftLeft: "+sprint",
      Space: "+jump",
    });
    expect(DEFAULT_BINDS.some(([code]) => /control|meta/i.test(code))).toBe(false);
    expect(b.isDefault()).toBe(true);
  });

  it("map +actions to indices, case-insensitively, and nothing else", () => {
    expect(actionOf("+forward")).toBe(ACTION_FORWARD);
    expect(actionOf("+JUMP")).toBe(ACTION_JUMP);
    expect(actionOf("+attack")).toBe(ACTION_ATTACK);
    expect(actionOf("forward")).toBe(-1);
    expect(actionOf("+fly")).toBe(-1);
    expect(actionOf("")).toBe(-1);
    expect(ACTIONS.map((a) => actionOf(`+${a}`))).toEqual(ACTIONS.map((_, i) => i));
  });

  it("look codes up ignoring case and keep the first spelling", () => {
    const b = new Binds();
    expect(b.commandFor("keyw")).toBe("+forward");
    expect(b.bind("keyw", "+back")).toBe(true);
    expect(b.list().find(([c]) => c === "KeyW")).toEqual(["KeyW", "+back"]);
    expect(b.isDefault()).toBe(false);
  });

  it("refuse codes that are not codes and empty commands; count changes", () => {
    const b = new Binds();
    const v = b.version;
    expect(b.bind("Key W", "+jump")).toBe(false);
    expect(b.bind("1abc", "+jump")).toBe(false);
    expect(b.bind("KeyQ", "  ")).toBe(false);
    expect(b.version).toBe(v);
    expect(b.bind("KeyW", "+forward")).toBe(true);
    expect(b.version).toBe(v);
    expect(b.bind("KeyQ", "+jump")).toBe(true);
    expect(b.unbind("KEYQ")).toBe(true);
    expect(b.unbind("KeyQ")).toBe(false);
    expect(b.version).toBe(v + 2);
    expect(["KeyW", "Digit1", "ArrowUp", "F5", "Mouse0"].every(isKeyCode)).toBe(true);
  });

  it("refuse modifier keys: the page drops every key pressed with Ctrl, Alt or Meta held", () => {
    const b = new Binds();
    for (const code of [
      "ControlLeft",
      "controlright",
      "AltLeft",
      "AltRight",
      "MetaLeft",
      "OSRight",
    ]) {
      expect(b.refusal(code, "+crouch")).toMatch(/cannot be bound/);
      expect(b.bind(code, "+crouch")).toBe(false);
    }
    expect(b.refusal("ShiftRight", "+crouch")).toBeNull();
    expect(isModifierCode("ShiftLeft")).toBe(false);
  });

  it("keep a key on toggleconsole: the last one cannot be unbound or rebound", () => {
    const b = new Binds();
    expect(b.isLastConsoleKey("Backquote")).toBe(true);
    expect(b.unbind("Backquote")).toBe(false);
    expect(b.refusal("backquote", "+jump")).toMatch(/last key bound to toggleconsole/);
    expect(b.bind("Backquote", "+jump")).toBe(false);
    expect(b.bind("Backquote", "TOGGLECONSOLE")).toBe(true);
    expect(b.commandFor("Backquote")).toBe("TOGGLECONSOLE");
    expect(b.bind("F1", "toggleconsole")).toBe(true);
    expect(b.unbind("Backquote")).toBe(true);
    expect(b.isLastConsoleKey("F1")).toBe(true);
    expect(isToggleConsole(" ToggleConsole ")).toBe(true);
    expect(isToggleConsole("toggleconsolex")).toBe(false);
    expect(isToggleConsole(undefined)).toBe(false);
  });

  it("replace everything from stored entries only when all are good and one opens the console", () => {
    const b = new Binds();
    const v = b.version;
    expect(
      b.replaceAll([
        ["KeyE", "+forward"],
        ["bad code", "+jump"],
        ["Backquote", "toggleconsole"],
      ]),
    ).toMatch(/not a key code/);
    expect(
      b.replaceAll([
        ["KeyR", ""],
        ["Backquote", "toggleconsole"],
      ]),
    ).toMatch(/empty/);
    expect(
      b.replaceAll([
        ["ControlLeft", "+crouch"],
        ["Backquote", "toggleconsole"],
      ]),
    ).toMatch(/cannot be bound/);
    expect(b.replaceAll([["KeyE", "+forward"]])).toBe("no key toggles the console");
    expect(b.isDefault()).toBe(true);
    expect(b.version).toBe(v);
    expect(
      b.replaceAll([
        ["KeyE", " +forward "],
        ["Backquote", "toggleconsole"],
      ]),
    ).toBeNull();
    expect(b.list()).toEqual([
      ["Backquote", "toggleconsole"],
      ["KeyE", "+forward"],
    ]);
    expect(b.version).toBe(v + 1);
  });
});
