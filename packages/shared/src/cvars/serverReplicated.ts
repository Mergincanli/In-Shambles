import { CvarFlag } from "./flags";
import type { CvarRegistry } from "./registry";

/**
 * The replicated cvars the server owns beside the movement ones (D-042, M3 design §1): the
 * dedicated server's match template, the Worker's match and every client's mirror register the
 * same set (with `registerPmoveCvars`), so the cvar block lists exactly what each side holds.
 *
 * `sv_cheats` lets clients use their CHEAT cvars (third person, the debug views): each client sets
 * its registry's cheats-allowed state from the mirror's value whenever a block arrives. 0 by
 * default, as on the dedicated server; the offline Worker starts it at 1 (design values).
 */
export function registerServerReplicatedCvars(reg: CvarRegistry): void {
  reg.register({
    name: "sv_cheats",
    type: "int",
    default: 0, // design (D-042): 0 on the dedicated server; the Worker sets 1
    min: 0,
    max: 1,
    description: "1: clients may use their CHEAT cvars (third person, debug views)",
    flags: CvarFlag.REPLICATED,
  });
}
