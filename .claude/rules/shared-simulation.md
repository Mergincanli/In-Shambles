---
paths:
  - "packages/shared/**"
---

# Rules for the shared simulation (`packages/shared`)

These load whenever you work in `packages/shared`. They protect determinism and prediction.

- **Pure and environment-agnostic.** No DOM, no Node APIs, no `window`, `process`, `fs`, `setTimeout` or `fetch`. This code runs in Node, a Web Worker and the browser main thread.
- **No hidden time or randomness.** Never use `Math.random`, `Date.now`, `performance.now` or `new Date()` in sim code. Time comes in as `tick` and `TICK_DT`. Randomness comes from `rng/` seeded via `hash32(matchSeed, entityId, tick, index)`.
- **Fixed tick only.** Simulation functions advance exactly one tick. Never scale physics by a variable frame time.
- **Quantize at end of tick.** Any change to `PlayerState`/`EntityState` fields must go through `quantize()` and be reflected in the net codec and delta masks (`docs/05` §4).
- **Every simulated field is networked.** If you add a field that affects simulation, also add it to serialization, delta encoding and the prediction parity test. Otherwise client and server will diverge.
- **Tunables are replicated cvars** (`REPLICATED` flag). Never read client-local settings inside the sim.
- **No allocations in hot paths.** Use out-parameters, pooled vectors and preallocated arrays. No closures or array helpers (`map`/`filter`/`forEach`) inside per-tick loops.
- **Labels.** When implementing a value from `docs/03` or `docs/04`, keep its FACT/INFERRED/ESTIMATE label in a comment next to the default.
- **Tests.** Every behavior change needs a unit or scenario test. Movement changes run `pnpm test:movement`; anything touching state also runs the parity tests.
- **Clean room.** Implement from the docs' algorithm descriptions only. Do not reproduce Quake III / ioquake3 source code.
