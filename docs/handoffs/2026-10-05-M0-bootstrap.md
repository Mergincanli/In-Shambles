# Handoff — 2026-10-05 — M0 — Bootstrap & guardrails

> File name: `docs/handoffs/YYYY-MM-DD-M#-<slug>.md`. Written by `/handoff` at the end of every session. The next session starts by reading the newest one (`/start-session`).

## 1. Summary (3–5 lines)
M0 is built: a pnpm monorepo (`@game/shared`, `server`, `client`, `tools`) with strict TypeScript, Biome, Vitest, Vite, tsx, esbuild and CI. It includes the FACT damage table with its BAL-01 golden test, the cvar registry, `DEV_ASSERT`, a placeholder client page and server, and stubs for later commands. The work went through four multi-agent review rounds (about 95 findings, all fixed or explicitly refuted) and gained guard tests that keep the golden rules machine-checked. One spec deviation: the server dev command is `pnpm dev:server` (D-015).

## 2. Milestone status
- Milestone: M0 — Bootstrap & guardrails → ☑ done
- Acceptance criteria:
  - ✅ Fresh clone → `pnpm install && pnpm typecheck && pnpm lint && pnpm test` passes. Also verified on a Windows-style CRLF clone (`core.autocrlf=true`), on Node 22.12 and on Node 26.
  - ✅ `pnpm dev` serves the page: Chromium shows "client ok · build <git hash>".
  - ✅ `pnpm dev:server` starts and logs "server ok t=<monotonic ms>" (D-015: `pnpm server` is a pnpm built-in).
  - ✅ BAL-01 passes, and fails when one value changes in either `damage.json` or the `docs/04` §4 table.

## 3. What was built (by package)
- `shared/`:
  - `cvars/`: registry with ARCHIVE / REPLICATED / CHEAT / SERVER / LATCH flags.
    - Names are spec-style `prefix_camelCase` with case-insensitive lookup; reads by the registered name don't allocate.
    - Validation: int32 ints, finite floats, validated bounds, decimal-only parsing, `-0` → `0`.
    - LATCH values wait for `applyLatched()`; turning cheats off resets CHEAT cvars.
  - `debug/assert.ts`: `DEV_ASSERT` / `setDevAsserts`. Allocation-free on success; an optional primitive `detail` is formatted only on failure.
- `server/`:
  - `startServer()` installs the stop handlers before logging readiness.
  - `main.ts` is the entry point; `build.mjs` makes the esbuild bundle (`dist/main.js`).
  - Smoke tests cover SIGINT/SIGTERM, the production bundle, and the root `pnpm dev:server` command. Every spawned process is cleaned up, even after a test timeout.
- `client/`:
  - Vite placeholder page.
  - The build hash comes from this repo's checkout only: `-dirty` with uncommitted changes, `BUILD_HASH` to override, "dev" elsewhere.
  - A build test checks the built page and bundle.
- `tools/`:
  - Helpers:
    - `paths.ts`
    - `docs/mdTable.ts` (fences, unique headings, GitHub table forms)
    - `content/weaponDocs.ts` (docs/04 §2 and §4 parsers)
    - `code/scan.ts` (source scanner for guards)
    - `jsonc.ts`
  - Guard tests:
    - BAL-01
    - weapon content (IDs, names, type tags)
    - trademarks: brand and model names in player-visible text
    - shared purity: `Math.random`, `Date`, `globalThis`, allocating `DEV_ASSERT` calls
    - tsconfig: strict everywhere; no DOM or Node types in shared
    - scripts: CLAUDE.md commands exist, stubs, `--fail-if-no-match`, no pnpm built-in names, no `--` between a pnpm script and its flags in docs, BAL test naming
- `content/`:
  - `weapons/damage.json`: FACT, 20 weapons × 10 zones.
  - `names/weapons.json`: 22 IDs, names "TBD", plain type tags.
  - `LICENSES.md`: header only.
- Repo:
  - Root scripts, including stubs that print "added in M#".
  - `tsconfig.base.json` plus a root `tsconfig.json` for `vitest.config.ts`.
  - `biome.json`: `any` is an error in shared.
  - `.gitattributes` (LF everywhere), `.nvmrc` (24).
  - CI: install, typecheck, lint, test and build on PRs and on `main`.
  - README, LICENSE placeholder.

## 4. Verification
- `pnpm typecheck`, `pnpm lint` and `pnpm test` all pass: 177 tests in about 2 s, stable over repeated and parallel runs.
- `pnpm test:balance`: BAL-01 passes.
- `pnpm build`, then `node packages/server/dist/main.js`: starts, logs and exits 0 on SIGTERM.
- Clones: fresh clone and CRLF clone both pass.
- Mutation probes: about 100 across the review rounds. Each guard fails on the regression it exists for.
- Reviews:
  - `clean-room-auditor`: all 120 locked packages are dev-only and permissively licensed; no GPL or Quake III patterns; FACT data matches.
  - `perf-auditor`: there are no hot paths yet; the allocation risks it raised (DEV_ASSERT messages, cvar lookups) are fixed.
- Bench, bots and feel-report: not applicable before M1–M3.

## 5. Decisions and deviations
- New: [D-015](../11-decision-log.md): the dedicated-server dev command is `pnpm dev:server`.
- Deviations from the approved plan, none of which change scope:
  - `test:balance` selects tests named `BAL-*` instead of filtering by path, because docs/10 puts BAL scenarios under `test/scenarios`. A guard makes each `bal-NN-*.test.ts` name its `describe` `BAL-NN`.
  - The client page is checked by a build test instead of a runtime DOM test, which would need a new dependency.

## 6. Tuning changes
| Cvar | Old | New | Reason |
|---|---|---|---|
| none | | | |

## 7. Known issues / risks
- **TypeScript 7** (native compiler) is new. If it misbehaves, fall back to TS 6.0.
- **Stopping `dev:server`:** pnpm doesn't forward signals to its child. Stop it with Ctrl+C or by signalling its process group, or run the bundle with `node` (README).
- **`test:balance`** exits 0 when no test name matches. The BAL naming guard covers this.
- **No runtime DOM test** of the client page yet. Revisit when M2 adds real client code.
- **LICENSE** copyright holder is a placeholder ("the In Shambles authors") until O-5.
- **CI** first runs on the M0 pull request.

## 8. Next steps (ordered)
1. Merge the M0 pull request once CI is green.
2. `/milestone M1`: simulation core (time, math, PRNG, brushes, traces, BVH, compiled maps, greybox courses).
3. In parallel, whenever you like: decide O-2 naming (`P-NAMES` prompt), or start measuring the original game (`START_HERE.md` §4, `P-CAPTURE`).

## 9. Try it (for Mustafa)
- Setup: `git clone`, then `corepack enable`, then `pnpm install`.
- `pnpm dev`: open http://localhost:5173. You should see "client ok · build <hash>".
- `pnpm dev:server`: logs "server ok t=…ms". Stop it with Ctrl+C.
- `pnpm test`: 177 tests in about 2 s. `pnpm test:balance` runs BAL-01.
- `pnpm build`, then `node packages/server/dist/main.js`: the production server bundle.
- To see a guard work: change one number in `content/weapons/damage.json` and run `pnpm test:balance`.
