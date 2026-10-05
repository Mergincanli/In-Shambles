# 10 — Testing & Performance

> Claude Code works best with a **verification loop**: a check it can run that proves the work is done. This doc defines those checks.

## 1. Test pyramid

| Layer | Tool | What | Where |
|---|---|---|---|
| Unit | Vitest | math, quantization, traces, pmove steps, damage rules, codecs | `packages/*/test` |
| Scenario (sim) | Vitest + greybox courses | movement feel targets (MV-xx), balance rules (BAL-xx) | `packages/shared/test/scenarios` |
| Parity / determinism | Vitest | client vs. server sim, recorded input streams | `packages/shared/test/parity` |
| Determinism vectors (D-016, D-017) | Vitest; real browsers from M2 | frozen input → output bits for dtrig (plus a digest of all 65536 `sinU16`/`cosU16` angles), quantizers, PRNG and hash, and for brush traces, `snapOrigin` and `pointContents` on a fixed world | `packages/shared/test/vectors`, JavaScript-only syntax with no imports (regenerate with `pnpm --filter @game/tools vectors`) |
| Property / fuzz (M1) | Vitest | trace properties P1–P7 against a SAT oracle over the courses and seeded synthetic worlds (no tunneling, startSolid/allSolid, no phantom hits, BVH = brute force, determinism, snap chains); a failure prints a case to paste into `regressions.test.ts`; `FUZZ_SEED` and `FUZZ_CASES` override the default 20k cases for long local runs | `packages/tools/test/fuzz` |
| Netcode integration | Vitest + in-process server + NetSim | NET-xx under profiles | `packages/server/test/net` |
| Load / soak | bots CLI | 16–32 bots, minutes to hours, metrics | `packages/tools/bots` |
| Perf benchmarks | `pnpm bench` | µs per op for hot paths | `packages/*/bench` |
| Manual playtest | checklist | feel sign-off, readability, fun | handoff notes |

**Golden data:** recorded UserCmd streams + expected end states live in `packages/shared/test/fixtures/`. When a deliberate tuning change alters results, regenerate the fixtures in a separate commit, with the decision-log entry referenced.

## 2. Suites and commands

| Command | Contents |
|---|---|
| `pnpm test` | everything fast (< 60 s target) |
| `pnpm test:movement` | MV-01…MV-20 (`docs/03` §8) |
| `pnpm test:balance` | BAL-01…BAL-11 (`docs/04` §13): every test whose name starts with `BAL-`, so each BAL test's top-level `describe` starts with its ID (`BAL-07: …`) |
| `pnpm test:net` | NET-01…NET-12 (`docs/05` §14), with profiles |
| `pnpm bench` | trace, pmove, snapshot build, codec, render-frame microbenchmarks |
| `pnpm bots --count N --profile P --minutes M --map X` | load/soak with a metrics summary (JSON + markdown) |
| `pnpm feel-report` | table of movement metrics vs. targets (also writes `reports/feel.md`) |
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
- **Allocation guards** (tests, since M1): the bench's GC count covers the trace categories only. `packages/tools/test/perf/` checks the other per-tick paths: 0 GCs and under 64 KB heap growth over 2e5 calls for the BVH queries, `snapOrigin` (all three outcomes), `quantizePlayerState`, the `PlayerState` ring, copy/equals and `sanitizeUserCmd`, run as native ESM in a child process (`node --import tsx`), since Vitest's module runner hides double boxing.

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
