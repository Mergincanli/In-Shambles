# Prompt Playbook for Claude Code

> Copy-paste prompts, in order. Each milestone prompt is self-contained, but always runs inside this repo where `CLAUDE.md`, `docs/`, `.claude/rules`, skills and agents exist.
> Shortcut: `/milestone M#` makes Claude Code load the matching prompt from this file automatically.

## How to run a milestone

1. Start a fresh session (`/clear` or a new terminal) → `/start-session`.
2. Switch to **plan mode** (Shift+Tab or `/plan`) → paste the milestone prompt.
3. Review the plan. Push back on scope creep, missing tests or vague acceptance. Approve.
4. Let it implement in increments. Commit after each green increment.
5. Ask for reviews: *"Use the netcode-reviewer agent on this diff."*
6. Close with `/handoff` → `/clear`.

**Rule of thumb:** if a session gets long or confused, run `/handoff`, `/clear` and `/start-session`. The handoff file carries the state.

---

## Reusable session prompts

### P-START (if you don't use `/start-session`)
```
Read CLAUDE.md, the newest file in docs/handoffs/, and the status table in docs/09-roadmap.md.
Run git status, pnpm typecheck, pnpm lint, pnpm test (skip what doesn't exist yet).
Summarize where we are in ≤15 lines and recommend ONE next step. Don't change code yet.
```

### P-REVIEW
```
Use the netcode-reviewer agent (and movement-reviewer if sim/movement files changed) to review
the current diff. Then fix all Blocker and Major findings, re-run the relevant test suites,
and summarize what changed.
```

### P-TUNE (movement tuning session)
```
Movement tuning session. Run /feel-check. Then propose up to 5 cvar changes for ESTIMATE/INFERRED
values that move us toward the targets in docs/03 §8 (and measured values in §7 if present).
Explain the expected effect of each. Apply only the ones I approve, re-run the feel report,
and record old→new values for the handoff. Never change FACT values or the tick rate.
```

### P-CAPTURE (turn reference measurements into data)
```
I measured these values in the original game (UrT 4.3.4, observe-only):
<paste measurements: quantity, value, method, date>
Update docs/03 §7 and/or docs/04 §6 with them (label: MEASURED + date). Then update
the corresponding cvar defaults or weapon data, adjust tests/targets, and add a decision-log
entry summarizing the changes. Show me the diff before committing.
```

### P-BUG
```
Bug: <what happened>
Expected: <what should happen>
Repro: <steps, map, net_profile, cvars>
Evidence: <console log / demo file / video timestamp>

First reproduce it with an automated test (scenario, parity or net test). Then find the root
cause, explain it, fix it, and keep the test. Don't patch symptoms.
```

### P-DECISION (when I decide an open item)
```
Decision: <e.g. O-2 naming → Italian food names with type tags>
Update docs/01 (open decisions table), add a D-### entry in docs/11, and update any affected
docs/content (e.g. content/names/weapons.json). Show me the diff.
```

### P-SCOPE-GUARD (when the session drifts)
```
Stop. Re-read the current milestone in docs/09 and its prompt in prompts/PROMPTS.md.
List what you're doing that is out of scope, revert or park it (add to the roadmap backlog),
and continue only with in-scope work.
```

### P-NAMES (generate naming candidates once O-2 is chosen)
```
Generate 3 naming candidates for every weapon/item ID in docs/04 §2, following the O-2 guidance
in docs/01 (role-telegraphing names + type tag, consistent tone). Output a table:
ID | candidate A | B | C | type tag | why it fits. Don't write files until I pick.
```

---

## M0 — Bootstrap & guardrails

```
Milestone M0. Read CLAUDE.md, docs/06-engine-architecture.md (§2, §3, §11), docs/09-roadmap.md (M0),
docs/04-combat-and-balance.md (§2, §4, §12) and docs/10-testing-and-performance.md (§2).

Goal: a clean pnpm monorepo where every later milestone can be verified automatically.

Build:
1. pnpm workspace with packages @game/shared, @game/server, @game/client, @game/tools.
   TypeScript strict everywhere (noUncheckedIndexedAccess in shared). Shared tsconfig base.
2. Tooling: Biome (lint + format), Vitest (workspace-aware), Vite for the client, tsx for dev
   server, esbuild for server bundle. Node LTS engines field.
3. Scripts from CLAUDE.md. Commands that belong to later milestones exist as stubs that print
   "added in M#" and exit 0.
4. Client: Vite page that shows "client ok" and the build hash. Server: Node entry that logs
   "server ok" with a monotonic-clock timestamp.
5. content/weapons/damage.json created from docs/04 §4 EXACTLY (all 20 weapon rows,
   10 zone columns, keyed by weapon ID). content/names/weapons.json with "TBD" names and the
   type tags from docs/04 §2. content/LICENSES.md (empty table header).
6. Golden test BAL-01: damage.json equals a table parsed from docs/04 §4. If the doc table
   changes without the JSON (or vice versa), the test fails.
7. shared: DEV_ASSERT helper, a minimal cvar registry (name, type, default, min/max, flags:
   ARCHIVE, REPLICATED, CHEAT, SERVER, LATCH) with unit tests.
8. README.md (setup, scripts), .gitignore, license placeholder ("All rights reserved"
   until decision O-5).

Out of scope: any gameplay, rendering beyond the placeholder page, networking.

Acceptance: fresh clone → pnpm install && pnpm typecheck && pnpm lint && pnpm test passes;
pnpm dev serves the page; pnpm server starts; BAL-01 passes.

Plan first and wait for my approval. Then implement in small green increments. Finish with /handoff.
```

## M1 — Simulation core (headless)

```
Milestone M1. Read CLAUDE.md, docs/06 (§3, §5, §9), docs/07 (§2, §3), docs/05 (§4.1),
docs/10 (§4.4), docs/09 (M1).

Goal: the deterministic foundation, with no rendering and no movement rules yet.

Build in packages/shared:
1. time.ts (TICK_RATE=60, TICK_DT), math (pooled vec3 with out-params, plane, aabb, angles),
   quant.ts (origin 1/32 u, velocity 1/16 u/s, angle u16, stamina 0.01), rng (mulberry32 +
   hash32 seeding).
2. world/: cmap types; convex brush (planes + bounds + contents flags); static BVH over brush
   bounds; traceBox(start, end, mins, maxs, mask) and traceRay(...). Brush traces use the
   classic approach: expand each brush plane by the box extents along the plane normal, compute
   enter/leave fractions with a small epsilon (e.g. 1/32 u), and report fraction, endpos, plane,
   contents, startSolid, allSolid. Implement this from the description; don't port any existing
   engine code.
3. sim/playerState.ts (fields from docs/03 §6 that exist so far) + quantize(); sim/usercmd.ts.

Build in packages/tools/src/greybox:
4. MapBuilder API (box, stairs, ramp, wall, volume(contents), spawn, timer) → compile to cmap
   (deterministic, byte-identical output on repeat).
5. Courses: movement_lab, jump_lab, slide_lab, fall_tower, arena_greybox per docs/07 §3.

Tests and benchmarks:
6. Trace tests: start-solid, all-solid, grazing faces, edges/corners, epsilon behavior,
   multiple brushes, contents masks. Fuzz: random sweeps never tunnel through solid brushes.
7. Cmap determinism test. pnpm bench with a traceBox microbenchmark (target ≤ 1 µs average on
   movement_lab).

Out of scope: pmove, rendering, networking.
Acceptance: docs/09 M1. Plan first and wait for approval. Finish with /handoff.
```

## M2 — Base movement + client shell + local server with prediction

```
Milestone M2. Read CLAUDE.md, docs/03 (§1–4, §6, §8, §9), docs/05 (§0–5, §13), docs/06 (§4, §6, §7),
docs/09 (M2). The .claude/rules files for shared, netcode and client apply.

Goal: run around movement_lab in the browser with Q3-style physics. It's already
server-authoritative (server in a Web Worker), predicted and reconciled, and smooth under
simulated latency and loss.

Build:
1. shared/sim/pmove: command scale, friction, accelerate, walk move (jump check BEFORE
   friction), air move, half-step gravity, clip velocity, multi-plane slide move, step-slide
   move, ground trace + slopes, edge-triggered jump (pm_autoHop cvar), crouch (hull swap, stand
   check), basic water (levels, swim, jump/crouch vertical control) and ladders (forward = up).
   All constants are REPLICATED cvars with FACT/INFERRED/ESTIMATE labels from docs/03 §2.
2. shared/net (minimal for now): BitWriter/BitReader, INPUT (cmds with 4x redundancy + ack)
   and SNAPSHOT (local player state only), LoopbackTransport, NetSimTransport with the
   profiles from docs/10 §3.
3. Server match loop (environment-agnostic) running in a Web Worker: monotonic-clock
   accumulator, per-tick cmd consumption (repeat last cmd if missing), pmove, snapshot.
4. Client: Vite app, pointer lock with raw input where available, Quake-style sensitivity
   (m_yaw/m_pitch 0.022), per-frame mouse look, tick accumulator with render interpolation of
   the local player, Three.js rendering of the cmap (flat-shaded greybox with grid textures)
   via render/space.ts (the only coordinate conversion; unit-test it), first-person camera with
   step smoothing.
5. Prediction + reconciliation per docs/05 §5 (exact quantized comparison, re-simulation,
   render-offset smoothing). Mini netgraph: RTT, loss, corrections/s, correction size.
6. Console (backquote): set, toggle, reset, cvarlist, bind (KeyboardEvent.code), net_profile.
   Speedometer HUD. Debug draw: hull, traces, ground normal.
7. pnpm feel-report (base metrics) and pnpm test:movement.

Tests: MV-01, 03, 04, 05, 06, 07, 08, 17 (basic), 18 (basic), 19; NET-03 (0 corrections on
lossless loopback). Manual: smooth play at net_profile wan-150-loss2.

Out of scope: UrT mechanics (sprint, wall jumps, slides, ledge grabs…), combat, remote
players, Node dedicated server.
Plan first and wait for approval. Finish with /handoff, including a "Try it" section for me.
```

## M3 — Real networking

```
Milestone M3. Read CLAUDE.md and ALL of docs/05-netcode.md, plus docs/10 (§3, §4) and docs/09 (M3).
Netcode is the top priority of this project. Take it slowly and test everything.

Goal: several browsers plus headless bots play together on a Node dedicated server, with smooth
remote players and measured bandwidth and tick budgets.

Build:
1. Node server package: match manager, WebSocketTransport (ws), config (server.cfg), structured
   logs, metrics (tick p50/p95/p99, bytes, starved cmds, GC pauses).
2. Full protocol per docs/05 §3–4: HELLO/WELCOME (protocol version, build hash, replicated
   cvar block + hash), READY, PING/PONG clock sync, INPUT (redundancy, acks), SNAPSHOT
   (header, local player block, entity list with field masks, delta vs. acked baseline,
   64-snapshot history, full resync), EVENTS (reliable).
3. Input buffers with inputBufferHealth reports and client time dilation (±3%) per docs/05 §8.
4. Remote entity interpolation with auto-sized interpDelay (2–6 ticks) and capped
   extrapolation. Simple capsule players in team colors.
5. Full netgraph overlay (cl_netgraph).
6. Headless bots (packages/tools/bots) over the real transport: strafe-jump circuits and random
   walks. CLI flags --count --profile --minutes --map; JSON + markdown summary.
7. Demo recording of the server snapshot stream + basic playback.
8. Security basics: bounds-checked decoders, size caps, rate limits, input clamps, strikes.

Tests: NET-01, 02, 04, 05, 07, 08 (measured; relevance comes in M9), 09, 10, 12.
Load check: 16 bots + 1 human on arena_greybox at wan-100-loss1, tick p99 ≤ 4 ms.

Out of scope: combat, relevance/visibility culling, WebTransport.
Plan first and wait for approval. Use the netcode-reviewer agent before closing.
Finish with /net-check and /handoff.
```

## M4 — UrT movement set

```
Milestone M4. Read CLAUDE.md, docs/03 (ALL, especially §5–§10), docs/02 (§3), docs/05 (§4, §5),
docs/09 (M4). Movement is the identity of this game: fidelity and feel come first.

Goal: movement that plays like Urban Terror 4.x, fully predicted and networked.

Build (each mechanic in its own increment, with tests, before moving on):
1. Walk/run/sprint (forward-only sprint, sprint raises air wishspeed too).
2. Stamina system per §5.2 (max = health × vest factor, costs, regen idle/move/none in water,
   delay). A minimal health component for now (full combat comes in M6).
3. Wall jumps per §5.3 (probes at two heights, world-only, max 3, impulse rules, events).
4. Power slide per §5.4 (crouch pressed airborne + speed threshold, locked direction,
   slide friction, exits).
5. Ledge grab and climb per §5.5 (wall/top/space probes, zero fall velocity, climb state).
6. Ladders and water completed; breath/drowning (16 s / 8 s).
7. Fall damage curve, broken legs and limp per §5.6; goomba per §5.7; kick per §5.8 (20 damage
   hook); player collision and ghosting cvars per §5.9.
8. Presentation hooks: speed trail >600 u/s, wall-kick/grab/slide sounds (placeholder),
   landing dip.
9. Tools: strafe-helper overlay, trace visualizer for wall/ledge probes, input recorder and
   replayer, ghost runs. pnpm feel-report produces the full docs/03 §8 table.
10. Every new field goes into PlayerState, the codec, delta masks and prediction.

Tests: MV-01…MV-20 (ESTIMATE targets may be tuned; log final values), NET-03 and NET-04 still
green with all mechanics active.

Out of scope: weapons and combat beyond the damage hooks.
Plan first and wait for approval. Use movement-reviewer and netcode-reviewer before closing.
Finish with /feel-check, /net-check and /handoff. I will do a feel sign-off session after this.
```

## M5 — TrenchBroom pipeline

```
Milestone M5. Read CLAUDE.md, docs/07 (ALL), docs/03 (§2 hull, §8 tests), docs/09 (M5).

Goal: author maps in TrenchBroom (Valve 220 format) and play them in the game with hot reload.

Build:
1. tools/trenchbroom/<GameName>/: GameConfig.cfg (map format Valve 220, texture root
   content/textures with PNG/JPG, exclusion patterns for *_normal/*_rough/*_orm etc.),
   <game>.fgd with the entities in docs/07 §4.2, icon. Tool textures (clip, nodraw, skip,
   trigger, water, ladder, slick, nodamage). Write install instructions in the tool README
   (which folder to copy into on Windows, macOS and Linux).
2. pnpm mapc compiler per docs/07 §4.3: parser with line/column errors, face planes, convexity
   validation, face polygons by half-space clipping, vertex welding, Valve 220 UVs (read texture
   dimensions from image headers), per-material batching, collision brushes straight from
   planes (never triangles), BVH, entity conversion, validation, compile report, deterministic
   output.
3. --watch hot reload: recompile on save → dev server broadcasts MAP reload → client reloads
   geometry, keeping player positions where possible.
4. Rebuild movement_lab and jump_lab as .map files.

Tests: parser golden fixtures, compile determinism, fuzzed malformed input, and the
equivalence test (TrenchBroom movement_lab vs. greybox movement_lab give identical collision
results on a recorded run).

Out of scope: lightmaps and art meshes (Phase C).
Plan first and wait for approval. Finish with /handoff, including a short "How to make a map"
guide for me.
```

## M6 — Combat core

```
Milestone M6. Read CLAUDE.md, docs/04 (ALL), docs/05 (§7, §10, §11), docs/02 (§4–§6), docs/09 (M6).
The damage table is FACT: never change it. Fire rates, reloads and spread are ESTIMATE/INFERRED
and live in content/weapons/<id>.json.

Goal: Urban Terror's gun balance, server-authoritative and lag-compensated.

Build (separate increments, each with tests):
1. Hitbox pose function (zones from docs/04 §10, stance-aware) + debug view showing current vs.
   rewound hitboxes.
2. Lag-compensation history (1 s) + rewind hitscan with sv_maxRewindMs and viewInterpTick
   validation. Torso-over-arms rule; groin/butt by shot direction; no penetration.
3. Weapon data loading (zod-validated, content only) + weapon state machines: semi, burst,
   auto, hyper-burst (miss lockout), magazine reload (discard remainder), shell reload
   (incremental, cancellable), bolt (uncancellable), multi-level zoom with zoom-in delay,
   scoped movement rule, unscope-on-hit.
4. Deterministic spread/recoil (seeded per shooter/tick/shot) shared by client and server;
   client-predicted tracers, muzzle flash and world impacts; server-confirmed player hits.
5. Damage application with helmet/vest columns, bleeding (5 HP/s), leg wounds → limp,
   bandage (self/others), medic healing caps 90/50 with stacking, no self-heal.
6. Loadout legality (all combos, Negev rule, minimum gear), gear-change timing (apply on
   respawn after moving/firing), death drops, pickups (auto + crouch-use), ammo pickup caps.
7. Knife slash + throw (last-knife rule), HE (cook + cancel-on-switch) and smoke grenades,
   launcher with timed grenades. Projectiles predicted for the thrower.
8. Feedback: hit sound, hit messages (zone + %), wound figure, bleeding blink and blackout
   pulse, kill feed. pnpm balance-report.

Tests: BAL-01…BAL-11, NET-06 (lag comp at 150 ms), predicted tracers match server shot vectors.
Load: 16 firing bots on arena_greybox within tick and bandwidth budgets.

Out of scope: final art/audio, modes beyond FFA for testing.
Plan first and wait for approval. Use netcode-reviewer and perf-auditor before closing.
Finish with /balance-check, /net-check and /handoff.
```

## M7 — Modes & match flow

```
Milestone M7. Read CLAUDE.md, docs/01 (O-6 status), docs/02 (§7 for inspiration only),
docs/09 (M7). If O-6 is still "Proposed", implement the proposed set and say so in the handoff.

Goal: complete, replayable matches.

Build:
1. Rules plug-in interface (shared types; server host) + modes: FFA, TDM, Team Survivor
   (rounds, spawn groups, no respawn within a round), CTF (flags, captures, returns, an
   anti-stalemate timer of our own design), Movement Trials (timers, checkpoints,
   save/load position, ghosting, personal-best ghosts from recordings).
2. Team selection, auto-balance, spectator (free + follow), warmup/countdown, match end and
   map rotation.
3. HUD: scoreboard, kill feed polish, chat (all/team), round timer, mode objectives, minimap
   with teammate arrows.
4. Simple server list (servers POST heartbeats to an HTTP endpoint; client lists them) and
   direct-join links (?server=…).

Tests: mode unit tests (round transitions, scoring, flags, timers), plus a 2-hour bot soak with
no errors. Late join and reconnect.
Plan first and wait for approval. Finish with /net-check and /handoff.
```

## M8 — Look & feel

```
Milestone M8. Read CLAUDE.md, docs/08 (ALL, especially §15–§19), docs/07 §5, docs/10 §4.3,
docs/09 (M8). docs/08a is reference material, not rules.
If the look-dev parameters (docs/08 §17.3) aren't in the decision log yet, STOP and ask me.
Don't invent them.

Goal: the chosen art direction implemented within budgets.

Build (per docs/08):
1. Lighting pipeline per the docs/07 §5 decision (lightmap baker / Blender bake; see docs/08 §6),
   materials, post-processing, graphics presets (low/medium/high) with renderer.info budget
   overlay.
2. Character model pipeline (glTF skinned, LODs) with animation driven by interpolated state.
   Hitboxes re-fitted to the final proportions (update docs/04 §10).
3. Viewmodels and animations (fire, reload, bolt, bandage, climb, wall kick, slide), separate
   render pass with its own FOV.
4. VFX: tracers, impacts (world vs. player), blood, smoke, speed trail, all pooled.
5. Audio pass: positional footsteps (material-based), weapons, wall kicks and grabs, UI;
   voice limits and priorities.
6. UI/HUD styling and menus: settings (graphics, audio, controls, sensitivity in Quake units,
   accessibility: colorblind presets, FOV, viewmodel, reduced shake).

Acceptance: budgets in docs/08 §16 and docs/10 §4.3 on the reference machines; the readability
test from docs/08 §17.4 documented with screenshots.
Plan first and wait for approval. Use perf-auditor before closing. Finish with /handoff.
```

## M9 — Online hardening

```
Milestone M9. Read CLAUDE.md, docs/05 (§3.1, §9, §12, §13), docs/10, docs/09 (M9).

Goal: ready for public servers.

Build:
1. WebTransportTransport (datagrams for unreliable traffic, one reliable stream) with feature
   detection and fallback to WebSocket. Evaluate server-side HTTP/3 options for Node and
   document the choice as a decision (D-###), including licensing.
2. Relevance and visibility culling per docs/05 §9.1 (LOS with padding and velocity prediction,
   hysteresis, leak radius, coarse audio events for unseen players). Add a cluster-visibility
   pre-pass in the map compiler.
3. Snapshot priority accumulator and per-client 30 Hz fallback under bandwidth pressure.
4. Validation hardening and strike system; rcon auth; admin commands (kick, ban, map,
   restart).
5. Deployment: container image, health checks, metrics endpoint, structured logs, one EU region.
   Crash/telemetry reporting (privacy-respecting, opt-in where required).
6. CI: typecheck, lint, tests, a 2-minute bot soak, bundle-size and perf budget checks.
   Stress test with 32 bots; 24-hour soak.

Tests: full NET suite on both transports, NET-11 relevance tests, soak without leaks.
Plan first and wait for approval. Use netcode-reviewer, perf-auditor and clean-room-auditor
before closing. Finish with /net-check and /handoff.
```

## M10 — The twist + content

```
Milestone M10. Read CLAUDE.md, docs/01 (O-3 must be decided), docs/09 (M10).
If O-3 is still TBD, don't build anything. Help me design it instead:
1. Interview me with ≤5 questions about the twist's intent, fantasy and constraints.
2. Propose 3 directions that fit the pillars (movement mastery, readable lethality, trusted
   netcode). For each: core loop impact, netcode cost, art implications, risks.
3. After I choose, write docs/12-twist-design.md (rules, states, UI, networking,
   tests) and an M10 implementation plan. Wait for approval before coding.
```

---

## Tips for working with Claude Code on this project

- **Plan mode is cheap insurance.** Use it for every milestone and for any change touching `shared/net` or `shared/sim`.
- **Give it a way to verify.** Every prompt ends in runnable checks. If Claude says "done" without running them, ask it to run `/feel-check`, `/net-check` or `/balance-check`.
- **Keep CLAUDE.md lean.** Put details in `docs/`; CLAUDE.md only points to them.
- **Use the reviewers.** Subagents work in their own context, so reviews don't bloat your main session.
- **Measure the original.** The fastest way to turn ESTIMATEs into truth is the capture protocol in `docs/02` §13 plus the P-CAPTURE prompt.
- **One milestone per branch** (`m3-networking`) if you use git branches. Merge after the handoff.
