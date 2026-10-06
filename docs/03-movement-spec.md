# 03 — Movement Spec

> The movement **is** the product. This spec defines our clean-room implementation of Quake-3-style movement plus the Urban Terror mechanics layer.
> Confidence labels: FACT / INFERRED / ESTIMATE (see `docs/02` §0). Every ESTIMATE is a **replicated cvar** so it can be tuned live (`docs/06` §6).
> Clean-room: the algorithms below are described in our own words. Do **not** consult or port id Software / ioquake3 source code.

## 1. Fidelity policy

1. **Lock the tick first** (60 Hz, `docs/05` §1). Air acceleration is capped per tick, so strafe-jump gains depend slightly on tick length. Tune feel only after the tick is final.
2. **Framerate independence.** Physics runs only in fixed ticks. Render rate never affects movement. Q3's 125-fps jump bonus is a bug we do **not** reproduce.
3. **Deterministic and quantized.** At the end of every tick, quantize origin and velocity (§6) identically on client and server.
4. **Tune by feel, verify by numbers.** `pnpm feel-report` prints every target in §8. When reference captures exist (`docs/02` §13), they override ESTIMATEs.

## 2. Space, units, hull, constants

- **Units:** 1 u = 1 inch. **Z-up.** Yaw = rotation around +Z (0 = +X), pitch positive = looking down (Quake convention); clamp pitch to ±89°.
- **Player hull (AABB, relative to origin; FACT for Q3, UrT may differ):**

| State | mins | maxs | Height | Eye height above origin |
|---|---|---|---|---|
| Standing | (−15, −15, −24) | (15, 15, 32) | 56 u | +26 (eye 50 u above feet) |
| Crouched / sliding | (−15, −15, −24) | (15, 15, 16) | 40 u | +12 (eye 36 u above feet) |

### 2.1 Base constants (Q3 baseline, FACT for Q3; UrT may have tweaked them, so they are cvars)

| Cvar | Default | Meaning |
|---|---|---|
| `pm_gravity` | 800 | u/s² |
| `pm_jumpVelocity` | 270 | u/s, set (not added) on jump |
| `pm_runSpeed` | 320 | ground wishspeed cap when running |
| `pm_stopSpeed` | 100 | friction control floor |
| `pm_friction` | 6 | ground friction |
| `pm_accelerate` | 10 | ground acceleration |
| `pm_airAccelerate` | 1 | air acceleration |
| `pm_duckScale` | 0.25 | crouch speed multiplier |
| `pm_walkScale` | 0.5 | walk modifier (≈160 u/s) |
| `pm_swimScale` | 0.5 | swim speed multiplier |
| `pm_waterAccelerate` | 4 | |
| `pm_waterFriction` | 1 | |
| `pm_stepSize` | 18 | max auto step-up |
| `pm_minWalkNormal` | 0.7 | ground normal Z threshold (≈45.6° slope) |
| `pm_overclip` | 1.001 | velocity clip overbounce |
| `pm_groundTraceDist` | 0.25 | downward probe distance |

### 2.2 UrT layer constants

| Cvar | Default | Label | Notes |
|---|---|---|---|
| `pm_sprintSpeed` | 365 | INFERRED | Community measured ~368 on ground with sprint. |
| `pm_maxWallJumps` | 3 | FACT | Reset on touching walkable ground. |
| `pm_wallJumpUp` | 290 | ESTIMATE | Vertical velocity floor after a kick. |
| `pm_wallJumpPush` | 140 | ESTIMATE | Outward velocity along the wall normal. |
| `pm_wallJumpReach` | 10 | ESTIMATE | Detection distance beyond the hull. |
| `pm_wallJumpMinHeight` | 40 | ESTIMATE | Wall must span this height (rejects curbs). |
| `pm_slideMinSpeed` | 300 | ESTIMATE | Horizontal speed needed to enter a slide. |
| `pm_slideFriction` | 0.8 | ESTIMATE | Replaces `pm_friction` while sliding. |
| `pm_slideEndSpeed` | 120 | ESTIMATE | Below this the slide ends (→ crouch). |
| `pm_slideSteer` | 0.5 | ESTIMATE | Accel allowed while sliding (≈ none). |
| `pm_ledgeMinHeight` | 24 | ESTIMATE | Min ledge top above feet at detection. |
| `pm_ledgeMaxHeight` | 76 | ESTIMATE | Max ledge top above feet at detection. |
| `pm_ledgeReach` | 18 | ESTIMATE | Forward probe beyond the hull. |
| `pm_climbSpeed` | 180 | ESTIMATE | u/s while pulling up. |
| `pm_fallSafeSpeed` | 560 | ESTIMATE | Impact speed below which no damage. |
| `pm_fallLegsSpeed` | 850 | ESTIMATE | Broken legs at/above this. |
| `pm_fallLethalSpeed` | 1100 | ESTIMATE | Death at/above this. |
| `pm_fallCurve` | 1.6 | ESTIMATE | Damage curve exponent. |
| `pm_limpScale` | 0.6 | ESTIMATE | Speed multiplier with unbandaged leg wound/broken legs. |
| `pm_trailSpeed` | 600 | FACT | Presentation-only threshold. |
| `pm_autoHop` | 0 | ESTIMATE | 0 = jump must be re-pressed (Q3 behavior); 1 = holding jump re-jumps on landing. |

Stamina cvars are in §5.2.

### 2.3 M2 base additions

New ESTIMATEs for the base ladder and water moves (M2 plan, "New tunables"; M2 design §4). Like every ESTIMATE they are replicated cvars, tuned by feel or by reference captures.

| Cvar | Default | Label | Meaning |
|---|---|---|---|
| `pm_ladderScale` | 0.5 | ESTIMATE | Ladder speed = `pm_runSpeed` × this (§4.14). |
| `pm_ladderFacing` | 0.5 | ESTIMATE | Stay attached only while dot(forward, −ladder normal) exceeds this (§4.14). |
| `pm_ladderReach` | 2 | ESTIMATE | u; length of the forward probe that finds the ladder face. |
| `pm_ladderJumpPush` | 150 | ESTIMATE | u/s; jumping off adds this along the ladder normal. |
| `pm_waterSinkSpeed` | 60 | ESTIMATE | u/s; the swim wish speed downward with no move or vertical input (§4.13). |

## 3. Tick pipeline (per player, per tick)

Inputs: the previous `PlayerState` and the `UserCmd` for this tick (`docs/05` §3: `forwardmove`/`rightmove` in −127..127, buttons, view angles). Output: the next `PlayerState` plus events.

**Contract** (D-023): `pmove(ps, cmd, world, params, dt, events, debugLog)` updates `ps` in place.
- `cmd` is already sanitized (`sanitizeUserCmd`, `docs/05` §3.4).
- `dt` is a parameter: `TICK_DT` in play, other tick lengths only in tests (MV-04 checks 1/120 s).
- `params` holds the replicated movement cvars as plain fields, refreshed outside the tick when the cvar registry's version changes.
- `events` (step, jump, land; may be null) and `debugLog` (the traces run; may be null) are output only. They never feed the next tick and are not part of `PlayerState`; remote players get events through the entity state in M3.
- The hull changes only in the pre-checks, at the tick's start origin.

1. **Copy view angles** from the cmd and compute forward/right/up vectors.
2. **Pre-checks**, in this order, at the tick's start origin (D-024):
   - crouch transitions (try to stand if crouch released; stay crouched if the standing hull doesn't fit), which pick the tick's hull
   - water level (0 = dry, 1 = feet, 2 = waist, 3 = submerged) from content samples at feet, waist and eyes (§4.13), the eyes for the stance just picked
   - ladder contact (§4.14), probed with that hull
   - limp state (M4)
3. **Ground trace** (§4.10). If the player was airborne last tick and is grounded now, run **landing** (§5.6/§5.7): fall damage, goomba, slide entry check.
4. **Mode dispatch** (first match wins):
   1. `climbing` → ledge climb (§5.5)
   2. on ladder → ladder move (§4.14)
   3. water level ≥ 2 → water move (§4.13)
   4. grounded → walk move (§4.4), or slide move if `sliding` (§5.4)
   5. otherwise → air move (§4.5), which includes the wall-jump check (§5.3) and the ledge-grab check (§5.5)
5. **Post:**
   - ground trace again
   - reset the wall-jump counter if on walkable ground
   - update stamina (§5.2), timers, breath/drowning
   - emit events: footstep, jump, land, wallkick, grab, slide start/end, fall damage
6. **Snap and quantize** (§6): the origin goes to the nearest clear 1/32 u grid point for the tick's hull (`snapOrigin`, D-017; last tick's origin is the fallback), then the whole state is quantized.

The **order matters**: on a grounded tick the jump check happens **before** friction. A jump pressed on the landing tick therefore skips ground friction entirely. This is what makes chained hops keep their speed.

## 4. Base algorithms (Q3-style, our wording)

**Trace contract** (D-017, `packages/shared/src/world/trace.ts`). Every hull trace below sweeps the box against brushes and stops ε = 1/32 u short of the surface it hits, so on a flat floor the player rests at floor + 1/32 u, which the step, crouch and gap metrics in `docs/07` §6 account for. A box that exactly touches a brush is outside it. A move that does not approach a plane never collides with it, so sliding along a face, or inside the 1/32 u skin, is free; a move that approaches a plane from inside the skin stops at once without `startSolid`. On slopes and angled walls a move meant to run exactly along the plane can round to approaching it by a few ulps and stop that way, so the slide move gets off a plane through the overclip (§4.7) and the same-plane nudge (§4.8), never through exact tangency.

### 4.1 Command scale (no faster diagonals)
Let `f`, `r`, `u` = forwardmove, rightmove, upmove (−127..127).
- If all are 0: scale = 0.
- Otherwise: `scale = speed × max(|f|,|r|,|u|) / (127 × sqrt(f² + r² + u²))`.

`speed` is the current speed cap: run, sprint, walk (`runSpeed × walkScale`), times `duckScale` when crouched and `limpScale` when limping.

The wish velocity is built from `f` and `r` along the movement basis, so diagonal input never exceeds the cap.

### 4.2 Friction (ground and water)
- Ground (walking, not sliding, not on slick surfaces): use horizontal speed `s`.
  - If `s < 1`, zero the horizontal velocity.
  - Otherwise: `control = max(s, stopSpeed)`, `drop = control × friction × dt`, `newSpeed = max(s − drop, 0)`, and scale the velocity by `newSpeed / s`.
- Water adds `drop += s × waterFriction × waterLevel × dt` (use full 3D speed in water).
  - In M2 (D-024) the walk move measures `s` as the horizontal speed for both terms, so wading (level 1) only adds the water term to its ground friction; the run, walk and crouch caps are unchanged, because at each cap the two terms together remove less than one tick of `pm_accelerate`. The swim move (§4.13) uses the water term alone on the 3D speed, and the ladder move (§4.14) uses the ground term on the 3D speed; below 1 u/s of 3D speed they zero the whole velocity.
- Sliding uses `slideFriction` instead of `friction` and **no** `stopSpeed` floor.

### 4.3 Accelerate (identical for ground and air; only the coefficient differs)
1. `current = dot(velocity, wishDir)`
2. `add = wishSpeed − current`; if `add ≤ 0`, return.
3. `accel = coefficient × dt × wishSpeed`, clamped to `add`.
4. `velocity += wishDir × accel`

**Why strafe jumping works.** The cap compares only the component along `wishDir`. If the player keeps `wishDir` almost perpendicular to their velocity (strafe key + mouse turn), `current` stays small. Each tick then adds speed, and the total speed grows beyond `wishSpeed`. Straight-ahead hopping adds nothing, because `current` already equals the cap.

### 4.4 Walk move (grounded)
1. If the jump check succeeds (§4.11), run air move (or water move) for this tick and return.
2. Apply friction (§4.2).
3. Build the movement basis: flatten forward/right onto the **ground plane** (clip against the ground normal), normalize, compute `wishVel`, `wishDir`, `wishSpeed` (scaled per §4.1).
4. Accelerate with `pm_accelerate` (or air accel when on slick surfaces).
5. Keep the speed magnitude while following the slope: remember `|v|`, clip the velocity to the ground plane, renormalize to the remembered magnitude.
6. If horizontal velocity is zero, stop. Otherwise run **step-slide move without gravity** (§4.9).

### 4.5 Air move
1. Flatten forward/right to horizontal (z = 0), normalize, build the wish vector; `wishSpeed` per §4.1. **Sprint raises the air `wishSpeed` cap too.** This is why sprint-held circle jumping is strong.
2. Accelerate with `pm_airAccelerate`.
3. If touching a steep surface that isn't walkable, clip the velocity against that plane.
4. Run **step-slide move with gravity** (§4.6, §4.9).
5. Wall-jump and ledge-grab checks run **before** step 2 in the same tick (§5.3, §5.5).

### 4.6 Gravity integration
Use half-step (trapezoidal) integration so jump arcs are tick-rate independent:
- `vEnd = vz − gravity × dt`
- Move with `vz_avg = (vz + vEnd) / 2`
- Then set `vz = vEnd`

Expected apex for a 270 u/s jump: `270² / (2 × 800) = 45.56 u`.

### 4.7 Clip velocity (slide along a plane)
- `backoff = dot(v, n)`
- If `backoff < 0`: `backoff *= overclip`; else `backoff /= overclip`.
- `v' = v − n × backoff`

The tiny overclip pushes slightly away from surfaces so the player doesn't re-collide on the next trace.

### 4.8 Slide move (multi-plane collide-and-slide)
Up to 4 iterations, tracking up to 5 contact planes (always include the ground plane if grounded, and the original velocity direction as a pseudo-plane).

Each iteration:
1. Sweep the hull from origin by `v × timeLeft`.
   - If the sweep is **allSolid** (the box is inside one brush for the whole move): zero vertical velocity and stop (stuck). The end-of-tick snap keeps every tick's start clear, so this is a bug and asserts in dev builds. A sweep that only *starts* in solid can move out of the brush and is accepted (D-023).
   - Otherwise advance to the hit point.
   - Done if the sweep completed without hitting anything.
2. Subtract the used fraction from `timeLeft`.
3. If the new plane is (nearly) the same as a stored one (normals' dot > 0.99), nudge the velocity by the normal and continue.
4. Clip the velocity against the new plane (§4.7). If the result still moves into another stored plane, clip against that too.
   - If moving into **two** planes, slide along their crease (cross product of the normals, keeping the velocity component along it).
   - If moving into **three**, stop.
   - Here a stored plane counts as cleared only when the velocity leaves it at more than 0.1 u/s; slower is "moving into" it, so it is clipped and the overclip makes the velocity leave it.
5. If the velocity now opposes the *original* velocity (dot < 0), stop. This prevents jitter in corners.

With half-step gravity (§4.6) the end-of-tick velocity is clipped against the same planes as the move velocity, and is what the move leaves behind. Return whether any plane was hit (used by step-slide).

The 0.99 and 0.1 u/s thresholds are design constants (`SLIDE_SAME_PLANE`, `SLIDE_LEAVE_SPEED`), not feel knobs or ESTIMATEs of the original game.

### 4.9 Step-slide move (auto stairs)
1. Save the start origin/velocity and run slide move.
2. If nothing was hit, done.
3. Do **not** step if moving upward fast (jumping) and there is no ground below within `stepSize`.
4. **Try the stepped path:**
   - Trace the hull up by `stepSize` from the start origin; if blocked at the start, give up.
   - From the raised position, with the start velocity, run slide move.
   - Trace back down by the amount actually raised plus `groundTraceDist` (D-023). A player rests ε above the floor (D-017), so a trace of exactly the raise ends at the start height without reaching the floor, and a stepped path that has not yet cleared a riser would never count as landed.
   - In the walk move (no gravity) the trace also goes down by whatever the stepped slide itself rose, so it always reaches `groundTraceDist` below the start height (D-023). Walking up a slope moves along it; at a crest the hull, riding the slope inside its ε skin, meets the platform's riser a few hundredths of a unit below its top, and a trace of only the raise would stop above the platform and leave the walk dead on that lip (MV-06). Where the plain slide clears that lip instead, the walk keeps the slope's vz onto the platform and may kick off the crest (§4.10).
   - If that lands on walkable ground, accept the stepped result; otherwise keep the unstepped one.
5. **Compare** horizontal distance and keep whichever path got farther. Clip the velocity against the final ground plane.
   - The stepped path must get at least 1/16 u farther (`STEP_MIN_GAIN`). Along a wall, slope or rotated plane both paths cover the same ground to within the same-plane nudge, and without the margin rounding would pick the stepped path and report spurious steps.
   - Within 1/16 u either way the paths **tie**: keep the unstepped origin, with the velocity of whichever path kept more horizontal speed (D-023). A plain slide that touches a riser at the end of the tick is clipped to a stop, while the stepped one, still short of the riser, kept its speed; taking the plain velocity there made stairs snag to 0 u/s.
6. Emit a `step` event with the height delta (at least 1/32 u, one origin grid step). The client uses it to smooth the view height (no visual pops).

### 4.10 Ground trace and slopes
- Sweep the hull `groundTraceDist` (0.25 u) straight down. No hit → airborne.
- If moving upward (vz > 0) and `dot(v, groundNormal) > 10` → treat as airborne. This covers jumping and being launched; without it you would immediately "re-ground".
- If `normal.z < minWalkNormal` → **steep**: not walkable. Apply air physics and clip against the plane, so you slide down slopes.
- Otherwise grounded. Record the ground entity and surface flags. The ground is **slick** or **nodamage** when the hit plane has the `SURF_SLICK`/`SURF_NODAMAGE` face flag **or** the hit brush has `CONTENTS_SLICK`/`CONTENTS_NODAMAGE` (D-023). Bevel planes carry no face flags, but the trace keeps the brush's contents whichever plane it hits, so a ramp crest standing on the top bevel is still slick.
- If the player was airborne and is now grounded, **clip the velocity against the ground plane** (§4.7) and emit a `land` event; its value is the downward speed at the start of the tick (D-023). A fall can end within `groundTraceDist` of the floor without the slide sweep touching it; without the clip the next walk move (§4.4 step 5) would lay the whole fall speed onto the ground as horizontal speed.
- After the move, a player the ground trace finds grounded is **settled** onto the ground (moved to the trace's end point) before the end-of-tick snap (D-023). A walk along a slope moves by the same step every tick, so the snap rounds it by the same error every tick; without the settle that drift adds up past `groundTraceDist`, and the player would drop into an air tick (and a spurious `land`) every few ticks.
- **Crest kick-off:** walking up a slope onto a flat crest, the velocity still carries the slope's vz on the tick the ground trace first finds the flat ground, so the rule above can make the walk airborne for one short hop (up to about 35 u from a 0.71 slope at the run cap), depending on where the tick ends at the crest. It follows from the kick-off rule as specified and is accepted (D-023, MV-06).
- Known limit: feet exactly on the floor (an anchor start; a walk on flat ground never lifts them; the match spawns players one ε up, D-027) meet the toe of a steep wedge on its axial bevel and stop there as at a wall; feet one ε up (any player that has landed) are clipped onto the slope and jitter at the toe while forward is held (D-023, "Steep toes"; MV-06 pins both).
- Known limit: a crevice between steep (non-walkable) planes, such as two steep slopes or a steep slope against a wall, can hold the player with zero velocity and no walkable ground, so they can neither slide out nor jump. This is accepted base-movement behaviour; maps must not build such crevices where players can reach them (a map-validation check is planned with the map pipeline, `docs/07`).

### 4.11 Jump rules
- Requires the jump button **newly pressed** since the last jump (unless `pm_autoHop = 1`), grounded, not crouch-blocked, and not in a climb.
  - **Crouch-blocked** means crouched with the standing hull blocked at the current origin, i.e. under a ceiling: no jump there. Crouch-jumping in the open is allowed (D-023).
- Set `vz = jumpVelocity` (set, not add), clear grounded, set the `jumpHeld` flag, charge stamina (§5.2), emit `jump`.
- `jumpHeld` clears when the button is released.

### 4.12 Crouch
- Holding crouch switches to the crouched hull immediately (shrinks from the top).
- Releasing tries to stand: sweep-test the standing hull at the current origin; stay crouched if blocked.
  - In M2 both happen only in the pre-check at the tick's start origin (D-023, D-024): the stand test is a position test of the standing hull there, so a player walking out of a low tunnel stands on the first tick whose start origin is clear. `PMF_CROUCHED` holds the stance.
- **Crouch-down costs stamina** (§5.2); standing up is free.
- Crouch speed = `runSpeed × duckScale`.
- Crouch gives **no** weapon accuracy bonus (`docs/04`).

### 4.13 Water
- **Water level** (D-024): `pointContents` samples on the origin's vertical, counted from the feet (the hull bottom, origin z − 24): feet + 1 u, feet + 28 u (the middle of the standing hull) and the eye, feet + 50 u standing or feet + 36 u crouched (origin + 26 / + 12, §2). Each level needs the samples below it: 1 = feet, 2 = waist, 3 = eyes under water. `PMF_IN_WATER` is set at level ≥ 1. The sample heights are design constants (`WATER_SAMPLE_FEET`, `WATER_SAMPLE_WAIST`), not ESTIMATEs. It is computed in the pre-check and again after the move.
- **Water level ≥ 2 → swim:**
  - Wish velocity uses the full 3D view vectors. **Jump = up, crouch = down** (UrT), so the player can strafe and aim like on ground.
    - Forward and right go along the 3D view forward and right; the vertical axis is world z: jump adds +127 and crouch −127 to the cmd's up axis (clamped to ±127), and the three axes go through command scale (§4.1) together, without the crouch factor.
    - World z is not orthogonal to a pitched view forward, so the summed wish is capped at the speed command scale picked (never stretched): forward + jump looking straight up swims at 160 u/s, not √2 × 160.
  - Speed scaled by `swimScale`.
  - With no input, sink slowly (wish z = −`pm_waterSinkSpeed`, 60 u/s, ESTIMATE).
    - "No input" means the forward, right and vertical axes are all 0; jump and crouch held together cancel, so they sink too. The sink wish is not scaled by `swimScale`.
  - No gravity. Friction is the water term only (§4.2), acceleration `pm_waterAccelerate`, then a step-slide without gravity (§4.9; against the floor plane when grounded), so a swimmer at the surface can climb out over an edge up to `pm_stepSize` high. Jump in the swim move swims; it never starts a ground jump.
  - Rising to the surface: once the waist sample leaves the water (level 1) the player is in air or walk moves again, falls back and swims up again, bobbing with the waist at the surface. **Water-jump** (climbing out of deep water onto a high edge) is M4.
- Friction per §4.2; acceleration `waterAccelerate`. **No sprint. No stamina regen.**
- **Breath** (FACT): 16 s of air while submerged (level 3), refilled instantly on surfacing. After it runs out, drowning kills in 8 s (≈12.5 HP/s).

### 4.14 Ladders
- **Ladder contact:** the hull touches a ladder-flagged surface **and** the player faces it (dot(forward, −normal) > `pm_ladderFacing`, 0.5, ESTIMATE). Turning away too far detaches.
  - **Detection** (D-024): the pre-check sweeps the tick's hull horizontally `pm_ladderReach` (2 u, ESTIMATE) along the yaw-only forward (pitch is ignored). Contact means the sweep hits a plane with the `SURF_LADDER` face flag and dot(forward, −n) > `pm_ladderFacing`. Only the face flag counts; `CONTENTS_LADDER` volumes stay reserved and are ignored by movement.
  - **No attach while moving away:** a player whose velocity leaves the face faster than 16 u/s (v·n > `LADDER_DETACH_SPEED`, a design constant) does not attach, so a jump-off never re-attaches on the next tick.
  - **On the ground** the ladder engages only while forward is held (forward > 0); standing at its foot or walking back from it is walking.
  - `PMF_ON_LADDER` holds the contact for the tick.
- On the ladder:
  - **forward = up, back = down**, regardless of pitch (FACT); strafe moves sideways along it.
    - The wish is the cmd's forward axis on world z plus its right axis along the view right projected onto the face plane, through command scale (§4.1, without the crouch factor), times `pm_ladderScale`.
  - No gravity while attached; ladder speed = `runSpeed × pm_ladderScale` (0.5, ESTIMATE).
    - Friction is the ground term on the 3D speed (§4.2), without the water term even where the ladder reaches into water, and acceleration `pm_accelerate`, so the climb converges to exactly the ladder speed and stops within about 0.4 s of letting go; then a slide move without gravity or ground plane.
  - Jumping off pushes away along the ladder normal (`pm_ladderJumpPush`, 150 u/s, ESTIMATE).
    - It takes a fresh jump press (the `jumpHeld` edge, §4.11, or `pm_autoHop`), adds n × `pm_ladderJumpPush` to the velocity, detaches at once and emits `jump`.
  - No slide-down.
  - **At the top** the hull rises past the face, the next probe misses, and the climb ends in an air move that carries the player over the edge onto the top (MV-18: `ladder_base` to `ladder_top`, 384 u, in about 3.1 s).
  - Ladder faces are vertical walls in M2; climbing is straight up world z whatever the face's tilt.
  - **Known limit (open, D-024):** a ladder cannot be mounted from its top. Walking backward off the top edge toward the face leaves it faster than `LADDER_DETACH_SPEED`, so contact is refused and the player falls.
- Climbing is free (no stamina).

## 5. UrT mechanics layer

### 5.1 Walk / run / sprint
- **Run** is the default. **Walk** is a held/toggle modifier (×`walkScale`; quieter footsteps, no footstep sound below the walk threshold).
- **Sprint** is active when all of these hold:
  - sprint held
  - forward held, with forward dominant (|f| ≥ |r|)
  - stamina > 0
  - not crouched
  - water level < 2
  - not limping

  While active, the speed cap = `sprintSpeed` on ground **and in air**.
- Sprint drains stamina per second while active, on ground or in air, but only while actually moving (horizontal speed > 50).

### 5.2 Stamina
- `stamina` ∈ [0, `staminaMax`], with `staminaMax = health × (vest ? 0.5 : 1)` (FACT). When health drops, clamp stamina down to the new max.
- **Costs** (ESTIMATE; tune with reference captures):

| Cvar | Default | Applies |
|---|---|---|
| `st_sprintDrain` | 11 / s | while sprint active and moving |
| `st_jumpCost` | 5 | per ground jump |
| `st_wallJumpCost` | 8 | per wall jump |
| `st_crouchCost` | 2 | on crouch-down transition |
| `st_slideCost` | 6 | on slide start |

- **Regeneration** (ESTIMATE):
  - Rates: `st_regenIdle` = 18/s when stationary (horizontal speed < 10); `st_regenMove` = 5/s when moving and not sprinting; 0 in water (level ≥ 2).
  - Regen starts after `st_regenDelay` = 0.5 s since the last cost.
- **When stamina runs out** (ESTIMATE, unknown in original):
  - sprint unavailable
  - ground jumps still allowed (costs clamp at 0)
  - wall jumps require `stamina ≥ st_wallJumpCost`
- **Feel targets:** full sprint from 100 lasts ≈ 8–9 s; empty→full standing ≈ 5–6 s.

### 5.3 Wall jump (reconstruction, behavior FACT, math ESTIMATE)
**Preconditions:**
- airborne, not on a ladder, water level < 2, not climbing
- jump newly pressed
- `wallJumps < maxWallJumps`
- stamina ≥ cost

**Wall detection:**
1. Cast short horizontal hull-edge traces from the origin in 8 compass directions plus the current wish direction. Each trace has length `15 + wallJumpReach`. Run them at two heights: feet + 8 u and feet + `wallJumpMinHeight`.
2. A candidate wall needs **both** heights to hit **world geometry** (not players, not clip-only triggers) with a near-vertical normal (|n.z| < 0.3).
3. Pick the candidate whose normal is most opposed to the wish direction; on ties, pick the nearest.

**Impulse** (with `n` = wall normal, pointing away from the wall):
1. `vn = dot(v, n)`. If `vn < 0`, then `v −= n × vn` (cancel motion into the wall).
2. `v += n × wallJumpPush` (kick away).
3. `v.z = max(v.z, wallJumpUp)`. This resets a fall, which enables the documented controlled descents and lowers landing speed.
4. Keep the tangential component untouched. Kicking a wall at an angle converts to speed (FACT: "gain speed by kicking a wall sideways").

**Bookkeeping:**
- `wallJumps += 1`, charge stamina, emit `wallkick` (sound + leg anim). Set `jumpHeld`.
- `wallJumps` resets on landing on walkable ground (not on ladders or water).

**If the trace hits a player instead:** this is a kick attempt (§5.8), not a wall jump.

**Tuning goals:**
- Chimney climb: 3 kicks between two walls 64 u apart gain ≈ 120–160 u of height (ESTIMATE).
- An angled kick from a 400 u/s run along a wall exits faster than it entered.

### 5.4 Power slide (reconstruction)
**Entry** (on the landing tick): crouch held, crouch was pressed *while airborne*, and horizontal speed ≥ `slideMinSpeed`. Charge stamina, set `sliding`, use the crouched hull, emit `slideStart`.

**While sliding:**
- Friction uses `slideFriction`.
- Acceleration is limited to `slideSteer` (a nearly locked direction): **movement direction ignores view direction** (FACT), so the player can aim anywhere while velocity carries them.
- Limp does not reduce slide speed (FACT: works with broken legs).

**Exit** (emit `slideEnd`):
- horizontal speed < `slideEndSpeed` → normal crouch
- crouch released → try to stand
- jump pressed → normal jump (friction skipped that tick, so momentum carries into the air)

**Weapons:** non-scoped weapons fire normally while sliding; scoped weapons are heavily penalized (`docs/04`).

**Feel target:** from sprint speed (365) on flat ground, slide ≈ 300–420 u before ending (ESTIMATE).

### 5.5 Ledge grab and climb (reconstruction)
**Check** (airborne, or grounded but blocked by a wall): forward held (or jump held; support both). Not crouched, not sliding, water level < 2.
1. **Wall probe:** a forward trace at chest height (feet + 40) of length `15 + ledgeReach` must hit a near-vertical world surface.
2. **Top probe:**
   - Start above the wall at feet + `ledgeMaxHeight` + 8, moved forward by (wall distance + 8 u).
   - Trace down to feet + `ledgeMinHeight`.
   - Must hit a walkable surface (`normal.z ≥ minWalkNormal`) at height `h` within [`ledgeMinHeight`, `ledgeMaxHeight`] above the feet.
3. **Space probe:** the crouched hull must fit standing on that surface (an empty box test).

**On grab:**
- Set vertical velocity to 0 immediately (**no fall damage**, FACT), set `climbing`, emit `grab` (distinctive sound).
- Store the target ledge point.

**While climbing:**
- If forward/jump is held: move up at `climbSpeed` until the feet are 1 u above the ledge, then move forward onto it over ~0.15 s.
- If released before the top: drop, resuming normal air physics with v = 0.
- Climbing is free.
- Weapons are lowered; reload may continue if it started before (order quirk, optional).

**Re-grab:** allowed after 0.2 s, or after touching ground.

### 5.6 Fall damage, broken legs, limp
- **Impact speed** `vi` = the downward speed at the moment of contact. Compute it analytically from the start-of-tick vz and gravity over the fraction of the tick before contact, so it doesn't depend on tick phase.
- **Damage** (ESTIMATE):
  - `vi < fallSafeSpeed` → 0
  - `vi ≥ fallLethalSpeed` → lethal
  - otherwise `100 × ((vi − safe) / (lethal − safe))^fallCurve`
- **Broken legs** if `vi ≥ fallLegsSpeed`: set the `legsBroken` flag → limp (×`limpScale`, no sprint) until bandaged (FACT: bandage fixes broken legs).
- **No fall damage:**
  - when landing in water at level ≥ 2
  - when a ledge grab or ladder catch occurred
  - on surfaces flagged `nodamage`
- Leg-zone wounds (lower leg, foot) also set `legWound` → limp until bandaged (`docs/04`).
- **Reference targets** (ESTIMATE; use for tuning tests):
  - 2-storey drop (256 u) ≈ small damage (~5)
  - 4-storey drop (512 u) ≈ 45–55 + broken legs
  - 6-storey drop (768 u) ≈ lethal

### 5.7 Goomba stomp
- On landing, if the hull's downward contact is **another player's head region** and `vi ≥ fallLegsSpeed`: the victim dies instantly (FACT: "a height where you'd break your legs or die").
- The attacker takes **no** fall damage (ESTIMATE; our design choice). Emit `goomba`. The kill-feed gets a special icon.
- Teammates are affected only if friendly fire is on.

### 5.8 Boot / kick
- **When:** airborne or moving, jump pressed while touching another player (same probe as §5.3, hitting a player), and the held weapon is knife, pistol or grenade (FACT).
- **Effect:** 20 damage to the body zone (FACT), small knockback (ESTIMATE 120 u/s along the push direction), 0.5 s cooldown (ESTIMATE).
- No damage to teammates unless friendly fire is on (but knockback is allowed for "shove" utility).

### 5.9 Player collision and ghosting
- Players are solid to each other: the hull traces include other players.
- Optional `sv_ghostTeammates` (default 0) and `sv_ghostAll` (Movement Trials mode = 1).
- Lag-compensated **positions are never used for movement collision**. Only current server state is used.

### 5.10 Presentation hooks (not physics)
- Speed trail when horizontal speed > `pm_trailSpeed` (600 u/s, FACT): team/personal color, client-side VFX.
- View smoothing on steps and landing dips, footstep cadence, wall-kick and grab sounds.
- Speedometer HUD (debug + optional player setting).

## 6. PlayerState (everything movement touches must be here, predicted and replicated)

| Field | Type | Notes |
|---|---|---|
| `origin` | vec3 | quantized 1/32 u |
| `velocity` | vec3 | quantized 1/16 u/s |
| `viewYaw`, `viewPitch` | u16 | 65536 steps per 360° |
| `flags` | bitfield | grounded, crouched, sliding, climbing, onLadder, jumpHeld, crouchPressedInAir, legsBroken, legWound, inWater… |
| `groundEntity` | i16 | −1 = none |
| `waterLevel` | u8 | 0–3 |
| `wallJumps` | u8 | |
| `stamina` | u16 | fixed-point ×100 |
| `health` | u8 | owned by combat; read by movement |
| `armor` | bitfield | vest, helmet |
| `breathMs`, `drownMs` | u16 | |
| `climbTarget` | vec3 | while climbing |
| `timers` | u16s | regen delay, kick cooldown, re-grab cooldown, slide time |
| `movementEvents` | small ring | footstep, jump, land(impact), wallkick, grab, slideStart/End, fallDamage, goomba |

**Quantize at the end of every tick:**
- origin to the nearest clear 1/32 u grid point (D-017): the rounded point if the hull fits there, else the nearest clear corner of the grid cell, else last tick's origin
- velocity to the nearest 1/16 u/s
- stamina to 0.01

This makes the client's predicted state **bit-identical** to the server's state for the same inputs (`docs/05` §4).

**Pinned down in M1** (D-018, `packages/shared/src/sim/playerState.ts`):
- M1 implements `origin` through `waterLevel`, plus `stamina`. `wallJumps` and the fields below `stamina` are added by the milestone that first simulates them.
- `stamina` is stored as an integer count of hundredths (0–65535), so 100 is one stamina point.
- `flags` bits 0–9 are the ten flags above, in the order listed; new flags take the next bit.
- Every scalar field holds an integer. Quantize clamps `origin` to ±16384 u and `velocity` to ±(2^19 − 1)/16 u/s (the i20 range) per axis, wraps the view angles to u16, clamps `groundEntity` to −1…32767 (32767 is the world) and `waterLevel` to 0–3, truncating toward zero.
- A non-finite value is a bug (a dev assert). With asserts off it falls back to 0, except `groundEntity`, which falls back to −1 (none) because 0 is a real entity.
- Rounding biases: stamina rounds to 0.01 every tick, so a per-second rate moves in steps of 0.6/s at 60 Hz (an 11/s drain runs at 10.8/s, 5/s regen at 4.8/s); M2 tunes the `st_*` cvars with this in mind. Origin rounding to 1/32 u each tick can add about 0.2% distance at 320 u/s, so feel tests measure velocity, not distance travelled.

## 7. Measurements log (fill from reference captures, `docs/02` §13)

| Quantity | Target (current) | Measured in UrT 4.3.4 | Date | Notes |
|---|---|---|---|---|
| Run top speed | 320 | | | |
| Sprint top speed | 365 (INFERRED) | | | |
| Walk / crouch speed | 160 / 80 | | | |
| Jump apex | 45.6 u | | | |
| Wall-jump height gain | ESTIMATE | | | |
| Slide distance from sprint | 300–420 u | | | |
| Ledge reach (max top above floor, standing jump) | ESTIMATE | | | |
| Sprint duration 100→0 | 8–9 s | | | |
| Regen 0→100 standing | 5–6 s | | | |
| Fall damage at 256/512/768 u | 5 / 50 / lethal | | | |

## 8. Feel targets and automated tests (`pnpm test:movement`, `pnpm feel-report`)

Every test runs headless at 60 Hz on code-built test courses (`docs/07` §3). Each test logs measured vs. target.

| ID | Test | Pass condition |
|---|---|---|
| MV-01 | Run cap | Holding forward on flat ground converges to 320 ± 0.5 within 0.6 s. |
| MV-02 | Sprint cap | Converges to `sprintSpeed` ± 0.5. Drains stamina at the configured rate. |
| MV-03 | Walk / crouch caps | 160 ± 1 / 80 ± 1. |
| MV-04 | Jump apex | 45.56 ± 0.5 u from flat ground. Identical at TICK_RATE 60 and 120 within 0.5 u (integration check). |
| MV-05 | Step-up | 18 u step climbed without jumping; 19 u step blocks. Smooth `step` events. |
| MV-06 | Slopes | Walkable at normal.z = 0.71; slides on 0.69. |
| MV-07 | No straight-hop gain | 20 consecutive forward-only hops (no turning, no strafe) never exceed the cap + 2%. |
| MV-08 | Strafe gain | Scripted ideal-strafe bot (optimal wish angle each tick) gains speed every hop. Logs the speed curve. |
| MV-09 | Circle-jump band | With sprint and wide arcs, the bot reaches ≥ 540 u/s within 12 hops (target band 540–580, from the ~555 community figure; tune air accel/sprint if outside). |
| MV-10 | Wall-jump limit | 3 kicks allowed, 4th denied until landing. Not off players. Not off a 24 u curb. |
| MV-11 | Wall-jump redirect | Angled kick conserves tangential speed and adds push; chimney climb gains within band. |
| MV-12 | Slide | Entry only when crouch was pressed airborne and speed ≥ threshold. Direction locked to velocity regardless of yaw. Distance within band. |
| MV-13 | Ledge grab | Catches a fall from 768 u with 0 damage. Grabs ledges within [min, max]. Climbs onto top within expected time. |
| MV-14 | Stamina | Costs and regen per §5.2. No regen in water. Vest halves max. Max tracks health. |
| MV-15 | Fall damage | Curve matches §5.6 at 256/512/768 u drops. Legs break at threshold. Bandage clears limp. |
| MV-16 | Goomba / kick | Goomba kills at ≥ legs speed onto a head. Kick deals 20 with eligible weapons only. |
| MV-17 | Water | Breath 16 s, drown 8 s. Jump/crouch control vertical swim. |
| MV-18 | Ladder | Forward = up regardless of pitch. Detach when facing away. |
| MV-19 | Determinism | Same inputs → bit-identical states across 10k ticks (run twice; and client vs. server builds). |
| MV-20 | Prediction parity | Recorded mixed-mechanics session: predicted client states == authoritative states every tick (no reconciliation needed on a lossless link). |

## 9. Tuning and debug tools (build them; they pay back immediately)

- **Speedometer + strafe helper overlay:** current speed, optimal wish angle indicator, ground/air state, wall-jumps left, stamina numbers.
- **Trace visualizer:** draw hull sweeps, wall-jump probes, ledge probes, ground normal.
- **Live cvars:** console `/set pm_wallJumpUp 300`. Replicated from server to clients instantly (`docs/06` §6).
- **Input recorder/player:** record UserCmd streams and replay them for regression tests and A/B tuning.
- **Ghost runs:** overlay a previous run (from a recording) as a translucent player.

## 10. Open questions (track; resolve via capture or design)

1. Does UrT auto-hop when holding jump? (`pm_autoHop` default 0.)
2. Exact wall-jump vector math; does facing/input direction influence the kick?
3. Does crouch-landing reduce fall damage (Q3 doubled it while ducked)? Default: no effect.
4. Ledge reach heights and whether you can grab while moving upward.
5. Stamina rates and whether low stamina weakens jumps.
