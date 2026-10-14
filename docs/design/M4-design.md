# M4 design: the UrT movement set (sprint and stamina, health and falls, wall jumps, power slide, ledge grab, ladders and water completed, player collision with goomba and boot, protocol v4, presentation hooks, tuning tools, the full feel report)

> **Status:** approved with the plan (2026-10-14), after one critique round (movement, netcode and scope lenses, 61 findings; what changed and what was rejected is in "Review notes" at the end). This is the design record for M4, written before any code so that citations like "M4 design §2.6" in code, tests and `docs/11` resolve. It is not a spec. Where it differs from `docs/03`–`docs/10` or the decision log, those win, and the approved plan (`docs/design/M4-plan.md`) wins over this record.
>
> **How it was made.** Four read-only digests of the repo at 67c03a8 (the spec and the research record; pmove; netcode; tests and tools; the client) fed one designer; three review lenses then checked the draft against the code. Every number marked **[calc]** comes from a 1-D model of friction, accelerate, trapezoid gravity and 1/16 / 1/32 rounding (it reproduces the documented 45.625 / 45.406 u apexes) or from the designer's size script (a scratch file; increment 2's static checks replace it), not from the docs. The research record is `docs/design/M4-movement-research.md` ("R"); its proposals are R §4.1 A1–A17 (`docs/02`) and R §4.2 B1–B50 (`docs/03`).
>
> **Mustafa's answers (2026-10-13, binding; `docs/design/M4-plan.md` "Your answers"):** Q1 (B): the research column is the default and the docs column is the `movement_preset docs` preset. Q2 (a): solid players, predicted; part 2 (i): keep `docs/05` §7 and log the temporary deviation until M6. Q3 (b): a capture in parallel whenever he likes. Q4 (a): the 15-minute pause after increment 6. Both FACT upgrades: yes. `docs/02` A1–A17: yes. Every other default in §8: kept. Where this record still says "the default until he answers" or "waits for Q1", read it as settled by these answers.
>
> Decisions D-052–D-065 go into `docs/11` in the increment that implements each one. Each increment edits only the doc text its code makes true (golden rule 6); §3 and §6 name those docs per increment. The close-out PR to main is merged (merge commit) once CI is green, because `main` has no branch protection for auto-merge to wait on; M4 is marked ☑ only after the feel sign-off increment (17).

## 0. Facts the plan relies on (main at 67c03a8; checked against the code)

### pmove today
- **Entry point** `pmove(ps, cmd, world, params, dt, events, debugLog)` (`packages/shared/src/sim/pmove/pmove.ts` L53–96), in place. Called by the match (`server/src/match/match.ts` L1231, events on), the predictor (`client/src/net/predictor.ts` L269 first prediction with events and log, L288 re-simulation with neither), the scenario runner (`tools/src/scenarios/runner.ts` L193), the MV-19 probe (`determinismProbe.ts` L182) and the primer.
- **Order:** start origin saved, `landing[0] = vz` (L62–66); view vectors; JUMP_HELD cleared on release (L70); pre-checks crouch (L72, the only hull writer), water (L75), ladder (L76); ground trace (L80–83, emits LAND inline); dispatch ladder → swim → walk → air (L84–87); post ground trace with settle (L88–91, LAND again); water level again (L92); `snapOrigin` world-only (L94); quantize (L95).
- **`docs/03` §3 puts the wall-jump and ledge-grab checks inside the air move** (step 4.5, and §4.5 step 5: "before step 2"). M4 keeps the wall jump there and moves the ledge check after the move (§2.8), keeping its air-move-only scope.
- **Landings fire mostly at the post-move trace** (L88): a fall ends in the air move's slide and the post trace grounds it. At L88 `waterLevel` still holds the pre-move sample; L92 refreshes it. The pre-move site catches only edge cases (kick-off ticks, spawns).
- **LAND value** = −vz at tick start (D-023), not the `docs/03` §5.6 analytic contact speed: it under-reads by up to g·dt ≈ 13 u/s and depends on tick phase.
- **Missing for M4:** the limp pre-check, a landing hook, the climb dispatch, slide, the wall-jump and ledge checks (comment in `airMove`, walk.ts L145), stamina, timers, breath. `cmdScale` (basics.ts L23–48) caps at run × walk × duck when crouched; it is called by walk (L108), air (L159, with `crouched`: the D-024 Q7 site), ladder (L100, crouched false) and water (L92). `checkJump` (walk.ts L59–79) charges no stamina.
- **Stance changes only in the crouch pre-check** at the tick's start origin (crouch.ts L19–30): the snap fallback relies on the start origin being clear for the tick's hull. So slide and climb end states take effect in the next tick's pre-check. The pre-check sets PMF_CROUCHED only while crouch is held; nothing else forces it today.
- **Ladder contact** (ladder.ts L50–68): refused on the ground unless forward is held; in the air no input is needed; refused while v·n > `LADDER_DETACH_SPEED` (16 u/s); the probe is a 2 u horizontal hull sweep along the yaw-only forward.
- **Nothing in the sim knows about other players.** `TraceResult.entity` is only world or none; contents have no body bit; `snapOrigin` is world-only on purpose (D-017: "a client's prediction never depends on where it thinks other players are").
- **`clipBrush`** (`world/trace.ts` L193–251) reads planes and contents from the `CollisionWorld`'s arrays by brush index; a start inside a brush sets `startSolid`/`allSolid`; exact ties go to the lower brush index; `finishTrace` (L253–300) always reports `ENTITY_WORLD`. The world arrays are shared by the predictor, the remote interpolator's extrapolation trace and every match in a process.
- **Deterministic math:** `dpow` does not exist (D-016: "follows in M4 for the fall-damage curve"); `Math.pow`, `**` and `Math.atan2` are banned in shared; `math/dtrig.ts` exports only `dsin`, `dcos`, `sinU16`, `cosU16`, `sinCosU16` (no atan2).
- **The primer** (`primer.ts`): `PMOVE_PRIMER_TICKS` 36800 (L50), world L132–204 (no chimney, ledge series, tall drop, slide lane, raised rim or second player), script L314–456 plus ladder and swim drills (Node 24 keeps a move function at Maglev until about 10k calls), scratch state L475–481, `startSegment` L483–494 **never sets stamina** (scratch stamina is 0). About 200–320 ms cold; eight fast-tier files prime (D-040). The coverage guard (`tools/long/pmove-primer.long.ts` L243–271, child `test/perf/pmoveCoverage.ts`) requires the primer to reach every block of the files its regex matches, **`/shared/src/sim/pmove/*.ts` only** (L38; excluding primer and scratch), that the MV mix reaches; the mix is `measureFeel()` (movement_lab only) plus the single-player MV-19 probe (L27–31).
- **Hot-path rules** (D-016, D-023, `.claude/rules/shared-simulation.md`): exact math plus `Math.sqrt/abs/min/max/round/floor`; no doubles across non-inlined calls (out-params, typed arrays, `pushFrom`); new fields at the end of fixed-shape classes; `refreshPmoveParams` (params.ts L215–248) stores fields by name in `PMOVE_CVARS` order, pinned by params.test.ts. pmove measures 2.2–2.5 µs per player-tick against ≤ 5 µs (`docs/10` §4.4); one box trace is 350–410 ns.
- **`docs/06` §3 plans the UrT layer as `sim/urt/`** (sprint, stamina, wallJump, powerSlide, ledgeGrab, fall, goomba, kick) **and the bandage rules in `combat/medic.ts`**. M4 follows that layout (gap 17).

### State and wire today (protocol v3)
- **PlayerState** (`sim/playerState.ts` L29–45): origin, velocity, viewYaw, viewPitch, flags, groundEntity, waterLevel, stamina (hundredths). `PMF_*` uses bits 0–9; `PMF_MASK` 0x3ff. SLIDING, CROUCH_PRESSED_IN_AIR, LEGS_BROKEN, LEG_WOUND and CLIMBING are never set today.
- **Codec** (`net/playerStateCodec.ts`): `PLAYER_STATE_BITS` 199 = origin 3×i21, velocity 3×i20, yaw 16, pitch 16, flags 10, groundEntity+1 16, waterLevel 2, stamina 16.
- **Snapshot** (`net/snapshot.ts`): header 86 bits (70 spectator; the flags byte is full: bits 0–3 flags, 4–7 starveSeq, D-050); the delta local block's 8-bit mask is full (L217–224), `LOCAL_DELTA_MAX_BITS` 219; entity records `ENTITY_NEW_BITS` 213, `ENTITY_DELTA_MAX_BITS` 233, flags 10 bits under `ENTITY_FLAG_MASK` 0x39f (no JUMP_HELD, no CROUCH_PRESSED_IN_AIR); 2 event slots of kind 4 + value 8; `eventsValid` refuses kinds above LAND (L295–300). A pending slot (above 37 players, D-046) is present with stamp 0 and a zeroed origin (`setPending`, L921–947); the decoder sets the receiver's own slot's team to 0 and carries no events for it (L1284–1291).
- **Size constants and checks** (L108–179): `SNAP_FIT_MAX_PLAYERS` 37 (literal plus a load-time throw), `SNAP_MIN_CAPACITY` 34 (full 37), `SNAP_MAX_STALENESS` 2 with a load-time throw if 2 × capacity < 63. Worst delta 942 B at 32 players, 1088 B at 37 (8700 bits: **100 bits of slack** before 37 becomes 36).
- **`playerStateToSlot`** (`net/worldFrame.ts` L188–199) writes v × 16 into `Int32Array`s, so a velocity off the 1/16 grid is truncated silently: the frame then differs from the server's own state.
- **Remotes already get every movement flag M4 animates** (grounded, crouched, sliding, climbing, on ladder, legs broken, leg wound, in water) and a 1 u/s velocity. The remote view (`client/src/net/remotes.ts` L119–148) exposes only `crouched`.
- **UserCmd** (`sim/usercmd.ts`): `BUTTON_SPRINT` (bit 3) is sampled and sent (`input/sampler.ts` L82; bind ShiftLeft, "inert until M4", `binds.ts` L30); `BUTTON_BANDAGE` (bit 7) exists with no action or bind; `weaponSlot` 0–7 is always 0 from the sampler and is the client's *requested* slot (`sanitizeUserCmd` only clamps it, L85). D-018: weaponSlot is the knife plus the seven `docs/04` §9 loadout slots (primary, secondary, sidearm, grenade, item1–3), so 0 knife, 3 sidearm, 4 grenade; which index is which was left open (`docs/05` §3.4 L150).
- **Server tick** (`match.ts` L640–690): sessions are sorted by client id; each ACTIVE session is simulated in that order, then `capture(t)`; `currentTick = t` is set only at the end of `tick()`. `respawn()` calls `spawn(s, currentTick + 1)` (L1099–1104) and steps `teleportSeq` (D-035); called during tick t it therefore spawns into frame t itself. `spawn()` (L1170–1199) resets flags, ground, water and stamina (`SPAWN_STAMINA` 10000, L153). Only PLAYER_JOIN and PLAYER_LEAVE reach `Match.tickEvents` (L1147, L1158), which is all the demo recorder writes.
- **Prediction** (`predictor.ts` L238–291): the client predicts only ticks after its newest snapshot and re-simulates from the snapshot tick A, so it never holds the server's frame for a tick it predicts. Movement events and the trace log are recorded on a tick's first prediction only (L269); `resimulate()` and `setPendingParams` pass null for both (L281–291).
- **`docs/05`:** §5 says damage to others, hit markers and deaths are not predicted; §7 says "**Melee and kicks: same rewind, short range**" (L416), while `docs/03` §5.9 keeps movement collision on current state; §10 says the client never shows predicted player hits. `viewInterpTick` is sent only while attack is held and joins in M6 (usercmd.ts L37).

### Tests and tools today
- MV-01, 03–08, 17 (basic), 18 (basic), 19 pass; **MV-02, 09–16 and 20 have no file**. Several hard-code the Q3 defaults (MV-01 `RUN_CAP` 320 and `BY_TICK` 36; MV-03 160/80; MV-04 the literal 800 at L61; MV-07/08 320; `slopes.ts` speeds and margins; MV-17 swim 160; MV-18 climb 160 and the 3.5 s bound; `StrafeCircuit` `AIR_GAIN_SPEED` 320 − 320/60, `scriptedInput.ts` L24–26). 32 files construct `new PmoveParams()`; `basics.test.ts` L295–303 pins D-024's "wading keeps the run, walk and crouch caps" for 320/160/80 and `water.test.ts` L194–206 expects 288 (320 − 32).
- `routes.test.ts` L46–47 asserts a route bot's top speed > 450 u/s and at least 3 laps.
- **The acceptance guard cannot parse "MV-01…MV-20" or "NET-03/04"** (`acceptance-ids.test.ts` L100–108 reads them as MV-01, MV-20, NET-03); `MILESTONES` holds M2 and M3 only. `docs/09` M6 uses the same notation ("BAL-01…BAL-11"). `scripts.test.ts` L265–269 lists the MV suites.
- **`ScenarioRecord`** records origin, velocity, flags, yaw, snap and events only; `placePlayer` has no health or armor; the runner and the MV-19 probe are single-player; nothing presses sprint.
- **The cvar doc golden** (`tools/test/docs/pmove-cvars-docs.test.ts`) parses `pm_` names only (L24), pins the §2.1 heading to "FACT for Q3" with label FACT-Q3 (L63–66) and allows only `pm_autoHop` from §2.2 (L21). The `st_*` table (§5.2) has no doc guard.
- **Feel report** (`tools/src/reports/feelReport.ts`): 20 rows, movement_lab only; **its targets stay at the defaults whatever the run simulates with** (L87–117, "the targets stay the defaults' (P)"); its test runs `measureFeel` three times (one in a CLI subprocess).
- **Fast tier** at M3 close: 46–50 s wall, 133–148 CPU-s against 55 s / 165 CPU-s; a slower VM ran 60–68 s. Movement + reports + greybox: 11 files, 6.1 s.
- **Tools:** the speedometer (`cl_speedometer`, a **bool** cvar, `clientCvars.ts` L39–43; the registry accepts only 0/1/true/false, `registry.ts` L316–320), the trace draw (`PmoveTraceLog` capacity 64, no kind tag) and live cvars exist; no input recorder, no ghost runs, no strafe helper. The Worker map is hard-wired to movement_lab (`app/boot.ts` L47, L96); offline the Worker starts with `sv_cheats` 1 (`workerCvars.ts` L12); `?bot=<unknown>` stands still with a console warning (boot.ts L120). `pnpm dev:server --map <name>` exists (`server/src/node/config.ts` L105–124).
- **Client presentation:** no audio at all, no speed trail, no landing dip, no stamina or health display; the client consumes only PMEV_STEP; the own player is never drawn.

### Spec gaps found while digesting (golden rule 6; each gets a resolution in §9)
1. The water-jump has no rule and no values (`docs/03` §4.13 L250–251).
2. Drowning: a fixed 8 s to death, or ≈ 12.5 HP/s whatever the health?
3. Boot on teammates: `docs/02` L98 ("needs friendly fire on") conflicts with `docs/03` L402 (a shove with friendly fire off).
4. Impact speed: analytic at contact (§5.6) vs the LAND value at tick start (D-023).
5. The goomba "head region" is undefined before M6 hitboxes.
6. Bandage is `docs/04` §3.4 (M6), but MV-15 asks "bandage clears limp" now.
7. The boot needs the held weapon; which `weaponSlot` is which is open (D-018), and the cmd carries only the requested slot.
8. The ladder catch from a fall: instant stop, or ground friction (≈ 15 ticks from 1000 u/s)?
9. What the predicting client collides against for other players; the server's order dependence.
10. Unlabelled §5 numbers (sprint 50 u/s and |f| ≥ |r|; probe heights feet + 8 and + 40; |n.z| < 0.3; the ledge +8 offsets, "1 u above the ledge", 0.15 s, 0.2 s; the stationary 10 u/s).
11. `st_sprintDrain` 11/s runs at 10.8/s (§6 rounding), so 100 → 0 takes 9.26 s, outside docs/03's own 8–9 s target [calc].
12. `docs/07` §6 metrics (apex ≈ 45, ledge ≈ 76) and the `fall_tower` rails follow the current values.
13. `docs/02` L52 ("kept Quake III's movement speeds") is wrong per R (A1).
14. **The §5.5 chest probe (feet + 40) cannot see a ledge lower than 40 u above the feet**, so `pm_ledgeMinHeight` 24 acts as 40 today.
15. `docs/03` §6 lists `movementEvents` as a PlayerState field; D-023 keeps events out. `docs/03` §6 says health u8 and timers u16; `docs/05` §4.1 says "1 ms or ticks, u16".
16. **Boot hit test:** `docs/05` §7 rewinds kicks like melee; `docs/03` §5.8/§5.9 make the boot a movement probe on current positions; the lag-compensation history and `viewInterpTick` arrive in M6.
17. **Module layout:** `docs/06` §3 plans `sim/urt/` and `combat/medic.ts`; the first draft of this record put everything under `sim/pmove/`.
18. **Ledge-check placement:** `docs/03` §3/§4.5 run it inside the air move before accelerate; a narrow window needs a swept check after the move (D-058).

## 1. Package layout

The dependency graph is unchanged (shared ← server ← client ← tools). No new dependency: Web Audio and three.js's audio classes ship with the browser and three (~0.186.1).

### shared (`packages/shared/src`)
| File | Change |
|---|---|
| `sim/playerState.ts` | v4 fields (§2.2) appended; `PMF_GRAB_LOCK` = bit 10; `PMF_MASK` 0x7ff; copy, equals, diff; quantize with the canonical rules (§2.2); `resetPlayerStateForSpawn` (every v4 field) |
| `sim/events.ts` | kinds 4 WALLKICK, 5 GRAB, 6 BOOT, 7 WATER_JUMP (wire); 8 SLIDE_START, 9 SLIDE_END, 10 FALL_DAMAGE, 11 GOOMBA (local only, §2.2) |
| `sim/players.ts` (new) | `PlayerBoxes`: a struct of typed arrays (count, id, team, origin, crouched) kept in ascending id, the mover's id and team, an output `touched` count (§2.11); `addBox` (the one writer, id order); `buildBoxesFromFrames(frameT, frameTm1, mover, params, out)` (the server's selection from frames, used by the parity check) |
| `sim/pmove/pmove.ts` | signature gains `others: PlayerBoxes` (always passed, count 0 when alone; D-023 amended, D-061); the M4 pipeline (§2.1); the dead gate |
| `sim/pmove/pmTrace.ts` (new) | the one hull-trace wrapper pmove uses: world trace merged with `boxTrace` (§2.11) |
| `sim/pmove/basics.ts` | `cmdScale`: sprint, limp, low-stamina scale, crouch factor on the ground only (Q4 default) |
| `sim/pmove/landing.ts` (new) | the landing step (§2.1 step 7): calls `urt/fall`, `urt/goomba`, `urt/powerSlide` entry, the wall-jump reset |
| `sim/pmove/ladder.ts`, `water.ts` | foot rule, top-mount probe, catch (§2.9); water-jump, breath and drowning (§2.10) |
| `sim/pmove/params.ts` | every new `pm_*`/`st_*`/`bd_*` row (§4.1) and `sv_ghostAll`/`sv_ghostTeammates` in a fixed order (all read through `paramsFor(tick)` on the client) |
| `sim/pmove/presets.ts` (new) | the two default columns of §4.1 as data (`MOVEMENT_PRESETS.docs`, `.research`) |
| `sim/pmove/primer.ts` | M4 course pieces, a second scratch player, segments, drills (§2.15) |
| `sim/pmove/debug.ts` | trace kinds; capacity 64 → 128 |
| `sim/urt/sprint.ts` (new) | sprint activity (§2.4) |
| `sim/urt/stamina.ts` (new) | drain, regen law, costs, max from health and vest |
| `sim/urt/wallJump.ts` (new) | the 18 probes, the candidate choice, the impulse (§2.6) |
| `sim/urt/kick.ts` (new) | the boot trigger, `heldWeaponSlot(ps, cmd)`, BOOT (§2.11) |
| `sim/urt/powerSlide.ts` (new) | entry, slide move, exits (§2.7) |
| `sim/urt/ledgeGrab.ts` (new) | swept grab check, climb move (§2.8) |
| `sim/urt/fall.ts` (new) | impact speed, damage curve, legs (§2.5) |
| `sim/urt/goomba.ts` (new) | the head test on landing (§2.11) |
| `combat/medic.ts` (new) | the self-bandage timer (the M4 subset of `docs/04` §3.4) |
| `world/boxTrace.ts` (new) | the hull swept against player boxes: its own AABB clip with clipBrush's ε arithmetic, no writes to `CollisionWorld` (§2.11) |
| `math/dpow.ts` (new) | `dexp2`, `dlog2`, `dpow` from exact operations (D-016) |
| `net/playerStateCodec.ts` | v4 local block, 281 bits |
| `net/snapshot.ts` | header `contactSeq` u4; 18-bit local mask; new event kinds and value rules; static checks recomputed; load-time width checks (§2.2) |
| `net/worldFrame.ts` | one strided `Int16Array(64 × 11)` for the local-only fields with named lane offsets (`LF_*`); conversions; `frameDigest` |
| `net/events.ts` | EVENTS kinds 4 `PLAYER_DEATH`, 5 `HIT_CONFIRM` |
| `net/protocol.ts` | `PROTOCOL_VERSION` 4 |

### server (`packages/server/src`)
| Path | Change |
|---|---|
| `match/match.ts` | builds `PlayerBoxes` per simulated player from the live states (§2.11); collects boot and goomba effects during the tick and applies them after all `simulate` calls, before `capture`, re-quantizing each state it changes; a DEV_ASSERT in `capture()` that every captured state is a fixed point of quantize; steps each session's `contactSeq`; deaths: `PLAYER_DEATH` to every joined player and into `tickEvents`, respawn at the start of the next tick; `HIT_CONFIRM` to the attacker; spawns through `resetPlayerStateForSpawn` (health 100, armor from `sv_spawnVest`); spawn occupancy check |
| `match/session.ts` | `contactSeq`; pending respawn |
| `match/commands.ts` | `movement_preset <docs\|research>` (admin: rcon, stdin, the Worker's own client) |

### client (`packages/client/src`)
| Path | Change |
|---|---|
| `net/predictor.ts`, `net/clientSim.ts` | `PlayerBoxes` per predicted tick from the snapshot store (§2.11: slots with state only, the newest frame extrapolated, the mover's team from the roster); the touch bit from every pmove call; contact classification; `STAT_CONTACT_CORRECTIONS` and the contact metrics |
| `net/roster.ts` | the receiver's team for `PlayerBoxes`; `PLAYER_DEATH` console line; `HIT_CONFIRM` → impact sound |
| `net/remotes.ts` | `RemoteView` gains horizontal speed and the presentation flags |
| `net/smoothing.ts` | `LandingDip`; `ViewHeight` keyed on the hull actually used (sliding, climbing); the top mount's drop smoothed like a step |
| `net/scriptedInput.ts` | `MechanicsTour` (`?bot=tour`), `idle` (`?bot=idle`, no warning); `StrafeCircuit` speed from the replicated params |
| `net/cmdRecorder.ts` (new) | `.cmds` writer and reader (DOM-free) |
| `net/ghost.ts` (new) | re-simulates a `.cmds` run into a state ring (DOM-free) |
| `audio/planner.ts` (new) | event → voice, priorities, pool, `jumped` and teleport filtering, swing vs confirmed impact (DOM-free) |
| `audio/webAudio.ts` (new) | synthesized placeholder buffers, panner per voice, resumed on the pointer-lock click; no-op without `AudioContext` |
| `render/fx/speedTrail.ts` (new) | pooled per-slot history, one draw call, cut on teleport and hide |
| `render/ghostMesh.ts` (new) | one translucent capsule, placed by `space.ts` |
| `render/debug/debugDraw.ts` | probe colours by kind; probe hold |
| `hud/overlay.ts`, `hud/speedometer.ts`, `hud/vitals.ts` (new), `hud/strafeHelper.ts` (new) | slide and climb states; `cl_speedometerDetail` line; HP (rounded up) and stamina readout; a canvas strafe helper |
| `app/boot.ts`, `app/game.ts`, `app/demoGame.ts` | `?map=` for the Worker; trail, ghost, sounds, dip wiring |
| `console/commands.ts`, `console/binds.ts`, `app/settings.ts` | `cmdrecord`, `cmdstop`, `ghost`, `movement_preset` (forwarded), `cvardiff`; `+bandage` on KeyF; new default binds merged into a saved set when their key is free |

### tools (`packages/tools`)
- `src/scenarios/`: `ScenarioRecord` keeps a ring of whole quantized PlayerStates; `placePlayer` takes health, armor, stamina, velocity; a multi-player runner (`MultiScenarioRunner`, server-order boxes from live states, deferred effects as the match applies them); bots `SprintRun`, `CircleJump` (forward only, steers by yaw; MV-09), `WallKicker`, `SlideRun`, `LedgeApproach`, `Kicker`, `Stomper`.
- `src/replay/cmdReplay.ts` + CLI `pnpm cmd-replay <file> [--set name=value …] [--json]`.
- `src/reports/feelReport.ts`: all four movement courses, the full §8 table, two target columns (§2.14).
- `src/greybox/courses/`: movement_lab "M4 yard", jump_lab `ledge_116` and `ledge_128` (§2.14).
- `src/vectors/`: pmove, trace (box-trace cases) and determinism vectors with the v4 fields and `dpow`.
- `test/guards/acceptance-ids.test.ts`: expands "X-01…X-20" ranges and "NET-03/04" slashes (unit cases), `MILESTONES` M4.
- `test/perf/pmoveCoverage.ts`: the regex and the MV mix widened (§2.15).
- tests in `test/movement/` (MV-02, 09–16, 20), `test/net/` (NET-03/04 legs, the frame-replay parity check), `test/perf/` (workloads), `long/` (sweeps, 16-client legs, the CLI subprocess smokes).

### Root and docs
CLAUDE.md commands table (`pnpm cmd-replay`); `docs/02` §3 and §13–§15 (A1–A17, a separate yes/no, §8); `docs/03` (§2–§10 per increment); `docs/04` §3.4, §8.6, §9 notes; `docs/05` §3.3–§3.6, §4, §5, §7, §8.1, §10, §13, §14; `docs/06` §3 (module map per increment), §6, §7, §10; `docs/07` §3, §6; `docs/09` M4 status, M8 note; `docs/10` §1, §2, §4; `docs/11` D-052…D-065. The per-increment list is in §6.

## 2. Data structures and algorithms

### 2.1 The M4 tick pipeline (`docs/03` §3 amended, D-055–D-061)
1. View angles; JUMP_HELD cleared on release; **GRAB_LOCK cleared when neither forward nor jump is held** (§2.8).
2. **Dead gate:** health 0 → the cmd is treated as neutral (no axes, no buttons, the same angles); physics still runs.
3. **Pre-checks** at the start origin: crouch (stance and hull; **PMF_CROUCHED is forced while SLIDING or CLIMBING**, §2.7–§2.8; sets CROUCH_PRESSED_IN_AIR on an airborne crouch press), water level, ladder (§2.9: forward > 0 for every attach; an airborne attach with vz < 0 zeroes vz), **limp** (LEGS_BROKEN or LEG_WOUND, read by `cmdScale`), **sprint activity** (§2.4; derived each tick, not stored).
4. **Landing inputs and the pre ground trace:** vz₀ = max(0, −vz) and the start feet height are sampled **here, after the pre-checks**, so a ladder catch on this tick counts. Then the ground trace; an air → ground transition sets a local `landed` mark and saves the horizontal speed at contact (after the ground clip); nothing else happens here.
5. **Dispatch** (first match wins): CLIMBING → climb move (§2.8); on ladder → ladder move; water-jump timer > 0 → air move; water ≥ 2 → swim move (water-jump check first, §2.10); grounded → slide move if SLIDING (§2.7), else walk move; else air move. **A tick whose dispatch is not the slide move clears SLIDING and emits SLIDE_END** (a slide that leaves the ground off an edge or a crest, or meets a ladder or water). The walk move's jump runs before friction as today, with its stamina cost and the weak-jump rule (§2.4). The air move runs the **wall-jump check before accelerate** (§2.6) and the **boot check** (§2.11).
6. **Post ground trace** (with settle) and **water level again**, as today. A walk-move tick that leaves the ground without a jump runs the **top-mount probe** (§2.9).
7. **Landing step** (new, once per tick, after 6 so it sees the post-move water level, D-060): if either ground trace set `landed`: impact speed vi (§2.5), LAND event with value vi, then in order: goomba (landing on a player box, §2.11), fall damage and legs unless excused (§2.5; the landing that ends a climb is excused), slide entry (needs PMF_GROUNDED now and uses the saved contact speed, §2.7), wall-jump counter reset on walkable ground, CROUCH_PRESSED_IN_AIR cleared.
8. **Ledge check** (D-058): only on a tick whose dispatched move was the air move, or the walk move when `pm_ledgeFromGround` is 1 and the move was blocked; never on climb, ladder, swim or water-jump ticks; on the tick's swept interval (§2.8). A kick earlier in this tick does not block it.
9. **Vitals and timers:** stamina (§2.4); breath and drowning (§2.10); regen delay, boot cooldown, re-grab, water-jump and bandage countdowns; the self-bandage (§2.5).
10. Snap (world only, D-017) and quantize every field, with the canonical rules (§2.2).

Landing effects run once even when both traces turn the player grounded (they can't both: the pre trace grounds, the move keeps it grounded). Events are emitted where they happen; the order inside a tick is fixed (D-023's events contract is unchanged: output only).

### 2.2 PlayerState v4 and protocol v4 (D-053)

**Units:** every timer counts ticks (1/60 s is no whole number of ms; `docs/05` §4.1 pinned to ticks). Every field is an integer that quantize clamps to its codec width, so "decode accepts ⇒ quantize leaves it unchanged" keeps holding. Remote records do not change.

**New and changed local-block fields** (appended after stamina, except the flags field, which widens in place):

| Field | Bits | Range and quantization | Read by | Changes |
|---|---|---|---|---|
| flags | 10 → **11** | bit 10 `PMF_GRAB_LOCK` (owner only, outside `ENTITY_FLAG_MASK`); bits ≥ 11 refused | ledge | on a drop and on releasing forward and jump |
| `wallJumps` | 3 | 0–7; `pm_maxWallJumps` range 0–7 (a trials range up to 100, B8, would need u7 and a bump) | wall jump | per kick, per landing |
| `health` | 14 | **hundredths**, 0–16383 (game max 10000); truncate, clamp | stamina max, dead gate, fall, drown | on damage, drowning, respawn |
| `armor` | 2 | bit 0 vest, bit 1 helmet | stamina max | at spawn |
| `submerged` | 11 | ticks with the eye sample under water, saturating at 2047; 0 when the eyes are out | breath, drowning | every tick under water |
| `climbHeight` | i12 | 1/32 u, ledge top − origin z (±64 u, so `pm_ledgeMaxHeight` < 88); 0 unless CLIMBING | climb | every climb tick |
| `climbYaw` | 8 | **the view yaw at the grab >> 8** (the direction the wall probe ran; no atan2, D-016); 0 unless CLIMBING | climb pull and finish | on grab |
| `regenDelay` | 7 | ticks, 0–127 (`st_regenDelay` range 0–2.1 s) | regen | after each cost |
| `kickCooldown` | 6 | ticks, 0–63 (`pm_kickCooldown` 0–1.05 s) | boot | after a boot |
| `regrab` | 4 | ticks, 0–15. Outside CLIMBING the re-grab countdown (`pm_regrabDelay` 0–0.25 s); **while CLIMBING the climb finish's ticks left** (`pm_climbFinishTime` 0–0.25 s; 0 = rising) | ledge, climb | after a drop; during a climb |
| `waterJump` | 6 | ticks, 0–63 (`pm_waterJumpTime` 0–1.05 s) | water-jump | during a water-jump |
| `bandage` | 8 | ticks held, 0–255 (`bd_time` up to 4.25 s) | self-bandage | while bandaging |

`ΔPS` = 82 bits, so `PLAYER_STATE_BITS` = **281**. Health in hundredths, like stamina, makes `staminaMax = health × factor` one unit and lets drowning (12.5 HP/s), M6 bleeding (5 HP/s) and healing (12/6 HP/s) run without a hidden accumulator (an integer-HP health would need one, which would itself have to be in PlayerState). Whole HP (u7) would save 7 bits.

**Fields deliberately not added:** sprint and walk (derived from cmd and state each tick); the slide time (the slide ends on speed); a separate climb timer (the finish counts in `regrab`, §2.8); a ladder-catch mark (the catch zeroes vz, §2.9); `movementEvents` (D-023: output only; `docs/03` §6 corrected); a dead flag (health 0 is the gate); a "rising from a ground jump" flag (the ladder rule needs only forward, §2.9).

**Canonical rules, in quantize** (so "quantize ⇒ encodable" holds whatever path cleared a flag: a drop, a death, a spawn, a future teleport): `climbHeight` and `climbYaw` are zeroed whenever CLIMBING is clear; flags are masked to `PMF_MASK`. The encoder still refuses a non-canonical state (a bug), but quantize makes one impossible.

**Spawn:** `resetPlayerStateForSpawn` resets every v4 field (health 10000, armor from `sv_spawnVest`, everything else 0, flags 0); `spawn()` and `placePlayer` use it; the field guard covers it.

**Load-time width checks** (next to the snapshot layout checks): for every tick field, round(cvar max × 60) ≤ 2^bits − 1 (`st_regenDelay`, `pm_kickCooldown`, `pm_regrabDelay`, `pm_climbFinishTime`, `pm_waterJumpTime`, `bd_time`); `pm_maxWallJumps` max ≤ 7; (`pm_ledgeMaxHeight` max − 24) × 32 ≤ 2047; `pm_climbPopHeight` range −8…16. A later range change then fails at load instead of saturating a field silently.

**Delta local block:** the mask grows from 8 to **18 bits**, one per field: bits 0–7 as v3 (flags now 11 wide), 8 wallJumps, 9 health, 10 armor, 11 submerged, 12 climb (height and yaw together), 13 regenDelay, 14 kickCooldown, 15 regrab, 16 waterJump, 17 bandage. A set field is sent absolute at its width. `LOCAL_DELTA_MAX_BITS` 219 → **311**. Decode checks: flags bits ≥ 11 refused; climb fields ≠ 0 without CLIMBING refused; ranges as above (the hostile-packet table gains each).

**Header:** a 4-bit **`contactSeq`** after `teleportSeq` (not in spectator snapshots; §2.11). `SNAP_HEADER_BITS` 86 → **90**; spectator header 70 unchanged.

**Entity records:** unchanged layout (ΔE = 0). Event kinds 0–7 are accepted with these value rules: WALLKICK 0, GRAB 0, BOOT = victim id (< 64), WATER_JUMP 0; LAND carries the analytic impact speed / 16 (≤ 255). Kinds 8–15 are refused: slide start and end, fall damage and goomba stay local (remotes derive slides from the SLIDING flag's edges and a hurt sound from LAND's value with the replicated cvars), so the 2 event slots stay enough (a slide landing would otherwise emit LAND + SLIDE_START + FALL_DAMAGE in one tick and lose the oldest on a clean link). A kick and a grab on one tick (§2.8) fill both slots; no LAND can join them (airborne).

**EVENTS** (reliable):
- kind 4 `PLAYER_DEATH`: victim 6, cause 3 (0 fall, 1 drown, 2 goomba, 3 boot, 4 world; 5–7 refused), hasKiller 1, killer 6 when hasKiller. Sent to **every joined player** in the death tick's EVENTS and appended to `Match.tickEvents`, so demos record it; `DemoPlayer` and `pnpm demo-info` handle it (golden updated). The client prints it in the console (the kill feed is M6).
- kind 5 `HIT_CONFIRM`: victim 6, cause 3 (0 boot, 1 goomba; 2–7 refused in v4). Sent to the attacker only (not recorded in demos). It gates the impact sound (§2.12).
- Both are the M4 subset of M6's combat feed; M6 extends them (weapon, zone) with its own protocol bump, which it needs anyway for weapon state. Kinds 6–15 stay refused.

**Size bounds** (computed by `scratchpad/v4sizes.mjs`; type byte included):

| Case | v3 | v4 |
|---|---|---|
| `SNAP_FULL_FIXED_BITS` / `SNAP_DELTA_FIXED_BITS` | 292 / 312 | 378 / 408 |
| Full, alone / 16 / 32 / 37 players | 37 / 436 / 862 / 995 B | 48 / 447 / 873 / 1006 B |
| Worst delta, 32 / 37 players | 942 / 1088 B | 954 / 1100 B (8796 bits) |
| `SNAP_FIT_MAX_PLAYERS` | 37 (100 bits slack) | **37 (4 bits slack)** |
| `SNAP_MIN_CAPACITY` / full | 34 / 37 | **33** / 37 |
| Worst scheduled delta, 63 remotes | 34 records + 29 deferred, 1088 B | 33 + 30, 1073 B |
| `SNAP_MAX_STALENESS` 2 (2 × capacity ≥ 63) | 68 ≥ 63 | 66 ≥ 63, holds |
| Spectator delta, 64 entities | 1874 B | 1874 B (unchanged) |

Reading it: the default 32-player match still never runs the scheduler; 37 players still fit by construction, with 4 bits of slack, so **M4 may not grow the local block or the header further** without re-deciding 37 → 36 (D-034, D-046 wording). The review round's fixes (the climb finish, the boot trigger, deaths) add no bits. `SNAP_MIN_CAPACITY` 34 → 33 is derived and statically checked; it changes the D-046 numbers ("at least 33 records, at most 30 left out"). M4 uses 96 of the 499 bits that keep 2 × capacity ≥ 63 at 64 players; M6's ammo, weapon state, zoom, bleeding and wounds share the remaining 403. The levers, if a later field must fit: whole-HP health (−7), dropping the re-grab timer under B41 (−5; the finish counter would then need its own bits), grouping the timer masks (−4), or narrowing player entity ids (−10 per record, a D-033 policy change).

**Bandwidth:** about +10–20 bits on a typical delta while timers and breath run, +75–150 B/s per client against ≈ 13.8 KB/s per bot today. **Memory:** the **eleven** local-only fields live in one strided `Int16Array(64 × 11)` per `WorldFrame` with named lane offsets (≈ +1.4 KB per frame, ≈ +90 KB per mirror, ≈ +5.8 MB at 64 players; ESTIMATE, measured in increment 2) instead of eleven arrays. The field guard asserts the lane count equals the number of v4 scalars (11).

**Protocol v4 and demos:** one `PROTOCOL_VERSION` 4 for the milestone, with the whole layout above fixed in increment 2 (D-033's precedent: nothing is released between increments). Later increments only give the fields their meaning; any layout change after increment 2 is a plan amendment. HELLO's pin becomes `010400`; v3 demos are refused by their header; `DEMO_VERSION` stays 1 (spectator snapshots hold entity fields only; the new EVENTS kind is recorded). `.cmds` recordings (§2.13) are tied to their protocol and build; the header records both.

**Prediction parity coverage:** every new field joins `copyPlayerState`, `playerStateEquals`, `diffPlayerState`, `quantizePlayerState`, the codec, `playerStateToSlot`/`slotToPlayerState`, `copySlot`, `frameDigest`, the remote zeroing (`copyEntity`, `setPending`, `readNewBody`), `resetPlayerStateForSpawn`, `placePlayer`, the MV-19 digest, the pmove and determinism vectors. Two checks guard it:
- **A behavioural field guard** (name lists drift from the code and can't see a field copied wrong): for each key of `new PlayerState()`, set a distinct in-range value on a quantized state and assert that copy copies it, equals and diff see it, quantize keeps it, the full and delta codecs round-trip it, `playerStateToSlot` → `slotToPlayerState` and `copySlot` keep it, `frameDigest` changes, and the remote zeroing clears it. It also asserts the frame lane count.
- **A "restart from the wire" leg in NET-03 and MV-20** (no field guard can see state kept outside PlayerState, such as a module-scope variable in a new move function): for every tick t of the `MechanicsTour`, in shuffled order, decode the server's snapshot of t into a fresh PlayerState, run pmove with the cmd of t + 1, and assert it equals the server's t + 1 (0 diffs). It covers mid-climb, mid-finish, mid-slide and mid-water-jump starts.

### 2.3 Parameters, superset models and presets (D-052)
Every place where `docs/03` and R disagree on a **rule** (not only a value) is written as one formula whose cvars select either reading. So Q1 decides defaults, not code, and a feel session can switch columns with one command.

| Conflict | One formula | Docs reading | Research reading |
|---|---|---|---|
| Sprint with strafe (B22) | sprint needs forward > 0 and \|right\| ≤ `pm_sprintStrafe` × forward | 1 (forward dominant) | 0 (no net strafe; AWD still sprints) |
| Drain and regen in the air (B23, B27) | `st_airFreeze` 1 freezes stamina while airborne | 0 | 1 |
| Stamina while climbing (B27, B40) | `st_climbFreeze` 1 freezes it while CLIMBING | 0 ("climbing is free": no cost, regen runs) | 1 (R T7) |
| Regen law (B27) | rate = (h < `st_idleSpeed` ? `st_regenIdle` : `st_regenMove`) − `st_regenSpeedSlope` × h, may go negative | 18 / 5 / slope 0 | 20 / 20 / 0.0764 |
| Low-stamina penalty (B24) | run and sprint caps × (`st_lowSpeedScale` + (1 − scale) × min(1, stamina / `st_lowSpeedKnee`)) | scale 1 (none) | 0.75, knee 25 |
| Weak jump at low stamina (B28) | below `st_jumpCost`: vz = `st_weakJumpVelocity`, horizontal × `st_weakJumpScale` | 270, 1 (a full jump) | 202, 0.5 |
| Kick tiers (B28, B34) | refused below `st_wallJumpMin`; weak (`pm_wallJumpWeakUp/Push`) below `st_wallJumpWeak` | 8 / 8 (no weak tier) | 5 / 12 |
| Kick while rising (B34) | `pm_wallJumpRising` 0 allows kicks only at vz ≤ 0 | 1 | 0 |
| Cancel into the wall (B35) | `pm_wallJumpCancel` | 1 | 0 |
| vz after a kick (B9) | vz = max(vz, `pm_wallJumpUp`) | 290 floor | 270; identical to "set" whenever kicks are descending-only |
| Boot press (B45, R "boot repeat") | `pm_bootFreshPress` 1 needs a fresh jump press, 0 boots while jump is held | 1 ("jump pressed") | 0 (holding jump booted before 4.3; 4.3.0 removed only the ground case) |
| Slide deceleration (B12) | decel = `pm_slideDecel` + `pm_slideFriction` × speed, no stopSpeed floor | 0 + 0.8 × speed | 125 + 0 |
| Slide end (B13) | ends below `pm_slideEndSpeed` | 120 | 300 |
| Ledge from the ground (B15 derivation) | `pm_ledgeFromGround` | 1 (grounded and blocked) | 0 (needs a jump) |
| Climb rise, finish (B17, B40) | rise at `pm_climbSpeed` with `pm_climbAccel` (0 = instant) to top − `pm_climbPopHeight`, then the finish onto the ledge over `pm_climbFinishTime` (§2.8) | 180, instant, −1 (1 u above, `docs/03` §5.5), 0.15 s | 70, 750, 7, one tick |
| Re-grab (B41) | needs `regrab` = 0 (`pm_regrabDelay`) and, when `pm_regrabPress` 1, a fresh press (GRAB_LOCK clear) | 0.2 s, 0 | 0, 1 |
| First fall damage | for vi ≥ safe: damage = `pm_fallMinDamage` + (100 − min) × t^curve (§2.5) | 0 (the `docs/03` formula) | 1 HP |

**Presets and what is tested:** `presets.ts` holds both columns of §4.1 as data. The admin command `movement_preset docs|research` sets every M4 cvar from one column (the Worker's own client is admin offline; on the Node server it goes through rcon), as **one CVARS block with one effective tick**. After Q1 **the chosen column is the spec**: `docs/03` carries its defaults, and the MV bands and the feel report's targets are its own. The other column stays as data for A/B in the feel session and is covered by one smoke (the preset loads; MV-01 and MV-04 pass against its own derived targets) plus the few both-preset cases named in §5; it is not a second maintained spec. **Algorithm unit tests and set 0 of the pmove vectors use an explicit `MOVEMENT_PRESETS.docs` fixture**, so switching the default column changes no algorithm test and no frozen vector; only the scenario and feel tests that judge the default column re-target.

### 2.4 Sprint and stamina (D-055)
- **Sprint active** (derived per tick): sprint held; forward > 0 with |right| ≤ `pm_sprintStrafe` × forward; **walk not held** (FACT, Beta 2.1; `docs/03` is silent, so this fills a gap in both columns); stamina > 0; not crouched; water < 2; **not on a ladder** (both columns: the ladder move has its own scale, and R's 4.3.0 fix says no drain there); not limping; not dead.
- **Cap:** `cmdScale`'s speed = sprint ? `pm_sprintSpeed` : run, × walkScale when walking, × duckScale when crouched **on the ground** (Q4 default: the Q3 lineage; today it also applies in the air), × limpScale when limping, × the low-stamina scale for run and sprint only. Sprint raises the air wish cap too (`docs/03` §4.5, FACT behaviour).
- **Stamina per tick**, in hundredths, quantized by rounding as today:
  - frozen when `st_airFreeze` and airborne, when `st_climbFreeze` and CLIMBING, and the regen part in water ≥ 2;
  - sprint active and h > `st_sprintMoveSpeed` (50, the unlabelled number becomes an ESTIMATE cvar): − `st_sprintDrain`/60, and the regen delay restarts;
  - otherwise, once `regenDelay` = 0: + rate/60 by the §2.3 law (negative rates drain);
  - costs at their sites: ground jump `st_jumpCost`, crouch-down transition `st_crouchCost` (no drain while moving crouched, FACT 4.2.007), wall kick `st_wallJumpCost`, slide start `st_slideCost`; each restarts `regenDelay` (`st_regenDelay`, in ticks); the boot costs nothing (design);
  - clamp to [0, staminaMax], staminaMax = health × (vest ? 0.5 : 1) in hundredths (vest: FACT wording, our reading of "cuts stamina in half", B29; capture #9 settles max vs drain).
- **`st_sprintDrain` 11 → 12 /s** (ESTIMATE retune in both columns, a default in the plan's list): 11/s rounds to 18 hundredths per tick (10.8/s), so 100 → 0 takes 9.26 s, outside `docs/03`'s own 8–9 s target; 12/s is exactly 20 hundredths per tick (no rounding bias) and gives 8.33 s, closer to R's 12.5 lead. Logged in D-055.
- **Weak jump** (§2.3) when stamina < `st_jumpCost` points; the cost clamps at 0.
- **Vest hook:** `armor` bit 0, set at spawn from the SERVER cvar `sv_spawnVest` (0; design, until M6 loadouts). Prediction reads the state, not the cvar.
- **HUD:** stamina and health in points (§2.12).
- **Test bots and stamina (D-055):** the M3 net and bot suites (NET-02/04/05/07/08/09/12, `routes.test`, the e2e smoke) were tuned on bots that hop without stopping. Under the research rules a non-stop hopper is empty after about 16 hops and then jumps weakly. So those suites keep their sustained strafe-jump load with stamina costs off: the harness sets three replicated overrides through the server (`st_jumpCost 0`, `st_regenSpeedSlope 0`, `st_lowSpeedScale 1`), printed in each test's log. The new M4 legs (the `MechanicsTour`, the collision legs) use the real rules. The bots CLI and the load tier use the real rules too, with `RouteInput` pacing its hops by stamina (it stops hopping below 20 points and runs until 60). `StrafeCircuit`'s `AIR_GAIN_SPEED` and `routes.test`'s speed threshold are re-derived from the replicated params, and the `docs/10` measured figures are re-baselined in increments 3 and 6.

### 2.5 Health, fall damage, broken legs, limp, deaths, bandage (D-054, D-060)
- **Health** in hundredths (§2.2); spawn 10000 (100 HP, FACT max).
- **Impact speed** vi = √(max(0, vz₀² + 2 g · max(0, Δz))), with vz₀ = max(0, −vz) sampled after the pre-checks (§2.1 step 4) and Δz = start feet − landing feet. Exact under constant gravity, independent of tick phase, only `Math.sqrt` (D-016). Δz is 0 when the landing point is above the tick start (an air-move step-up onto a ledge, a jump-onto, the climb's end), so vi is then vz₀ (or 0 while rising) instead of the square root of a negative number, which quantize would map to 0 health. **LAND's value becomes vi** (D-023 amended); remotes get vi / 16 as before.
- **Damage:** 0 below `pm_fallSafeSpeed`; lethal at or above `pm_fallLethalSpeed`; otherwise `pm_fallMinDamage` + (100 − min) × t^`pm_fallCurve` with t = (vi − safe) / (lethal − safe), through the new deterministic `dpow` (exp2/log2 from exact operations, determinism vectors, browser replay). Damage is in hundredths, truncated.
- **Excused:** landing in water ≥ 2 (the post-move level), on `nodamage` ground, on another player's head with vi ≥ legs speed (goomba, §2.11), and **the landing that ends a climb** (LAND 0; no slide entry). A ledge grab and a ladder catch zero vz, so the next landing is gentle anyway.
- **Legs:** vi ≥ `pm_fallLegsSpeed` sets LEGS_BROKEN; LEGS_BROKEN or LEG_WOUND limps (× `pm_limpScale`, no sprint); the slide ignores limp (FACT).
- **Calibration** (`docs/03` §6): the research column's thresholds sit just under √(2 g h) of the FACT heights so that a 200.125 u drop hurts and a 394.125 u drop kills in our sim. At g = 750: √(2·750·200.125) = 547.9 and √(2·750·394.125) = 768.9, so the defaults are **547.8** and **768.8** (R rounds to 548/769, which would leave a 394.125 u drop at 99.9 damage). Without a minimum the first damage would round to nothing: a 200.125 u drop gives t = 0.0004 and 0.0004 HP, truncated to 0, and the first whole HP would come at a ≈ 209 u drop [calc]. Hence `pm_fallMinDamage` (research 1 HP, ESTIMATE: integer-HP games show at least one point; docs 0, as written): a 200.125 u drop costs 1 HP, 200 u costs 0. At the top, 394 u leaves 0.03 HP, so **the HUD shows HP rounded up** (a living player never reads 0). MV-15 tests both heights ±1/8 u.
- **Death:** health 0 → the dead gate (§2.1). The server keeps the dead player in the death tick's frame (health 0 at the landing spot, with that tick's events) and **respawns it at the start of the next tick** (`respawn()` → `spawn(s, t + 1)`, the same timing `respawn()` already has between ticks; teleportSeq steps, so the client takes it as a teleport, not a correction). Calling `respawn()` inside tick t would spawn into frame t itself (§0), so the death would never appear in any frame and its sounds would play at the spawn point. `PLAYER_DEATH` goes to every joined player with the cause from the tick's events (fall, drown) or from the effect (goomba, boot). Respawn delay is effectively one tick (design, until M7's mode rules). The respawn view snap stays deferred (D-035).
- **Self-bandage hook** (pulled from `docs/04` §3.4, `combat/medic.ts`; a default in the plan): hold `+bandage` (KeyF, design) for `bd_time` (3.0 s, ESTIMATE, replicated) to clear LEGS_BROKEN and LEG_WOUND; the `bandage` timer counts held ticks and resets on release. Bleeding, the 64 u target rule and "cannot fire" come with M6.
- **Bugs not to copy** (B43): a squeeze between misaligned solids causes no fall damage (vi is computed from the vertical fall only); wall-hugging with jump held never cancels fall damage without a grab.

### 2.6 Wall jump (D-056)
- **Preconditions:** airborne; not on a ladder; water < 2; not CLIMBING; jump freshly pressed (JUMP_HELD clear); `wallJumps` < `pm_maxWallJumps`; vz ≤ 0 unless `pm_wallJumpRising`; stamina ≥ `st_wallJumpMin` points.
- **Probes:** a horizontal hull-edge sweep of length 15 + `pm_wallJumpReach` in 8 compass directions plus the wish direction, at feet + 8 (`WALLJUMP_PROBE_LOW`, design constant) and feet + `pm_wallJumpMinHeight`; the high probe is skipped in a direction whose low probe missed. A **wall candidate** needs both heights to hit world geometry with |n.z| < 0.3 (`WALLJUMP_MAX_NZ`, design constant). On this fresh press a direction whose probe hits a player box first is a **boot candidate** (when the boot is eligible, §2.11). The choice runs over both kinds together: the normal most opposed to the wish direction, ties to the nearer hit, then the lower direction index (wish direction first, then the compass from +x), so it is deterministic and independent of trace order. A chosen wall kicks; a chosen player boots. At most 18 traces, only on a fresh press while airborne. (The boot also has its own trigger, §2.11, so it does not need this press.)
- **Impulse:** if `pm_wallJumpCancel` and v·n < 0, remove v·n; add n × push; vz = max(vz, up); keep the tangential part; push and up are the weak values below `st_wallJumpWeak` points. `wallJumps` += 1, cost, JUMP_HELD, WALLKICK event.
- **Reset** on walkable ground in the landing step (not on ladders or water, FACT); whether a grab, a ladder or water resets it is capture #15 (default: no; a finished climb lands on walkable ground and resets it).

### 2.7 Power slide (D-057)
- **CROUCH_PRESSED_IN_AIR** is set by the crouch pre-check when crouch is held, was not held at the tick's start (PMF_CROUCHED clear) and the player is airborne; it clears on landing and on release.
- **Entry** in the landing step: **PMF_GROUNDED at that point** (a pre-trace landing whose walk move jumped is airborne again and does not slide), crouch held, the flag set, and the horizontal speed **saved at landing contact** (§2.1 step 4) ≥ `pm_slideMinSpeed`, so it does not depend on which ground trace grounded the player (a pre-trace landing would otherwise measure after the walk move's friction). Set SLIDING (CROUCHED stays set, so remotes draw the crouched capsule), charge `st_slideCost`, SLIDE_START.
- **Slide move** (grounded and SLIDING): deceleration per §2.3 on the horizontal speed, then accelerate toward the wish with coefficient `pm_slideSteer` (Q3-style: no input, or forward along a faster velocity, adds nothing, so the view alone doesn't steer; strafe keys bend the path). The **wish speed is `cmdScale` with crouched false, no limp and no sprint: the run cap** (× walkScale when walking), as B14's "as in air" reads, not the crouched cap (a 2.2× difference in steering). Then the walk move's ground-plane step-slide. Limp is ignored.
- **Exits** (SLIDE_END): speed < `pm_slideEndSpeed` → crouched walk; crouch released → the next pre-check stands if it can; jump → a normal jump before friction (momentum kept: R says 100%); **any tick whose dispatch is not the slide move** (§2.1 step 5: off a ledge, a crest kick-off, onto a ladder, into water), so a slide never resumes on a later landing without the entry rules and the cost.
- Sticky air crouch (B37) stays open (capture #4): a tap in the air is not enough in either column.

### 2.8 Ledge grab and climb (D-058)
- **Where:** after the move (pipeline step 8), on the tick's swept interval, so a narrow window cannot be skipped in a fast fall ([calc] a 768 u fall moves 17.9–18.5 u per tick against R's 8 u window). **Only on ticks whose dispatched move was the air move, or the walk move when `pm_ledgeFromGround` is 1 and the move was blocked by a wall; never on climb, ladder, swim or water-jump ticks.** `docs/03` runs the check inside the air move; these exclusions keep that scope, without which the last 58–76 u of every ladder would become a grab (the ladder face is near-vertical and the pillar top a ledge), a CLIMBING player would re-grab every tick, and a water-jump arc would grab the pool rim it should land on.
- **Check:** forward or jump held (support both, R #13); not crouched at the tick's start, not SLIDING, water < 2; GRAB_LOCK clear when `pm_regrabPress`; `regrab` = 0; and **not leaving the wall**: the tick-start velocity along the wall normal, v·n ≤ `LEDGE_LEAVE_SPEED` (16 u/s, design constant, like `LADDER_DETACH_SPEED`). A kick earlier in the same tick does not block the check (the gate reads the tick start, before the kick's push), so an apex kick and its grab share a tick: R's "the grab wins on the next frame" (an 8 ms frame) falls inside our 16.7 ms tick. From the next tick on the push leaves the wall at 200 u/s and the gate refuses, which is what keeps the post-kick reach at the FACT (below).
- **Wall probe:** a horizontal line trace from the tick-end origin along the view yaw at feet + `pm_ledgeMinHeight` − 8 (gap 14: the docs' feet + 40 cannot see a ledge below 40 u, so it becomes a derived height), length 15 + `pm_ledgeReach`, hitting a world surface with |n.z| < 0.3.
- **Top probe:** from above the wall (moved forward by the wall distance + 8 u, design constant), trace down from **max(start feet, end feet)** + `pm_ledgeMaxHeight` + 8 to **min(start feet, end feet)** + `pm_ledgeMinHeight`, so a rising tick probes the whole window it swept. A walkable top h passes when the window in feet terms, [h − max, h − min], overlaps the tick's travel [min(s, e), max(s, e)] (falling and rising alike; grabs while rising, B42).
- **Space probe:** the crouched hull fits on the top at the probe point.
- **Grab:** feet z = clamp(start feet, h − max, h − min), the first point of the tick's travel inside the window (on a take-off tick the travel starts inside it); xy = the tick end. A position test of the tick's hull there; no grab if not clear. Velocity zeroed (vertical: FACT; horizontal: B40, filling a docs silence in both columns); CLIMBING; PMF_CROUCHED set (the next pre-check keeps it while CLIMBING, so the rise and the finish sweep the hull the space probe tested; remotes follow through the networked CROUCHED flag; R: "you arrive crouched"); `climbHeight` = h − origin z; `climbYaw` = viewYaw >> 8; `regrab` = 0; GRAB event.
- **Climb move** (crouched hull, no gravity; the stored horizontal velocity stays 0):
  - **Rise** (`regrab` = 0): vz ramps to `pm_climbSpeed` at `pm_climbAccel` from the stored vz (instant at 0); the hull is also pulled toward the wall: one hull trace along forward(`climbYaw`) by `CLIMB_PULL_SPEED` · dt (240 u/s, design constant), moving to the trace's end. It stops at the wall and never slides along it, so an angled wall causes no sideways drift, and it is a displacement, not a stored velocity. The hull therefore touches the wall before the finish (every rise lasts at least 8 ticks, 32 u of pull against `pm_ledgeReach` 18 [calc]). When the feet reach h − `pm_climbPopHeight` they stop there, vz = 0, and `regrab` = N = clamp(round(`pm_climbFinishTime` × 60), 1, 15).
  - **Finish** (`regrab` = r > 0): the hull moves straight up or down by (h + ε − feet) / r, then forward along forward(`climbYaw`) by `CLIMB_FINISH_FORWARD` / N (23 u in total: from touching the wall to 8 u past its face, the point the space probe tested), through slide moves without gravity; r −= 1. When r reaches 0 the post ground trace must find walkable ground: the climb ends grounded on the top with CLIMBING clear, velocity 0 and `regrab` 0, still crouched (the next pre-check stands when crouch isn't held and there is room). Otherwise the player drops. The research column's one-tick finish is the 7 u "one-frame pop" plus the forward step; the docs column rises 1 u above the top (`docs/03` §5.5) and finishes over 9 ticks.
  - **State-complete:** every step reads only PlayerState (`climbHeight`, `climbYaw`, `regrab`, vz), the cvars and the world, so a re-simulation that starts mid-rise or mid-finish reproduces the server (NET-03 and MV-20's restart-from-the-wire leg, §2.2). Nothing is left moving on arrival.
  - **Drop:** a rise or finish tick that makes no progress (blocked), or releasing forward and jump: v = 0, CLIMBING clear, GRAB_LOCK set, `regrab` = `pm_regrabDelay` in ticks.
  - Stamina frozen when `st_climbFreeze` (§2.4).
- **Reach against the FACT heights** (research column; [calc] apex 48.59 u at g 750, 60 Hz):
  - **Lowest, standing jump:** the take-off tick sweeps the feet from 0.031 to 4.43 u, so a ledge from 58.03 u above the floor up is grabbed, 60.375 u (FACT minimum, DEV32198) at every tick phase. Ledges of 58.03–60.375 u are grabbed where UrT jumps onto them (the same end state: you end up on top). A window floor of 60.344 would reproduce the FACT exactly with our swept check (R's window floor assumed one 2.1 u frame of rise before the first check) at the cost of a 2.3 u narrower window in falls; that is a feel-session knob, not a default change.
  - **Highest, standing jump:** 48.59 + 66.1 = 114.69 u (FACT 114.625). R's derivation says 66.1; B16 rounds to 66, which would miss the 114.625 u FACT by 0.035 u.
  - **After an apex kick:** the kick tick sweeps apex → apex + 4.40, so 119.09 u (FACT 118.75, DEV32198's +4.125); from the next tick the leave gate refuses. 120 u is never grabbed off one wall.
  - **Docs column:** 24.03–121.6 u standing, 126.4 u after an apex kick (vz 290); `ledge_128` is out of reach in both columns.
- **Ranges:** `pm_ledgeMaxHeight` < 88 (climbHeight's i12), `pm_climbFinishTime` ≤ 0.25 s (`regrab`'s 4 bits), checked at load (§2.2).

### 2.9 Ladders completed (D-059)
- **Foot (Q4 default):** a fresh jump while grounded at the foot is a ground jump, not a push-off (the ladder dispatch yields to the walk move's jump on that tick). **In the air the ladder attaches only with forward held, rising or falling.** The D-024 candidate rule (forward only while rising, falling catches unchanged) does not deliver "a standing jump doesn't hang": the standing jump would rise unattached and attach on its descent about 48 u up, where the catch stops it. The FACT catch ("drop and turn back at the last moment to stop unhurt") is performed with forward held in MV-18. Alternative (not the default): forward-free catches only for real falls (vz < −`pm_jumpVelocity`).
- **Top mount (Q4 default):** its own probe. Skipping `LADDER_DETACH_SPEED` alone cannot mount: on the walk-off tick the hull is still above the face, and one air tick later it is 1.8–5.3 u past it (walk to run, both columns), beyond the 2 u reach. So: on a walk-move tick that leaves the ground without a jump while back is held (forward < 0) and jump is not held, a horizontal sweep of the tick's hull from the tick-end origin lowered by `pm_stepSize`, along the yaw-only forward, by `pm_ladderReach` + the horizontal distance moved this tick. If it hits a `SURF_LADDER` face that passes the facing test, the player is placed at the sweep's end (ε off the face, `pm_stepSize` lower; a position test), the velocity is clipped so v·n ≤ 0 with vz = 0, and PMEV_STEP carries the drop so the client smooths the view as on a step down. The next pre-check finds the face at ε and attaches as usual. One extra trace, only on walk-off ticks with back held.
- **Catch:** attaching while airborne with vz < 0 sets vz = 0 (INFERRED from "drop and turn back at the last moment to stop unhurt", FACT, DSWP); gap 8. vz₀ for the landing step is read after this (§2.1 step 4).
- **Sprint:** inactive on ladders (§2.4). Walk keeps its scale on a ladder (silent), crouch doesn't slow climbing (FACT, matches today).

### 2.10 Water completed: water-jump, breath, drowning (D-059)
- **Water-jump** (our design, every value ESTIMATE; Q4 default): at water level 2 (waist in, eyes out: the bobbing swimmer), forward held, a forward probe at feet + 28 of length 15 + `pm_waterJumpReach` hits a near-vertical face and the same probe at feet + 50 is clear (the rim is below the eyes). The two heights are design constants tied to existing ones (`WATER_SAMPLE_WAIST` and the standing eye), not feel knobs. Then vz = `pm_waterJumpVelocity`, horizontal = −n × `pm_waterJumpPush`, `waterJump` = `pm_waterJumpTime` in ticks, WATER_JUMP event. While the timer runs the air move replaces the swim move (gravity, no water friction) and no ledge check runs (§2.8), so the arc carries the player over the rim; it ends on landing or at 0. [calc] 280 u/s lifts the feet ≈ 49 u (g 800) or 52 u (g 750) from the bob, clearing rims up to about 24 u above the surface; the step-up handles the last 18 u. This closes the flush-rim trap (D-024 Q8) in both columns.
- **Breath and drowning** (FACT): `submerged` counts ticks with level 3; surfacing (level < 3) resets it at once. After 960 ticks (16 s) the player drowns: in drown tick k (k = submerged − 960) the damage is ⌊10000 (k + 1) / 480⌋ − ⌊10000 k / 480⌋ hundredths, so 100 HP lasts exactly 480 ticks (8 s) and a hurt player dies sooner (the rate reading of "≈ 12.5 HP/s"; a default in the plan). Integer arithmetic only. A drowning death respawns with cause drown.
- **No sprint and no regen in water ≥ 2** (§2.4).

### 2.11 Player collision, ghosting, goomba, boot; the contact counter (D-061)
**Boxes.** `PlayerBoxes` lists the other players a mover collides with, **always in ascending id**: their origin (1/32 u grid, exact), crouched flag (hull height), team and id. Ghosted players are left out: `sv_ghostAll` 1 drops everyone, `sv_ghostTeammates` 1 drops the mover's team (both REPLICATED, default 0; **read through `PmoveParams`**, so the client switches them at the CVARS block's effective tick via `paramsFor(t)`, never from the mirror registry early). Team 0 (none) has no teammates. pmove always receives a `PlayerBoxes`, count 0 when alone (the primer's solo segments too), never null, so production and the primer share one call shape.
- **Server inputs:** the live session states (below).
- **Client inputs:** only slots with state, present and stamp ≠ 0 (above 37 players a pending slot is present with stamp 0 and a zeroed origin, which would be a phantom box at the map origin; a deferred slot with an older stamp is fine); the mover's own team from the roster (`PLAYER_JOIN`), since the decoder sets the receiver's own team to 0.

**Box traces** (`world/boxTrace.ts`): **its own AABB clip**, not a temporary brush in the world's arrays: the same ε arithmetic as `clipBrush` against the box's six axial planes expanded by the mover's hull, a preallocated per-module plane scratch, and no writes to `CollisionWorld` (its arrays are shared by the predictor, the interpolator's extrapolation trace and several matches). The pmove trace wrapper (`pmTrace`) merges it with the world result by fraction, with an explicit tie order: **world first, then players by ascending id**, identical on client and server. `TraceResult.entity` = the player id. **A box the trace starts inside is skipped for that trace** (not `startSolid`), so overlapping players (a spawn on a spawn, a crouch under someone) separate instead of sticking. Every hull trace in pmove goes through `pmTrace`, the stand test too; `snapOrigin` stays world-only (D-017). The ground trace may find a player box: `groundEntity` = that id (standing on heads). A pre-filter keeps only boxes within the tick's reach (origin ± |v|·dt + hull + step size), so the usual cost is one AABB scan of ≤ 63 entries. Box-trace cases join the committed trace vectors, replayed by `pnpm test:browser` in Chromium, Firefox and WebKit; a unit test builds two touching boxes in both insertion orders and gets one result.

**Which positions** (order and prediction):
- **Server:** players are simulated in client-id order (`docs/05` §8.1, already so). Player i collides with each other player's newest state the server holds: players with a lower id have already moved this tick, higher ids are at T − 1 (the Q3 model). Two players can't end a tick overlapping. Boot and goomba effects on others are collected during the tick and applied after every `simulate`, before `capture` (damage, knockback, death), so mutual boots resolve independently of order (B46). **The deferred step re-quantizes every PlayerState it changes** (a diagonal knockback leaves the 1/16 u/s grid, and `playerStateToSlot` would truncate it, so the frame and the server's own state would differ and the client would mispredict on a tick with no contact); the same rule binds any later server mutation outside pmove (M6 hits). A DEV_ASSERT in `capture()` checks every captured state is a fixed point of quantize.
- **Client:** the client only predicts ticks after its newest snapshot and re-simulates from the snapshot tick (§0), so it never holds the server's frame for a tick it predicts. For predicted tick t, each remote's box is **its newest stored frame F, extrapolated by its networked velocity** (entVel, 1 u/s) over min(t − F, `CONTACT_EXTRAP_MAX_TICKS`) ticks (15, 250 ms, design constant), with no vertical motion for a grounded remote, rounded to the 1/32 u grid; client-only and never traced. Every contact with a moving remote is therefore a guess: close for a steady runner, off by up to the remote's whole change of motion over about RTT + `cl_inputBuffer` when it turns or stops (≈ 48 u at 320 u/s and 150 ms). The box is ahead of the drawn capsule by about (interp delay + RTT) × speed, as the server's truth is. Re-simulating from the same frames gives the same boxes. The fallback, if increment 4's numbers favour it (D-061): collide with the drawn `RemoteView` positions (what you see is what you bump), at the cost of more corrections against movers.
- **Contact counter:** the server steps the session's 4-bit `contactSeq` (header, §2.2) once on every tick that the player's own pmove touched a box (a trace hit, ground on a player, a probe hitting a player) or that the server changed its state from outside its pmove (boot knockback and damage now; M6 hits later). The client records a per-predicted-tick "touched a remote" bit from `PlayerBoxes.touched` **after every pmove call, first predictions and re-simulations (`resimulate`, `setPendingParams`) alike**, so the bits always describe the current predicted path. A correction is a **contact correction** (`STAT_CONTACT_CORRECTIONS`) when the counter moved since the previous snapshot received, or the current predicted path touched a remote since the last matching snapshot. A **misprediction** becomes a correction with neither a starve nor a contact since the previous snapshot (D-050 extended); the bots summary, the e2e health rule and the server-stall test keep holding mispredictions to 0. Limits as D-050's: 16 contact ticks between two received snapshots with the counter back where it was read 0, but the client's own touch bits usually still classify them.
- **Gates and metrics:** NET-04's correction-rate and mean bounds (`docs/05` §14, `docs/10` §1: < 1/s, mean < 2 u, render offset < 8 u, measured while strafe-jumping alone) **count mispredictions and starves only**, as M3 measured them. Contact corrections get their own metrics, reported on the 16-client arena leg and on scripted two-client `wan-150-loss2` legs ("push against a strafing player", "stand on a moving head", "boot a strafing player"): contact corrections/s, mean and max distance, render-offset max. Their bounds are ESTIMATEs set from increment 4's measurement (starting guesses: mean < 8 u, render-offset max < 16 u) and shown to Mustafa with Q2's numbers. D-061 and `docs/10` §1 say so.
- **The exact multi-player check** (bypasses the classifier, which would otherwise hide a real client/server difference on contact ticks): a 2–16-player match through `MultiScenarioRunner` or the harness, with `Kicker`, `Stomper` and route bots, deaths and spawns. For every tick t and player i, rerun i's pmove from the server's frame t − 1 state with i's cmd, with boxes from the shared `buildBoxesFromFrames` fed with the server's own frames t and t − 1 (lower ids from t, higher from t − 1), apply the tick's recorded deferred effects, and assert frame t bit for bit (0 diffs). It also asserts that the live-state builder and the frame builder give identical boxes.

**pmove reads only replicated inputs** (D-061): the cmd, PlayerState, `PlayerBoxes` and `PmoveParams`. Team rules and `g_friendlyFire` (a SERVER cvar) gate only the server-side effects (damage, knockback, death), so a blocked teammate boot still emits BOOT and sets `kickCooldown` on both sides, and the attacker's prediction never depends on them. (If Mustafa wants a blocked boot to become a wall jump instead, `g_friendlyFire` must become REPLICATED and part of `PmoveParams`.)

**Goomba:** the landing step finds the mover grounded on a player box (its top face is the "head region" until M6 hitboxes) with vi ≥ `pm_fallLegsSpeed`: the attacker takes no fall damage and GOOMBA is emitted (local). The server kills the victim (death, cause goomba; `HIT_CONFIRM` cause goomba to the attacker) unless both are teammates with `g_friendlyFire` 0 (SERVER, design until M6; UrT leaves the teammate rule unstated).

**Boot** (B45, B46): **its own trigger**, separate from the wall-jump press, as R's "sprint at the player, jump, time the apex with the collision" needs: on each airborne tick with jump held (a fresh press only when `pm_bootFreshPress` 1), not on a ladder, in water < 2 or CLIMBING, with `kickCooldown` 0 and `heldWeaponSlot(ps, cmd)` ∈ {0 knife, 3 sidearm, 4 grenade} (D-018's open mapping pinned; the sampler sends 0, so every player can boot in M4): only when the pre-filter has a box in reach, the 9 probe directions (wish direction, then the compass) sweep the hull against the boxes; a world trace in a hit's direction confirms it is not behind a wall. It is not gated by `wallJumps`, the vz sign or the stamina tiers. A fresh press near both a wall and a player picks one through §2.6's choice. A hit: BOOT (value = victim id), JUMP_HELD, `kickCooldown` = `pm_kickCooldown`; no wall jump on that press; the kicker's velocity is unchanged (a design rule; UrT's is unknown). The usual cost stays zero (no box in reach, no probe). The server then applies 20 HP (FACT, body zone) and `pm_kickKnockback` along the probe direction to the victim (re-quantized), unless the teammate rule blocks it, and sends `HIT_CONFIRM` to the attacker.
- `heldWeaponSlot(ps, cmd)` returns `cmd.weaponSlot` until M6 puts the held weapon and its switch state into PlayerState; otherwise a client could boot instantly by requesting slot 0 on the jump tick once weapon switching has switch times. It goes on the M6 checklist in the handoff.
- **Lag compensation (Q2 part 2):** in M4 the server tests the boot against current positions, like movement collision (`docs/03` §5.9). `docs/05` §7 says kicks use the same rewind as melee, and the history and `viewInterpTick` arrive in M6. Recommended (Q2b i): keep `docs/05` §7 and log M4's behaviour as a temporary deviation; in M6 pmove keeps deciding the boot attempt on current boxes on both sides, and the server resolves the victim against rewound boxes at the validated `viewInterpTick` (then sent on boot presses too), clamped to `sv_maxRewindMs`. Alternative (ii): amend §7 so boots stay pmove probes on current positions, with the high-ping cost stated in D-061.

**Spawns:** the spawn rotation skips occupied spawns (a box test against current players); if all are occupied it uses the next one anyway (the start-inside rule separates them).

### 2.12 Presentation hooks (D-062)
- **Speed trail** above `pm_trailSpeed` (600, FACT; REPLICATED, never read by pmove) on **horizontal** speed (our choice, R B48; capture #16). Remotes from `RemoteView`'s new horizontal speed (interpolated from `entVel`), demo playback likewise, the own player only in third person. One pooled ribbon per slot in a DOM-free core, one draw call, cut on `teleported` and on hide, team colour.
- **Placeholder sounds** (pulled from M8; the prompt asks for wall kick, grab and slide; jump, land and boot are a default in the plan): synthesized with Web Audio oscillators and noise (no asset files, no licence rows) for jump, land (scaled by impact), wall kick, grab, boot and slide start. Local sounds come from the first prediction's events (`jumped` ones skipped), **except player hits: a predicted BOOT plays only a swing, and the impact plays on `HIT_CONFIRM`** (`docs/05` §5 and §10: player hits are server-confirmed; the local block carries no server events, so nothing else would correct a false impact sound); a stomp sound plays on the attacker's `HIT_CONFIRM` cause goomba. Remotes from the interpolator's events at the drawn position; slide start and end for remotes from SLIDING edges. A DOM-free planner (priorities, a pool of 16 voices) and a thin backend resumed on the pointer-lock click; a no-op where there is no `AudioContext` (Node, headless, autotest). `s_volume` 0.5 (ARCHIVE, design). Footsteps stay out (M8).
- **Landing dip:** a `LandingDip` smoother beside `StepSmoother`, fed by LAND (depth from vi, capped), added to the eye in `updatePose`; reset on teleport. `cl_landDipScale`, `cl_landDipMs` (ARCHIVE, ESTIMATE). `ViewHeight` follows the hull used (sliding and climbing: crouched; the climb's pop and the top mount's drop smoothed like a step).
- **HUD:** the speedometer's mode follows the M4 dispatch (climb, ladder, water, slide, ground, air; the e2e regex `/\d+ u\/s {2}vz/` is kept); a separate bool **`cl_speedometerDetail`** (ARCHIVE; `cl_speedometer` stays a bool, so no settings migration) adds a second line (stamina, wall jumps left, legs, sprint, slide or climb); an always-on vitals readout "HP 100  ST 100" with **HP rounded up** (placeholder; M8 styles it).

### 2.13 Tuning tools (D-063)
- **Strafe helper** (`cl_strafeHelper` 0, ARCHIVE + **CHEAT**: a skill aid on public servers in a game whose identity is movement; offline the Worker runs with `sv_cheats` 1, so it works there): a canvas overlay at the crosshair drawn per frame without allocating, showing the ideal air wish angle for the current speed (cos θ = (wish − accel·dt·wish) / |v| from the replicated params of `predictor.paramsFor`), the current wish direction and the sprint state.
- **Probe visualizer** (lands with the wall jumps, increment 8, so the wall and ledge probes are debugged with it): `PmoveTraceLog` records a kind per trace (move, ground, step, ladder, top mount, wall-kick probe, boot probe, ledge wall/top/space, water-jump, player box) and holds 128; `r_debugProbes` (CHEAT) colours probes by kind and keeps the last probe set for `r_debugProbeHoldMs` (1000 ms), since a probe runs for one tick.
- **Input recorder and replayer:** `.cmds` v1: magic, version, protocol, build hash, map name and content hash, the replicated cvar block, the start PlayerState (codec form), then the sanitized cmds (tick delta, buttons, axes, angles, weaponSlot). A file is tied to its protocol and build (the header says which made it). Client: `cmdrecord [name]` / `cmdstop` (the browser downloads the file and keeps the last recording in memory; `record` is the server's demo command). Tools: `pnpm cmd-replay <file> [--set name=value …] [--json]` re-simulates headless on the named map and prints a per-second summary (speed, height, stamina, events) and, with `--set`, the divergence against the recorded parameters (A/B tuning).
- **Ghost runs:** `ghost` with no argument replays the last recording held in memory; `ghost pick` opens a file picker (so a Downloads file never needs an `/@fs/` path); `ghost <url>` or `?ghost=<url>` loads a URL. The run is re-simulated in the client with the current replicated cvars into a state ring and drawn as one translucent capsule (`render/ghostMesh.ts`, placed through `space.ts`), started when the player's next run starts (the first cmd with move input after `ghost`, or a `ghoststart` bind). Draw-only.
- **`cvardiff [docs|research]`** (client console): prints every replicated cvar that differs from the named preset (default: the default column) as a ready `docs/11` table (name, preset value, current value, label). It is the feel session's export (lands in increment 3).
- **`?map=<course>`** for the Worker (movement_lab, jump_lab, slide_lab, fall_tower, arena_greybox), so every mechanic can be played offline on its course; **`?bot=idle`** stands still without a warning (a stomp and boot dummy).
- **`movement_preset docs|research`** (§2.3).

### 2.14 Feel report and courses (D-064, D-065)
- **Feel report:** `measureFeel` runs on movement_lab, jump_lab, slide_lab and fall_tower; the header lists each course's hash; the table gains the §8 rows MV-02 and MV-09–MV-18 (sprint cap and drain time, circle-jump peak, kick limit, kick redirect and chimney gain, slide entry and distance, grab window and reach, climb time, the 768 u catch, regen 0 → 100, vest max, fall damage at the column's drops, legs threshold, goomba and boot outcomes, breath, drown, water-jump, ladder top mount) and status rows for MV-19 and MV-20. **Two target columns:** "implementation" (derived from the active parameters, pass/fail: does the code do what the parameters say) and "reference" (the chosen preset's FACT/INFERRED observable with its source, the delta and the label: how far the tuning has moved from UrT's run 220, apex 48.53 u, lethal 394.125 u and so on). A `set pm_runSpeed 240` therefore still passes its implementation rows and shows its distance from the reference. Increment 3 adds the reference column to today's 20 rows; increment 15 adds the rest. `docs/03` §7 gets the measured values at close.
- **movement_lab "M4 yard"** (in a quadrant clear of every existing anchor's path, checked by `courses.test.ts`): a 64 u chimney, a kick wall, a ledge block at 64 u and a crawl-space ledge (a 44 u opening above its top), a 400 u platform with a ladder and a nodamage pad below another drop, and a pool section with a rim 8 u above the surface. It puts every mechanic on the map the NET harness, MV-19, MV-20, the primer coverage mix and the offline Worker use.
- **jump_lab:** `ledge_116` (research: grabbable only after an apex kick, 114.69 < 116 ≤ 119.09; docs: from a standing jump) and `ledge_128` (out of reach in both: maxima 119.09 / 126.4 u, §2.8).
- **fall_tower** is kept: its 256/512/768 u platforms serve the docs column; the research column's thresholds (200.125, 394.125 u) and the legs threshold are tested from placed starts above flat floor at 1/8 u resolution, plus one walk-off per tier from the platforms. Its rails are re-checked against the window in use (the swept check removes the "can't skip the face" sizing constraint).
- `docs/07` §3 and §6 updated (apex, ledge reach, metrics for the chosen column).

### 2.15 Primer growth (D-040 amended)
Every increment that adds a pmove branch adds, in the same commit: course pieces to `buildPrimerWorld` (a chimney and kick wall, two ledges at the active window, a drop tall enough for the lethal tier, a nodamage pad, a raised-rim pool, a ladder top approach, a slide lane); script segments (with stamina, health and the new fields seeded in `startSegment`, for example a drown segment that starts at `submerged` 950); drills for each new move function (slide move, climb move) of about 10k calls; tally counters (`primer.test.ts`) and the inertness dump; the shared-purity import pin for new imports.
- **A second scratch player** (a box in `PlayerBoxes`) reaches the collision, goomba and boot branches. The primer **always passes a `PlayerBoxes`**: empty in solo segments, the second player in contact segments, never null, matching the server's and the predictor's call shape.
- **The coverage guard widens** to every file pmove reaches in M4: `sim/pmove/*.ts`, `sim/urt/*.ts`, `sim/players.ts`, `world/boxTrace.ts`, `math/dpow.ts`, `combat/medic.ts` and any new trace entry point. Its MV mix adds the two-player MV-10/MV-16 scenarios and the four-course feel report. The no-retry guard gains first-kick, first-slide, first-grab, first-fall and **first-contact** windows (two players meet after the solo warm-up), since native-ESM allocation workloads warm up first and cannot see a first-use transient (D-023).
- **No pass under the other preset** (a live `movement_preset` switch changes values, not code paths; added back only if a measurement shows a transient).
- **Budget:** the primer's cold time is measured every increment and reported as "priming files × Δms" against the fast-tier allowance (§2.16); design target ≤ 450 ms cold on the 4-vCPU VM (today 200–320 ms); `PMOVE_PRIMER_TICKS` set by measurement. New fast-tier files whose checks are logical turn the primer off (the D-049 (6) precedent).

### 2.16 Test budget and tiers
The fast tier has 5–9 s of headroom (46–50 s of 55). M4 may add at most **+5 s wall and +15 CPU-s in total**, reported each increment, including primer growth (priming files × Δms). The feel-report test drops from three `measureFeel` runs to one in the fast tier (the variant and the CLI subprocess move to the long tier), which pays back about 1.2 s. Placement (D-032 rule):
- **Fast:** one `MechanicsTour` NET-03 file and one NET-04 tour smoke (`wan-100-loss1`), each growing per mechanic increment; a 2-client contact smoke; `cmd-replay` run in process; MV fast cases.
- **Long:** sweeps (fall heights at 1/8 u, the ledge window and the top mount at every tick phase, slide distances over entry speeds, chimney phases), the full NET-04 tour legs, **the 16-client solid-player legs (`net-04-reconciliation.long.ts`)**, the two-client `wan-150-loss2` contact legs, the exact multi-player check at 16 players, the other-preset smoke, the `cmd-replay` CLI subprocess smoke and goldens.

## 3. Decisions (each lands with its code and only the doc text that code makes true)

| ID | Decision | Inc. | Doc updates |
|---|---|---|---|
| D-052 | **M4 movement values** (Mustafa's Q1 answer): which column of §4.1 is the default (A until he answers); the §2.3 superset formulas and the presets; labels for the chosen column; the MV re-targets of §4.3 (MV-01's 200/219 u/s points logged, not asserted); the gravity reading (B6: `pm_gravity` is player movement only; M6 projectiles keep their own 800); the hull kept (R did not propose a change); after Q1 the chosen column is the spec and the other a preset with a smoke; the M3 suites' stamina overrides. Amended in increment 17 with the sign-off values | 3, 17 | `docs/03` §2.1–§2.3, §4.2 (wading caps at the chosen values), §5, §7, §8; D-024's wading sentence (note); `docs/07` §6; `docs/10` §1, §2 (re-baselined M3 figures). `docs/02` §3, §13–§15 (A1–A17) only on its own yes (§8) |
| D-053 | **PlayerState v4 and protocol v4** (§2.2): fields, widths in ticks and hundredths, `regrab` doubling as the finish counter, the 11-bit flags, the 18-bit local mask, `contactSeq`, event kinds 4–7 on the wire and 8–11 local, EVENTS `PLAYER_DEATH` (broadcast, in demos) and `HIT_CONFIRM` (attacker only) as the M4 subset of M6's feed, eleven packed local-only frame lanes, the canonical rules in quantize, the spawn reset, the load-time width checks, the behavioural field guard and the restart-from-the-wire legs, `SNAP_MIN_CAPACITY` 33, `SNAP_FIT_MAX_PLAYERS` 37 kept (4 bits slack), v3 demos refused, one v4 for the milestone with the layout fixed in increment 2 | 2 | `docs/03` §6 (table pinned; `movementEvents` removed); `docs/05` §3.3, §3.6, §4.1, §4.2, §10, §13 (demos); `docs/06` §3 (SNAPSHOT v4, module map); `docs/10` §4.4 ("protocol v4", the bench's delta label); D-034/D-046 numbers |
| D-054 | **Minimal health component and deaths:** health hundredths, the dead gate, the death kept in its frame and the respawn at the start of the next tick, `PLAYER_DEATH` causes and recipients, `sv_spawnVest`, the self-bandage hook in `combat/medic.ts` (`+bandage`, `bd_time`), `g_friendlyFire` (SERVER, until M6), HP rounded up on the HUD | 7 | `docs/03` §5.6; `docs/04` §3.4 note; `docs/05` §5, §10; `docs/06` §3, §6–§8 |
| D-055 | **Sprint and stamina** (§2.4): activity rule, walk cancels sprint, no sprint on ladders, caps, the regen law, air and climb freezes, low-stamina scale, weak jump, costs and delay, `st_sprintDrain` 12, the vest's × 0.5 on the maximum as our reading; crouch factor on the ground only (Q4 default); test bots and stamina | 6 | `docs/03` §4.1, §4.5, §5.1, §5.2 (a Label column and every `st_*` row); `docs/06` §3 (`sim/urt/`); `docs/10` §1 (re-baselined), §2, §4 (workloads) |
| D-056 | **Wall jump** (§2.6): probes and their design constants, deterministic candidate choice (walls and boot candidates), impulse formula, tiers, reset | 8 | `docs/03` §5.3, §9; `docs/06` §3; `docs/10` §4 |
| D-057 | **Power slide** (§2.7): the airborne-press flag, entry in the landing step (grounded, contact speed), the deceleration formula, steering by input at the run cap, exits including any non-slide dispatch, CROUCHED kept | 9 | `docs/03` §4.2, §5.4; `docs/06` §3; `docs/10` §4 |
| D-058 | **Ledge grab and climb** (§2.8): after the move on the swept interval and only on air-move ticks (walk with `pm_ledgeFromGround`), the leave gate, the full-window top probe, the derived wall-probe height, grab placement and zero velocity, crouched while climbing, the pull/rise/finish climb with `regrab` as its counter, drop rules, re-grab gates, kick and grab on one tick, the ranges | 10 | `docs/03` §3, §4.5, §5.5, §10; `docs/06` §3; `docs/07` §6; `docs/10` §4 |
| D-059 | **Ladders and water completed** (§2.9, §2.10): forward for every airborne attach, the top-mount probe, the catch, the water-jump design and its design-constant probes, breath and drowning arithmetic | 11 | `docs/03` §4.13, §4.14, §10 Q6/Q8 answered; D-024 note; `docs/07` §6 (rims); `docs/10` §4 |
| D-060 | **Fall damage, legs, limp** (§2.5): the landing step, vz₀ after the pre-checks, the guarded analytic vi as LAND's value (D-023 amended), `pm_fallMinDamage`, `dpow`, excuses (the climb's landing included), calibration to the simulated arc | 5 (`dpow`), 7 | `docs/03` §3, §4.10, §5.6, §6; D-016 note; D-023 note; `docs/06` §3; `docs/10` §4.4 |
| D-061 | **Player collision and its prediction** (§2.11, Q2): `PlayerBoxes` (id order, inputs per side), the box-trace contract and tie order, start-inside skipped, snap world-only, server order, deferred effects re-quantized, client boxes from the newest frame extrapolated, the contact counter, touch bits on every pmove call, the misprediction rule and the separate contact metrics, the exact multi-player check, ghost cvars in `PmoveParams`, pmove reads only replicated inputs, goomba and boot rules (own trigger, `heldWeaponSlot`, slots 0/3/4, `HIT_CONFIRM`, current positions in M4 with Q2 part 2's answer), spawn occupancy | 4 (core), 12 (goomba, boot) | `docs/03` §5.7–§5.9; `docs/05` §3.4 (slot mapping), §3.6 (`contactSeq`), §5, §7 (per Q2 part 2), §8.1, §10, §14 (NET-04 note); `docs/04` §8.6, §9 notes (slots 0/3/4); `docs/06` §3; `docs/10` §1, §2, §4; D-017, D-018, D-050 notes |
| D-062 | **Presentation hooks pulled from M8** (§2.12): trail on horizontal speed, synthesized placeholder sounds (slide included; boot swing predicted, impact confirmed), landing dip, HUD readouts and `cl_speedometerDetail` | 13 | `docs/03` §5.10; `docs/06` §3, §7; `docs/09` M8 note; D-037 note |
| D-063 | **Tuning tools** (§2.13): strafe helper (CHEAT), probe kinds and hold, `.cmds` v1 (tied to protocol and build), `cmdrecord`/`cmdstop`, `pnpm cmd-replay`, ghost runs (`ghost`, `ghost pick`), `cvardiff`, `?map=`, `?bot=idle`, `movement_preset` | 1, 3, 8, 13, 14 | `docs/03` §9; `docs/05` §13; `docs/06` §3 (modules, URL hooks), §6 (console), §7 (client cvars), §10 (diagnostics); CLAUDE.md commands |
| D-064 | **Feel report, MV-20 and the acceptance guard:** four courses, the full §8 table, implementation and reference target columns; the `MechanicsTour` (from increment 6); MV-20 on the recorder, single-player; the acceptance guard parses ranges and slashes (`docs/09` wording unchanged); the primer budget | 1, 3, 6, 14, 15 | `docs/03` §8 (MV-20's note: single-player; contact judged by NET-04's legs and the exact check); `docs/10` §1, §2, §4.4 |
| D-065 | **Courses for M4** (§2.14): the movement_lab yard, jump_lab ledges 116 and 128, fall_tower kept | 7–11 (pieces), 15 | `docs/07` §3, §6 |

## 4. Values

### 4.1 Defaults, both columns
"Docs" is `docs/03` today (the code's values). "Research" is R. Labels are per column; a label in **bold** changes if that column is adopted. B-ids are R §4.2. ★ marks a value that needs Mustafa's explicit approval to become FACT (golden rule 7).

**Base (`docs/03` §2.1; only the research column changes them):**

| Cvar | Docs | Research | Source (research) |
|---|---|---|---|
| `pm_runSpeed` | 320 FACT-Q3 | 220 **INFERRED** | B1; T1, T2, F9278 |
| `pm_walkScale` | 0.5 FACT-Q3 | 0.5 **INFERRED** (110; measured 111–112) | B2; T2 |
| `pm_duckScale` | 0.25 FACT-Q3 | 0.45 **INFERRED** (99) | B3; T2, MOV, F9278 |
| `pm_friction` | 6 FACT-Q3 | 4 **INFERRED** | B4; T6 |
| `pm_stopSpeed` | 100 FACT-Q3 | 100 **INFERRED** | B4; T6 |
| `pm_accelerate` | 10 FACT-Q3 | 4.5 **INFERRED (low–medium; a fit, tune 4.5–5)** | B5; T2 + pooled ramps |
| `pm_gravity` | 800 FACT-Q3 | 750 **INFERRED** (player movement; projectiles keep 800 in M6) | B6; T5, CFG-SRV |
| `pm_jumpVelocity` | 270 FACT-Q3 | 270 **INFERRED** | B6; T5 |
| others (§2.1) | FACT-Q3 | unchanged | — |

**UrT layer (`docs/03` §2.2, §5.2) and the new superset knobs:**

| Cvar | Docs | Research | Notes |
|---|---|---|---|
| `pm_sprintSpeed` | 365 INFERRED | 340 INFERRED | B7; T3, F9278 |
| `pm_sprintStrafe` (new) | 1 (docs rule) | 0 INFERRED | B22 |
| `pm_maxWallJumps` | 3 FACT | 3 FACT | B8 (range 0–7) |
| `pm_wallJumpUp` | 290 ESTIMATE | 270 INFERRED | B9 |
| `pm_wallJumpPush` | 140 ESTIMATE | 200 INFERRED | B10 |
| `pm_wallJumpWeakUp` / `WeakPush` (new) | 290 / 140 (inert) | 170 / 100 INFERRED | B28 |
| `pm_wallJumpRising` (new) | 1 (docs rule) | 0 INFERRED (600 of 601) | B34 |
| `pm_wallJumpCancel` (new) | 1 (docs rule) | 0 INFERRED | B35 |
| `pm_wallJumpReach` | 10 ESTIMATE | 10 ESTIMATE | no data (capture #11) |
| `pm_wallJumpMinHeight` | 40 ESTIMATE | 40 ESTIMATE | no data |
| `pm_bootFreshPress` (new) | 1 (docs: "jump pressed") | 0 INFERRED | B45; R "boot repeat" |
| `pm_slideMinSpeed` | 300 ESTIMATE | 300 **FACT ★** ("about 300") | B11; MAN, MAN41 |
| `pm_slideFriction` | 0.8 ESTIMATE | 0 INFERRED | B12 |
| `pm_slideDecel` (new) | 0 (docs model) | 125 INFERRED | B12; T8 |
| `pm_slideEndSpeed` | 120 ESTIMATE | 300 INFERRED | B13; T9 |
| `pm_slideSteer` | 0.5 ESTIMATE | 1.0 ESTIMATE | B14 (wish = the run cap, §2.7) |
| `pm_ledgeMinHeight` | 24 ESTIMATE | 58 INFERRED | B15 (§2.8 on 58 vs 60.344) |
| `pm_ledgeMaxHeight` | 76 ESTIMATE | 66.1 INFERRED | B16 (R's derivation, §2.8); range < 88 |
| `pm_ledgeReach` | 18 ESTIMATE | 18 ESTIMATE | no data (capture #12) |
| `pm_ledgeFromGround` (new) | 1 (docs rule) | 0 INFERRED | DEV32198 |
| `pm_climbSpeed` | 180 ESTIMATE | 70 INFERRED | B17; T7 |
| `pm_climbAccel` (new) | 0 = instant (docs model) | 750 INFERRED | B17 |
| `pm_climbPopHeight` (new) | −1 (docs: rise to 1 u above the top) | 7 INFERRED | B40; T7, T10; range −8…16 |
| `pm_climbFinishTime` (new) | 0.15 s ESTIMATE (docs "~0.15 s"; 9 ticks) | 1 tick INFERRED ("one-frame pop") | B40; range ≤ 0.25 s |
| `pm_regrabDelay` (new) | 0.2 s ESTIMATE (docs, unlabelled) | 0 INFERRED | B41 |
| `pm_regrabPress` (new) | 0 (docs rule) | 1 INFERRED | B41 |
| `pm_fallSafeSpeed` | 560 ESTIMATE | 547.8 INFERRED | B18, calibrated (§2.5) |
| `pm_fallLethalSpeed` | 1100 ESTIMATE | 768.8 INFERRED | B19, calibrated |
| `pm_fallLegsSpeed` | 850 ESTIMATE | 650 ESTIMATE | B20 (Beta 1.1 "≥ 30 damage") |
| `pm_fallCurve` | 1.6 ESTIMATE | 1.6 ESTIMATE | no data (capture #7) |
| `pm_fallMinDamage` (new) | 0 (the docs formula) | 1 HP ESTIMATE | §2.5 |
| `pm_limpScale` | 0.6 ESTIMATE | 0.6 ESTIMATE | no number (capture #13) |
| `pm_kickKnockback` (new) | 120 ESTIMATE | 120 ESTIMATE (probably more; capture #10) | B46 |
| `pm_kickCooldown` (new) | 0.5 s ESTIMATE | 0.5 s ESTIMATE | no data |
| `pm_waterJumpVelocity` / `Push` / `Time` / `Reach` (new) | 280 / 150 / 0.4 s / 8 ESTIMATE | same | our design (gap 1) |
| `pm_trailSpeed` | 600 FACT | 600 FACT | presentation only |
| `pm_autoHop` | 0 ESTIMATE | 0 ESTIMATE | B21 (capture #3) |
| `st_sprintDrain` | **12 /s ESTIMATE** (was 11) | 12 /s ESTIMATE | §2.4; R's lead 12.5 (unconfirmed) |
| `st_sprintMoveSpeed` (new; was unlabelled) | 50 ESTIMATE | 50 ESTIMATE | — |
| `st_jumpCost` | 5 ESTIMATE | 6 INFERRED | B25; T5 |
| `st_wallJumpCost` | 8 ESTIMATE | 6 INFERRED | B26; T10 |
| `st_wallJumpMin` / `st_wallJumpWeak` (new) | 8 / 8 (docs rule) | 5 / 12 ESTIMATE thresholds | B28 |
| `st_crouchCost` | 2 ESTIMATE | 2 ESTIMATE | lead: 10 on the ground, 0 in the air |
| `st_slideCost` | 6 ESTIMATE | 6 ESTIMATE | B31 (R: a drain model, unconfirmed) |
| `st_regenIdle` | 18 /s ESTIMATE | 20 /s INFERRED | B27; T6 |
| `st_regenMove` | 5 /s ESTIMATE | 20 /s INFERRED (the law's intercept) | B27 |
| `st_regenSpeedSlope` (new) | 0 | 0.0764 INFERRED | B27 |
| `st_idleSpeed` (new; was an ESTIMATE rule) | 10 ESTIMATE | 10 ESTIMATE | — |
| `st_regenDelay` | 0.5 s ESTIMATE | 0.5 s ESTIMATE | lead ≈ 0 (B27 silent) |
| `st_airFreeze` (new) | 0 (docs rule) | 1 INFERRED | B23, B27; T5 |
| `st_climbFreeze` (new) | 0 (docs: "free") | 1 INFERRED | B27, B40; T7 |
| `st_lowSpeedScale` / `st_lowSpeedKnee` (new) | 1 / 25 (off) | 0.75 / 25 INFERRED | B24; T4 |
| `st_weakJumpVelocity` / `st_weakJumpScale` (new) | 270 / 1 (off) | 202 / 0.5 INFERRED | B28; T7 |
| `bd_time` | 3.0 s ESTIMATE (`docs/04`) | same | — |
| `sv_ghostAll` / `sv_ghostTeammates` | 0 / 0 design (§5.9) | same | B47: per-player opt-in not adopted |

Unchanged in both columns: `pm_ladderScale` 0.5, `pm_ladderFacing` 0.5, `pm_ladderReach` 2, `pm_ladderJumpPush` 150, `pm_waterSinkSpeed` 60, `pm_swimScale` 0.5 (all ESTIMATE; with the research base ladder and swim speeds become 110 u/s, Q1). The goomba attacker unhurt: ESTIMATE (docs) / **FACT ★** (B44).

**ESTIMATEs M4 uses for the first time without changing them** (the milestone skill calls them out): `pm_wallJumpReach` 10, `pm_wallJumpMinHeight` 40, `pm_ledgeReach` 18, `pm_fallCurve` 1.6, `pm_limpScale` 0.6, `pm_kickKnockback` 120, `pm_kickCooldown` 0.5 s, `st_crouchCost` 2, `st_slideCost` 6, `st_regenDelay` 0.5 s, `st_idleSpeed` 10, `st_sprintMoveSpeed` 50, `bd_time` 3.0 s, the four water-jump values; in the docs column also every UrT-layer ESTIMATE above.

**FACT constants (not cvars):** breath 960 ticks (16 s), drowning 480 ticks (8 s), boot damage 20 HP, max health 100.

**Design constants** (not feel knobs, not ESTIMATEs of the original game): `WALLJUMP_PROBE_LOW` 8 u; `WALLJUMP_MAX_NZ` 0.3 (also the ledge wall test); the ledge wall probe at feet + min − 8 and the top probe's + 8 u offsets; `LEDGE_LEAVE_SPEED` 16 u/s; `CLIMB_PULL_SPEED` 240 u/s; `CLIMB_FINISH_FORWARD` 23 u; the water-jump probe heights (`WATER_SAMPLE_WAIST` 28 and the standing eye 50); the top-mount probe (`pm_stepSize` lower, reach + the tick's distance); the probe direction order; the boot leaves the kicker's velocity unchanged; `CONTACT_EXTRAP_MAX_TICKS` 15; `PlayerBoxes` reach pre-filter; the respawn one tick after death (until M7); the 16-voice audio pool; the probe log capacity 128; the trace-kind list; `.cmds` v1 layout; the 18-bit local mask.

**Client and server cvars:** `cl_strafeHelper` 0 (ARCHIVE, CHEAT), `cl_speedometerDetail` 0 (ARCHIVE), `s_volume` 0.5, `cl_landDipScale` and `cl_landDipMs` (ESTIMATE), `r_debugProbes` (CHEAT), `r_debugProbeHoldMs` 1000 (design); SERVER `sv_spawnVest` 0, `g_friendlyFire` 0 (design until M6). Every replicated addition re-pins the cvar-block golden hashes (`docs/05` §3.5).

### 4.2 Derived numbers per column ([calc] unless sourced)

| Quantity | Docs column | Research column |
|---|---|---|
| Run / sprint / walk / crouch cap | 320 / 365 / 160 / 80 | 220 / 340 / 110 / 99 |
| Run 0 → cap | ≈ 0.2 s | 0.57 s; 100 / 150 / 200 / 219 u/s at 167 / 267 / 433 / 567 ms against R's 168 / 264 / 408 / 488: 100 and 150 match (the fit's points), 200 and 219 run 25 and 79 ms slow (logged, D-052). At accelerate 5: 133 / 217 / 350 / 417 ms |
| Walk / crouch 0 → within 1 u/s of the cap | < 0.6 s | 1.12 s / 2.03 s (0.70 / 0.98 at 5); R has no walk or crouch ramp data (capture item 1) |
| Stop from run | — | 0.45 s (R: ≈ 0.46 s) |
| Jump apex 60 / 120 Hz, airtime | 45.625 / 45.406 u, 0.675 s | 48.59 / 48.81 u, 0.733 s (44 ticks); R 48.53 u, 0.72 s; 750·dt is on the 1/16 grid, so §6's gravity bias disappears |
| Wading caps (water level 1) | run, walk, crouch caps hold | ≈ 198 / 93 / 44 (ground + water friction exceed one tick of accelerate; D-024's wading sentence no longer holds) |
| Ladder and swim speed (0.5 ratios) | 160 | 110; ladder 0 → 110 in ≈ 1.1 s |
| Sprint 100 → 0 at `st_sprintDrain` 12 | 8.33 s (target 8–9 s) | same; only on the ground |
| Regen 0 → 100 standing | 5.6 s (18 → 18.0/s) | ≈ 5.05 s (20 → 19.8/s) |
| Chimney, 3 kicks | ≈ 158 u (290 floor) | ≈ 146 u (R B36) |
| Slide from 365 / 335 | ≈ 317 u (307 slide + 10 stop) | ≈ 150 u from 335 (R B39); from 600 the slide alone ≈ 1080 u |
| Fall: first damage / legs / lethal drop | ≈ 196 / 452 / 757 u | 200.125 (FACT; 1 HP) / ≈ 282 (≈ 30 damage) / 394.125 u (FACT) |
| Fall damage at 256 / 512 / 768 u | 4.7 / 48.9 + legs / lethal | ≈ 17.4 / lethal / lethal |
| Ledge reach above the floor, standing jump | 24.03–121.6 u (every jump_lab ledge) | 58.03–114.69 u (FACT 60.375–114.625) |
| Ledge reach after an apex kick (one wall) | 126.4 u | 119.09 u (FACT 118.75) |
| Climb a 64 u ledge | ≈ 0.4 s rise + 0.15 s finish | ≈ 0.8 s (R: ≈ 59 u in 0.79 s) |
| Goomba drop (legs speed) | ≈ 452 u | ≈ 282 u |

### 4.3 MV targets per column
The chosen column's targets are asserted; the other column's are the reference for Q1 and its smoke.

| ID | Docs column (pass condition) | Research column | Changes in the test |
|---|---|---|---|
| MV-01 | 320 ± 0.5 by 0.6 s | 220 ± 0.5 by 0.6 s (reached at 567 ms); the ramp's 100 and 150 u/s at 168 / 264 ms ± 2 ticks; 200 and 219 u/s logged, not asserted; the stop ≈ 0.46 s ± 2 ticks | targets from params; `BY_TICK` from params |
| MV-02 | 365 ± 0.5; drain at 12/s exact (20 hundredths per tick) | 340 ± 0.5 (our accelerate converges exactly, so R's 329–340 plateau needs no tolerance); no sprint with strafe, walk or on a ladder; drain on the ground only | new |
| MV-03 | 160 ± 1 / 80 ± 1 by 0.6 s | 110 ± 1 / 99 ± 1 by 1.3 s / 2.2 s (window re-targeted, logged) | targets from params |
| MV-04 | 45.56 ± 0.5; airtime 0.675 s ± 1 tick | 48.53 ± 0.5; airtime 0.72 s ± 1 tick; jump-onto 66.5 u (FACT) with health unchanged | the literal 800 goes |
| MV-05 | 18 climbs, 19 blocks | same, plus the 66.5 u jump-up with health unchanged (both columns) | — |
| MV-06 | as today | as today; slopes' speeds and margins from params | `slopes.ts` |
| MV-07 | ≤ 326.4 | ≤ 224.4 | from params |
| MV-08 | gains every hop from 320 | from 220 | from params |
| MV-09 | ≥ 540 within 12 hops (band 540–580) | re-measured with the forward-only bot, sprint active on every airborne tick: the band comes from an unverified lead (R L377); if outside, a question, not a silent re-target | new |
| MV-10 | 3 kicks, 4th denied until landing; not off players; not off a 24 u curb | same + descending only + weak/refused tiers | new |
| MV-11 | tangential kept + push; chimney 120–160 u | push 200, vz 270, no cancel; chimney ≈ 146 u (band 120–160 kept); apex kick then grab: 118.75 u grabbed, 120 u not, from a gap of 0 and of 10 u | new |
| MV-12 | entry rules; direction locked without input; ≈ 300–420 u from 365; lateral speed gained in 0.5 s with a strafe key (from params) | constant 125 u/s² ending at 300; strafe steers (its 0.5 s number from params); ≈ 150 u from 335 (band 120–180, ESTIMATE); a jump out keeps the speed; slide off a ledge, into water and a landing tick with crouch held and jump pressed all end or skip the slide | new |
| MV-13 | 768 u catch with 0 damage; grabs in [24, 76]; climb time | the same catch; window [58, 66.1] at every tick phase; 60.375 u grabbed at every phase; reach 114.625 grabbed, 114.75 not; 118.75 only after an apex kick, 120 never; climb ≈ 0.8 s; the climb's end leaves health unchanged; a crawl-space ledge (44 u opening) is climbed crouched; fresh-press re-grab; rising grab; no grab at a ladder top (both columns) | new |
| MV-14 | costs and regen per §5.2; no regen in water; vest halves max; max tracks health | the regen law; frozen in the air and while climbing; low-stamina scale; weak jump; 0 → 100 in ≈ 5 s | new |
| MV-15 | 256/512/768 u ≈ 5 / 45–55 + legs / lethal; bandage clears limp | 200.125 u costs 1 HP and 200 u nothing; 394.125 u kills and 394 doesn't (HUD shows ≥ 1); legs at ≈ 282 u; squeeze and wall-hug tests | new |
| MV-16 | goomba kills at ≥ legs speed onto a head; boot 20 with eligible slots only | same + airborne-only boot; sprint, jump, meet the player at the apex with no second press; mutual boots; teammate rule per the defaults | new |
| MV-17 | breath 16 s, drown 8 s; jump/crouch swim; swim 160 ± 1 | breath and drown exact; water-jump onto a flush and a raised rim, landing with no GRAB (both columns); swim 110 ± 1; wading caps logged | extended |
| MV-18 | forward = up; detach facing away; top within 3.5 s | + top mount walking and running back at every tick phase (both columns); a foot jump jumps; a standing jump at the foot never attaches over its whole arc; the catch (forward held) zeroes vz; 110 ± 1; top within ≈ 4.8 s | extended |
| MV-19 | bit-identical over 10k ticks | same, the stream on the M4 yard with sprint, kicks, slides, ledges, falls and a second scripted player (collision, goomba, boot), the `PlayerBoxes` inputs and both states in the digest | extended |
| MV-20 | predicted == authoritative every tick on a lossless link, single-player | same | new |

## 5. Test plan

### Acceptance tests
F = `pnpm test` (and `test:movement`/`test:net`); Lg = `pnpm test:long`. Every scenario reads its implementation targets from the active parameters and its bands from the chosen column; the Lg "other preset" smoke loads the other column and runs MV-01 and MV-04 against its derived targets.

| ID | Tier and file | Setup | Pass condition |
|---|---|---|---|
| MV-01 | F `mv-01-run-cap` (re-targeted) | `runway_start` | §4.3; grounded, straight, 0 snap fallbacks |
| MV-02 | F `mv-02-sprint` | runway, `open_sw`; `SprintRun` | cap ± 0.5 on the ground and as the air wish cap; drain = 20 hundredths per tick exactly; no sprint with strafe (per `pm_sprintStrafe`), walk, crouch, ladder, water ≥ 2, limp, stamina 0; air drain per `st_airFreeze` |
| MV-03 | F (re-targeted) | as today | §4.3 |
| MV-04 | F (re-targeted) | as today; + jump-onto (research) | §4.3; the vz step = round(g·dt·16)/16 from params |
| MV-05–08 | F (re-targeted) | as today | §4.3 |
| MV-09 | F smoke (6 hops) + Lg full | `open_sw`, `CircleJump` (forward only, steers by yaw, exact yaw search) | ≥ 540 u/s within 12 hops, sprint active on every airborne tick, speed curve logged; outside the band → reported and asked (D-052) |
| MV-10 | F `mv-10-wall-jump-limit` | jump_lab chimney and curb; placed airborne states near a wall; two-player runner for "not off players" | 3 kicks, the 4th denied until a walkable landing; not on a ladder or in water; no kick off the 24 u curb or a player; tiers by stamina; descending rule per column |
| MV-11 | F + Lg phase sweep | kick lanes 15/30/45/60°; chimney; a synthetic 400 u/s run along a wall; `ledge_116` | tangential speed kept to 1/16 u/s; push along n; vz rule; exits faster when the run is parallel; chimney gain in band over start phases (Lg); apex kick then grab per §4.3 |
| MV-12 | F + Lg entry-speed sweep | slide_lab lane and bars; `SlideRun`; a ledge and the pool | entry only with crouch pressed in the air, grounded, at contact speed ≥ min; CROUCHED kept; view turns don't steer, strafe does (lateral gain in 0.5 s from params); distance in band; ends below end speed; a jump keeps the speed; limp ignored; slides under the 41/42/44 bars, not 40; off a ledge and into water it ends (SLIDE_END); a landing tick with crouch held and jump pressed starts no slide |
| MV-13 | F + Lg tick-phase sweep | fall_tower rails; jump_lab ledges; placed starts at 1/8 u around the window; a crawl-space ledge; a ladder top | the 768 u catch: GRAB, vz 0, 0 damage, climbs on top with health unchanged; grabs exactly in [min, max] at every tick phase (Lg); reach and post-kick bounds per §4.3; climb time ± 2 ticks; re-grab gates per column; rising grab; no grab crouched, sliding, in water, on a rounded top or at a ladder top; crouched climb under a 44 u opening |
| MV-14 | F `mv-14-stamina` | flat floor, pool | each cost exact; regen law per column; delay; frozen in water ≥ 2, while climbing (per `st_climbFreeze`) and in the air (per `st_airFreeze`); weak jump; low-stamina scale; vest halves the max; max tracks health and clamps stamina |
| MV-15 | F + Lg drop sweep | placed drops at 1/8 u on flat floor; fall_tower walk-offs; nodamage pad; level-2 pool; wedge squeeze | damage per §4.3 at the column's heights; legs at threshold; limp × scale and no sprint; `+bandage` for `bd_time` clears it; nodamage and water excuse; squeeze and wall-hug (B43); lethal → frame shows the death, respawn next tick, `PLAYER_DEATH` cause fall to everyone |
| MV-16 | F `mv-16-goomba-boot` (two-player runner + a match test) | a placed fall onto a standing player; booting at the apex | goomba kills at ≥ legs speed, attacker unhurt, below it a normal landing on a head; boot 20 HP to the victim with slots 0/3/4 only, airborne only, cooldown, held jump per `pm_bootFreshPress` (sprint-jump into the player at the apex, no second press); mutual boots both land, in either id order; teammate rule per the defaults; `HIT_CONFIRM` to the attacker only |
| MV-17 | F (extended) | movement_lab pool and the yard rim | breath 960 ticks, then death in exactly 480 at 100 HP (sooner when hurt); water-jump over flush and 8 u rims with no GRAB (both columns); swim speed from params; wading logged |
| MV-18 | F (extended) + Lg phase sweep | movement_lab ladder, fall_tower pillars | foot jump jumps; a standing jump at the foot never attaches over its whole arc; forward + jump at the foot climbs; top mount walking and running back at every tick phase (Lg, both columns); the catch (forward held) zeroes vz and saves a fall; existing checks |
| MV-19 | F + Lg (extended) | probe on movement_lab incl. the yard, plus a second scripted player through `MultiScenarioRunner` (server id order); sprint draws | two runs identical; identical after a primer pass; esbuild bundle identical; tally reaches every M4 mode and event; the digest holds both states and the `PlayerBoxes` inputs |
| MV-20 | F `mv-20-prediction-parity` + Lg 3 min | `MechanicsTour` (single player, every solo mechanic) through `ClientSim` on a lossless link; recorded with `cmdRecorder`, replayed with `cmd-replay` | predicted == authoritative every tick (0 corrections); the replay reproduces the server's states bit for bit; the restart-from-the-wire leg (§2.2) 0 diffs |
| NET-03 | F (extended per mechanic, increments 6–11) + Lg | the `MechanicsTour` leg on the yard; a `movement_preset` switch mid-tour (increment 3) | 0 corrections, resyncs and starves; `mismatches` 0 every tick with every v4 field compared; the preset switch arrives as one block with one effective tick and costs 0 corrections; the restart-from-the-wire leg 0 diffs |
| NET-04 | F smoke + Lg (extended) | M2/M3 blocks re-run (stamina overrides, §2.4); the tour on `wan-100-loss1` (smoke, per mechanic increment) and `wan-150-loss2` (Lg); 2-client contact legs on `wan-150-loss2` (Lg) with a 2-client fast smoke; 16 clients on arena with solid players (Lg) | < 1 correction/s, mean < 2 u, render offset < 8 u for the observed client, counting mispredictions and starves; contact corrections reported against their own ESTIMATE bounds (§2.11); **0 mispredictions** |
| Contact exact check | F (2 players) + Lg (16 players) | §2.11 "the exact multi-player check" | 0 diffs between the frame replay and the server's frames, every tick, every player; live-state and frame box builders identical |

MV-20, NET-03 and the `MechanicsTour` are single-player by design: a moving remote makes the first prediction of a contact tick a guess (§2.11). Collision, goomba and boot are judged by NET-04's 2- and 16-client legs and by the exact multi-player check (D-064 writes this into `docs/03` §8's MV-20 note).

### Other tests
- **Shared units:** each new module (stamina law edges, weak tiers, probe choice ties, the boot trigger and its gates, slide exits and entry speed, the leave gate, the take-off-tick top probe, grab placement, the climb's pull, rise, finish and blocked drop, re-grab gates, the top-mount probe, water-jump probes, drowning arithmetic, dead gate, bandage timer, vi's guard on negative radicands); `boxTrace` against the brush-trace contract (touching, ε, start inside skipped, crouched height, ties world-first then by id, two touching boxes in both orders); `PlayerBoxes` inputs (pending slots skipped, the roster team, team 0, ghost cvars switching at the effective tick); `dpow` against a high-precision reference and its D-016 vectors; the behavioural field guard; the canonical rules and load-time width checks.
- **Codecs (NET-01):** v4 round trips at every field extreme; hostile table (flag bit 11+, climb fields when not climbing, every range + 1, event kinds 8–15, BOOT ≥ 64, WALLKICK ≠ 0, `PLAYER_DEATH` cause 5–7, killer without hasKiller, `HIT_CONFIRM` cause 2–7); goldens of §2.2; `protocol-docs` sums; HELLO `010400`; v3 demo refused.
- **Server:** deferred boot/goomba effects applied after all simulate calls (order-independence by permuting ids); after a diagonal boot the victim's `s.player` equals `slotToPlayerState(frame)` bit for bit; `contactSeq` steps; death → the frame shows it, respawn next tick, `PLAYER_DEATH` to everyone and in `tickEvents` (demo golden, `demo-info`); `HIT_CONFIRM` to the attacker only; spawn occupancy; `resetPlayerStateForSpawn`; `movement_preset` admin scope and one CVARS block; `sv_spawnVest`.
- **Client:** contact classification table (server step, client-only touch, both, neither, with a starve, and a re-simulation that newly touches a remote followed by a mismatch → contact); box building from the store; `LandingDip`, trail core, audio planner (priorities, pool, `jumped` skipped, swing vs confirmed impact), ghost re-simulation (`ghost` with no argument), `.cmds` round trip and truncation refusal, strafe-helper angle, HUD mode order, HP rounded up, `cvardiff` output, bind merge of new defaults into saved sets.
- **Tools:** `cmd-replay` in process (fast) and its CLI (golden summary, `--set` divergence, bad file exit 1; Lg subprocess); feel-report rows, both target columns and four hashes; course fixtures and `EXPECTED_ANCHORS`; the doc goldens extended to `st_*`, `sv_ghost*` and the new `pm_*` rows with a Label column per §5.2 (and the §2.1 label pin per Q1); `acceptanceIds` range and slash expansion with unit cases.
- **M3 suites under the new base** (increments 3 and 6): NET-02, 04, 05, 07, 08, 09, 12, `routes.test` (threshold from params), the e2e smoke and a 2-minute 16-bot run green under the new defaults, `docs/10` figures re-baselined.
- **Primer:** inertness with every v4 field in the dump; the widened coverage guard (Lg) green each increment; the no-retry guard's first-kick, first-slide, first-grab, first-fall and first-contact windows; primer time reported as priming files × Δms.
- **Allocation (native ESM, 0 GCs, < 64 KB):** `pmoveStamina`, `pmoveWallJump`, `pmoveSlide`, `pmoveLedge`, `pmoveFall`, `pmoveWater` (water-jump, drowning), `pmovePlayers` (2 and 16 boxes, goomba, boot), `boxTrace`, `dpow`, `match` with deaths and boots, `predict` with boxes, `cmdRecorder`; client `view-frame` gains the dip, trail, strafe helper, probe hold and audio planner.
- **Bench:** pmove mix with sprint, kicks, slides, ledges, falls (≤ 5 µs per player-tick, reported per increment); a 16-player crowd case; kick-press tick cost reported (≈ 18 traces); the boot trigger's cost with and without a box in reach.
- **Bots:** `pnpm bots --count 16 --profile wan-100-loss1 --minutes 2` in increments 2, 3, 4, 6 and 12 (`.claude/rules/netcode.md`) and at close-out with `--strict`.
- **e2e:** the smoke regex kept; vitals readout present; a sound planner no-op in autotest; `?map=jump_lab` boots offline.

## 6. Increments

Each increment: an implementer, 4–5 review lenses (spec, correctness, determinism and performance, tests), plus `movement-reviewer` on every movement increment (3, 4, 6–12, 15) and **`netcode-reviewer` on every increment that touches the sim, the wire or prediction (2–4, 6–12, 14)**, an integrator. Each ends with `pnpm typecheck && pnpm lint && pnpm test` green, plus `test:movement`, `test:net`, `test:long` and `test:browser` where touched, its docs and decision-log edits, the fast-tier wall and CPU time, the primer time, and a commit and push. **Every mechanic increment (6–12) adds its mechanic to the `MechanicsTour`, to NET-03 (lossless, 0 corrections, every v4 field compared) and to a NET-04 `wan-100-loss1` tour leg** (fast smoke, full run in the long tier), so no mechanic is committed without a prediction-parity and a lossy-link check.

| # | Commit | Contents | Green when | Docs | Mustafa can try |
|---|---|---|---|---|---|
| 1 | `test(tools): M4 acceptance guard, scenario state records and ?map= for the Worker` | `acceptanceIds` expands ranges and slashes (`docs/09` unchanged); `MILESTONES` M4 (all pending); `ID_SUITES` MV list; `ScenarioRecord` keeps whole states; `placePlayer` gains fields; `?map=`; `?bot=idle`. D-063 (part), D-064 (part) | guard units, scripts and boot tests | `docs/06` §3 (the URL hooks); D-063, D-064 | `?map=jump_lab` offline |
| 2 | `feat(shared,server,client): PlayerState v4 and protocol v4` | §2.2 in full, all fields inert (health 100 at spawn, `sv_spawnVest`); codec, masks, header `contactSeq` (never stepped yet), event kinds, EVENTS `PLAYER_DEATH` and `HIT_CONFIRM` accepted; eleven frame lanes; canonical rules; spawn reset; width checks; behavioural guard; vitals HUD; vectors regenerated. D-053 | NET-01 (+ goldens), NET-02 unit, NET-03 0 corrections, vectors, browser replay, codec workload; 2-minute 16-bot run | `docs/03` §6; `docs/05` §3.3, §3.6, §4.1, §4.2, §10, §13; `docs/06` §3; `docs/10` §4.4; D-053 | "HP 100  ST 100" on the HUD; nothing else changes |
| 3 | `feat(shared,tools): M4 movement values and presets` (**waits for Q1**) | the Q1 column as default (§4.1 base rows); `presets.ts`, `movement_preset`, `cvardiff`; algorithm tests on the docs fixture; M2 scenario tests re-targeted from params; the feel report's reference column; `docs/02` A-items if approved; doc golden label pins; the M3 suites' stamina overrides prepared. D-052 | MV-01/03–08/17/18 for the chosen column; the other-preset smoke (Lg); vectors; NET-03 preset-switch leg; M3 NET legs, `routes.test`, e2e and a 2-minute 16-bot run under the new defaults; `docs/10` re-baselined | `docs/03` §2.1–§2.3, §4.2, §7, §8; `docs/02` §3, §13–§15 (if yes); `docs/06` §6; `docs/07` §6; `docs/10` §1, §2; D-052, D-024 note | `movement_preset docs` / `research` live; `cvardiff` |
| 4 | `feat(shared,server,client): solid players` | §2.11 core: `PlayerBoxes`, `boxTrace`, `pmTrace` in every pmove sweep and the stand test, start-inside skipped, server id order, client boxes (newest frame extrapolated, store inputs, roster team), `contactSeq` stepping and classification, touch bits, contact metrics, ghost cvars in `PmoveParams`, spawn occupancy, ground on heads; the exact multi-player check; primer second player and widened coverage guard; bots summary wording. D-061 (part) | box-trace units and vectors (browser replay); builder tests; server order and overlap tests; 2-client contact smoke (F) and legs (Lg); 16-client NET-04 legs (Lg) with 0 mispredictions and contact metrics reported; exact check (F 2 players, Lg 16); `boxTrace`, `pmovePlayers`, `matchMulti`, `predict` workloads; crowd bench; 2-minute 16-bot run. **Contact numbers reported to Mustafa (Q2)** | `docs/03` §5.9; `docs/05` §3.6, §5, §8.1, §14; `docs/06` §3; `docs/10` §1, §2, §4; D-061, D-017, D-050 notes | two windows bump, stand on a head; `sv_ghostAll 1` |
| 5 | `feat(shared): deterministic dpow` | `dexp2`, `dlog2`, `dpow`; D-016 vectors; browser replay. D-060 (part) | units, vectors, `test:browser` | D-016 note; `docs/06` §3; `docs/10` §4.4 | — |
| 6 | `feat(shared,client,tools): sprint and stamina` | §2.4 in `sim/urt/`; crouch factor on the ground only; `SprintRun`, `CircleJump`; MV-19 sprint draw; primer stamina seeding and sprint segments; `cl_speedometerDetail`; the `MechanicsTour` starts; test-bot stamina policy live. D-055 | MV-02, MV-09, MV-14 (sprint, jump, crouch, regen, vest, max), MV-01–08 unchanged; NET-03 and NET-04 tour legs; M3 suites, `routes.test`, e2e and a 2-minute 16-bot run under the stamina rules; coverage guard; `pmoveStamina` | `docs/03` §4.1, §4.5, §5.1, §5.2; `docs/06` §3; `docs/10` §1, §2, §4; D-055 | Shift sprints; watch stamina; jump at 0 stamina. **Optional 15-minute base check (Q4)** |
| 7 | `feat(shared,server,client): fall damage, broken legs, limp, deaths and the bandage hook` | §2.5; the landing step; LAND = vi; deaths kept in their frame, respawn next tick, `PLAYER_DEATH`; `+bandage` in `combat/medic.ts`; yard drop and nodamage pad. D-054, D-060 | MV-15, MV-14 (health), MV-05 (jump-onto health), NET-03/04 legs, match death tests and demo golden, `pmoveFall` | `docs/03` §3, §4.10, §5.6, §6; `docs/04` §3.4 note; `docs/05` §5, §10; `docs/06` §3, §6–§8; `docs/10` §4; D-054, D-060, D-023 note | `?map=fall_tower`: drops, limp, F to bandage |
| 8 | `feat(shared,client): wall jumps and the probe visualizer` | §2.6 (world walls; boot candidates inert until 12); WALLKICK; trace kinds, capacity 128, `r_debugProbes`, hold; yard chimney; primer chimney. D-056, D-063 (part) | MV-10 (world part), MV-11, NET-03/04 legs, `pmoveWallJump`, bench, view-frame guard | `docs/03` §5.3, §9; `docs/06` §3, §7; `docs/10` §4; D-056 | chimney on jump_lab; `set r_debugProbes 1` |
| 9 | `feat(shared): power slide` | §2.7; slide drill. D-057 | MV-12, NET-03/04 legs, `pmoveSlide` | `docs/03` §4.2, §5.4; `docs/06` §3; `docs/10` §4; D-057 | sprint-jump, crouch in the air, slide on slide_lab |
| 10 | `feat(shared): ledge grab and climb` | §2.8; GRAB; jump_lab `ledge_116`/`ledge_128`; yard ledge and crawl-space ledge; climb drill. D-058 | MV-13, MV-11 (kick then grab), NET-03/04 legs incl. mid-climb restarts, `pmoveLedge`, bench (airborne-forward probe cost) | `docs/03` §3, §4.5, §5.5, §10; `docs/06` §3; `docs/07` §6; `docs/10` §4; D-058 | jump_lab ledges; fall_tower rails |
| 11 | `feat(shared): ladders and water completed` | §2.9, §2.10; yard rim; `ladder.test`/`water.test` pins flipped. D-059 | MV-17, MV-18 (incl. Lg top-mount sweep), NET-03/04 legs, `pmoveWater` | `docs/03` §4.13, §4.14, §10; `docs/07` §6; `docs/10` §4; D-059, D-024 note | mount a ladder from the top; climb out over a rim; hold your breath |
| 12 | `feat(shared,server,client): goomba and the boot` | §2.11 goomba and boot: own trigger, `heldWeaponSlot`, deferred effects re-quantized, the capture assert, `HIT_CONFIRM`, swing vs impact; `Kicker`, `Stomper`; exact check with boots and deaths. D-061 (rest) | MV-10 (players), MV-16, exact check, NET-04 contact legs with boots, server boot tests, `pmovePlayers`, 2-minute 16-bot run | `docs/03` §5.7, §5.8; `docs/04` §8.6, §9 notes; `docs/05` §3.4, §7 (per Q2 part 2), §10; `docs/06` §3; `docs/10` §4; D-061, D-018 note | boot and stomp the `?bot=idle` dummy |
| 13 | `feat(client): speed trail, placeholder sounds, landing dip, HUD states and the strafe helper` | §2.12; §2.13 strafe helper (CHEAT). D-062, D-063 (part) | view-frame guard, units, e2e | `docs/03` §5.10, §9; `docs/06` §3, §7; `docs/09` M8 note; D-062, D-037 note | sounds, dips, trails on bots above 600; `set cl_strafeHelper 1` offline |
| 14 | `feat(client,tools): input recorder, cmd-replay, ghost runs and MV-20` | §2.13 (recorder, replay, ghost); MV-20 and its restart-from-the-wire leg. D-063, D-064 | MV-20, NET-03, `cmd-replay` in process (F) and CLI goldens (Lg) | `docs/03` §9; `docs/05` §13; `docs/06` §6, §7, §10; CLAUDE.md commands; D-063 | `cmdrecord`, `cmdstop`, `ghost`; `pnpm cmd-replay … --set` |
| 15 | `feat(tools): the full feel report, MV-19 on the M4 yard and final tuning tables` | §2.14; MV-19 with the second player; the other-preset smoke; benches; `docs/03` §7/§8 values. D-064, D-065 | `pnpm feel-report` every implementation row on target for the chosen column; MV-19; coverage; benches | `docs/03` §7, §8 (MV-20 note); `docs/07` §3, §6; `docs/10` §1, §2, §4.4; D-064, D-065 | `pnpm feel-report` |
| 16 | `docs: M4 review fixes, feel-check, net-check and handoff` | full close-out like M3: fresh clone; `movement-reviewer`, `netcode-reviewer`, `perf-auditor`, `clean-room-auditor`, client, tests and docs lenses; fixes; `/feel-check`, `/net-check`; a 2-minute 16-bot `--strict` run; `pnpm bench`; handoff with the feel-session kit; PR merged once CI is green | all recorded; CI green | `docs/09` M4 (☐, "feel sign-off pending"); handoff; `docs/10` measured | the feel session |
| 17 | `tune(shared): M4 feel sign-off values` (after Mustafa's session) | his `cvardiff` changes as defaults (`presets.ts`, `docs/03` §2.2/§5.2/§7, D-052 amended); re-runs; acceptance guard's pending list emptied; a small PR | `test:movement`, the feel report, NET-03/04, a 2-minute 16-bot run | `docs/03` §2.2, §5.2, §7; `docs/09` M4 ☑; D-052 | — |

M4 stays ☐ on main until increment 17 merges.

## 7. Risks

| Risk | Mitigation |
|---|---|
| The research values move after M4 (a capture, a feel session) and every tuned mechanic must follow | Superset formulas and presets (§2.3); implementation targets from params; the base decided first (increment 3) and felt early (Q4's pause after increment 6), so mechanics are tuned on the base they ship with; increment 17 lands the sign-off values |
| Player collision makes prediction miss near other players and the zero-misprediction gates fail | Built early (increment 4) so every later mechanic is built and net-tested with solid players; server order by id; client boxes extrapolated from the newest frame; the contact counter and touch bits classify contact corrections; contact metrics with their own bounds; the exact multi-player check proves pmove and the box builder agree with the server; numbers to Mustafa with Q2; fallbacks Q2 (b)/(c) or drawn-position boxes |
| A classifier that books every contact window as "contact" hides a real client/server difference | pmove reads only replicated inputs (team rules server-side only); the exact multi-player check bypasses the classifier |
| Server-side state changes outside pmove leave the quantize grid | Deferred effects re-quantize; DEV_ASSERT in `capture()`; a server test after a diagonal boot |
| Overlapping players stick (spawns, crouch under someone, rounding) | Start-inside skipped; ε stop leaves ≥ 1/64 u after the snap's rounding; spawn occupancy check; unit tests with overlaps |
| The snapshot budget: 4 bits of slack at 37 players; `SNAP_MIN_CAPACITY` 33 | The layout fixed in increment 2 with its static checks; goldens; the review's fixes added no bits; any later growth re-decides 37 → 36 in the open; levers listed (§2.2) |
| Missing a field somewhere (codec, digest, equals, frame lane) or keeping sim state outside PlayerState | Behavioural field guard; NET-03 compares every field every tick; restart-from-the-wire legs; canonical rules in quantize; width checks at load |
| Narrow ledge window skipped in fast falls, or the post-kick reach overshooting the FACT | Swept check on the tick's interval with the full-window probe; the leave gate; Lg sweeps over tick phases, drop heights and gaps |
| Two landing sites and the water-level order | One landing step after the post-move water check; tests landing in level 2 vs level 1 |
| Primer misses new branches (code outside `sim/pmove/` included); its time and the fast tier grow | Per-increment course, segments and drills; widened coverage guard and mix; first-contact window; one `PlayerBoxes` call shape; primer cost reported as files × Δms; primer off in logical files |
| Native-ESM boxing in new branches (doubles across calls) | Out-params and typed arrays as in D-023; one workload per new path, including code outside `sim/pmove/` |
| `dpow` differs across engines | Exact operations only; D-016 vectors; Chrome, Firefox and WebKit replay |
| The research's single accelerate fit makes walk, crouch and ladder ramps slow (1.1–2.1 s) and misses R's top-end ramp points | MV-01 asserts the fit's points and logs the rest; MV-03/18 windows re-targeted and logged; capture item 1 would settle it; `pm_accelerate` is live-tunable |
| MV-09's band comes from an unverified lead | Forward-only bot with sprint asserted; measured in increment 6; outside the band → a question, not a silent re-target |
| Starve repeats now trigger mechanics (a repeated crouch starts a slide; a neutral cmd drops a climber) | Classified as starved (D-050); NET-04's mean and render-offset bounds re-measured on `wan-150-loss2` |
| The M3 net and bot suites were tuned on non-stop hoppers and a 320 base | Stamina overrides in the M3 harnesses, real rules in the M4 legs; bots pace hops; thresholds from params; the suites and a bot run gate increments 3 and 6 |
| Deaths are new (first in the game) | The death kept in its frame, respawn as a teleport next tick (D-035), never a correction; dead gate; `PLAYER_DEATH` to everyone and in demos; match tests |
| False "hit" feedback from prediction | Predicted boot plays a swing only; impact and stomp sounds on `HIT_CONFIRM` |
| Audio autoplay and headless runs | Resume on the pointer-lock click; no-op backend without `AudioContext`; planner tested DOM-free |
| New default binds never reach a saved custom set | Merge rule: a new default action whose key is free in the saved set gets it (settings test) |
| Doc goldens, vectors and golden hashes churn every increment | Regenerated in the increment that changes them, with the reason in the commit and the decision log; algorithm tests and vector set 0 on the docs fixture |
| Clean room | Values come from R's prose and telemetry (INFERRED); no UrT code or assets; sounds synthesized; `clean-room-auditor` at close |

## 8. Questions for Mustafa (the plan asks them in plain words; each has a recommendation)

**Answered 2026-10-13:** every recommendation below was chosen (Q1 B, Q2 a and i, Q3 b, Q4 a), and both FACT upgrades and `docs/02` A1–A17 were approved; the header has the summary.

**Q1. Which values M4 is built with.** (A) the current `docs/03` values and the Q3 base, as he said before the research: **the default until he answers**. (B) **Recommended:** the research column of §4.1 as the default, with the docs column one `movement_preset docs` away. (The first draft's "UrT layer on the Q3 base" is dropped: the values form a set, and with run 320 every run-jump reaches the 300 slide speed while with apex 45.6 the 58–66 window reaches only 104 u. The "capture first" option moved into Q3.) Increment 3 waits for the answer. *Consequences of B* as in §4.2–§4.3; `docs/03` §2.1 relabels eight rows from FACT-Q3 to INFERRED; D-052 records the choice and every re-target. The hull stays Q3's in both (R found UrT's box is 32 × 32 × 72 but proposed no change).

**Q2. Player collision and its prediction.** (a) **Recommended:** solid players, predicted against the newest snapshot extrapolated (§2.11); contact corrections never count as mispredictions and are measured on their own; increment 4 reports the numbers before anything is built on top. (b) Solid on the server only; the client predicts as if ghosted. (c) Not solid in M4 (`sv_ghostAll` 1 by default); collision, goomba and boot wait. **Part 2, boots at high ping** (gap 16, golden rule 6): (i) **recommended:** keep `docs/05` §7 (kicks rewound like melee); M4 uses current positions as a logged temporary deviation and M6 adds the rewind; (ii) amend §7 so boots stay movement probes on current positions.

**Q3. A UrT 4.3.4 capture session** (R §5, observation only, our own throwaway map; golden rule 1 allows it). Before building (about 3 hours of his time first, items 1–7); **recommended:** in parallel whenever he likes, items 1 and 2 (about 75 minutes: base speeds and ramps including walk and crouch 0 → cap, the low-stamina penalty), results arriving as logged cvar changes; or not at all.

**Q4. A base-feel pause.** (a) **Recommended:** after increment 6 (run, sprint, stamina on his column), a 15-minute check with `movement_preset docs|research` and `cvardiff`; increments 7–12 continue on what he confirms. (b) No pause: keep going and report at the end (his M3 choice).

**Defaults used unless he says no** (one line each in the plan): the two FACT upgrades (`pm_slideMinSpeed` 300 "about 300"; "the goomba attacker is unhurt") as an explicit yes/no; the `docs/02` corrections A1–A17 as a separate yes/no, applied in increment 3 under either Q1 answer; `st_sprintDrain` 12; the M2 movement answers (ladder foot with forward for every airborne attach; the top-mount probe; crouch factor on the ground only; the water-jump); respawn one tick after death; drowning at 12.5 HP/s; the self-bandage on F; booting a teammate with friendly fire off swings but does nothing (UrT blocks it), vs our docs' shove; boots airborne only; stomping teammates only with friendly fire on (until M6); placeholder sounds also for jump, land and boot; the speed trail on horizontal speed; the strafe helper as a cheat; HP rounded up on the HUD.

## 9. Spec gaps resolved

| Gap | Resolution |
|---|---|
| 1 Water-jump unspecified | §2.10 (our design, ESTIMATE cvars, design-constant probes); default list |
| 2 Drowning law | §2.10 rate reading with exact 8 s at 100 HP; default list |
| 3 Teammate boot | blocked teammate boot swings with no effect (UrT's block); `g_friendlyFire` SERVER until M6; default list |
| 4 Impact speed vs LAND | vi analytic with the negative-radicand guard; LAND carries vi (D-023 amended, D-060) |
| 5 Goomba head region | the top face of the victim's box until M6 hitboxes |
| 6 Bandage before M6 | self-bandage hook in `combat/medic.ts` (default list) |
| 7 Boot weapon slots | slots 0 knife, 3 sidearm, 4 grenade through `heldWeaponSlot` (D-018's open mapping pinned, D-061); the held weapon replaces the cmd's slot in M6 |
| 8 Ladder catch | vz = 0 on an airborne attach while falling, forward held (§2.9) |
| 9 Remote collision on the client; server order | §2.11 (server by id; client boxes from the newest frame extrapolated; contact counter; exact check) |
| 10 Unlabelled numbers | cvars (`st_sprintMoveSpeed`, `st_idleSpeed`, `pm_regrabDelay`, `pm_climbFinishTime`, `pm_climbPopHeight` for "1 u above") or design constants (§4.1) |
| 11 Sprint drain vs its target | `st_sprintDrain` 12 (exact on the 1/100 grid, 8.33 s; default list) |
| 12 docs/07 metrics and rails | updated for the chosen column (D-065); swept grab removes the rail sizing constraint |
| 13 docs/02 "kept Q3 speeds" | A1, a separate yes/no independent of Q1 |
| 14 Chest probe vs ledge min | the wall probe at feet + min − 8 (D-058) |
| 15 docs/03 §6 vs D-023, widths | §6 table pinned to §2.2; `movementEvents` removed; ticks everywhere (D-053) |
| 16 Boot rewind vs current positions | Q2 part 2; M4 current positions; `docs/05` §7 per the answer (D-061) |
| 17 Module layout | follow `docs/06` §3: `sim/urt/` and `combat/medic.ts`; the coverage guard widened to them |
| 18 Ledge-check placement | after the move, swept, air-move ticks only (D-058); `docs/03` §3, §4.5 amended |
| Primer stamina 0 | `startSegment` seeds every v4 field (§2.15) |
| Acceptance guard ranges | the guard learns ranges and slashes (increment 1); `docs/09` wording unchanged |
| Doc golden for `st_*` | §5.2 gains a Label column; the golden parses `st_` and `sv_ghost*` |
| Bandage's M6 restrictions | M6 (bleeding, targets, no firing) |

## Critical files
- `packages/shared/src/sim/{playerState,events,players,usercmd}.ts`; `sim/pmove/{pmove,pmTrace,basics,crouch,ground,walk,ladder,water,landing,params,presets,primer,debug}.ts`; `sim/urt/{sprint,stamina,wallJump,kick,powerSlide,ledgeGrab,fall,goomba}.ts`; `combat/medic.ts`; `world/boxTrace.ts`; `math/dpow.ts`; `net/{playerStateCodec,snapshot,worldFrame,events,protocol}.ts`
- `packages/server/src/match/{match,session,commands,spawns}.ts`
- `packages/client/src/net/{predictor,clientSim,remotes,roster,smoothing,scriptedInput,cmdRecorder,ghost,stats}.ts`; `audio/*`; `render/fx/speedTrail.ts`, `render/ghostMesh.ts`, `render/debug/debugDraw.ts`; `hud/*`; `app/{boot,game,demoGame,settings}.ts`; `console/{commands,binds}.ts`
- `packages/tools/src/scenarios/*`, `src/replay/cmdReplay.ts`, `src/reports/feelReport.ts`, `src/greybox/courses/{movement_lab,jump_lab}.ts`, `src/vectors/*`; `test/movement/*`, `test/net/*`, `test/perf/{pmoveCoverage,nativeEsmAllocation}.ts`, `long/*`; `test/guards/{acceptance-ids,scripts}.test.ts`; `test/docs/{pmove-cvars-docs,protocol-docs,client-cvars-docs,console-docs}.test.ts`
- `docs/02` §3, §13–§15; `docs/03` §2–§10; `docs/04` §3.4, §8.6, §9 notes; `docs/05` §3.4–§3.6, §4, §5, §7, §8.1, §10, §13, §14; `docs/06` §3, §6–§8, §10; `docs/07` §3, §6; `docs/09` M4, M8 note; `docs/10` §1, §2, §4; `docs/11` D-052…D-065

## Review notes (critique round, 2026-10-13)

Three lenses reviewed the first draft: movement (M1–M22), netcode (N1–N17) and scope (S1–S22), numbered in the order each lens listed them. Every finding was checked against the code, the docs and a 1-D model (the numeric claims of M1–M4, M8, M10 and S13 reproduce). **Applied as proposed:** M2, M5, M10–M13, M15–M20, M22; N1 (as Q2 part 2), N3–N7, N9–N13, N15–N17; S1–S4, S7–S9, S13–S17, S19, S21, S22. The ones below were applied with a change, or in part; nothing was rejected outright.

| Finding | Outcome | Reason |
|---|---|---|
| M1 (climb not resumable from state; atan2; no stop on arrival) and S11 (same) | Applied, with a different mechanism | `climbHeight` cannot double as the finish distance: its rise values (−25…52 u relative to the origin) overlap any forward distance, so the phase would be ambiguous. Instead `regrab` (unused while CLIMBING) counts the finish ticks (0 = rising), the rise pulls the hull to the wall (a trace that stops on contact, so no drift along an angled wall), and the finish moves a fixed 23 u to the point the space probe tested. That is state-complete with 0 extra bits. `climbYaw` takes the view yaw (M1's option b), and the finish moves by displacement, so the velocity is 0 on arrival (M1 c). |
| M3 (top probe misses on the take-off tick) | Applied, except the "60.25 u: no grab" test | With the research floor of 58 and the corrected probe, our sim grabs from 58.03 u above the floor, so a 60.25 u ledge *is* grabbed (UrT jumps onto it instead; the end state is the same). MV-13 asserts 60.375 at every phase and the window's own floor. 60.344 instead of 58 would reproduce the FACT exactly; that is logged as a feel knob (§2.8), not a default change. |
| M4 (post-kick reach) and S5 (same) | Applied M4's fix; S5's options not taken | The grab check now runs on the kick tick, and the leave gate (v·n > 16 u/s) closes the following ticks. That gives 119.09 u against the FACT 118.75 with no new state. S5's alternatives were not taken. Cutting `pm_ledgeReach` to ≈ 3 u would change an ESTIMATE that has no data and make normal grabs fiddly. A next-tick-only grab via `regrab` is no longer needed. `ledge_128` is re-checked (maxima 119.09 / 126.4 u). |
| M6 (ladder foot) | Applied, with the first of its two options | Forward is required for every airborne attach. The other option (forward-free catches only for real falls, vz < −270) is named as the alternative in §2.9. Near the ground it depends on rounding and leaves an edge case. |
| M7 (top mount) | Applied with a different probe | A downward sweep cannot hit a vertical ladder face. The probe is a horizontal sweep from a point lowered by `pm_stepSize`, the player is placed against the face, and the drop is smoothed through PMEV_STEP. |
| M8 (first damage truncates to 0) | Applied, with docs column 0 | M8 suggested 1 HP in both columns. The docs column reproduces `docs/03` as written (no minimum). The research column gets 1 HP. HP is shown rounded up. |
| M9 (boot's own trigger) | Applied | The world trace that confirms a boot hit, so you can't boot through a wall, is our addition. |
| M14 and N2 (client "server frames" rule) | Applied, with one choice made | Of the two options, the newest frame extrapolated is the default and drawn positions are the fallback. Extrapolation matches the server for steady movers, so it should give fewer corrections. Increment 4's numbers decide it if the fallback is needed. |
| M21 (base-feel pause) vs S6 ("ask three questions") | Both applied, as four questions | The pause changes Mustafa's time and the build flow ("keep going, report at the end" was his M3 choice), so it has to be a question, not a default. Everything else S6 wanted (Q1 C dropped, Q1 D folded into the capture question, design defaults and the presentation items in one "unless you say no" list, plain words) is done. |
| N8 (respawn timing) | Applied | We respawn at the start of the next tick, not after `capture(t)`. This keeps `respawn()`'s existing between-ticks timing (`spawn(s, currentTick + 1)`). |
| N14 (PLAYER_DEATH fields for M6) | Applied the "accept a change in v5" option | Reserving weapon and zone fields now buys nothing: M6 bumps the protocol anyway for weapon state, and a reserved field validated as 0 would change its validation then. |
| S10 (primer cap about 350 ms) | Applied in part | The per-increment measurement ("priming files × Δms"), primer-off in logical files and dropping the other-preset pass are adopted. The cap is a 450 ms design target instead of 350. M4 adds about six drills of about 10k calls each, so 350 ms (today 200–320) would likely be missed by construction, and the fast-tier allowance already caps the real cost. |
| S12 ("NET-04 corrections < 1/s including contact corrections") | That part not applied | NET-04's bounds were measured on a solo strafe-jumper. At 150 ms a client touching a moving player can correct on most snapshots by design (N2, M14), so folding contact corrections into "< 1/s" would make the gate fail for the wrong reason or force collision off. Contact corrections get their own measured bounds (§2.11), and the exact multi-player check covers correctness. MV-20, NET-03 and the tour stay single-player, as S12 asks. |
| S18 (both columns maintained forever) | Applied, keeping a few both-column cases | After Q1 the chosen column is the spec and the other gets one smoke. A handful of cheap both-column cases stay (ladder-top no-grab, water-jump no-grab, top-mount sweep, the jump-onto health check) because they guard rules (§2.8 exclusions) whose failure differs by window. |
| S20 (kit) | Applied | For the two-player recipe the dummy is a second browser *window* at `?connect=…&bot=idle`, not a headless "idle profile". It needs no new bots-CLI profile, and a visible window isn't throttled like a background tab. |
