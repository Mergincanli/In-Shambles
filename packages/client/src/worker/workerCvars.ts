import { CvarRegistry, registerPmoveCvars, registerServerReplicatedCvars } from "@game/shared";

/**
 * The offline match's replicated cvars (D-042): the defaults, with `sv_cheats` at 1, since offline
 * play is the player's own sandbox (third person and the debug views work). The dedicated server
 * keeps it at 0 unless an admin sets it.
 */
export function workerCvars(): CvarRegistry {
  const cvars = new CvarRegistry();
  registerPmoveCvars(cvars);
  registerServerReplicatedCvars(cvars);
  cvars.set("sv_cheats", 1);
  return cvars;
}
