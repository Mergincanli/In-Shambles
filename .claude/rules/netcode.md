---
paths:
  - "packages/shared/src/net/**"
  - "packages/server/**"
  - "packages/client/src/net/**"
---

# Rules for networking code

- **Never trust the client.** Accept only UserCmds and requests. Validate ranges, rates, loadouts and `viewInterpTick` (`docs/05` §7, §12).
- **Binary, bounds-checked codecs.** Every decoder checks lengths and value ranges and fails safely: drop the packet and add a strike. Never throw past the transport layer.
- **Version the protocol.** Any wire-format change bumps `PROTOCOL_VERSION` and updates `docs/05` §3–4 in the same change.
- **Design for unreliable delivery** even on WebSocket: sequence numbers, acks, delta baselines, input redundancy, idempotent events.
- **Respect the budgets:** snapshot ≤ 1100 B, down ≤ 32 KB/s and up ≤ 8 KB/s per client at 16 players. Measure with bots before and after.
- **Server loop.** Use a monotonic clock with an accumulator. Never `setInterval`. Keep a fixed per-tick processing order (by client id).
- **Prediction integrity.** Client reconciliation compares quantized states exactly. Smoothing applies only to render offsets, never to simulation state.
- **Tests.** Netcode changes must pass `pnpm test:net` under all profiles in `docs/10` §3, plus a short bot run: `pnpm bots -- --count 16 --profile wan-100-loss1 --minutes 2`.
- **Review.** After non-trivial changes, delegate a review to the `netcode-reviewer` agent.
