---
name: start-session
description: Resume work on the game at the start of a Claude Code session. Use when the user types /start-session or says things like "start session", "resume", "where were we", "what's next", or opens a new session on this repo. Reads the latest handoff and roadmap status, checks repo health, and proposes the next concrete step. Do not use mid-task.
---

# Start session

1. **Orient**
   - Read the newest file in `docs/handoffs/` (sort by name, ignore `TEMPLATE.md`). If none exists, say so — the project is at M0.
   - Read the status table in `docs/09-roadmap.md`.
   - Run `git status --short` and `git log --oneline -8`.
2. **Health check.** If a command doesn't exist yet, skip it and say which milestone adds it.
   - `pnpm install --frozen-lockfile` (only if `node_modules` is missing or the lockfile changed)
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm test`
3. **Report** to the user in ≤ 15 lines:
   - Current milestone and the status of its acceptance criteria (✅/❌/⏳).
   - Health-check results, failures first, with failing test names.
   - Open risks and known issues from the handoff.
   - **One** recommended next step, plus up to two alternatives.
4. **Wait** for the user to choose before changing any code. If the next step is milestone work, suggest `/milestone M#`.
