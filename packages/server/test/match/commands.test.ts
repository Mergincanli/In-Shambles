import {
  CvarFlag,
  CvarRegistry,
  PRINT_ERROR,
  PRINT_INFO,
  registerPmoveCvars,
  TEXT_MAX,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  type MatchAdmin,
  parseRcon,
  runServerCommand,
  tokenizeCommand,
} from "../../src/match/commands";

function registry(): CvarRegistry {
  const reg = new CvarRegistry();
  registerPmoveCvars(reg);
  reg.register({
    name: "sv_flag",
    type: "bool",
    default: false,
    description: "test",
    flags: CvarFlag.REPLICATED,
  });
  reg.register({ name: "sv_local", type: "int", default: 3, description: "test" });
  reg.register({
    name: "sv_motd",
    type: "string",
    default: "hi",
    description: "test",
    flags: CvarFlag.REPLICATED,
  });
  return reg;
}

describe("tokenizeCommand", () => {
  it.each([
    ["set pm_gravity 400", ["set", "pm_gravity", "400"]],
    ["  set\tpm_gravity   400  ", ["set", "pm_gravity", "400"]],
    ['set sv_motd "two words"', ["set", "sv_motd", "two words"]],
    ['set sv_motd ""', ["set", "sv_motd", ""]],
    ['a"b"c', ["a", "b", "c"]],
    ["", []],
  ])("%j", (text, tokens) => {
    expect(tokenizeCommand(text)).toEqual(tokens);
  });

  it("refuses an unterminated quote", () => {
    expect(tokenizeCommand('set sv_motd "open')).toBeNull();
  });
});

describe("runServerCommand", () => {
  it("set changes a replicated cvar for an admin and echoes the stored value", () => {
    const reg = registry();
    const r = runServerCommand("set pm_gravity 400", reg, true);
    expect(r).toEqual({ level: PRINT_INFO, text: "pm_gravity = 400", resendCvars: false });
    expect(reg.get("pm_gravity")).toBe(400);
  });

  it("matches cvar names in any case and reports clamping", () => {
    const reg = registry();
    const r = runServerCommand("SET PM_GRAVITY 1e9", reg, true);
    expect(r.level).toBe(PRINT_INFO);
    expect(r.text).toMatch(/^pm_gravity = \d+ \(clamped\)$/);
  });

  it("refuses a non-admin, changing nothing", () => {
    const reg = registry();
    const version = reg.version;
    for (const text of ["set pm_gravity 400", "reset pm_gravity", "toggle sv_flag"]) {
      const r = runServerCommand(text, reg, false);
      expect(r.level).toBe(PRINT_ERROR);
      expect(r.text).toContain("admin");
    }
    expect(reg.version).toBe(version);
  });

  it("refuses unknown and non-replicated cvars and bad values", () => {
    const reg = registry();
    expect(runServerCommand("set nope 1", reg, true)).toMatchObject({ level: PRINT_ERROR });
    expect(runServerCommand("set sv_local 4", reg, true).text).toBe(
      "sv_local is not a replicated cvar",
    );
    expect(runServerCommand("set pm_gravity fast", reg, true)).toMatchObject({
      level: PRINT_ERROR,
    });
    expect(reg.get("sv_local")).toBe(3);
    expect(reg.get("pm_gravity")).toBe(800);
  });

  it("reset and toggle", () => {
    const reg = registry();
    runServerCommand("set pm_gravity 400", reg, true);
    expect(runServerCommand("reset pm_gravity", reg, true).text).toBe("pm_gravity = 800");
    expect(runServerCommand("toggle sv_flag", reg, true).text).toBe("sv_flag = true");
    expect(runServerCommand("toggle sv_flag", reg, true).text).toBe("sv_flag = false");
    expect(runServerCommand("toggle pm_autoHop", reg, true).text).toBe("pm_autoHop = 1");
    expect(runServerCommand("toggle pm_autoHop", reg, true).text).toBe("pm_autoHop = 0");
    expect(runServerCommand("toggle sv_motd", reg, true).level).toBe(PRINT_ERROR);
  });

  it("reports latching (no replicated cvar can be CHEAT, D-042)", () => {
    const reg = registry();
    reg.register({
      name: "sv_latchy",
      type: "int",
      default: 0,
      description: "test",
      flags: CvarFlag.REPLICATED | CvarFlag.LATCH,
    });
    expect(runServerCommand("set sv_latchy 2", reg, true).text).toBe(
      "sv_latchy = 2 (latched: applies on map restart)",
    );
    expect(reg.get("sv_latchy")).toBe(0);
  });

  it("set joins the remaining tokens for a string value", () => {
    const reg = registry();
    runServerCommand("set sv_motd hello  there", reg, true);
    expect(reg.get("sv_motd")).toBe("hello there");
  });

  it("cvars asks for a resend and is open to every client", () => {
    expect(runServerCommand("cvars", registry(), false)).toEqual({
      level: PRINT_INFO,
      text: "",
      resendCvars: true,
    });
  });

  it.each([
    ["", "empty command"],
    ["set", "usage: set <cvar> <value>"],
    ["set pm_gravity", "usage: set <cvar> <value>"],
    ["reset", "usage: reset <cvar>"],
    ['set sv_motd "x', "unterminated quote"],
    ["kill", "unknown server command kill"],
  ])("%j → %j", (text, reply) => {
    expect(runServerCommand(text, registry(), true)).toEqual({
      level: PRINT_ERROR,
      text: reply,
      resendCvars: false,
    });
  });

  it("keeps replies within PRINT's text limit", () => {
    const r = runServerCommand(`${"x".repeat(TEXT_MAX)} y`, registry(), true);
    expect(r.text.length).toBe(TEXT_MAX);
  });
});

describe("parseRcon (D-042)", () => {
  it.each([
    ["rcon pw status", { password: "pw", command: "status" }],
    [
      '  RCON "two words"  set sv_motd "a  b" ',
      { password: "two words", command: 'set sv_motd "a  b"' },
    ],
    ['rcon "" status', { password: "", command: "status" }],
    ["rcon pw", { password: "pw", command: "" }],
    ["rcon", { password: "", command: "" }],
    ['rcon "open', { password: "", command: "" }],
  ])("%j", (text, out) => {
    expect(parseRcon(text)).toEqual(out);
  });

  it("is null for any other line", () => {
    for (const text of ["", "status", "rconx pw status", "set rcon 1", '"rcon'])
      expect(parseRcon(text), text).toBeNull();
  });
});

describe("admin commands on a match (D-042)", () => {
  function admin() {
    const calls: string[] = [];
    const m: MatchAdmin = {
      status: () => "map, 1 of 32 players\n#0 active",
      kickClient: (id, reason) => {
        calls.push(`kick ${id} ${reason}`);
        return id === 0;
      },
      metricsReset: () => {
        calls.push("reset");
        return "metrics reset: match main";
      },
      record: (name) => {
        calls.push(`record ${name}`);
        return { ok: name !== "bad", text: name === "bad" ? "record: no" : `recording ${name}` };
      },
      stopRecord: () => {
        calls.push("stoprecord");
        return { ok: true, text: "stopped" };
      },
    };
    return { m, calls };
  }

  it("status, kick and metrics reset need the admin flag and act on the match", () => {
    const { m, calls } = admin();
    const reg = registry();
    for (const text of ["status", "kick 0", "metrics reset"]) {
      const r = runServerCommand(text, reg, false, m);
      expect(r.level, text).toBe(PRINT_ERROR);
      expect(r.text, text).toMatch(/only an admin .*rcon/);
    }
    expect(calls).toEqual([]);
    expect(runServerCommand("status", reg, true, m)).toEqual({
      level: PRINT_INFO,
      text: "map, 1 of 32 players\n#0 active",
      resendCvars: false,
    });
    expect(runServerCommand("kick 0 too  loud", reg, true, m).text).toBe(
      "client 0 kicked: too loud",
    );
    expect(runServerCommand("kick 7", reg, true, m).text).toBe("kick: no client 7");
    expect(runServerCommand("METRICS RESET", reg, true, m).text).toBe("metrics reset: match main");
    expect(calls).toEqual(["kick 0 too loud", "kick 7 kicked by an admin", "reset"]);
  });

  it("record and stoprecord need the admin flag and pass the name as typed (D-044)", () => {
    const { m, calls } = admin();
    const reg = registry();
    for (const text of ["record", "record x", "stoprecord"]) {
      const r = runServerCommand(text, reg, false, m);
      expect(r.level, text).toBe(PRINT_ERROR);
      expect(r.text, text).toMatch(/only an admin may record demos \(use rcon/);
    }
    expect(calls).toEqual([]);
    expect(runServerCommand("record", reg, true, m)).toEqual({
      level: PRINT_INFO,
      text: "recording null",
      resendCvars: false,
    });
    expect(runServerCommand('record ""', reg, true, m).text).toBe("recording ");
    expect(runServerCommand("RECORD bad", reg, true, m)).toMatchObject({
      level: PRINT_ERROR,
      text: "record: no",
    });
    expect(runServerCommand("stoprecord", reg, true, m).text).toBe("stopped");
    expect(calls).toEqual(["record null", "record ", "record bad", "stoprecord"]);
  });

  it.each([
    ["kick", "usage: kick <client id> [reason]"],
    ["kick -1", "usage: kick <client id> [reason]"],
    ["kick 100", "usage: kick <client id> [reason]"],
    ["metrics", "usage: metrics reset"],
    ["metrics reset now", "usage: metrics reset"],
    ["status", "status: there is no match here"],
    ["record a b", "usage: record [name]"],
    ["stoprecord now", "usage: stoprecord"],
    ["record", "record: there is no match here"],
    ["rcon pw status", "rcon: this console already runs as admin"],
  ])("%j → %j", (text, reply) => {
    expect(runServerCommand(text, registry(), true).text).toBe(reply);
  });
});
