import {
  type CvarRegistry,
  findNetProfile,
  NET_PROFILE_LAN,
  type NetProfile,
  CvarRegistry as Registry,
  registerPmoveCvars,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { Binds } from "../../src/console/binds";
import { registerClientCvars } from "../../src/console/clientCvars";
import { CONSOLE_COMMANDS, type ConsoleHost, runConsoleCommand } from "../../src/console/commands";

function host(connected = true, withNet = true) {
  const cvars: CvarRegistry = new Registry();
  registerPmoveCvars(cvars);
  registerClientCvars(cvars);
  const out: string[] = [];
  const sent: string[] = [];
  let profile: NetProfile = NET_PROFILE_LAN;
  let toggled = 0;
  let cleared = 0;
  const h: ConsoleHost = {
    cvars,
    binds: new Binds(),
    print: (t) => out.push(t),
    clear: () => cleared++,
    toggleConsole: () => toggled++,
    sendServer: (t) => {
      if (!connected) return false;
      sent.push(t);
      return true;
    },
    net: withNet
      ? {
          profile: () => profile,
          setProfile: (p) => {
            profile = p;
          },
        }
      : null,
  };
  const run = (line: string) => {
    out.length = 0;
    runConsoleCommand(line, h);
    return [...out];
  };
  return {
    h,
    run,
    sent,
    cvars,
    profile: () => profile,
    toggled: () => toggled,
    cleared: () => cleared,
  };
}

describe("console commands (M2 design §2)", () => {
  it("set a client cvar locally, with clamping and type errors", () => {
    const t = host();
    expect(t.run("set sensitivity 2.5")).toEqual(["sensitivity = 2.5"]);
    expect(t.cvars.get("sensitivity")).toBe(2.5);
    expect(t.run("set cl_fov 500")).toEqual(["cl_fov = 160 (clamped)"]);
    expect(t.run("set cl_netgraph maybe")).toEqual(['cl_netgraph: "maybe" is not a valid value']);
    expect(t.run("set nope 1")).toEqual(["unknown cvar nope"]);
    expect(t.run("set sensitivity")).toEqual(["usage: set <cvar> <value>"]);
    expect(t.sent).toEqual([]);
  });

  it("send set, reset and toggle on a replicated cvar to the server, never applying them", () => {
    const t = host();
    expect(t.run("set PM_GRAVITY 400")).toEqual([]);
    expect(t.run("reset pm_gravity")).toEqual([]);
    expect(t.run("toggle pm_autoHop")).toEqual([]);
    expect(t.run('set pm_gravity "  400 "')).toEqual([]);
    expect(t.sent).toEqual([
      "set pm_gravity 400",
      "reset pm_gravity",
      "toggle pm_autoHop",
      'set pm_gravity "  400 "',
    ]);
    expect(t.cvars.get("pm_gravity")).toBe(800);
  });

  it("say so when a replicated change cannot be sent", () => {
    const t = host(false);
    expect(t.run("set pm_gravity 400")).toEqual(["pm_gravity is a server cvar: not connected"]);
  });

  it("toggle bools and numbers, reset to defaults", () => {
    const t = host();
    expect(t.run("toggle cl_netgraph")).toEqual(["cl_netgraph = true"]);
    expect(t.run("toggle cl_netgraph")).toEqual(["cl_netgraph = false"]);
    expect(t.run("set sensitivity 0")).toEqual(["sensitivity = 0"]);
    expect(t.run("toggle sensitivity")).toEqual(["sensitivity = 1"]);
    expect(t.run("reset sensitivity")).toEqual(["sensitivity = 5"]);
  });

  it("list cvars by prefix with their flags", () => {
    const t = host();
    const lines = t.run("cvarlist r_debug");
    expect(lines).toEqual([
      "A---- r_debugGround false",
      "A---- r_debugHull false",
      "A---- r_debugTraces false",
      "3 cvars starting with r_debug",
    ]);
    expect(t.run("cvarlist pm_gravity")[0]).toBe("-R--- pm_gravity 800");
    expect(t.run("cvarlist").at(-1)).toMatch(/^\d+ cvars$/);
  });

  it("show a cvar by its bare name, mirror values included", () => {
    const t = host();
    t.cvars.setReplicated("pm_gravity", 400);
    expect(t.run("pm_gravity")[0]).toMatch(/^pm_gravity = 400 \(default 800, replicated/);
    expect(t.run("sensitivity")[0]).toMatch(/^sensitivity = 5 \(default 5\): Mouse/);
    expect(t.run("frobnicate")).toEqual(["unknown command frobnicate (try help)"]);
  });

  it("bind, show and unbind keys", () => {
    const t = host();
    expect(t.run("bind KeyQ +jump")).toEqual(["KeyQ = +jump"]);
    expect(t.h.binds.commandFor("KeyQ")).toBe("+jump");
    expect(t.run("bind keyq")).toEqual(["keyq = +jump"]);
    expect(t.run("bind KeyE set cl_netgraph 1")).toEqual(["KeyE = set cl_netgraph 1"]);
    expect(t.run("bind KeyR +fly")).toEqual(["unknown action +fly"]);
    expect(t.run("bind 9x +jump")[0]).toMatch(/not a key code/);
    expect(t.run("bind ControlLeft +crouch")).toEqual([
      "bind: ControlLeft cannot be bound: the browser keeps Ctrl, Alt and Meta combinations",
    ]);
    expect(t.h.binds.commandFor("ControlLeft")).toBeUndefined();
    expect(t.run('bind KeyQ ""')).toEqual(["bind: the command is empty (unbind removes a bind)"]);
    expect(t.run('bind KeyQ "   "')).toEqual([
      "bind: the command is empty (unbind removes a bind)",
    ]);
    expect(t.h.binds.commandFor("KeyQ")).toBe("+jump");
    expect(t.run("unbind KeyQ")).toEqual(["KeyQ unbound"]);
    expect(t.run("unbind KeyQ")).toEqual(["KeyQ is not bound"]);
    expect(t.run("bind")).toEqual(["usage: bind <code> [command]"]);
  });

  it("never leave the console without a key", () => {
    const t = host();
    const last = "Backquote is the last key bound to toggleconsole; bind another key to it first";
    expect(t.run("unbind Backquote")).toEqual([last]);
    expect(t.run("bind Backquote +jump")).toEqual([`bind: ${last}`]);
    expect(t.h.binds.commandFor("Backquote")).toBe("toggleconsole");
    expect(t.run("bind F1 toggleconsole")).toEqual(["F1 = toggleconsole"]);
    expect(t.run("unbind Backquote")).toEqual(["Backquote unbound"]);
  });

  it("switch the simulated network profile", () => {
    const t = host();
    expect(t.run("net_profile")[1]).toMatch(/^profiles: lan, wan-50, wan-100-loss1/);
    expect(t.run("net_profile wan-150-loss2")).toEqual([
      "net_profile wan-150-loss2: 75 ms ±15 each way, loss 2%, duplicate 0%, reorder 0.5%",
    ]);
    expect(t.profile()).toBe(findNetProfile("wan-150-loss2"));
    expect(t.run("net_profile moon")[0]).toMatch(/^unknown profile moon/);
    expect(host(true, false).run("net_profile lan")[0]).toMatch(/no network simulator/);
  });

  it("clear, toggle the console, help, quotes", () => {
    const t = host();
    t.run("clear");
    t.run("toggleconsole");
    expect([t.cleared(), t.toggled()]).toEqual([1, 1]);
    expect(t.run("help")).toHaveLength(CONSOLE_COMMANDS.length);
    expect(t.run('set sensitivity "3')).toEqual(["unterminated quote"]);
    expect(t.run("   ")).toEqual([]);
  });
});
