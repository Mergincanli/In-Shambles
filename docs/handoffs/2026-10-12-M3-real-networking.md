# Handoff — 2026-10-12 — M3 — Real networking

> File name: `docs/handoffs/YYYY-MM-DD-M#-<slug>.md`. Written by `/handoff` at the end of every session. The next session starts by reading the newest one (`/start-session`).

## 1. Summary (3–5 lines)
M3 makes the game multiplayer for real. A Node dedicated server runs the match. Browsers and headless bots connect over WebSocket, see each other as capsules in team colours, and remote players move smoothly.

What you can now do:
- play with up to 32 players by default (64 with a flag), on several matches per server;
- record demos and play them back in the browser, switching players with `[` and `]`;
- run admin commands with `rcon`.

Under the hood:
- delta snapshots: 14.6 KB/s per player with 16 bots;
- a byte budget that keeps every snapshot at or under 1100 B up to 64 players;
- smooth ±3% time dilation, a movement warm-up at startup, rate limits, strikes and timeouts;
- a full netgraph, and a load tier that runs 16 bots plus a headless browser player.

Each of the 18 increments was built, reviewed from 5–6 angles and fixed before its commit. The close-out review (8 lenses, skeptics, a completeness critic) confirmed 14 findings: 1 blocker (a connection flood could crash the server) and 3 majors. All are fixed, in 12 commits, recorded as D-048.

## 2. Milestone status
- Milestone: M3 — Real networking → ☑ done.
- Acceptance criteria:
  - ✅ **NET-01** codecs: round trips, fuzz, a hostile-field table. Worst snapshots: 942 B at 32 players, 1088 B at 37 and when scheduled at 64. Live snapshots over 1100 B are refused.
  - ✅ **NET-02** deltas: the client's frame equals the server's on every snapshot.
    - bad-250-loss5, 60 s: 99.7% deltas, mean 74 B vs 117 B full.
    - 64 players: every snapshot ≤ 1100 B, staleness ≤ 2, no player who left shown late.
  - ✅ **NET-04** reconciliation: 16 clients on `arena_greybox`, wan-100-loss1, 60 s: worst 0.00 corrections/s. Every M2 frame model still passes under dilation.
  - ✅ **NET-05** remote interpolation: 0 jumps and 0 render snaps in every leg, including 64 players with skipping and a late joiner. Worst held/extrapolated share 8.4% (in a 250 ms server stall).
  - ✅ **NET-07** time dilation:
    - up-steps re-converge in 0.58–1.27 s (bound 2 s), down-steps in 2.9–3.5 s (design bound 4 s);
    - the rate stays within ±3%;
    - a control with dilation off fails both directions.
  - ✅ **NET-08** bandwidth, 16 bots + 1 human, wan-100-loss1, 60 s:
    - 14.6 KB/s down (budget 32), 3.65 KB/s up (budget 8);
    - snapshots average 238 B, 52% of a full one (budget 70%).
    - At 32 players: 25.2 KB/s down and nothing deferred.
  - ✅ **NET-09** server performance, built server + 16 bots, 1 min, after a 10 s discard: p50 0.48 ms, p99 1.49 ms, GC max 2.44 ms, 19.5 MB (budgets 1.5 / 4 / 8 ms, 150 MB).
  - ✅ **NET-10** abuse: every attacker is kicked on the computed schedule (3× input flood in 4.5 s, 10× in 1.0 s, reliable flood in 1.1 s, malformed packets within 6). Honest players get 0 strikes. The close-out added connection- and frame-flood legs (D-048).
  - ✅ **NET-12** late join and reconnect: identical frames and 0 strikes over 5 simulated minutes.
  - ✅ **16 bots + 1 human** on `arena_greybox` at wan-100-loss1 (your stand-in: headless Chromium).
    - Smooth remote motion on every run. Tick p99 ≤ 4 ms beside the browser in 7 of 8 runs (2.1–3.3 ms); the 8th, on a slightly busier host, had 4.92 ms beside it and 3.05 ms on the repeat without it, which the design's rule judges the server on.
    - The human always joined, with 0–0.025 corrections/s, no misprediction and 0 interpolation violations.
    - **GC pause, decided by you (2026-10-12):** the design added a second gate to this run, server GC pause ≤ 8 ms. Beside the headless browser on this 4-vCPU cloud VM it held in only 2 of 7 runs (5.1, 7.8, 11.1, 12.9, 14.1, 14.4, 15.1 ms): the browser's software rendering takes about 1.8 of the 4 cores. The same server with 17 bots and no browser: GC max 4.1 ms, the same number of pauses. You chose to judge the GC bound without the browser (NET-09 passes at 2–4 ms), so the load leg now repeats a run without `--human` when only the server's own checks fail beside the browser (D-045). The updated leg passed: 4.92 ms p99 and 9.7 ms GC beside the browser, 3.05 ms and 5.06 ms without it.

## 3. What was built (by package)
- `shared/`:
  - **Protocol v2** (D-033):
    - SNAPSHOT lists every player (64 slots, stamps, an 8-bit teleport counter, D-035);
    - full, delta (D-038), deferred (D-046) and spectator (demo) forms;
    - EVENTS (join, leave with reason, server tick stats, D-043).
    - Every decoder returns false on bad input and allocates nothing.
  - `WorldFrame` (one tick of every player as typed arrays).
  - The pmove primer: 20000 ticks over a built-in course, proven not to change results (D-040).
  - The demo format and `validateDemo` (D-044).
  - Replicated `sv_cheats`.
- `server/`:
  - **`src/match`** (pure):
    - spawns and teams;
    - a 64-tick world history, per-client acks and baselines;
    - the byte-budget scheduler with per-client mirrors (above 37 players);
    - token buckets, strikes, kicks, timeouts, the neutral cmd for a silent player (D-041);
    - rcon commands scoped to the sender's match (D-042);
    - EVENTS, the demo recorder;
    - `Match.close`.
  - **`src/node`**:
    - the process entry, `server.cfg` and the CLI;
    - JSON logs, metrics (tick histograms, GC, memory, CPU, bytes), `/metrics` and `/status`;
    - the stdin admin console, the rcon lockout;
    - the demo writer (safe names, confined to `demos/`);
    - several matches on one loop (`MatchSet`, D-047), graceful shutdown.
  - **`src/transport`**: the `ws` listener, with one upgrade handler for path, origin, per-IP and total limits (in-flight counted). The close-out added refused sockets destroyed, reads paused under floods and a crash-proof metrics sample (D-048).
- `client/`:
  - the WebSocket transport (`?connect=`); the socket opens after the page's startup work;
  - remote interpolation (an arrival-based render clock, 2–6 ticks of delay, at most 2 ticks of extrapolation, D-037);
  - capsule players (one instanced mesh, crouch blend);
  - the hybrid ±3% dilation clock (D-039);
  - the 7-line netgraph and join/leave notices;
  - `rcon`, `connect`/`disconnect`, `demo`, `follow`/`follownext`/`followprev` with `[`/`]` binds;
  - CHEAT gating of third person and the debug views;
  - the hidden-tab keepalive;
  - demo playback (`?demo=`).
- `tools/`:
  - `pnpm bots`: real-WebSocket bots on routes and random walks, a JSON and markdown summary, `--human` for the headless browser player, a host gate, nice 10, stale-build refusal;
  - `pnpm demo-info`;
  - the multi-client harness (up to 64 `ClientSim`s);
  - the `test:long` and `test:load` tiers;
  - new native-ESM allocation workloads for every new hot path;
  - benches for interpolation and snapshot build;
  - the acceptance-ids guard with tiers.
- **Dependencies:** `ws` 8 and `@types/ws` (MIT), listed in `content/LICENSES.md`.
- **CI:** a `load` job (`pnpm build`, `pnpm test:load`, reports uploaded). It is `continue-on-error`, so it never blocks.
- **Docs:**
  - D-029 to D-048;
  - `docs/05` §2–§4, §6, §8, §10, §12–§14;
  - `docs/06` module map, §6–§8, §11;
  - `docs/10` §1–§4;
  - `docs/09` M3;
  - CLAUDE.md and README commands;
  - the `/net-check` skill now names the long NET legs and the load tier.

## 4. Verification
- **Checks on the final tree** (`e182e69` plus this docs commit):
  - `pnpm typecheck` and `pnpm lint` clean.
  - `pnpm test`: 181 files, 3034 tests, 46–50 s wall and 133–148 CPU-s (D-032 budget 55 s / 165 CPU-s).
  - `pnpm test:long`: 27 files, 205 tests, 136–138 s (budget 240 s).
  - `pnpm test:net`: 120 fast + 133 long tests. `pnpm test:movement`: 55 + 13.
  - `BROWSERS=chromium pnpm test:browser`: 8 files, 46 tests.
  - `pnpm feel-report`: 17 of 17 metrics on target, unchanged from M2.
- **Fresh clone** at `d5c681b`: install, typecheck, lint, test, test:long, test:net, test:movement, build and test:browser all pass.
- **Load tier** (`pnpm build && pnpm test:load`, 5.8 min) passed 3 of 4 legs before your GC decision; the 16 + 1 leg failed only on the GC bound above. With the decision applied, the 16 + 1 leg passes (above).
  - NET-09: PASS.
  - 63 bots (reported): p99 6.6 ms, GC 2.2 ms, 67 MB, everybody joined, nobody skipped twice.
  - 4 matches × 16 bots (reported): the loop pass's p99 4.5 ms (each match 1.4–1.6 ms), no dropped tick.
- **`/net-check`:** `pnpm test:net` green. Bots at wan-150-loss2, 2 min: PASS (p99 1.64 ms, GC 3.69 ms, 14.3 KB/s down, 3.6 up, 0 mispredictions).
- **Bench** (Node 22.22, Xeon 2.8 GHz, 4 vCPU; all PASS, 0 GCs):

  | Benchmark | Result | Budget |
  |---|---|---|
  | box trace | 369 ns | 1 µs |
  | pmove | 1.99 µs | 5 µs |
  | 16-player delta snapshot | 9.8 µs | 30 µs |
  | snapshot build per client | 5.8 µs | 50 µs |
  | 64-player scheduled build per client | 33.7 µs | reported |
  | interpolation, 16 remotes per frame | 4.7 µs | reported |
  | interpolation, 63 remotes per frame | 14.8 µs | reported |

- **Manual end-to-end, headless:** a dev server with `sv_autoRecord 1` and 2 bots wrote a 31 s demo.
  - `pnpm demo-info` read it: 4 keyframes, 2 players with teams.
  - The dev page played it at `?demo=/@fs/<repo>/demos/<file>`; `]` switched from "following #0" to "following #1".
- **Build:** client 741 kB (204 kB gzip); server bundle `dist/main.js` 468 kB.
- **Reviews:**
  - **Per increment:** 15–34 findings each, from spec, correctness, determinism/performance and tests lenses, plus `netcode-reviewer` and the client or `movement-reviewer` lens where relevant. An integrator reproduced each finding, then fixed it or rejected it with a reason.
  - **Close-out:**
    - 8 lenses: netcode, security, movement, perf, clean room, client, tests, spec;
    - 26 findings after merging duplicates;
    - 3 skeptics per blocker or major, 1 per minor;
    - 14 confirmed, 5 refuted, 7 nits, 1 critic finding;
    - 12 fix commits;
    - a final check, all green.
  - The clean-room audit found no copied code, trademarks or license issues.

## 5. Decisions and deviations
- **New decisions** ([decision log](../11-decision-log.md)): D-029 to D-047 came with the plan you approved, each extended as its increment landed. **D-048 is new:** the server survives connection and frame floods. Found by the close-out security review; the rest of the hardening goes to M9.
- **Main deviations from the design** (each recorded in its D-entry):
  - The dilation target is `cl_inputBuffer`, not "plus the adaptive lead" (D-039 (1)).
  - The frame caps were raised: `MAX_TICKS_PER_FRAME` 5 → 8 and `HITCH_FRAME_MS` 100 → 150, after the trial passed every NET-04 frame model (D-039).
  - The primer is off in the logical fast NET tests to keep the test budget; NET-03, NET-09 and all long NET tests keep it (D-040 reading 8).
  - The kick-time formula is corrected for floods slower than 1 packet per tick (D-041).
  - A right rcon password does not clear an address's failures; the 600 s cap holds (D-042).
  - Server-forced socket closes report LEAVE reason 0 (D-043).
  - `validateDemo` lives in shared (the browser needs it); `DemoPlayer` is separate from `ClientSim` (D-044).
  - The load tier's reported legs run 1 minute each; the strict 16 + 1 run refuses stale builds (D-045).
  - Mirrors take about 530 KB each, about 34 MB at 64 players, not the design's 156 KB (D-046).
  - One tick loop for all matches (D-047).

## 6. Tuning changes
| Cvar | Old | New | Reason |
|---|---|---|---|
| `sv_maxClients` | — | 32 (1–64) | Your decision "Cap 64, default 32" (D-034) |
| `sv_maxMatches` / `sv_maxTotalClients` | — | 4 / 64 | ESTIMATE (D-047) |
| `sv_timeout` / `sv_helloTimeout` / `sv_handshakeTimeout` | — | 5 s / 2 s / 10 s | design / ESTIMATE (D-041) |
| `sv_starveNeutralTicks` | — | 30 | ESTIMATE: a silent player stands still after 0.5 s |
| `sv_strikeWarn` / `sv_strikeKick` | — | 15 / 30 | ESTIMATE |
| `sv_inputBurst` / `sv_reliableBurst` | — | 240 / 20 | ESTIMATE (only the default is shown to keep honest clients at 0 strikes) |
| `sv_maxPerIp` | — | 8 | ESTIMATE, loopback exempt |
| `sv_sendBufferDrop` / `sv_sendBufferClose` | — | 32 KiB / 1 MiB | ESTIMATE |
| `sv_port`, `sv_map`, `sv_strictBuild`, `sv_allowedOrigins`, `sv_metricsInterval`, `sv_autoRecord` | — | 28700, arena_greybox, 1, any, 10 s, 0 | design |
| `sv_cheats` (replicated) | — | 0 on Node, 1 in the Worker | D-042 |
| `cl_interpDelay` / `cl_remoteSmoothMs` / `cl_remoteCrouchBlendMs` | — | 0 (auto) / 100 / 100 | design / ESTIMATE |
| `rcon_password` | — | "" (never saved) | D-042 |
| `MAX_TICKS_PER_FRAME` / `HITCH_FRAME_MS` (constants) | 5 / 100 ms | 8 / 150 ms | D-039 trial passed |

## 7. Known issues / risks
- **Questions for you.** Defaults are in place for each.
  1. **The up-step glide.** When your ping jumps up (50 → 150 ms), the clock's 2-tick catch-up glides you forward about 22 u once. That is under the snap distance and kept on purpose by the hybrid you chose. The plan said "no glide"; accept the 22 u, or should I reword the plan?
  2. **The dilation target** is `cl_inputBuffer` without the adaptive lead (D-039 (1)): confirm, or I amend the design record.
  3. **Several matches on one loop.** 4 full matches put the loop pass at p99 4.5–5.6 ms on this VM (each match alone 1.4–2.0 ms). Keep `sv_maxMatches` 4?
  4. **Smaller ones**, to answer when convenient:
     - Should a kicked socket be cut off after a short grace period, instead of waiting up to 30 s for its close?
     - The Worker match also applies strikes. A bad-packet storm would kick the page's only player. Intended?
     - The primer is off in six fast NET tests (budget). Acceptable?
- **Planned for M9** (recorded in D-048 and `docs/09` M9):
  - a per-address cap on raw TCP connections and shorter header timeouts;
  - reconnect penalties;
  - IPv6 /64 grouping for the rcon lockout;
  - `wss://`;
  - the rest of the anti-abuse hardening.
- **Risks:**
  - **Test timings depend on the host.** On a slower VM, `pnpm test` ran 60–68 s (over the 55 s budget) on unchanged code. The long tier's native-ESM file is close to its 30 s per-test timeout when another job shares the host.
  - **NET-07 down-step margin:** 3.5 s against the design's 4 s.
  - **Not covered by a blocking test:** the `--human` browser plumbing runs only in the load tier.
  - **The CI `load` job must not become a required check:** it is `continue-on-error` on purpose. Branch protection could not be checked from here.
  - **From M2, still open:** the Worker-path e2e starvation case. The respawn view snap is deferred to M6/M7. Teams are cosmetic until M7.
- **Not done in M3, by design:** combat, relevance culling (everything is sent, within the byte budget), WebTransport, `wss://`, bans and accounts, a 30 Hz snapshot fallback.

## 8. Next steps (ordered)
1. Merge the M3 PR. It is opened with auto-merge (merge commit) and merges once CI is green; the `load` job reports but never blocks.
2. Play it yourself (§9): two tabs, then you plus 16 bots, then a demo. That is the real "16 bots + 1 human" check.
3. Answer the §7 questions when convenient.
4. Then `/milestone M4`, the UrT movement set (sprint and stamina, wall jumps, power slide, ledge grab, fall damage, goomba, kick). M4 also settles the M2 movement questions (ladder from the top, crouched air strafing, jumping at a ladder's foot).
5. Whenever you like: `pnpm bench` and `pnpm test:load` on your laptop, to fill in `docs/10` §5.

## 9. Try it (for Mustafa)
- **Setup:** `pnpm install`, then `pnpm build` once (the bots and the load tier use the built server).
- **You on a real server:**
  - Terminal 1: `pnpm dev:server` (port 28700, map `arena_greybox`).
  - Terminal 2: `pnpm dev`.
  - Open http://localhost:5173/?connect=ws://localhost:28700 and click to take the mouse. W A S D, Space, C crouch, X walk; Backquote opens the console.
- **Two tabs:** open the same URL in a second tab. Each sees the other as a capsule in its team colour (orange or blue). Close one tab: its capsule leaves at once (a connection that just goes silent is dropped after 5 s).
- **You + 16 bots:**
  - Terminal 3: `pnpm bots --server ws://localhost:28700 --count 16 --minutes 10`.
  - In the console: `set cl_netgraph 1` shows the 7 lines (link, snapshots, remote interp, corrections, input buffer and dilation, traffic, server tick time).
  - `net_profile wan-100-loss1` simulates a 100 ms link with 1% loss; remotes should stay smooth.
- **The automated version of that check:** `pnpm bots --count 16 --profile wan-100-loss1 --minutes 2 --map arena_greybox --human --strict`. It prints PASS or FAIL per check and writes `reports/bots/`. On a machine with few cores the server's GC row can FAIL beside the browser; the load tier then judges the server on a run without it (your decision, D-045).
- **A full server:** `pnpm dev:server --set sv_maxClients=64`, then `pnpm bots --server ws://localhost:28700 --count 62` (the byte-budget scheduler keeps snapshots ≤ 1100 B).
- **Two matches:**
  - `pnpm dev:server --match main=arena_greybox --match lab=movement_lab`.
  - One tab at `?connect=ws://localhost:28700` (main), one at `?connect=ws://localhost:28700/m/lab`. They see different maps and players.
  - `matches` on the server's stdin lists both.
- **Admin:**
  - `SV_RCON_PASSWORD=secret pnpm dev:server`, then in the browser console `set rcon_password secret`.
  - `rcon status` or `rcon set pm_gravity 400` changes gravity for everyone in that match.
  - `set cl_thirdPerson 1` is refused on the Node server (cheats off) and works offline with `pnpm dev`.
- **A demo:**
  - With rcon set up as above: `rcon record`, play a bit, `rcon stoprecord`. The server prints the file name in `demos/`.
  - Open http://localhost:5173/?demo=/@fs/<full path to the repo>/demos/<file>.demo. The camera follows a player; `]` and `[` switch players.
  - `pnpm demo-info demos/<file>.demo` prints what is in it.
- **The load tier:** `pnpm build && pnpm test:load` (about 6–8 minutes; close other heavy programs first, the host gate refuses a busy machine).
