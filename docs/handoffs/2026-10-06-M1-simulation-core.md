# Handoff — 2026-10-06 — M1 — Simulation core

> File name: `docs/handoffs/YYYY-MM-DD-M#-<slug>.md`. Written by `/handoff` at the end of every session. The next session starts by reading the newest one (`/start-session`).

## 1. Summary (3–5 lines)
M1 built the deterministic simulation core in `packages/shared`:
- exact math, so every browser computes the same bits (D-016);
- quantizers, a seeded PRNG and a hash;
- `PlayerState` and `UserCmd`;
- brush collision with swept-box traces, a 1/32 u skin and a "nearest clear grid point" snap (D-017);
- an SAH BVH, and the cmap v1 binary map format (D-020).

`packages/tools` gained the greybox compiler and MapBuilder (D-021), the five courses (committed in `content/maps/`), a trace fuzz test against an independent oracle, and `pnpm bench`.

Each increment was built, reviewed from 4–5 angles and fixed before its commit. The final review confirmed 17 findings and all are fixed. One was a real bug: a per-tick allocation that only shows up under native ES modules. There is no movement, rendering or networking yet.

## 2. Milestone status
- Milestone: M1 — Simulation core (headless) → ☑ done.
- Acceptance criteria:
  - ✅ **Trace unit tests** for start-solid, all-solid, grazing edges, corners and epsilon behavior, in `packages/shared/test/world/trace.test.ts`. 157 trace, BVH and snap tests in total.
  - ✅ **Fuzz: random box sweeps never tunnel.** 0 violations in the default run (20k cases) and in long runs of 1M, 2M, 8M and 10M cases with different seeds.
  - ✅ **cmap compile is byte-identical twice.** `pnpm greybox` run twice gives identical files, equal to the committed ones, also from a fresh clone. A test fails when the committed maps go stale.
  - ✅ **Box trace ≤ 1 µs average on `movement_lab`:** 280–304 ns, with 0 GCs, measured on a cloud VM. ⏳ The criterion says "dev laptop", so please re-run `pnpm bench` on yours.

## 3. What was built (by package)
- `shared/`:
  - `time.ts`: `TICK_RATE = 60`, `TICK_DT`, `TICK_MAX = 2^30 − 1`.
  - `math/`:
    - `vec3`: `Float64Array`s with out-params and per-module scratch.
    - `plane`, `aabb`.
    - `quant`: origin to 1/32 u, clamped to ±16384; velocity to 1/16 u/s, clamped to the i20 range; u16 angles; stamina in hundredths; −0 becomes +0.
    - `dtrig`: sine and cosine built from exact operations, plus an exact u16 quarter-wave table.
    - `angles`.
  - `rng/`: Mulberry32, and Murmur3 x86_32 (`hash32` for seeding, `murmur3Bytes`).
  - `sim/`:
    - `PlayerState`: origin, velocity, view angles, PMF flags, ground entity, water level, stamina.
    - `PlayerStateRing(128)`.
    - `UserCmd` and `sanitizeUserCmd`, with 12 button bits.
    - Hulls, `ENTITY_NONE` and `ENTITY_WORLD`.
  - `world/`:
    - Contents and surface flags.
    - Shape constructors: boxes, boxes rotated about Z, axis-aligned wedges.
    - The polygonizer and brush validation.
    - `buildBrush`: f32 planes plus axial bevels rounded outward.
    - `CollisionWorld`.
    - `traceBox`, `traceRay`, `positionTest`, `pointContents` and `boxContents`, each with a brute-force reference version.
    - `snapOrigin` (D-017).
    - The SAH BVH.
    - The cmap v1 decoder: strict validation, canonical JSON, content hash. Plus `buildCollisionWorld`.
- `server/`: none.
- `client/`: none.
- `tools/`:
  - `greybox/`:
    - brush compiler: render surfaces, and a check that rejects shapes needing edge bevels;
    - `MapBuilder`: box, stairs, ramp, slope, wall, rotatedBox, volume, ladder, spawn, timer, anchor;
    - cmap encoder;
    - the 5 courses;
    - `cli.ts` for `pnpm greybox` (and `--out <dir>`).
  - `bench/`: the trace microbenchmark (`pnpm bench`; `--strict` fails on a missed budget).
  - `code/deterministicMath.ts`: the D-016 guard rules.
  - `vectors/`: generator for the determinism and trace vectors (input bits → output bits), which M2 replays in browsers.
  - Tests:
    - the fuzz test (SAT oracle, properties P1–P7, regressions);
    - course sanity and stale-map checks;
    - cmap round trips and every rejection path;
    - guards: shared purity including the approximate-math ban, greybox determinism, the scripts and commands table, vectors files are plain JS;
    - a native-ESM allocation guard.
- `content/`:
  - `maps/*.cmap`, 5 compiled courses: movement_lab 117 KB, jump_lab 45 KB, slide_lab 71 KB, fall_tower 23 KB, arena_greybox 43 KB.
  - `.gitattributes` marks `*.cmap` as binary.
- Docs:
  - D-016 to D-021.
  - `docs/03` §6, `docs/05` §4.1 and §5, `docs/06` module map and scripts, `docs/07` §2/§3/§6, `docs/10` §1/§2/§4.4.
  - The approved plan and design as records in `docs/design/`.
  - CLAUDE.md commands: `pnpm greybox`, and `pnpm bench` is no longer a stub.

## 4. Verification
- **Checks:**
  - `pnpm typecheck` and `pnpm lint` (145 files) are clean.
  - `pnpm test`: 56 files, 1317 tests, about 10 s.
  - `pnpm test:balance`: BAL-01 (7 tests).
- **Fresh clone** at `6c4a460`, before the review fixes: install with `--frozen-lockfile`, typecheck, lint, test, build and the stub commands all pass. The checks were run again on the final tree.
- **Fuzz:**
  - Default seed, 20k cases: 0 violations in about 2 s.
  - Long runs: 1M; 2M (seed 0xbb40e64d); 8M (0xa205b064); 10M (0xc0ffee). All 0 violations.
  - Snap chains: about 10k chains × 200 ticks along every slope and rotated wall, never inside solid.
- **Bench** (Node 22.22, Xeon 2.1 GHz, 4 vCPU):
  - Weighted box-trace average 280–304 ns; 294 ns on the final tree.
  - Moves ~330–355 ns, ground probes ~255–305, step traces ~275, position tests ~205–217.
  - Rays ~570–617 ns, not part of the average.
  - 0 GCs.
- **Course content hashes:** movement_lab b30d60b969733b31, jump_lab 504353c5a4e625fc, slide_lab f468dc116e0498c5, fall_tower 5c99f06120448ab9, arena_greybox a1bb92adffe46253.
- **Reviews:**
  - **Per increment:** each of the 10 increments had 4–5 independent reviewers (spec, correctness, geometry, determinism/performance, test quality) and an integrator who reproduced each finding before fixing it.
  - **Close-out:**
    - An acceptance re-run on a fresh clone.
    - 7 lenses: `netcode-reviewer`, `perf-auditor`, `clean-room-auditor`, traces, map format and courses, tests, spec and docs. They produced 31 raw findings, 18 after merging duplicates, plus 1 from the completeness critic.
    - Each finding had 3 skeptics: 16 confirmed, 2 refuted, plus 13 nits.
    - Everything was fixed in 12 commits, plus 1 style commit.
  - **`clean-room-auditor`:** one nit, a constant named like one in GPL map tools (renamed). The only dependency change is `tsx` (MIT, already in the lockfile), added as a tools devDependency.
  - **`perf-auditor`:** found that quantize and snap allocated every tick when shared runs as native ES modules. Fixed, and a child-process guard now catches it, because Vitest hides it.
  - **`netcode-reviewer`:** decoder hardening, and the client must predict with the sanitized cmd (`docs/05` §5). Both fixed.
- **Mutation probes:** dozens across increments, and each test or guard fails on the regression it targets. One known equivalent mutant remains: the BVH leaf sort.

## 5. Decisions and deviations
- **New decisions** ([decision log](../11-decision-log.md)):
  - **D-016**, deterministic math, and **D-017**, trace skin, touching = outside, snap to the nearest clear grid point. You approved both with the plan.
  - **Accepted by Mustafa on 2026-10-06:**
    - **D-018:** PlayerState and UserCmd layout. Button and flag bits, stamina as hundredths, field ranges, kick-eligible deferred to M4.
    - **D-019:** brush contents, surface flags and build rules (bevels, validation thresholds, the bounds rule).
    - **D-020:** cmap v1 layout. The hash covers the whole file with the hash field read as zero; the plan said bytes [32, EOF), so this covers more. The optional `.cmap.json` + `.cmap.bin` dev pair is dropped. The decoder accepts only the encoder's exact layout.
    - **D-021:** greybox builder API and render conventions: uv 1 per 64 u, how entity angles are stored, which contents render.
- **Deviations from the approved plan:**
  - Docs were updated with each increment instead of all in increment 10 (golden rule 6).
  - The shape constructors, `buildBrush` and the canonical JSON writer live in shared, not tools, so shared tests and the decoder can use them.
  - The decoder is stricter than the design: canonical JSON, the encoder's exact layout, one surface per material in order, header bounds equal to the union of the brush bounds.
  - allSolid traces report no hit brush or plane.
  - movement_lab's floor is 72 strips instead of a full 128 u checkerboard, which keeps the committed file small. Seams still run both ways.
  - The bench's box-trace average includes position tests, since a position test is a zero-length box trace.
  - Course-based tests live in `packages/tools/test`, but `docs/10` §1 puts scenario tests in shared. See §7, question 2.
  - The plan and design are committed as records in `docs/design/`.

## 6. Tuning changes
| Cvar | Old | New | Reason |
|---|---|---|---|
| none | | | M1 has no cvars; `pm_*` arrive in M2 |

## 7. Known issues / risks
- **Questions for you.** Defaults are in place.
  1. **Bevel surface flags:** bevel planes carry no surface flags, so a ground trace at a wedge crest reads "not slick, not nodamage". Should bevels copy the flags of the face next to them? (M2)
  2. **Scenario test location:** `docs/10` §1 puts scenario tests in `packages/shared/test/scenarios`, but shared tests can't read `content/maps`. Either run course-based scenarios from tools, or embed the course bytes in a TS module. (M2)
  3. **"Starts in solid":** in `docs/03` §4.8, does it mean startSolid or allSolid? M1 reports both. (M2)
  4. **Ladders:** detect them by wall-face flag or by LADDER volume? The courses emit both. (M2)
  5. **Rounding biases** (documented in `docs/03` §6):
     - Stamina rates move in steps of 0.6/s at 60 Hz.
     - Per-tick origin rounding adds about 0.2% distance at 320 u/s, so feel tests measure velocity, not distance.
  6. **Greybox details:**
     - Should footstep flags come from material prefixes?
     - Add a `worldspawn` entity?
     - Water volumes render all six faces.
     - Timer entities have no origin.
     - Material names are strict snake_case paths.
  7. **Deferred to M4/M6:** the meaning of each `weaponSlot` index. Kick-eligible stays out of the buttons until M4.
- **Settled at close-out (Mustafa, 2026-10-06):**
  - The `docs/03` §2 hull table is labelled FACT for Q3.
  - D-018 to D-021 are accepted.
  - CLAUDE.md's docs map lists `docs/design/`.
  - The D-016 math-ban line for `.claude/rules/content-and-ip.md` was not added. The greybox determinism guard only scans `packages/tools/src/greybox`, so M5 must add `mapc` to it (D-016 already covers compiler output code).
- **Risks:**
  - **Slopes in M2:** a slide that runs along a slope can round into the 1/32 skin and lose a tick. M2's overclip and nudge should absorb this; watch the slope feel tests. A related "crest snag" finding was refuted by the skeptics.
  - **Snap fallback:** the snap's last rule (keep last tick's origin) fires only in direct probes, never in the random slide chains.
  - **sanitizeUserCmd:** fed fractional numbers, it can allocate under native ES modules. Integer input from the wire is clean; revisit with the M2 decoder.
  - **Bench machine:** the numbers come from a cloud VM. The `docs/10` §5 reference machines are still to be filled in.
  - **Browsers:** cross-engine determinism is proven in Node only. M2 replays the committed vectors in Chrome, Firefox and Safari.
  - **Committed maps:** the binary maps change whenever compiler output changes. Bump `compiler.version`; the stale-map test tells you to recompile.
  - **TypeScript 7** (native compiler) is still new.

## 8. Next steps (ordered)
1. Merge the M1 PR once CI is green. The §7 questions can wait until M2 starts; defaults are in place.
2. Run `pnpm bench` on your laptop and fill in `docs/10` §5.
3. `/milestone M2`: base movement, client shell, Worker server, prediction. Early M2 decisions: where scenario tests live, startSolid vs allSolid, ladder detection, bevel flags. Also replay the determinism vectors in real browsers.
4. In parallel, whenever you like: O-2 naming, or measuring the original game (`START_HERE.md` §4).

## 9. Try it (for Mustafa)
Nothing shows in a browser yet; rendering arrives in M2. Everything in M1 runs from the terminal:
- `pnpm install`, then `pnpm test`: 1317 tests in about 10 s.
- `pnpm bench`: trace speed on movement_lab. Look for "box-trace average … PASS" and "GCs during timed loops: 0". `pnpm bench --strict` fails on a miss.
- `pnpm greybox`: rebuilds the 5 courses into `content/maps/`. `git status` stays clean because the output is byte-identical.
- **Long fuzz run:**
  - bash: `FUZZ_CASES=1000000 pnpm vitest run packages/tools/test/fuzz/trace-fuzz.test.ts`
  - PowerShell: `$env:FUZZ_CASES=1000000; pnpm vitest run packages/tools/test/fuzz/trace-fuzz.test.ts`
  - It takes about 40 s. Set `FUZZ_SEED` for a different stream.
- **See a guard work:**
  - Change a number in `packages/tools/src/greybox/courses/slide_lab.ts` and run `pnpm test`. The stale-map test fails with "run pnpm greybox and commit". Undo with `git checkout -- <file>`.
  - Or add `Math.sin(1)` to any file in `packages/shared/src`: the purity guard fails.
- **Read the courses:** `packages/tools/src/greybox/courses/*.ts`. Every feature has a named anchor, such as `step_18_base` or `water_deep`.
