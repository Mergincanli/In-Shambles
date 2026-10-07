# M2 plan: base movement, client shell, Worker server and prediction

> **Status:** the M2 implementation plan as Mustafa approved it (2026-10-06), kept so that citations such as "M2 plan, increment 4" resolve. It is a record, not a spec: the numbered docs and the decision log win where they differ. The design it builds on is `docs/design/M2-design.md`.

## Context
M1 delivered the deterministic simulation core, and its PR is merged. M2 makes it playable: you run around `movement_lab` in the browser with Quake 3-style physics.

Everything already goes through a server running in a Web Worker. The client predicts its own movement and corrects it when the server disagrees, and it stays smooth under simulated latency and packet loss. Sources: `docs/09` M2 and the M2 prompt in `prompts/PROMPTS.md`.

**Acceptance (`docs/09` M2):**
- **Movement tests:** MV-01, 03, 04, 05, 06, 07, 08, 17 (basic), 18 (basic) and 19 pass.
- **Prediction (NET-03):** 0 corrections on a lossless loopback.
- **Lag:** smooth at `net_profile wan-150-loss2`; corrections are rare, small and logged.
- **Feel report:** `pnpm feel-report` prints the base metrics.
- **Browsers:** the determinism vectors replay bit for bit in Chrome, Firefox and Safari.

**Out of scope:**
- UrT mechanics (sprint, stamina, wall jumps, slides, ledge grab, fall damage, breath);
- combat;
- remote players;
- the Node network server (M3);
- delta snapshots (M3);
- smooth time dilation (M3).

**Your choices:**
- Full end-of-milestone review, like M1.
- Cross-browser check in a CI job (Chromium, Firefox, WebKit) **and** a phone test page.
- Course-based tests live in `packages/tools/test`.
- Keep going without pausing: commit and push each green increment, send short progress notes, and stop only for blockers.

**Branch:** `claude/blissful-knuth-055dcn`, now at the M1 merge. A PR to `main` at the end.

## Architecture

**Dependency graph:**
- server depends on shared.
- client depends on shared and server: the Worker runs the server's match code.
- tools depends on shared, server and the client's `./net` part (bots will need it in M3).
- There are no cycles.

**`packages/shared`**
- **`sim/pmove/`:**
  - The steps: command scale, friction, accelerate, clip, slide move with half-step gravity, step-slide, ground trace, walk/air with the jump check before friction, edge-triggered jump with `pm_autoHop`, crouch with a stand test, water, ladder.
  - Each tick ends with `snapOrigin`, then `quantizePlayerState`.
  - Entry point: `pmove(ps, cmd, world, params, dt, events|null, debugLog|null)`.
  - `PmoveParams` is refreshed from the cvar registry only when the new `registry.version` counter changes, so the hot path never looks up a cvar.
  - Movement events (step, jump, land) are output only.
  - **No new `PlayerState` fields.**
- **`net/`:**
  - BitWriter and BitReader: bounds-checked, with a sticky error flag.
  - Protocol v1 messages: HELLO, WELCOME, READY, INPUT (the last 4 cmds plus an ack, about 55 B), SNAPSHOT (full local player state, about 42 B), PING/PONG, CVARS, CMD, PRINT, KICK.
  - The replicated cvar block, with its hash.
  - Transport: an in-memory loopback pair, plus NetSim (injected clock, seeded RNG, the `docs/10` §3 profiles).
- **`cvars/`:** gets the `version` counter. **`sim/hull.ts`:** gets the eye heights 26/12 (FACT for Q3).

**`packages/server/src/match/`**
- Environment-agnostic, with no Node or DOM types, and checked by its own tsconfig.
- **Loop:** monotonic-clock accumulator, re-armed by the host; never `setInterval`. Catch-up is capped at 5 ticks.
- **Inputs:** queues keyed by tick. A missing cmd repeats the last one with attack cleared and is counted as "starved".
- **Each tick:** pmove, then a snapshot carrying `lastProcessedCmdTick` and the input-buffer health.
- **Console commands:** `set`/`reset`/`toggle` on a replicated cvar from the console arrive as CMD, change the server's value and are broadcast back as CVARS.

**`packages/client`**
- **`src/net/`** (DOM-free, so tests and M3 bots can use it):
  - Connection handshake.
  - Clock: prediction runs in server-tick time, with an RTT lead plus a 2-tick input buffer, re-anchored in steps (smooth dilation is M3).
  - Predictor: per `docs/05` §5. It compares states exactly, re-simulates on a mismatch, decays a render offset over 100 ms and snaps on teleports above 64 u.
  - Stats.
- **`src/worker/`:** the server Worker, talking to the client over `MessageChannel` ports.
- **`src/render/`:**
  - `space.ts`, the only Z-up inch → Y-up metre conversion.
  - The world mesh from the cmap's render surfaces, with procedural grid textures (1 uv per 64 u) and Lambert lighting.
  - First-person camera: Hor+ field of view, render interpolation, step and view-height smoothing.
  - Debug draw for the hull, traces and ground normal.
- **`src/input`, `src/console`, `src/hud`:**
  - Pointer lock with raw input when available, sensitivity in Quake units (0.022 per count).
  - Binds by `KeyboardEvent.code`: WASD, Space jump, C crouch, X walk.
  - A Backquote console: `set`, `toggle`, `reset`, `cvarlist`, `bind`, `unbind`, `net_profile`.
  - Speedometer.
  - Mini netgraph: RTT, loss, corrections per second and their size, input buffer, starved cmds, bytes.

**`packages/tools`**
- A scenario runner on the real courses: MV tests, feel-report, NET-03/04 harness, MV-19 build probes.
- Benches for pmove (≤ 5 µs per player-tick) and the snapshot codec (≤ 30 µs).
- Native-ESM allocation workloads.

**New dependencies:**

| Package | License | Why |
|---|---|---|
| `three` + `@types/three` 0.186 | MIT | Renderer (D-002) |
| `playwright`, pinned to the installed Chromium build (1.56.x) | Apache-2.0 | Browser tests |
| `@vitest/browser-playwright` 5.0.3 | MIT | Vitest browser mode |

## Spec decisions you approve with this plan

| ID | Decision |
|---|---|
| D-022 | **Browser determinism.** Vitest browser mode replays the existing vectors tests unchanged: Chromium locally; Chromium, Firefox and WebKit (Safari's engine) in a new CI job. There is also a phone test page so you can check real Safari or Chrome on your phone. |
| D-023 | **pmove contract.** `dt` is a parameter, so MV-04 can run at 120 Hz. Events stay out of `PlayerState`. **"Starts in solid" means allSolid:** a startSolid trace may move out. Slick and no-damage ground = the face flag **or** the brush contents bit, so ramp crests work with no format change. "Crouch-blocked" = crouched under a ceiling, so no jump there. |
| D-024 | **Ladders and water.** Ladders are detected by a short forward probe that must hit a `SURF_LADDER` face while you face it. The greybox drops the unused LADDER volume and gives the face a rung texture; maps recompile with `compiler.version` 2. Water is sampled at feet + 1, feet + 28 and eye height. Jump and crouch swim up and down. With no input you sink slowly. |
| D-025 | **Test homes.** Course-based tests (MV, NET, feel-report) live in tools. `docs/10` §1 is updated. |
| D-026 | **Protocol v1 and transports.** The transport sends `Uint8Array` + length, receives via `poll()`, and keeps the reliable channel ordered and lossless. Decoders drop bad packets and count a strike. Snapshots are full in M2. |
| D-027 | **Replicated cvars.** The block encoding and hash. CVARS carries an effective tick, and the client switches parameters at that tick, so a live `set pm_gravity 400` causes 0 corrections. The Worker's client is admin. |
| D-028 | **M2 clock and NetSim.** Clock as above. `docs/10` §3 is the canonical profile table; `docs/05` §13 gains the reorder column. |

## New tunables

**ESTIMATE replicated cvars** (added to a new `docs/03` §2.3):

| Cvar | Default |
|---|---|
| `pm_ladderScale` | 0.5 |
| `pm_ladderFacing` | 0.5 |
| `pm_ladderReach` | 2 u |
| `pm_ladderJumpPush` | 150 u/s |
| `pm_waterSinkSpeed` | 60 u/s |

**Client settings** (saved per player, not replicated):

| Setting | Default |
|---|---|
| `sensitivity` | 5 |
| `m_yaw`, `m_pitch` | 0.022 |
| `cl_fov` | 90 |
| `cl_inputBuffer` | 2 ticks |
| `cl_correctionSmoothMs` | 100 |
| `cl_teleportDist` | 64 |
| `cl_stepSmoothMs` | 150 |
| `cl_viewHeightSmoothMs` | 100 |
| `cl_netgraph`, `cl_speedometer`, `cl_thirdPerson`, `r_debug*` | off |

A doc-golden test keeps the `pm_*` defaults and labels in sync with `docs/03` §2.

## Tests mapped to acceptance

| Acceptance | Test |
|---|---|
| MV-01 run cap | Runway, forward: 320 ± 0.5 within 0.6 s |
| MV-03 | Walk 160 ± 1, crouch 80 ± 1 |
| MV-04 | Apex 45.56 ± 0.5 at both 60 and 120 Hz |
| MV-05 | 16 and 18 u steps climb with a STEP event; 19 blocks; stairs |
| MV-06 | Slopes: 0.71 and 0.8 walkable without stalls; you slide down 0.69 |
| MV-07, MV-08 | 20 straight hops ≤ cap + 2%; the strafe bot gains every hop |
| MV-17 / 18 basic | Water levels 1/2/3, swim up/down/sink, forward 160. Ladder: forward = up at any pitch, detach when facing away, jump off |
| MV-19 | 10k ticks run twice, then in esbuild and Vite builds, and pmove vectors in 3 browsers |
| NET-03 | Real Match + client over a lossless loopback for 3600 ticks, including out-of-range input and a live cvar change: 0 corrections |
| "Smooth at wan-150-loss2" | **Automated NET-04 basic** on every profile: < 1 correction/s, mean < 2 u, render offset < 8 u, no frame-to-frame jumps. Also a manual check for you |
| feel-report | Prints and writes `reports/feel.md` (git-ignored) |
| Browsers | `pnpm test:browser` locally (Chromium) plus a CI `browsers` job, and the phone page |

**Also:**
- **Unit tests:** pmove units, bitstream, codec round trip and fuzz (NET-01), cvar block, NetSim statistics, match loop and queues, `space.ts`, smoothers, console parsing.
- **Browser smoke test (local Chromium):** the real built client with a scripted bot. The Worker connects, frames render, there are no errors and 0 corrections. A screenshot script sends you pictures.
- **Scripts:**
  - `test:movement` = `-t "^MV-"`, `test:net` = `-t "^NET-"`, both protected by naming guards;
  - `feel-report` becomes a real command;
  - new `test:browser`;
  - the CLAUDE.md and README tables and stub sentences are updated.

## Increments (each green, committed and pushed)
1. `test: replay determinism vectors in real browsers`: browser deps, config, CI job, `test:browser`, D-022. This comes first because it's the riskiest plumbing.
2. `feat(shared): pmove params, cvars and core steps`, plus the `docs/03` §2.3 doc-golden test.
3. `feat(shared): slide, step-slide, ground, walk, air and jump`: unit tests, pmove bench, allocation workload, D-023.
4. `test(tools): movement scenarios MV-01..07`: ladder material and recompiled maps, `test:movement`, D-025.
5. `feat(shared): crouch, water and ladder movement`: MV-08, 17, 18; feel-report; D-024.
6. `test: pmove determinism vectors and MV-19`.
7. `feat(shared): bitstream, protocol v1 and cvar block`: NET-01, codec bench, D-026.
8. `feat(shared): transports and the net simulator`: D-028.
9. `feat(server): environment-agnostic match loop`: D-027.
10. `feat(client): headless prediction, reconciliation and clock sync`: NET-03, NET-04 basic, `test:net`.
11. `feat(client): Three.js world, Worker server, camera`: the e2e smoke test and screenshots.
12. `feat(client): input, console, binds, HUD, debug draw`, plus the phone vectors page.
13. **Close-out:**
    - full review, like M1 (a multi-agent workflow);
    - netcode, movement, perf and clean-room reviewers;
    - fixes;
    - handoff with "Try it", then a PR.

**How I'll build it:**
- One implementer per increment.
- I run the checks myself before each commit.
- The netcode or movement reviewer runs after the pmove, net and prediction increments.
- The full workflow review runs once at the end, then targeted fixes.
- The detailed design is committed as `docs/design/M2-design.md`, next to the M1 records.

## Risks
1. **Stalls on slopes and angled walls** (D-017: tangency isn't exact). Mitigated by MV-06 stall checks, a random-input property test, overclip plus nudge.
2. **pmove over 5 µs.** Bench from increment 3 onwards, with fallbacks ready.
3. **V8 boxing doubles under native ESM.** Allocation guard from the first pmove commit.
4. **Playwright / Vitest 5 vs the local Chromium build.** Done first; version pinned, with a `CHROMIUM_PATH` override. Firefox and WebKit are proven only in CI.
5. **WebKit isn't Safari.** It's the same JS engine, and the phone page covers the real thing.
6. **Corrections without time dilation.** 4× input redundancy, a 2-tick buffer, re-anchoring, and NET-04 on every profile.
7. **Headless WebGL.** SwiftShader flags; the smoke test still checks the sim and net path without WebGL.
8. **Spend limits interrupting long runs.** Commit and push after each increment, so any stop is resumable.

## Verification
- After every increment: `pnpm typecheck && pnpm lint && pnpm test`, plus `test:movement`, `test:net` and `test:browser` once they exist.
- **At the end:**
  - a fresh clone runs everything;
  - `pnpm bench` meets the pmove, trace and codec budgets with 0 GCs;
  - the CI `browsers` job is green in all 3 engines;
  - an e2e run with screenshots sent to you;
  - the full review workflow;
  - the handoff "Try it" list, including the manual `net_profile wan-150-loss2` check for when you're back at your laptop.
