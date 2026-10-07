# M2 design: base movement, client shell, Worker server and prediction

> **Status:** the design record for M2, written before the code so that citations such as "M2 design §2" in code, tests and `docs/11` resolve. It is not a spec: where it differs from `docs/03`–`docs/10` or the decision log, those win, and the approved plan (`docs/design/M2-plan.md`) wins over this record. Mustafa approved the plan on 2026-10-06 with these choices: a full multi-agent review at the end of M2; the browser determinism check both as a CI job (Chromium, Firefox, WebKit) and as a phone test page; course-based tests in `packages/tools/test`; no pause between increments. Decisions D-022–D-028 below are written into `docs/11` in the increment that implements each one.

## 0. Facts the plan relies on
- **No `PlayerState` additions are needed in M2.** Every input pmove needs is either already stored or recomputed each tick from the start origin:
  - stored: `GROUNDED`, `CROUCHED`, `JUMP_HELD`, `ON_LADDER`, `IN_WATER`, `waterLevel`, `groundEntity`;
  - recomputed: the ground plane, ladder contact and water samples.
  - Movement events are pmove output only. They never feed the next tick. M3 adds `eventSeq` to the entity state for remote players.
- **Hull changes happen only in the pre-checks, at the tick's start origin.** That origin is on the grid and passed a stand test, so `snapOrigin`'s fallback (`SNAP_PREVIOUS`) is clear for the hull that ends the tick.
- **Cvars have no change hook.** I add `CvarRegistry.version`, a counter bumped on every value change, so callers can refresh pmove parameters without allocating.

## 1. Package layout

**Dependency graph** (no cycles):
- shared ← server
- shared, server ← client
- shared, server, client's `./net` subpath ← tools

New `exports` entries:
- server `"."` → `src/index.ts` (match code only)
- client `"./net"` → `src/net/index.ts`

### shared (`packages/shared/src`)
| File | Responsibility |
|---|---|
| `cvars/registry.ts` | + `version` counter |
| `sim/hull.ts` | + `VIEW_HEIGHT_STANDING 26`, `VIEW_HEIGHT_CROUCHED 12` (FACT Q3), `WATER_SAMPLE_FEET 1`, `WATER_SAMPLE_WAIST 28` |
| `sim/events.ts` | `PmoveEvents` ring (8 slots): `PMEV_STEP`, `JUMP`, `LAND` |
| `sim/pmove/params.ts` | `PmoveParams`, `PMOVE_CVARS` table (with labels), `registerPmoveCvars`, `refreshPmoveParams` |
| `sim/pmove/scratch.ts` | Per-module scratch: basis, wish, 5 planes, 2 `TraceResult`s, ground info, hull refs, prev origin, ladder normal |
| `sim/pmove/basics.ts` | `cmdScale`, `accelerate`, `applyFriction`, `clipVelocity` |
| `sim/pmove/slideMove.ts` | Multi-plane slide with half-step gravity |
| `sim/pmove/stepSlideMove.ts` | Auto-step plus `PMEV_STEP` |
| `sim/pmove/ground.ts` | Ground trace: walkable, steep or jumping; surface rule (D-023) |
| `sim/pmove/crouch.ts` | Hull swap, stand test, crouch-blocked |
| `sim/pmove/water.ts` | Water level and swim move |
| `sim/pmove/ladder.ts` | Ladder contact probe and ladder move |
| `sim/pmove/walk.ts` | `checkJump`, `walkMove`, `airMove` |
| `sim/pmove/debug.ts` | `PmoveTraceLog` (ring of 64 traces; observer only) |
| `sim/pmove/pmove.ts` | Pipeline, then snap and quantize |
| `net/bitstream.ts` | `BitWriter` / `BitReader`, bounds-checked, sticky error flag |
| `net/protocol.ts` | `PROTOCOL_VERSION = 1`, `MSG_*` ids, size limits |
| `net/messages.ts` | Structs plus `encodeX` / `decodeX` for every message |
| `net/playerStateCodec.ts` | `PlayerState` bit layout and validation |
| `net/cvarBlock.ts` | Replicated block encode, decode, apply and hash |
| `net/transport.ts` | `Transport`, `TransportStats`, `createLoopbackPair` (pooled) |
| `net/netsim.ts` | `NetSimTransport` (injected clock, Mulberry32) |
| `net/profiles.ts` | `NET_PROFILES` (docs/10 §3) |

### server (`packages/server/src`)
- `match/host.ts`: the `LoopHost` interface.
- `match/loop.ts`: accumulator loop.
- `match/match.ts`: the `Match` class.
- `match/session.ts`: per-client handshake state, player, queue, stats and admin flag.
- `match/inputQueue.ts`: per-client input queue.
- `match/commands.ts`: `set`, `reset`, `toggle` on replicated cvars, then a CVARS broadcast.
- `index.ts`: exports.
- `tsconfig.match.json`: lib ES2023 and `types: []`, so the match code cannot touch Node or the DOM.

### client (`packages/client`)
| Path | Responsibility |
|---|---|
| `src/net/*` | DOM-free, checked by a new `tsconfig.net.json` (ES2023, `types: []`). Files: `connection.ts` (handshake state machine, message dispatch), `clientSim.ts` (tick accumulator, cmd generation, send), `predictor.ts`, `clock.ts`, `smoothing.ts` (`RenderOffset`, `StepSmoother`), `stats.ts` (rolling 1 s windows), `portTransport.ts` (structural `PortLike` type), `scriptedInput.ts` (`?bot=` input), `index.ts` |
| `src/worker/` | `serverWorker.ts`, `workerHost.ts`; `tsconfig.worker.json` uses the WebWorker lib |
| `src/render/` | `space.ts` (the only coordinate conversion), `world.ts`, `materials.ts` (grid textures), `camera.ts`, `renderer.ts`, `debug/debugDraw.ts` |
| `src/input/` | `pointerLock.ts`, `mouse.ts`, `keyboard.ts`, `sampler.ts` |
| `src/console/` | `console.ts` (DOM), plus DOM-free `commands.ts`, `binds.ts`, `clientCvars.ts` |
| `src/hud/` | `speedometer.ts`, `netgraph.ts`, `overlay.ts` (crosshair, click-to-play, errors) |
| `src/app/` | `boot.ts` (fetch cmap via `?url`, decode, spawn Worker), `game.ts` (frame loop), `settings.ts` (ARCHIVE cvars and binds in localStorage) |
| `scripts/` | `browser.ts` (launch helper), `screenshot.ts` |
| Optional | `vectors.html` plus `src/dev/vectorsPage.ts`: dev-only page for a manual run in real Safari or iOS |

### tools (`packages/tools`)
- `src/scenarios/`: `course.ts` (loading code pulled out of `courses.test.ts`), `runner.ts`, `bots.ts`, `metrics.ts`, `determinismProbe.ts`.
- `src/reports/feelReport.ts`, `src/vectors/pmove.ts`.
- `bench/pmove.bench.ts`, `bench/codec.bench.ts`.
- Tests: `test/movement/mv-*.test.ts`, `test/net/{harness.ts, net-03-*.test.ts, net-04-*.test.ts}`, `test/docs/{pmove-cvars,net-profiles}-docs.test.ts`, and new allocation workloads (`pmove`, `codec`, `predict`, `match`).

### Root
- `vitest.browser.config.ts` (vectors project and e2e project).
- A new `browsers` job in `ci.yml`.
- `reports/` added to `.gitignore`.

## 2. Data structures and APIs

### pmove
```ts
pmove(ps: PlayerState, cmd: UserCmd, world: CollisionWorld, p: Readonly<PmoveParams>,
      dt: number, ev: PmoveEvents | null, dbg: PmoveTraceLog | null): void
refreshPmoveParams(reg: CvarRegistry, out: PmoveParams): boolean // only when reg.version !== out.version
```
- `ps` is updated in place. `cmd` is already sanitized.
- `dt` is `TICK_DT` in play. Only MV-04 passes 1/120.
- **Pipeline:**
  1. Save the previous origin; copy the view angles; run `angleVectors`; clear `JUMP_HELD` if jump is released.
  2. Pre-checks: crouch, water level, ladder.
  3. Ground trace, with a `LAND` event when airborne turns grounded (value = impact speed).
  4. Dispatch: ladder → water (level ≥ 2) → walk (jump check before friction) → air.
  5. Post: ground trace and water level again.
  6. `snapOrigin(..., MASK_PLAYERSOLID, prev, ps.origin)`, then `quantizePlayerState`.
- **Slide move:** both the move velocity and the gravity end velocity are clipped against every contact plane.
- **Events:** `value` is the signed Δz for `STEP`, the impact speed for `LAND` and 0 for `JUMP`.

### Replicated cvar block
- Entries are `registry.replicated()`, sorted by name: name length (u6) + 7-bit ASCII, kind (u2), then the value as i32, f64 (raw bits, so values stay exact) or 1 bit. Strings are 7-bit ASCII.
- Hash: `murmur3Bytes(canonical bytes, seed 'cvar')`. CVARS carries the u32; snapshots carry the low 16 bits.

### Messages (`PROTOCOL_VERSION` 1, LSB-first bit packing; `u8 type` leads every message)
| Msg | Channel | Fields after the type byte (bits) |
|---|---|---|
| HELLO C→S | reliable | protocolVersion 16, buildHash (len 6 + 7·n), nonce 32 |
| WELCOME S→C | reliable | protocolVersion 16, clientId 8, tickRate 8, serverTick 32, mapName (6 + 7·n), mapHash 2×32, cvar block |
| READY C→S | reliable | (none) |
| INPUT C→S | unreliable | packetSeq 16, lastSnapshotTick 32, count 3 (1–4), newestTick 32; per cmd, newest first: tickBack 8 (not written for cmd 0), buttons 16, fwd/right/up 8 each (two's complement), yaw 16, pitch 16, weaponSlot 8. About 55 B; 3.3 KB/s at 60 Hz |
| SNAPSHOT S→C | unreliable | serverTick 32, baselineTick 32 (0 in M2), lastProcessedCmdTick 32, inputBufferHealth i8, cvarHash 16, flags 8 (bit 0 starved, bit 1 teleport), then the state: origin 3×i21 (1/32 u), velocity 3×i20 (1/16 u/s), yaw 16, pitch 16, flags 10, groundEntity+1 16, waterLevel 2, stamina 16. About 42 B |
| PING C→S / PONG S→C | unreliable | pingId 16 / pingId 16, serverTick 32 |
| CVARS S→C | reliable | effectiveTick 32, blockHash 32, block |
| CMD C→S / PRINT S→C / KICK S→C | reliable | text (len 10 + 8·n) / level 2 + text / reason |

- **Decoding:** `decodeX(r, out): boolean` returns false on a short read, a value out of range (origin past ±16384 u, pitch past ±16201, tick past `TICK_MAX`, count > 4, non-zero baseline) or trailing bits beyond padding. The caller drops the packet and adds a strike.
- Server-side cmds always pass through `sanitizeUserCmd`.
- INPUT, SNAPSHOT and PING/PONG decode without allocating. Text fields allocate, but only on rare reliable messages.

### Transport (changes docs/05 §3.1; see D-026)
```ts
interface Transport { sendUnreliable(d: Uint8Array, len: number): void; sendReliable(d: Uint8Array, len: number): void;
  onMessage(cb: (d: Uint8Array, len: number, reliable: boolean) => void): void; poll(): void;
  close(reason?: string): void; stats(): TransportStats }
```
- `poll()` delivers queued messages at fixed points in the loop. `d` is valid only during the callback.
- `createLoopbackPair()` copies into pooled slots, so it allocates nothing in steady state.
- **`PortTransport`** uses two `MessageChannel`s, one per channel. Each send does `d.slice(0, len).buffer` and transfers it. This is the one allocation per packet, and it happens only at the postMessage boundary.
- **`NetSimTransport(inner, profile, clock, seed, wake?)`:**
  - It wraps the client endpoint only, delaying both directions with the one-way profile.
  - Unreliable packets keep FIFO order through jitter (`due = max(prevDue, now + delay ± jitter)`). Loss and duplication are drawn per packet. A reordered packet is held an extra 2×jitter + one tick.
  - Reliable packets are delayed and kept in order, never dropped.
  - `pump()` moves due packets. `wake(at)` lets the browser arm a `setTimeout`.
  - `setProfile` backs the `net_profile` command.

### Match loop
- `LoopHost { now(): number /*ms, monotonic*/; schedule(cb, ms): void; log(level, msg): void }`.
- `startMatchLoop(match, host)` re-arms with `schedule` (never `setInterval`):
  - `acc += now − last`; run `floor(acc / TICK_MS)` ticks.
  - At most 5 ticks per wake: if more are due, run 5, drop the rest, log one warning, keep the remainder below one tick.
- **`Match.tick()`**:
  1. Poll the transports and handle messages:
     - HELLO: check version and build; mismatch → KICK.
     - READY: spawn at `info_player_start` (yaw converted with `degreesToU16`, stamina 10000) and set the teleport flag.
     - INPUT: push into the queue.
     - PING: answer with PONG.
     - CMD: run it; admin only.
  2. If cvars changed, refresh params, set `effectiveTick` to the current tick and broadcast CVARS.
  3. In client-id order: `take(T)`. On a miss, reuse the last cmd with ATTACK cleared and `tick = T`, and mark it starved.
  4. pmove each player.
  5. Send a SNAPSHOT with `lastProcessedCmdTick = T` and `inputBufferHealth = clamp_i8(newestReceived − T)`.
  6. Record metrics.
- **`InputQueue`**: 64 slots indexed `tick & 63`, with a `slotTick` array.
  - It drops duplicates, ticks below the next tick to simulate, and ticks more than 64 ahead, counting each kind.
- The Worker host uses `performance.now` and `setTimeout`. The Node host comes in M3. The Worker's single client is admin.

### Client clock (M2, without time dilation)
- The client predicts in server-tick space.
  - Handshake: 5 PINGs, median RTT.
  - At the first snapshot A: `clientTick = A + ceil(RTT / TICK_MS) + cl_inputBuffer` (default 2).
  - Ticks A+1 up to the current tick are filled with neutral cmds (zero move, spawn yaw). These match the server's starved repeats, so startup causes no correction.
- **Ongoing:**
  - RTT and jitter: EWMA from a PING every second.
  - Buffer health: EWMA over 30 snapshots.
  - Below target − 1.5 for 0.5 s: fast-forward k ticks (predict and send them this frame).
  - Above target + 3 for 1 s: hold k tick periods.
  - Each adjustment counts as a clock adjustment in the netgraph.
  - The client's own accumulator also caps at 5 ticks per frame.
- On a hidden tab, release all keys.

### Prediction and reconciliation (`predictor.ts`)
- **Rings:** 128 cmds, a `PlayerStateRing` of predicted states, and `latestTick`.
- **Each tick:** sample → sanitize → store → pmove (events and debug log recorded only on first-time predictions) → store → INPUT with the last 4 cmds and the ack.
- **On snapshot A** (newer than the last one):
  - If `cvarHash` ≠ the hash of the params for tick A: adopt S_A and re-simulate, counted as a pending-params resync rather than a correction. If that persists for 1 s, send CMD `cvars` to ask for the block again.
  - Otherwise, if `predicted[A]` exists and `playerStateEquals` holds: done.
  - Otherwise it is a correction:
    1. Note the old render position.
    2. Set the state to S_A.
    3. Re-simulate A+1 up to the latest tick, with params switched by tick.
    4. Record the count, the visible distance at the latest tick, and `diffPlayerState` into a log ring of 32 (allocates, but only on corrections).
    5. Add old − new to the `RenderOffset`, or zero it if the distance is above `cl_teleportDist` (64) or the teleport flag is set.
  - If A has fallen out of the ring: hard resync.
- **CVARS:** load the values into `pendingParams` with `fromTick = effectiveTick`, then re-simulate at once from the newest snapshot. Promote when the acked snapshot reaches `effectiveTick`. A lossless link therefore sees 0 corrections from a cvar change.
- **`RenderOffset`:** linear decay to 0 over `cl_correctionSmoothMs` (100). A new offset adds to whatever remains and restarts the decay.

### Rendering and input
- **Local player:**
  - Position: `lerp(predicted[t−1], predicted[t], alpha) + renderOffset`.
  - Eye height: `VIEW_HEIGHT` for the stance, smoothed over `cl_viewHeightSmoothMs`.
  - `StepSmoother` (render-tick time): the offset cancels the interpolated rise inside the step's tick, then decays over `cl_stepSmoothMs` (150). Offsets add up, capped at 32 u.
- **Frame order:** `transport.poll` (reconcile) → apply mouse deltas to the view (immediately) → tick accumulator (sample, predict, send) → interpolate → scene → render → HUD at 10–15 Hz.
- **Mouse:**
  - `requestPointerLock({unadjustedMovement: true})`, falling back to plain pointer lock (Firefox).
  - `yaw −= dx · sensitivity · m_yaw`; `pitch += dy · sensitivity · m_pitch`, clamped to ±89. No smoothing.
  - The cmd uses `degreesToU16`. The camera uses the live float angles.
- **Buttons:** held, or pressed since the last sample, so taps shorter than a tick still register.
- **Default binds** (`KeyboardEvent.code`):

  | Key | Binding |
  |---|---|
  | KeyW / S / A / D | +forward / +back / +moveleft / +moveright |
  | Space | +jump |
  | KeyC | +crouch |
  | KeyX | +walk |
  | ShiftLeft | +sprint (inert until M4) |
  | Mouse0 | +attack (inert) |
  | Backquote | toggleconsole |

  - No Ctrl binds (Ctrl+W closes the tab).
  - Bound keys call `preventDefault`.
- **`space.ts`:**
  - `METERS_PER_UNIT = 0.0254`.
  - `toThree(x, y, z, out)` gives (x, z, −y)·k; `toThreeDir`, `toSim`.
  - `setViewAngles(cam, yawDeg, pitchDeg)`: Euler order YXZ, `rot.y = yaw − 90°`, `rot.x = −pitch`.
  - `convertVertices(f32 × 8)` converts at load time. The mapping is a proper rotation, so triangle winding is kept.
- **World:**
  - One mesh per cmap surface (already one per material).
  - Materials: `MeshLambertMaterial` with a procedural `CanvasTexture`, 256² with 16 u minor and 64 u major lines, repeat-wrapped. uv is already 1 per 64 u.
    - floor: light grey; wall: mid grey; `grey/ladder`: rung texture.
    - water: blue, opacity 0.5, double-sided, no depth write.
    - unknown: magenta.
  - Hemisphere plus directional light, no shadows; `dispose()` on unload.
  - Field of view: `cl_fov` 90 horizontal, Hor+.
- **Debug draw** (`LineSegments` with preallocated buffers):
  - `r_debugHull`: the hull box.
  - `r_debugTraces`: the `PmoveTraceLog` (green for misses, red for hits, plus a tick along the hit normal).
  - `r_debugGround`: the ground normal.
  - `cl_thirdPerson` pulls the camera back 120 u so the hull is visible.
- **HUD:**
  - Speedometer: horizontal and vertical speed, plus ground/air/water/ladder state.
  - Netgraph (`cl_netgraph`):
    - link: RTT, jitter, download loss %, snapshots/s;
    - corrections: corrections/s, mean and max correction size, current offset;
    - input: buffer health, starved/s, clock adjustments;
    - traffic: bytes in/out per second.
  - A tint overlay when the eye is under water.
- **Console:**
  - Commands: `set`, `toggle`, `reset`, `cvarlist [prefix]`, `bind <code> <cmd>`, `unbind`, `net_profile <name>`, `clear`, with quoted tokens.
  - `set` on a REPLICATED cvar is sent as CMD. The server applies it and broadcasts CVARS, which updates the client's mirror registry.
- **Autotest hooks:** `?autotest=1&bot=circle` skips pointer lock and uses `ScriptedInput`. Status goes to `document.documentElement.dataset` (state, ticks, snapshots, corrections, draw calls).

## 3. Decisions (each lands in the increment that implements it, with the doc changes)

| ID | Decision (recommended) | Doc updates |
|---|---|---|
| D-022 | **Browser determinism replay.** Vitest browser mode with `@vitest/browser-playwright` replays every `packages/shared/test/*-vectors.test.ts` unchanged. Local runs use Chromium. A CI job runs Chromium, Firefox and WebKit; WebKit runs JavaScriptCore, Safari's engine, so it stands in for Safari. `playwright` is pinned to the release that matches the installed browser build (1.56.x for chromium-1194); `CHROMIUM_PATH` overrides `executablePath` if versions drift. The dev page `vectors.html` allows a manual check in real Safari. | docs/10 §1 |
| D-023 | **pmove contract.** The signature above; `dt` is a parameter; params refresh on `registry.version`; events stay out of `PlayerState`; no new fields; hull changes only in pre-checks. **Q1:** the slide move stops only on `allSolid` (zero vz, return blocked, `DEV_ASSERT`), because a `startSolid` trace may move out of the brush and is accepted. **Q3:** bevels keep flags 0. A ground counts as slick or nodamage if the hit plane's `SURF_*` bit **or** the hit brush's `CONTENTS_SLICK`/`NODAMAGE` bit is set, since `trace.contents` keeps the brush bits across bevels. **"Crouch-blocked"** is read as: crouched and the standing hull doesn't fit, so no jump; crouch-jumping in the open is allowed. | docs/03 §4.8, §4.10, §4.11 |
| D-024 | **Ladders and water.** **Q2:** read only the `SURF_LADDER` face. Contact means a horizontal hull probe along the yaw-only forward, `pm_ladderReach` long, hits a `SURF_LADDER` plane with `dot(fwd, −n) > pm_ladderFacing`; pitch is ignored. No attach while moving away (`v·n > 16 u/s`, a design constant), which makes jump-off work. On the ground the ladder engages only when forward > 0. The ladder move applies friction and accelerates toward vertical = the forward axis and along-wall = the right axis, times runSpeed × `pm_ladderScale`, with no gravity; jump adds `n · pm_ladderJumpPush`. The greybox drops the 16 u LADDER volume and gives the flagged face the material `grey/ladder`; `compiler.version` becomes 2 and the maps are recompiled. `CONTENTS_LADDER` stays reserved. **Q4:** samples at feet + 1, feet + 28 (the middle of the standing hull) and feet + eye height (50 standing, 36 crouched), counted from the bottom. Swim at level ≥ 2. Jump and crouch add ±127 to the vertical axis. With no move or vertical input, wish z = −`pm_waterSinkSpeed`. Swim friction uses 3D speed. No water-jump (M4). | docs/03 §4.13–4.14, docs/07 §3 |
| D-025 | **Q5, test locations.** Course-based MV scenarios, feel-report, NET integration (the real Match and the real client net code), MV-19 build probes and cross-package allocation guards all go in `@game/tools`, which reads `content/maps` and depends on shared, server and client-net. shared keeps unit tests and frozen vectors (now including pmove); server keeps match unit tests. | docs/10 §1 table |
| D-026 | **Protocol v1 and transports.** The message table above, including READY, PRINT and KICK. The transport takes `Uint8Array` + length, receives by `poll()`, keeps reliable delivery ordered and lossless, and allocates one ArrayBuffer per packet only at the postMessage boundary. Decoders use the sticky flag: drop the packet and add a strike. M2 always sends full snapshots. | docs/05 §3.1–3.4, §4.2 |
| D-027 | **Replicated cvars.** Block encoding and hash; CVARS with `effectiveTick`; client params switched by tick; client `set` on a replicated cvar becomes CMD; the Worker's client is admin, and M3 decides authorization for the Node server. | docs/05 §3.5, docs/06 §6 |
| D-028 | **M2 clock and NetSim.** Clock: prediction in server-tick space, with handshake lead and step re-anchoring (smooth time dilation is NET-07, M3). NetSim semantics as in §2. docs/10 §3 is the canonical profile table; docs/05 §13 gains the reorder column (wan-150-loss2: 0.5%). | docs/05 §8, §13 |

## 4. New values to label

| Name | Default | Label | Where documented |
|---|---|---|---|
| `pm_ladderScale` | 0.5 | ESTIMATE | docs/03 new §2.3 "M2 base additions" and §4.14 |
| `pm_ladderFacing` | 0.5 | ESTIMATE | §2.3, §4.14 |
| `pm_ladderReach` | 2 u | ESTIMATE | §2.3, §4.14 |
| `pm_ladderJumpPush` | 150 u/s | ESTIMATE | §2.3, §4.14 |
| `pm_waterSinkSpeed` | 60 u/s | ESTIMATE | §2.3, §4.13 |

The client cvars below are ARCHIVE, not replicated, and go in a new docs/06 §7 table:

| Name | Default | Label / note |
|---|---|---|
| `sensitivity` | 5 | Q3 default |
| `m_yaw`, `m_pitch` | 0.022 | Q3 convention (docs/06) |
| `cl_fov` | 90 | ESTIMATE |
| `cl_inputBuffer` | 2 ticks | ESTIMATE (docs/05 §8.2) |
| `cl_correctionSmoothMs` | 100 | ESTIMATE ("~100 ms" in docs/05) |
| `cl_teleportDist` | 64 | design value (docs/05) |
| `cl_stepSmoothMs` | 150 | ESTIMATE |
| `cl_viewHeightSmoothMs` | 100 | ESTIMATE |
| `cl_netgraph`, `cl_speedometer`, `cl_thirdPerson`, `r_debug*` | off | toggles |

- **Design constants, not cvars:** water sample heights, `LADDER_DETACH_SPEED` 16, catch-up cap 5, queue horizon 64, NetSim reorder hold, re-anchor windows.
- Every `PMOVE_CVARS` row carries FACT-Q3, INFERRED or ESTIMATE plus min/max. A doc-golden test (tools `mdTable`) compares the defaults and labels with docs/03 §2.1–2.3.

## 5. Test plan

### Movement and network acceptance tests
| ID | Setup | Inputs | Pass condition |
|---|---|---|---|
| MV-01 | `runway_start`, yaw 0 | forward, 2 s | horizontal speed within 320 ± 0.5 by 0.6 s and stays there |
| MV-03 | same | walk / crouch held | 160 ± 1 / 80 ± 1; `CROUCHED` set |
| MV-04 | same | one jump tick, at dt 1/60 and dt 1/120 | apex 45.56 ± 0.5 at both rates; the two differ by ≤ 0.5; airtime 0.675 s ± 1 tick; one LAND event |
| MV-05 | `step_{16,18,19}_base`, yaw 90; `stairs_base` | forward, 1.5 s | 16 and 18: end at the top anchor's z (+ε) with one STEP event of N (±1/16). 19: z stays at 24 + ε, blocked, no STEP. Stairs: 8 STEP events of 16, end at `stairs_top` |
| MV-06 | `slope_{071,080}_base`; `slope_069_base` | forward, 4 s | 0.71 and 0.8 reach the top, grounded on the incline, no stall (speed < 200 after accelerating). 0.69: never above top − 100. A spawn traced onto the 0.69 slope with no input slides to the base, not grounded |
| MV-07 | new anchor `open_sw`, yaw 45 | forward plus a re-press of jump on each landing, 20 hops | max horizontal speed ≤ 326.4 |
| MV-08 | `open_sw` | strafe bot (best u16 yaw by exact search, no approximate Math), strafe side alternates each hop, 10 hops | speed at each landing exceeds the previous; curve logged |
| MV-17 (basic) | `water_wade` / `waist` / `deep` | none; jump; crouch; forward | levels 1/2/3. In deep water: no input → vz → −60 ± 1; jump → rises to the surface; crouch → vz < −100; forward → 160 ± 1. Report only: exit via the waist and wade sections |
| MV-18 (basic) | `ladder_base`, yaw 90 | forward at pitch −89, 0 and +89; back; yaw ±50 and ±70; jump | `ON_LADDER`; vz 160 ± 1 at every pitch; reaches `ladder_top` within 3.5 s. Back → −160. ±50 stays attached, ±70 detaches and falls. Jump → v·n ≥ 149, no re-attach |
| MV-19 | 10k-tick seeded "sticky" cmd stream on movement_lab, teleporting across anchors every 1000 ticks | — | 1) Two in-process runs give equal per-tick digests. 2) The probe bundled with esbuild (server settings) and with Vite (library mode, minified) gives the same digest in Node. 3) pmove vectors replay in Chromium, Firefox and WebKit |
| NET-03 | real Match + `ClientSim` over a lossless loopback pair, fake clock, 144 Hz frames ±1 ms; 3600-tick mixed script including out-of-range raw input | — | 0 corrections, 0 starved after startup, server state == predicted state every tick. Variants: wan-50 → 0; `set pm_gravity 400` by CMD mid-run → 0 |
| NET-04 (M2 basic; the automated proxy for "smooth at wan-150-loss2") | same harness, NetSim with a seed, 60 s strafe-jump circuit, every profile | — | lan and wan-50: 0 corrections. wan-100-loss1 and wan-150-loss2: corrections < 1/s, mean < 2 u, max render offset < 8 u, every frame-to-frame render step ≤ speed·frameDt·1.5 + 0.5 u. bad-250-loss5: converges, metrics logged. Summary line printed |
| NET-01 | codecs | seeded random messages; 1e4 random byte strings; truncations and bit flips of valid messages | exact round trip; decoders never throw and return false or in-range values |

### Other tests
- **shared, pmove units** on synthetic worlds:
  - `cmdScale` (no faster diagonals), `accelerate` cap and strafe gain, friction floor and `s < 1`, both overclip signs;
  - slide move: one wall, crease, three planes stop, `allSolid`;
  - step 18 vs 19; walkable vs steep; jumping-up ground rule;
  - edge trigger and `pm_autoHop`; stand blocked; water levels; ladder threshold;
  - half-step gravity; events;
  - a 1e4-tick random-input property: `positionTest` true every tick, no `SNAP_PREVIOUS` streaks.
- **shared, other:** bitstream widths 1–32, signed values, overflow; cvar block (exact floats, hash golden value, order-independent); NetSim statistics, FIFO, reliable ordering, seed determinism; loopback pooling; `pmove-vectors.test.ts`.
- **server:**
  - loop: 1 s = 60 ticks under uneven wakes; a 1 s stall runs 5 ticks and logs once;
  - input queue rules; handshake and version KICK; snapshot fields;
  - starved repeat with ATTACK cleared; CMD → CVARS and hash change; non-admin CMD rejected.
- **client (Node):**
  - `space.ts`: axes, inverse, scale, handedness, winding;
  - `setViewAngles` matches `angleVectors` over a yaw/pitch grid;
  - world build for movement_lab: triangle count and bounds;
  - smoothers stay continuous; console parsing and binds; sampler latching;
  - the existing build test, with the worker chunk allowed.
- **e2e smoke** (`test:browser`, local Chromium):
  1. Vite build, then programmatic `preview`.
  2. Chromium with `--use-angle=swiftshader --enable-unsafe-swiftshader`, opening `/?autotest=1&bot=circle`.
  3. Wait for `data-state=running`, then 3 s.
  4. Check: more than 120 snapshots and predicted ticks; 0 corrections; more than 30 frames; draw calls > 0; no console or page errors; the screenshot is not a single color.
  - `scripts/screenshot.ts` uses the same helper (dev server) to take screenshots for you.
- **Guards:**
  - `mv-NN` / `net-NN` files must name their describe after their ID, like `bal-NN`;
  - every M2 acceptance ID has a test;
  - a match-purity scan (no `Date`, `performance`, `Math.random`, timers);
  - `tsconfig.{net,match,worker}.json` pass the tsconfig guard.
- **Bench and allocation:**
  - `pnpm bench` adds pmove (seeded mix on movement_lab, ≤ 5 µs per player-tick, GC count) and snapshot codec (≤ 30 µs).
  - Native-ESM workloads `pmove`, `codec`, `predict` (predict plus reconcile with re-simulation) and `match` (in-process loopback): 0 GCs.
- **Scripts:**
  - `test:movement` = `vitest run -t "^MV-"`, `test:net` = `vitest run -t "^NET-"`.
  - `feel-report` = `pnpm --filter @game/tools --fail-if-no-match feel-report`.
  - New `test:browser` = `vitest run --config vitest.browser.config.ts` (`BROWSERS` env, default chromium).
  - CLAUDE.md commands table gains `test:browser`. The stub sentence keeps only bots, mapc and balance-report, and the sentence "Until M2, `pnpm dev` serves the client only" goes. The README table and its "Commands for later milestones" list change to match.
- **feel-report** prints, and writes to `reports/feel.md` with deterministic output:
  - speeds: run cap and time to it, walk/crouch, stop time and distance from 320;
  - jump: apex at 60 and 120 Hz, airtime;
  - geometry: step limit, stairs time, slope outcomes;
  - hops: straight-hop max, strafe curve;
  - water and ladder: swim and sink speed, ladder speed;
  - runway 2048 u time.

## 6. Increments
Each ends with `pnpm typecheck && pnpm lint && pnpm test` green and its doc and decision updates.

| # | Commit | Contents |
|---|---|---|
| 1 | `test: replay determinism vectors in real browsers` | Dependencies, `vitest.browser.config.ts`, `test:browser`, CI `browsers` job (`playwright install --with-deps` runs only in CI), CLAUDE.md and README rows, D-022. Also an uncommitted check that headless Chromium WebGL works with SwiftShader |
| 2 | `feat(shared): pmove params, cvars and core steps` | `registry.version`, params and `PMOVE_CVARS`, docs/03 §2.3, doc-golden test, basics, events, view-height constants |
| 3 | `feat(shared): slide, step-slide, ground trace, walk, air and jump` | pmove pipeline with snap and quantize, units, native-ESM `pmove` workload, first pmove bench, D-023 |
| 4 | `test(tools): movement scenarios MV-01..07 on the courses` | Scenario harness; greybox ladder face material, LADDER volume dropped, `open_sw`/`open_center` anchors, `compiler.version` 2, recompiled maps; real `test:movement`; mv naming guard; stub and README edits; D-025 |
| 5 | `feat(shared): crouch, water and ladder movement` | MV-08, MV-17, MV-18; feel-report; D-024 |
| 6 | `test(shared,tools): pmove determinism vectors and MV-19` | Generator, replay (browsers pick it up), build probes, guard that all acceptance IDs exist, bench numbers in docs/10 §4.4 |
| 7 | `feat(shared): bitstream, protocol v1 and the replicated cvar block` | NET-01, `codec` workload, codec bench, docs/05 tables, D-026 (codec part) |
| 8 | `feat(shared): transports and the net simulator` | Loopback, NetSim, profiles and their doc-golden test, D-026 (transport part) and D-028 (NetSim part) |
| 9 | `feat(server): environment-agnostic match loop` | Exports, `tsconfig.match.json`, queue, session, match, loop, commands, tests, purity guard, D-027 (server part) |
| 10 | `feat(client): headless prediction, reconciliation and clock sync` | `src/net` with `tsconfig.net.json` and `./net` export; tools depends on client and server; NET-03, NET-04 basic; `test:net`; net naming guard; `predict` and `match` workloads; D-027 and D-028 |
| 11 | `feat(client): Three.js greybox world, Worker server and first-person camera` | `three` and `@types/three`, `space.ts`, world, materials, camera, interpolation, smoothers, worker with `tsconfig.worker.json`, `PortTransport`, boot, scripted bot, build test, e2e smoke, screenshot script, CLAUDE.md `pnpm dev` sentence |
| 12 | `feat(client): input, console, binds, HUD and debug draw` | Pointer lock (raw), sensitivity, binds, console with CMD forwarding, `net_profile`, speedometer, netgraph, debug draw, third person, settings, tests |
| 13 | `docs: M2 review fixes, perf audit and handoff` | netcode-reviewer, movement-reviewer, perf-auditor and clean-room-auditor; roadmap status; handoff with a "Try it" section (including a manual check at `net_profile wan-150-loss2`) |

## 7. Risks

| Risk | Mitigation |
|---|---|
| Slide or step stalls on slopes and rotated walls (D-017: tangency is not exact) | MV-06 stall checks; random-input property; overclip plus same-plane nudge; fuzz over the courses |
| pmove over 5 µs (about 12 queries per tick) | Bench from increment 3. Fallbacks: reuse the stored `waterLevel` for the pre-check; skip the ladder probe when no ladder brush is in the hull's BVH neighbourhood |
| V8 boxing doubles under native ESM | Allocation workload from the first pmove commit; out-parameters; `Math.min`/`max` clamps |
| Playwright and Vitest 5 provider vs the local Chromium build | Increment 1 first; pin the version; `CHROMIUM_PATH` fallback. Firefox and WebKit are proven in CI only; the acceptance box is ticked once the PR's `browsers` job is green |
| WebKit is not Safari | Same engine (JavaScriptCore); the dev page `vectors.html` allows a manual real-Safari or iOS run; noted in D-022 |
| Headless WebGL | SwiftShader flags; the smoke test asserts the sim and network path even if WebGL is missing, and the screenshot becomes optional |
| Starvation without dilation causes corrections | 4× redundancy, buffer target 2, step re-anchoring, starved repeats keep JUMP held (so no phantom jumps); NET-04 basic on every profile; NET-07 in M3 |
| Cvar changes cause rubber-banding | Params switched by tick plus immediate re-simulation; NET-03 variant |
| Water exit and ladder-top dismount feel | MV-17 exit check; ESTIMATE cvars; water-jump is M4 |
| `-t` exits 0 when nothing matches | Naming guards plus the acceptance-ID presence guard |
| Worker, Vite and tsconfig plumbing (WebWorker lib, server exports) | One increment with the build test and e2e smoke |
| Browser input quirks (Ctrl+W, Space scrolling, Firefox lacks `unadjustedMovement`) | No Ctrl binds; `preventDefault` on bound keys; feature-detected fallback |
| Module-scope scratch is not reentrant | pmove and trace are never called from inside each other; client debug traces run outside pmove |

**Spec calls I'd like you to confirm before increment 2:**
- The four answers to the open questions (D-023 Q1 and Q3, D-024 Q2 and Q4).
- Reading "crouch-blocked" as "can't jump while crouched under a ceiling".
- `pm_ladderJumpPush` 150.
- Dropping the LADDER volume from the greybox (maps recompile, `compiler.version` 2).
- Pinning `playwright` to the installed browser build instead of 1.63.

## Critical files
- packages/shared/src/sim/pmove/pmove.ts (new; pipeline, slide/step via sibling modules)
- packages/shared/src/net/messages.ts (new; protocol v1 codecs) and packages/shared/src/net/netsim.ts (new)
- packages/server/src/match/match.ts (new; tick, queues, snapshots, CVARS)
- packages/client/src/net/predictor.ts (new; reconciliation) and packages/client/src/render/space.ts (new)
- packages/tools/test/guards/scripts.test.ts (constrains the script, stub and naming changes)