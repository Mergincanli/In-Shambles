# M3 plan: real networking

> **Status:** the M3 implementation plan as Mustafa approved it (2026-10-07), kept so that citations such as "M3 plan, increment 6" resolve. It is a record, not a spec: the numbered docs and the decision log win where they differ. The design it builds on is `docs/design/M3-design.md`.

## Context
M2 is merged: you can play alone in the browser against a server in a Web Worker, with prediction.

M3 makes it real multiplayer. A Node server runs the match. Browsers and headless bots connect over WebSocket. Remote players move smoothly. Sources: `docs/09` M3 and the M3 prompt.

**Acceptance (`docs/09` M3):**
- NET-01, 02, 04, 05, 07, 08, 09, 10 and 12 pass.
- NET-08 measures bandwidth, even though relevance comes later.
- 16 bots + 1 human on `arena_greybox` at `wan-100-loss1`: smooth remotes, server tick p99 ≤ 4 ms.

**Out of scope:**
- combat;
- relevance culling (M3 sends everything, within the byte budget);
- WebTransport;
- `wss://`, bans and accounts (M9);
- a 30 Hz snapshot fallback (M9).

**Your answers (binding):**
1. **Dilation:** hybrid. ±3% for small errors, M2's fast-forward steps for big ones (D-039).
2. **Player cap: "Cap 64, default 32".** Up to 64 players per match; `sv_maxClients` defaults to 32. Above 37 players a snapshot can be too big, so a byte-budget scheduler sends some players every other tick instead (D-046).
3. **Human run:** a headless Chromium player stands in. Your own run goes in the handoff's "Try it".
4. **Scope:** the extras stay in M3: `pnpm demo-info`, several matches per server process, and `[`/`]` to switch players in demo playback. Also kept: the stdin admin console, `/status`, `follow <id>` and the primer coverage check.
5. **Auto-merge** is on for the repository.

**Your choices (from M2, kept):**
- Commit and push each green increment and keep going. Report at the end.
- Each increment: one implementer, 4–5 review lenses, one integrator.
- A full end-of-milestone review, like M1 and M2.
- At the end, a PR to `main` opened with auto-merge on (merge commit). It merges once CI is green.

**Branch:** `claude/blissful-knuth-055dcn`, equal to `main` at 01d33f7.

## Architecture

**Dependency graph:** unchanged (shared ← server ← client ← tools). The server gets a second entry point, `@game/server/node`, so tools tests can start a real server in-process. The match code stays pure.

**`packages/shared`**
- Protocol v2:
  - snapshots carry a list of other players;
  - snapshots are deltas against a snapshot the client confirmed;
  - a new reliable EVENTS message (join, leave, server stats).
- `WorldFrame`: one tick of every player as typed arrays. Server and client both keep the last 64.
- Up to 64 players. Up to 37, every snapshot fits 1100 B by construction (942 B at 32).
- A pmove "primer": a tiny built-in course that warms up every movement branch at startup.

**`packages/server`**
- `src/match` (pure): spawns, teams, world history, delta snapshots, the byte-budget scheduler, EVENTS, rate limits, strikes, timeouts, tick timing.
- `src/node` (new): process entry, `server.cfg`, CLI flags, JSON logs, metrics, GC tracking, stdin admin console, demo writer, several matches on one port, graceful shutdown.
- `src/transport` (new): the `ws` WebSocket listener, plus `/metrics` and `/status` pages.

**`packages/client`**
- A WebSocket transport, used when the URL has `?connect=`. The Worker stays the default.
- Remote interpolation: an arrival-based render clock with a 2–6 tick delay. It extrapolates at most 2 ticks, then holds. It copes with players that skip a tick.
- Capsule players in team colours: one instanced mesh, 2 draw calls.
- Smooth time dilation (±3%), keeping M2's fast-forward steps for big jumps.
- The full 7-line netgraph. Demo playback with `[`/`]` to switch players.
- `rcon`, and CHEAT flags on third person and the debug views.

**`packages/tools`**
- `pnpm bots`: headless bots over real WebSockets. They run strafe-jump circuits and random walks, and write a JSON + markdown summary.
- `pnpm demo-info`: prints what is in a demo file.
- A multi-client test harness (up to 64 clients).
- Two new test tiers: long tests and load tests.

**New dependencies:**

| Package | License | Why |
|---|---|---|
| `ws` 8.x (server only) | MIT | Node has no built-in WebSocket server. Browsers and bots use the native WebSocket. |
| `@types/ws` (dev) | MIT | Types for `ws` |

## How the 64-player budget works
- A snapshot must stay ≤ 1100 B. With 63 other players moving hard it would be up to 1.9 KB.
- For each client, the server first checks the worst case. If it fits, everything goes out. At 32 players it always fits, so nothing changes.
- If it doesn't fit, the server measures each player's update exactly. It always sends players who left and players it skipped last tick. Then it fills the rest of the budget, oldest-updated first.
- Skipped players are listed by id. The client keeps their last state and keeps them visible.
- No player is ever skipped two ticks in a row. A build-time check proves it: at least 34 players always fit, and at most 29 can be skipped.
- The remote view adds about one tick of delay only when something was skipped.

## Spec decisions you approve with this plan

| ID | Decision |
|---|---|
| D-029 | **Node server.** Its own folders, outside the pure match. `server.cfg` plus CLI flags. JSON logs. Tick p50/p95/p99, GC pauses, memory and CPU in the metrics. Default port 28700. |
| D-030 | **WebSocket transport.** One socket carries both channels; the message type says which. One upgrade handler checks path, origin and limits before a socket opens. Server accepts frames ≤ 2 KB. Slow clients lose snapshots first, then get closed. |
| D-031 | **Connecting.** One build-hash script for everything. The client loads the map the server names and checks its hash. `?connect=ws://…` and `connect`/`disconnect` in the console. |
| D-032 | **Test tiers.** `pnpm test` stays fast (≤ 55 s, CPU time reported too). New `pnpm test:long` holds the long deterministic runs; it is blocking in CI. New `pnpm test:load` holds the real-time runs. |
| D-033 | **Protocol v2 layout.** Snapshots get a player list and deltas. `lastProcessedCmdTick` is dropped: it always equals the server tick today, and nothing reads it. |
| D-034 | **Players: "Cap 64, default 32"** (your decision). 64 slots; `sv_maxClients` 32. `docs/01` O-8 becomes "partly decided". Teams are auto-balanced and only cosmetic until M7. Everyone uses the 16 free-for-all spawns. |
| D-035 | **Teleport counter.** An 8-bit counter replaces the one-snapshot teleport flag, so a lost snapshot can't hide a respawn. It is the only thing that makes a remote snap. Respawns no longer count as corrections. |
| D-036 | **Bots and bandwidth.** Bots live in `packages/tools/src/bots`. They refuse a count the server can't hold. Bandwidth counts payload + WebSocket framing, and 1 KB = 1000 B. NET-08 runs on `arena_greybox`. |
| D-037 | **Remote interpolation**, with a NET-05 rule that allows for stairs. |
| D-038 | **Delta snapshots.** One shared 64-tick history. The client confirms the newest stored snapshot; with no usable baseline the server sends a full one. |
| D-039 | **Time dilation (hybrid, your choice).** ±3% speed-up reacts fast. Slow-down waits for the 1.5 s window, as M2 learned. M2's fast-forward steps stay for deficits of 2+ ticks. |
| D-040 | **pmove primer.** 20000 ticks at match and client start, proven not to change results. A guard checks that the first-stairs GC is gone. |
| D-041 | **Security basics.** Rate limits, strikes, kicks, timeouts (2 s to say hello, 5 s silent). A player whose input stops stands still after 0.5 s. |
| D-042 | **Admin.** `rcon` with a password set by env var, locked out per IP after repeated failures. rcon only acts on the sender's match. `sv_cheats` gates third person and debug views. |
| D-043 | **EVENTS and netgraph.** Join, leave and server tick stats. A 7-line netgraph. |
| D-044 | **Demos.** The server records its snapshot stream to `demos/` (safe file names only). The browser plays it back following one player; `[`/`]` switch players. `pnpm demo-info` prints a demo's contents. |
| D-045 | **Load check.** `pnpm test:load` runs the real server, 16 bots and a headless browser. A busy host fails the run with a reason; it is never skipped. It also reports a 63-bot match and 4 matches × 16 bots. The CI load job reports numbers but doesn't block. |
| D-046 | **Byte-budget scheduler.** Keeps every snapshot ≤ 1100 B above 37 players. Never skips a player two ticks in a row. Never delays a "player left". |
| D-047 | **Several matches per process.** Each match has its own URL path (`/m/<name>`), ids, settings, logs, metrics and demos. One loop runs them all. Up to 4 matches and 64 players per process by default. |

## New tunables

**Server cvars** (not replicated; documented in `docs/06` §8):

| Cvar | Default | Label |
|---|---|---|
| `sv_maxClients` | 32 (max 64) | design (your decision) |
| `sv_maxMatches` | 4 | ESTIMATE |
| `sv_maxTotalClients` | 64 | ESTIMATE |
| `sv_timeout` | 5 s | design |
| `sv_helloTimeout` | 2 s | ESTIMATE |
| `sv_handshakeTimeout` | 10 s | ESTIMATE |
| `sv_starveNeutralTicks` | 30 | ESTIMATE |
| `sv_strikeWarn` / `sv_strikeKick` | 15 / 30 | ESTIMATE |
| `sv_inputBurst` / `sv_reliableBurst` | 240 / 20 | ESTIMATE |
| `sv_maxPerIp` | 8 | ESTIMATE |
| `sv_sendBufferDrop` / `Close` | 32 KiB / 1 MiB | ESTIMATE |
| `sv_port`, `sv_map`, `sv_strictBuild`, `sv_allowedOrigins`, `sv_metricsInterval`, `sv_autoRecord` | 28700, arena_greybox, 1, any, 10 s, 0 | design |

**Replicated:** `sv_cheats` (0 on Node, 1 in the Worker).

**Client:** `cl_interpDelay` (0 = auto), `cl_remoteSmoothMs` 100 (ESTIMATE), `cl_remoteCrouchBlendMs` 100 (ESTIMATE), `rcon_password` (not saved). Binds `[` and `]` switch players in demos.

**Placeholder team colours:** orange #d9652b and blue #2b8fd9 (ESTIMATE). They read well for common colour blindness. `docs/08` picks the real ones in M8.

## Tests mapped to acceptance

| Acceptance | Test |
|---|---|
| NET-01 | v2 codecs: round trips, fuzz, a table of hostile fields. Worst snapshot 942 B at 32 players, 1088 B scheduled at 64. |
| NET-02 | Delta correctness under loss, reorder and hostile acks: client frame = server frame every time. Deltas must actually be used: ≥ 90% delta snapshots on `bad-250-loss5`. At 64 players: every snapshot ≤ 1100 B, nobody skipped twice in a row, nobody who left shown late. |
| NET-04 | M2 blocks re-checked under v2 + dilation, plus 16 clients on arena. < 1 correction/s, mean < 2 u. |
| NET-05 | Remotes never jump (stairs allowed for). Hold/extrapolate ≤ 2% of frames. No snaps after the first. Also at 64 players, with skipping and a late joiner. |
| NET-07 | RTT step up re-converges ≤ 2 s, down ≤ 4 s, at most ±3%. A copy with dilation turned off must fail. |
| NET-08 | 16 bots + 1 human: down ≤ 32 KB/s, up ≤ 8 KB/s, every snapshot ≤ 1100 B, mean ≤ 0.7 × full size. Also reports 32 players, where nothing may be skipped. |
| NET-09 | Real server + 16 bots: tick p99 ≤ 4 ms, GC ≤ 8 ms, memory ≤ 150 MB. A quick in-process proxy runs in `pnpm test`. |
| NET-10 | Attackers get kicked on a computed schedule (3× flood ≤ 5 s, 10× ≤ 1.2 s, garbage ≤ 6 packets). Connection limits hold even with many sockets at once. Honest players see nothing. |
| NET-12 | Late join and reconnect: full snapshot, identical frames, 0 strikes, over 5 simulated minutes. |
| 16 bots + 1 human | `pnpm bots --count 16 --profile wan-100-loss1 --minutes 2 --map arena_greybox --human --strict` (no extra flag needed now), plus your own run. |

**Also:** transport contract tests on real sockets; scheduler units (budget maths, 37 ↔ 38 players, a failed encode records nothing); server units (spawns, teams, limits, rcon scope, config); several-matches suite (isolation, 404/503, removal); client units (clock, interpolator, store); demo tests (replay, safe names, `[`/`]`, `demo-info`); allocation guards for the new hot paths; benches; browser e2e for connect and multiplayer.

## Increments (each green, committed and pushed)
1. `feat(server): Node dedicated server over WebSocket` (D-029, D-030).
2. `feat(client): connect to a Node server` (D-031). **You can play alone on the Node server.**
3. `test(tools): multi-client harness, test tiers and the M3 acceptance guard` (D-032).
4. `feat(shared,server,client): protocol v2 full snapshots with the entity list` (D-033, D-034).
5. `feat(server,client): spawns, teams, teleport counter and capsule players` (D-035). **Two tabs see each other.**
6. `feat(tools,server): headless bots, server metrics and the load baseline` (D-036). **Bots run circuits.**
7. `feat(client): remote entity interpolation (NET-05)` (D-037). **Smooth remotes.**
8. `feat(shared,client): delta codec and snapshot store (NET-02 unit)`.
9. `feat(server,client): delta snapshots in the match (NET-08, NET-12)` (D-038). **About 16 KB/s instead of 28.**
10. `feat(shared,server,client): snapshot byte-budget scheduler for 64 players` (D-046). **A full 64-player server stays smooth.**
11. `feat(client): asymmetric hybrid time dilation (NET-07)` (D-039).
12. `feat(shared,server,client): deterministic pmove primer with a late-branch guard` (D-040).
13. `feat(server,client): rate limits, strikes, timeouts and keepalive (NET-10)` (D-041).
14. `feat(server,client): rcon authorization, sv_cheats and CHEAT client cvars` (D-042).
15. `feat(shared,server,client): EVENTS channel and the full netgraph` (D-043).
16. `feat(server,client,tools): demo recording, playback with player cycling, and demo-info` (D-044). **Replay a match and switch players.**
17. `feat(server): several matches per server process` (D-047). **Two matches on one server.**
18. `test(tools): load project (NET-09, 16 bots + 1 human) and the CI load job` (D-045).
19. `docs: M3 review fixes, load check, net-check and handoff`, then the PR with auto-merge.

## How it will be built
- **Per increment:** an implementer writes it. Then 4–5 lenses review it: spec, correctness, determinism and performance, tests, plus `netcode-reviewer` (every networked increment) and `movement-reviewer` (11, 12). An integrator applies the fixes.
- **Before each commit:** `pnpm typecheck && pnpm lint && pnpm test`, plus `test:net`, `test:long` and `test:browser` when touched. I report `pnpm test` wall time and CPU time.
- **Docs:** each increment updates only the docs its code makes true, with its decision-log entry.
- **Close-out:** fresh-clone run; `netcode-reviewer`, `movement-reviewer`, `perf-auditor`, `clean-room-auditor` and more; fixes; the 2-minute 16 + 1 run; `pnpm bench`; `/net-check`; `/handoff`. Then the PR to `main` with auto-merge on (merge commit); it merges once CI is green.

## Risks
1. **Real WebSocket behaves differently from loopback.** Done first, with contract tests on real sockets.
2. **Deltas go out of sync, or silently never get used.** Frame checks every snapshot, plus "deltas actually used" assertions.
3. **The scheduler gets the maths wrong at 64 players** (too big, a player skipped too long, a player who left shown late). Exact budget accounting, a build-time bound, and 64-player tests that check every snapshot.
4. **64 players cost too much CPU.** Not an acceptance target. Below 38 players the scheduler is skipped. A bench and a 63-bot run report the cost.
5. **Matches on one server slow each other down.** They share no state. A slow match does share loop time; logs say so, and a 4 × 16 load run reports it.
6. **Dilation fights M2's clock.** Slow-down only on the long window; M2 tests must stay green; a dilation-off control.
7. **Load numbers are noisy on a shared 4-core box.** Bots and the browser run at low priority, the first 10 s are discarded, and a busy host fails loudly.
8. **`pnpm test` gets too slow.** A wall and CPU budget each increment; long runs move to `test:long`.
9. **The primer misses the branches that cause the GC.** A multi-process guard with a "primer off" control, plus a coverage check.
10. **rcon over plain `ws://`.** Off unless a password is set; per-IP lockout; one match only; `wss://` in M9.

## Verification
- After every increment: the checks above.
- **At the end:**
  - fresh clone runs everything;
  - `pnpm test:load` and the 2-minute 16 + 1 `--strict` run pass, with numbers in `docs/10` §4;
  - `pnpm bench` within budgets;
  - CI green (check with `test:long`, browsers, and the load job reporting);
  - the full review;
  - PR opened with auto-merge on (merge commit);
  - handoff "Try it":
    - `pnpm dev:server`;
    - `pnpm bots --server ws://localhost:28700 --count 16`;
    - your browser at `?connect=ws://localhost:28700&net_profile=wan-100-loss1`;
    - a full server: `pnpm dev:server --set sv_maxClients=64` and `pnpm bots --server ws://localhost:28700 --count 62`;
    - two matches: `pnpm dev:server --match main=arena_greybox --match lab=movement_lab`, then a tab at `?connect=ws://localhost:28700/m/lab`;
    - a demo: `rcon record`, play, `rcon stoprecord`, open `?demo=…`, press `]`, then `pnpm demo-info demos/<file>`.
