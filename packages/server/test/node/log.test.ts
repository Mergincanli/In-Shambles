import { CvarRegistry, registerPmoveCvars } from "@game/shared";
import { describe, expect, it } from "vitest";
import { Match } from "../../src/match/match";
import { runConsoleLine } from "../../src/node/console";
import { createJsonLog, matchLog } from "../../src/node/log";
import { loadMap, TEST_BUILD } from "../match/fixtures";

const clock = () => new Date(Date.UTC(2026, 9, 7, 12, 0, 0, 5));

describe("JSON-lines log", () => {
  it("writes one object per line: time, level, event, fields", () => {
    const lines: string[] = [];
    const log = createJsonLog((l) => lines.push(l), clock);
    log("info", "listening", { port: 28700, matches: [{ name: "main" }] });
    log("warn", "tick_drop");
    expect(lines).toEqual([
      '{"t":"2026-10-07T12:00:00.005Z","lvl":"info","ev":"listening","port":28700,"matches":[{"name":"main"}]}',
      '{"t":"2026-10-07T12:00:00.005Z","lvl":"warn","ev":"tick_drop"}',
    ]);
  });

  it("tags a match's text lines with its name", () => {
    const lines: string[] = [];
    matchLog(
      createJsonLog((l) => lines.push(l), clock),
      "main",
    )("error", 'say "hi"\n');
    expect(JSON.parse(lines[0] as string)).toEqual({
      t: "2026-10-07T12:00:00.005Z",
      lvl: "error",
      ev: "log",
      match: "main",
      msg: 'say "hi"\n',
    });
  });
});

describe("admin console line", () => {
  it("runs server commands on the match as an admin and logs the reply", () => {
    const lines: { lvl: string; ev: string; text?: string }[] = [];
    const log = createJsonLog((l) => lines.push(JSON.parse(l)), clock);
    const cvars = new CvarRegistry();
    registerPmoveCvars(cvars);
    const match = new Match({ cmap: loadMap("movement_lab"), cvars, buildHash: TEST_BUILD });
    runConsoleLine("set pm_gravity 400", "main", match, log);
    runConsoleLine("   ", "main", match, log);
    runConsoleLine("bogus", "main", match, log);
    expect(cvars.get("pm_gravity")).toBe(400);
    expect(lines.map((l) => [l.lvl, l.ev, l.text])).toEqual([
      ["info", "console", "pm_gravity = 400"],
      ["error", "console", "unknown server command bogus"],
    ]);
  });
});
