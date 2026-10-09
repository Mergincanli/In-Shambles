# 06 — Engine Architecture

> Our own Quake-3-style engine for the browser. **From scratch** where the feel lives: movement, collision, netcode, hit registration, console/cvars, map compiler. **Proven libraries** where nothing is gained by reinventing them: Three.js rendering, Web Audio, Vite, Vitest.

## 1. Goals and constraints

- One TypeScript codebase. The shared simulation runs in Node (server), a Web Worker (local server) and the main thread (client prediction).
- Deterministic fixed-tick simulation (`docs/05`). Renderer and UI are read-only consumers of simulation state.
- Browser-first: fast startup, small downloads, no plugins. Works in current Chrome, Edge, Firefox and Safari.
- Data-driven content (weapons, items, modes, names) so balance and naming changes don't need code changes.

## 2. Stack (decision D-002)

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict) | `noUncheckedIndexedAccess` on in `shared` |
| Monorepo | pnpm workspaces | packages `@game/shared`, `@game/server`, `@game/client`, `@game/tools` |
| Client build | Vite | ES modules, worker bundling |
| Server runtime | Node.js (current LTS) | `tsx` in dev, esbuild bundle for prod |
| Tests | Vitest | headless sim tests run in Node |
| Lint/format | Biome | one tool, fast |
| Rendering | Three.js | `WebGLRenderer` first (broadest support; matches the FORGE look-dev sandbox); keep render code isolated so `WebGPURenderer` can be adopted later |
| Transport | `ws` 8.x (MIT; Node server only) + the native WebSocket in browsers and Node clients (bots) | D-030; WebTransport later (M9) |
| Validation | zod (content loading only, never in hot paths) | |
| Audio | Web Audio API | HRTF panning |

**Dependency policy:** MIT/BSD/Apache-2.0/ISC/MPL-2.0 only in shipped code; no GPL/AGPL (decision D-001). Every new dependency needs a one-line justification in the PR/handoff.

## 3. Module map

```
packages/shared/src/
  time.ts              TICK_RATE, TICK_DT, tick math
  math/                vec3 (Float64Array, out-params, per-module scratch), plane, aabb,
                       quant (quantizers), dtrig (deterministic sin/cos, u16 table), angles (D-016)
  rng/                 mulberry32, hash32 (seeding: match/shooter/tick/shot)
  cvars/               registry, flags, version counter, defaults from docs
  debug/               DEV_ASSERT / setDevAsserts (dev-only checks behind a runtime flag)
  world/
    cmap.ts            compiled map format v1 (docs/07 §2): types, validating decodeCmap → CmapError,
                       buildCollisionWorld (f32 planes widened to f64, BVH built at load)
    cmapHash.ts        64-bit contentHash (two Murmur3 lanes; identity and caching, not security)
    canonicalJson.ts   the cmap JSON's canonical form: the encoder writes it, the decoder requires it
    collisionWorld.ts  typed-array brushes (planes, faces then bevels, contents, bounds)
    shapes.ts          plane sets: box, box rotated about Z, axis-aligned wedge
    polygonize.ts      planes → welded, validated face polygons (build time)
    brushValidate.ts   brush build errors, thresholds and the topology/geometry checks
    brushBuild.ts      polygonize + axial bevels + bounds (build time)
    bvh.ts             static BVH over brush bounds: binned SAH, built at load, depth-first typed arrays
    trace.ts           traceBox / traceRay → TraceResult {fraction, endpos, plane, contents, entity, startSolid, allSolid};
                       positionTest, pointContents, boxContents, snapOrigin (ε = 1/32, D-017); queries walk the
                       BVH and match their brute-force references (traceBoxBrute, …) bit for bit
    contents.ts        SOLID, PLAYERCLIP, WATER, LADDER, SLICK, NODAMAGE, TRIGGER, NODRAW; SURF_* flags
  sim/
    entity.ts          ENTITY_NONE (−1), ENTITY_WORLD (32767), MATCH_MAX_CLIENTS (64), TEAM_*,
                       ENTITY_FLAG_MASK (D-034)
    hull.ts            player hulls (docs/03 §2)
    playerState.ts     PlayerState struct + quantize(), PlayerStateRing (128 ticks)
    usercmd.ts         UserCmd struct + sanitize(), BUTTON_* bits
    pmove/             cmdScale, friction, accelerate, walk, air, water, ladder, slideMove,
                       stepSlideMove, groundTrace, crouch, jump  (docs/03 §4); the pipeline
                       (pmove.ts, D-023) and a trace log for debug draw (debug.ts)
    urt/               sprint, stamina, wallJump, powerSlide, ledgeGrab, fall, goomba, kick (docs/03 §5)
    events.ts          movement events ring
  combat/
    weapons.ts         weapon runtime state machine (idle, firing, burst, reload, bolt, zoom)
    damage.ts          table lookup, armor substitution, bleeding/limp flags
    hitboxes.ts        pose(stance, pitch, yaw, phase) → zone volumes; ray vs zones
    spread.ts          deterministic cones
    projectiles.ts     grenades, launcher, thrown knives
    medic.ts           bandage/heal rules
    loadout.ts         slot legality (docs/04 §9)
  game/
    entities.ts        typed entity store (ids, kinds, component arrays)
    rules/             mode plug-ins: ffa, tdm, survivor, ctf, trials (interfaces only in shared)
  net/
    bitstream.ts       BitWriter/BitReader: LSB-first, explicit widths, sticky error flag (D-026)
    protocol.ts        PROTOCOL_VERSION, MSG_* type ids, MSG_CHANNEL (type → channel), packet,
                       client-message and text size limits
    messages.ts        message structs + encodeX/decodeX (docs/05 §3.6) but SNAPSHOT; readTick/writeTick
    snapshot.ts        SNAPSHOT v2: SnapshotHeader, encodeSnapshot, decodeSnapshotHeader/Body, full and
                       delta forms against a baseline frame, exact size functions localBlockBits and
                       entityRecordBits, the size constants and their static checks (D-033, D-038)
    worldFrame.ts      WorldFrame (64 slots as typed arrays, stamps, masks), FrameRing (64 by tick),
                       slot ↔ PlayerState, copySlot, entityEquals, frameDigest (D-034)
    playerStateCodec.ts  the PlayerState bit layout and its decode-time range checks
    cvarBlock.ts       replicated cvar block: canonical encoding, hash, all-or-nothing apply (D-027)
    transport.ts       Transport interface, TransportStats, createLoopbackPair (pooled; D-026)
    packetQueue.ts     pooled packet copies ordered by due time (loopback, NetSim and the
                       WebSocket inbox)
    netsim.ts          NetSimTransport: delay, jitter, loss, duplication, reorder (D-028)
    profiles.ts        NET_PROFILES, the docs/10 §3 table

packages/server/src/
  index.ts             package entry: the match code only (the Worker and tools import it)
  match/               environment-agnostic (tsconfig.match.json: ES2023, no DOM/Node types; D-027)
    host.ts            LoopHost: now, schedule, log (the Worker or Node adapter)
    loop.ts            accumulator loop: ticks due since start, catch-up cap 5; a late wake
                       yields to the host's I/O before catching up
    match.ts           Match: handshake, sv_maxClients, teams, spawns and respawns, per-tick order
                       (docs/05 §8.1), movement-event history, the world frame captured into the
                       history and the v2 snapshots built from it (deltas against each client's
                       acked tick, D-038; the byte-budget scheduler above 37 players, D-046), CVARS
    history.ts         WorldHistory: the last 64 world frames, shared by every client; the acks'
                       rules (acceptAck, baselineTick, markSent/markUnsent over a client's sent
                       ring; D-038)
    mirror.ts          ClientMirror: the frames a client was sent that left players out, as it
                       holds them; MirrorPool per match (only above 37 players); sentFrame (D-046)
    scheduler.ts       SnapshotScheduler: worst-case check, size pass, exact reserved accounting,
                       priority by staleness and rotation; buildSnapshot: baseline, scheduler,
                       mirror frame, encode, commit on success (D-046)
    session.ts         per-client state, player, team, input queue, sent ring and acked baseline,
                       the scheduler's rows and mirror, counters, admin flag
    spawns.ts          SpawnRotation (info_player_start round-robin in cmap order, origins raised
                       ε) and assignTeam (the team with fewer active players; D-034)
    inputQueue.ts      cmds by tick (64 slots), duplicate/late/early counters
    commands.ts        CMD: set/reset/toggle on replicated cvars, cvars resend
    tickStats.ts       TickHistogram: 2048 × 10 µs buckets + overflow + exact max; 1 s and run
                       windows; p50/p95/p99 without allocating (the host records whole µs)
                       (later: relevance, lag-comp history, rules host)
  node/                the Node host (D-029), exported as @game/server/node for in-process tests:
    main.ts            process entry (pnpm dev:server; bundled to dist/main.js): signals, exit codes
    server.ts          startServer: config → cvars → map → match `main` → listener → loop; /status,
                       /metrics; graceful shutdown
    config.ts          server.cfg (`set` lines; `//` and `#` comment lines) and CLI flags
    serverCvars.ts     SERVER cvars (sv_*, §8)
    host.ts            Node LoopHost (performance.now + setTimeout) and TimedPass (per-match and
                       per-pass tick times, CPU per second, tick_drop)
    metrics.ts         ServerMetrics: GC pauses (PerformanceObserver), memory, wire traffic, run
                       and interval windows; /metrics, the metrics lines, --metrics-out (D-029)
    log.ts             JSON-lines logger
    maps.ts            content/maps/<name>.cmap (or --maps)
    buildHash.ts       the bundle's baked-in hash, else scripts/build-hash.mjs (the page's too,
                       D-031); whether this is the bundle (sv_strictBuild)
    console.ts         admin console on stdin
  transport/           wsListener.ts (http.Server + ws noServer, one upgrade handler, /status and
                       /metrics), wsTransport.ts (WsTransport, D-030); webtransport adapter (M9)

packages/client/src/
  app/                 boot.ts (the local server: fetch movement_lab, start the server Worker, connect
                       over PortTransport; or, with ?connect=, a WebSocketTransport to a dedicated
                       server and the map its WELCOME names (D-031); the net simulator at
                       ?net_profile=; build the scene, start the frame loop), maps.ts (every
                       content/maps/*.cmap as a bundled ?url asset, fetched by name and checked
                       against WELCOME's hash), game.ts (the frame loop, the view pose, the autotest
                       status), params.ts (the ?autotest=1, ?bot=, ?cam=, ?connect=, ?net_profile=
                       URL hooks; server addresses), settings.ts (ARCHIVE cvars and binds saved in
                       localStorage, §6); later routing (menu ↔ match)
  net/                 DOM-free (tsconfig.net.json), exported as @game/client/net for tests and bots:
    clientSim.ts       ClientSim: one frame = poll (reconcile) → clock step → tick accumulator
                       (sample, predict, INPUT) → pings; the map given up front, or the one WELCOME
                       names through onMapRequest and provideMap (D-031); renderOrigin, renderTick,
                       pathShift (the
                       render-tick jump of a clock step or re-anchor); tick-tagged movement events of
                       first predictions (TickEvents, flagged when predicted under such a jump); the
                       CmdSampler interface
    connection.ts      handshake state machine (HELLO → WELCOME → pings and the map → READY →
                       spawn), decoding, channel checks and strikes, INPUT/CMD encoding
    snapshotStore.ts   SnapshotStore: snapshots decoded into a FrameRing of 64 by tick, deltas against
                       the stored baseline frame, newest stored = the ack, missing baselines dropped
                       (8 in a row: ack 0), deferred players kept or pending, counters; a spectator
                       snapshot is refused (D-033, D-034, D-038, D-046)
    predictor.ts       cmd and state rings (128), exact compare, re-simulation with params by tick,
                       pending CVARS params, correction log (32), hard resync (docs/05 §5)
    clock.ts           handshake median RTT, lead, RTT/jitter EWMAs, buffer-health step re-anchoring
                       with the adaptive input buffer (the health's low edge steered to the target)
                       (docs/05 §8.2–§8.3; smooth dilation is NET-07, M3)
    smoothing.ts       RenderOffset (linear decay over cl_correctionSmoothMs), StepSmoother (render-tick
                       time, cl_stepSmoothMs, capped at 32 u), ViewHeight (cl_viewHeightSmoothMs)
    stats.ts           totals and rolling 1 s windows for the netgraph
    cvars.ts           the client's net settings (cl_inputBuffer, cl_correctionSmoothMs, cl_teleportDist,
                       cl_interpDelay, cl_remoteSmoothMs, cl_remoteCrouchBlendMs)
    portTransport.ts   PortTransport over two MessagePort-like ports (the Worker link)
    webSocketTransport.ts  WebSocketTransport over a structural SocketLike (the browser's or Node's
                       WebSocket): channel from the type byte, pooled inbox, close reasons (D-030)
    scriptedInput.ts   StrafeCircuit, MixedInput (?bot= input, NET tests, M3 bots)
    remotes.ts         remote interpolation (D-037): RenderClock, InterpDelay (with the
                       scheduler's defer lag, D-046),
                       RemoteInterpolator (samples by stamp, snaps on the teleport counter,
                       extrapolate ≤ 2 ticks, hold, rejoin), RemoteView (what the renderer
                       draws), RemoteJumpMeter (NET-05's criterion)
  input/               keyboard.ts (keys → binds, KeyboardEvent.code), mouse.ts (raw counts → view
                       angles), pointerLock.ts (unadjustedMovement where offered), sampler.ts
                       (+action states → UserCmd sampling)
  render/
    space.ts           Z-up inches → Y-up meters (ONLY place for conversion; guard:
                       packages/tools/test/guards/client-space.test.ts)
    world.ts           static map meshes: one per cmap render surface, (later) lightmaps
    materials.ts       greybox Lambert materials with procedural grid textures
    camera.ts          first-person camera: Hor+ field of view from cl_fov, pose from the sim
    renderer.ts        WebGLRenderer, scene, hemisphere + directional light, map load/unload
    viewCvars.ts       cl_fov, cl_stepSmoothMs, cl_viewHeightSmoothMs
    players.ts         M3: the other players as capsules in team colours (one InstancedMesh + a
                       facing nub, 2 draw calls); later character models, animation from
                       interpolated state
    teamColors.ts      placeholder team hues (ESTIMATE until docs/08 §5 picks them, M8)
    viewmodel.ts       first-person weapon (separate scene/camera, own FOV)
    fx/                tracers, muzzle, impacts, blood, speed trail, smoke (pooled)
    debug/             debugDraw.ts (r_debugHull, r_debugTraces, r_debugGround); later hitboxes (current +
                       rewound), brushes
  audio/               Web Audio graph, positional sources, footsteps, priorities

  hud/                 DOM overlay. M2: overlay.ts (panels, ≤ 15 Hz), speedometer.ts, netgraph.ts,
                       renderStats.ts (r_stats). Later: crosshair, health/stamina, ammo, wound
                       figure, killfeed, chat, minimap
  console/             console UI (console.ts), commands.ts (cvar and bind commands, DOM-free),
                       binds.ts (bind table, defaults, modifier keys refused), clientCvars.ts
                       (ARCHIVE client cvars)
  worker/              local server entry (runs packages/server match code in a Web Worker;
                       tsconfig.worker.json, WebWorker lib): serverWorker.ts, workerHost.ts
                       (performance.now + setTimeout LoopHost), messages.ts (start, log, error)
  dev/                 vectorsPage.ts: the phone vectors page (D-022), replaying every committed
                       vector table in the browser that opens it

packages/client/scripts/  Node, driving the built client in headless Chromium (Playwright):
  browser.ts           build, vite preview / dev server, SwiftShader launch, status and error readers
  screenshot.ts        PNG screenshots of fixed viewpoints in movement_lab
  png.ts               a minimal PNG decoder for pixel checks
  vectorsPage.ts       builds the phone vectors page as one self-contained vectors.html (D-022)
  singleFile.ts        inlines a Vite page's module script into one HTML file
packages/client/e2e/   pnpm test:browser (docs/10 §2): smoke.e2e.ts (the e2e smoke test on the Worker),
                       connect.e2e.ts (the built client at ?connect= on the built server, D-031),
                       health.ts (the prediction-health rule both judge by), vectors-page.e2e.ts (the
                       one-file vectors page passes from a file URL)

packages/tools/src/
  mapc/                TrenchBroom .map → cmap compiler (M5)
  greybox/             MapBuilder, brush compiler and cmap encoder; code-built test courses (movement lab etc.);
                       cli.ts is pnpm greybox
  vectors/             determinism test vectors for packages/shared/test/vectors (pnpm --filter @game/tools vectors)
  code/                source scanner (code vs. strings/comments) and the D-016 banned-math list, for the guards
  scenarios/           movement scenarios (D-025): runner.ts (real pmove on a course, scripted
                       cmds), bots.ts (hold, hop, strafe bots), course.ts (committed courses as the
                       game loads them), metrics.ts, determinismProbe.ts and probeBuilds.ts (MV-19)
  bots/                pnpm bots (M3, D-036): cli.ts and command.ts (flags, exit codes), runner.ts
                       (N ClientSims on Node's WebSocket, each behind its own NetSim, one 60 Hz
                       timer chain, the count check against /status), routes.ts (the yard ring,
                       60/40 route/walk), serverChild.ts, tap.ts (socket traffic), summary.ts
  reports/             feel-report (M2, feelReport.ts; cli.ts is pnpm feel-report), balance-report
  replay/              demo inspection
  docs/                Markdown section/table parsing for doc-golden tests (BAL-01)
  content/             content-vs-docs helpers (weapon IDs, damage table)
  jsonc.ts             JSON-with-comments parser (tsconfig and config guards)
  paths.ts             repo-root resolution

packages/tools/bench/  pnpm bench (docs/10 §4.4): run.ts (entry), trace.bench.ts (traceBox on
                       movement_lab), pmove.bench.ts (player-ticks), codec.bench.ts (snapshot
                       encode + decode)
```

## 4. Runtime topology

```
DEV / OFFLINE                                  ONLINE
┌──────────── browser ───────────┐   ┌──── browser ────┐        ┌──── Node ─────┐
│ main thread: client            │   │ client          │  WS /  │ dedicated     │
│  ├ predict (shared sim)        │   │  ├ predict      │◄──────►│ server        │
│  ├ render/audio/HUD            │   │  └ render…      │   WT   │ (shared sim)  │
│  └ PortTransport ◄─────┐       │   └─────────────────┘        └───────────────┘
│ Web Worker: server ────┘       │
│  (same match code as Node)     │
└────────────────────────────────┘
```

- **Rule:** there is exactly one gameplay code path. Offline play = local server.
- Server match code must not use Node-only APIs directly. Put those behind small adapters (clock, logging, transport) so it runs in a Worker too.

## 5. Simulation core details

- **Entity store:** id-indexed arrays per component (position, velocity, stance, team, health…), not class hierarchies. Players have a `PlayerState` struct (`docs/03` §6) that is cloned only into preallocated history slots.
- **Collision:**
  - World = convex **brushes** (plane sets). Traces are swept AABB vs. brush, plane-by-plane: entering fractions stop ε = 1/32 u short and leaving fractions are exact (D-017), Q3-style "box vs. planes" by expanding planes by the box extents.
  - Broadphase = static BVH over brush bounds. Players are dynamic AABBs (current state only for movement; rewound poses only for hit rays).
  - Never collide movement against triangle soups; render meshes are not collision.
- **Rays (bullets):** ray vs. brushes (world) → nearest; then ray vs. player zone volumes (lag-compensated) → nearest player hit before the world hit.
- **Events:** sim steps append to small fixed-size rings; the client (presentation) and server (network) consume them.
- **No hidden time sources:** sim functions receive `tick` and `dt` explicitly.
- **Deterministic math (D-016):** only operations ECMAScript rounds exactly (`+ − * /`, `sqrt`, `fround`, `round`, `floor`, `abs`, `imul`, bitwise…). Trig comes from `math/dtrig`, never `Math.sin`/`cos`; `pow`, `exp`, `log`, `atan2`, `hypot` and `**` are banned too. Vectors are `Float64Array`s with out-params and named per-module scratch, not a shared pool, and sim values never pass through a `Float32Array`.

## 6. Cvars and console (Q3-style)

- **Registry** in `shared/cvars`.
  - Each cvar: name, type, default, min/max, description, flags.
  - Flags: `ARCHIVE` (persist client setting), `REPLICATED` (server-owned, sent to clients, used by prediction), `CHEAT` (dev only), `SERVER` (server-only), `LATCH` (applies on map restart).
  - `REPLICATED` cvars must fit the cvar block (`docs/05` §3.5, D-027): names of at most 63 chars, string values of printable 7-bit ASCII up to 255 chars. A client's mirror takes the server's values through `setReplicated`, past its own CHEAT and LATCH rules.
  - A `version` counter goes up on every registration and every value change. The sim copies its tunables into plain structs (`PmoveParams`) only when it moves, so no tick looks a cvar up (M2 design §0).
- **Movement/combat tunables** (`pm_*`, `st_*`, `wp_*` overrides) are `REPLICATED`. The server sends the block on join and on change; the block hash appears in snapshots.
- **Changing a replicated cvar** (D-027): the server owns them, so a client's console `set`, `reset` or `toggle` on a `REPLICATED` cvar goes to the server as a `CMD`. The server applies it if the session is admin (the Worker's one client is; M3 decides authorization on the Node server), replies with `PRINT`, and broadcasts `CVARS` with the effective tick; the client's mirror registry and its prediction parameters switch at that tick (`docs/05` §3.5).
- **Console UI:** toggle with the backquote key (`Backquote` code); Escape also closes it, and both still do when the console's input has lost focus (a click on the view or its output). A held toggle key does not flip it again on auto-repeat. While it is open it owns the keyboard: every bound key is released, and the pointer lock with it. Planned commands: `set`, `toggle`, `reset`, `cvarlist [prefix]`, `bind`, `unbind`, `exec <file>`, `connect`, `disconnect`, `net_profile <name>`, `record`/`stoprecord`, `demo <file>`, `rcon <cmd>`.
- **Implemented in M2** (and `connect`/`disconnect` in M3; `client/src/console/commands.ts`; tokens split at whitespace, double quotes group one with spaces, as the server's CMD parser does):

  | Command | Effect |
  |---|---|
  | `set <cvar> <value>` | a client cvar changes at once (clamped to its range, with a note); a `REPLICATED` one is sent to the server as `CMD` and changes when its `CVARS` arrives (D-027) |
  | `toggle <cvar>` | a bool flips; a number goes to 1 from 0, else to 0; replicated ones as for `set` |
  | `reset <cvar>` | back to the default; replicated ones as for `set` |
  | `cvarlist [prefix]` | each cvar with its flags (`A`rchive, `R`eplicated, `C`heat, `L`atch, `S`erver) and value, then the count |
  | `bind <code> [command]` | shows or sets a key's command: a `+action` or any console line; refuses an empty command, Ctrl/Alt/Meta keys, and taking `toggleconsole` off its last key |
  | `unbind <code>` | removes a key's bind, except the last key bound to `toggleconsole` |
  | `net_profile [name]` | shows, or switches, the client end's simulated link (`docs/10` §3 profiles; the page always wraps its transport in the net simulator, starting at `?net_profile=<name>`, or `lan` when that is absent or unknown, D-031) |
  | `net_corrections` | prints the prediction's correction log (the newest 32, oldest first): each snapshot tick, the newest tick re-simulated, the visible distance and the fields that differed (`docs/05` §5) |
  | `connect [address]` | alone, says where this session plays (a server's address, or the local server); with `ws://host[:port][/path]` (or `host[:port]`; the port defaults to the server's 28700) reloads the page with `?connect=` to play there (D-031). `wss://` comes with deployment (M9) |
  | `disconnect` | leaves the server: the session closes with "left the server" |
  | `clear` | empties the console |
  | `toggleconsole` | opens or closes the console (what Backquote is bound to) |
  | `help` | lists these; a cvar's name alone prints its value, default and description |

  `connect` and `disconnect` came in M3 (D-031); `exec`, demos and `rcon` come with the milestones that need them.
- **Binds** use `KeyboardEvent.code` (physical keys) so AZERTY/QWERTZ layouts work; mouse buttons are `Mouse0`..`Mouse4`. Codes match ignoring case. A `+action` is held while its key is down (a key releases what it pressed even if rebound meanwhile); any other bound line runs once on the press. Bound keys call `preventDefault` (Space must not scroll); presses with Ctrl, Meta or Alt held go to the browser, so those keys cannot be bound (`ControlLeft`/`Right`, `AltLeft`/`Right`, `MetaLeft`/`Right`; a Ctrl crouch would also swallow the movement keys pressed under it). An auto-repeat never runs a command again. One key always stays bound to `toggleconsole`: binds are saved, and without it nothing could reopen the console to repair them. A hidden tab or a lost focus releases every key.
- **Default binds** (M2 design §2; all rebindable). There are no Ctrl binds: the browser keeps Ctrl+W and its kin.

  | Key (`code`) | Bind |
  |---|---|
  | `KeyW` / `KeyS` / `KeyA` / `KeyD` | `+forward` / `+back` / `+moveleft` / `+moveright` |
  | `Space` | `+jump` |
  | `KeyC` | `+crouch` |
  | `KeyX` | `+walk` |
  | `ShiftLeft` | `+sprint` (sent as `BUTTON_SPRINT`; inert until M4) |
  | `Mouse0` | `+attack` (sent as `BUTTON_ATTACK`; inert until combat) |
  | `Backquote` | `toggleconsole` |
- **Saved settings** (`client/src/app/settings.ts`): the `ARCHIVE` cvars that differ from their defaults, and the binds when they differ from the defaults, as JSON under the localStorage key `inshambles.settings` (version 1), saved after each console command that changed something. Replicated cvars are never saved. Missing, throwing or corrupt storage leaves the defaults; unknown or invalid cvar entries are skipped with a console warning; a stored bind set with any invalid entry, or with no key on `toggleconsole`, is ignored as a whole (the default binds stay), and a save that storage refused is retried after the next command. Autotest pages (`?autotest=1`) neither load nor save.

## 7. Client specifics

**Client cvars** (M2 design §4): `ARCHIVE` settings, saved per player and never replicated, so they never reach the simulation (prediction uses the replicated `pm_*` values only, §6). `registerClientCvars` (`client/src/console/clientCvars.ts`) registers them all: the net code's (`client/src/net/cvars.ts`), the view's (`client/src/render/viewCvars.ts`) and the console's and HUD's own. A doc-golden test (`packages/tools/test/docs/client-cvars-docs.test.ts`) keeps this table equal to the registered set.

| Cvar | Default | Label / note |
|---|---|---|
| `sensitivity` | 5 | Q3 default; turn per count = `sensitivity` × `m_yaw` (or `m_pitch`) |
| `m_yaw` | 0.022 | Q3 convention: degrees per mouse count |
| `m_pitch` | 0.022 | Q3 convention: degrees per mouse count; negative inverts |
| `cl_fov` | 90 | ESTIMATE (horizontal, Hor+) |
| `cl_inputBuffer` | 2 | ESTIMATE (ticks; `docs/05` §8.2: target 1–2 ticks); the input buffer the clock keeps at the low point of the buffer health (its low edge over 1.5 s, fast-forwarded below `cl_inputBuffer` − 1) and the handshake lead's buffer; with steady frames the mean health equals it, bursty frames and jitter add their spread (adaptive, at most 8 ticks more; D-028) |
| `cl_correctionSmoothMs` | 100 | ESTIMATE (`docs/05` §5: "~100 ms"); render-offset decay |
| `cl_teleportDist` | 64 | design value (u; `docs/05` §5); a longer correction snaps, and so does a remote player's rejoin offset (D-037) |
| `cl_interpDelay` | 0 | design value (D-037): the remote players' interpolation delay in ticks; 0 sizes it from the snapshot stream (`docs/05` §6), 2–6 fix it (the cvar takes 0–6 and 1 counts as 2) |
| `cl_remoteSmoothMs` | 100 | ESTIMATE (M3 design §2.8); a remote player's rejoin offset decay after extrapolating or holding |
| `cl_remoteCrouchBlendMs` | 100 | ESTIMATE (M3 design §2.8); a remote capsule's crouch and stand-up blend |
| `cl_stepSmoothMs` | 150 | ESTIMATE; step-up view smoothing |
| `cl_viewHeightSmoothMs` | 100 | ESTIMATE; crouch view-height smoothing |
| `cl_speedometer` | off | toggle: the speedometer |
| `cl_netgraph` | off | toggle: the netgraph |
| `cl_thirdPerson` | off | toggle: the camera 120 u (design value) behind the eye, pulled in by a trace short of walls |
| `r_debugHull` | off | toggle: the hull box |
| `r_debugTraces` | off | toggle: pmove's traces |
| `r_debugGround` | off | toggle: the ground normal |
| `r_stats` | off | toggle: the renderer panel (top right: the last frame's draw calls and triangles, live geometries and textures from three's `renderer.info`), for the draw-call and texture budgets (`docs/08` §16, `docs/10` §4.3) |

- **Input:**
  - Pointer Lock. Request unadjusted (raw) movement where supported (`requestPointerLock({unadjustedMovement: true})`), falling back to plain pointer lock where it is refused (Firefox). A click on the canvas takes the lock; mouse buttons route through the binds only while it holds, so that click never fires.
  - Sensitivity in Quake-style units (`m_yaw`/`m_pitch` = 0.022 degrees per count) so players can port their sens: `yaw −= dx · sensitivity · m_yaw`, `pitch += dy · sensitivity · m_pitch`, pitch clamped to ±89°, yaw kept in [0, 360).
  - No mouse smoothing; optional acceleration off by default.
  - The counts gathered between frames turn the view at the start of the next frame, before its ticks sample it. The camera uses these live float angles; each cmd carries them rounded to u16 units (`degreesToU16`), and the predictor sanitizes the cmd as the server does.
  - Buttons and axes come from the `+actions` (§6): an action counts the keys holding it and latches a press until the next sample, so a tap shorter than a tick still reaches one cmd.
- **Camera:**
  - The view applies the latest mouse delta every frame.
  - The eye is the predicted origin interpolated between the last two ticks, plus the correction's render offset, plus the step smoother's offset, plus the stance's eye height (26 u standing, 12 u crouched) smoothed over `cl_viewHeightSmoothMs` (M2 design §2).
  - View height smoothing on step and land events. Steps (M2): while the step's tick is being interpolated the offset cancels the rise, then it decays linearly over `cl_stepSmoothMs`; offsets add up, capped at 32 u. A step predicted inside a clock fast-forward or a re-anchor is left to the render offset, which already holds the drawn position across it, and pending step offsets move with the render-tick clock when it jumps, so neither path drops the eye.
  - FOV setting: `cl_fov` is the horizontal angle at 4:3 and the vertical angle stays the 4:3 one on wider screens (Hor+); narrower screens keep the horizontal angle.
  - The viewmodel is rendered in its own pass with its own FOV and depth range (never clips into walls).
- **Render loop:**
  - `requestAnimationFrame` → step the client tick accumulator (prediction ticks) → interpolate local and remote states → update the Three.js scene from interpolated state → render.
  - Avoid per-frame allocations (reuse vectors/matrices; pool FX objects).
- **Space conversion** (`render/space.ts`): `three.x = q.x × 0.0254`, `three.y = q.z × 0.0254`, `three.z = −q.y × 0.0254`; yaw/pitch mapped accordingly: `setViewAngles` sets Euler order YXZ with `rotation.y = yaw − 90°` and `rotation.x = −pitch` (sim yaw 0 faces +X, positive pitch looks down). The mapping is a proper rotation, so map vertices are converted once at load time (`convertVertices`) and keep their winding. Unit-test the conversions.
- **World (M2):** one mesh per cmap render surface (one per material), `MeshLambertMaterial` with a procedural 256² grid `CanvasTexture` per material (16 u minor and 64 u major lines, repeat-wrapped; uv0 is 1 per 64 u, `docs/07` §3): floor light grey, wall mid grey, `grey/ladder` with rungs, water blue at 0.5 opacity, double-sided, no depth write, anything else magenta. Hemisphere plus directional light, no shadows; geometry, materials and textures are disposed on unload.
- **HUD:** DOM overlay updated imperatively (refs). Crosshair and ammo update immediately; scoreboard and minimap at ≤ 15 Hz. No framework re-render per frame. Menus may use a UI framework later.
  - M2 (`client/src/hud`): a crosshair; a click-to-play prompt while the pointer is free; a blue tint while the camera is inside water (`pointContents` at the camera); the speedometer (`cl_speedometer`: horizontal speed, vertical velocity and ground/air/water/ladder, the mode pmove dispatches on); the netgraph (`cl_netgraph`, bottom right: RTT, jitter, snapshot loss % and snapshots/s; corrections/s with mean and largest size and the render offset left; input-buffer health, its mean and its low edge (the lowest over 1.5 s, which the clock keeps at `cl_inputBuffer` − 1 or more, lifting it to `cl_inputBuffer`, so a mean grown above it shows the spread of bursty frames or jitter; after a re-anchor the last low edge until the window refills), starved cmds/s and clock adjustments; bytes in and out per second; hard and pending-parameter resyncs; the simulated profile; since M3 increment 7 a `remote` line: the interpolation delay in ticks and ms and the share of the last second's remote-frames drawn extrapolated or held, D-037); the renderer panel (`r_stats`). Rates are over the last second; the panels' text refreshes at ≤ 15 Hz. When the session closes (a kick, a refused WELCOME, a version or tick-rate mismatch, refused server cvars) the page's error box shows `disconnected: <reason>`, and the prompt and crosshair stay hidden.
- **Players (M3, `client/src/render/players.ts`, D-034):** every other player is a capsule of the hull's radius (15 u) and height (56 u standing; squashed along the up axis to 40 u crouched), standing on the hull's feet and turned to its view yaw, with a small dark nub at eye height in front showing where it faces; colour by team (placeholders, ESTIMATE: team 1 orange `#d9652b`, team 2 blue `#2b8fd9`, no team grey `#9a9a9a`; `render/teamColors.ts`). One `InstancedMesh` of 64 capsules with a colour per instance and one of nubs sharing its matrix buffer: 2 draw calls whatever the player count, none with nobody visible. The game fills a `RemoteView` (`client/src/net/remotes.ts`) each frame from the remote interpolation (D-037, `docs/05` §6) and the renderer reads only that; a crouch or stand-up blends the capsule's height over `cl_remoteCrouchBlendMs` (at once when the slot appears or teleports). Instance matrices are written by `space.ts`'s `uprightToThree` (`space.ts` stays the only module that turns sim angles into scene rotations).
- **Debug draw** (M2, `client/src/render/debug/debugDraw.ts`): one `LineSegments` with buffers sized once. `r_debugHull` draws the hull box at the drawn origin; `r_debugTraces` the traces of the frame's first predictions from pmove's `PmoveTraceLog` (green when clear, red when they hit, with an 8 u tick along the hit normal; kept while frames predict no tick); `r_debugGround` the ground normal from a short sweep under the predicted state, drawn under the hull's interpolated origin (yellow when walkable, magenta when steep). The segments are built in sim space and converted through `space.ts`.
- **Audio:**
  - Footsteps and gunshots are positional (HRTF) with priority and voice limits. Footsteps are the gameplay-critical sound.
  - Event-driven from predicted (local) and snapshot (remote) events.
- **Assets:**
  - glTF 2.0 (skeletal) for characters and viewmodels.
  - KTX2/Basis textures; meshopt/Draco geometry compression.
  - Lazy-load per map; cache via HTTP caching and a service worker later.

## 8. Server specifics

- One process can host several matches (one tick loop each). Each match is isolated (no shared mutable state). Until D-047 the Node server runs one match, `main`.
- **Config (D-029):** `server.cfg` (`packages/server/server.cfg`; by default the one in the working directory, or `--cfg <file>`): one `set <cvar> <value>` per line, tokenized like the console; lines starting with `//` or `#` are comments (a comment after a value is refused, not read into it). Then the command line, in this order: `--port <n>` and `--map <name>` (shorthands for `sv_port` and `sv_map`), then each `--set <cvar>=<value>`; `--maps <dir>` points at the compiled maps (default: the repository's `content/maps`); `--metrics-out <file>` and `--metrics-discard <s>` (seconds from 0 to 86400, design value: a longer delay would overflow `setTimeout`) shape the metrics run (below). A `set` reaches the server's own cvars (below) or the match's replicated ones (`pm_*`, sent to clients). An unknown cvar, a bad value, one out of range, or `sv_sendBufferClose` not above `sv_sendBufferDrop` stops the server with a ConfigError (exit 1) rather than starting with another setting. Later: map rotation, rcon password (env var).
- **Structured logs (JSON lines, D-029):** one object per line on stdout, `{"t":<ISO time>,"lvl":"info"|"warn"|"error","ev":…, …}`: `server_ok` (`startupMs`, monotonic since process start) and then `listening` (`port`, `buildHash`, `matches`) once the match exists and the port is bound, `connect` (`match`, `client`, `ip`), `log` (the match's own text lines, with `match`), `loop` (the loop's own lines other than drops), `tick_drop` (ticks dropped after a stall: one line per drop, naming every match), `console` (admin console replies), `metrics` (every `sv_metricsInterval` seconds: one line per match, with `match`, and one for the process; below), `metrics_reset` (`reason`: `discard` or `console`), `metrics_written` (`file`), `shutdown` (`signal`), `error`. Later: `welcome`, `ready`, `leave` and `kick` (reason, strikes) as their own events with D-041 (increment 13; until then they are the match's `log` lines), kills.
- **Admin console:** stdin lines run as admin on the match: `set`/`reset`/`toggle` on replicated cvars (the CVARS broadcast follows on the next tick). `metrics reset` starts the metrics run window again for the process and every match (this process-wide reset is stdin's alone; rcon's match-scoped `metrics reset` arrives with D-042).
- **Metrics (D-029, D-036):** tick time p50/p95/p99, players, bytes in/out, starved cmds, full snapshots (each session's first and any sent without a usable ack; the rest are deltas, D-038), GC pauses. Two windows: the **run window** starts at listen, again `--metrics-discard <s>` seconds later, and on the console's `metrics reset`; the **interval window** is the time since the last metrics line. `GET /metrics` serves the run window as `{process:{…}, matches:{<name>:{…}}}`: for the process `uptimeS` (since start), `runS` (the run window's length), `passes`, `droppedTicks` and the loop's yields on late wakes (`loopYields`, D-027) in the window, the loop pass's tick times (`tickUs`, the NET-09 judge; `TickHistogram` µs) and its last closed 1 s window (`lastSecondUs`), CPU ms per wall second over the window (`cpuMsPerWallS`, the process's user + system CPU time since the window began over its wall time), GC pauses (`gc`: count, longest and total ms, from a `PerformanceObserver` on GC entries; `--trace-gc` cross-checks it by hand), memory (`memoryMB`: heapUsed, external and RSS as sampled when read, and the window's peaks `peakHeapExternal` and `peakRss` of the samples the server takes once a second between ticks), connections (now) and the traffic of every match; per match its map, players, server tick, tick times, and in the window starved player-ticks, strikes, snapshots, full snapshots, the byte-budget scheduler's work (D-046: `deferredEntities`, players left out, and `deferredSnapshots`, the snapshots that left any out; `maxStaleness`, the largest staleness of a remote at send since the match started, at most 2; `snapshotOverflow` and `schedOverrun`, both 0 by its bound), kicks and `traffic` (`bytesIn`, `bytesOut`, `kbInPerS`, `kbOutPerS`: payload plus WebSocket framing as the bytes cross the match's sockets, KB = 1000 B). Every `sv_metricsInterval` seconds a `metrics` line per match (players, tick times, starved, strikes, full snapshots, players left out, the largest staleness, snapshot overflows, kicks, KB/s in and out) and one for the process (pass tick times, dropped ticks, GC count and longest pause, memory with the interval's peaks, CPU over the interval, connections, KB/s) report the interval window. `--metrics-out <file>` writes the run window (`/metrics`'s JSON plus `buildHash`) at shutdown. `GET /status` serves `{buildHash, protocol, matches:[{name, map, players, maxClients}]}` (`maxClients` is the cap the match applies: `sv_maxClients`, 1–64, D-034). Later: input loss (D-041).
- **Graceful shutdown (SIGINT/SIGTERM):** between ticks, stop accepting, KICK every client "server shutting down" and close its socket 1001, stop the loop, write `--metrics-out`, wait up to 1 s (design value) for the closing handshakes, then terminate the rest, exit 0.

| Cvar | Default | Label / note |
|---|---|---|
| `sv_port` | 28700 | design (D-029); 0 picks a free port |
| `sv_host` | 0.0.0.0 | design; bind address |
| `sv_map` | arena_greybox | design; `content/maps/<name>.cmap` |
| `sv_maxClients` | 32 | design (D-034, Mustafa's decision: "Cap 64, default 32"); players the match admits, 1–64 (`MATCH_MAX_CLIENTS` slots), client ids the lowest free below it; above 37 the byte-budget scheduler keeps every snapshot within 1100 B and each session gets a mirror of what it was sent (D-046, `docs/05` §4.3); `/status` reports the effective cap |
| `sv_strictBuild` | 1 | design (D-031): a client whose HELLO names another build is KICKed with both hashes; at 0 it gets its WELCOME and a PRINT warning. Run from source (tsx) the server starts it at 0, since a dev page and a dev server compute their hashes when each starts; read when the match is created; the protocol version is always strict |
| `sv_metricsInterval` | 10 | design (D-029): seconds between the `metrics` lines, 0–3600 (0 = none) |
| `sv_sendBufferDrop` | 32768 | ESTIMATE (D-030): bytes waiting in a client's socket past which unreliable sends drop |
| `sv_sendBufferClose` | 1048576 | ESTIMATE (D-030): past this the socket closes 1008 "too slow" (checked every tick); must be above `sv_sendBufferDrop` |

These are SERVER cvars, read at startup and never replicated.

## 9. Performance rules (enforced by `perf-auditor`)

- **No allocations** in per-tick sim or per-frame render paths: preallocate, pool, use out-parameters, use typed arrays for hot data. Avoid closures and `Array.prototype.map/filter` in hot loops.
- **Avoid megamorphic object shapes** in hot structs: initialize all fields in constructors and keep field order stable.
- **Measure, don't guess:** a sim benchmark harness (`pnpm bench`) for pmove (target ≤ 5 µs per player-tick), trace (target ≤ 1 µs per box trace on the lab map) and snapshot build.
- **Rendering:**
  - Merge static world geometry by material.
  - Instance repeated props.
  - Cap dynamic lights; shadows only where art direction requires and budget allows.

## 10. Errors, logging, diagnostics

- Shared sim never throws in normal operation. Invalid states are asserted in dev builds (`DEV_ASSERT`) and clamped in prod.
- **Client:** error overlay in dev; telemetry endpoint later (M9).
- **Repro captures:**
  - `record`: cmds + snapshots, for prediction bugs.
  - `demo`: server view.

## 11. Scripts and CI (created in M0, extended later)

- `pnpm dev`, `pnpm dev:server`, `pnpm build`, `pnpm test`, `pnpm test:long` (M3, D-032), `pnpm test:movement`, `pnpm test:net` (each the fast tier, then the long tier with the same `-t` filter, D-032), `pnpm test:balance`, `pnpm test:browser` (M2), `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm greybox` (M1), `pnpm bench`, `pnpm bots`, `pnpm feel-report`, `pnpm balance-report`, `pnpm mapc` (M5).
- **CI** (GitHub Actions, `.github/workflows/ci.yml`): typecheck, lint, unit tests and build since M0. Since M2, a `browsers` job replays the determinism vectors in Chromium, Firefox and WebKit (D-022) and runs the client e2e smoke test in Chromium (M2 increment 11). Since M3 the `check` job runs `pnpm test:long` right after `pnpm test`, blocking (D-032). Added in M9 (bots exist from M3): a short bot soak (2 min, 8 bots, `wan-100-loss1`) and bundle-size/perf budget checks.
