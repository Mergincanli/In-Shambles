import { CvarRegistry, registerPmoveCvars } from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  applyAssignments,
  ConfigError,
  parseCommandLine,
  parseServerCfg,
  sendLimits,
} from "../../src/node/config";
import { registerServerCvars } from "../../src/node/serverCvars";

function registries() {
  const server = new CvarRegistry();
  registerServerCvars(server);
  const match = new CvarRegistry();
  registerPmoveCvars(match);
  return { server, match, both: [server, match] };
}

describe("parseServerCfg", () => {
  it("reads set lines, skips comments and blank lines, and groups quoted values", () => {
    const text = [
      "// comment",
      "# another",
      "",
      "set sv_port 1234",
      '  SET sv_host "127.0.0.1"  ',
      "set sv_map arena greybox",
    ].join("\r\n");
    expect(parseServerCfg(text, "server.cfg")).toEqual([
      { name: "sv_port", value: "1234", source: "server.cfg:4" },
      { name: "sv_host", value: "127.0.0.1", source: "server.cfg:5" },
      { name: "sv_map", value: "arena greybox", source: "server.cfg:6" },
    ]);
  });

  it.each([
    ["bind x y", "a.cfg:1: unknown command bind"],
    ["set sv_port", "a.cfg:1: usage: set <cvar> <value>"],
    ['set sv_host "open', "a.cfg:1: unterminated quote"],
    ["set sv_port 1 // default", "a.cfg:1: a comment must be on a line of its own"],
    ["set sv_host 0.0.0.0 # any", "a.cfg:1: a comment must be on a line of its own"],
  ])("refuses %j", (line, message) => {
    expect(() => parseServerCfg(line, "a.cfg")).toThrow(new ConfigError(message));
  });

  it("parses the shipped server.cfg into the documented defaults", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(new URL("../../server.cfg", import.meta.url), "utf8");
    const { server, both } = registries();
    const defaults = server.list().map((i) => [i.def.name, i.value]);
    applyAssignments(parseServerCfg(text, "server.cfg"), both);
    expect(server.list().map((i) => [i.def.name, i.value])).toEqual(defaults);
  });
});

describe("parseCommandLine", () => {
  it("turns --port and --map into sets ahead of --set, in order", () => {
    expect(
      parseCommandLine([
        "--set",
        "pm_gravity=400",
        "--port",
        "0",
        "--cfg",
        "x.cfg",
        "--maps",
        "m",
        "--map",
        "movement_lab",
        "--set",
        "sv_host=a=b",
      ]),
    ).toEqual({
      cfg: "x.cfg",
      mapsDir: "m",
      sets: [
        { name: "sv_port", value: "0", source: "--port" },
        { name: "sv_map", value: "movement_lab", source: "--map" },
        { name: "pm_gravity", value: "400", source: "--set" },
        { name: "sv_host", value: "a=b", source: "--set" },
      ],
    });
    expect(parseCommandLine([])).toEqual({ cfg: null, mapsDir: null, sets: [] });
  });

  it.each([[["--bogus"]], [["--port"]], [["stray"]], [["--set", "novalue"]], [["--set", "=1"]]])(
    "refuses %j",
    (args) => {
      expect(() => parseCommandLine(args)).toThrow(ConfigError);
    },
  );
});

describe("applyAssignments", () => {
  it("routes each cvar to the registry that has it", () => {
    const { server, match, both } = registries();
    applyAssignments(
      [
        { name: "sv_port", value: "0", source: "--port" },
        { name: "PM_GRAVITY", value: "400", source: "--set" },
      ],
      both,
    );
    expect(server.get("sv_port")).toBe(0);
    expect(match.get("pm_gravity")).toBe(400);
    expect(server.has("pm_gravity")).toBe(false);
  });

  it.each([
    ["sv_nope", "1", "x: unknown cvar sv_nope"],
    ["sv_port", "abc", 'x: sv_port: "abc" is not a valid value'],
    ["sv_port", "70000", "x: sv_port 70000 is out of range (0…65535)"],
  ])("refuses %s %s", (name, value, message) => {
    const { both } = registries();
    expect(() => applyAssignments([{ name, value, source: "x" }], both)).toThrow(
      new ConfigError(message),
    );
  });
});

describe("sendLimits", () => {
  it("takes the send-buffer limits from the server cvars", () => {
    const { server, both } = registries();
    applyAssignments(
      [
        { name: "sv_sendBufferDrop", value: "4096", source: "x" },
        { name: "sv_sendBufferClose", value: "8192", source: "x" },
      ],
      both,
    );
    const limits = sendLimits(server);
    expect([limits.sendBufferDrop, limits.sendBufferClose]).toEqual([4096, 8192]);
  });

  it("refuses a close limit that is not above the drop limit", () => {
    const { server, both } = registries();
    applyAssignments([{ name: "sv_sendBufferClose", value: "32768", source: "x" }], both);
    expect(() => sendLimits(server)).toThrow(
      new ConfigError("sv_sendBufferClose (32768) must be above sv_sendBufferDrop (32768)"),
    );
  });
});
