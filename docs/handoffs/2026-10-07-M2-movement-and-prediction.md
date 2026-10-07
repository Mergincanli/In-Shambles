# Handoff — 2026-10-07 — M2 — Movement and prediction

> File name: `docs/handoffs/YYYY-MM-DD-M#-<slug>.md`. Written by `/handoff` at the end of every session. The next session starts by reading the newest one (`/start-session`).

## 1. Summary (3–5 lines)
M2 makes the game playable: you run around `movement_lab` in the browser with Quake 3-style movement (walk, air, strafe-jumping, steps, slopes, crouch, water, ladders).

Every move already goes through a server running in a Web Worker. The client predicts its own player, corrects only when the server disagrees, and stays smooth under the simulated network profiles.

New pieces:
- protocol v1 (bit-packed INPUT and SNAPSHOT);
- loopback and Worker transports, plus a seeded network simulator;
- an environment-agnostic match loop;
- a Three.js greybox renderer;
- input, console, HUD and debug draw;
- the movement (MV) and netcode (NET) tests on the real courses;
- browser replays of the determinism vectors.

Each of the 12 increments was built, reviewed from 4–5 angles and fixed before its commit. The close-out review confirmed 24 findings (3 major) and all are fixed. Two later fixes harden the e2e smoke test and make the input buffer adapt to long or irregular frames (so a slow or hitching browser no longer starves the server and gets corrected).

## 2. Milestone status
- Milestone: M2 — Base Q3 movement + client shell + Worker server + prediction → ☑ done.
- Acceptance criteria:
  - ✅ **Movement tests** MV-01, 03, 04, 05, 06, 07, 08, 17 (basic), 18 (basic) and 19 pass (`pnpm test:movement`, 55 tests). Measured:
    - MV-01: 320.000 u/s at 0.6 s.
    - MV-03: walk 160.000, crouch 80.000.
    - MV-04: apex 45.625 u at 60 Hz and 45.406 at 120 Hz (target 45.56 ± 0.5).
    - MV-05: 16 and 18 u steps climbed, 19 blocked.
    - MV-06: 0.71 and 0.80 slopes walkable with no stalls; you slide down 0.69.
    - MV-07: 319.966 u/s over 20 straight hops (cap 326.4).
    - MV-08: strafe-jump landings 491 → 1220 u/s, rising every hop.
    - MV-17: water levels 1/2/3, sink 60, swim 160.
    - MV-18: ladder 160 u/s at any pitch, top in 3.08 s, detaches at ±70°, push-off 150.
    - MV-19: 10k ticks are identical across two runs, an esbuild build and a minified Vite build.
  - ✅ **NET-03:** 0 corrections on a lossless loopback over a 3600-tick mixed session, including out-of-range input, wan-50, and a live `set pm_gravity 400`.
  - ✅ **Smooth at `wan-150-loss2`.** Automated as NET-04 (basic) on every profile: under 1 correction/s, mean under 2 u, render offset under 8 u, no frame-to-frame jumps. A new NET-04 block uses browser-like frame timing: 60 fps with hitches, 33–83 ms frames, 50–83 ms frames. Before the input-buffer fix it showed up to 8 corrections/s and errors up to 23 u; now it has 0 corrections on wan-50, wan-100-loss1 and wan-150-loss2. ⏳ Still to do: your own manual check on a laptop (§9).
  - ✅ **`pnpm feel-report`** prints the base metrics: 17 of 17 checked metrics meet target, and it writes `reports/feel.md` (git-ignored).
  - ✅ **Determinism vectors replay bit for bit in browsers.** Chromium passes locally. The one-file vectors page passed every table on your phone (Mustafa, 2026-10-07). Firefox and WebKit passed the trace, determinism and pmove vectors in the CI `browsers` job on the M2 PR's first run (2026-10-07), which also ran the e2e smoke test green on a GitHub runner.

## 3. What was built (by package)
- `shared/`:
  - `sim/pmove/`, the base pipeline (`docs/03` §3–§4, D-023):
    - command scale, friction, accelerate, clip, slide move, step-slide, ground trace;
    - walk and air moves, edge-triggered jump (`pm_autoHop`);
    - crouch with a stand test, swim and ladder moves (D-024).
    - Each tick ends with `snapOrigin`, then `quantizePlayerState`.
    - `PmoveParams` refreshes from the cvar registry only when its `version` changes.
    - Events (step, jump, land) and the trace log are output only.
    - No new `PlayerState` fields.
  - `net/`:
    - LSB-first `BitWriter`/`BitReader` with a sticky error flag;
    - protocol v1 messages: HELLO, WELCOME, READY, INPUT (4 cmds, 55 B), SNAPSHOT (42 B), PING, PONG, CVARS, CMD, PRINT, KICK. Decoders return false instead of throwing (D-026);
    - the replicated cvar block and its hash (D-027);
    - `createLoopbackPair` and `NetSimTransport` (seeded; delay, jitter, loss, duplication, reorder), and `NET_PROFILES` (D-028).
  - Also new: the cvar registry's `version` counter, and eye heights 26/12 in `sim/hull.ts`.
- `server/`: `src/match/`, the environment-agnostic match:
  - `LoopHost`, and `startMatchLoop`: an accumulator that catches up at most 5 ticks.
  - `Match.tick` with per-client `InputQueue`s. A missing cmd repeats the last one with attack cleared and is counted as starved.
  - Snapshots carry `lastProcessedCmdTick` and the input-buffer health.
  - CMD `set`/`reset`/`toggle` on replicated cvars, broadcast back as CVARS with an effective tick. The Worker client is admin.
  - Spawns rest at floor + ε.
  - Its own `tsconfig.match.json` and a purity guard keep Node and DOM APIs out.
- `client/`:
  - `src/net/` (DOM-free, exported as `@game/client/net`):
    - connection and handshake;
    - `ClientClock`: server-tick-space prediction, the RTT lead plus the input buffer, re-anchored in steps;
    - `Predictor`: exact compare, re-simulation, a 32-entry correction log;
    - the render offset, stats, `PortTransport` and the scripted bots.
  - `src/worker/`: the server Worker over `MessageChannel` ports.
  - `src/render/`:
    - `space.ts`, the only coordinate conversion;
    - the world mesh with procedural grid textures;
    - Hor+ camera, step and view-height smoothing, debug draw.
  - `src/input`, `src/console`, `src/hud`:
    - pointer lock with raw input when available;
    - `KeyboardEvent.code` binds;
    - the Backquote console;
    - speedometer, netgraph, renderer stats;
    - settings saved in the browser.
  - The phone vectors page, built as one self-contained HTML file.
  - The e2e smoke test (`packages/client/e2e/`).
- `tools/`:
  - the scenario runner and bots (hold, hop, strafe, circuit);
  - MV-01..19 and NET-01/03/04 tests on the real courses;
  - `pnpm feel-report`;
  - pmove and codec benches;
  - pmove determinism vectors;
  - native-ESM allocation workloads (pmove modes, scenario, codec, transport, match, predict);
  - guards for the MV/NET naming and the suite scripts.
- `content/`:
  - The courses were recompiled with `compiler.version` 2: the ladder is a `SURF_LADDER` face with a rung texture, and the LADDER volume is gone (D-024).
  - `LICENSES.md` lists three.js; its notice ships with the build.
- Docs:
  - D-022 to D-028.
  - `docs/03` §2.3 (new ESTIMATEs), §3, §4.x.
  - `docs/05` §2, §3.1, §3.5–§3.6, §5, §8, §13.
  - `docs/06` module map, §6 console, §7 client cvars.
  - `docs/10` §1, §3, §4.
  - The plan and design records in `docs/design/`.
  - CLAUDE.md and README commands, and the "Try it" section.

## 4. Verification
- **Checks on the final tree** (`f2db714`): `pnpm typecheck` and `pnpm lint` clean; `pnpm test` 131 files, 2295 tests in about 40 s; `pnpm test:net` 89 tests; `pnpm test:movement` and `pnpm test:net` green; `pnpm test:browser` (Chromium: vectors plus e2e) green. With 2 of 4 cores busy, the e2e passed 17 of 18 runs (see §7).
- **Fresh clone at `da75565`** (before the review fixes): `pnpm install --frozen-lockfile`, typecheck, lint, test, build and every acceptance command pass.
- **Bench** (Node 22.22, Xeon 2.8 GHz, 4 vCPU; 3 runs, all PASS, 0 GCs):
  - box trace 341–358 ns (budget 1 µs);
  - pmove 2.11–2.25 µs per player-tick (budget 5 µs);
  - SNAPSHOT encode + decode 0.73–0.76 µs (budget 30 µs);
  - INPUT 1.19–1.24 µs.
- **NET-04 (basic), headless, 144 Hz frames:**
  - lan and wan-50: 0 corrections.
  - wan-100-loss1: 0–1 corrections a minute.
  - wan-150-loss2: 0–12 a minute (≤ 0.20/s), max 0.94 u.
  - bad-250-loss5: 3, all ≤ 0.03 u.
  - Browser-like frames (the new block, 18 runs, seeds 1–2): 0 corrections in every run and no starved tick once moving. Over seeds 1–10 (90 runs): at most 1 correction per run, under 0.25 u. Cost: 1.3–4.4 ticks (22–73 ms) more input delay, only while frames are irregular. 144 Hz runs are unchanged.
- **Build:** client index 657 kB (176 kB gzip), server Worker 66 kB, movement_lab.cmap 117 kB; Node server `dist/main.js` 17 kB.
- **Course content hashes:** movement_lab d5048ad19a2add54, jump_lab bb0867d22f3ac65c, slide_lab 77aa38d807f7f8ef, fall_tower 86df048c4a5057f5, arena_greybox 990efb80e478cd6c. `pnpm greybox` is byte-identical twice.
- **Reviews:**
  - **Per increment:** 4–5 reviewers each (spec, correctness, determinism/performance, tests, plus `movement-reviewer` or `netcode-reviewer` where relevant), then an integrator who reproduced each finding before fixing it.
  - **Close-out:**
    - an acceptance re-run on a fresh clone;
    - 7 lenses: `netcode-reviewer`, `movement-reviewer`, `perf-auditor`, `clean-room-auditor`, client, tests, spec and docs;
    - 40 findings after merging duplicates (3 major, 26 minor, 11 nits), plus 1 from a completeness critic;
    - 3 skeptics for each of the 29 non-nit findings: 24 confirmed (the 3 majors among them), 5 refuted;
    - the confirmed findings, the critic's finding and the plainly correct nits were fixed;
    - all fixes in 11 commits (`250475b` … `2ad4c7f`), then the e2e fix (`73af75e`) and the input-buffer fix (`f2db714`).
  - **`clean-room-auditor`:** three.js was missing from `LICENSES.md` and its notice from the build. Both fixed.
  - **`perf-auditor`:** one-off V8 warm-up transient (below). It is documented, and the fix is planned for M3.
  - **`netcode-reviewer`:** unbounded receive queues (now capped), prediction past the server's input horizon (now stopped), e2e timing blind spots (now checked per frame).

## 5. Decisions and deviations
- **New decisions** ([decision log](../11-decision-log.md)). You approved all seven with the plan; each was extended in place as the increments landed:
  - **D-022:** browser determinism replay: Vitest browser mode, the CI `browsers` job, the phone page.
  - **D-023:** pmove contract. "Starts in solid" = allSolid; slick or nodamage = face flag or brush contents; crouch-blocked; `dt` as a parameter; events outside `PlayerState`. Accepted notes on the crest kick-off and steep toes.
  - **D-024:** ladders by a `SURF_LADDER` face probe, water sampled at three heights, swim up and down, a slow sink.
  - **D-025:** course-based tests live in `@game/tools`.
  - **D-026:** protocol v1 and transports.
  - **D-027:** replicated cvars with an effective tick; the Worker client is admin.
  - **D-028:** M2 clock and NetSim. Extended at close-out with the **adaptive input buffer**: the clock now steers the lowest buffer health of the last 1.5 s instead of its average. It grows fast (once the dips are a pattern) and shrinks slowly (after 4 s), and is capped at 8 extra ticks.
- **Deviations from the approved plan:**
  - The prediction stops 64 ticks past the newest snapshot (the server's input horizon) instead of owing the time forever.
  - The e2e smoke test judges resyncs and starved cmds against measured frame gaps instead of requiring 0 everywhere. SwiftShader's frame gaps make a blanket 0 a timing lottery (`docs/10` §2).
  - `cl_inputBuffer` keeps its name and default (2). It now means the buffer kept at the health's low point; the average grows by the measured spread (D-028).

## 6. Tuning changes
| Cvar | Old | New | Reason |
|---|---|---|---|
| `pm_ladderScale` | — | 0.5 | New ESTIMATE (D-024): ladder speed = run speed × this |
| `pm_ladderFacing` | — | 0.5 | New ESTIMATE: stay attached while facing the ladder this much |
| `pm_ladderReach` | — | 2 u | New ESTIMATE: forward probe length |
| `pm_ladderJumpPush` | — | 150 u/s | New ESTIMATE: jump-off push along the ladder normal |
| `pm_waterSinkSpeed` | — | 60 u/s | New ESTIMATE: sink speed with no input |
| `cl_*`, `sensitivity`, `m_yaw`, `m_pitch` | — | see `docs/06` §7 | New client settings (not replicated) |
| `cl_inputBuffer` | 2 (average target) | 2 (low-point target, plus 0–8 adaptive) | D-028: bursty frames no longer starve the server |

## 7. Known issues / risks
- **Questions for you.** Defaults are in place.
  1. **Ladder from the top:** walking back off a ladder's top edge drops you; it can't be mounted from above. Options are in D-024. (M4 or now)
  2. **Crouched air strafing:** crouching in the air cuts the air wish speed to run × `pm_duckScale` as `docs/03` §4.1/§4.5 are written. That weakens crouch-jump strafing and every M4 power-slide approach; the Q3 lineage applies the crouch factor on the ground only. Keep it or change the spec? (before M4)
  3. **Jumping at a ladder's foot** (D-024, `docs/03` §4.14):
     - With forward held, a jump pushes you off the ladder instead of jumping.
     - A standing jump facing the ladder is caught on the next tick, and you hang about 35 u up until you press back or jump.
     - The candidate rule: while rising from a ground jump, attach only with forward held.
  4. **Crest kick-off:** at the top of a 0.71 slope at full run, a few percent of approaches pop into one short hop (up to 35 u). This follows the kick-off rule as written (D-023). Keep or suppress? (feel decision)
  5. **MV-09 air acceleration** is tuned with the M4 movement set.
  6. **Cheat flags:** `r_debug*` and `cl_thirdPerson` are free to use in M2. They need a CHEAT flag once there is a real server (M3).
  7. **Flush pool rims** trap a bobbing swimmer until the M4 water-jump (D-024); maps need a shallow exit or a low rim.
- **Planned for M3:**
  - the deterministic pmove primer (the warm-up transient below);
  - smooth clock dilation (NET-07);
  - the < 20 fps clock limit;
  - the TELEPORT flag for respawns;
  - the inactivity timeout and the strike threshold;
  - Node-server cvar authorization;
  - an input rate limit that allows the 64-packet startup burst (or a batched fill, D-028).
- **Risks:**
  - **Learning glide:** when frames turn bad while you move fast, the clock needs about 1.4 s to learn the new rhythm. Until then there are 0–9 small corrections, then one forward glide of 22–57 u over 100 ms. It happens once per change of frame rhythm. Smooth dilation (NET-07, M3) will hide it.
  - **e2e under heavy load:** with 2 of 4 cores busy, 1 of 18 e2e runs had a hard resync in a normal-length frame while moving, which the smoke test rejects. The clock before the fix passed 9 of 9 loaded runs; the difference isn't significant. If CI shows it, the likely cause is the Worker server's thread being starved; the next step is to log frame and server-tick timing around the resync.
  - **Warm-up transient:** a pmove branch first reached after V8 optimized its function (the first stairs, the first ladder) boxes doubles for a while: 1.7–5.4 MB once per process. It is not a steady state (`docs/10` §4). M3 adds the primer.
  - **Bench machine:** the numbers come from a cloud VM; please run `pnpm bench` on your laptop.
  - **Small netgraph overlap:** at very small windows the netgraph covers the speedometer.
- **Corrected facts:**
  - Ctrl, Alt and Meta keys can't be bound: `bind` refuses them, and presses made with a modifier held are ignored.
  - The pmove vectors file is about 308 KB (30 KB gzipped). It is inlined into the phone page.
- **Settled with you:**
  - The CLAUDE.md docs-map row for `docs/design/` is generic.
  - M2 review depth "like M1".
  - CI job plus phone page.
  - Course tests in tools.
  - The phone vectors page passed every table on your phone (2026-10-07).

## 8. Next steps (ordered)
1. Merge the M2 PR: CI is green, including the `browsers` job in Chromium, Firefox and WebKit.
2. Try the game on your laptop (§9), especially the manual `net_profile wan-150-loss2` check.
3. Answer the §7 questions when convenient. Questions 2 and 3 should be settled before M4.
4. Optional style spike (`docs/08` §18), or go straight to `/milestone M3`: the Node dedicated server, delta snapshots, remote players, bots, smooth time dilation and the pmove primer.
5. Whenever you like: `pnpm bench` on your laptop to fill in `docs/10` §5.

## 9. Try it (for Mustafa)
- `pnpm install`, then `pnpm dev`. Open http://localhost:5173 and click the view to take the mouse (Escape gives it back).
- **Move:** W A S D, Space jump, C crouch, X walk.
  - `movement_lab` has a runway, steps of 16/18/19 u, stairs, slopes (0.69, 0.71, 0.8), a crouch tunnel, a pool and a ladder.
  - Strafe-jump down the runway and watch the speed climb past 320.
- **Console:** Backquote opens it; `help` lists the commands.
  - `set cl_speedometer 1` and `set cl_netgraph 1`.
  - **Manual acceptance check:** `net_profile wan-150-loss2`. Movement should stay smooth, with netgraph corrections rare and small. `net_profile lan` switches back.
  - `set pm_gravity 400`: the change round-trips through the in-browser server with no correction. `reset pm_gravity` undoes it.
  - `set cl_thirdPerson 1`, `set r_debugHull 1`, `set r_debugTraces 1`, `set r_debugGround 1`.
  - `bind KeyQ +jump`, `cvarlist cl_`.
- **Terminal:**
  - `pnpm test:movement`: the MV tests print measured vs target.
  - `pnpm test:net`: NET-03 and one NET-04 summary line per profile.
  - `pnpm feel-report`: the metrics table.
  - `pnpm bench`: trace, pmove and codec budgets.
- **Browsers on your machine:** `pnpm exec playwright install chromium firefox webkit` once, then `BROWSERS=chromium,firefox,webkit pnpm test:browser`. In PowerShell: `$env:BROWSERS="chromium,firefox,webkit"; pnpm test:browser`.
- **Phone:** the vectors page I sent passed every table on your phone. Rebuild it with `pnpm --filter @game/client vectors-page <out.html>` after a sim change.
