---
name: feel-check
description: Verify the game's movement feel against the spec. Use when the user types /feel-check, asks "check the movement", "run the feel tests", "how close are we to UrT movement", or after any change to pmove, stamina, wall jumps, slides, ledge grabs, fall damage or movement cvars. Runs movement tests and the feel report, compares against docs/03 targets, and suggests cvar tuning.
argument-hint: "[optional: mechanic to focus on]"
---

# Feel check

1. **Run the tests.** Run `pnpm test:movement`. If it doesn't exist yet, say it's added in M2/M4 and stop.
2. **Run the report.** Run `pnpm feel-report` and read `reports/feel.md`.
3. **Compare.** Check every metric against `docs/03-movement-spec.md` §8 (targets) and §7 (values measured from the original, if filled in). If `$ARGUMENTS` names a mechanic, focus on it.
4. **Report** a table: metric | target | measured | Δ | label (FACT/INFERRED/ESTIMATE) | status.
5. **Suggest tuning** for misses on ESTIMATE/INFERRED values: cvar name, current → suggested value, expected effect.
   - Never change FACT targets.
   - Remind the user that tuning must be done at the locked 60 Hz tick.
6. **Apply only with approval.** Ask before applying changes. If applied, re-run steps 1–3 and record the changes for the handoff's "Tuning changes" table.
