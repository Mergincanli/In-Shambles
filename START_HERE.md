# START HERE: Claude Code pack for the browser FPS

This pack contains everything Claude Code needs to build the game:
- project memory (`CLAUDE.md`)
- specs for design, tech and research (`docs/`)
- path-scoped rules, workflow skills and reviewer agents (`.claude/`)
- a sequenced prompt playbook (`prompts/PROMPTS.md`)

**The deal in one line:** copy Urban Terror's **movement** and **gun balance** faithfully. Everything else is ours: engine, art, names, maps, modes, the twist. **Netcode comes first.**

## 1. Install (≈10 minutes)

1. Create an empty repo folder, e.g. `game/`, and run `git init` in it.
2. Copy **everything** from this pack into the repo root, including the hidden `.claude/` folder. On macOS/Linux, hidden files may need `cp -a` or "show hidden files".
3. Install the prerequisites:
   - Node.js (current LTS)
   - pnpm (`corepack enable`)
   - Git
   - Claude Code
   - TrenchBroom (only needed from M5 on)
4. Open a terminal in the repo, run `claude`, and accept the folder-trust prompt. Project rules, skills and agents only load in trusted folders.
5. Optional: commit the pack as your first commit (`chore: add Claude Code pack`).

## 2. Decide what you can (5 minutes)

Open `docs/01-vision-and-scope.md` → **Open decisions**. Claude Code treats anything TBD as undecided and won't invent it. Nothing blocks M0–M4 except:

| ID | Decision | Needed by |
|---|---|---|
| O-5 | License/business model | the default (closed, free-to-play, no GPL) is fine for now |
| O-2 | Naming | decide any time; names live in data |
| O-3 | The twist | before M10 |

When you decide something, paste the **P-DECISION** prompt.

## 3. Build, one milestone at a time

**Every session**

| When | What |
|---|---|
| Start | `/start-session` |
| Work | `/milestone M0` (then M1, M2 …). Use plan mode, approve the plan, and let it build in small green steps. |
| Checks | `/feel-check` (movement), `/net-check` (netcode), `/balance-check` (guns) |
| Reviews | "Use the netcode-reviewer agent on this diff" (also `movement-reviewer`, `perf-auditor`, `clean-room-auditor`) |
| End | `/handoff`, then `/clear` |

**Milestones**

| Milestone | What you get |
|---|---|
| M0 | Monorepo, tooling and the locked damage table with its golden test |
| M1 | Deterministic simulation core: collision, compiled maps, test courses |
| M2 | Running around in the browser, already through a local server with prediction |
| M3 | Real multiplayer: Node server, protocol, interpolation, bots |
| M4 | UrT movement: sprint, stamina, wall jumps, slides, ledge grabs (**your feel sign-off**) |
| M5 | TrenchBroom map pipeline with hot reload |
| M6 | Combat with UrT balance and lag compensation |
| M7 | Game modes and match flow |
| M8 | Your art direction |
| M9 | Online hardening and deployment |
| M10 | The twist |

## 4. Turning estimates into truth

UrT's game code was closed, so some movement and weapon numbers are **ESTIMATE** (clearly labeled in the docs). To make them exact:
1. Install UrT 4.3.4 (free) and run it offline. **Observe only; never copy its files.**
2. Follow the capture protocol in `docs/02-urt-reference.md` §13: speeds, jump/wall-jump heights, slide distance, stamina, fire rates, reload times.
3. Paste your measurements with the **P-CAPTURE** prompt. Claude Code updates the data, tests and decision log.

## 5. What's in the pack

```
START_HERE.md                     ← this file (for you)
CLAUDE.md                         ← auto-loaded project instructions for Claude Code
docs/
  01-vision-and-scope.md          pillars, copy-vs-ours, non-goals, open decisions, naming guidance
  02-urt-reference.md             all research on the original (facts, tables, sources, unknowns)
  03-movement-spec.md             Q3-style physics + UrT mechanics, cvars, 20 feel tests
  04-combat-and-balance.md        damage table, armor, bleeding, weapons, accuracy, loadouts, tests
  05-netcode.md                   60 Hz tick, protocol, prediction, interpolation, lag comp, security
  06-engine-architecture.md       packages, modules, client/server structure, cvars, perf rules
  07-map-pipeline-trenchbroom.md  compiled map format, greybox courses, TrenchBroom importer
  08-art-direction.md             "Comic Noir" art direction: rules, rendering, budgets, look-dev (FORGE)
  08a-xiii-style-reference.md     XIII (2003) style research + corrected shader recipes (reference only)
  09-roadmap.md                   milestones M0–M10 with acceptance criteria + status
  10-testing-and-performance.md   test suites, network profiles, performance budgets
  11-decision-log.md              decisions D-001… and why
  handoffs/TEMPLATE.md            end-of-session handoff format
prompts/
  PROMPTS.md                      copy-paste prompts: milestones + reusable session prompts
.claude/
  rules/      shared-simulation, netcode, client-render, content-and-ip (load per folder)
  skills/     start-session, handoff, milestone, feel-check, net-check, balance-check
  agents/     netcode-reviewer, movement-reviewer, perf-auditor, clean-room-auditor
```

## 6. Ground rules worth remembering

- **Clean room:** no UrT/Quake III/ioquake3 code or assets, no GPL code, no decompiling. Observing gameplay is fine.
- **No trademarks** in player-facing names ("Urban Terror", "UrT", "FrozenSand", gun brands).
- **"Works locally" isn't done.** Done means it works under `net_profile wan-100-loss1`, with tests.
