import {
  CvarFlag,
  CvarRegistry,
  PRINT_ERROR,
  PRINT_INFO,
  registerPmoveCvars,
  TEXT_MAX,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { runServerCommand, tokenizeCommand } from "../../src/match/commands";

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

  it("reports cheat protection and latching", () => {
    const reg = registry();
    reg.register({
      name: "sv_cheaty",
      type: "int",
      default: 0,
      description: "test",
      flags: CvarFlag.REPLICATED | CvarFlag.CHEAT,
    });
    reg.register({
      name: "sv_latchy",
      type: "int",
      default: 0,
      description: "test",
      flags: CvarFlag.REPLICATED | CvarFlag.LATCH,
    });
    expect(runServerCommand("set sv_cheaty 1", reg, true)).toEqual({
      level: PRINT_ERROR,
      text: "sv_cheaty is cheat protected",
      resendCvars: false,
    });
    expect(reg.get("sv_cheaty")).toBe(0);
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
