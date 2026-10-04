---
name: handoff
description: Write the end-of-session handoff for this game project. Use when the user types /handoff or says "handoff", "wrap up", "end session", "write the handoff", or before clearing context after a milestone. Produces docs/handoffs/YYYY-MM-DD-M#-slug.md from the template, updates roadmap status and the decision log, and lists next steps.
argument-hint: "[optional short title]"
---

# Handoff

1. **Collect facts — don't guess.**
   - `git diff --stat` since the last handoff commit (or `git log` for this session).
   - Results of `pnpm typecheck`, `pnpm lint` and `pnpm test`. Run them now if they weren't run in the last 15 minutes.
   - Any suite relevant to the work (`test:movement`, `test:net`, `test:balance`), plus bench/bot metrics if those areas were touched.
2. **Write the handoff.** Create `docs/handoffs/<YYYY-MM-DD>-<M#>-<slug>.md` from `docs/handoffs/TEMPLATE.md`. Use `$ARGUMENTS` as the title if given. Fill every section; write "none" instead of deleting a section.
3. **Update the roadmap.** In `docs/09-roadmap.md`, set the milestone's status emoji and the "Last handoff" link.
4. **Log decisions.** If any decision changed or the spec was deviated from, append a `D-###` entry to `docs/11-decision-log.md` and reference it in the handoff.
5. **Log tuning.** If tunables changed, fill the "Tuning changes" table (cvar, old, new, reason).
6. **Show and ask.** Show the user sections 1, 2, 8 and 9 of the handoff, then ask whether to commit the docs. Never auto-commit or push without confirmation.
