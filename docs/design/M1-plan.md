# M1 plan: simulation core (headless)

> **Status:** the M1 implementation plan as Mustafa approved it (2026-10-05), kept so that citations such as "M1 plan, open question 1", "Risk 2 of the M1 plan" or "increment 8" in code, tests and `docs/11` resolve. It is a record, not a spec: the numbered docs and the decision log win where they differ. The open questions' defaults were used; questions 2–4 are left to M2. Departures while building M1 are logged, notably D-020 (the cmap hash covers the whole file with its own field read as zero, not bytes [32, EOF)). The design it builds on is `docs/design/M1-design.md`.

## Context
M0 gave us the monorepo and guard tests. M1 builds the deterministic foundation every later milestone stands on: tick time, exact math, quantization, PRNG, brush collision (traces, BVH), the compiled map format (cmap) and the greybox courses (`docs/09` M1, `prompts/PROMPTS.md` M1). There is no pmove, rendering or networking yet.

**Acceptance (`docs/09` M1):**
- trace unit tests: start-solid, all-solid, grazing edges, corners, epsilon behavior;
- fuzz test: random box sweeps never tunnel through brushes;
- cmap compile is byte-identical when run twice;
- box trace ≤ 1 µs average on `movement_lab`.

**Your choices:**
- render surfaces in the M1 compiler;
- compiled `.cmap` files committed to `content/maps/`;
- full end-of-milestone review, like M0.

**Branch:** `claude/blissful-knuth-055dcn` (reset to `main` after the M0 merge). One commit per green increment, then a PR to `main` at the end.

## Spec changes you approve with this plan
These are written into the docs during increment 10, each with a decision-log entry.

1. **D-016 — Deterministic math.**
   - ECMAScript lets engines approximate `sin`, `cos`, `atan2`, `pow`, `**`, `exp`, `log`, `hypot` and similar functions, so Chrome, Firefox and Safari can return different bits.
   - These are banned in `shared` and in compiler code that produces output. The purity guard enforces it.
   - Safe: `+ − * / %`, `sqrt`, `fround`, `round`, `floor`, `ceil`, `trunc`, `abs`, `sign`, `min`, `max`, `imul`, bitwise ops.
   - Our own `dsin` and `dcos` are built from exact operations, with a u16 angle table. `dpow` follows in M4 for the fall-damage curve.
2. **D-017 — Trace epsilon, touching, and snapping.**
   - Traces stop 1/32 u (ε) short of a surface. A box that exactly touches a brush counts as outside.
   - End-of-tick snapping goes to the **nearest clear** 1/32 grid point, not just the nearest one: try the rounded point, then the 8 cell corners in order of distance, then keep last tick's origin.
   - Why: plain rounding drifts a player sliding along slopes or rotated walls into solid within tens of ticks.
   - Docs: `docs/05` §4.1 and `docs/03` §6 change from "nearest 1/32 u" to "nearest clear 1/32 u grid point".
   - **Map metric consequence:** a crouched player rests at floor + 1/32, so a 40 u gap blocks. Slide gaps become 41/42/44 u. `docs/07` §6 changes "40–44" to "41–44", and §3's slide_lab changes "40 u high" to "41–44 u high".
3. **`docs/07` §2, cmap layout.**
   - `contentHash` moves into the binary preamble, so the hash never covers itself. The header becomes the preamble plus the JSON.
   - The BVH is built at load time, which §2 already allows.
4. **`docs/06` §5, `math/vec3`.**
   - Vectors are `Float64Array`s with out-params, plus named per-module scratch vectors instead of a general pool.
   - Why: a pool adds bookkeeping and aliasing bugs, and per-module scratch is equally allocation-free.
5. **CLAUDE.md.**
   - `pnpm bench` stops being a stub.
   - New command: `pnpm greybox` recompiles the courses into `content/maps/`.

## Files

**`packages/shared/src`** (pure TS, no DOM or Node APIs)
- `time.ts`: `TICK_RATE = 60`, `TICK_DT`, tick and ms helpers.
- `math/`
  - `vec3.ts`: `Vec3 = Float64Array`, out-param ops.
  - `plane.ts`, `aabb.ts`
  - `quant.ts`: origin 1/32, velocity 1/16, u16 angles, stamina hundredths.
  - `dtrig.ts`: D-016 sine and cosine, plus `sinU16`/`cosU16`.
  - `angles.ts`
- `rng/`
  - `mulberry32.ts`
  - `hash32.ts`: Murmur3 x86_32, shared with the cmap hash.
- `sim/`
  - `playerState.ts`: PlayerState, copy, equals, quantize, `PlayerStateRing(128)`.
  - `usercmd.ts`: UserCmd, button bits, `sanitizeUserCmd`.
  - `hull.ts`: standing and crouched hulls from `docs/03` §2.
- `world/`
  - `contents.ts`: SOLID, PLAYERCLIP, WATER, LADDER, SLICK, NODAMAGE, TRIGGER, NODRAW; surface flags.
  - `collisionWorld.ts`: typed-array brushes and planes.
  - `polygonize.ts`
  - `trace.ts`: `traceBox`, `traceRay`, `traceBoxBrute`, `positionTest`, `pointContents`, `boxContents`, `snapOrigin`, `TraceResult`.
  - `bvh.ts`
  - `cmap.ts`: types, decoder, `CmapError`, `buildCollisionWorld`.
  - `cmapHash.ts`

**`packages/tools/src/greybox/`**
- `brushCompiler.ts`:
  1. round planes to f32;
  2. polygonize and validate;
  3. add axial bevels, rounded outward;
  4. compute bounds;
  5. build render surfaces per material.
- `cmapEncode.ts`: canonical, ASCII-only JSON plus little-endian sections.
- `MapBuilder.ts`: `box`, `stairs`, `ramp`, `slope`, `wall`, `volume`, `spawn`, `timer`, `anchor`.
- `courses/{movement_lab,jump_lab,slide_lab,fall_tower,arena_greybox}.ts`
- `cli.ts`: writes `content/maps/*.cmap`.

**Other files**
- `packages/tools/bench/`: `run.ts` and `trace.bench.ts`.
- Root: `.gitattributes` gets `*.cmap binary`. Root scripts `greybox` and `bench` (both `pnpm --filter @game/tools --fail-if-no-match …`).
- `tools` adds the `tsx` devDependency, MIT and already in the lockfile. No new dependencies.
- Reused M0 code:
  - `tools/src/paths.ts` (`fromRoot`);
  - `tools/src/code/scan.ts` for the extended purity guard;
  - `shared/src/debug/assert.ts` (`DEV_ASSERT` for finite inputs).

## Key design

### Traces (`world/trace.ts`)
- **Setup.** Per trace, center offset `o = (mins + maxs)/2` and half extents `h = (maxs − mins)/2`. Per plane: `ext = Σ|n_k|·h_k`, `sd = n·S′ − d − ext`, `ed = n·E′ − d − ext`.
- **Per-plane rules:**
  - **Separating:** `sd ≥ 0` and (`ed ≥ sd` or `ed ≥ ε`). Skip the brush.
  - **Entering:** `t = (sd − ε)/(sd − ed)`. Keep the maximum, with a strict `>`.
  - **Leaving:** `sd < 0` and `ed > 0`. `t = sd/(sd − ed)` with no ε. Keep the minimum.
  - **No entering plane:** startSolid; also allSolid if every `ed < 0`.
- **Hits.** A brush is hit when `tEnter < tLeave`, at `t = max(0, tEnter)`. Ties go to the lowest brush index, so the result doesn't depend on BVH order.
- **No penetration.** Entering times use ε and leaving times don't, which gives zero penetration in exact math.
- **endpos.** Copy E exactly when the fraction is 1, and copy S when it is 0.
- **Reported plane.** The unexpanded plane. Faces are stored before bevels.
- **Zero-length traces** are `positionTest`. `traceRay` is the same code with `h = 0`.
- **`snapOrigin(world, exact, mins, maxs, mask, prevOrigin, out)`:** the D-017 snap, tested against world brushes only.

### Bevels
- Axial bevels (the brush's bounding-box planes) are added after polygonizing, with f32 rounding outward.
- They make every M1 shape exact: axis-aligned boxes, boxes rotated around Z, and axis-aligned wedges.
- The builder throws on ramps that aren't aligned to an axis. Edge bevels arrive in M5.

### BVH
- **Build:** at load time, binned SAH with 16 bins, leaves of at most 2 brushes, a median-split fallback and a depth cap of 48. Typed-array layout, depth-first.
- **Traversal:** iterative, with an `Int32Array(64)` stack.
  - Node test: query-box overlap with a 1/16 margin.
  - Traces longer than 64 u also get a slab test.
  - Near child first.
- **Check:** `traceBox` must equal `traceBoxBrute` bit for bit.

### cmap v1
- **Preamble:** `"CMAP"`, version, jsonByteLength, sectionCount, hashLo, hashHi (a 64-bit hash of bytes [32, EOF)), totalByteLength, reserved.
- **Section table**, then ASCII JSON (bounds, compiler {name, version}, entities, materials, name, units, up).
- **Sections:**

| Tag | Record size | Contents |
|---|---|---|
| `PLNS` | 16 B | f32 plane: nx, ny, nz, d |
| `PLSF` | 8 B | surfaceFlags, material |
| `BRSH` | 40 B | brushes |
| `SURF` | 24 B | render surfaces |
| `VTXS` | 32 B | vertices: position, normal, uv0 |
| `IDXS` | 4 B | u32 indices |

- **Decoder:** fully validated. It throws `CmapError` at load time.

### Determinism
- **Planes:** f32 on disk, widened exactly to f64 at load.
- **Hot-path objects:** fixed-shape classes. Scalar fields are integers only.
- **Quantize:** `(Math.round(x·32) + 0)/32`. The `+ 0` normalizes −0 to +0. Values are clamped to the codec ranges.
- **Test vectors:** input bits → output bits for dtrig, quant, rng and traces. They are committed to `packages/shared/test/vectors/` so M2 can replay them in real browsers.

### Courses
- Each course follows `docs/07` §3.
- **Named anchors** (`info_target`) let tests refer to places by name instead of coordinates.
- **`slope({normalZ})`** computes the rise with `sqrt`, for slope normals with z = 0.69, 0.71 and 0.8.
- **Kick lanes** are rotated around Z by closed-form trig, e.g. sin15° = (√6 − √2)/4.
- **Ladders** get both a LADDER volume and a LADDER surface flag on the wall face; M2 picks one.
- **Water** is 12, 36 and 128 u deep.
- **movement_lab** has a roughly 6144² flat area with floor tiles every 128 u.
- **arena_greybox** has 16 `info_player_start` plus 8 red and 8 blue spawns.

## Increments (each ends with typecheck + lint + test green, then a commit)

| # | Commit | Contents and tests |
|---|---|---|
| 1 | `feat(shared): tick time, deterministic math, quantizers and PRNG (D-016)` | time, vec3, plane, aabb, quant, dtrig, angles, mulberry32, hash32. Fixed test vectors (dtrig within 2 ulp of reference values; exact cardinal angles and symmetry; Murmur3 published vectors). Purity guard extended with the banned Math functions and `**`, plus mutation probes. |
| 2 | `feat(shared): PlayerState, state ring and UserCmd` | copy, equals, quantize (idempotent, −0, clamps, NaN), ring with stale-tick detection, sanitize (clamps, unknown bits masked). |
| 3 | `feat(shared): collision world, contents and brush polygonizer` | Polygons match each constructor's reference vertices and the triple-plane-intersection oracle. Validation errors for degenerate brushes. |
| 4 | `feat(shared): brush traces, position tests and snapOrigin (D-017)` | Brute-force trace. **Acceptance tests:** start-solid, all-solid, grazing faces and edges, corners, ε behavior (rests at 1/32; touching = outside), multiple brushes, contents masks, zero-length traces, rays. snapOrigin on slopes and rotated walls. |
| 5 | `feat(shared): SAH BVH for traces` | BVH equals brute force bit for bit on synthetic worlds; deterministic build. |
| 6 | `feat(shared,tools): cmap v1 format` | Encoder and decoder round trip; hash; every decoder rejection path (bad magic, version, bounds, alignment, counts, indices, non-finite values, hash). `.gitattributes`. |
| 7 | `feat(tools): greybox brush compiler and MapBuilder` | Bevels, bounds, render surfaces, off-axis ramp rejection, canonical JSON. |
| 8 | `feat(content): greybox courses compiled to cmap` | The 5 courses; `pnpm greybox`; committed `.cmap` files. **Acceptance test:** compiling twice gives identical bytes, which also match the committed file ("run pnpm greybox and commit"). Sanity tests: valid brushes, bounds within ±16384, spawns clear with ground within 1 u, spawns ≥ 64 u apart, anchors exist, required features present. |
| 9 | `test(tools): trace fuzz properties` | **Acceptance test.** About 20k seeded cases over the courses and synthetic worlds, checked against a SAT oracle. P1 no tunneling, P2 startSolid correct, P3 allSolid correct, P4 no phantom hits (catches missing bevels), P5 BVH equals brute force, P6 same case gives the same bits, P7 200-step snap chains never go solid. Failures print the seed and the inputs as f64 hex. `FUZZ_SEED` and `FUZZ_CASES` override. |
| 10 | `feat(tools): pnpm bench trace microbenchmark` + `docs: M1 spec updates (D-016, D-017)` | **Acceptance test:** bench on movement_lab with 1e5 warm-up calls, then 1e6 timed calls from a seeded mix of moves, ground probes, step traces, position tests and rays. Reports ns/op per kind and the box-trace average against 1 µs, and the GC count during the loop (expect 0). Doc updates from the section above; roadmap status. |

## ESTIMATE values and design constants
- **ε = 1/32 u:** a design constant (D-017), not a measured UrT value. It is a shared constant rather than a cvar, because traces must match on client and server and ε is not a feel knob.
- **Player hulls:** `docs/03` §2 values as labelled there. They are only used by course and fuzz tests in M1.
- **Course dimensions:** design values from `docs/07` §3 and §6 (gaps 64–320, ledges 24–120, chimney 64 u, kick lanes 15/30/45/60°, curb 24, fall platforms 128–1024). The extras (lab area, water depths, 41/42/44 gaps, 48 u tunnel) are ours. None of them are ESTIMATEs of the original game.
- **No movement cvars yet;** `pm_*` arrives in M2.

## Open questions (defaults used unless you say otherwise)
1. **Kick-eligible:** `docs/05` lists "kick-eligible" as a button, but it reads like derived state. Default: leave it out of M1's button bits (4 bits stay spare) and settle it in M4.
2. **"Starts in solid" in `docs/03` §4.8:** does it mean startSolid or allSolid? M2 question; M1 reports both.
3. **Ladders:** surface flag or LADDER volume? M1 emits both; M2 decides.
4. **Rounding biases** (documented in `docs/03` §6):
   - Stamina rates come in steps of 0.6/s at 60 Hz.
   - Per-tick position rounding can add about 0.2% distance at 320 u/s. Feel tests should measure velocity, not distance.

## Risks
1. **Players stuck on slopes from snap drift.** Fixed by D-017 and checked by fuzz P7.
2. **Cross-engine float differences.** Covered by the purity guard, dtrig and committed test vectors (browser replay in M2).
3. **Trace speed in V8.** Mitigated by SAH from the start, fixed-shape classes and the bench's GC counter. First fallback: a per-plane axis tag.
4. **ε changes map metrics** (40 u gaps block). Covered by the docs updates above.
5. **The fuzz oracle depends on the polygonizer.** Mitigated by the triple-intersection cross-check, which runs first.
6. **Committed binary churn and line-ending damage.** Mitigated by `*.cmap binary`, `compiler.version` and a clear recompile message.
7. **No edge bevels yet.** The builder rejects shapes that would need them, and P4 checks in both directions.
8. **TS 7 typing friction with `Float64Array`.** Handled with one `Vec3` alias and a factory.

## Verification
1. `pnpm typecheck && pnpm lint && pnpm test` passes after every increment, and again on a fresh clone at the end.
2. Acceptance:
   - trace unit tests (increment 4);
   - fuzz with the default seed, plus a long local run (`FUZZ_CASES=1000000`);
   - `pnpm greybox` twice, then `git status` shows no changes;
   - `pnpm bench` average ≤ 1 µs with 0 GCs. Numbers go into the handoff, with a note to re-run on your laptop.
3. Mutation probes:
   - drop a bevel → P4 fails;
   - remove the ε → the rest test fails;
   - add `Math.sin` to shared → the guard fails;
   - change one byte in a `.cmap` → the hash check fails.

## Close-out (full review, like M0)
- **Review workflow:**
  - an acceptance re-run;
  - about 7 review dimensions: determinism (netcode-reviewer), trace and BVH correctness, cmap and compiler, tests and fuzz quality, spec conformance, perf-auditor, clean-room-auditor;
  - 3 skeptics per finding and a final critic.
- **Cost:** this is the expensive part. I'll run it once, then fix the findings with targeted follow-ups instead of re-runs.
- Then `/handoff`. I show you sections 1, 2, 8 and 9 and ask before committing the docs.
- On your OK: push, open the PR, watch CI.
