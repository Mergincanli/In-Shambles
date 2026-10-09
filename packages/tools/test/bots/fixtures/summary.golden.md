# Bots run 2026-10-09T01:02:03.456Z: FAIL

2 bots on `arena_greybox` (match `main`, maxClients 32) at `wan-100-loss1` for 2 min, seed 1; server child (dist), build `abc1234`. Host: 4 CPUs, load 0.25 → 1.50 (1 min), Node 22.22.0 on linux-x64.

## Checks (docs/10 §4, prediction health)

| Check | Target | Measured | Result |
| --- | --- | --- | --- |
| bots joined and stayed | 2 | 2 joined, 1 closed | FAIL |
| server tick p50 | ≤ 1.5 ms | 0.410 ms | PASS |
| server tick p99 | ≤ 4 ms | 1.210 ms | PASS |
| server GC pause max | ≤ 8 ms | 2.500 ms | PASS |
| server memory (peak heapUsed + external) | ≤ 150 MB | 21.5 MB | PASS |
| server strikes | 0 | 0 | PASS |
| down per client (average) | ≤ 32 KB/s | 3.05 KB/s | PASS |
| down per client (peak 1 s) | ≤ 48 KB/s | 3.20 KB/s | PASS |
| up per client | ≤ 8 KB/s | 3.65 KB/s | PASS |
| snapshot size | ≤ 1100 B | 63 B | PASS |
| bot strikes | 0 | 0 | PASS |
| mispredictions (corrections not on a starved snapshot) | 0 | 0 | PASS |
| remote jumps (NET-05 violations) | 0 | 0 | PASS |

## Server (run window)

| Metric | Value |
| --- | --- |
| source | --metrics-out |
| run window | 112.5 s, 2 players at the end |
| tick p50 / p95 / p99 / max | 410 / 700 / 1210 / 3300 µs |
| GC | 40 pauses, max 2.500 ms |
| memory | peak heapUsed + external 21.5 MB, peak RSS 101.0 MB; at the end heapUsed 14.3 MB + external 4.5 MB, RSS 95.0 MB |
| CPU | 120 ms per wall s |
| traffic | 6.10 KB/s out, 7.30 KB/s in |
| counters | dropped ticks 0, starved 3, full snapshots 13500, strikes 0, kicks 0 |
| scheduler (D-046) | 2900 players left out of 120 of 13650 snapshots (0.9%), max staleness 2, snapshot overflows 0 |

## Bots (aggregate)

| Metric | Value |
| --- | --- |
| joined / closed | 2 / 1 |
| corrections per s (mean / worst) | 0.025 / 0.025 |
| correction (worst mean / max) | 0.400 / 1.200 u |
| mispredictions / starved / hard resyncs / strikes | 0 / 4 / 0 / 0 |
| input buffer (mean / lowest) | 1.80 / 0 ticks |
| down per client (mean / worst / peak 1 s) | 3.05 / 3.05 / 3.20 KB/s |
| up per client (mean / worst) | 3.65 / 3.65 KB/s |
| snapshot p50 / p95 / max | 63 / 63 / 63 B |
| delta share | 0.0% |
| interp delay (mean / max) | 3.50 / 4 ticks |
| remotes extrapolated or held (worst) / NET-05 violations | 0.25% / 0 of 14000 judged |

## Bots

| Bot | Kind | Corr/s | Mean / max corr (u) | Starved | Resyncs | Buffer mean / low | Down / peak / up (KB/s) | Snapshot p50 / max (B) | Interp (ticks) / extrap / jumps | Laps / stuck | Closed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | route | 0.025 | 0.40 / 1.20 | 2 | 0 | 1.80 / 0 | 3.05 / 3.20 / 3.65 | 63 / 63 | 3.5 / 0.25% / 0 | 6 / 1.0% | – |
| 3 | walk | 0.025 | 0.40 / 1.20 | 2 | 0 | 1.80 / 0 | 3.05 / 3.20 / 3.65 | 63 / 63 | 3.5 / 0.25% / 0 | – | timed out |
