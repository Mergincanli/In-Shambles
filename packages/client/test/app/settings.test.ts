import { CvarRegistry, registerPmoveCvars } from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  applySettings,
  captureSettings,
  loadSettings,
  SETTINGS_KEY,
  SETTINGS_VERSION,
  SettingsSaver,
  type SettingsStorage,
} from "../../src/app/settings";
import { Binds } from "../../src/console/binds";
import { registerClientCvars } from "../../src/console/clientCvars";

function registry(): CvarRegistry {
  const reg = new CvarRegistry();
  registerPmoveCvars(reg);
  registerClientCvars(reg);
  return reg;
}

class MemoryStorage implements SettingsStorage {
  readonly items = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes++;
    this.items.set(key, value);
  }
}

const throwing: SettingsStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("settings (ARCHIVE cvars and binds in localStorage)", () => {
  it("store only changed ARCHIVE cvars, never replicated ones, and binds only when changed", () => {
    const reg = registry();
    const binds = new Binds();
    expect(captureSettings(reg, binds)).toEqual({ version: SETTINGS_VERSION, cvars: {} });
    reg.set("sensitivity", 2.5);
    reg.set("cl_netgraph", true);
    reg.setReplicated("pm_gravity", 400);
    binds.bind("KeyQ", "+jump");
    const s = captureSettings(reg, binds);
    expect(s.cvars).toEqual({ sensitivity: "2.5", cl_netgraph: "true" });
    expect(s.binds).toContainEqual(["KeyQ", "+jump"]);
    expect(s.binds).toHaveLength(11);
  });

  it("round-trip through storage, and save only after a change", () => {
    const storage = new MemoryStorage();
    const reg = registry();
    const binds = new Binds();
    const saver = new SettingsSaver(storage, reg, binds);
    expect(saver.maybeSave()).toBe(false);
    reg.set("m_pitch", -0.022);
    binds.unbind("KeyC");
    expect(saver.maybeSave()).toBe(true);
    expect(saver.maybeSave()).toBe(false);
    expect(storage.writes).toBe(1);

    const reg2 = registry();
    const binds2 = new Binds();
    expect(loadSettings(storage, reg2, binds2)).toEqual([]);
    expect(reg2.get("m_pitch")).toBe(-0.022);
    expect(binds2.commandFor("KeyC")).toBeUndefined();
    expect(binds2.commandFor("KeyW")).toBe("+forward");
  });

  it("skip what is unknown, replicated, malformed or from another version", () => {
    const reg = registry();
    const binds = new Binds();
    const warnings = applySettings(
      {
        version: SETTINGS_VERSION,
        cvars: { pm_gravity: "100", nope: "1", sensitivity: "fast", cl_fov: "100" },
        binds: [["KeyW", "+forward"], ["bad", 3], "x"],
      },
      reg,
      binds,
    );
    expect(warnings).toEqual([
      "settings: skipped pm_gravity",
      "settings: skipped nope",
      "settings: skipped sensitivity = fast",
      "settings: malformed binds, using the default binds",
    ]);
    expect([reg.get("pm_gravity"), reg.get("sensitivity"), reg.get("cl_fov")]).toEqual([
      800, 5, 100,
    ]);
    // One bad entry keeps every default bind (a partial set could have lost the console key).
    expect(binds.isDefault()).toBe(true);
    expect(
      applySettings(
        {
          version: SETTINGS_VERSION,
          cvars: {},
          binds: [
            ["KeyW", "+forward"],
            ["Backquote", " "],
          ],
        },
        reg,
        binds,
      ),
    ).toEqual([
      "settings: binds ignored (the command is empty (unbind removes a bind)), using the default binds",
    ]);
    expect(
      applySettings(
        { version: SETTINGS_VERSION, cvars: {}, binds: [["KeyW", "+forward"]] },
        reg,
        binds,
      ),
    ).toEqual(["settings: binds ignored (no key toggles the console), using the default binds"]);
    expect(binds.isDefault()).toBe(true);
    expect(
      applySettings(
        {
          version: SETTINGS_VERSION,
          cvars: {},
          binds: [
            ["KeyW", "+forward"],
            ["F1", "toggleconsole"],
          ],
        },
        reg,
        binds,
      ),
    ).toEqual([]);
    expect(binds.list()).toEqual([
      ["F1", "toggleconsole"],
      ["KeyW", "+forward"],
    ]);
    expect(applySettings({ version: 99, cvars: { cl_fov: "50" } }, reg, binds)).toEqual([
      "settings: version 99, ignored",
    ]);
    expect(applySettings(null, reg, binds)).toEqual(["settings: not an object, ignored"]);
  });

  it("survive missing, throwing and corrupt storage", () => {
    const reg = registry();
    const binds = new Binds();
    expect(loadSettings(null, reg, binds)).toEqual([]);
    expect(loadSettings(throwing, reg, binds)).toEqual([
      "settings: storage unavailable, using defaults",
    ]);
    const bad = new MemoryStorage();
    bad.items.set(SETTINGS_KEY, "{not json");
    expect(loadSettings(bad, reg, binds)).toEqual([
      "settings: stored settings are not JSON, ignored",
    ]);
    const saver = new SettingsSaver(throwing, reg, binds);
    reg.set("cl_fov", 100);
    expect(saver.maybeSave()).toBe(false);
  });

  it("retry a save that storage refused once", () => {
    const reg = registry();
    const binds = new Binds();
    const storage = new MemoryStorage();
    let refuse = true;
    const flaky: SettingsStorage = {
      getItem: (k) => storage.getItem(k),
      setItem: (k, v) => {
        if (refuse) throw new Error("QuotaExceededError");
        storage.setItem(k, v);
      },
    };
    const saver = new SettingsSaver(flaky, reg, binds);
    reg.set("sensitivity", 3);
    expect(saver.maybeSave()).toBe(false);
    refuse = false;
    expect(saver.maybeSave()).toBe(true);
    expect(JSON.parse(storage.items.get(SETTINGS_KEY) ?? "{}").cvars).toEqual({ sensitivity: "3" });
  });
});
