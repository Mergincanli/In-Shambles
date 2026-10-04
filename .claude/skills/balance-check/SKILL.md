---
name: balance-check
description: Verify weapon balance fidelity to the Urban Terror 4.3 reference. Use when the user types /balance-check, asks to "check the gun balance", "compare TTK", or after changes to weapon data, damage, armor, bleeding, healing, spread, fire rates or loadouts. Runs balance tests and the balance report and flags any drift from the FACT damage table.
---

# Balance check

1. **Run the tests.** Run `pnpm test:balance`. If it doesn't exist yet, say BAL-01 arrives in M0 and the rest in M6, then stop.
2. **Run the report.** Run `pnpm balance-report` and read `reports/balance.md`.
3. **Verify:**
   - `content/weapons/damage.json` matches `docs/04-combat-and-balance.md` §4 exactly. These are FACT values, so any difference is a **blocker**.
   - The hits-to-kill table matches `docs/04` §5.
   - RPM, reload and spread values match `docs/04` §6–7, or a decision-log entry explains the change.
4. **Report** the TTK/HTK highlights and any drift. Label each value FACT, INFERRED or ESTIMATE.
5. **Suggest captures** (`docs/02` §13) for the ESTIMATE values with the biggest effect on TTK. These are usually RPM and reload time.
