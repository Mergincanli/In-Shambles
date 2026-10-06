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
- **Deterministic math only** (D-016). No `Math.sin`/`cos`/`pow`/`exp`/`log`/`atan2`/`hypot` (or the other approximate functions) and no `**`: use `math/dtrig` and exact operations. The purity guard enforces it.
- **No allocations in hot paths.** Use out-parameters, named per-module scratch vectors (`Float64Array`, not a shared pool; D-016) and preallocated arrays. No closures or array helpers (`map`/`filter`/`forEach`) inside per-tick loops.
- **Keep doubles unboxed.** Under native ES modules (tsx, Vite dev) V8 boxes a fractional double that crosses a call it doesn't inline, or that a ternary joins with a module-scope constant, which bundling turns into a `var`. In per-tick code: return doubles through out-parameters (a `Vec3` written in place), clamp with `Math.min`/`Math.max` instead of `x < -LIMIT ? -LIMIT : …`, and pass a double to `DEV_ASSERT` only on the failure path. Vitest's module runner hides this; `packages/tools/test/perf/native-esm-allocation.test.ts` runs the end-of-tick path as native ESM.
- **Labels.** When implementing a value from `docs/03` or `docs/04`, keep its FACT/INFERRED/ESTIMATE label in a comment next to the default.
- **Tests.** Every behavior change needs a unit or scenario test. Movement changes run `pnpm test:movement`; anything touching state also runs the parity tests.
- **Clean room.** Implement from the docs' algorithm descriptions only. Do not reproduce Quake III / ioquake3 source code.
