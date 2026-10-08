import {
  type CvarRegistry,
  findNetProfile,
  NET_PROFILE_LAN,
  type NetProfile,
  CvarRegistry as Registry,
  registerPmoveCvars,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { connectSearch } from "../../src/app/params";
import { Binds } from "../../src/console/binds";
import { registerClientCvars } from "../../src/console/clientCvars";
import { CONSOLE_COMMANDS, type ConsoleHost, runConsoleCommand } from "../../src/console/commands";
import { CorrectionLog } from "../../src/net/predictor";

function host(connected = true, withNet = true, corrections: CorrectionLog | null = null) {
  const cvars: CvarRegistry = new Registry();
  registerPmoveCvars(cvars);
  registerClientCvars(cvars);
  const out: string[] = [];
  const sent: string[] = [];
  let profile: NetProfile = NET_PROFILE_LAN;
  let toggled = 0;
  let cleared = 0;
  const connects: string[] = [];
  let disconnects = 0;
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
    corrections,
    server: "the local server (Worker)",
    connected: () => connected,
    connect: (address) => {
      // boot.ts's own step: the page query to reload with (here recorded instead).
      const next = connectSearch(address, "?autotest=1&connect=ws://old:1/");
      if (!next.ok) return next.error;
      connects.push(next.search);
      return null;
    },
    disconnect: () => {
      if (!connected) return false;
      connected = false;
      disconnects++;
      return true;
    },
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
    connects,
    disconnects: () => disconnects,
  };
}

describe("console commands (M2 design §2)", () => {
  it("net_corrections prints the correction log with what differed", () => {
    expect(host().run("net_corrections")).toEqual(["no prediction to report on"]);
    const log = new CorrectionLog();
    const t = host(true, true, log);
    expect(t.run("net_corrections")).toEqual(["0 corrections; the newest 0:"]);
    const r = log.push();
    r.tick = 300;
    r.latestTick = 309;
    r.distance = 1.23456;
    r.predicted.origin[0] = 10;
    r.server.origin[0] = 12;
    r.predicted.stamina = r.server.stamina;
    expect(t.run("net_corrections")).toEqual([
      "1 corrections; the newest 1:",
      "tick 300 (to 309) 1.23 u: origin[0]: 10 → 12",
    ]);
  });

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

  it("connect shows the server or starts a session on another; disconnect leaves (D-031)", () => {
    const t = host();
    expect(t.run("connect")).toEqual(["playing on the local server (Worker)"]);
    expect(t.run("connect ws://127.0.0.1:28700")).toEqual([]);
    expect(t.run("connect localhost:28700")).toEqual([]);
    // The page reloads with only `connect` replaced (`URLSearchParams` encodes the URL).
    expect(t.connects).toEqual([
      "autotest=1&connect=ws%3A%2F%2F127.0.0.1%3A28700%2F",
      "autotest=1&connect=ws%3A%2F%2Flocalhost%3A28700%2F",
    ]);
    expect(new URLSearchParams(t.connects[0]).get("connect")).toBe("ws://127.0.0.1:28700/");
    expect(t.run("connect wss://example.org")[0]).toMatch(/^connect: wss:\/\/ comes with/);
    expect(t.run("connect http://example.org")[0]).toMatch(/starts with ws:\/\//);
    expect(t.run("connect ws://h:1/?x=1")[0]).toMatch(/no query string/);
    expect(t.connects).toHaveLength(2);
    expect(t.run("disconnect")).toEqual([]);
    expect(t.disconnects()).toBe(1);
    // Once the session closed, `connect` alone no longer claims it plays there.
    expect(t.run("connect")).toEqual(["not connected (last: the local server (Worker))"]);
    expect(t.run("disconnect")).toEqual(["disconnect: not connected"]);
    expect(t.disconnects()).toBe(1);
    expect(host(false).run("disconnect")).toEqual(["disconnect: not connected"]);
  });

  it("clear, toggle the console, help, quotes", () => {
    const t = host();
    t.run("clear");
    t.run("toggleconsole");
    expect([t.cleared(), t.toggled()]).toEqual([1, 1]);
    expect(t.run("help")).toHaveLength(CONSOLE_COMMANDS.length);
    // Verbs match ignoring case, like key codes.
    expect(t.run("SET sensitivity 3")).toEqual(["sensitivity = 3"]);
    expect(t.run("Bind KeyQ +jump")).toEqual(["KeyQ = +jump"]);
    expect(t.run("bind KeyQ")).toEqual(["KeyQ = +jump"]);
    expect(t.run('set sensitivity "3')).toEqual(["unterminated quote"]);
    expect(t.run("   ")).toEqual([]);
  });
});
