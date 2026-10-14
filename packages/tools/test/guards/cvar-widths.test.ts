import { registerServerCvars } from "@game/server/node";
import {
  CvarRegistry,
  PLAYER_STATE_CVAR_LIMITS,
  playerStateCvarWidthError,
  registerPmoveCvars,
  registerServerReplicatedCvars,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { registerClientCvars } from "../../../client/src/console/clientCvars";
import { registerClientNetCvars } from "../../../client/src/net/cvars";
import { registerViewCvars } from "../../../client/src/render/viewCvars";

// D-053's width checks (M4 design §2.2): `shared/src/net/snapshot.ts` checks PMOVE_CVARS at load,
// but a cvar that feeds a v4 PlayerState field may land in another table (`st_*`, `bd_time` in
// `combat/medic.ts`). This guard registers every package's cvar tables and checks each row that
// PLAYER_STATE_CVAR_LIMITS names, so a range past its field fails here, wherever it is registered.
// A new cvar table joins `REGISTRARS`.

const REGISTRARS: [string, (reg: CvarRegistry) => void][] = [
  ["registerPmoveCvars", registerPmoveCvars],
  ["registerServerReplicatedCvars", registerServerReplicatedCvars],
  ["registerServerCvars", registerServerCvars],
  ["registerClientCvars", registerClientCvars],
  ["registerClientNetCvars", registerClientNetCvars],
  ["registerViewCvars", registerViewCvars],
];

describe("the v4 PlayerState cvar width checks over every registered table", () => {
  it.each(REGISTRARS)("%s", (_name, register) => {
    const reg = new CvarRegistry();
    register(reg);
    const rows = reg.list().map((i) => ({
      name: i.def.name,
      min: i.def.min ?? Number.NEGATIVE_INFINITY,
      max: i.def.max ?? Number.POSITIVE_INFINITY,
    }));
    expect(rows.length).toBeGreaterThan(0);
    expect(playerStateCvarWidthError(rows)).toBeNull();
  });

  it("refuses a limited cvar registered without a bounded range", () => {
    const limited = PLAYER_STATE_CVAR_LIMITS[0]?.cvar ?? "";
    const unbounded = [{ name: limited, min: 0, max: Number.POSITIVE_INFINITY }];
    expect(playerStateCvarWidthError(unbounded)).toMatch(limited);
  });
});
