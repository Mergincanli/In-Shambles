---
name: milestone
description: Run a roadmap milestone for this game (M0–M10) with a plan-first workflow. Use when the user types /milestone M# or asks to "start/continue milestone M#". Loads the milestone's scope and acceptance criteria from docs/09-roadmap.md and the matching prompt in prompts/PROMPTS.md, plans, implements in verified increments, and finishes with checks and a handoff.
argument-hint: "M0..M10"
---

# Milestone runner

Target milestone: **$ARGUMENTS**. If empty, read `docs/09-roadmap.md`, pick the first milestone not marked ☑, and confirm with the user.

1. **Load context**
   - The milestone section in `docs/09-roadmap.md`: goal, scope, out of scope, acceptance criteria.
   - The milestone prompt with the same ID in `prompts/PROMPTS.md`.
   - Only the spec docs that prompt references.
   - The newest handoff in `docs/handoffs/`.
2. **Plan first** (use plan mode if not already in it)
   - Produce a numbered plan:
     - files and modules to create or change
     - test list mapped to the acceptance criteria
     - risks
     - order of increments, each ending green
   - Call out every ESTIMATE value you will use and every open question.
   - Stop and wait for approval.
3. **Implement in increments.** For each increment:
   - Write tests first where practical, then implement.
   - Run `pnpm typecheck && pnpm lint` and the relevant suites; fix failures.
   - Commit with a conventional message, after confirmation, if the user wants commits per increment.
   - Follow `.claude/rules/*` and the golden rules in `CLAUDE.md`. Never expand scope; put new ideas in the roadmap backlog instead.
4. **Verify the milestone**
   - Run every acceptance check. For milestones that affect networking, also run the NET profiles and a bot session.
   - Delegate reviews before closing:
     - `netcode-reviewer` for sim, net, server or prediction changes
     - `movement-reviewer` for movement changes
     - `perf-auditor` and `clean-room-auditor` for every milestone
5. **Close out**
   - Update the docs; record spec deviations in the decision log.
   - Run `/handoff`.
   - Give the user a "Try it" list.
