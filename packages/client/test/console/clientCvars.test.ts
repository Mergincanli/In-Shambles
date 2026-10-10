import { CvarFlag, CvarRegistry } from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  CLIENT_CVARS,
  ClientSettings,
  RCON_PASSWORD_CVAR,
  refreshClientSettings,
  registerClientCvars,
} from "../../src/console/clientCvars";
import { CLIENT_NET_CVARS } from "../../src/net";
import { VIEW_CVARS } from "../../src/render/viewCvars";

describe("client cvars (docs/06 §7)", () => {
  it("register every client cvar as ARCHIVE, never REPLICATED; the views CHEAT; rcon_password neither", () => {
    const reg = new CvarRegistry();
    registerClientCvars(reg);
    const names = [...CLIENT_NET_CVARS, ...VIEW_CVARS, ...CLIENT_CVARS].map((c) => c.name);
    expect(
      reg
        .list()
        .map((i) => i.def.name)
        .sort(),
    ).toEqual([...names, RCON_PASSWORD_CVAR].sort());
    const cheats = ["cl_thirdPerson", "r_debugHull", "r_debugTraces", "r_debugGround"];
    for (const info of reg.list()) {
      const name = info.def.name;
      const want =
        name === RCON_PASSWORD_CVAR
          ? CvarFlag.NONE
          : CvarFlag.ARCHIVE | (cheats.includes(name) ? CvarFlag.CHEAT : 0);
      expect(info.def.flags, name).toBe(want);
    }
    expect(reg.get(RCON_PASSWORD_CVAR)).toBe("");
  });

  it("refresh the settings struct only when the registry moves", () => {
    const reg = new CvarRegistry();
    registerClientCvars(reg);
    reg.setAllowCheats(true);
    const s = new ClientSettings();
    expect(refreshClientSettings(reg, s)).toBe(true);
    expect(refreshClientSettings(reg, s)).toBe(false);
    expect([s.sensitivity, s.mYaw, s.mPitch, s.netgraph, s.thirdPerson]).toEqual([
      5,
      0.022,
      0.022,
      false,
      false,
    ]);
    reg.set("cl_netgraph", true);
    reg.set("m_pitch", -0.022);
    reg.set("r_debugTraces", true);
    expect(refreshClientSettings(reg, s)).toBe(true);
    expect([s.netgraph, s.mPitch, s.debugTraces, s.debugHull]).toEqual([true, -0.022, true, false]);
  });

  it("copy every cvar into its own field", () => {
    const reg = new CvarRegistry();
    registerClientCvars(reg);
    reg.setAllowCheats(true);
    const s = new ClientSettings();
    // Each field on its own: one value per number, one bool on at a time.
    reg.set("sensitivity", 3);
    reg.set("m_yaw", 0.03);
    reg.set("m_pitch", -0.04);
    refreshClientSettings(reg, s);
    expect([s.sensitivity, s.mYaw, s.mPitch]).toEqual([3, 0.03, -0.04]);
    const bools = [
      ["cl_speedometer", "speedometer"],
      ["cl_netgraph", "netgraph"],
      ["cl_thirdPerson", "thirdPerson"],
      ["r_debugHull", "debugHull"],
      ["r_debugTraces", "debugTraces"],
      ["r_debugGround", "debugGround"],
      ["r_stats", "renderStats"],
    ] as const;
    for (const [name, field] of bools) {
      for (const [other] of bools) reg.set(other, other === name);
      refreshClientSettings(reg, s);
      const on = bools.filter(([, f]) => s[f]).map(([, f]) => f);
      expect([name, on]).toEqual([name, [field]]);
    }
    expect(CLIENT_CVARS).toHaveLength(3 + bools.length);
  });
});
