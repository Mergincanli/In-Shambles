# 10 — Testing & Performance

> Claude Code works best with a **verification loop**: a check it can run that proves the work is done. This doc defines those checks.

## 1. Test pyramid

| Layer | Tool | What | Where |
|---|---|---|---|
| Unit | Vitest | math, quantization, traces, pmove steps on synthetic worlds, damage rules, codecs | `packages/*/test` (sim units in `packages/shared/test`, D-025) |
| Scenario (sim, D-025) | Vitest + the committed greybox courses (`content/maps`) through the scenario runner (`packages/tools/src/scenarios`: course loading, runner, scripted bots, metrics) | movement feel targets (MV-xx), the feel report, MV-19 build probes; balance rules (BAL-xx) | `packages/tools/test/movement` (`mv-NN-*.test.ts`), `packages/tools/test/reports` (the feel report, `packages/tools/src/reports`), `packages/tools/test/balance` |
| Parity / determinism (D-025) | Vitest | client vs. server sim, recorded input streams, MV-19 (repeat runs and bundled builds) | frozen vectors (pmove from M2) in `packages/shared/test/vectors`; MV-19 build probes and client-vs-server parity runs in `packages/tools/test` |
| Determinism vectors (D-016, D-017, D-022) | Vitest in Node; Vitest browser mode via `pnpm test:browser` (Chromium locally; Chromium, Firefox and WebKit in the CI `browsers` job) replays every `packages/shared/test/*-vectors.test.ts` unchanged | frozen input → output bits for dtrig (plus a digest of all 65536 `sinU16`/`cosU16` angles), quantizers, PRNG and hash, and for brush traces, `snapOrigin` and `pointContents` on a fixed world | `packages/shared/test/vectors`, JavaScript-only syntax with no imports (regenerate with `pnpm --filter @game/tools vectors`) |
| Property / fuzz (M1) | Vitest | trace properties P1–P7 against a SAT oracle over the courses and seeded synthetic worlds (no tunneling, startSolid/allSolid, no phantom hits, BVH = brute force, determinism, snap chains); a failure prints a case to paste into `regressions.test.ts`; `FUZZ_SEED` and `FUZZ_CASES` override the default 20k cases for long local runs | `packages/tools/test/fuzz` |
| Netcode integration (D-025) | Vitest + the real match code and client net code in process + NetSim | NET-xx under profiles | `packages/tools/test/net` (`net-NN-*.test.ts`); match unit tests stay in `packages/server/test` |
| Load / soak | bots CLI | 16–32 bots, minutes to hours, metrics | `packages/tools/bots` |
| Perf benchmarks | `pnpm bench` | µs per op for hot paths | `packages/*/bench` |
| Manual playtest | checklist | feel sign-off, readability, fun | handoff notes |

**Golden data:** recorded UserCmd streams + expected end states live in `packages/shared/test/fixtures/`. When a deliberate tuning change alters results, regenerate the fixtures in a separate commit, with the decision-log entry referenced.

## 2. Suites and commands

| Command | Contents |
|---|---|
| `pnpm test` | everything fast (< 60 s target) |
| `pnpm test:movement` | MV-01…MV-20 (`docs/03` §8): every test whose name starts with `MV-`, so each `mv-NN-*.test.ts` names its top-level `describe` after its ID (`MV-05: …`; guard: `packages/tools/test/guards/scripts.test.ts`). Runs with `--silent=false`, so each test's measured-vs-target line prints |
| `pnpm test:balance` | BAL-01…BAL-11 (`docs/04` §13): every test whose name starts with `BAL-`, so each BAL test's top-level `describe` starts with its ID (`BAL-07: …`) |
| `pnpm test:net` | NET-01…NET-12 (`docs/05` §14), with profiles; named like the MV tests (`net-NN-*.test.ts`, `describe("NET-03: …")`) |
| `pnpm test:browser` | the determinism and trace vectors in headless browsers (D-022): `BROWSERS` is a comma list of `chromium`, `firefox`, `webkit` (default `chromium`); `CHROMIUM_PATH` overrides the Chromium executable. Not part of `pnpm test` |
| `pnpm bench` | trace, pmove, snapshot build, codec, render-frame microbenchmarks |
| `pnpm greybox` | recompiles the greybox courses into `content/maps/`; `courses.test.ts` fails with "run pnpm greybox and commit" while a committed map is stale (`docs/07` §3) |
| `pnpm bots --count N --profile P --minutes M --map X` | load/soak with a metrics summary (JSON + markdown) |
| `pnpm feel-report` | table of the base movement metrics vs. targets on `movement_lab` (since M2, D-024); also writes `reports/feel.md`, git-ignored and byte-identical on every run |
| `pnpm balance-report` | HTK/TTK/DPS tables (`reports/balance.md`) |

## 3. Network profiles (shared by tests, bots and the in-game `net_profile`)

| Profile | One-way delay | Jitter | Loss | Dup | Reorder |
|---|---|---|---|---|---|
| `lan` | 0 | 0 | 0 | 0 | 0 |
| `wan-50` | 25 ms | ±3 | 0 | 0 | 0 |
| `wan-100-loss1` | 50 ms | ±8 | 1% | 0 | 0 |
| `wan-150-loss2` | 75 ms | ±15 | 2% | 0 | 0.5% |
| `bad-250-loss5` | 125 ms | ±40 | 5% | 1% | 1% |

**Gameplay changes must pass their tests under `wan-100-loss1`.** Netcode changes must pass under all profiles.

## 4. Performance budgets (requirements)

### 4.1 Server (Node, per match, 16 players, 60 Hz)

| Metric | Budget |
|---|---|
| Tick time p50 / p99 | ≤ 1.5 ms / ≤ 4 ms |
| GC pause (max) | ≤ 8 ms |
| Memory per match | ≤ 150 MB |
| Snapshot build per client | ≤ 50 µs |

### 4.2 Network (per client, 16 players)

| Metric | Budget |
|---|---|
| Down | ≤ 32 KB/s average, ≤ 48 KB/s peak |
| Up | ≤ 8 KB/s |
| Snapshot size | ≤ 1100 B (datagram-safe) |

### 4.3 Client

| Metric | Budget |
|---|---|
| Frame rate | ≥ 144 fps on a mid-range desktop GPU at 1080p "high"; ≥ 60 fps on integrated graphics at 1080p "low" |
| CPU per frame (game logic + interpolation + HUD) | ≤ 2 ms |
| Render submission | ≤ 4 ms |
| Draw calls | ≤ 300 typical scene |
| GC | no per-frame allocations in steady state (verify with the heap profiler; allocation-rate check in dev builds) |
| Input-to-photon | camera rotation applied the same frame as mouse input |
| Startup | first-match download ≤ 30 MB; main menu interactive ≤ 3 s on broadband (cached ≤ 1 s) |

### 4.4 Sim microbenchmarks

| Op | Target |
|---|---|
| `traceBox` on `movement_lab` | ≤ 1 µs average |
| `pmove` per player-tick (all mechanics) | ≤ 5 µs |
| Lag-comp rewind + hitscan vs. 16 players | ≤ 30 µs per shot |
| Codec encode/decode of a typical snapshot | ≤ 30 µs |

Budgets are checked by `perf-auditor` before closing a milestone. A regression > 20% needs a decision-log entry.

**How `pnpm bench` measures the trace** (`packages/tools/bench/trace.bench.ts`, since M1):
- **Workload:** `content/maps/movement_lab.cmap`, decoded and built as the game loads it. A seeded Mulberry32 draws 4096 cases per category before the clock runs, into typed arrays. Every case is built from a clear 1/32 u grid spot (`snapOrigin`) on the ground beside a random brush, for 60% of moves swept against a wall, step or slope first, with the standing or crouched hull. Categories, weighted by our ESTIMATE of one pmove player-tick (`docs/03` §3): hull moves ≤ 12 u (3), 0.25 u ground probes (2), 18 u step-up and step-down traces (2) and snap position tests (1; a position test is the zero-length box trace). Long rays (1024–8192 u) are timed but kept out of the average.
- **Timing:** 1e5 warm-up calls per category, in 100 short rounds so the loops are optimized as whole functions (a loop only ever optimized on-stack can box its doubles and allocate), then 1e6 timed calls per category with `process.hrtime.bigint()`. Results feed a printed sink. A `PerformanceObserver` counts GC events inside the timed loops: anything above 0 means a query allocates.
- **Report:** ns/op, BVH nodes and brushes tested per call, blocked share and GCs per category, then the weighted box-trace average against the 1 µs budget with PASS/FAIL. The exit code is 0 unless `--strict` is given and the budget or the GC count is missed. `--calls` and `--warmup` change the counts.
- **M1 result** (Node 22.22, Intel Xeon @ 2.10 GHz cloud VM, 3 runs): weighted average 238–338 ns, about a third of the budget (moves 310–359, ground probes 195–369, step traces 211–335, position tests 161–225, rays 507–605 ns; about 20 of 133 BVH nodes and 1.7 brushes tested per move), 0 GCs. Re-run on the reference machines in §5.
**How `pnpm bench` measures pmove** (`packages/tools/bench/pmove.bench.ts`, since M2 increment 3):
- **Workload:** 16 players on `movement_lab` (a full match), each starting at `info_player_start` or one of the course anchors and moved to the next one every 600 ticks, so the mix keeps meeting steps, stairs, slopes and walls. A seeded Mulberry32 draws 4096 ticks of sticky input before the clock runs: a new choice every 6–60 ticks, about 70% running forward, strafes, back-pedalling, walk, crouch (since M2 increment 5), held and re-pressed jumps, turning up to ±400 u16 a tick and looking up and down. The anchors include the pool and the ladder, so the mix swims (about 10% of player-ticks) and, rarely, climbs. Each player reads the table at its own offset. Events are collected as on the server; the trace log is off.
- **Timing:** 12500 warm-up ticks in 100 short rounds, each followed by one scripted 90-tick ladder climb from `ladder_base` (random input reaches the ladder in only about 0.2% of player-ticks, too rarely for V8 to optimize the ladder move), then 12500 timed ticks (2e5 player-ticks) from a fresh state with `process.hrtime.bigint()`, and a GC count over the timed loop. `--pmove-ticks` and `--pmove-warmup` change the counts. The warm-up is longer than the trace bench's relative to the timed run: the rarely run paths (landings, steps, corner stops, water and ladder transitions) need it before V8 optimizes them, and until then they box doubles. It was 6250 ticks until M2 increment 5, whose larger mix left one or two GCs in the timed loop at that length.
- **Report:** the mix (shares of grounded, swimming, crouched and ladder ticks; jumps, steps, landings and snap fallbacks per 1000 player-ticks), ns per player-tick against the 5 µs budget with PASS/FAIL, and the GC count. `--strict` fails on either budget or any GC.
- **M2 increment 3 result** (Node 22.22, the same cloud VM, 3 runs): 1.54–1.75 µs per player-tick (walk, air, jump, step-slide, two ground traces and the snap; crouch, water and ladder join in increment 5), 0 GCs; mix 59% grounded, about 8 jumps, 0.8 steps and 8.6 landings per 1000 player-ticks, no snap fallbacks.
- **M2 increment 5 result** (Node 22.22, Intel Xeon @ 2.80 GHz cloud VM, 3 runs): 2.25–2.46 µs per player-tick with the crouch, water and ladder pre-checks (three water samples before and after the move, a ladder probe) and the new modes, 0 GCs; mix 64% grounded, 9.9% swimming, 12.2% crouched, 0.17% on the ladder, about 5.5 jumps, 0.8 steps and 6.5 landings per 1000 player-ticks, no snap fallbacks. The increment 3 code measured 1.57 µs on the same VM, so the pre-checks and modes cost about 0.7–0.9 µs, well inside the budget; the design's fallbacks (reusing the stored water level for the pre-check, skipping the ladder probe away from ladder brushes) are not needed.

- **Allocation guards** (tests, since M1): the bench's GC counts cover the trace categories and the pmove loop. `packages/tools/test/perf/` checks the per-tick paths on their own: 0 GCs and under 64 KB heap growth over 2e5 calls for the BVH queries, `snapOrigin` (all three outcomes), `quantizePlayerState`, the `PlayerState` ring, copy/equals, `sanitizeUserCmd`, the pmove params refresh and steps, whole pmove ticks (a walled room with a slope, a rotated wall and steps; events and the trace log attached; params refreshed from the registry with fractional values), and pmove ticks in the M2 modes (ladder climbs, turns and jump-offs, swimming, sinking and diving, crouching; since M2 increment 5), run as native ESM in a child process (`node --import tsx`), since Vitest's module runner hides double boxing.

## 5. Reference machines (fill in)

| Role | Machine |
|---|---|
| Mid-range desktop | TBD (Mustafa's main PC) |
| Low-end | TBD (an integrated-GPU laptop) |
| Server reference | TBD (a small cloud VM, 2 vCPU) |

## 6. Manual playtest checklist (each milestone that touches feel)

- [ ] Strafe/circle jumping feels right; speed builds as expected.
- [ ] Wall jumps: chimney, angled speed kicks, descent breaking.
- [ ] Slides: entry reliability, distance, aiming while sliding.
- [ ] Ledge grabs catch reliably; no "sticky" walls.
- [ ] At `wan-100-loss1`: no rubber-banding; remote players smooth; hits register where aimed.
- [ ] HUD readable; hit feedback clear; footsteps directional.
- [ ] Notes and any cvar changes recorded in the handoff.
