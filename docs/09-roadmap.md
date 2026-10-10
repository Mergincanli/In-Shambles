# 09 — Roadmap

> One milestone at a time. Each milestone ends with: green checks (`typecheck`, `lint`, `test`), updated docs, a handoff file, and a short demo note (what to try). Prompts for each milestone are in `prompts/PROMPTS.md`.
> **Ordering principle:** networking arrives early (M2/M3), so every mechanic after it is born networked and predicted.

## Status

| ID | Milestone | Status | Last handoff |
|---|---|---|---|
| M0 | Bootstrap & guardrails | ☑ done | [2026-10-05](handoffs/2026-10-05-M0-bootstrap.md) |
| M1 | Simulation core: tick, math, brush collision, greybox builder | ☑ done | [2026-10-06](handoffs/2026-10-06-M1-simulation-core.md) |
| M2 | Base Q3 movement + client shell + Worker server + prediction | ☑ done | [2026-10-07](handoffs/2026-10-07-M2-movement-and-prediction.md) |
| — | *Optional:* Style spike: toon material, hull outline, crease lines on greybox (`docs/08` §18) | ☐ | |
| M3 | Real networking: dedicated server, protocol, snapshots, interpolation, bots | ☐ | |
| M4 | UrT movement set (sprint/stamina, wall jumps, slide, ledge grab, …) | ☐ | |
| M5 | TrenchBroom pipeline: game config, FGD, `.map` compiler, hot reload | ☐ | |
| M6 | Combat core: hitboxes, lag comp, weapons, damage, armor, bleeding, loadouts | ☐ | |
| M7 | Modes & match flow: teams, FFA/TDM/Survivor/CTF/Trials, HUD, spectate | ☐ | |
| M8 | Look & feel: art direction implementation, lighting, characters, audio | ☐ | |
| M9 | Online hardening: WebTransport, relevance culling, deployment, anti-cheat basics | ☐ | |
| M10 | The twist + content + public playtest | ☐ | |

## M0 — Bootstrap & guardrails

**Goal:** a clean monorepo where every later milestone can be verified automatically.

**Scope**
- pnpm workspace with `shared`, `server`, `client`, `tools`; TS strict configs; Biome; Vitest; Vite client "hello world"; Node server "hello world".
- Scripts listed in `CLAUDE.md` (stubs allowed that print "added in M#").
- `content/` skeleton: `weapons/damage.json` populated from `docs/04` §4 **now**, plus its golden test (BAL-01). `names/weapons.json` with TBD names.
- `.gitignore`, `README.md` (dev setup), license placeholder (decision O-5 pending → "All rights reserved" for now).
- A tiny `DEV_ASSERT` utility; a `cvars` registry skeleton.

**Out of scope:** any gameplay.

**Acceptance**
- `pnpm install && pnpm typecheck && pnpm lint && pnpm test` passes on a fresh clone.
- `pnpm dev` serves a page; `pnpm dev:server` starts and logs (D-015).
- BAL-01 passes (damage table golden).

## M1 — Simulation core (headless)

**Goal:** the deterministic foundation: time, math, quantization, PRNG, brushes, traces, BVH, compiled map format, greybox builder + labs.

**Scope**
- `time.ts`, `math/*`, `rng/*`, `world/*` (cmap types, brush, BVH, `traceBox`, `traceRay`, contents), `sim/playerState.ts` + quantize, `sim/usercmd.ts`.
- `tools/greybox`: MapBuilder + the 5 courses (`docs/07` §3) compiled to cmap.
- Benchmarks (`pnpm bench`): trace performance on `movement_lab`.

**Out of scope:** rendering, networking, movement rules.

**Records:** the approved plan and the design it builds on are `docs/design/M1-plan.md` and `docs/design/M1-design.md`.

**Acceptance**
- Trace unit tests: start-solid, all-solid, grazing edges, corners, epsilon behavior.
- Fuzz test: random box sweeps never tunnel through brushes.
- Cmap compile is deterministic (byte-identical twice).
- Box trace ≤ 1 µs average on `movement_lab` (Node, dev laptop).

## M2 — Base movement + client shell + local server with prediction

**Goal:** you can run around `movement_lab` in the browser with Q3-style physics. It already goes through a server (Web Worker) with prediction and reconciliation, and survives simulated latency.

**Scope**
- `sim/pmove/*` per `docs/03` §4: command scale, friction, accelerate, walk/air move, gravity integration, clip/slide/step-slide, ground trace, jump (edge-triggered), crouch, water and ladder basics.
- **Client:**
  - Vite app with pointer lock + raw mouse
  - Quake-style sensitivity
  - Three.js world rendering of the cmap (flat-shaded greybox, grid textures)
  - first-person camera with per-frame mouse look
  - tick accumulator + render interpolation
  - console (`set`, `cvarlist`, `bind`), speedometer HUD, debug draw (hull, traces)
- **Server in Web Worker** (same match code path that Node will use).
- `createLoopbackPair` (in-process) and `PortTransport` (Worker) + `NetSimTransport`; minimal binary INPUT/SNAPSHOT for the local player only.
- Prediction + reconciliation (`docs/05` §5), corrections counter in a mini netgraph.

**Out of scope:** UrT mechanics, combat, remote players, dedicated server.

**Records:** the approved plan and the design it builds on are `docs/design/M2-plan.md` and `docs/design/M2-design.md`.

**Acceptance**
- Movement tests MV-01, 03, 04, 05, 06, 07, 08, 17 (basic), 18 (basic), 19 pass.
- NET-03 (prediction parity: 0 corrections on lossless loopback) passes.
- With `net_profile wan-150-loss2`, movement stays smooth (no visible rubber-banding; corrections rare and small, logged).
- `pnpm feel-report` prints base metrics.
- The determinism vectors (`packages/shared/test/vectors`) replay bit for bit in Chrome, Firefox and Safari (D-016; D-022: Chromium, Firefox and WebKit via `pnpm test:browser` and the CI `browsers` job, real Safari via the phone page).

## Style spike (optional, after M2)

**Goal:** confirm the Comic Noir render pipeline on greybox before content production (`docs/08` §18). Recommended, 1–2 sessions; skipping it doesn't block M3.

**Scope**
- Banded toon material driven by the key light, with tinted shadows (`docs/08` §6).
- Hull outlines with pixel-accurate width on a test character (`docs/08` §7.1).
- Crease lines from the greybox brushes (`docs/08` §7.2).

**Out of scope:** lightmaps, hatching, the screen-space edge pass, comic FX and UI. They arrive in M5–M8 per `docs/08` §18.

**Acceptance**
- Frame cost measured against the `docs/08` §16 budgets on the low preset; results recorded in the handoff.

## M3 — Real networking

**Goal:** multiple browsers (and bots) play together on a Node dedicated server with smooth remote players.

**Scope**
- Node server + `WebSocketTransport`.
- Full protocol (`docs/05` §3–4): handshake, replicated cvars, INPUT with redundancy and acks, SNAPSHOT with delta compression and entity list, EVENTS reliable channel.
- Server tick loop with input buffers + time dilation reports; client clock sync.
- Remote entity interpolation; simple capsule player models in team colors.
- Full netgraph.
- Headless bots (`pnpm bots`), demo recording (server snapshot stream) and playback (basic).
- Deterministic pmove primer at match and prediction start, guarded by a late-branch native-ESM allocation workload (the M2 warm-up transient, `docs/10` §4). Done in increment 12 (D-040): a no-retry multi-process guard with a primer-off control and a block-coverage guard, in `pnpm test:long`.

**Out of scope:** combat, relevance culling (send everything in M3), WebTransport.

**Records:** the approved plan and the design it builds on are `docs/design/M3-plan.md` and `docs/design/M3-design.md`.

**Acceptance**
- NET-01, 02, 04, 05, 07, 08 (bandwidth measured, even if relevance comes later), 09, 10, 12 pass.
- 16 bots + 1 human on `arena_greybox` at `wan-100-loss1`: smooth remote motion, server tick p99 ≤ 4 ms.

## M4 — UrT movement set

**Goal:** the movement plays like UrT and is fully predicted and networked.

**Scope** (`docs/03` §5)
- Walk/run/sprint, stamina (incl. vest halving hook).
- Wall jumps (max 3), power slide, ledge grab and climb.
- Ladders and water (complete), breath/drowning.
- Fall damage, broken legs/limp (damage via a minimal health component; full combat comes in M6).
- Goomba and kick (damage hooks), player collision and ghosting cvars, speed trail VFX.
- All new state in PlayerState + snapshot fields + prediction.
- Tuning tools: strafe helper, trace visualizer, input recorder/replayer, ghost runs.
- `pnpm feel-report` complete with the §8 table.

**Acceptance**
- MV-01…MV-20 pass (targets marked ESTIMATE may be tuned; record final values in the decision log).
- NET-03/04 still pass with all mechanics.
- **Mustafa's feel sign-off** after a play session; tuning changes logged.

## M5 — TrenchBroom pipeline

**Goal:** author maps in TrenchBroom and play them with hot reload.

**Scope:** `docs/07` §4
- Game config + FGD + tool textures.
- `.map` (Valve 220) parser, brush → planes/polygons/UVs, collision brushes, entities, validation, compile report.
- `pnpm mapc` + `--watch` hot reload.
- Rebuild `movement_lab` and `jump_lab` in TrenchBroom.

**Acceptance**
- Parser/compiler tests and the equivalence test (`docs/07` §4.5) pass.
- A new map made in TrenchBroom loads in the client within 2 s of saving.

## M6 — Combat core

**Goal:** UrT gun balance, server-authoritative and lag-compensated.

**Scope** (`docs/04`)
- Hitbox pose function + debug view (current vs. rewound).
- Lag-compensation history + rewind hit tests.
- Weapon state machines (fire modes, burst, hyper-burst, reload types, bolt, zoom levels, scope rules).
- Deterministic spread; damage table + armor + bleeding + bandage + medic.
- Loadout legality + gear-change timing; drops/pickups.
- Knife slash/throw, HE/smoke grenades with cooking, launcher.
- Hit feedback (hit sound, messages, wound figure, blackout pulse); kill feed.
- `pnpm balance-report`.

**Acceptance**
- BAL-01…BAL-11 pass. NET-06 (lag comp) passes at 150 ms. Predicted tracers match server hits.
- 16 bots firing on `arena_greybox`: server tick p99 ≤ 4 ms; bandwidth within budget.

## M7 — Modes & match flow

**Goal:** complete matches.

**Scope**
- Team selection, spawns (spawn groups for round modes).
- Rule plug-ins: **FFA, TDM, Team Survivor (rounds), CTF, Movement Trials** (timers, checkpoints, ghost runs, ghosting) — final list per decision O-6.
- Scoreboard, kill feed polish, chat, spectator (free/follow), warmup/countdown, match end.
- Simple server list (HTTP endpoint from servers) + direct-join links.

**Acceptance**
- Mode tests (round transitions, scoring, flag logic, timers).
- Two-hour bot soak without errors; late join and reconnect work.

## M8 — Look & feel

**Goal:** the chosen art direction (O-4) implemented, within budgets.

**Scope**
- Style implementation (materials, post, lighting model per the `docs/07` §5 decision).
- Character model + skeletal animation driven by interpolated state.
- Viewmodels + animations (fire, reload, bolt, bandage, climb, wall kick).
- VFX (tracers, impacts, blood, smoke, speed trail), audio pass (positional footsteps, weapons, UI).
- HUD/UI styling, settings menus (graphics presets, audio, controls, accessibility).

**Acceptance**
- Budgets in `docs/08` §16 and `docs/10` met on the reference machines.
- Readability tests (`docs/08` §17.4) documented.

## M9 — Online hardening

**Goal:** ready for public servers.

**Scope**
- `WebTransportTransport` (datagrams) with WebSocket fallback + feature detection.
- Relevance and visibility culling with hysteresis (`docs/05` §9); audio events for unseen players; cluster visibility from the compiler.
- Server validation and strike system; rate limits.
- Deployment (container image, one EU region), health checks, metrics endpoint, structured logs.
- Crash/telemetry reporting (privacy-respecting), bandwidth/perf budgets in CI, 32-bot stress test, 24 h soak.

**Acceptance**
- NET-11 passes; NET suite green on WebTransport *and* WebSocket.
- 24 h soak without leaks; public playtest checklist complete.

## M10 — The twist + content

**Goal:** the game's unique hook (O-3) and enough content for a public playtest.

**Scope:** defined when O-3 is decided. Expect: twist systems, 3–5 maps, progression/meta (if any), onboarding (movement tutorial course), polish.

## Backlog (unscheduled ideas)
- Sub-tick fire timestamps for rewind precision.
- Killcam from server demo buffer.
- Ranked matchmaking, accounts/auth.
- Community map loading (sandboxed).
- Spectator/caster tools.
- Replay sharing.
- Additional regions.
