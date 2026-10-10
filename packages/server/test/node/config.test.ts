import { CvarRegistry, registerPmoveCvars } from "@game/shared";
import { describe, expect, it } from "vitest";
import { SessionLimits } from "../../src/match/limits";
import {
  admissionLimits,
  applyAssignments,
  ConfigError,
  parseCommandLine,
  parseServerCfg,
  sendLimits,
  sessionLimits,
} from "../../src/node/config";
import { registerServerCvars } from "../../src/node/serverCvars";
import { AdmissionLimits, isLoopback, parseOrigins } from "../../src/transport/wsListener";

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
      metricsOut: null,
      metricsDiscardS: 0,
    });
    expect(parseCommandLine([])).toEqual({
      cfg: null,
      mapsDir: null,
      sets: [],
      metricsOut: null,
      metricsDiscardS: 0,
    });
  });

  it("takes the metrics file and the seconds discarded before the run window (D-029)", () => {
    const cl = parseCommandLine(["--metrics-out", "out/m.json", "--metrics-discard", "2.5"]);
    expect([cl.metricsOut, cl.metricsDiscardS]).toEqual(["out/m.json", 2.5]);
    // Up to a day: setTimeout would fire a longer delay after 1 ms.
    expect(parseCommandLine(["--metrics-discard", "86400"]).metricsDiscardS).toBe(86_400);
    expect(() => parseCommandLine(["--metrics-discard", "86400.5"])).toThrow(
      "--metrics-discard 86400.5: expected seconds from 0 to 86400",
    );
  });

  it.each([
    [["--bogus"]],
    [["--port"]],
    [["stray"]],
    [["--set", "novalue"]],
    [["--set", "=1"]],
    [["--metrics-discard", "-1"]],
    [["--metrics-discard", "soon"]],
    [["--metrics-discard", " "]],
    [["--metrics-discard", "3000000"]],
    [["--metrics-out"]],
  ])("refuses %j", (args) => {
    expect(() => parseCommandLine(args)).toThrow(ConfigError);
  });
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

describe("sessionLimits and admissionLimits (D-041)", () => {
  it("default to the design's values, the match's and the listener's defaults", () => {
    const { server } = registries();
    expect(sessionLimits(server)).toEqual(new SessionLimits());
    expect(admissionLimits(server)).toEqual(new AdmissionLimits());
  });

  it("take every limit from its server cvar", () => {
    const { server, both } = registries();
    const sets: [string, string][] = [
      ["sv_timeout", "90"],
      ["sv_helloTimeout", "12"],
      ["sv_handshakeTimeout", "180"],
      ["sv_starveNeutralTicks", "10"],
      ["sv_strikeWarn", "5"],
      ["sv_strikeKick", "9"],
      ["sv_inputBurst", "64"],
      ["sv_reliableBurst", "8"],
      ["sv_maxPerIp", "3"],
      ["sv_allowedOrigins", "https://a.example, http://localhost:5173,"],
    ];
    applyAssignments(
      sets.map(([name, value]) => ({ name, value, source: "x" })),
      both,
    );
    expect({ ...sessionLimits(server) }).toEqual({
      timeout: 90,
      helloTimeout: 12,
      handshakeTimeout: 180,
      starveNeutralTicks: 10,
      strikeWarn: 5,
      strikeKick: 9,
      inputBurst: 64,
      reliableBurst: 8,
    });
    const a = admissionLimits(server);
    expect([a.maxPerIp, a.allowedOrigins]).toEqual([
      3,
      ["https://a.example", "http://localhost:5173"],
    ]);
  });

  it("refuses a burst below the 64-packet anchor fill and a kick level not above the warning", () => {
    const { server, both } = registries();
    expect(() =>
      applyAssignments([{ name: "sv_inputBurst", value: "63", source: "x" }], both),
    ).toThrow(ConfigError);
    applyAssignments([{ name: "sv_strikeKick", value: "15", source: "x" }], both);
    expect(() => sessionLimits(server)).toThrow(
      new ConfigError("sv_strikeKick (15) must be above sv_strikeWarn (15)"),
    );
  });

  it("exempts loopback addresses only", () => {
    expect(["127.0.0.1", "127.8.0.2", "::1", "::ffff:127.0.0.1"].map(isLoopback)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(["10.0.0.1", "::ffff:10.0.0.1", "203.0.113.7", "", "1270::1"].map(isLoopback)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(parseOrigins("")).toEqual([]);
    // Written as a browser sends it: lowercase, no trailing slash.
    expect(parseOrigins(" https://Play.Example.org/ ,http://localhost:5173")).toEqual([
      "https://play.example.org",
      "http://localhost:5173",
    ]);
  });
});
