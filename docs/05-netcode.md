# 05 — Netcode Spec

> **Highest priority system.** The game is designed online-first: even offline play runs through a server (in a Web Worker) over a loopback transport, so netcode is never bolted on later.

## 0. Principles

1. **Server-authoritative.** Clients send inputs (UserCmds) only. The server simulates and decides everything: movement, hits, damage, pickups, scores.
2. **Shared deterministic simulation.** `packages/shared` runs bit-identically on client and server for the same inputs (fixed tick + end-of-tick quantization).
3. **Predict yourself, interpolate others, compensate shots.** The local player is predicted and reconciled; remote entities are interpolated; hitscan is lag-compensated.
4. **Design for datagrams, ship on WebSocket.** Every message works on an unreliable, unordered transport: sequence numbers, acks, baselines, redundancy. Switching to WebTransport datagrams is then a transport swap, not a redesign.
5. **Measure everything.** Netgraph, bots, a network simulator and budgets in CI. If it isn't measured, it isn't done.

## 1. Clocks and the 60 Hz decision

### 1.1 Why not UrT's 20 Hz?
- UrT/Q3 had **three different clocks**:
  - the client frame rate, where movement physics actually ran per client command (hence the 125-fps quirk)
  - the server frame rate (`sv_fps`)
  - the snapshot rate (default 20)
- UrT 4.3.0 raised the server default to 60, and **4.3.2 locked it back to 20**.
- 20 Hz still ships in big modern games (Apex Legends and Arc Raiders run 20 Hz). The competitive shooters run higher: CS2 at 64 with sub-tick timestamps, Valorant at 128, Marathon at 60. Respawn's own numbers: 20 Hz servers add about 5 frames of delay, 60 Hz about 3.

### 1.2 Our choice

| Constant | Value | Notes |
|---|---|---|
| `TICK_RATE` | **60 Hz** (16.67 ms) | Simulation tick on server *and* client prediction. |
| `SNAPSHOT_RATE` | 60 Hz default | Server → client. Can drop to 30 per client under bandwidth pressure. |
| `INPUT_RATE` | 60 Hz | Client → server, with redundancy (§3.4). |
| Render rate | Display refresh (60–240+) | Decoupled; interpolate between ticks. |

- **Why 60:** cuts the server-induced delay by about two-thirds vs 20 Hz. It's affordable for a Node server at ≤16 players (budget: tick p99 ≤ 4 ms, see `docs/10`). Bandwidth fits the browser budget (§9).
- **Not 128:** it doubles CPU and bandwidth for a small gain at our scale. The tick is a constant in `shared/src/time.ts`; it can be revisited, but **the movement feel must be re-tuned if it changes** (`docs/03` §1).
- **Sub-tick (later):** inputs carry an optional `fireSubtick` fraction for more precise lag-compensation rewind.

### 1.3 Client timing
- **Prediction tick rate:** the client runs it at nominally 60 Hz, adjusted by time dilation (§8.2).
- **Rendering** uses an accumulator ("fix your timestep") and draws the local player **interpolated between the last two predicted ticks** (alpha = accumulator / dt). This adds ≤ 1 tick of visual latency but is perfectly smooth at 144/240 Hz.
- **Mouse look applies every render frame** to the camera immediately, not per tick. Each tick's UserCmd samples the current view angles. Aim never waits for the tick.

## 2. Topology and sessions

- **Dedicated server:** Node process (`packages/server`) running 1..N matches; one match = one tick loop.
- **Local/offline:** the *same* server code runs in a **Web Worker** in the browser. The transport is `LoopbackTransport` (postMessage with transferable ArrayBuffers), and the net simulator can inject latency and loss even locally.
- **Connection lifecycle:**
  1. `HELLO`: protocol version, build hash, client nonce.
  2. `WELCOME`: client id, tick rate, current server tick, map id + content hash, replicated cvar block, match rules (match rules join WELCOME in a later protocol version; v1 has none, §3.6).
  3. Clock sync: 5 × `PING`/`PONG`, median RTT.
  4. The client loads the map, then sends `READY`.
  5. The client starts as a spectator; it joins a team and picks a loadout through reliable messages.
- **Timeouts:** no packet for 5 s → disconnect. Reconnect within 60 s restores the slot (later).

## 3. Protocol

### 3.1 Transport abstraction (`shared/src/net/transport.ts`)
```ts
interface Transport {
  sendUnreliable(buf: ArrayBuffer): void;   // inputs, snapshots
  sendReliable(buf: ArrayBuffer): void;     // events, chat, loadout, cvars
  onMessage(cb: (buf: ArrayBuffer, reliable: boolean) => void): void;
  close(reason?: string): void;
  stats(): TransportStats;                  // bytes, packets, rtt if known
}
```

| Implementation | Milestone | Notes |
|---|---|---|
| `LoopbackTransport` | M2 | |
| `WebSocketTransport` | M3 | Both channels over one socket. Still uses acks/baselines as if unreliable. |
| `WebTransportTransport` | M9 | Datagrams for unreliable traffic, one reliable stream. WebTransport is supported in all major browsers since Safari 26.4 (March 2026); server-side HTTP/3 tooling is less mature. |

Every transport can be wrapped by `NetSimTransport` (latency, jitter, loss, duplication, reorder, bandwidth cap).

### 3.2 Framing and versioning
- **Binary only** (`ArrayBuffer`/`DataView`), no JSON in hot paths.
- Every message starts with `u8 type`. `PROTOCOL_VERSION` (u16) is exchanged in `HELLO`; on mismatch → refuse with a clear message. HELLO's first 3 B (type, protocolVersion) are frozen across all protocol versions, so the server reads a client's version (`peekHelloVersion`) before parsing the rest and can always answer a mismatch with a `KICK`, whatever a newer HELLO adds (D-026).
- **Bit-packed** writer/reader (`BitWriter`/`BitReader`, `shared/src/net/bitstream.ts`) with explicit widths (1–32 bits), LSB-first: stream bit *i* is bit *i* & 7 of byte *i* >> 3, a value's low bit first. Both work over a preallocated `Uint8Array` and never throw: an overflow, a value its width can't carry or a short read sets a sticky error flag (D-026).
- **Decoders are bounds-checked** and return false on a short read, a wrong type byte, any value the encoder never writes, or bits left after the message (beyond the zero padding of its last byte). The receiver drops the packet and counts a strike. Encoders refuse fields out of their layout's range the same way, so a bad message is never sent.
- **One message per packet.** Unreliable packets are at most `MAX_UNRELIABLE_BYTES` = 1200 B (datagram-safe), reliable messages at most `MAX_RELIABLE_BYTES` = 16384 B (`shared/src/net/protocol.ts`).

### 3.3 Message types

| Dir | Type | Channel | Purpose | Since |
|---|---|---|---|---|
| C→S | `HELLO`, `READY` | reliable | handshake | v1 (M2) |
| C→S | `INPUT` | unreliable | UserCmds (redundant) + snapshot ack | v1 (M2) |
| C→S | `PING` | unreliable | clock/RTT | v1 (M2) |
| C→S | `CMD` | reliable | console/admin command text | v1 (M2) |
| C→S | `LOADOUT`, `TEAM`, `CHAT` | reliable | gear, team, chat | later |
| S→C | `WELCOME`, `CVARS` | reliable | session setup, replicated cvars | v1 (M2) |
| S→C | `MAP` | reliable | map change | later |
| S→C | `SNAPSHOT` | unreliable | world state for a tick | v1 (M2) |
| S→C | `PONG` | unreliable | clock/RTT reply | v1 (M2) |
| S→C | `PRINT`, `KICK` | reliable | console output; disconnect with a reason | v1 (M2) |
| S→C | `EVENTS` | reliable | kill feed, hit confirms, damage taken, round state, chat | later |

The exact v1 layouts are in §3.6.

### 3.4 UserCmd and the INPUT message
Each UserCmd (~12 bytes):
- `tick` (u32; later cmds in the same packet are delta-coded as u8)
- `buttons` (u16): attack, jump, crouch, sprint, walk, use, reload, bandage, fireMode, zoomIn, zoomReset, drop, kick-eligible…
- `forward`, `right`, `up` (i8 each)
- `yaw`, `pitch` (u16 each)
- `weaponSlot` (u8)
- `fireSubtick` (u8, optional)
- `viewInterpTick` (u32 + u8 fraction), only when attack is held; used by lag compensation (§7)

**Pinned down in M1** (D-018, `packages/shared/src/sim/usercmd.ts`; `sanitizeUserCmd` forces every received cmd into these ranges):
- `buttons` bits 0–11 are attack … drop in the order listed above; bits 12–15 are spare. "kick-eligible" is not a button for now: it reads as state derived from the player and weapon, and is decided with the kick in M4.
- `forward`, `right` and `up` are clamped to ±127 (never −128); `pitch` to ±89° (±16201 units).
- `weaponSlot` is 0–7: the knife plus the seven loadout slots of `docs/04` §9. Which index is which is decided with weapon switching.
- `tick` stays within 0…2^30 − 1.

The `INPUT` packet carries:
- `packetSeq` (u16)
- `lastSnapshotTick` (u32): **ack** for delta baselines
- the **last N = 4 UserCmds** (redundancy, so a lost packet rarely loses an input), newest first: the newest cmd's tick in full (u32), each older one as a u8 offset back from it (`tickBack`, 1–255, strictly rising, never below tick 0). Four cmds take 435 bits, 55 B, so about 3.3 KB/s up at 60 Hz (§3.6).
- Decoded cmds must already be in the ranges `sanitizeUserCmd` forces (buttons bits 12–15 clear, axes ±127, pitch ±16201, weaponSlot 0–7), or the packet is dropped; the server still sanitizes every cmd it simulates.

### 3.5 Replicated cvars
- Physics and gameplay tunables (`pm_*`, `st_*`, weapon overrides) are **server-owned**.
- They are sent on join and on change, versioned by a hash. Snapshots carry the hash; if it mismatches, the client requests a resend.
- **Prediction must use the replicated values only.**
- **The block** (D-027, `shared/src/net/cvarBlock.ts`) lists every `REPLICATED` cvar in ascending lowercase-name order, with no duplicates, so one set of values has exactly one encoding:
  - count (u10, at most 1023 entries);
  - per entry: name (u6 length + 7-bit ASCII: the registry's name grammar, at most 63 chars), kind (u2: 0 int, 1 float, 2 bool, 3 string), then the value: int as i32; float as the f64's raw IEEE-754 bits, low word first (exact, so client and server simulate with the same double; finite, never −0); bool as 1 bit; string as a u8 length + 7-bit printable ASCII.
- **The hash** is `murmur3Bytes` (`shared/src/rng/hash32.ts`) over the block encoded on its own from bit 0 and zero-padded to a whole byte, with seed `0x63766172` (the ASCII bytes "cvar", big-endian). `CVARS` carries all 32 bits and the decoder checks them against the block it read; `SNAPSHOT` carries the low 16 bits of the hash the server simulated that tick with. The hash does not depend on registration order or on any non-replicated cvar.
- **The registry keeps every block encodable:** a `REPLICATED` cvar's name is at most 63 chars (registration throws otherwise), and a `REPLICATED` string's value is printable 7-bit ASCII of at most 255 chars (registration throws; `set` and `setFromString` refuse it with a `type` error). So a console or admin value can never make WELCOME or CVARS unencodable or turn the snapshot hash into a sentinel.
- **Applying a block** to the client's mirror registry is all or nothing: it must name exactly the registry's `REPLICATED` cvars, spelled as registered, with their types and with values inside their min/max (a clamped value would mispredict). Unknown names, non-replicated cvars, a missing cvar, wrong kinds and out-of-range values reject the whole block and change nothing. The server already applied its CHEAT and LATCH rules to what it sends, so the mirror stores CHEAT and LATCH values as sent (`CvarRegistry.setReplicated`), whatever its own cheat setting, and drops any pending latched value. After a successful apply the mirror's hash equals the block's.
- **`CVARS`** carries `effectiveTick`, the first tick simulated with the new values, so the client switches its prediction parameters at that tick (D-027; the switch lands with the match loop and the predictor, M2 increments 9–10).

### 3.6 Protocol v1 layout (`PROTOCOL_VERSION` = 1, D-026)

Every message starts with the `u8` type: 1 `HELLO`, 2 `WELCOME`, 3 `READY`, 4 `INPUT`, 5 `SNAPSHOT`, 6 `PING`, 7 `PONG`, 8 `CVARS`, 9 `CMD`, 10 `PRINT`, 11 `KICK` (0 is never a message). Fields follow in this order, LSB-first, and the last byte is zero-padded. Ticks are written in 32 bits but must be ≤ `TICK_MAX` (2^30 − 1). "short ASCII" is a u6 length + 7 bits per printable char (0x20–0x7e, at most 63); "text" is a u10 length + 8 bits per Latin-1 char (printable, plus tab and newline; at most 1023).

| Msg | Channel | Fields after the type byte (bits) | Size |
|---|---|---|---|
| `HELLO` C→S | reliable | protocolVersion 16 (with the type byte, frozen for every version, §3.2), buildHash (short ASCII), nonce 32 | ≤ 63 B |
| `WELCOME` S→C | reliable | protocolVersion 16, clientId 8, tickRate 8 (1–255), serverTick 32, mapName (short ASCII), mapHash lo 32 + hi 32 (the cmap `contentHash`), cvar block (§3.5) | ≈ 0.5 KB with the M2 cvars |
| `READY` C→S | reliable | none | 1 B |
| `INPUT` C→S | unreliable | packetSeq 16, lastSnapshotTick 32, count 3 (1–4), newestTick 32; per cmd, newest first: tickBack 8 (not for the first cmd), buttons 16, forward 8, right 8, up 8 (i8 each, ±127), yaw 16, pitch 16 (±16201), weaponSlot 8 (0–7) | 55 B for 4 cmds |
| `SNAPSHOT` S→C | unreliable | serverTick 32, baselineTick 32 (0 = full; must be 0 in M2), lastProcessedCmdTick 32, inputBufferHealth i8, cvarHash 16, flags 8 (bit 0 starved, bit 1 teleport; the rest must be 0), then the player state below | 335 bits, 42 B |
| `PING` C→S | unreliable | pingId 16 | 3 B |
| `PONG` S→C | unreliable | pingId 16, serverTick 32 | 7 B |
| `CVARS` S→C | reliable | effectiveTick 32, blockHash 32, cvar block (§3.5) | ≈ 0.5 KB |
| `CMD` C→S | reliable | text | ≤ 1026 B |
| `PRINT` S→C | reliable | level 2 (0 info, 1 warn, 2 error; 3 is refused), text | ≤ 1026 B |
| `KICK` S→C | reliable | reason (text) | ≤ 1026 B |

**Player state** (`shared/src/net/playerStateCodec.ts`, 199 bits), in the units of end-of-tick quantization (§4.1), so a quantized state encodes exactly and decodes to the same bits:

| Field | Bits | Encoding and decode check |
|---|---|---|
| origin x, y, z | 3 × 21 | signed, 1/32 u; within ±524288 (±16384 u) |
| velocity x, y, z | 3 × 20 | signed, 1/16 u/s; within ±524287 (−2^19 is refused) |
| viewYaw | 16 | u16 angle units |
| viewPitch | 16 | u16 angle units; within ±16201 (±89°) |
| flags | 10 | `PMF_*` bits |
| groundEntity + 1 | 16 | 0 (`ENTITY_NONE`) … 32768 (`ENTITY_WORLD`); above is refused |
| waterLevel | 2 | 0–3 |
| stamina | 16 | hundredths |

INPUT, SNAPSHOT, PING and PONG encode and decode without allocating, refused packets included: decoders read a tick as two u16 halves and reject it past `TICK_MAX` before it becomes a number V8 would box. The text and cvar-block fields of the reliable messages allocate (rare). A decoder that accepts a packet re-encodes it to the same bytes (NET-01).

## 4. State encoding and quantization

### 4.1 End-of-tick quantization (both sides, every tick)
| Quantity | Quantum | Storage |
|---|---|---|
| Origin | 1/32 u (nearest clear grid point, D-017) | i21 per axis on the wire (±2^19 units, §3.6); clamped to ±16384 u |
| Velocity | 1/16 u/s | i20 per axis; clamped to ±(2^19 − 1)/16 = ±32767.9375 u/s |
| Angles | 360/65536° | u16; pitch is only masked, so whatever sets it must keep it within ±16201 (pmove copies the sanitized cmd pitch; a spawn or teleport clamps with `clampPitchU16`), or the codec refuses the state |
| Stamina | 0.01 | u16 |
| Timers | 1 ms or ticks | u16 |

Because both client and server quantize identically, a correctly predicted state equals the authoritative one **bit for bit**. Mismatch detection is exact.

The origin is not simply rounded: pmove snaps it to the nearest clear 1/32 u grid point (`snapOrigin`, D-017), because plain rounding drifts a player sliding along a slope or angled wall into solid. The snap is deterministic and tests world brushes only, so it predicts like everything else. The codec still sends the plain 1/32 u value.

### 4.2 Snapshot layout
- **Header:**
  - `serverTick` (u32), `baselineTick` (u32; 0 = full)
  - `lastProcessedCmdTick` (u32, for this client)
  - `inputBufferHealth` (i8, §8.2)
  - `cvarHash` (u16)
  - `flags` (u8: starved, teleport)
- **M2 (v1) sends only this header and the local player's full movement state** (the §3.6 layout). The local player block below, the combat state, the entity list and delta coding join with M3 and later, with a protocol version bump.
- **Local player block:** the full authoritative `PlayerState` (`docs/03` §6) plus the combat state (ammo, weapon state, zoom, bleeding, wounds), delta-coded against the baseline.
- **Entities:** count, then per entity:
  - `id` (u16), `removed` bit
  - field bitmask
  - changed fields only (delta vs. the client's acked baseline; full state if the entity is new to that client)
- **Entity kinds:** players (`origin`, `vel`, `yaw`/`pitch`, `stance` flags, `weapon`, `animation` params, team, `eventSeq` + last 2 events), projectiles, dropped items, flags/objectives.

### 4.3 Delta compression
- The server keeps the last 64 snapshots per client. The baseline is the newest snapshot the client acked (`lastSnapshotTick`).
- If the baseline is too old or missing → send full. The client keeps received snapshots for 64 ticks to resolve baselines.
- **Size target** ≤ 1100 bytes (datagram-safe). If over budget, defer low-priority entities to the next tick (priority accumulator: distance, visibility, time since last update).

## 5. Client prediction and reconciliation

1. **Each client tick:**
   - sample input → UserCmd → `sanitizeUserCmd` (§3.4)
   - store `cmds[tick]`
   - run shared `pmove` + `weaponPredict` from the current predicted state
   - store `predicted[tick]`
   - send `INPUT`
2. **Predicted locally:** movement (all `docs/03` mechanics), stamina, weapon timing, ammo, fire-mode, zoom, recoil/spread (deterministic RNG), reload/bandage timers, muzzle flash/tracer/impact-on-world visuals.
   **Not predicted:** damage to others, hit markers (server-confirmed), pickups (shown as pending), deaths.
3. **On snapshot** (ack `A`, authoritative state `S_A`):
   - Compare `S_A` with `predicted[A]`. If equal → done.
   - If different:
     - set state = `S_A`
     - re-simulate `cmds[A+1 … now]`
     - overwrite `predicted[]`
     - record a **correction** (count, distance)
4. **Visual smoothing:**
   - Keep the *simulation* state exact.
   - Apply a decaying **render offset** (old render pos − new render pos), decaying to 0 over ~100 ms.
   - Teleports (> 64 u) snap instantly.
5. **Target:** zero corrections during steady play on a lossless link (`docs/03` MV-20). Corrections on lossy links must be rare and small.

The client predicts with, stores and sends the sanitized cmd. The server sanitizes every cmd it receives anyway, and sanitizing is idempotent, so both sides simulate the same cmd even when the sampler produces an out-of-range value (a −128 axis, pitch past ±89°, a spare button bit). M2's parity tests include such input.

## 6. Remote entity interpolation

- **Render time:** `renderTick = estimatedServerTick − interpDelay`.
- **`interpDelay`** is auto-sized:
  - `2 × snapshotInterval + jitter(p95)`, rounded up to whole ticks
  - min 2 ticks (33 ms), max 6 ticks (100 ms)
  - shown in the netgraph
- **Interpolation:**
  - Positions are interpolated linearly between the bracketing snapshots.
  - Angles use shortest-arc interpolation.
  - Stance and animation parameters blend.
- **Missing future snapshot:** extrapolate ≤ 2 ticks using velocity, then hold. Never extrapolate through walls (clamp with a cheap trace, or skip).
- **Animation** is driven from interpolated state only. The renderer never reads raw server state.

## 7. Lag compensation and hit registration

- **History:** for every player, every tick, the server stores the inputs to the hitbox pose function: origin, stance flags, yaw, pitch, limb phase. Keep 1 s (60 ticks).
- **On a fire command at tick `T`:**
  1. Shooter eye = shooter's authoritative state at `T` (the server processes `T` in order) + view height.
  2. `rewindTick = clamp(cmd.viewInterpTick, T − maxRewind, T)` with `sv_maxRewindMs` = 200 (cvar).
     - Validate against the client's measured RTT + interp delay (± tolerance). Reject or clamp suspicious values to block backtracking cheats.
  3. Reconstruct the target poses at `rewindTick` (interpolate between history ticks).
  4. Raycast vs. world (current geometry) and the rewound hitboxes.
  5. Resolve zone per `docs/04` §10, apply damage **at the current tick**, emit events.
- **Shotgun:** each pellet is its own ray with deterministic spread (same RNG as the client).
- **Beyond `maxRewind`:** the shooter must lead the target (documented trade-off).
- **"Favor the shooter" within the cap.** Victims may occasionally be hit just after reaching cover. Keep `maxRewind` modest.
- **Melee and kicks:** same rewind, short range.

## 8. Server loop, input buffering, clock sync

### 8.1 Server tick (fixed order, deterministic by client id)
1. Drain decoded packets into per-client input queues (keyed by tick; discard duplicates and too-old cmds).
2. For each client, pop the cmd for this tick. If missing, **repeat the last cmd** with attack cleared and mark it "starved" (count it).
3. Run `pmove` for each player.
4. Weapons/fire (with lag comp), then projectiles, then triggers, then game rules (bleeding, healing, rounds, scoring).
5. Record the lag-comp history.
6. Build and send snapshots (relevance, delta, priority).
7. Record metrics (tick time, bytes, starvation).

The loop is driven by a monotonic clock (`process.hrtime.bigint()`) with an accumulator. **Never `setInterval`.** Catch-up is capped at 5 ticks; beyond that, log and skip.

### 8.2 Input buffer and time dilation (keeps inputs arriving "just in time")
- The server reports `inputBufferHealth` = (newest cmd tick received − tick being simulated) to each client. Target: 1–2 ticks, adaptive to jitter.
- The client gently speeds up or slows down its prediction tick (±3% max) to converge on the target. This avoids both starvation (lost inputs) and excess latency.

### 8.3 Clock sync
- Initial: 5 ping samples during the handshake, median RTT → estimate the server tick.
- Ongoing: an EWMA of RTT from `PING`/`PONG` every second. Snapshot `serverTick` re-anchors the estimate.

## 9. Relevance, visibility culling and bandwidth

### 9.1 Visibility culling (anti-wallhack; essential in browsers)
**v1 relevance test** (per client, per enemy):
- **Always send:** teammates, entities within `sv_leakRadius` (≈256 u), and anything visible via a coarse line-of-sight test. Rays go from the viewer's eye to the target's head, chest and feet, with padding and velocity prediction (~100 ms ahead) so peekers appear on time.
- **Hysteresis:** keep sending for 250 ms after losing LOS.
- **Not visible** → don't send the position. Footsteps and gunshots are sent as **audio events** with coarse, quantized positions (64 u) and only within hearing range.

**v2 (after M5):** the map compiler precomputes cluster visibility (PVS-like) for a cheap first pass, then the LOS test.

### 9.2 Bandwidth budgets (16 players, 60 Hz; verify with bots)
| Direction | Budget | Typical |
|---|---|---|
| Client → server | ≤ 8 KB/s | 4 cmds × 12 B × 60/s + headers ≈ 3.5–4 KB/s |
| Server → client | ≤ 32 KB/s | ≈ 300–600 B/snapshot × 60 ≈ 18–36 KB/s → **delta + relevance must keep it ≤ 32** |

**Degrade gracefully:** if a client's measured throughput can't keep up, halve that client's snapshot rate (30 Hz) before dropping entities.

## 10. Events and reliability

**Entity events** (sounds, muzzle flashes, footsteps, jumps, wall kicks, grabs):
- Encode as an `eventSeq` counter plus the last 2 events inside the entity state.
- Clients detect new events by sequence, so a lost snapshot doesn't lose the event if the next one arrives.

**Reliable events** go in `EVENTS`: kill feed, hit confirmations (attacker), damage taken with zone and source direction (victim), bleeding start/stop, round/match state, chat, loadout applied.

**Hit confirmations**
- Server-authoritative. The attacker gets the hit sound and hit message ~RTT after firing.
- The client may show **predicted** tracers, muzzle flash and world impacts immediately, but never predicted player hits.

## 11. Projectiles (grenades, launcher, thrown knives)

- **Server:** projectiles are server entities, simulated in shared code (deterministic bounce/fuse).
- **Thrower's client:** spawns a **predicted** projectile immediately (id = shooterId + cmd tick), then swaps to the authoritative one when it appears.
- **Mismatch:** fade the predicted one out, show the authoritative one.
- **Remote projectiles:** interpolated like players.
- **Explosions:** server events; the client plays effects at the authoritative position.

## 12. Security and validation (never trust the client)

**Decoding**
- Strict bounds-checked decoding and max message sizes.
- Rate limit: ≤ 2 × `INPUT_RATE` packets/s. Excess is dropped and counted as strikes.

**Input validation**
- Clamp move axes and angles.
- Ignore impossible button combos.
- Validate loadouts server-side (`docs/04` §9).
- Validate `viewInterpTick` (§7).

**Authority**
- One cmd per tick per client is consumed, so speed hacks can't move faster than the tick.
- The server never accepts client positions, hits or damage.
- Strike system: escalate warn → kick → temporary ban (later with accounts).

**Visibility** culling (§9.1) is the primary defense against information cheats.

## 13. Tooling (build early, use daily)

**Network simulator profiles** (`net_profile`, both client and server side):

| Profile | Delay (one-way) | Jitter | Loss | Other |
|---|---|---|---|---|
| `lan` | 0 ms | 0 | 0 | |
| `wan-50` | 25 ms | ±3 ms | 0 | |
| `wan-100-loss1` | 50 ms | ±8 ms | 1% | |
| `wan-150-loss2` | 75 ms | ±15 ms | 2% | |
| `bad-250-loss5` | 125 ms | ±40 ms | 5% | 1% duplication, 1% reorder |

**Netgraph overlay** (toggle `cl_netgraph 1`): RTT, jitter, loss %, snapshots/s, interp delay, input buffer health, corrections/s and average size, bytes in/out per second, server tick time (from server stats), starved cmds.

**Headless bots** (`packages/tools/bots`): Node clients over the real transport, with scripted behaviors (strafe-jump circuits, wall-jump routes, firing at visible targets). They are used for load tests and NET tests.

**Demos/replays:** record the server snapshot stream + events per spectator view (`.demo` binary). A client player replays them, also used later for killcams and ghost runs. Client debug captures (cmds + received snapshots) reproduce prediction bugs offline.

## 14. Tests (`pnpm test:net`)

| ID | Test |
|---|---|
| NET-01 | Codec round-trip for all messages; fuzzed random bytes never crash decoders. |
| NET-02 | Delta compression correctness across random state sequences, lost baselines and forced full resyncs. |
| NET-03 | Prediction parity: scripted session over lossless loopback → 0 corrections. |
| NET-04 | Reconciliation under `wan-150-loss2`: corrections rare (< 1/s while strafe-jumping), mean correction < 2 u, no visible rubber-banding (render-offset max < 8 u). |
| NET-05 | Interpolation: remote player render paths are continuous under jitter (no frame-to-frame jump > speed × frame time × 1.5). |
| NET-06 | Lag comp: bot shooter at 150 ms RTT tracking a strafing target hits ≥ 99% of scripted on-screen-aimed shots; shots older than `maxRewind` are not compensated. |
| NET-07 | Time dilation: input buffer re-converges within 2 s after an RTT step from 50 → 150 ms. |
| NET-08 | Bandwidth: 16 bots on the lab map, average down ≤ 32 KB/s per client, up ≤ 8 KB/s. |
| NET-09 | Server perf: tick p99 ≤ 4 ms with 16 bots; no GC pause > 8 ms (`--trace-gc` sampling). |
| NET-10 | Abuse: malformed/oversized packets, input floods, angle spam → server healthy, offender kicked. |
| NET-11 | Relevance: enemies fully behind solid geometry beyond the leak radius are never sent; audio events coarse. |
| NET-12 | Late join and reconnect: full state sync; no desync after 5 minutes of bot play. |

## 15. Reading list (concepts, not code to copy)

- Gabriel Gambetta, "Fast-Paced Multiplayer" (prediction, reconciliation, interpolation, lag compensation): https://www.gabrielgambetta.com/client-server-game-architecture.html
- Glenn Fiedler / Gaffer On Games: "Fix Your Timestep!", "Snapshot Interpolation", "Snapshot Compression": https://gafferongames.com/
- Valve Developer Community, "Source Multiplayer Networking": https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking
- Fabien Sanglard, "Quake 3 Source Code Review: Network Model" (architecture overview only): https://fabiensanglard.net/quake3/network.php
- Tim Ford, GDC 2017, "Overwatch Gameplay Architecture and Netcode" (input buffering, time dilation)
- Riot Games tech blog, "Peeking into VALORANT's Netcode"
- Edgegap, tick-rate economics: https://edgegap.com/blog/game-server-tick-rate-explained-gameplay-precision-vs-infrastructure-cost
