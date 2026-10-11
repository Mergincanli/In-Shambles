import {
  type CvarRegistry,
  findNetProfile,
  NET_PROFILE_LAN,
  type NetProfile,
  CvarRegistry as Registry,
  registerPmoveCvars,
  registerServerReplicatedCvars,
  TEXT_MAX,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { connectSearch, demoSearch } from "../../src/app/params";
import { Binds } from "../../src/console/binds";
import { registerClientCvars } from "../../src/console/clientCvars";
import {
  CONSOLE_COMMANDS,
  type ConsoleHost,
  consoleEcho,
  type DemoFollow,
  runConsoleCommand,
} from "../../src/console/commands";
import { CorrectionLog } from "../../src/net/predictor";

function host(
  connected = true,
  withNet = true,
  corrections: CorrectionLog | null = null,
  demo: DemoFollow | null = null,
) {
  const cvars: CvarRegistry = new Registry();
  registerPmoveCvars(cvars);
  registerServerReplicatedCvars(cvars);
  registerClientCvars(cvars);
  const out: string[] = [];
  const sent: string[] = [];
  let profile: NetProfile = NET_PROFILE_LAN;
  let toggled = 0;
  let cleared = 0;
  const connects: string[] = [];
  const demos: string[] = [];
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
    demo,
    playDemo: (url) => {
      const next = demoSearch(url, "?autotest=1&connect=ws://old:1/");
      if (!next.ok) return next.error;
      demos.push(next.search);
      return null;
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
    demos,
    disconnects: () => disconnects,
  };
}

/** A demo's follow camera over a set of present ids, as DemoPlayer steps it. */
function follower(present: number[]): DemoFollow & { following: number } {
  const step = (from: number, dir: number) => {
    for (let k = 1; k <= 64; k++) {
      const s = ((((from < 0 ? (dir > 0 ? -1 : 0) : from) + dir * k) % 64) + 64) % 64;
      if (present.includes(s)) return s;
    }
    return -1;
  };
  const f = {
    following: present.length > 0 ? Math.min(...present) : -1,
    followNext: () => {
      f.following = step(f.following, 1);
      return f.following;
    },
    followPrev: () => {
      f.following = step(f.following, -1);
      return f.following;
    },
    follow: (id: number) => {
      if (!present.includes(id)) return false;
      f.following = id;
      return true;
    },
  };
  return f;
}

describe("demo console commands (D-044)", () => {
  it("say they are for demo playback outside it", () => {
    const t = host();
    for (const line of ["follownext", "followprev", "follow 2"]) {
      expect(t.run(line)).toEqual([`${line.split(" ")[0]}: only during demo playback`]);
    }
  });

  it("step through present players, wrapping, and jump to one that is present", () => {
    const demo = follower([1, 4, 9]);
    const t = host(false, false, null, demo);
    expect(demo.following).toBe(1);
    expect(t.run("follownext")).toEqual(["following #4"]);
    expect(t.run("follownext")).toEqual(["following #9"]);
    expect(t.run("follownext")).toEqual(["following #1"]);
    expect(t.run("followprev")).toEqual(["following #9"]);
    expect(t.run("follow 4")).toEqual(["following #4"]);
    expect(t.run("follow 5")).toEqual(["follow: player #5 is not in the demo now"]);
    expect(demo.following).toBe(4);
    expect(t.run("follow")).toEqual(["usage: follow <id>"]);
    expect(t.run("follow x")).toEqual(["usage: follow <id>"]);
    expect(host(false, false, null, follower([])).run("follownext")).toEqual([
      "follownext: nobody to follow",
    ]);
  });

  it("demo <url> reloads the page with ?demo= and without ?connect=", () => {
    const t = host();
    expect(t.run("demo")).toEqual(["usage: demo <url>"]);
    expect(t.run("demo /demos/a.demo")).toEqual([]);
    expect(t.demos).toEqual(["autotest=1&demo=%2Fdemos%2Fa.demo"]);
  });
});

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
      "A-C-- r_debugGround false",
      "A-C-- r_debugHull false",
      "A-C-- r_debugTraces false",
      "3 cvars starting with r_debug",
    ]);
    expect(t.run("cvarlist pm_gravity")[0]).toBe("-R--- pm_gravity 800");
    expect(t.run("cvarlist").at(-1)).toMatch(/^\d+ cvars$/);
  });

  it("refuse CHEAT cvars while the server's sv_cheats is 0, and allow them at 1 (D-042)", () => {
    const t = host();
    for (const name of ["cl_thirdPerson", "r_debugHull", "r_debugTraces", "r_debugGround"]) {
      expect(t.run(`set ${name} 1`)).toEqual([
        `${name} is cheat protected: the server's sv_cheats is 0`,
      ]);
      expect(t.run(`toggle ${name}`)[0]).toMatch(/cheat protected/);
      expect(t.cvars.get(name)).toBe(false);
    }
    // r_stats is no cheat: the renderer's own counters show nothing of the match.
    expect(t.run("set r_stats 1")).toEqual(["r_stats = true"]);
    // What ClientSim does with a block whose sv_cheats is 1, then 0.
    t.cvars.setAllowCheats(true);
    expect(t.run("set cl_thirdPerson 1")).toEqual(["cl_thirdPerson = true"]);
    t.cvars.setAllowCheats(false);
    expect(t.cvars.get("cl_thirdPerson")).toBe(false);
    // sv_cheats itself is the server's: a set goes there.
    expect(t.run("set sv_cheats 1")).toEqual([]);
    expect(t.sent).toEqual(["set sv_cheats 1"]);
  });

  it("rcon sends the command with the password; the password is never printed (D-042)", () => {
    const t = host();
    expect(t.run("rcon set pm_gravity 400")).toEqual(["rcon: set rcon_password first"]);
    expect(t.run("rcon")).toEqual(["usage: rcon <command…>"]);
    expect(t.run("set rcon_password two words")).toEqual(["rcon_password set"]);
    expect(t.run("rcon_password")[0]).toMatch(/^rcon_password = \(hidden\) \(default \): /);
    expect(t.run("cvarlist rcon")[0]).toBe("----- rcon_password (hidden)");
    expect(t.run('rcon  set sv_motd "a b"')).toEqual([]);
    expect(t.run("RCON status")).toEqual([]);
    expect(t.sent).toEqual(['rcon "two words" set sv_motd "a b"', 'rcon "two words" status']);
    for (const bad of ['a"b', "€uro", "tab\there"]) {
      t.cvars.set("rcon_password", bad);
      expect(t.run("rcon status"), bad).toEqual([
        "rcon: rcon_password must be printable ASCII without double quotes",
      ]);
    }
    const off = host(false);
    off.cvars.set("rcon_password", "pw");
    expect(off.run("rcon status")).toEqual(["rcon: not connected"]);
    // Open, but not welcomed yet (HELLO sent, no WELCOME): sendCommand refuses a line that fits.
    t.cvars.set("rcon_password", "pw");
    t.h.sendServer = () => false;
    expect(t.run("rcon status")).toEqual([
      "rcon: not connected yet (waiting for the server's WELCOME)",
    ]);
    // Connected, but the CMD does not encode (Connection.sendCommand returns false): the reason.
    expect(t.run("rcon say €uro")).toEqual([
      `rcon: the command does not fit one message (${TEXT_MAX} Latin-1 chars with the password)`,
    ]);
    t.cvars.set("rcon_password", "x".repeat(1100));
    expect(t.run("rcon status")).toEqual([
      `rcon: the command does not fit one message (${TEXT_MAX} Latin-1 chars with the password)`,
    ]);
  });

  it("echo a line that sets rcon_password hidden and keep it out of the history", () => {
    expect(consoleEcho("set rcon_password hunter2")).toEqual({
      echo: "set rcon_password (hidden)",
      history: null,
    });
    expect(consoleEcho('  SET RCON_PASSWORD "a b').history).toBeNull();
    expect(consoleEcho('  SET RCON_PASSWORD "a b').echo).not.toContain("a b");
    expect(consoleEcho("rcon_password hunter2")).toEqual({
      echo: "rcon_password (hidden)",
      history: null,
    });
    // Every spelling the tokenizer reads as setting it, quotes against the name included.
    for (const line of [
      '"set" rcon_password hunter2a',
      'set "rcon_password"hunter2b',
      'set rcon_password"hunter2c"',
      "set\tRCON_PASSWORD\thunter2d",
      'set rcon_password "hunter2 e"',
    ]) {
      const e = consoleEcho(line);
      expect(e.history, line).toBeNull();
      expect(e.echo, line).toMatch(/^set rcon_password \(hidden\)$/i);
      const t = host();
      expect(t.run(line), line).toEqual(["rcon_password set"]);
    }
    // A bind's command naming it: hidden here, and refused (binds are saved).
    const bind = 'bind KeyP "set rcon_password hunter2"';
    expect(consoleEcho(bind)).toEqual({ echo: "bind KeyP (hidden)", history: null });
    const t = host();
    expect(t.run(bind)).toEqual([
      "bind: a bind cannot hold rcon_password: binds are saved, the password never is",
    ]);
    expect(t.h.binds.commandFor("KeyP")).toBeUndefined();
    for (const line of [
      "rcon_password",
      "reset rcon_password",
      "cvarlist rcon_password",
      "rcon status",
      "set sensitivity 3",
    ]) {
      expect(consoleEcho(line)).toEqual({ echo: line, history: line });
    }
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
