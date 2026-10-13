import {
  CvarRegistry,
  createLoopbackPair,
  registerPmoveCvars,
  registerServerReplicatedCvars,
} from "@game/shared";
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
  it("runs server commands on the match as an admin and logs the reply (D-042: status, kick)", () => {
    const lines: { lvl: string; ev: string; text?: string }[] = [];
    const log = createJsonLog((l) => lines.push(JSON.parse(l)), clock);
    const cvars = new CvarRegistry();
    registerPmoveCvars(cvars);
    registerServerReplicatedCvars(cvars);
    const match = new Match({
      cmap: loadMap("movement_lab"),
      cvars,
      buildHash: TEST_BUILD,
      primer: false,
    });
    match.connect(createLoopbackPair()[1]);
    const host = { match: () => ({ name: "main", match }) };
    runConsoleLine("set pm_gravity 400", host, log);
    runConsoleLine("   ", host, log);
    runConsoleLine("bogus", host, log);
    // The console is admin of the match itself too (D-042): status and kick.
    runConsoleLine("status", host, log);
    runConsoleLine("kick 0", host, log);
    // Without a process (a match's own console), the process commands are refused.
    runConsoleLine("matches", host, log);
    runConsoleLine("quit", host, log);
    expect(cvars.get("pm_gravity")).toBe(400);
    expect(lines.map((l) => [l.lvl, l.ev, l.text])).toEqual([
      ["info", "console", "pm_gravity = 400"],
      ["error", "console", "unknown server command bogus"],
      ["info", "console", "movement_lab, tick 0, 1 of 32 players\n#0 connecting strikes 0 build -"],
      ["info", "console", "client 0 kicked: kicked by an admin"],
      ["error", "console", "matches: this console has no process commands"],
      ["error", "console", "quit: this console has no process commands"],
    ]);
  });
});
