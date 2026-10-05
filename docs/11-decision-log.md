# 11 — Decision Log

> Append-only. Format: `D-### — Title (date, status)`, then Context / Decision / Consequences. Superseded decisions stay, marked `superseded by D-###`.
> Open decisions owned by Mustafa are tracked in `docs/01` (O-#). When one is decided, add a D-entry here.

---

### D-001 — Clean-room policy and licensing default (2026-10-04, accepted)
**Context:** We reproduce Urban Terror's movement and balance. Its assets and game code are proprietary; Quake III's code is GPL v2.
**Decision:**
- Use no UrT files, code, names or assets, and do not decompile or reverse-engineer its binaries.
- Use no GPL code. Implement from our specs; observing the original's behavior is allowed.
- Shipped dependencies are permissive only (MIT/BSD/Apache/ISC/MPL).

**Consequences:** some constants are ESTIMATE until measured from gameplay captures. We keep licensing options open (decision O-5).

### D-002 — Tech stack (2026-10-04, accepted)
**Decision:** TypeScript strict monorepo (pnpm), Vite client, Node LTS server, Vitest, Biome, Three.js (`WebGLRenderer` first), `ws` for WebSocket.
**Why:** one language across server, worker and client; mature tooling; Mustafa's existing Three.js/React experience (FORGE).
**Consequences:** performance discipline needed in JS hot paths (`docs/06` §9).

### D-003 — Server-authoritative Q3-style netcode (2026-10-04, accepted)
**Decision:**
- Inputs-only clients. Shared deterministic sim; client prediction + reconciliation.
- Snapshot interpolation for remote entities. Hitscan lag compensation with capped rewind (200 ms).

**Consequences:** every gameplay feature must define networked state, prediction and tests.

### D-004 — 60 Hz fixed tick (2026-10-04, accepted)
**Context:** UrT ended at a 20 Hz server rate. Modern competitive shooters run 60–128 Hz.
**Decision:** 60 Hz simulation, snapshots (30 Hz fallback per client) and inputs (with 4-cmd redundancy). Render decoupled with interpolation.
**Consequences:** movement feel is tuned at 60 Hz; changing the tick requires re-tuning (`docs/03` §1).

### D-005 — Everything runs through a server, even offline (2026-10-04, accepted)
**Decision:** local play uses the same server code in a Web Worker over a loopback transport, plus a network simulator.
**Why:** netcode is never an afterthought; one gameplay path.

### D-006 — Units and axes (2026-10-04, accepted)
**Decision:** 1 u = 1 inch, Z-up in sim, maps and netcode. Conversion to Three.js Y-up meters happens only in `client/render/space.ts`.
**Why:** matches UrT's unit convention and TrenchBroom/Quake map space; avoids conversion bugs in physics.

### D-007 — Brush-based collision; no physics engine for players (2026-10-04, accepted)
**Decision:** world collision = convex brushes (planes) with swept-AABB traces; Q3-style kinematic collide-and-slide.
**Why:** crisp, predictable edges are essential for wall jumps, ledge grabs and slides. Triangle meshes cause internal-edge snags.

### D-008 — Compiled map format + TrenchBroom via Valve 220 (2026-10-04, accepted)
**Decision:**
- A greybox TypeScript builder first.
- In M5, a TrenchBroom `.map` (Valve 220) compiler producing the same `cmap`.
- Custom TrenchBroom game config + FGD.

### D-009 — Transport abstraction; WebSocket first, WebTransport later (2026-10-04, accepted)
**Decision:** all messages are designed for unreliable delivery (acks, baselines, redundancy). Ship WebSocket in M3; add WebTransport datagrams with fallback in M9.
**Why:** WebTransport reached all major browsers in 2026, but server-side tooling is younger. WebSocket's head-of-line blocking is acceptable early on.

### D-010 — Balance source of truth = UrT 4.3 damage table (2026-10-04, accepted)
**Decision:** `content/weapons/damage.json` mirrors `docs/04` §4 exactly (golden test). Fire rates, reloads and spread start as labeled estimates and get replaced by captured measurements.
**Consequences:** FACT values change only on Mustafa's explicit instruction.

### D-011 — Stable internal IDs; display names in content (2026-10-04, accepted)
**Decision:** weapons/items use archetype IDs (`rifle_ar`, `armor_vest`, …). Display names and type tags live in `content/names/*.json`. LR300/M4 twins merge into `rifle_ar`.
**Why:** naming (O-2) can change without code changes.

### D-012 — Visibility-based relevance as the primary anti-wallhack measure (2026-10-04, accepted for M9)
**Decision:** the server doesn't send enemy positions without potential line of sight (with hysteresis and leak radius); unseen players produce coarse audio events only.
**Why:** browser clients are fully inspectable; data never sent can't be revealed.

### D-013 — Art direction: "Comic Noir" (2026-10-04, accepted)
**Context:** O-4 was open. The game needs its own visual identity (pillar 5) that stays readable at competitive speed and fits the browser performance budgets.
**Decision:**
- Adopt **"Comic Noir"**: a modern Franco-Belgian comic look inspired by XIII (2003), rebuilt for a competitive browser FPS. The rules live in `docs/08`; `docs/08a` is reference research, not rules.
- Core techniques: banded lighting with tinted shadows over baked lightmaps, pixel-width hull outlines on actors, compiler-emitted crease lines plus a screen-space edge pass, world-space hatching on environments only, onomatopoeia lettering and comic panels.
- When rules collide: readability and fairness → performance budgets → style fidelity.
- Borrow the style family only: no XIII characters, story elements, logos, UI layouts or traced art (`docs/08` §3).
- Onomatopoeia is generated only from sound events the client legitimately receives (`docs/08` §11.2).

**Why:** flat color, baked light and ink lines are cheap to render in a browser and suit brush-built maps (`docs/08` §6, §7.2). Onomatopoeia doubles as a fair sound visualizer and an accessibility feature (`docs/08` §11).
**Consequences:**
- Exact parameters (bands, line widths, palettes, team colors, lettering font) are locked in look-dev (`docs/08` §17) and recorded in a later D-entry.
- Art work starts before M8 (`docs/08` §18): an optional style spike after M2, crease-line data from the compiler in M5, comic FX and UI hooks in M6–M7.
- Baked world lighting narrows the `docs/07` §5 lighting choice to a lightmap bake (options 1–2).

### D-014 — Working title: "In Shambles" (2026-10-04, accepted)
**Context:** O-1 (working title and branding) was open.
**Decision:** the working title is **"In Shambles"**. O-1's trademark rule still applies: no "Urban Terror", "UrT" or "FrozenSand" in names or branding.
**Consequences:** use "In Shambles" wherever player-facing text needs the game's name (page title, menus, server list). As a working title it can still change; check it against existing game titles and trademarks before a public release.

### D-015 — The dedicated-server dev command is `pnpm dev:server` (2026-10-04, accepted)
**Context:** the docs named it `pnpm server`, but pnpm 10 has a built-in `pnpm server` command (it manages a store server). Built-in commands take priority over package scripts, so `pnpm server` silently did nothing and exited 0.
**Decision:** the root script is `dev:server`. It runs the server from source with tsx. Production runs the esbuild bundle that `pnpm build` produces (`node packages/server/dist/main.js`).
**Consequences:** CLAUDE.md, `docs/06` §11, `docs/09` M0 and the M0 prompt say `pnpm dev:server`. New root scripts must not reuse a pnpm built-in command name, and root scripts that use `pnpm --filter` pass `--fail-if-no-match`, so a wrong filter fails instead of silently succeeding.

### D-016 — Deterministic math (2026-10-05, accepted)
**Context:** prediction needs client and server to compute bit-identical results. ECMA-262 lets engines approximate `Math.sin`, `cos`, `atan2`, `pow`, `exp`, `log`, `hypot` and the other transcendental functions, so Chrome, Firefox and Safari can return different bits for the same input. A one-ulp difference is enough to diverge a predicted state from the server's.
**Decision:**
- **Banned** in `packages/shared` and in compiler code that produces output (the greybox compiler from M1, `mapc` later): `Math.acos`, `acosh`, `asin`, `asinh`, `atan`, `atanh`, `atan2`, `cbrt`, `cos`, `cosh`, `exp`, `expm1`, `hypot`, `log`, `log1p`, `log10`, `log2`, `pow`, `sin`, `sinh`, `tan`, `tanh`, and the `**`/`**=` operators (they are `pow`).
- **Allowed**, because the spec rounds them exactly: `+ − * / %`, `Math.sqrt`, `fround`, `round` (halves toward +∞), `floor`, `ceil`, `trunc`, `abs`, `sign`, `min`, `max`, `imul`, `clz32`, bitwise operators, number literal parsing, and constants such as `Math.PI`.
- **Trig:** `math/dtrig.ts` builds `dsin`/`dcos` from exact operations only (Cody–Waite reduction, Taylor polynomials, |x| < 1e5), plus a quarter-wave table for u16 angles: `sinU16`/`cosU16` are exact at the cardinal angles and exactly odd and even.
- **Vectors** are `Float64Array`s with out-params. Modules keep named scratch vectors instead of sharing a general pool, which would add bookkeeping and aliasing bugs for no allocation benefit (`docs/06` §3 and §5).
- Never route sim values through a `Float32Array` (render code copies, never writes back), never store NaN, normalize −0 to +0 when quantizing, and never enable "unsafe math" minifier options.
- `dpow` (from deterministic exp and log) follows in M4 for the fall-damage curve.

**Consequences:**
- The shared purity guard rejects the banned names and `**`, and flags any use of `Math` other than `Math.<allowed member>` (computed access, optional chaining, aliasing, destructuring). The rules live in `packages/tools/src/code/deterministicMath.ts`, so compiler code can reuse them.
- Committed determinism vectors (`packages/shared/test/vectors/determinism.ts`, input bits → output bits for dtrig, quantizers, `quantizePlayerState`, `sanitizeUserCmd`, Mulberry32 and hash32) are recomputed by the tests; M2 replays them in Chrome, Firefox and Safari (`docs/09` M2, `docs/10` §1).
- Constants that were written with `**` in shared (the cvar registry's i32 range) are now literals.

### D-018 — PlayerState and UserCmd layout for M1 (2026-10-05, accepted)
**Context:** M1 implements `PlayerState` (`docs/03` §6) and `UserCmd` (`docs/05` §3.4). Both docs leave the bit order, the fixed-point stamina format and the field ranges open, and `docs/05` lists "kick-eligible" among the buttons although it reads as derived state. (D-017 is reserved for the M1 trace epsilon and snapping decision, written with the M1 doc updates.)
**Decision:**
- **Kick-eligible is not a button.** It reads as state derived from the player and the weapon, not an input, so it is left out until the kick is built in M4 (M1 plan, open question 1). `buttons` bits 0–11 are attack … drop in the `docs/05` order; bits 12–15 are spare.
- **Stamina** is an integer count of hundredths (u16). `flags` bits 0–9 are the `docs/03` §6 flags in the listed order.
- **Ranges:** `groundEntity` −1 (none) to 32767 (the world); `waterLevel` 0–3; move axes ±127 (the i8 never carries −128); pitch ±89°; `weaponSlot` 0–7 (the knife plus the seven `docs/04` §9 loadout slots); `tick` 0…2^30 − 1 (not the full u32), so ticks stay V8 small integers (about 207 days at 60 Hz).
- `quantizePlayerState` maps a non-finite `groundEntity` to −1, not 0, because 0 is a real entity. `sanitizeUserCmd` clamps and masks untrusted input and never throws.

**Consequences:**
- `docs/03` §6 and `docs/05` §3.4 carry "Pinned down in M1" notes; the code is in `packages/shared/src/sim/`.
- Open for later milestones: whether kick-eligible needs any wire bit (M4), which `weaponSlot` index is which and whether out-of-range slots clamp or mean "no change" (weapon switching), and the hull label in `docs/03` §2.

---

<!-- Template
### D-### — Title (YYYY-MM-DD, proposed|accepted|superseded by D-###)
**Context:**
**Decision:**
**Consequences:**
-->
