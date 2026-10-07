# M3 design: real networking (Node server, WebSocket, protocol v2 deltas with a byte-budget scheduler, interpolation, dilation, bots, demos, several matches per process)

> **Status:** this is the design record for M3. It was written before any code so that citations like "M3 design §2.4" in code, tests and `docs/11` resolve. It is not a spec. Where it differs from `docs/03`–`docs/10` or the decision log, those win, and the approved plan (`docs/design/M3-plan.md`) wins over this record.
>
> **How it was made.** Two designs were merged (risk-first and vertical-slice). A netcode critic and a perf/spec critic reviewed the merge. After Mustafa answered the open questions, a final critic reviewed the revision. Every finding was folded in or rejected with a reason. The order proves the risky parts early (the real WebSocket path, the multi-client harness, a load baseline, delta correctness) and gets Mustafa playing early: increment 2 gives a browser tab on a Node server, increment 5 two tabs that see each other, increment 7 smooth remotes and bots, increment 10 a full 64-player server.
>
> **Mustafa's answers (binding):** (1) dilation stays the asymmetric hybrid (D-039); (2) "Cap 64, default 32": `MATCH_MAX_CLIENTS` stays 64 and `sv_maxClients` defaults to 32, so a byte-budget scheduler (D-046) keeps every snapshot ≤ 1100 B when the worst case no longer fits; (3) the headless Chromium stand-in closes the 16 + 1 check; (4) the extras stay in M3: `pnpm demo-info`, several matches per process (D-047) and key cycling in demo playback, beside the stdin console, `/status`, `follow <id>` and the primer coverage check; (5) auto-merge is enabled on the repository.
>
> Decisions D-029–D-047 go into `docs/11` in the increment that implements each one. Each increment edits only the doc text its code makes true (golden rule 6). The close-out PR to main is opened with auto-merge on (merge method: merge commit), so it merges once CI is green.

## 0. Facts the plan relies on (main at 01d33f7; checked against the code)

### Server and match
- **The server entry is a placeholder.** `packages/server/src/main.ts` and `startup.ts` only log `server ok t=…ms` (the regex in `server/test/smoke.test.ts`) and keep the process alive.
- **The match is environment-agnostic.** `src/match/**` sits behind `LoopHost {now, schedule, log}` (D-027). `tsconfig.match.json` and `match-purity.test.ts` enforce it: no `Date`, `performance`, timers, `process`, `globalThis`, `require`, `import(`; imports only from `@game/shared` and `./`; `index.ts` re-exports only `./match/*`; `server/package.json` `exports` is pinned to `{".": "./src/index.ts"}`.
- **What `Match` does today:**
  - `MATCH_MAX_CLIENTS = 64` (`match.ts:85`; ids 0…63 fit WELCOME's u8). `connect()` assigns the lowest free id (`freeClientId`, `match.ts:119-126`) at socket open and KICKs "server full" when none is free;
  - every player spawns at the first `info_player_start` (`match.ts:206`);
  - `sendSnapshot` sends only the receiver's own state with `baselineTick = 0`, and `lastProcessedCmdTick = serverTick` always (`match.ts:503`);
  - INPUT's `lastSnapshotTick` and `packetSeq` are ignored;
  - a starved tick repeats `lastCmd` (attack cleared) with no limit (`match.ts:441-448`);
  - strikes are only counted; no timeouts, rate limit, teams, entity store, EVENTS, byte or tick metrics;
  - `pmove(..., null, null)` collects no events.
- **The loop drops ticks after a stall:** `MAX_CATCHUP_TICKS = 5` (`loop.ts:9`); past that the rest is dropped, counted in `stats.dropped` and logged as a warning (`loop.ts:121-133`).
- **No client code reads `lastProcessedCmdTick`** (only `messages.ts`, `match.ts:503` and the codec bench). The predictor's ack is the snapshot's `serverTick`, because a cmd's tick equals the server tick (D-027).
- **`LoopStats.busyMs` is measured per wake** (up to 5 ticks): no per-tick percentiles today.

### Protocol and transports
- **Protocol v1:** SNAPSHOT is 42 B = 335 bits: a 136-bit header **including the type byte** plus the 199-bit `PlayerState`. The decoder refuses `baselineTick ≠ 0`. INPUT is 55 B. Ticks are read as two u16 halves. Decoders return false and the receiver strikes. `MSG_KICK` = 11 is the highest type. The INPUT decoder already refuses button bits outside `BUTTON_MASK` (`messages.ts:84`). `tools/test/docs/protocol-docs.test.ts` pins `docs/05` §3.6.
- **`docs/05` §4.2** gives entity ids as u16. **§4.3** already asks the server, when a snapshot is over the 1100 B target, to "defer low-priority entities to the next tick (priority accumulator: distance, visibility, time since last update)". **§9.2** sets the bandwidth budgets for 16 players.
- **`Transport` (D-026):** bytes plus a length; `poll()` delivery; unreliable receive queues capped at `MAX_QUEUED_UNRELIABLE` = 256; one allocation per packet only at a postMessage boundary; both ends strike a message on the wrong channel.
- **`ws@8.22.0` is in the lockfile** only as a transitive dev dependency. From its source: `WebSocket#setSocket` calls `socket.setNoDelay()` (websocket.js:261); `WebSocketServer` defaults to `perMessageDeflate: false`; and it throws unless exactly one of `port`, `server`, `noServer` is given (websocket-server.js:92-97).
- **Node 22.22 (here) and Node 24 (CI) have a global `WebSocket` client**, so bots need no dependency.
- **The client net purity guard** (`tsconfig.net.json`, `client-net-purity.test.ts`) forbids timers, `performance`, `globalThis` and the DOM in `client/src/net`. A socket there must be structural, like `PortLike`.

### Client
- **`ClientSimOptions.cmap` is required**, and WELCOME refuses another map. `boot.ts` hard-codes `movement_lab` and the Worker.
- **The prediction accumulator advances by real dt** (`t[ACC] += t[DT]`). The D-028 step clock fast-forwards up to 5 ticks and holds up to 30. `MAX_TICKS_PER_FRAME` 5, `HITCH_FRAME_MS` 100.
- **The anchor fill sends one INPUT per filled tick**, up to the lead (≤ 64), in one frame (`clientSim.ts:522–526`).
- **The ack field is wrong for deltas:** `sendInput` acks `predictor.snapshotTick`, the newest snapshot, not necessarily a stored baseline.
- **`Predictor.onSnapshot`** counts any state mismatch as `SNAPSHOT_CORRECTED` (`predictor.ts:280-321`).
- **`CvarRegistry.setAllowCheats(false)`** resets every CHEAT cvar, whatever its other flags (`registry.ts:147-158`). No cvar is REPLICATED and CHEAT today.
- **The view-frame allocation guard runs with `renderer: null`** (`client/test/perf/viewFrameAllocation.ts:97`).
- **Key binds** (`console/binds.ts`): `DEFAULT_BINDS` uses KeyW/S/A/D, Space, KeyC, KeyX, ShiftLeft, Mouse0 and Backquote; `BracketLeft`/`BracketRight` are free.

### Maps, hull, flags
- **`arena_greybox`** (hash 990efb80e478cd6c): 16 `info_player_start` across the yard; 8 `info_spawn_red` and 8 `info_spawn_blue` inside the bases behind 96 × 128 u doors; a south ledge 96 u up reached by 6 steps of 16 u (`arena_greybox.ts:38,128-132`); no water, no ladder. **`movement_lab`** has one `info_player_start`.
- **Hull** (`sim/hull.ts`): mins (−15, −15, −24); maxs z 32 standing, 16 crouched. A capsule of radius 15 u is 56 u tall standing, 40 u crouched.
- **`PMF_*` bits:** 0 GROUNDED, 1 CROUCHED, 2 SLIDING, 3 CLIMBING, 4 ON_LADDER, 5 JUMP_HELD, 6 CROUCH_PRESSED_IN_AIR, 7 LEGS_BROKEN, 8 LEG_WOUND, 9 IN_WATER.
- **Players are not solid to each other until M4** (`docs/03` §5.9): overlapping spawns are harmless in M3.
- **Shared has the primer-world builders:** `boxPlanes`, `wedgePlanes`, `rotatedBoxPlanes`, `buildBrush`, `createCollisionWorld`, `SURF_LADDER`, `CONTENTS_WATER`.
- **`docs/01` O-8** is "Proposed: 16 max; 5v5 for round modes". Mustafa decided the M3 player cap: 64 slots, default 32 (D-034).

### Guards, tests, CI
- **Root `vitest.config.ts`**: `projects: ["packages/*"]`, no per-package config: every `*.test.ts` under a package runs in `pnpm test`.
- **The acceptance-ids guard** scans `/test/.*\.test\.ts` for a top-level `describe("<ID>…")`; `MILESTONES` has only M2.
- **`scripts.test.ts` pins:** the stubs (`bots` M3), the CLAUDE.md "Until their milestone…" sentence and README line 49; `test:net` = `vitest run -t "^NET-" --silent=false`; the `net-NN-*.test.ts` naming.
- **Other guards M3 trips:** `licenses.test.ts`; `client-cvars-docs.test.ts`; `console-docs.test.ts`; the D-027 golden block hash `0x11df56b6`.
- **The native-ESM allocation child** warms up once, then retries up to 3 times in the same process (`nativeEsmAllocation.ts:961-976`); the match rig warms up 1.6e5 ticks; each `it` has a 30 s timeout; children run 2 at a time.
- **Test time (measured):** `pnpm test` 40.5 s wall, 110 s user + 11.5 s sys on 4 vCPU (CPU-bound, about 3 cores busy). `pnpm test:net` 16 s (89 tests). Native-ESM children sum to about 41 CPU-s; the match child alone 5.0 s. One simulated client-minute costs 60–140 ms.
- **M2 baselines:** 16-client in-process match tick p50 42 µs, p99 115 µs, 0 GCs, 17 MB heap; codec 0.73 µs per 42 B snapshot; pmove 2.2 µs per player-tick.
- **CI:** Node 24 (`.nvmrc`), jobs `check` (typecheck, lint, test, build) and `browsers`. The repository is public, so `ubuntu-latest` is a standard 4-vCPU runner. `/reports/` is git-ignored. Auto-merge is enabled on the repository.

## 1. Package layout

The dependency graph is unchanged: shared ← server ← client ← tools; tools also reads the client's `./net`. New export points:
- **server `"./node"` → `src/node/index.ts`:** the Node host, server, match set and listener, for in-process tools tests. `match-purity.test.ts` allows exactly this second entry; `src/match/**` stays pure.
- **client `./net` gains** the WebSocket transport, the snapshot store, the remote interpolator and the demo player, all DOM-free.

### shared (`packages/shared/src`)
| File | Change |
|---|---|
| `net/protocol.ts` | `PROTOCOL_VERSION = 2`; `MSG_EVENTS = 12`; `MSG_CHANNEL` (type → 1 reliable / 0 unreliable / −1 unknown); `SNAPSHOT_HISTORY = 64`; `MAX_SNAPSHOT_BYTES = 1100` (`SNAP_BUDGET_BITS` = 8800); `MAX_SPECTATOR_SNAPSHOT_BYTES = 2048` (demo files only, never on a socket); `MAX_UNRELIABLE_BYTES = 1200`; `MAX_CLIENT_MESSAGE_BYTES = 2048`; `SNAP_FLAG_SPECTATOR = 1 << 2` (bit 1, v1's TELEPORT, retired, must be 0); `SNAP_FLAG_DEFERRED = 1 << 3` (inc. 10); `EV_*`, `EVK_*`; class widths |
| `sim/entity.ts` | `MATCH_MAX_CLIENTS = 64` (moved from `match.ts`, value unchanged; the server re-exports it); `TEAM_NONE/1/2`; `ENTITY_FLAG_MASK` (all `PMF_*` except JUMP_HELD and CROUCH_PRESSED_IN_AIR) |
| `net/worldFrame.ts` (new) | `WorldFrame` (struct of typed arrays sized 64, integer wire units, per-slot `stamp`, presence and pending masks, §2.2); `FrameRing(64)` indexed `tick & 63` with stored ticks; `playerStateToSlot`, `slotToPlayerState` (exact), `copySlot`, `entityEquals`, `frameDigest` (§2.2) |
| `net/snapshot.ts` (new) | `SnapshotHeader`; `EntitySource` (read-only slot view: present, pending, stamp, entity fields; implemented by `WorldFrame` and by the server's `MirrorView`); `encodeSnapshot(w, hdr, cur, base \| null, selfId)`; `decodeSnapshotHeader(r, out)`; `decodeSnapshotBody(r, hdr, base \| null, selfId, out)`; class-coded diff helpers; exact size functions `localBlockBits`, `entityRecordBits` (no writing); budget constants and their static checks (§2.3) |
| `net/events.ts` (new, inc. 15) | `EventsMsg` (pooled `EventRecord[63]`), `encodeEvents`/`decodeEvents` |
| `net/messages.ts` | v1 `SnapshotMsg` and its codec removed; every other layout kept (version reads 2) |
| `net/playerStateCodec.ts` | Unchanged; the full local block |
| `sim/pmove/primer.ts` (new) | `buildPrimerWorld()` (cached), `PRIMER_SCRIPT`, `primePmove(params, ticks)`, `primePmoveOnce(params)` (§2.11) |
| `cvars/serverReplicated.ts` (new) | `registerServerReplicatedCvars(reg)`: replicated `sv_cheats`; server, Worker and client mirror register the same set |
| `cvars/registry.ts` | Registration asserts no cvar is both REPLICATED and CHEAT (D-042) |

### server (`packages/server/src`)
| Path | Responsibility |
|---|---|
| `match/match.ts` | 64 slots and `sv_maxClients` (default 32; ids assigned lowest-free below the effective cap); spawn rotation, team balance; per-session `PmoveEvents`; world-history capture; v2 snapshot build per client (worst-case check, then the scheduler only when needed); EVENTS; strikes, buckets, timeouts, starved-cmd neutralisation; rcon gate hook; demo sink hook; `reportTickStats`; primer at construction |
| `match/session.ts` | Adds `ackTick`, `sentTicks: Int32Array(64)`, `team`, `serial`, `teleportSeq`, `events` + event history (eventSeq, 2 slots), `starvedRun`, `unreliableTokens`, `reliableTokens`, `strikeScore`, `warned`, `lastPacketTick`, `connectTick`, `bytesIn/Out`, `fullSnapshots`, `inputLoss`, EVENTS outbox; scheduler state `lastSent: Int32Array(64)`, `lastDeferred: Int32Array(64)`, `plain: Uint8Array(64)` per sent tick, and an optional `ClientMirror` (inc. 10). `admin` becomes mutable |
| `match/history.ts` (new) | `WorldHistory`: one `FrameRing(64)` captured at the end of each tick, shared by all clients |
| `match/mirror.ts` (new, inc. 10) | `ClientMirror`: per sent tick, what that client's frame holds (§2.3); `MirrorView implements EntitySource` over `WorldHistory` + mirror (or plain frames when the session has no mirror); `MirrorPool` per match, filled only when the match's effective `sv_maxClients` > 37 |
| `match/scheduler.ts` (new, inc. 10) | `SnapshotScheduler`: pure, allocation-free selection of the entities a snapshot carries within `SNAP_BUDGET_BITS` (§2.3) |
| `match/spawns.ts` (new) | `SpawnRotation` (origins raised to rest height at construction; deterministic round-robin) and `assignTeam` |
| `match/limits.ts` (new) | `TokenBucket` (fixed-point ints, refilled per tick), `StrikeScore` (weights, decay, warn, kick) |
| `match/tickStats.ts` (new) | `TickHistogram`: pure; 2048 × 10 µs + overflow + exact max; 1 s window and run window (resettable); p50/p95/p99 without allocating |
| `match/demo.ts` (new) | `DemoSink` interface and the pure spectator recorder (§2.12) |
| `match/commands.ts` | `rcon` (§2.10), `status`, `kick <id> [reason]`, `record [name]`/`stoprecord`, `metrics reset` (match-scoped) |
| `node/index.ts` | Exports `startServer`, `createNodeHost`, `listen`, `MatchSet` |
| `node/main.ts` | Process entry (replaces `src/main.ts`, `startup.ts`): config → maps → matches → listener → loop; signals |
| `node/host.ts` | `performance.now` + `setTimeout(Math.ceil(ms))`; a `Tickable` wrapper that times each `match.tick()` into that match's `TickHistogram` and the whole pass into the process histogram, calls `match.reportTickStats` once per second, and samples `process.cpuUsage()` per second |
| `node/matchSet.ts` (new, inc. 17) | `MatchSet`: named matches on one loop and one port (§2.17) |
| `node/config.ts` | `server.cfg` (`set <cvar> <value>` lines via `tokenizeCommand`; `//` and `#` comments; `match_add` and `@<match>` lines from inc. 17) and CLI (`--cfg --port --map --maps <dir> --metrics-out <file> --metrics-discard <s> --set name=value`, `--match name=map[:maxClients]` from inc. 17); env `SV_RCON_PASSWORD` |
| `node/log.ts` | JSON-lines logger to stdout (match-scoped lines carry `"match"`) |
| `node/metrics.ts` | GC via `PerformanceObserver({entryTypes:["gc"]})`; memory (heapUsed, external, RSS); metrics line every `sv_metricsInterval`; final JSON for `--metrics-out` |
| `node/rconGuard.ts` | Per-IP rcon failure counter with exponential lockout (D-042) |
| `node/buildHash.ts` | `__BUILD_HASH__` in the bundle; under tsx from `scripts/build-hash.mjs` |
| `node/maps.ts` | Loads `content/maps/<name>.cmap` (or `--maps`) |
| `node/console.ts` | Admin console on stdin (`@<match>` prefix and `matches`, `match_add`, `match_remove` from inc. 17) |
| `node/demoWriter.ts` | Buffered (64 KiB) file `DemoSink` into `demos/`; validates and confines file names (§2.12) |
| `transport/wsListener.ts` | `http.Server` + `ws` `WebSocketServer({noServer: true})` behind one `upgrade` handler (§2.6); path routing (`/`, then `/m/<name>` from inc. 17); admission limits counting in-flight upgrades; `GET /metrics` (JSON), `GET /status` (`{buildHash, protocol, matches:[{name, map, players, maxClients}]}` from inc. 1) |
| `transport/wsTransport.ts` | `WsTransport implements Transport` (§2.6) |
| `server.cfg` (new) | Default config, values in `docs/06` §8 |
| `build.mjs` | Defines `__BUILD_HASH__`; bundles `ws` with a `createRequire` banner; `bufferutil`, `utf-8-validate` external |

Several named matches share one process, one loop and one port from increment 17 (§2.17, D-047). Until then the process runs one match named `main`; `startServer` returns `{matches, listener, stop}` throughout (`matches.main` is the one match).

### client (`packages/client/src`)
| Path | Responsibility |
|---|---|
| `net/webSocketTransport.ts` | `WebSocketTransport(socket: SocketLike)`; channel from the type byte; inbox ring with reused slots; receive cap 16384 B; close-reason mapping |
| `net/snapshotStore.ts` | Client `FrameRing(64)` (64 slots each), newest stored tick, full/delta/dropped/spectator-dropped/deferred counters, consecutive-miss counter |
| `net/remotes.ts` | `RenderClock`, `InterpDelay`, `RemoteInterpolator` (per-slot samples by stamp, keyed on teleportSeq); output `RemoteView` (§2.8) |
| `net/connection.ts` | v2 SNAPSHOT dispatch (header → baseline → body); EVENTS; ack = newest stored tick; READY gated on map, pings, primer; handshake and idle timeouts; `keepalive()` |
| `net/predictor.ts` | New result `SNAPSHOT_TELEPORT` (§2.3) |
| `net/clientSim.ts` | `provideMap(cmap)` (sync); dilation-scaled accumulator; `primePmoveOnce`; spectator mode for demos |
| `net/clock.ts` | Asymmetric hybrid controller (§2.7); test-only `dilation: false` option |
| `net/demoPlayer.ts` | DOM-free `.demo` reader feeding a spectator store and interpolator; followed-player cycling (§2.12) |
| `net/scriptedInput.ts` | `RouteInput(waypoints, seed)` with stuck detector; `RandomWalk(seed)` (Mulberry32) |
| `net/stats.ts` | Snapshot bytes, full snapshots, baseline drops, entities, deferred entities, extrapolated/held frames, render snaps, remote events, interp delay, defer lag, dilation, teleports, server tick p50/p99/max |
| `net/cvars.ts` | `cl_interpDelay`, `cl_remoteSmoothMs`, `cl_remoteCrouchBlendMs` |
| `render/players.ts` (new) | One `InstancedMesh` of capsules (64 instances; per-instance team colour, crouch via instance z scale) + an instanced facing nub: 2 draw calls; allocation-free `update(view)`; placement via `space.ts` |
| `render/teamColors.ts` (new) | Placeholder hues (§4) |
| `app/boot.ts`, `app/maps.ts`, `app/params.ts` | `?connect=ws://host:port[/m/<match>]`, `?net_profile=`, `?demo=<url>`; map URLs from `import.meta.glob("content/maps/*.cmap", {query: "?url"})`; 1 s keepalive `setTimeout` chain while hidden. Worker stays the default |
| `app/game.ts` | Remote capsule update before render; autotest status gains `remotes`, `remoteJumps`, `extrapolations`, `interpDelay`, `buildHash`, `resyncLog`; demo HUD line "following #id" |
| `hud/netgraph.ts` | 7 lines (§2.9) |
| `console/commands.ts` | `connect <url>`, `disconnect`, `rcon <cmd…>`, `demo <url>`, `follow <id>`, `follownext`, `followprev` |
| `console/binds.ts` | Default binds `BracketRight` → `follownext`, `BracketLeft` → `followprev` (inc. 16) |
| `console/clientCvars.ts` | CHEAT on `cl_thirdPerson`, `r_debugHull/Traces/Ground`; `rcon_password` (not archived) |
| `worker/serverWorker.ts` | `sv_cheats 1`; client admin; timeouts off; tick stats via `reportTickStats` |

### tools (`packages/tools`)
- **`src/bots/`:** `cli.ts` (`pnpm bots`), `runner.ts` (N `ClientSim` + `NetSimTransport` + `WebSocketTransport` on one 60 Hz timer; programmatic API), `routes.ts`, `serverChild.ts` (spawns `dist/main.js`, else tsx, with `--port 0 --metrics-out --metrics-discard`, plus `--set sv_maxClients=<min(64, count+2)>` only when count + 2 > 32), `human.ts` (headless Chromium via `packages/client/scripts/browser.ts`), `summary.ts`. The runner reads the target match's `maxClients` from `GET /status` and refuses a count that does not fit (§2.15).
- **`src/replay/validateDemo.ts`:** demo validation used by tests, playback and the CLI. **`src/replay/demoInfo.ts`:** the `pnpm demo-info` CLI (§2.12, inc. 16).
- **`test/net/`:** `multiHarness.ts` (N ≤ 64 clients, binary-heap timers, per-client NetSim seeds and frame models, raw attacker endpoints, per-session bytes, digests against the server mirror); `harness.ts` becomes a one-client facade; `transportContract.ts`; the NET files (§5).
- **`long/` (new):** deterministic long legs and multi-process allocation guards, run by `vitest.long.config.ts` (`pnpm test:long`). Files `*.long.ts`.
- **`load/` (new):** real-time legs, run by `vitest.load.config.ts` (`pnpm test:load`). Files `*.load.ts`. Gated: NET-09 and 16 + 1. Reported only: one 63-bot match and 4 matches × 16 bots.
- **`bench/`:** `snapshotBuild.bench.ts` (16-player build, and a 64-player worst-motion build with the scheduler, reported); codec "typical snapshot" = 16-player full v2 (inc. 4), then 16-player delta (inc. 8); "interp frame" (16 and 63 remotes).
- **`test/perf/`:** new native-ESM workloads; a separate no-retry child mode for the primer (§2.11).

### Root
- `scripts/build-hash.mjs` + `.d.mts` (`BUILD_HASH` env, else `git rev-parse --short HEAD` + `-dirty`, else `dev`).
- `vitest.long.config.ts`, `vitest.load.config.ts`; scripts `test:long`, `test:load`, `demo-info`; `bots` becomes real.
- CLAUDE.md commands table (`test:long`, `test:load`, `demo-info` rows) and stub sentence (only `mapc` M5 and `balance-report` M6 stay stubs), README line 49.
- `content/LICENSES.md`: a `ws` row.
- `.github/workflows/ci.yml`: `pnpm test:long` as a blocking step in `check`; a non-blocking `load` job.

## 2. Data structures and APIs

### 2.1 Protocol v2 (LSB-first; `u8 type` leads every message; the last byte is zero-padded)

`MSG_CHANNEL`: reliable HELLO 1, WELCOME 2, READY 3, CVARS 8, CMD 9, PRINT 10, KICK 11, EVENTS 12; unreliable INPUT 4, SNAPSHOT 5, PING 6, PONG 7.

**Unchanged layouts** (version reads 2): HELLO (first 3 B frozen), WELCOME, READY, INPUT, PING, PONG, CVARS, CMD, PRINT, KICK. Match addressing (D-047) uses the WebSocket upgrade path, not a message field.

**INPUT semantics (v2):** `lastSnapshotTick` = the newest snapshot tick the client has stored. 0 = "no baseline; send a full snapshot". No snapshot is sent for tick 0. The server uses `packetSeq` for an uplink-loss metric.

#### SNAPSHOT (type 5, S→C, unreliable)
A live snapshot is ≤ 1100 B (8800 bits). The server checks the worst case for each client and runs the scheduler only when it does not fit (§2.3, D-046). The encoder checks the size too (`w.fail()` and `DEV_ASSERT` past it; §2.3 says what happens then). Spectator snapshots exist only in demo files and are ≤ 2048 B.

| Field | Bits | Rule |
|---|---|---|
| type | 8 | 5 |
| serverTick | 32 | 1…`TICK_MAX`, two u16 halves |
| baseBack | 6 | 0 = full; 1–63 → baseline = serverTick − baseBack, ≥ 1 |
| flags | 8 | bit 0 STARVED; bit 2 SPECTATOR (demos only); bit 3 DEFERRED (inc. 10; refused before); bit 1 and bits 4–7 must be 0; SPECTATOR with STARVED or DEFERRED refused |
| cvarHash | 16 | low 16 bits of the block hash |
| inputBufferHealth | 8 (i8) | not when spectator |
| teleportSeq | 8 | not when spectator (D-035) |
| local block | var | not when spectator |
| entityCount | 7 | records that follow: 0…63, or 0…64 when spectator |
| entity records | var | ids strictly ascending; own id refused unless spectator |
| deferred list | var | only when DEFERRED: count 6 (1…63), then ids u16 strictly ascending (§2.3) |

The header is **86 bits with the type byte** (70 when spectator). `lastProcessedCmdTick` is dropped: it always equals `serverTick` in this tick model (D-027) and no client reads it. It returns when cmd ticks decouple from server ticks (D-033).

**Live connections drop SPECTATOR snapshots** (counted, and struck like any bad packet); only `DemoPlayer` accepts them.

**Local block.** baseBack = 0: the full v1 `PlayerState`, 199 bits. baseBack > 0: a delta against the baseline's local slot: an 8-bit mask, then the set fields:

| Bit | Field | Code |
|---|---|---|
| 0 | origin x, y, z | per axis class 2 bits: 0 same / 1 diff i7 / 2 diff i13 / 3 absolute i21 (1/32 u) |
| 1 | velocity x, y, z | per axis class 2: 0 same / 1 i7 / 2 i13 / 3 absolute i20 (1/16 u/s) |
| 2 | yaw | 16 |
| 3 | pitch | 16, ±16201 |
| 4 | flags | 10 |
| 5 | groundEntity + 1 | 16, ≤ 32768 |
| 6 | waterLevel | 2 |
| 7 | stamina | 16 |

Mask 0 = unchanged. The local state is reconstructed bit-exact. The local block is never deferred.

**Entity record (players only in M3; entity id = clientId).**

| Field | Bits | Rule |
|---|---|---|
| id | 16 | < 64 (`MATCH_MAX_CLIENTS`; u16 per `docs/05` §4.2, kept for later entity kinds) |
| removed | 1 | 1 → nothing follows; refused in a full snapshot or if the id is absent from the baseline (allowed for a pending baseline slot) |
| new | 1 | when removed = 0. 1 = a full body follows. Must be 1 in a full snapshot and when the baseline slot is absent or pending; for a slot with state in the baseline the encoder sets it only on a new incarnation (different server `serial`) |
| new body (213 bits with the 18 above) | | origin 3 × i21; entity velocity 3 × i16 (1 u/s); yaw 16; pitch 16; flags 10 (outside `ENTITY_FLAG_MASK` refused); team 2 (3 refused); teleportSeq 8; events (eventSeq 8, 2 × (kind 4 + value 8)) |
| delta body | | mask 8 (origin, velocity, yaw, pitch, flags, team, teleportSeq, events; 0 refused), then set fields in order |

Delta body codes: origin uses the local classes; velocity per axis class 2: 0 same / 1 i6 / 2 i11 / 3 absolute i16 (1 u/s); other fields use new-body widths.

**"new" is only a body format.** The client does not treat it as an incarnation signal: it keeps no serial, and interpolation snaps only when a slot's `teleportSeq` changes or the slot appears (§2.8). Every new incarnation spawns, and every spawn bumps the slot's `teleportSeq` (§2.4), so a real new player always snaps, and a "new" record re-sent for the same incarnation (after a pending frame, §2.3) never does. The encoder still never chooses "new" by size: the choice depends only on the baseline slot and the server serial, so encoding stays canonical.

**Canonical rules** (an accepted packet re-encodes to the same bytes, NET-01): smallest class always, non-minimal refused; a set group whose classes are all 0 refused; an entity is listed only if removed, new or mask ≠ 0; absent-and-unlisted-and-not-deferred = absent; present-and-unlisted-and-not-deferred = fresh at this tick, fields copied from the baseline (unchanged). Deferred list: ids strictly ascending, < 64, never the own id, never also in the records, count ≥ 1 when the flag is set. In a delta, a deferred id whose baseline slot has state keeps that state and its stamp; one whose baseline slot is pending or absent becomes pending. In a full snapshot a deferred id is pending. Event slots: kind 0 empty, 1 STEP, 2 JUMP, 3 LAND, 4–15 refused; an empty slot has value 0; empty ev[0] requires empty ev[1]; STEP = round(Δz) as i8; JUMP = 0; LAND = min(255, round(impactSpeed / 16)), quantized at capture.

**Size bounds** (golden test; type byte included):

| Case | Bits | Bytes |
|---|---|---|
| Worst delta, 31 remotes (32 players): 86 + 219 + 7 + 31 × 233 | 7535 | 942 |
| Full, 31 remotes: 86 + 199 + 7 + 31 × 213 | 6895 | 862 |
| Worst delta, 36 remotes, no removals: 86 + 219 + 7 + 36 × 233 | 8700 | 1088 |
| Worst delta, 36 remotes + 6 removals (43 → 37 players inside the ack window): 8700 + 6 × 17 | 8802 | 1101 (> 1100: the worst-case check fails, the scheduler runs) |
| Worst delta, 63 remotes, unscheduled: 86 + 219 + 7 + 63 × 233 | 14991 | 1874 (> 1100: the scheduler defers) |
| Worst full, 63 remotes, unscheduled: 86 + 199 + 7 + 63 × 213 | 13711 | 1714 (> 1100: the scheduler defers) |
| Worst scheduled delta, 63 remotes: 86 + 219 + 7 + 6 + 34 × 233 + 29 × 16 | 8704 | 1088 |
| Worst spectator delta, 32 entities: 70 + 7 + 32 × 233 | 7533 | 942 |
| Worst spectator delta, 64 entities (demo files only): 70 + 7 + 64 × 233 | 14989 | 1874 (≤ 2048) |

**When the scheduler runs.** A snapshot fits by construction while the baseline and the current frame together hold ≤ 37 players by slot id (≤ 36 remotes: 8700 bits). Ids are assigned lowest-free below the effective `sv_maxClients`, so at the default 32 every id is < 32 and the scheduler never runs (NET-08's 32-player leg asserts 0 deferrals). Until inc. 10, `sv_maxClients` is clamped to 37, which keeps every id < 37, so every snapshot fits without a scheduler. From inc. 10 the per-client worst-case check (§2.3) decides: it fails only with > 36 remotes, or with removals on top of 36; then the scheduler keeps every snapshot ≤ 1100 B.

**Typical sizes (ESTIMATE; NET-08 and the 64-player legs measure):** a moving remote at a 6–10 tick baseline age ≈ 115–125 bits, so a delta with 16 remotes (16 bots + 1 human) ≈ 260 B ≈ 16 KB/s down with framing. Full join snapshot: 436 B with 15 remotes (16 players), 463 B with 16 remotes (17 players), ≈ 28 KB/s if every snapshot were full. 32 players (31 remotes): ≈ 490 B ≈ 30 KB/s (reported; the `docs/05` §9.2 budget is for 16 players). 64 players (63 remotes): ≈ 1000 B, so deferral happens only on busy ticks.

#### EVENTS (type 12, S→C, reliable, ≤ 16384 B; inc. 15)
`count` 6 bits (1–63), then per event `kind` 4 bits + payload:

| Kind | Name | Payload |
|---|---|---|
| 1 | PLAYER_JOIN | clientId 6 (0–63), team 2 (0–2) |
| 2 | PLAYER_LEAVE | clientId 6, reason 2 (0 left, 1 timed out, 2 kicked; 3 refused) |
| 3 | SERVER_STATS | tickP50Us 16, tickP99Us 16, tickMaxUs 16 (saturating), players 7 (0–64) |

Kinds 0 and 4–15 refused (reserved for M6/M7). More than 63 events in a tick split across messages. With several matches, every EVENTS message concerns the receiver's match only (SERVER_STATS carries that match's tick times).

**Allocation:** SNAPSHOT and EVENTS encode and decode without allocating, refused packets included.

### 2.2 WorldFrame (`net/worldFrame.ts`)
Arrays sized 64: `present` u8; `stamp` i32 (the server tick the slot's state belongs to; 0 = pending: present but no state yet); `serial` u16 (server only: per-slot connect counter; the client leaves it 0); `originX/Y/Z` i32 (1/32 u); `vel16X/Y/Z` i32 (1/16 u/s); `entVelX/Y/Z` i16 (1 u/s: `clamp((vel16 + 8) >> 4, −32767, 32767)`, computed at capture); `yaw` u16; `pitch` i16; `flags` u16; `groundEntity+1` u16; `waterLevel` u8; `stamina` u16; `team` u8; `teleportSeq` u8; `eventSeq` u8; `evKind` u8×2; `evValue` u8×2. Plus `presentLo/Hi` and `pendingLo/Hi` (u32 masks kept in step with `present` and `stamp`, so counts are popcounts).

Coverage: the server fills every field of every ACTIVE slot, with `stamp` = the frame's tick. The client fills its own slot from the local block (plus `teleportSeq` from the header; stamp = the frame's tick), and only entity fields, `present` and `stamp` of other slots. Until the scheduler (inc. 10) every present slot's stamp equals the frame's tick; after it a deferred slot keeps its baseline stamp. **`frameDigest`** hashes, for the receiver's own slot, exactly the local-block fields plus teleportSeq (not `team`, which arrives on EVENTS), and for other slots `present`, pending, `stamp` and exactly the entity fields (not `serial`). Entity flags are `flags & ENTITY_FLAG_MASK`. Entity velocity at 1 u/s is used only for ≤ 2-tick extrapolation (error ≤ 0.017 u, INFERRED adequate).

### 2.3 Delta scheme (D-038) and byte-budget scheduler (D-046)

**Server**
- `WorldHistory.capture(T)` at the end of each tick writes every ACTIVE slot into frame `T & 63`.
- Per session: `sentTicks[64]`; `ackTick` = max over INPUTs of a valid `lastSnapshotTick` (a reordered INPUT never lowers it).
- **Valid ack:** `0 < ack < T`, `T − ack ≤ 63`, `sentTicks[ack & 63] === ack`, history still holds it. Ahead of the newest sent: ignored, +2 strike. Older: ignored. 0: `ackTick = 0` → full.
- **Baseline:** the valid `ackTick`, else full. Whenever a valid ack exists, `baseBack === T − ackTick` (asserted in NET-02).
- **What the client holds.** For each sent tick the session records whether the frame was `plain`: equal to world frame T minus the receiver's row. Up to 37 players every frame is plain and nothing else is stored. In a match whose effective `sv_maxClients` is > 37, each session also gets a `ClientMirror` (inc. 10): for each sent tick that was not plain, each slot is stored as absent, fresh (state = world frame T's row, stamp T), copied (a deferred slot: its row, serial and stamp copied from the baseline's mirror at send time, so a chain of deferrals never reaches past the 64-frame history) or pending (stamp 0), with presence and pending masks. `MirrorView` resolves any slot of a sent frame (plain or mirrored) without allocating.
- **Mirror memory (inc. 10):** ≈ 156 KB per session (64 frames × 64 rows × ≈ 38 B). Taken from the match's `MirrorPool` at connect, only in matches whose effective `sv_maxClients` is > 37. When an admin raises `sv_maxClients` above 37, mirrors are allocated for the sessions then present, on that change (a rare admin action, never in the tick's hot path). A session returns its mirror to the pool on leave; reconnects reuse it. A 32-player match allocates none. A session without a mirror is always within the bypass condition: its baseline and current frames only hold ids below a cap that has been ≤ 37 during its whole session.
- **Build** for client c at T: header; local slot c of T vs the baseline's local slot; then the worst-case check, and the scheduler only when it fails (below); write mirror frame T (or mark it plain); `encodeSnapshot(cur = mirror T, base = mirror B)`. For each s ≠ c ascending: present at T and (absent or pending in B, or different serial) → new; present or pending in B, absent at T → removed; deferred (cur stamp ≠ T or pending) → deferred list; else mask over differing entity fields, omitted when 0.
- **Commit only on success.** The scheduler writes `lastSent`/`lastDeferred` updates into two match-level scratch `Int32Array(64)`s. After a successful encode the snapshot is sent, `sentTicks[T & 63] = T`, and the scratch is committed. If the encode fails (past 1100 B or any encoder refusal; impossible by the bound, `DEV_ASSERT`), nothing is sent to that client this tick, `sentTicks[T & 63] = 0` (T can never be acked or used as a baseline), mirror frame T is invalid, `lastSent`/`lastDeferred` stay unchanged, and `snapshot_overflow` is counted and logged. NET-02 asserts the count is 0.
- The first snapshot after READY, a late join or a reconnect is full.

**Byte-budget scheduler (D-046; implements `docs/05` §4.3's deferral, with time since last update as the only priority in M3; distance and visibility join with relevance in M9)**
- **Per entity, per client:** `lastSent[s]` = the last tick whose sent snapshot carried s's state fresh: a record, an unchanged present slot (present-and-unlisted), or any present slot of a snapshot that skipped the scheduler. It is updated on every sent snapshot, bypass included (one Int32 write per present remote, no allocation), so crossing from 37 to 38 players starts with correct staleness. `staleness` = T − `lastSent[s]`. An entity that appears for this client (join, or a new incarnation in that slot) starts at `lastSent = T − 1`. `lastDeferred[s]` = the last tick s was left out.
- **Worst-case check (bypass):** W = 312 + 233 × p + 17 × r, where p = remotes present at T and r = slots present or pending in B and absent at T (popcount of the masks); for a full snapshot W = 292 + 213 × p. If W ≤ 8800: include everything, no size pass, frame plain. It holds whenever baseline ∪ current ≤ 37 players by id, so at the default 32 it always holds.
- **Size pass** (when W > 8800): exact bits for every slot that needs a record (`entityRecordBits`; no writing). If the exact total fits, include everything (no DEFERRED flag; the frame is plain). Otherwise classify:
  - **removals** (17 bits each): always included. Removal stays explicit and is never deferred;
  - **mandatory records**: staleness ≥ 2;
  - **deferrable records**: every other slot that needs a record. Each has an out cost: 16 bits (deferred id), or 17 for a **reused slot** (a new incarnation while B still holds the departed player's state), which, if left out, is sent as "removed" (below);
  - **unchanged** slots cost nothing and are never deferred.
- **Accounting (exact, reserved up front):** used = fixed (312 delta, 292 full) + 6 (deferred count) + Σ removals + Σ mandatory records + Σ out costs of all deferrable records. Then scan the deferrable records in priority order and include s while used + (bits_s − out_s) ≤ 8800, adding that marginal cost; a record that does not fit is left out and the scan continues. The final size is ≤ used ≤ 8800 (the 6-bit count is not written when no id is deferred). Example: 63 worst records, none mandatory: used starts at 318 + 63 × 16 = 1326; 34 records fit at +217 each; 29 are deferred; total 318 + 34 × 233 + 29 × 16 = 8704 bits.
- **Priority** (for inclusion): staleness descending, then `lastDeferred` descending (the entity left out longest ago is left out next, so update rates rotate instead of favouring low ids), then id ascending. The order is a preallocated key array sorted by insertion (≤ 63 entries); no allocation.
- **What "left out" means on the wire and in the mirror:** a deferred slot with state in B keeps that state and stamp (copied row); a deferred slot that is new for the client (absent or pending in B, or any slot of a full snapshot) becomes pending, so nothing wrong is shown; a reused slot that is left out is sent as "removed" (17 bits) and is absent in mirror T, so the departed player disappears on time and the new player is never drawn at the old player's place. The new incarnation then has staleness 2 at T + 1 and goes out as a mandatory "new" record. (Rejected alternative: make every reused slot a mandatory record. It can push the mandatory records past capacity, for example 29 carried deferrals + 6 reused slots = 35 > 34.)
- **Bound (static check in `snapshot.ts`, test-verified):** every slot costs at least 17 bits whatever its class (removal 17, left-out reused slot 17, deferred id 16 + its share of slack), and a record adds at most 216 more. So at least `SNAP_MIN_CAPACITY` = ⌊(8800 − 318 − 63 × 17) / (233 − 17)⌋ = 34 records fit in any delta snapshot whatever the removals (⌊(8800 − 298 − 63 × 17) / (213 − 17)⌋ = 37 new bodies in a full one). If more than 34 records are wanted, at least 34 are included, so at most 29 are left out. Only those 29 can have staleness 2 next tick, so the mandatory set is ≤ 29 ≤ 34 and always fits first. Therefore **no entity is left out two ticks in a row: every remote reaches each client at least every `SNAP_MAX_STALENESS` = 2 ticks in the sent stream**, and every snapshot is ≤ 1100 B. The static check asserts 2 × `SNAP_MIN_CAPACITY` ≥ `MATCH_MAX_CLIENTS` − 1, so a later cap or layout change that breaks the bound fails to build. If the mandatory set ever did not fit (impossible by the bound; `DEV_ASSERT`), the scan treats it like the rest and counts `sched_overrun`; NET-02 asserts 0.
- **Events under deferral:** a remote's `eventSeq` keeps the 2 newest events, so ≥ 3 events inside one 2-tick gap lose the oldest (counted by the client, as with packet loss).
- **Cost:** the worst-case check is O(1) per client; the size pass and the encode run only when it fails, both allocation-free. The 64-player build cost is benched and reported, not budgeted (NET-09 is 16 bots).

**Client**
- `SnapshotStore` decodes the header, resolves the baseline (`store.tick(b & 63) === b`), and decodes the body into slot `T & 63` only if T is newer than that slot. Listed slots get stamp T; unlisted present slots are fresh (fields copied from the baseline, stamp T); deferred slots copy fields and stamp from the baseline (or become pending); a failed body invalidates the slot and strikes.
- **Missing baseline:** drop (`STAT_BASELINE_DROPS`, no strike); after 8 in a row, ack 0 until a full snapshot arrives (a safety net; with 64/64 rings it should not fire).
- **Ack** = newest stored tick.
- **Prediction** reads the local slot through `slotToPlayerState` (bit-exact).
- **Frame equality:** a stored client frame equals the server's sent frame for that tick (mirror or plain), stamps and pending slots included (by induction: snapshot T is decoded only against the baseline the server encoded it from). NET-02 checks it with `frameDigest`.
- **Pending slots:** a slot may be pending only in a frame whose baseline is absent or pending for it, or in a full snapshot. Until the client acks a frame where the slot has state, a slot can be pending again in later frames; that is harmless because the interpolator takes samples from every stored frame (§2.8) and does not snap on a re-sent "new" record.
- **Teleport:** `lastTeleportSeq` is seeded from the first stored snapshot and updated only by non-stale snapshots (after the `tick ≤ snapshotTick` check). A change → the predictor adopts the state, re-simulates, clears the render offset and returns `SNAPSHOT_TELEPORT`, which is counted as a teleport, not a correction.

**30 Hz degrade:** not in M3 (M9). WS backpressure drops act as loss; the interpolator measures `snapshotInterval`.

### 2.4 Teams, spawns, events, teleports (D-034, D-035)
- **Team:** on READY, the team with fewer active players (tie → team 1). Cosmetic until M7. No TEAM message; the spectator step (`docs/05` §2 step 5) stays later.
- **Spawn:** round-robin over all `info_player_start` in cmap order, origins raised to floor + ε at construction. The 17th wraps (overlap harmless until M4). Team spawns come with modes (M7).
- **On spawn:** `teleportSeq++` (8 bits, wrapping, persists per slot across incarnations), `serial` = slot connect counter (server), neutral `lastCmd`, `queue.reset`, `starvedRun = 0`.
- **Roster (inc. 15):** JOIN broadcast; the joiner first gets a JOIN burst for every present player; LEAVE with reason.
- **pmove events:** per session into `PmoveEvents`, appended to the slot's event history (eventSeq + 2 newest, quantized). `Match.respawn(s)` for tests and later milestones.
- **`teleportSeq` replaces `SNAP_FLAG_TELEPORT`.** The predictor (own slot) and the interpolator (remotes) key on it; a changed counter is a teleport even if the spawn tick's snapshot was lost (resolves the D-027 known limit). The server `serial` only tells the encoder that a slot holds a new incarnation.

### 2.5 Server tick (v2 order; deterministic by client id; clock-free)
1. **Refill buckets.** Poll each transport in id order. Per message: unreliable type > 1200 B → +5, dropped; channel bucket empty → dropped, tick marked rate-limited; decode and dispatch (INPUT updates `ackTick`, `lastPacketTick`, loss metric).
2. **Timeouts** (when `MatchOptions.timeouts`): CONNECTING (no HELLO) > `sv_helloTimeout` (120 ticks) → KICK "handshake timed out"; WELCOMED > `sv_handshakeTimeout` (600) → same; WELCOMED or ACTIVE with no packet for `sv_timeout` (300) → KICK "timed out".
3. **Strikes:** +1 for a rate-limited tick; decay 1 per 60 ticks; ≥ `sv_strikeWarn` → one PRINT; ≥ `sv_strikeKick` → KICK "too many bad packets", LEAVE reason 2.
4. **Cvars:** refresh and CVARS broadcast (unchanged).
5. **Simulate** each ACTIVE session, collecting pmove events. A starved tick repeats `lastCmd` (attack cleared, `docs/05` §8.1) while `starvedRun < sv_starveNeutralTicks` (30); after that it repeats a **neutral cmd**: axes 0, all buttons released, angles kept. A received cmd resets `starvedRun`. (A hidden tab or a dead client stops moving within 0.5 s instead of running into walls in front of everyone.)
6. `history.capture(T)`.
7. Per ACTIVE session: worst-case check, then the scheduler only if it fails; write the mirror frame (or mark it plain); encode; on success send and commit (`sentTicks`, `lastSent`, `lastDeferred`, `bytesOut`, deferred count), on failure count `snapshot_overflow` (§2.3); then flush the EVENTS outbox (JOIN/LEAVE; SERVER_STATS every 60 ticks).
8. Demo sink, if attached.
9. Metrics counters (including deferred entities, the maximum staleness seen, `snapshot_overflow` and `sched_overrun`).

`reportTickStats(p50Us, p99Us, maxUs)` comes from the host; the match never reads a clock.

### 2.6 WebSocket transport (D-030)
- **One socket per client, both channels.** `reliable = MSG_CHANNEL[d[0]] === 1`; unknown types are delivered as unreliable and struck. No extra bytes on the wire.
- **Server listener (`ws`):** `new WebSocketServer({noServer: true, maxPayload: 2048, perMessageDeflate: false, clientTracking: false, skipUTF8Validation: true})` (ws refuses `server` together with `noServer`), with `binaryType "nodebuffer"`, and one `http.on("upgrade")` handler. In order, the handler: parses the path (a query string is refused); resolves it to a match (`/` in inc. 1; `/m/<name>` with `^[a-z0-9_]{1,32}$` from D-047), else HTTP 404; checks `sv_allowedOrigins` (403), `sv_maxPerIp` (429; loopback exempt) and `sv_maxTotalClients` (503 "server full", inc. 17), counting upgrades still in flight as well as open sockets; only then calls `handleUpgrade`. In the callback it looks the match up again: if it was removed meanwhile, the socket closes with 1001 "match closed". 2048 B covers the largest client message (CMD ≤ 1026 B); a larger frame is closed by ws (1009). Text frame → close 1003. noDelay is set by ws.
- **Server receive:** copy into a pooled `PacketQueue` (slots grow only on demand). Unreliable: ≤ 256 queued, drop-oldest; > 1200 B queued as a zero-length unreliable message (struck +5). Reliable: ≤ 64 between polls; overflow → close 1008.
- **Server send:** `ws.send(Buffer.from(d.subarray(0, len)))` (one copy; ws holds the reference until flushed). `bufferedAmount` > `sv_sendBufferDrop` (32 KiB) → unreliable dropped and counted lost; > `sv_sendBufferClose` (1 MiB) → close 1008 "too slow". Reliable never drops.
- **Close:** KICK text first, then 1000 (1001 at shutdown), reason ≤ 123 B. `onClose` per D-026.
- **Client:** `SocketLike {binaryType; send(data: ArrayBufferView); close(code?, reason?); onopen; onmessage; onclose; readyState; bufferedAmount}` (browser and Node `WebSocket` fit). Sends `send(d.subarray(0, len))`. Received ArrayBuffers are copied into reused inbox slots, same caps; > 16384 B → close.
- **Allocation exception (extends D-026):** ws Buffers, received ArrayBuffers/MessageEvents and the one copy per send are the documented boundary allocation. Match tick, scheduler, codecs and interpolator stay allocation-free. NET-09 measures the GC cost.
- **Scheme:** `ws://` in M3; `wss://` with deployment (M9).

### 2.7 Client clock: asymmetric hybrid ±3% dilation (D-039)
- **Inputs per snapshot:** D-028 low edge **L** (90-snapshot window) and EWMA mean **M** (unchanged); **lowFast** = min over the last 30 snapshots; **target** = `cl_inputBuffer` + adaptive lead (D-028).
- **Speed up (fast, on lowFast):** e_f = lowFast − target. If e_f ≤ −0.5: δ = min(0.03, −0.02 · e_f). Speeding up only adds lead, so reacting to a lone dip is safe.
- **Slow down (slow, on L, per D-028's lesson that short windows miss the longest frames):** only when L ≥ target + 1 **and** M ≥ target + 1: δ = −min(0.03, 0.02 · (min(L, M) − target)). Any dip below target inside the last 90 snapshots blocks slowing down by construction.
- Otherwise δ = 0. The adaptive-cap excess (A > target + 8 + 2) forces δ = −0.03.
- **Apply:** `t[ACC] += t[DT] × (1 + δ)`. `clock.dilation` is exposed.
- **Coarse steps (D-028 machinery kept):** fast-forward when L as a pattern is ≤ target − 2, by k = target − 1 − L (cap 5; target + 8 cap applies); dilation closes the last tick. Hold only when L ≥ target + 6, by k = L − target − 2. Ordinary holds removed. The +8 cap, adaptive lead, anchors and i8-floor rule unchanged.
- **Why steps stay:** 50 → 150 ms RTT adds a 3-tick uplink deficit; +3% recovers 1.8 ticks/s, so pure dilation starves for ≥ 1.67 s (≈ 100 starved ticks). Hybrid: detection ≈ 0.25 s, a 2-tick fast-forward, then ≈ 0.56 s at +3%, about 1 s total. Down (150 → 50): L needs 1.5 s to clear, then 3 ticks at −3% ≈ 1.7 s, ≈ 3.2 s total.
- **Stability:** the loop includes the EWMA (≈ 30 snapshots), the min windows and up to 15 ticks of round trip, so the phase margin is smaller than 0.02 × 15 suggests. The clock unit test uses a plant with the real EWMA, the real min windows and an RTT delay, and NET-07 bounds sign changes (below).
- **Re-converged (NET-07 metric):** the first time tc after which, for ≥ 1 s and to the end of a 6 s window: every 30-snapshot low edge ≥ target − 1, and M ∈ [target − 0.5, target + 0.5 + measured spread].
- **Bounds:** up ≤ 2 s (spec); down ≤ 4 s (design).
- **`MAX_TICKS_PER_FRAME` 5 → 8 and `HITCH_FRAME_MS` 100 → 150** only if every NET-04 block (including a new 83–125 ms frame model) stays green; else 5/100 stay and the < 12 fps limit is documented.

### 2.8 Remote interpolation (`net/remotes.ts`, D-037)
**`RenderClock`** (independent of the prediction clock):
- Each newly stored newest snapshot gives o = serverTick − pollTimeMs / TICK_MS (poll time on purpose: frame quantization is part of the lateness).
- `maxOffset` = max over the last 120 samples (2 s), monotonic ring.
- `target` = nowMs / TICK_MS + maxOffset − interpDelay.
- Each frame: `renderTick += dtTicks × clamp(1 + (target − renderTick) × 0.5, lo, 1.1)`, with lo = 0.9 normally and **lo = 0.5 while renderTick is past the newest stored tick** (so a delay rise is absorbed quickly instead of extrapolating and holding). Render time never runs backwards.
- |target − renderTick| > 6 ticks → snap, counted.

**`InterpDelay`:** lateness = maxOffset − o, histogram of 1/8-tick buckets to 8 ticks (`Uint16Array(64)`) over the same 120 samples; `snapshotInterval` = median tick step over the last 30; **deferLag** = max over the last 120 newly stored snapshots of, per snapshot, the largest (serverTick − newest stamp of that slot over all stored frames, including this one) among the ids it defers; slots with no sample yet are ignored, and a snapshot that defers nothing gives 0. So ≤ 37 players behave exactly as without it, and deferLag is 1 when the scheduler works without loss (a slot deferred at T was sent fresh at T − 1), even though the deferred copy itself carries an older baseline stamp. D = clamp(ceil(2 × snapshotInterval + p95 + deferLag), 2, 6), or `cl_interpDelay` (2–6) when non-zero. D rises at once, falls after 2 s at a lower value.

**`RemoteInterpolator.update(renderTick)`:** works per slot on **samples**: a stored frame where the slot has state gives the sample (stamp, fields, teleportSeq); frames that share a stamp (a deferred copy) give the same sample; pending frames give none. Per slot, a = the sample with the largest stamp ≤ renderTick and b = the sample with the smallest stamp > renderTick, searched over the stored frames from the newest back up to 6 + `SNAP_MAX_STALENESS` frames (no allocation). Until inc. 10 every stamp equals its frame's tick, so this is the per-frame bracket. Per slot: same teleportSeq → lerp origin, shortest-arc yaw, lerp pitch, crouched from a; teleportSeq changed → a until renderTick ≥ b, then b, frame marked `teleported`; first sample (or first after a hide) → appears at its stamp. A re-sent "new" record for the same incarnation changes nothing. **Visibility:** a slot is hidden from the tick of the first stored frame that marks it absent after its newest sample (an explicit removal, or absence in a full snapshot); deferred and pending slots never hide (a pending slot is drawn from its newest sample, or not yet drawn if it has none). **No b:** extrapolate along entity velocity ≤ 2 ticks past that slot's newest sample, clamped by one `traceBox` of the stance hull (one preallocated `TraceResult`), then hold. **Rejoin:** prevDrawn − raw into a per-slot offset decaying over `cl_remoteSmoothMs` (100), snap past `cl_teleportDist`. **Events:** an `eventSeq` advance surfaces ≤ 2 new events per slot (counted; a larger advance counts the lost ones). **Output:** `RemoteView` arrays (64) x, y, z, yaw, pitch, crouched, team, visible, teleported, extrapolating. The renderer blends crouch height over `cl_remoteCrouchBlendMs` (100).

**NET-05 step criterion (used by NET-05, the bots' violation counts and the human stand-in's `remoteJumps`):** per frame, step ≤ speed × dt × 1.5 + 0.5 u, where speed = max(|v_a|, |v_b|, |b.origin − a.origin| / ((b.stamp − a.stamp) × TICK_DT)). The bracket displacement term covers stairs (a 16 u step-up in one tick with vz ≈ 0). Teleport, appearance and the first snap are exempt; outages are judged by the rejoin allowance (bound + offset × dt / `cl_remoteSmoothMs`).

### 2.9 Netgraph (`docs/05` §13; inc. 15)
1. **link:** RTT, jitter, loss %, snapshots/s.
2. **snapshots:** mean/max bytes, full/s, baseline drops/s, entities, deferred per snapshot.
3. **remote:** interp delay (ticks, ms), defer lag, extrapolating / held %.
4. **corrections:** /s, mean, max, offset; teleports.
5. **input:** buffer mean/low, starved/s, dilation %, clock steps.
6. **traffic:** bytes in/out per s (payload + WS framing).
7. **server:** tick p50/p99/max ms, players (of this match).

### 2.10 Authorization and cheats (D-042)
- **Client:** `rcon <cmd…>` sends CMD `rcon <rcon_password> <cmd…>`.
- **Server:** constant-time compare with `SV_RCON_PASSWORD`; unset or empty → rcon disabled. rcon CMD text is never logged. Correct → runs as admin of the sender's match: `set`/`reset`/`toggle` on replicated cvars, `status`, `kick`, `record`/`stoprecord`, and `metrics reset`, which resets only that match's histogram and counters. Wrong → +10 strike and a PRINT.
- **Brute-force lockout:** the pure match calls an optional `MatchOptions.rconGate {allow(clientId), result(clientId, ok)}`. The Node layer implements it in `rconGuard.ts`, keyed by remote address across all matches: from the 3rd failure, lockout = min(2^(failures − 3) s, 600 s); while locked, rcon is refused without checking; counters reset after 10 min without failures. Failures are logged with IP and no text. The Worker has no gate (its client is admin).
- **The stdin console and the Worker client are admin.** `server.cfg` is applied before the listener opens. Process-level commands (`match_add`, `match_remove`, `matches`, and `metrics reset` without a match prefix, which resets the process window and every match) are stdin and `server.cfg` only, never rcon.
- **`sv_cheats`** replicated: 0 on Node, 1 in the Worker. On every block apply the client sets the registry's cheats-allowed state from the mirror's `sv_cheats`; while off, `cl_thirdPerson` and `r_debug*` refuse `set` and reset without writing settings storage. Registration asserts no cvar is both REPLICATED and CHEAT, so the reset never touches a replicated value (D-027).
- The golden block hash `0x11df56b6` changes and is re-pinned.

### 2.11 pmove primer (D-040)
- **World:** `buildPrimerWorld()` (shared, cached): floor, 16/18/19 u steps and a stairs flight, 0.71/0.69 slopes, steep wedge, rotated-wall crease, crouch ceiling, slick strip, water pool (wade, waist, deep), a `SURF_LADDER` face.
- **Script:** `PRIMER_SCRIPT` reaches every move mode and late branch: the slide move's second clip and crease, step-up/down, landings, crouch under the ceiling, ladder climb and jump-off, swim/sink/dive.
- **`primePmoveOnce(params)`** runs `PMOVE_PRIMER_TICKS` (20000, design, measured; ≈ 45 ms) on scratch states with its own `PmoveEvents` and debug log, once per module instance (so a second match in the same process skips it). It never touches match/client state, PRNG, cvars, registries or sessions.
- **Callers:** `Match` constructor (`MatchOptions.primer`, default true) and `ClientSim` constructor (`primer`, default true). Unit helpers that build many matches pass false; inertness, NET and allocation tests keep it on.
- **Guard harness (a separate child mode):** no warm-up pass and no in-process retry, because the transient happens once per process. Each child: a circle phase on flat ground (1.6e5 player-ticks), then exactly one first-stairs window and one first-ladder window, measured for GCs and heap growth. Judged across processes: primed (`primerServer` = Match + loopback client; `primerClient` = ClientSim side) ≥ 2 of 3 processes at 0 GCs and < 64 KB; primer-off control: every one of 3 processes > 256 KB. Runs in `test:long`.
- **Coverage guard** (`test:long`): `node:inspector` precise coverage of `sim/pmove/*`; the primer must reach every block the MV scenario mix reaches, except a reviewed allowlist in the test file. It is the evidence that the primer covers the late branches, which is M3 scope.

### 2.12 Demos (D-044)
- **Recording:** the pure spectator recorder encodes, at the end of each tick, a SPECTATOR SNAPSHOT of all players (up to 64; never deferred, ≤ `MAX_SPECTATOR_SNAPSHOT_BYTES` 2048) against world frame T − 1, with a full keyframe every 600 ticks and at the start, and hands it with the tick's broadcast EVENTS and CVARS to the `DemoSink`. Demo frames always have stamp = tick.
- **File (`.demo`, byte-aligned, LE):** magic "ISDM"; demoVersion u16 = 1; protocolVersion u16; tickRate u8; startTick u32; mapName (u8 len + ASCII); mapHash lo u32, hi u32; buildHash (u8 len + ASCII); cvar block (u16 len + encoded CVARS); records: kind u8 (1 SNAPSHOT, 2 EVENTS, 3 CVARS, 0 END), tick u32, length u16, exact wire message.
- **Commands:** `rcon record [name]`/`stoprecord`, the stdin console (`@<match> record` with several matches), or `sv_autoRecord 1`. Default file `demos/<map>-<utc>.demo`, `demos/<match>-<map>-<utc>.demo` once several matches exist (git-ignored).
- **File names:** a given `[name]` must match `^[a-z0-9_-]{1,64}$`, else the command is refused with a PRINT. The Node writer builds the path with `path.join(demosDir, name + ".demo")` and refuses it unless `path.resolve` of it is inside `demosDir`. An existing file is not overwritten (a `-2`, `-3` suffix is added).
- **Playback:** `?demo=<url>` or `demo <url>` → `validateDemo` → `DemoPlayer` → spectator store and interpolator at 1×; the camera follows the lowest present id from behind (the existing third-person camera path). No seeking.
- **Key cycling (inc. 16):** `follownext` / `followprev` (default binds `BracketRight` / `BracketLeft`) step to the next / previous present id in ascending order, wrapping and skipping absent ids; `follow <id>` jumps to one (refused with a PRINT if absent). If the followed player leaves, the camera moves to the next present id. Outside demo playback the commands PRINT "only during demo playback". The HUD shows "following #id" with the team colour.
- **`pnpm demo-info <file> [--json]` (inc. 16):** runs `validateDemo`, then prints the header (demoVersion, protocol, tickRate, map and hash, buildHash, startTick), duration (ticks and seconds), record counts per kind, keyframes, snapshot bytes mean/max, players seen (ids, teams from JOIN events, first and last tick) and cvar changes; `--json` prints the same as one JSON object. An invalid file prints the reason and exits 1. Root script `demo-info`; CLAUDE.md commands row; `scripts.test.ts` pin.
- **Naming:** in `docs/06` §6/§10 `record`/`demo` mean the server demo; the client debug capture is renamed `capture` and deferred.

### 2.13 Session security (D-041; M3 basics, M9 hardens)
- **Buckets (ticks):** unreliable capacity `sv_inputBurst` 240, refill 2/tick (2 × `INPUT_RATE`); reliable `sv_reliableBurst` 20, refill 0.25/tick. 240 covers the unbatched 64-packet anchor fill plus a 2 s TCP stall backlog.
- **Strikes:** malformed/oversized/unknown 5; wrong channel or state, ack ahead 2; a tick with rate-limited drops 1 (once per tick); bad rcon 10. Decay 1/s. Warn 15, kick 30. Honest clients score 0.
- **Kick-time formula (asserted in NET-10, written into `docs/05` §12):** a flood at r packets/tick against capacity C and refill f is first rate-limited after C / (r − f) ticks and kicked about 31 ticks later (30 points at +1/tick minus decay). So 3× input rate: 240 + 31 = 271 ticks ≈ 4.5 s (bound ≤ 5 s); 10×: 30 + 31 = 61 ticks ≈ 1.0 s (≤ 1.2 s); a reliable flood at 1/tick: 27 + 31 ≈ 1.0 s (≤ 1.2 s). Malformed packets kick within 6.
- **Timeouts:** server 120 / 600 / 300 ticks (§2.5), off in the Worker; client 5 s without a packet → "timed out", 10 s without WELCOME or pongs → "handshake timed out".
- **Hidden tab:** `boot.ts` calls `client.keepalive()` every 1 s (poll, handle reliable, drop snapshots, PING). The server neutralises the repeated cmd after 30 starved ticks (§2.5), so the hidden player stands still. On return: ack 0 → full snapshot and a hard resync. Tabs hidden > 5 min may disconnect under Chrome's intensive throttling (documented).
- **Input validation:** in-range yaw spam legal; out-of-range pitch/axes and spare button bits refused by the decoder (+5); cmds > 64 ticks early dropped and counted, no strike.
- **Listener limits** (checked in the one upgrade handler, in-flight upgrades counted): `maxPayload` 2048, text frames refused, `sv_maxPerIp` (counted across matches), `sv_allowedOrigins`, `sv_helloTimeout`, unknown paths and query strings 404, `sv_maxTotalClients` 503 (§2.17).

### 2.14 Node server (D-029)
**Startup:** parse `server.cfg` and CLI → register SERVER `sv_*` and the replicated template (`sv_cheats` + `pm_*`) → load the maps → create the matches (one `main` match on `sv_map` until inc. 17 and whenever none is configured; the primer runs once) → listen → log `{"ev":"server_ok","startupMs":…}` then `{"ev":"listening","port":N,"buildHash":"…","matches":[…]}`.

**`GET /status`** from inc. 1: `{buildHash, protocol, matches:[{name, map, players, maxClients}]}` (one entry until inc. 17). `maxClients` is the effective cap (clamped to 37 before inc. 10).

**Logs:** `{"t":ISO,"lvl":…,"ev":…}` (match-scoped lines add `"match":"<name>"`): `connect`, `welcome`, `ready`, `leave`, `kick` (reason, strikes), `rcon_fail` (ip), `tick_drop` (the loop's dropped ticks; the line lists every match name, because a drop hits every match on the loop), `snapshot_overflow`, `metrics` every 10 s per match and once for the process (tick p50/p95/p99/max µs, GC count/max ms, players, bytes in/out per s, starved, full snapshots, deferred entities, max staleness, heapUsed/external/RSS MB, CPU ms per wall s), `match_add`, `match_remove`, `shutdown`, `error`.

**Metrics run window:** starts at listen, or after `--metrics-discard <s>` (process and every match). `metrics reset` from rcon resets the sender's match only; from stdin, `@<match> metrics reset` resets that match and a bare `metrics reset` resets the process window and every match. `--metrics-out` writes the run windows (process and per match).

**Shutdown** (SIGINT/SIGTERM, between ticks): stop accepting; KICK "server shutting down" then close 1001 in every match; flush the demos; write `--metrics-out`; exit 0.

**Build hash:** `sv_strictBuild` 1 in the bundle (mismatch KICKed with both hashes), 0 under tsx (PRINT warning). Protocol version always strict. The hash is in the `listening` line and `GET /status`.

**GC:** `PerformanceObserver`; `--trace-gc` passes through for a manual cross-check.

### 2.15 Bots (D-036)
`pnpm bots --count N --profile P --minutes M --map X [--server ws://…[/m/<match>]] [--seed S] [--human] [--strict] [--out reports/bots]`
- **`--count`** 1–64 (1–63 with `--human`). Before connecting, the runner reads the target match's `maxClients` from `GET /status` and refuses with a clear message ("count 40 + human > maxClients 37 on match main") when N (+1 with `--human`) does not fit. Before inc. 10 that refuses counts above 37 (36 with `--human`).
- **Without `--server`:** spawns the built server (`dist/main.js`, else tsx) with `--port 0 --map X --metrics-out <tmp> --metrics-discard 10`, adding `--set sv_maxClients=<min(64, N+2)>` only when N + 2 > 32 (the default covers 16 bots + 1 human); reads port and buildHash from the `listening` line, then `maxClients` from `/status`. With `--server`, reads buildHash and `maxClients` from `GET /status`. Bots send that hash in HELLO.
- **Priorities:** the bots' process, headless Chromium and `vite preview` run at nice 10 (`nice -n 10` on Linux/macOS, `os.setPriority` fallback).
- **One process:** each bot = `ClientSim` + `NetSimTransport(profile, seed + i)` + `WebSocketTransport(new WebSocket(url))`, framed at 60 Hz by one `setTimeout` chain with per-bot phase.
- **Behaviours:** 60% `RouteInput` strafe-jump circuits (arena: yard ring around x ±900, y ±560); 40% `RandomWalk` (heading change every 1–3 s, jumps). Stuck = < 32 u of progress in 2 s → random walk 1 s, then next waypoint.
- **Each bot samples its `RemoteInterpolator` at 60 Hz** for NET-05 violations (§2.8 criterion).
- **`--human`:** serves the production build with `vite preview`, opens headless Chromium at `/?autotest=1&bot=mixed&connect=ws://127.0.0.1:<port>&net_profile=<P>`; before the run, the page's `buildHash` must equal the server's or the run fails with "rebuild: preview <a> ≠ server <b>"; the summary asserts the human joined (server players = N + 1, human `remotes` = N).
- **Host gate:** 1-minute load average ≤ 0.5 per core before the run, else FAIL with the reason (not a skip).
- **Summary** (`reports/bots/<stamp>.json` + `.md`): config (match name included); server (run-window tick p50/p95/p99/max, GC max/count, heapUsed + external, RSS, CPU/wall, starved, full snapshots, deferred entities, max staleness, strikes, kicks); per bot and aggregate (corrections/s, mean/max correction, starved, buffer mean/low, bytes up/down per s with WS framing, KB = 1000 B, snapshot size p50/p95/max, delta share, deferred per snapshot, interp delay, extrapolation %, NET-05 violations, resyncs, input loss); host load. PASS/FAIL against `docs/10` §4; `--strict` exits 1 on any FAIL.

### 2.16 Test tiers (D-032)
| Tier | Command | What | Where it gates |
|---|---|---|---|
| fast | `pnpm test` | units, a short smoke of every acceptance test, in-process proxies | every increment; CI `check` |
| long | `pnpm test:long` (`vitest.long.config.ts`, `packages/*/long/**/*.long.ts`) | deterministic fake-clock long legs (including the 64-player legs) and multi-process allocation guards | every increment that touches them; CI `check` (blocking) |
| load | `pnpm test:load` (`vitest.load.config.ts`, `packages/tools/load/*.load.ts`) | real processes on real time: NET-09 and 16 + 1 (gated); one 63-bot match and 4 matches × 16 bots (reported only) | local `--strict` run recorded in the handoff; CI `load` job non-blocking |

- **Budgets:** `pnpm test` ≤ 55 s wall **and** ≤ 165 CPU-s (user + sys), both reported per increment (baseline 40.5 s / 121.5 CPU-s). `pnpm test:long` ≤ 4 min wall.
- **Placement rule:** a new native-ESM child or long leg lands in `pnpm test` only if the measured budget holds; otherwise it moves to `test:long` (still blocking in CI).
- **`test:net`** keeps its pinned command (the fast NET smokes). `/net-check` runs `test:net`, `test:long -t "^NET-"` and a bots run.
- **acceptance-ids guard (M3 entry):** each ID needs a `describe("<ID>…")` in a `test/` file; IDs with a tier (`NET-09` → load; `NET-04`, `NET-12`, `NET-02` → long) also need one in that tier's files.

### 2.17 Several matches per process (D-047; inc. 17)
- **Addressing:** the WebSocket upgrade path. `/` → the default match (the first created); `/m/<name>` → that match; names match `^[a-z0-9_]{1,32}$`. An unknown name, any other path or a query string gets HTTP 404 before the upgrade (no socket, no slot). The match is looked up again when the upgrade completes; if it was removed in between, the socket closes with 1001 "match closed" (§2.6). The protocol is unchanged (HELLO stays frozen; WELCOME already names the map). Clients and bots pass the full URL (`?connect=ws://host:28700/m/duel`, `--server ws://…/m/duel`).
- **Creating and removing:** `match_add <name> <map> [maxClients]` in `server.cfg`, on the CLI (`--match <name>=<map>[:<maxClients>]`, repeatable) or on stdin; `match_remove <name>` on stdin (KICK "match closed" to its sessions, LEAVE reason 2, its demo flushed, its mirrors released; the last match cannot be removed); `matches` lists name, map, players, maxClients. With none configured: one match `main` on `sv_map` with `sv_maxClients`.
- **What is per match / per process:** per match: map, `maxClients` (default `sv_maxClients`, ≤ 64), the replicated registry (`pm_*`, `sv_cheats`), sessions, client ids 0–63, serverTick, `WorldHistory`, mirror pool, PRNG, EVENTS, demos, metrics. Per process: port, host, build hash, timeouts, buckets, strikes, `sv_maxPerIp`, `sv_allowedOrigins`, `sv_metricsInterval`, `sv_strictBuild`, the rcon password and lockout. A `server.cfg` or stdin line prefixed `@<name>` targets that match (`@duel set pm_gravity 400`, `@duel status`, `@duel record`); without a prefix, match commands go to the default match, and a replicated `set` in `server.cfg` before any `match_add` sets the template every new match copies.
- **One loop:** `MatchSet` is the host's `Tickable`; each loop tick it ticks every match in creation order. Matches share no state, so a match's results do not depend on its neighbours (tested by digest). **Timing is shared:** one slow match lengthens the pass for all, and a catch-up drop (`MAX_CATCHUP_TICKS` 5) drops the same ticks in every match. `tick_drop` lists every match; the pass histogram is the judge.
- **Limits:** `sv_maxMatches` 4 (ESTIMATE, 1–16); `sv_maxTotalClients` 64 (ESTIMATE; one full match fits): an upgrade past it, in-flight upgrades counted, gets HTTP 503 "server full"; a full match KICKs "server full" as today. The load tier reports 4 matches × 16 bots (pass p99, drops) so the default can be revisited; it is not gated (`docs/10` §4.1 budgets one 16-player match).
- **Logs and metrics:** match-scoped log lines carry `"match"`; a `TickHistogram` per match and one for the whole pass (the NET-09 judge, identical with one match); `/metrics` → `{process:{…}, matches:{<name>:{…}}}`; `/status` → `{buildHash, protocol, matches:[{name, map, players, maxClients}]}`; `--metrics-out` writes both; SERVER_STATS carries the receiver's match tick times.
- **Admin:** rcon acts on the sender's match only (including `metrics reset`); process commands are stdin and `server.cfg` only.

## 3. Decisions (each lands with its code and only the doc text that code makes true)

| ID | Decision | Inc. | Doc updates |
|---|---|---|---|
| D-029 | **Node server shape.** `src/node`, `src/transport` outside the pure `src/match`; `"./node"` export. One match per process until D-047. `server.cfg` via `tokenizeCommand`; CLI overrides; SERVER `sv_*`. JSON-lines logs. `TickHistogram`, GC via `PerformanceObserver`, memory (heapUsed + external; RSS reported), CPU/wall, bytes; metrics line; `/metrics`, `/status` (matches array from the start); `--metrics-out`, `--metrics-discard`, `metrics reset` (match-scoped via rcon, process via stdin). Graceful shutdown. Port 28700 | 1 | docs/06 §3, §8; docs/05 §2 |
| D-030 | **WebSocket transport.** `ws` (MIT) server-only; browsers and bots use native WebSocket via `SocketLike`. Listener in `noServer` mode behind one upgrade handler that checks path, origin and limits (in-flight counted) before `handleUpgrade`. Channel from the type byte. Binary only; server `maxPayload` 2048, client receive cap 16384; no deflate; noDelay. Unreliable ≤ 1200 B. Backpressure drops > 32 KiB, closes > 1 MiB. Inboxes 256/64. Boundary allocation extends D-026. `ws://` in M3 | 1 (client 2) | docs/05 §3.1–3.2; docs/06 §2; LICENSES |
| D-031 | **Build hash, map loading, connect path.** One `scripts/build-hash.mjs`; `sv_strictBuild` (bundle 1, tsx 0); hash in `listening` and `/status`. Client loads the WELCOME map from bundled URLs (Node: disk), checks the hash. READY waits for map, pings, primer. `?connect=`, `?net_profile=`, `connect`/`disconnect`. Worker stays default | 2 | docs/05 §2; docs/06 §6; docs/07 §6 |
| D-032 | **Test tiers** (§2.16): fast / long / load, wall and CPU budgets, the placement rule, the tiered acceptance guard | 3 | docs/10 §1–§2 |
| D-033 | **Protocol v2 layout** (§2.1): 86-bit header (with type) with baseBack u6, SPECTATOR flag, teleportSeq; `lastProcessedCmdTick` dropped; full/delta local block; entity list with a 7-bit count; "new" is a body format only; canonical encoding; `PROTOCOL_VERSION` 2. Inc. 4 documents the full forms and marks the delta rows "refused until D-038" and the DEFERRED flag "refused until D-046"; inc. 8 enables deltas, inc. 10 the deferred list (same version, nothing released between) | 4 (delta 8, deferred 10) | docs/05 §3.3, §3.6, §4.2 |
| D-034 | **Entities, cap, teams, spawns.** WorldFrame slot; entity id = clientId (u16, < 64); local excluded; flag mask. **"Cap 64, default 32" (Mustafa):** `MATCH_MAX_CLIENTS` stays 64 (moved to shared); `sv_maxClients` defaults to 32 (design value, Mustafa's decision), range 1–64, clamped to 37 until the scheduler lands (inc. 10); ids lowest-free below the effective cap. A snapshot fits 1100 B by construction while baseline ∪ current ≤ 37 players by id (worst 1088 B; 942 B at 32); otherwise D-046. Teams auto-balanced, cosmetic until M7. Round-robin `info_player_start`. Placeholder hues | 4–5 | docs/05 §2, §4.2; docs/01 O-8 status text → "**Partly decided** (D-034): up to 64 players per match, `sv_maxClients` default 32; 5v5 for round modes still proposed"; docs/08 §5 note |
| D-035 | **Teleport counter.** 8-bit `teleportSeq` (header and entity) replaces `SNAP_FLAG_TELEPORT`; it is the only snap signal for the predictor and the interpolator (every spawn, so every new incarnation, bumps it); the server `serial` only drives the encoder's "new" choice; predictor `SNAPSHOT_TELEPORT` (not a correction), last-seen ordered by snapshot tick | 4–5 | docs/05 §3.6, §5, §6 |
| D-036 | **Bots, server metrics, NET-08 accounting.** `packages/tools/src/bots/` (fixes docs/05 §13, docs/10 §1); one process; NetSim per bot; routes + random walk + stuck detector; server child sets `sv_maxClients` only when count + 2 > 32 (16 + 1 needs no flag); the runner refuses a count above the match's `maxClients` from `/status`; bots take the server's build hash; nice 10. NET-08 on arena_greybox with 16 bots + 1 human stand-in (acceptance), plus a reported 32-player leg; bandwidth = payload + WS framing, KB = 1000 B; stale "12 B/cmd" corrected; NET-12 reconnect = fresh session with full sync | 6 | docs/05 §13–14 (NET-08, NET-12); docs/10 §1, §4.2 |
| D-037 | **Remote interpolation** (§2.8), including per-slot samples by stamp, snapping keyed on teleportSeq, the NET-05 criterion with the bracket-displacement speed term, lo 0.5 slew while past the newest frame, and the hold/snap bounds | 7 | docs/05 §6, §14 NET-05 |
| D-038 | **Delta compression** (§2.3): shared 64-frame history + per-client sent ring; ack = max valid; ahead +2; 0 = full request; store of 64; drop on missing baseline, 8 in a row → full. Deferral by D-046; no 30 Hz degrade in M3 | 8–9 | docs/05 §4.3, §9.2 |
| D-039 | **Asymmetric hybrid dilation (NET-07)** (§2.7): speed up on lowFast, slow down only on the 90-snapshot L and M; D-028 fast-forwards kept; holds only at L ≥ target + 6. Re-converged metric; 2 s up, 4 s down. Cap 8 / hitch 150 only if NET-04 green. Deviation from "±3% only" justified by the starvation arithmetic (Mustafa chose the hybrid) | 11 | docs/05 §1.3, §8.2, §14 NET-07; docs/06 §7; D-028 note |
| D-040 | **pmove primer** (§2.11): primer world and script; 20000 ticks (design, measured); once per module instance at Match and ClientSim; proven inert; no-retry multi-process guard with a primer-off control; coverage guard | 12 | docs/10 §4.4; docs/03 §3 note |
| D-041 | **Session security** (§2.13): buckets, strike weights, kick-time formula, timeouts (hello 120, handshake 600, idle 300 ticks; off in Worker; client 5/10 s), neutral cmd after `sv_starveNeutralTicks` starved ticks, hidden-tab keepalive, listener limits with in-flight counting. M9 hardens | 13 | docs/05 §2, §8.1, §12; docs/09 M9 note |
| D-042 | **Authorization and cheats** (§2.10): rcon with constant-time check, per-IP lockout in the Node layer; rcon scoped to the sender's match (incl. `metrics reset`); stdin and Worker admin; replicated `sv_cheats` drives CHEAT flags; no REPLICATED+CHEAT cvars; hash re-pinned | 14 | docs/05 §3.5; docs/06 §6–§8 |
| D-043 | **EVENTS and the full netgraph:** JOIN + roster burst, LEAVE + reason (6-bit client ids), SERVER_STATS 1 Hz (7-bit players); kinds 4–15 reserved; 7-line netgraph | 15 | docs/05 §3.3, §10, §13; docs/06 §7 |
| D-044 | **Demos** (§2.12): spectator stream (≤ 64 entities, never deferred, ≤ 2048 B, files only), `.demo` v1, `DemoSink` + Node writer with validated, confined file names, `record`/`stoprecord`/`sv_autoRecord`, playback following a player with `follow`, `follownext`/`followprev` and `[`/`]` binds; `pnpm demo-info`; `capture` renamed and deferred | 16 | docs/05 §13; docs/06 §3, §6, §10; CLAUDE.md commands |
| D-045 | **Load project and the 16 + 1 check:** `pnpm test:load` (NET-09 real, 16 bots + 1 headless human; reported 63-bot and 4 × 16 legs), metrics discard, host gate that fails, nice 10 for generators and browser; CI `load` job non-blocking (shared-runner noise, not core count), first numbers recorded to decide blocking later | 18 | docs/05 §14 NET-09; docs/10 §3–§4; docs/09 M3 note |
| D-046 | **Snapshot byte-budget scheduler** (§2.3): `docs/05` §4.3's deferral with time since last update as the M3 priority (distance and visibility with relevance in M9); per-client worst-case check (bypass) that counts removals; `lastSent` updated on every sent snapshot; exact accounting with out costs reserved up front; mandatory removals and staleness ≥ 2; rotation by last deferral, then id; first fit; reused slots left out as "removed"; DEFERRED flag + u16 deferred-id list; pending slots; per-slot stamps; lazy `ClientMirror` (only in matches above 37, plain frames, copied deferred rows); commit only on a successful encode; static bound (≥ 34 records, max staleness 2 ticks); interpolation by stamp with deferLag | 10 | docs/05 §3.6, §4.2, §4.3, §6; docs/10 §4 |
| D-047 | **Several matches per process** (§2.17): path addressing `/m/<name>`, `match_add`/`match_remove`/`matches`, `@<match>` prefix, per-match registries, ids, logs, metrics, mirror pools and demos; one loop in creation order with shared timing (documented; `tick_drop` lists all matches); `sv_maxMatches` 4, `sv_maxTotalClients` 64 (in-flight counted, 503) | 17 | docs/06 §3, §6, §8; docs/05 §2 |

## 4. New values to label

Every value the M3 doc edits touch gets a label. Every ESTIMATE a person might tune is a cvar (rule 7).

**Server cvars** (SERVER, not replicated; `docs/06` §8 + `server-cvars-docs.test.ts`):

| Name | Default | Label |
|---|---|---|
| `sv_port` | 28700 | design |
| `sv_host` | 0.0.0.0 | design |
| `sv_map` | arena_greybox | design |
| `sv_hostname` | "In Shambles" | content |
| `sv_maxClients` | 32 (1–64; clamped to 37 until inc. 10) | design (Mustafa's decision, D-034); hard cap `MATCH_MAX_CLIENTS` 64 |
| `sv_maxMatches` | 4 (1–16) | ESTIMATE (inc. 17) |
| `sv_maxTotalClients` | 64 (one full match) | ESTIMATE (inc. 17) |
| `sv_strictBuild` | 1 bundle / 0 tsx | design |
| `sv_timeout` | 300 ticks (5 s) | `docs/05` §2 design |
| `sv_helloTimeout` | 120 ticks (2 s) | ESTIMATE |
| `sv_handshakeTimeout` | 600 ticks (10 s) | ESTIMATE |
| `sv_starveNeutralTicks` | 30 | ESTIMATE |
| `sv_strikeWarn` / `sv_strikeKick` | 15 / 30 | ESTIMATE |
| `sv_inputBurst` | 240 (≥ 64) | ESTIMATE |
| `sv_reliableBurst` | 20 | ESTIMATE |
| `sv_maxPerIp` | 8 (loopback exempt) | ESTIMATE |
| `sv_allowedOrigins` | "" (any) | design |
| `sv_sendBufferDrop` / `sv_sendBufferClose` | 32768 / 1048576 B | ESTIMATE |
| `sv_metricsInterval` | 10 s | design |
| `sv_autoRecord` | 0 | toggle |

**Replicated:** `sv_cheats` (Node 0, Worker 1; changes the golden hash).

**Client cvars** (ARCHIVE unless noted; `docs/06` §7 gains a flags column): `cl_interpDelay` 0 = auto (design); `cl_remoteSmoothMs` 100 (ESTIMATE); `cl_remoteCrouchBlendMs` 100 (ESTIMATE); `rcon_password` "" (not archived). CHEAT added to `cl_thirdPerson`, `r_debugHull/Traces/Ground`. Default binds `BracketRight` `follownext`, `BracketLeft` `followprev` (design).

**Design constants:**

| Area | Constant | Value | Label |
|---|---|---|---|
| Protocol | `PROTOCOL_VERSION` / `MSG_EVENTS` | 2 / 12 | design |
| Protocol | baseBack; entityCount | 6 bits; 7 bits | design |
| Protocol | `SNAPSHOT_HISTORY` | 64 | `docs/05` §4.3 |
| Protocol | `MAX_SNAPSHOT_BYTES` (`SNAP_BUDGET_BITS`) | 1100 (8800) | `docs/05` §4.3, `docs/10` §4.2 |
| Protocol | `MAX_SPECTATOR_SNAPSHOT_BYTES` | 2048 (demo files only) | design |
| Protocol | unreliable message cap | 1200 B | design (below a 1280 B IPv6 minimum MTU after headers) |
| Protocol | server `maxPayload` | 2048 B | design (largest C→S message 1026 B) |
| Protocol | `MATCH_MAX_CLIENTS` | 64 (unchanged from M2) | design (D-034) |
| Protocol | entity id | u16, < 64 | `docs/05` §4.2 |
| Classes | origin / local velocity / entity velocity | as §2.1 | design |
| Entity | velocity quantum | 1 u/s | INFERRED adequate |
| Entity | `teleportSeq`, `eventSeq` | 8 bits; 2 events kept | design; `docs/05` §10 |
| Entity | event kind / value; LAND scale | 4 / 8 bits; impact / 16 | design |
| Delta | drops before a full request | 8 | design |
| Scheduler | worst-case check | 312 + 233 p + 17 r ≤ 8800 (full: 292 + 213 p) | derived from the layout |
| Scheduler | `SNAP_MIN_CAPACITY`; `SNAP_MAX_STALENESS` | 34 records (37 full); 2 ticks | derived (static check) |
| Scheduler | out costs | deferred id 16 bits; reused slot sent as removed 17 bits | design |
| Scheduler | deferred id; deferred count | u16; 6 bits | design |
| Scheduler | priority | staleness, then last deferral, then id | design (`docs/05` §4.3 accumulator, time term only in M3) |
| Scheduler | `ClientMirror` | 64 frames × 64 rows (≈ 156 KB) per session, only in matches with `sv_maxClients` > 37, pooled | design |
| EVENTS | count; SERVER_STATS cadence | 6 bits; 60 ticks | design |
| EVENTS | client id; players | 6 bits; 7 bits | design |
| Interp | interpDelay; extrapolation | 2–6; ≤ 2 ticks | `docs/05` §6 |
| Interp | lateness window; fall hysteresis | 120 samples, 1/8-tick buckets; 2 s | design |
| Interp | render slew; past-newest floor; snap | ±10%, gain 0.5; 0.5; > 6 ticks | design |
| Interp | deferLag window | 120 snapshots | design |
| Clock | `DIL_MAX` | 0.03 | `docs/05` §8.2 |
| Clock | `DIL_GAIN`; speed-up deadband; slow-down threshold | 0.02/tick; 0.5 tick; L and M ≥ target + 1 | design |
| Clock | lowFast window; FF threshold; hold threshold | 30; L ≤ target − 2; L ≥ target + 6 | design |
| Clock | NET-07 down bound | 4 s | design |
| Clock | `MAX_TICKS_PER_FRAME`, `HITCH_FRAME_MS` | 5 → 8, 100 → 150 if NET-04 green | design, measured |
| Security | refills | 2/tick; 0.25/tick | `docs/05` §12; design |
| Security | strike weights; decay | 5/2/1/10; 1/s | design |
| Security | rcon lockout | from 3rd failure, 2^(n−3) s, cap 600 s, reset 10 min | design |
| Client | timeouts; keepalive | 5 s / 10 s; 1 s | `docs/05` §2 / design |
| WS | inbox | 256 / 64 | design |
| Metrics | `TickHistogram` | 2048 × 10 µs + overflow + max | design |
| Demos | keyframe; `DEMO_VERSION`; writer buffer | 600 ticks; 1; 64 KiB | design |
| Demos | record name pattern | `^[a-z0-9_-]{1,64}$`, confined to `demos/` | design |
| Matches | name pattern; default name | `^[a-z0-9_]{1,32}$`; `main` | design |
| Primer | `PMOVE_PRIMER_TICKS` | 20000 | design, measured (not an estimate of the original game; no effect on results) |
| Bots | frames; stuck rule; heading change; mix; arena ring | 60 Hz; 32 u in 2 s; 1–3 s; 60/40 route/walk; x ±900, y ±560 | design |
| Bots | `--count` | 1–64 (63 with `--human`), never above the match's `maxClients` | design |
| Load | discard; host gate | 10 s; load avg ≤ 0.5 per core | design |
| Tests | `pnpm test` budget | ≤ 55 s wall, ≤ 165 CPU-s | design (`docs/10` §2 target 60 s) |
| Accounting | WS framing | 2/4 B server frame, 6/8 B masked client frame | FACT (RFC 6455) |
| Accounting | KB | 1000 B | design |
| Rendering | capsule | r 15 u; 56 / 40 u | from `sim/hull.ts` |

**Placeholder content:** team 1 #d9652b (orange), team 2 #2b8fd9 (blue), neutral #9a9a9a: ESTIMATE placeholders (orange/blue reads for common colour-vision deficiencies). `docs/08` §5 still picks the real hues and the shape cue (M8).

**Estimates to confirm:** 16-remote delta ≈ 260 B ≈ 16 KB/s (NET-08); full join 436 B (16 players) / 463 B (17) (NET-08); up ≈ 3.7 KB/s (NET-08); 32-player delta ≈ 490 B ≈ 30 KB/s (NET-08 32-player leg, reported); 64-player delta ≈ 1000 B with occasional deferral (64-player legs, reported); snapshot build ≤ 10 µs per client at 16 players (bench); 64-player build cost (bench, reported); 16-remote interp ≤ 20 µs per frame (bench); 4 matches × 16 bots pass p99 (load, reported).

## 5. Test plan

### Acceptance tests
F = `pnpm test` (and `test:net`); Lg = `pnpm test:long`; L = `pnpm test:load`.

| ID | Tier and file | Setup | Pass condition |
|---|---|---|---|
| NET-01 | F `shared/test/net/codecs.test.ts` | Seeded v2 SNAPSHOTs (full, delta, spectator; 0–63 / 0–64 entities; with and without a deferred list; pending slots; each field alone and together; extremes; every class boundary) and EVENTS; 1e4 random strings, every truncation, bit flips; patched-field table (id ≥ 64, unsorted/duplicate ids, own id, removed in full, removed not in baseline, delta for absent or pending slot, mask 0, non-minimal class, all-zero classes, flag bit 1, bits 4–7, spectator + starved, spectator + deferred, count over cap, baseBack > serverTick − 1, entity flag bits 5/6, team 3, event kind > 3, empty ev[0] before ev[1], JUMP value ≠ 0, deferred flag with count 0, unsorted/duplicate deferred ids, deferred own id, deferred id also in the records, deferred id ≥ 64, EVENTS kind 0/4–15, LEAVE reason 3, JOIN id ≥ 64, players > 64) | Exact round trips; never throws; accept ⇒ same bytes; goldens 942/862/1088/942 B, the worst scheduled 63-remote delta 1088 B and the 64-entity spectator 1874 B (≤ 2048); protocol-docs golden; codec workload 0 GCs |
| NET-02 | F `shared/test/net/delta.test.ts` + F smoke / Lg full `tools/…/net-02-delta-match` + F smoke / Lg full `tools/…/net-02-sixty-four-players` | (a) 20k-tick world sequence (joins, leaves, slot reuse next tick and within 64, each field alone and together, idle, teleports, event bursts) through server encoder + client store with loss, duplication, reorder, delayed/lost acks, acks past 63, hostile acks ahead, ack 0, forced misses; plus the same with 64 slots and worst-class changes every tick, so the scheduler defers every tick; plus 43 → 37 players with 6 removals against an old baseline (the worst-case check fails and the scheduler runs); plus 37 ↔ 38 players crossed repeatedly under worst motion; plus reused slots under budget pressure. (b) Real Match + 4 `ClientSim` on bad-250-loss5: F 15 s, Lg 60 s. (c) Real Match + 64 `ClientSim` on arena_greybox (routes and random walks): F 5 s at wan-100-loss1; Lg 30 s each at wan-150-loss2 and bad-250-loss5, and a 20 s respawn storm (24 players respawned per tick, rotating) that forces deferral at the real 1100 B budget | Digest equality (client frame = server sent frame, stamps and pending slots included) on every accepted snapshot; **baseBack === T − ackTick whenever a valid ack exists**; full whenever no valid baseline; never a decode against a missing baseline; per entity delta bits ≤ new bits + 20 and local delta ≤ full + 20; mean delta ≤ mean full; (b) and (c) ≥ 90% delta snapshots after the first RTT following READY; 0 strikes; **(a) 64-slot, 43 → 37 and crossing, and (c): every snapshot ≤ 1100 B; `snapshot_overflow` and `sched_overrun` 0; for every client, entity and tick, staleness at send ≤ 2 (never left out twice in a row); genuine removals never deferred; a reused slot never shows the departed player's state after the reuse tick; a slot is pending only in a frame whose baseline is absent or pending for it, or in a full snapshot, and every entity reaches a frame with state within 2 sent snapshots of appearing; the storm leg defers in ≥ 50% of its snapshots; deferral share and max staleness printed** |
| NET-04 | F `net-04-reconciliation.test.ts` (M2 blocks re-baselined) + F `net-04-sixteen-clients` (seed 1, wan-150-loss2, 30 s) + Lg (seeds 5/7 and wan-100-loss1, 60 s) | M2 profiles and frame models under v2, delta, dilation; arena_greybox, 1 observed route client + 15 bots | Observed: < 1 correction/s, mean < 2 u, render offset < 8 u, `unreconciled()` empty; others < 1/s, mean < 2 u; teleports not counted as corrections; for the 60 fps-with-hitches and 33–83 ms models after 20 s of learning: ≤ 1 fast-forward per 60 s and no δ < 0 within 1.5 s after a dip below target |
| NET-05 | F 2-client matrix + Lg 16-client leg `net-05-interpolation` + Lg 64-client leg (with NET-02 (c)) | Mover on a strafe route (≤ ≈ 765 u/s, including the south-ledge stairs) and observer; profiles wan-50, wan-100-loss1, wan-150-loss2, bad-250-loss5; 144 Hz, hitches, slow host; RTT step + `framesSwitchingAt`. 64 players: 4 observers sample all 63 remotes at 60 Hz, at the real budget and in the storm leg, plus a late joiner at 64 players | §2.8 criterion with the displacement term; interpDelay in 2–6 and = formula (deferLag 0 at ≤ 37 players); render rate in [0.9, 1.1] (≥ 0.5 only while past the newest frame); 0 render snaps after the first; held + extrapolated ≤ 2% of frames on wan-150-loss2 (≤ 2% of remote-frames at 64 players, storm-teleported remotes exempt) and ≤ 0.6 s total after the RTT step; 150 ms outage → ≤ 2 ticks extrapolated, hold, rejoin within allowance; never drawn in solid; short-arc yaw across 0/65535; respawn and same-slot reconnect snap (new teleportSeq), never lerp; a deferred remote is never hidden; **the late joiner's remotes snap only at their first appearance (no snap on later "new" re-sends while slots alternate with pending)**; observer clock steps leave remotes continuous |
| NET-07 | F `net-07-time-dilation.test.ts` | One-way 25 → 75 ms (jitter, loss 0) mid-circuit, and 75 → 25; 144 Hz and browser-hitch frames; seeds 1–3; a control with `dilation: false` | Re-converged ≤ 2 s up, ≤ 4 s down; \|δ\| ≤ 0.03 every frame and ticks per wall second in [0.97, 1.03] over 0.5 s windows outside step frames; ≤ 2 fast-forwards per transition; no holds; 0 hard resyncs; corrections < 1/s; **144 Hz up-step: M within target ± 0.5 within the bound and δ > 0 for ≥ 0.3 s; δ changes sign ≤ 2 times in the steady part; the dilation-off control fails both directions** |
| NET-08 | F `net-08-bandwidth.test.ts` | (a) acceptance: MultiHarness, arena_greybox, 16 bots + 1 human stand-in (`MixedInput`, hitch frames), wan-100-loss1, 60 s after all joined; server session bytes + WS framing. (b) report: 31 bots + 1 human stand-in (32 players, the default cap), wan-100-loss1, 20 s | (a) per client: average down ≤ 32 KB/s, peak 1 s ≤ 48 KB/s, up ≤ 8 KB/s, every snapshot ≤ 1100 B; **mean snapshot ≤ 0.7 × mean full snapshot; full snapshots ≤ 1/s per client after join; delta share printed**; join and typical sizes printed. (b) every snapshot ≤ 1100 B and **0 deferred entities, 0 size passes** (worst-case check always passes); bandwidth, sizes and delta share printed, no bandwidth gate (`docs/05` §9.2 budgets 16 players) |
| NET-09 | F `net-09-server-perf.test.ts` ("NET-09 proxy: …") + L `net-09-server-perf.load.ts` | F: 16 clients over loopback with deltas. L: built server + bots (16, wan-100-loss1, 1 min, arena) at nice 10, `--metrics-discard 10` | F: p50 ≤ 1.5 ms, share of ticks > 4 ms ≤ 1% (one retry), no GC pause > 8 ms. L (run window after the discard): p50 ≤ 1.5 ms, p99 ≤ 4 ms, max GC ≤ 8 ms, heapUsed + external ≤ 150 MB (RSS reported); host gate fails with a reason above 0.5 load per core |
| NET-10 | F `net-10-abuse.test.ts` | (a) fake clock: honest client + raw attackers (random bytes, wrong channels, out-of-state, hostile ticks/acks, bad pitch/axes, spare bits, in-range yaw spam, INPUT floods at 3× and 10×, reliable flood, HELLO flood, CMD spam, wrong rcon, silent session, a socket that never sends HELLO); an honest client after a 3 s stall. (b) real ws via `@game/server/node` with lowered timeouts via config: a 2049 B frame, a > 16384 B frame, a text frame, a 1300 B INPUT, no HELLO, a reliable flood, 20 connections from one injected non-loopback address, 20 simultaneous upgrades from one address against `sv_maxPerIp` 8, rcon lockout across reconnects; from inc. 17 also unknown paths and query strings (404), N simultaneous upgrades at `sv_maxTotalClients` (503), and an upgrade to a match removed mid-handshake (1001) | Each attacker KICKed with a reason and the slot freed: malformed ≤ 6 packets; floods by the §2.13 formula (3× ≤ 5 s, 10× ≤ 1.2 s, reliable ≤ 1.2 s); silent at exactly 300 ticks; no-HELLO at 120; handshake at 600 (exact checks in (a) only). Simultaneous upgrades: exactly the limit admitted, the rest refused. Yaw spammer not kicked. Honest clients: 0 corrections, 0 extra starved, 0 strikes; the stall fill not struck. Queues bounded; the server keeps serving |
| NET-12 | F smoke (60 s) + Lg full (5 simulated min) `net-12-late-join` | MultiHarness: 8 bots on arena at wan-100-loss1, late join at 10 s, disconnect + new HELLO into the same slot at 30 s | Late joiner's first snapshot full with every entity; after reconnect others see removed then new with a new teleportSeq (one snap), and the rejoined client gets a full snapshot; digest equality at every snapshot tick; `unreconciled()` empty; 0 strikes |
| 16 + 1 | L `load-16-plus-1.load.ts`; `pnpm bots --count 16 --profile wan-100-loss1 --minutes 2 --map arena_greybox --human --strict`; manual | Built server (default `sv_maxClients` 32, no flag) + 16 bots + headless Chromium (all generators nice 10) | Human joined (players 17, `remotes` = 16); `expectHealthy`; `remoteJumps` 0 on non-long frames; interpDelay 2–6; server p99 ≤ 4 ms, GC ≤ 8 ms; bots PASS. If contention skews p99, repeat without `--human` and judge the legs separately (documented). Mustafa's manual run (`pnpm dev:server`, `pnpm bots --server …`, his browser) goes in the handoff |

### Other tests
- **Harness:** `MultiHarness` (up to 64 clients, heap timers, per-client NetSim and frames, attacker endpoints, per-session bytes, digests against the server's sent frames); `NetHarness` facade so NET-03/04 run unchanged.
- **Transport contract** (loopback, Port mocked, real localhost ws): reliable order, both channels, close both ways with reason, oversize refusal, receive caps, NetSim over WS. `WsTransport` with a fake ws: backpressure drop and close, inbox caps, zero-length oversize marker.
- **Real-ws integration** (F): one `ClientSim` over Node's WebSocket to the in-process server on lan for 3 s, judged by the e2e prediction-health rule (corrections only on starved snapshots after long frames).
- **Server:** `TickHistogram` vs a reference sort; buckets and `StrikeScore`; timeouts by ticks (off in Worker); starved-cmd neutralisation after 30 ticks; spawn round-robin (17 over 16); team balance; roster burst and JOIN/LEAVE; `teleportSeq` on spawn; ack-validation table; full on join; rcon right/wrong/disabled/locked and a non-admin `set` refused with the hash unchanged; `rconGuard` backoff; config parser (incl. `match_add`, `--match`, `@<match>` lines); JSON logger; `--metrics-discard`, rcon `metrics reset` (match only) and stdin `metrics reset` (process + all); listener: `noServer` construction, one upgrade handler, 404 for unknown paths; `/status` shape with `maxClients`; 64-slot full (the 65th KICKed "server full"); the default `sv_maxClients` 32 refuses the 33rd; `sv_maxClients` clamped to 37 before inc. 10; smoke on the dist bundle (port 0, Node WebSocket, WELCOME, `listening` carries buildHash, SIGTERM → exit 0 with `shutdown` and the metrics file).
- **Scheduler (inc. 10):** the static bound recomputed from the codec constants (`SNAP_MIN_CAPACITY` 34, full 37, 2 × 34 ≥ 63); the worst-case check against exact sizes (passes at ≤ 36 remotes with no removals, fails at 36 + 6 removals); no size pass and all frames plain while it passes; `lastSent` advanced in bypass, so 37 ↔ 38 crossings under worst motion keep staleness ≤ 2 and every snapshot ≤ 1100 B; exact size functions = encoded bits; **accounting: 63 worst-class records, every one after the cutoff deferred, total ≤ 8800 bits (8704)**; mandatory set (removals, staleness ≥ 2) always included; reused slot left out → "removed" this tick, mandatory "new" next tick; priority order and rotation (no fixed 30 Hz for high ids under sustained pressure); first fit skips and continues; a forced encode failure (test writer with too little capacity) sends nothing, leaves `sentTicks`, `lastSent`, `lastDeferred` unchanged and counts `snapshot_overflow`; mirror copies resolve after chains of deferrals across baselines up to 63 ticks old; mirror pool reuse on reconnect; no mirror allocated in a 32-player match (heap check); mirrors allocated for present sessions when `sv_maxClients` is raised above 37.
- **Several matches (inc. 17):** via `@game/server/node` on port 0: matches `a` (arena_greybox) and `b` (movement_lab), 3 clients each by path; WELCOME map per match; client ids 0–2 in each; no snapshot in `a` lists a player of `b`; `/status` lists both; log lines tagged; per-match and process metrics; rcon `metrics reset` in `a` leaves `b`'s and the process windows unchanged; a forced loop stall logs one `tick_drop` naming both matches; unknown name 404; `sv_maxTotalClients` 5 → the 6th gets 503, also with simultaneous upgrades; a full match KICKs; `match_remove b` kicks with "match closed" and `a` is unaffected; an upgrade completing after `match_remove` closes 1001; the last match cannot be removed; `@b status` routes; rcon in `a` changes `a`'s block hash only; demo files named per match; a determinism check: two matches ticked in one set give the same digests as each ticked alone.
- **Client:** `WebSocketTransport` with a fake socket; `SnapshotStore` (baseline lookups, eviction, 8-drop rule, live SPECTATOR dropped, deferred copies and pending slots); `RenderClock`/`InterpDelay` (windowed max, p95, hysteresis, slew, past-newest floor, snap, deferLag incl. a deferred copy carrying an old baseline stamp while deferLag stays 1); `RemoteInterpolator` (clamp, short arc, teleport by teleportSeq, a re-sent "new" with the same teleportSeq does not snap, per-slot samples by stamp, deferred never hidden, pending appears at first sample); clock units (asymmetry, deadband, cap, lagged plant with the real EWMA and windows plus RTT); predictor `SNAPSHOT_TELEPORT` (not counted, stale snapshot does not double-snap, seeded from first); map-provider flow; `keepalive()`; CHEAT gating; registry refuses REPLICATED+CHEAT; netgraph lines; `players.ts` (colours, placement, crouch blend, 64 instances); `view-frame-allocation` with 16 remotes; a native-ESM `playersUpdate` workload (16 remotes, team changes, crouch blends, visibility toggles on a headless Three.js scene, no WebGL); hidden-tab tests on the Node path (session survives, player stops within 30 ticks) and the Worker path (unchanged); demo follow cycling (wrap, skip absent, auto-advance on leave, refused outside playback).
- **Bots:** the runner refuses a count above `/status` `maxClients` (before inc. 10: above 37, 36 with `--human`) with the message; the server child passes `sv_maxClients` only above 30 bots.
- **Primer:** inertness (MV-19 digest and a 1000-tick match digest identical with and without; no registry, PRNG or event state touched) in F; the no-retry multi-process guard and the coverage guard in Lg (§2.11).
- **Allocation (native ESM),** 0 GCs and < 64 KB: `deltaCodec` (16-player, rotating baselines, hostile deltas; from inc. 10 also 64 slots with deferred lists and pending slots); `snapshotSchedule` (inc. 10: `WorldHistory` + 63 mirrors with rotating acks and worst-motion frames through the worst-case check, scheduler and encoder, no pmove); `matchMulti` (4 clients + a reconnect every 4096 ticks; warm-up 1.6e5 player-ticks, measured 2e4 player-ticks; child ≤ 6 s against the 30 s timeout, checked in inc. 9); `interp` (16 remotes incl. extrapolation, traces, teleports; from inc. 10 also 63 remotes with deferred samples); `wsTransport` (inbox with preallocated fake Buffers; boundary allocation measured and documented); `playersUpdate`. Placement by the §2.16 rule.
- **Bench** (`docs/10` §4.4, with the new workload recorded each time it changes so the 20% rule compares like with like): snapshot build per client ≤ 50 µs (16 players); 64-player worst-motion build with the scheduler (report); codec "typical snapshot" = 16-player full v2 (inc. 4) then 16-player delta (inc. 8), ≤ 30 µs; interp frame (16 and 63 remotes, report).
- **Load (reported, inc. 18):** one 63-bot match at wan-100-loss1 (tick p99, deferral share, max staleness, bandwidth) and 4 matches × 16 bots (pass p99, per-match p99, dropped ticks). Not gated; numbers in `docs/10` §4.
- **e2e (Chromium):** `connect.e2e.ts` (inc. 2; built server child + page at `?connect=`); `multiplayer.e2e.ts` (inc. 7; + 4 bots; 4 capsules, `remoteJumps` 0, netgraph interp; server tick time from inc. 15). Worker cases unchanged. `resyncLog` for the M2 loaded-run carry-over; a repeated loaded run (N = 18, 2 cores busy) recorded in the handoff. The e2e setup builds the server bundle.
- **Demo:** record 60 s of a 4-bot harness match into a memory sink, replay via `DemoPlayer`: every frame digest equals the server's; a 64-player recording stays ≤ 2048 B per record and replays exactly; header golden; truncated/corrupt files refused by `validateDemo`; record names: `../x`, `/abs`, `a/b`, empty and 65-character names refused with a PRINT, a valid name lands inside `demos/`, an existing name gets a suffix; `?demo=` smoke with a `BracketRight` press switching the followed id; `pnpm demo-info` on a recorded fixture (text and `--json` goldens; a corrupt file exits 1 with the reason).
- **Guards:** acceptance-ids M3 entry with tiers (§2.16), pending emptied by close; `scripts.test.ts` (`bots` real, `test:long`, `test:load`, `demo-info`, stub sentence, README); match-purity allows `./node`; licenses `ws` row; doc goldens (protocol v2, client cvars with flags, console and binds, server cvars); build-hash agreement.
- **Time reporting:** every increment reports `pnpm test` wall and CPU-s and `test:long` wall.

## 6. Increments

Each increment: an implementer, 4–5 review lenses (spec, correctness, determinism and performance, tests, plus `netcode-reviewer` on every networked increment and `movement-reviewer` on 11 and 12), an integrator. Each ends with `pnpm typecheck && pnpm lint && pnpm test` green (plus `test:net`, `test:long` and `test:browser` where touched), its doc and decision-log edits, and a commit and push. A bots run is re-recorded from increment 6 on.

| # | Commit | Contents | Green when | Mustafa can try |
|---|---|---|---|---|
| 1 | `feat(server): Node dedicated server over WebSocket` | `ws` + `@types/ws`, LICENSES, esbuild banner/externals; `MSG_CHANNEL`; `transport/` (`noServer` listener, one upgrade handler, path `/`); `node/` (main, host, config, `server.cfg`, logs, maps, build hash, stdin console, shutdown, `/metrics`, `/status` with the matches array, `./node` export); `scripts/build-hash.mjs`; `TickHistogram`. Protocol v1. D-029, D-030 (server) | `WsTransport` fake-ws suite; raw Node WebSocket handshake; unknown path 404; JSON smoke on dist; licenses, purity, scripts guards | `pnpm dev:server` prints JSON lines; `/status` answers |
| 2 | `feat(client): connect to a Node server` | `WebSocketTransport` + `SocketLike`; contract suite on real sockets; `provideMap`, READY gate, bundled map URLs; `?connect=`, `?net_profile=`, `connect`/`disconnect`; `sv_strictBuild`; real-ws integration (3 s); `connect.e2e.ts`. D-030 (client), D-031 | Contract suite; integration; build-hash agreement; e2e | Browser at `?connect=ws://localhost:28700`: play alone on arena_greybox |
| 3 | `test(tools): multi-client harness, test tiers and the M3 acceptance guard` | `MultiHarness`, facade; `vitest.long.config.ts`, `test:long`, CI step; acceptance-ids M3 with tiers (all pending); time + CPU reporting; v1 16-client baseline. D-032 | NET-03/04 unchanged; baseline passes; budgets recorded | (no visible change) |
| 4 | `feat(shared,server,client): protocol v2 full snapshots with the entity list` | `PROTOCOL_VERSION` 2; `WorldFrame` (64 slots, stamps, masks), `FrameRing`, `ENTITY_FLAG_MASK`; `MATCH_MAX_CLIENTS` 64 moved to shared; full v2 codec (delta and DEFERRED refused); `sv_maxClients` default 32, clamped to 37, ids below the effective cap; header teleportSeq; "new" records; live SPECTATOR drop; `SnapshotStore`; prediction from the local slot; codec bench = 16-player full; docs/01 O-8 status. D-033 (full forms), D-034 (cap), D-035 (codec) | NET-01 full cases; goldens 862 B; protocol-docs golden (delta rows and DEFERRED marked refused); NET-03 0 corrections; 33rd player refused at the default | (no visible change) |
| 5 | `feat(server,client): spawns, teams, teleport counter and capsule players` | Spawn rotation, team balance, pmove events into entity history, `Match.respawn`, predictor `SNAPSHOT_TELEPORT`; `render/players.ts`, team colours; `playersUpdate` workload. D-034, D-035 | Spawn/team tests; teleport snap with the spawn snapshot dropped; teleport not a correction; workload 0 GCs | Two tabs see each other as orange/blue capsules (jerky) |
| 6 | `feat(tools,server): headless bots, server metrics and the load baseline` | GC observer, metrics line, `--metrics-out`, `--metrics-discard`, `metrics reset`; `tools/src/bots` (CLI, runner, routes, walk, server child with `sv_maxClients` only above 30 bots, count checked against `/status` `maxClients`, build hash from server, summary; `--human` stub); `RouteInput`/`RandomWalk`; NET-09 proxy; `bots` stub removed; first baseline in `docs/10` §4. D-036 | Route tests (laps, < 5% stuck); CLI incl. count refusal; summary golden; NET-09 proxy; a 2 min 16-bot run writes JSON + md | `pnpm bots --server ws://localhost:28700 --count 8` while playing |
| 7 | `feat(client): remote entity interpolation (NET-05)` | `RenderClock`, `InterpDelay`, `RemoteInterpolator` (per-slot samples by stamp, snaps keyed on teleportSeq), crouch blend, cvars, stats; `interp` workload; `multiplayer.e2e.ts`. D-037 | NET-05 (F + Lg 16); `interp` 0 GCs; view-frame guard with 16 remotes; e2e | Smooth bots and tabs at `net_profile wan-150-loss2` |
| 8 | `feat(shared,client): delta codec and snapshot store (NET-02 unit)` | Delta local block and entity records; store baseline resolution; ack = newest stored; 8-drop rule; `deltaCodec` workload; codec bench = 16-player delta. D-033 (delta), D-038 (codec) | NET-01 delta cases; goldens 942 / 1088 B; NET-02 (a) | (no visible change) |
| 9 | `feat(server,client): delta snapshots in the match (NET-08, NET-12)` | `WorldHistory`, sent ring, ack validation, server baseline choice; `matchMulti` workload; snapshot-build bench; NET-05 re-run on deltas; bots re-measured. D-038 | NET-02 (b) F + Lg; NET-08 (a); NET-12 F + Lg; NET-04 16-client F + Lg; bench ≤ 50 µs | Same play at ≈ 16 KB/s instead of ≈ 28 KB/s |
| 10 | `feat(shared,server,client): snapshot byte-budget scheduler for 64 players` | DEFERRED flag + deferred-id list, pending slots, `EntitySource`/`MirrorView`, lazy `ClientMirror` pool (only above 37), `lastSent` (also in bypass)/`lastDeferred`, per-client worst-case check with removals, `SnapshotScheduler` (exact reserved accounting, mandatory set, reused slots as "removed", rotation, first fit), commit-on-success and `snapshot_overflow`/`sched_overrun` counters, static bound; `sv_maxClients` range 1–64; deferLag in `InterpDelay`; deferred stats and metrics; `snapshotSchedule` workload, `deltaCodec`/`interp` 64-slot cases; 64-player bench; a 63-bot run recorded (reported, not gated). D-046 | NET-01 deferred cases and goldens; NET-02 (a) 64-slot, 43 → 37 and crossing, and (c) F + Lg; NET-05 64-player leg incl. late joiner; NET-08 (b) 0 deferrals at 32; scheduler units; workloads 0 GCs | `pnpm dev:server --set sv_maxClients=64` and `pnpm bots --server ws://localhost:28700 --count 62` while playing: a full server stays smooth |
| 11 | `feat(client): asymmetric hybrid time dilation (NET-07)` | Controller + coarse steps, scaled accumulator, holds only at +6; 83–125 ms frame model; cap/hitch trial; `resyncLog`; NET-04 M2 blocks re-baselined. D-039 | NET-07 incl. control; every NET-04 block; cap/hitch outcome recorded | `net_profile wan-50` → `wan-150-loss2` mid-run: no glide |
| 12 | `feat(shared,server,client): deterministic pmove primer with a late-branch guard` | Primer world/script, `primePmoveOnce`, hooks with opt-out, inertness, no-retry child mode, `primerServer`/`primerClient` + controls, coverage guard. D-040 | Inertness (F); guard and coverage (Lg); budgets hold | Startup line shows primer time; no first-stairs GC |
| 13 | `feat(server,client): rate limits, strikes, timeouts and keepalive (NET-10)` | Buckets, strikes, size check, hello/handshake/idle timeouts, neutral cmd, input-loss metric, listener limits (`sv_maxPerIp`, origins, in-flight counted), client timeouts, `keepalive()`, hidden-tab chain; `wsTransport` workload; server-cvar doc golden. D-041 | NET-10 (a) + (b) incl. simultaneous upgrades per IP; stall fill not struck; hidden-tab tests | Close a tab: capsule leaves after 5 s; a hidden tab stands still |
| 14 | `feat(server,client): rcon authorization, sv_cheats and CHEAT client cvars` | rcon + lockout, `status`/`kick`/`metrics reset` (match-scoped; process reset stdin only); replicated `sv_cheats`, re-pinned hash, CHEAT flags, registry assert; `docs/06` tables. D-042 | rcon and lockout tests; reset scope; CHEAT gating; doc goldens | `set cl_thirdPerson 1` refused on Node; `rcon set pm_gravity 400` works |
| 15 | `feat(shared,server,client): EVENTS channel and the full netgraph` | `MSG_EVENTS`, roster burst, LEAVE, SERVER_STATS; `reportTickStats` (Node, Worker); 7-line netgraph; join/leave notices; NET-01 EVENTS cases. D-043 | EVENTS round trips; netgraph units; e2e HUD shows server tick time | Netgraph shows interp delay and server tick time |
| 16 | `feat(server,client,tools): demo recording, playback with player cycling, and demo-info` | Recorder (≤ 64 entities, 2048 B cap), Node writer with name validation and confinement, `record`/`stoprecord`/`sv_autoRecord`; `validateDemo`, `DemoPlayer`, `?demo=`, `demo`, `follow`, `follownext`/`followprev` + `[`/`]` binds, HUD line; `pnpm demo-info` (+ CLAUDE.md row, scripts pin). D-044 | Record → replay digests (4 and 64 players); format golden; corrupt refused; traversal names refused; `?demo=` smoke with cycling; demo-info goldens and exit code; console/binds goldens | `rcon record`, play, `rcon stoprecord`, open `?demo=…`, press `]`; `pnpm demo-info demos/<file>` |
| 17 | `feat(server): several matches per server process` | `MatchSet`, path routing `/m/<name>` (404 otherwise), re-lookup after the upgrade (1001), `match_add`/`match_remove`/`matches`, `--match`, `@<match>` lines, per-match registries, ids, logs, histograms, mirror pools, `/metrics`, `/status`, demo names; `tick_drop` naming every match; `sv_maxMatches`, `sv_maxTotalClients` (503, in-flight counted); bots `--server …/m/<name>`. D-047 | Several-matches suite; config parser; NET-10 (b) 404/503/1001 cases; NET-09 proxy unchanged with one match; server-cvar doc golden | `pnpm dev:server --match main=arena_greybox --match lab=movement_lab`; tabs at `?connect=ws://localhost:28700/m/lab` and `/` |
| 18 | `test(tools): load project (NET-09, 16 bots + 1 human) and the CI load job` | `vitest.load.config.ts`, `test:load`; bots `--human` (hash check, joined check, nice); host gate; reported legs (63-bot match, 4 matches × 16 bots); CI `load` job; pending emptied. D-045 | `pnpm test:load` passes locally (gated legs) and records the reported ones; `pnpm bots … --human --strict` passes; pending empty | `pnpm test:load`; the manual 16 + 1 run |
| 19 | `docs: M3 review fixes, load check, net-check and handoff` | Full close-out like M1/M2: fresh-clone run; `netcode-reviewer`, `movement-reviewer`, `perf-auditor`, `clean-room-auditor`, client, tests, spec/docs lenses; skeptic verification; fixes; 2 min 16 + 1 `--strict`; `pnpm bench`; `/net-check`; `docs/09` M3 ☑; `docs/10` §4; handoff with "Try it"; PR to main opened with auto-merge on (merge method: merge commit), so it merges once CI is green | All recorded; CI green | — |

## 7. Risks

| Risk | Mitigation |
|---|---|
| Real WS differs from loopback (coalescing, backpressure, buffer retention) | Increments 1–2 first; contract suite on real sockets; copy on send; noDelay confirmed; bucket 240; fake-ws backpressure tests; NET-10 (b) |
| Listener misconfigured so routing and limits are skipped | `noServer` construction (ws refuses `server` + `noServer`); one upgrade handler does every check before `handleUpgrade`; in-flight upgrades counted; 404/503/1001 and simultaneous-upgrade tests |
| Delta/baseline desync | One shared history = what was encoded; serial-driven "new"; NET-02 with impairments + `baseBack === T − ack` + delta share; NET-12 long; canonical decoding |
| Delta silently unused | NET-02 baseBack assertion and ≥ 90% delta share; NET-08 mean ≤ 0.7 × full |
| Deferral desyncs or leaks state (a deferred slot read from the wrong baseline, a chain past the history, a departed player shown in a reused slot) | Deferred rows are copied into the mirror at send time, so no lookup reaches past 64 frames; reused slots left out are sent as "removed"; client frame = sent frame including stamps and pending (NET-02 digests); commit only on a successful encode; the 64-slot worst-class sequence defers every tick under loss/reorder/hostile acks; the storm leg forces deferral in a real match |
| Snapshot over 1100 B (accounting or bypass error) | Out costs reserved up front; worst-case check counts removals; `lastSent` kept in bypass; 63-worst-record, 43 → 37 and 37 ↔ 38 tests; encoder `w.fail` + `snapshot_overflow` counted and asserted 0 |
| Starvation of a remote under the budget | Mandatory inclusion at staleness 2; static bound (2 × 34 ≥ 63) fails the build if the layout or cap changes; NET-02 asserts staleness ≤ 2 for every client, entity and tick; `sched_overrun` asserted 0 |
| Deferral makes remotes judder at 64 players | Per-slot samples by stamp; snaps only on teleportSeq, so pending/new re-sends after a join never snap; deferLag added to the interp delay (0 at ≤ 37 players); rotation keeps update rates even; NET-05 64-player leg incl. the storm and a late joiner |
| 64 players cost too much CPU per tick (64 snapshot builds with a size pass) | Not an acceptance target (NET-09 is 16 bots); O(1) worst-case check skips the size pass at ≤ 37; bench and the 63-bot run report it; fallback: memoise per-entity diffs shared by clients with the same baseline tick, then relevance (M9) |
| Mirror memory | Mirrors only in matches above 37, per session from a pool, ≈ 156 KB each (≈ 10 MB at 64); none at the default 32 (heap check) |
| 32 players near the downstream budget (≈ 30 KB/s vs 32) | Reported by NET-08 (b); the `docs/05` §9.2 budget is defined for 16 players; relevance (M9) cuts it |
| Dilation regresses NET-03/04 | Asymmetric controller (slow-down only on the 90-snapshot window); FF kept; NET-04 hitch-model assertions; dilation-off control; cap/hitch only if green |
| Tick p99/GC on a shared 4-vCPU host | Separate processes, nice 10 for all generators, metrics discard, a failing host gate, CPU/wall logged, server histogram as judge; bots from increment 6 |
| `pnpm test` past budget (64-client legs, several-matches suite) | Wall + CPU budget per increment; test tiers and the placement rule; 64-player F smoke kept to 5 s, long legs blocking in CI |
| ws boundary allocations → GC | Short-lived Buffers; NET-09 measures; fallback pooled send ring |
| Several matches interfere (shared loop time, cross-talk) | No shared state; isolation digest test; timing sharing documented; `tick_drop` names every match; per-match and pass histograms; reported 4 × 16 load leg; `sv_maxMatches`, `sv_maxTotalClients` |
| Admin of one match affects another | rcon scoped to the sender's match, `metrics reset` included; process commands stdin only; scope tests |
| Demo file names escape `demos/` | Name pattern, `path.join` + resolved-prefix check, traversal tests |
| Primer misses V8 deopt branches (Node 24 vs 22) | No-retry multi-process guard with control; coverage guard; CI Node 24 runs it |
| Interp judder at low fps | Lateness p95 includes frame quantization; slow-host model; `cl_interpDelay` |
| esbuild bundling CommonJS `ws` | `createRequire` banner; optional deps external; smoke connects to dist |
| Build-hash drift between build and run | Bots take the server's hash; `--human` checks preview vs server and says "rebuild" |
| Bot counts above the server cap | Runner reads `maxClients` from `/status` and refuses with a clear message |
| Bot routes snag on arena | Route tests with stuck bound; stuck detector |
| Hidden tabs | 1 s keepalive; neutral cmd after 30 starved ticks; Worker without timeouts |
| rcon brute force over `ws://` | Disabled unless set; per-IP lockout across matches; wss in M9 |
| Golden hash and protocol docs churn | Doc goldens fail loudly; one change per increment; doc edits split by increment |
| Scope (extras kept in M3) | Each extra has its own increment slot (demo-info and cycling in 16, multi-match in 17) with tests; none blocks the acceptance tests |

## 8. Reader gaps resolved

| Gap | Resolution |
|---|---|
| NET-07 vs ±3%; metric; D-028 interaction; short-window slow-down | D-039 asymmetric hybrid (Mustafa's choice); §2.7 metric; control test |
| Remote timebase | D-037 arrival-based `RenderClock` |
| interpDelay source/window/change; hold after RTT rise | §2.8; past-newest slew floor 0.5; NET-05 hold bounds; deferLag over all stored frames |
| NET-05 criterion on stairs | Bracket-displacement speed term (D-037) |
| Wall clamp; stance blend | `traceBox` while extrapolating; renderer crouch blend |
| Teleport/respawn signal; slot reuse; correction accounting | D-035 `teleportSeq` as the only snap signal, server serial for "new", `SNAPSHOT_TELEPORT` |
| Entity ids, field set, precision | §2.1/§2.2 (u16 ids < 64) |
| Teams, spawns, spectator step | D-034 |
| Size vs cap | "Cap 64, default 32" (D-034): fits by construction while baseline ∪ current ≤ 37 players by id (942 B at 32); otherwise the D-046 scheduler, every snapshot ≤ 1100 B, staleness ≤ 2 ticks |
| Scheduler accounting and bypass | Out costs reserved up front; per-client worst-case check with removals; `lastSent` kept in bypass; commit on success |
| Deferred entities vs deltas, digests, interpolation, removal | D-046: deferred-id list, pending slots, per-slot stamps, lazy `ClientMirror`, digests over stamps, samples by stamp, removal always explicit, reused slots left out as "removed" |
| Delta details; proving deltas are used | D-033, D-038; NET-02/NET-08 assertions |
| 30 Hz degrade | M9 |
| WS specifics, server payload cap, listener construction | D-030 (2048 B server, 16384 B client; `noServer` + one upgrade handler) |
| Bandwidth accounting | D-036; NET-08 (a) acceptance at 16 + 1, (b) reported at 32 |
| 16 + 1 vs `sv_maxClients` | Default 32 covers it; the flag remains only above 30 bots; the runner checks `maxClients`; joined check |
| NET-09 environment, discard, gate, memory metric | D-045, §2.14 |
| NET-10 thresholds and flood timing | D-041 kick-time formula |
| Handshake slot squatting | `sv_helloTimeout` 120 ticks |
| Hidden-tab ghost | Neutral cmd after 30 starved ticks |
| rcon brute force; rcon scope | Per-IP lockout; rcon acts on the sender's match only |
| NET-12 meaning | D-036; digest equality (local slot excludes team) |
| EVENTS, server stats carrier | D-043 |
| Demos and naming | D-044 (cycling, `demo-info` and safe file names included) |
| Several matches: addressing, ids, logs, metrics, limits, timing | D-047 (path `/m/<name>`, per-match everything, one loop with shared timing, reported 4 × 16 leg) |
| Node authorization, CHEAT flags | D-042 |
| Build hash with bots and preview | D-031, D-036 |
| Primer harness | D-040 no-retry multi-process mode |
| Test time and tiers | D-032 |
| Decision/doc timing | Doc edits split per increment |
| Increment size | 19 smaller increments |
| Scope | Kept in M3 (Mustafa): `demo-info` CLI, several matches, key cycling, stdin console, `/status`, `follow <id>`, primer coverage check |
| Human run | Headless Chromium stand-in + the 16-bot `--strict` run close M3; Mustafa's own run is in the handoff's "Try it" |

## Critical files
- `packages/shared/src/net/{snapshot,worldFrame,events,protocol,messages}.ts`; `sim/entity.ts`; `sim/pmove/primer.ts`; `cvars/{registry,serverReplicated}.ts`
- `packages/server/src/match/{match,session,history,mirror,scheduler,spawns,limits,tickStats,demo,commands}.ts`; `src/match/loop.ts` (read: `MAX_CATCHUP_TICKS`); `src/node/*` (incl. `matchSet.ts`, `demoWriter.ts`); `src/transport/{wsListener,wsTransport}.ts`; `build.mjs`; `package.json`
- `packages/client/src/net/{clientSim,clock,connection,predictor,snapshotStore,remotes,webSocketTransport,demoPlayer}.ts`; `render/players.ts`; `app/{boot,game}.ts`; `hud/netgraph.ts`; `console/*` (incl. `binds.ts`)
- `packages/tools/src/bots/*`; `src/replay/{validateDemo,demoInfo}.ts`; `test/net/multiHarness.ts` and `net-0x` files; `long/*`; `load/*`; `test/perf/nativeEsmAllocation.ts`
- `packages/tools/test/guards/{acceptance-ids,scripts,match-purity,licenses}.test.ts`; `test/docs/protocol-docs.test.ts`
- `scripts/build-hash.mjs`, `vitest.long.config.ts`, `vitest.load.config.ts`, `.github/workflows/ci.yml`, `content/LICENSES.md`, CLAUDE.md commands table
- `docs/01` O-8; `docs/05` §1–§4, §6, §8–§10, §12–§14; `docs/06` §2–§3, §6–§8, §10; `docs/10` §1–§4; `docs/11` D-029…D-047
