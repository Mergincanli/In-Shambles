# CLAUDE.md — Project instructions

This file loads into every Claude Code session. Keep it short; details live in `docs/`.

## What we are building

A browser-native, multiplayer first-person shooter built on our **own Quake-3-style engine**, written from scratch in TypeScript.

We copy exactly **two things** from Urban Terror 4.x (UrT):

1. **Movement mechanics and feel**: Q3 ground/air physics, strafe and circle jumping, sprint, stamina, wall jumps, power slide, ledge grab, fall damage, goomba stomp, kick.
2. **How the guns were balanced**: hit-zone damage table, armor, bleeding/bandage/medkit rules, magazines, reload rules, fire modes, accuracy model, loadout slots.

**Everything else is ours**: engine, netcode, tools, art direction, rendering, audio, UI, names, maps, modes, the twist.

**Top priority: netcode and online performance.** A feature is not done until it works networked: server-authoritative, client-predicted, and tested under simulated latency and packet loss.

## Golden rules

1. **Clean room.** Never copy code or assets from Urban Terror, Quake III Arena, ioquake3 or any GPL source. Never decompile or reverse-engineer UrT binaries. Implement from the specs in `docs/`. Observing the original game's behavior for reference is fine.
2. **No trademarks in content.** No "Urban Terror", "UrT", "FrozenSand" or real gun brand names in player-facing text. Use the internal IDs from `docs/04-combat-and-balance.md`; display names come from content data.
3. **Server-authoritative.** Clients send inputs only. The server simulates everything. Clients predict their own player and interpolate everyone else.
4. **One simulation.** Gameplay logic lives in `packages/shared` and runs identically on server and client, at a fixed 60 Hz tick.
   - Never use `Math.random`, `Date.now` or `performance.now` inside the simulation; use the seeded PRNG and the tick counter.
   - No DOM or Node APIs in `shared`.
5. **Netcode first.** Every gameplay feature ships with all of:
   - its state in `PlayerState`/`EntityState`
   - serialization and quantization
   - prediction support
   - tests under the net simulator
6. **The spec is the source of truth.**
   - If code and docs disagree, stop and ask.
   - When a decision changes, update the doc in the same change and add an entry to `docs/11-decision-log.md`.
7. **Numbers are labeled** FACT (sourced), INFERRED or ESTIMATE. Never upgrade an ESTIMATE to FACT. ESTIMATEs are tuned through cvars, not hard-coded.
8. **Tests prove it.** Add or adjust tests with every change. Run `pnpm typecheck && pnpm lint && pnpm test` before saying "done".
9. **Small steps.** Plan first and get approval for anything bigger than a small fix. Do one milestone at a time; never start the next one unasked.
10. **Performance budgets are requirements** (`docs/10-testing-and-performance.md`). No per-frame or per-tick allocations in hot paths.

## Repo layout (target)

```
packages/
  shared/   pure TS sim: math, world/collision, movement (pmove), combat, game rules,
            protocol + serialization, cvars, PRNG. No DOM/Node APIs.
  server/   Node dedicated server: transports, match loop, lag-comp history,
            relevance, admin.
  client/   Vite + Three.js: renderer, input, prediction, interpolation, audio, HUD,
            console, netgraph, menus. Also hosts the in-browser Worker server for
            offline/dev play.
  tools/    map compiler (TrenchBroom), headless bots, feel/balance reports,
            replay tools.
content/    maps (.map sources + compiled), textures, weapon/item data, names.
docs/       specs, roadmap, decisions, handoffs.
.claude/    rules (path-scoped), skills (workflows), agents (reviewers).
```

## Commands (created in M0; keep this list current)

| Command | What it does |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm dev` | Client + in-browser Worker server (loopback) |
| `pnpm dev:server` | Dedicated Node server from source (not `pnpm server`, a pnpm built-in; D-015) |
| `pnpm build` | Production client build + server bundle (`packages/server/dist/main.js`) |
| `pnpm test` | All tests (Vitest) |
| `pnpm test:movement` | Movement tests |
| `pnpm test:net` | Netcode tests |
| `pnpm test:balance` | Balance tests |
| `pnpm test:browser` | Determinism vectors in real browsers (BROWSERS=chromium,firefox,webkit) |
| `pnpm typecheck` | Type-check all packages |
| `pnpm lint` | Biome lint + format check |
| `pnpm format` | Apply Biome formatting and safe fixes |
| `pnpm greybox` | Recompile the greybox courses into `content/maps/` |
| `pnpm bench` | Microbenchmarks (`--strict` fails on a missed budget) |
| `pnpm bots --count 16 --profile wan-150-loss2` | Headless bot load test |
| `pnpm feel-report` | Movement metrics vs. targets |
| `pnpm balance-report` | Hits-to-kill / TTK tables |
| `pnpm mapc` | TrenchBroom `.map` compiler |

Until their milestone, these are stubs that print "added in M#": `test:movement`, `test:net`, `feel-report` (M2); `bots` (M3); `mapc` (M5); `balance-report` (M6). Until M2, `pnpm dev` serves the client only.

## Conventions

**Space and time**
- 1 unit (u) = 1 inch = 0.0254 m.
- The sim is **Z-up** (Quake convention). The renderer converts to Three.js Y-up meters in one module only: `packages/client/src/render/space.ts`.
- Time is integer **ticks**: `TICK_RATE = 60`, `TICK_DT = 1/60`. Render rate is decoupled; interpolate between ticks.

**Simulation state**
- End every tick by quantizing simulated state (`docs/05-netcode.md` §4) on both client and server, so predictions match bit-for-bit.
- Tunables that affect prediction are **replicated cvars** sent by the server. Clients never use local values for physics.

**Content**
- IDs are stable `snake_case` (`rifle_ar`, `armor_vest`). Display names live in `content/names/*.json`.

**Code style**
- TS `strict`, no `any` in `shared`.
- Pure functions for sim steps. Data-oriented structs, pooled objects, typed arrays in hot paths.

## Docs map: read what the task needs (paths are backticked so they don't auto-load)

| Doc | What's in it |
|---|---|
| `docs/01-vision-and-scope.md` | Pillars, copy-vs-ours, non-goals, **open decisions** |
| `docs/02-urt-reference.md` | Research on the original game (facts, sources, unknowns) |
| `docs/03-movement-spec.md` | Movement algorithms, constants, UrT mechanics, feel tests |
| `docs/04-combat-and-balance.md` | Hit zones, damage table, armor, bleeding, weapons, loadouts |
| `docs/05-netcode.md` | Tick model, protocol, prediction, interpolation, lag compensation |
| `docs/06-engine-architecture.md` | Packages, modules, rendering, input, audio, console/cvars |
| `docs/07-map-pipeline-trenchbroom.md` | Compiled map format, greybox builder, TrenchBroom importer |
| `docs/08-art-direction.md` | Look-dev process, readability rules, budgets |
| `docs/08a-xiii-style-reference.md` | XIII (2003) style research: verified facts, techniques, corrected shader recipes (reference, not rules) |
| `docs/09-roadmap.md` | Milestones M0–M10 with acceptance criteria and status |
| `docs/10-testing-and-performance.md` | Test strategy, net profiles, performance budgets |
| `docs/11-decision-log.md` | Decisions (D-###) and why |
| `docs/design/` | Approved milestone plans and design records (`M1-plan.md`, `M1-design.md`), cited as "M1 plan" / "M1 design A.4"; records, not specs |
| `docs/handoffs/` | Session handoffs; read the newest one when resuming |

## Workflow

- **Session start:** `/start-session`. **Session end:** `/handoff`.
- **Milestone work:** `/milestone M<n>` (reads the milestone from the roadmap; plan first).
- **Checks:** `/feel-check`, `/net-check`, `/balance-check`.
- **Reviews:** after changes to sim/net/server/prediction, delegate to the `netcode-reviewer` agent. Movement changes go to `movement-reviewer`. Before closing a milestone, run `perf-auditor` and `clean-room-auditor`.
- Commit after each green step with a conventional message (`feat(shared): …`). Never force-push. Ask before destructive git operations.

## Definition of done (every task)

- Behavior matches the relevant spec section. Deviations are documented in the decision log.
- Tests added or updated; `pnpm typecheck && pnpm lint && pnpm test` passes.
- Networked behavior verified under at least the `wan-100-loss1` profile for gameplay changes.
- No new per-tick/per-frame allocations in hot paths. Budgets in `docs/10` still met.
- Docs updated: roadmap status, decision log if anything changed, handoff at session end.

## Never

- Copy UrT/Q3/ioq3 code or assets, or paste GPL code.
- Add dependencies without saying why (and checking the license).
- Trust client-sent state (positions, hits, damage).
- Change a FACT value from `docs/04` without an explicit instruction.
- Put game logic in the renderer, or rendering in `shared`.
