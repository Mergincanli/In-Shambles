# 11 — Decision Log

> Append-only. Format: `D-### — Title (date, status)`, then Context / Decision / Consequences. Superseded decisions stay, marked `superseded by D-###`.
> Open decisions owned by Mustafa are tracked in `docs/01` (O-#). When one is decided, add a D-entry here.
> "M1 plan" (its increments, open questions and risks) and "M1 design" (sections A–J, also cited bare as "A.4" or "design G") refer to the records in `docs/design/M1-plan.md` and `docs/design/M1-design.md`.

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
- The same guard flags any bare `Date` (an alias would reach `Date.now`), locale-dependent APIs (`localeCompare`, `toLocale*`, `Intl`), whose results vary by engine and locale, and `\u` escapes outside strings, which would hide a banned identifier from every name rule.
- Committed determinism vectors (`packages/shared/test/vectors/determinism.ts`, input bits → output bits for dtrig, quantizers, `quantizePlayerState`, `sanitizeUserCmd`, Mulberry32 and hash32) are recomputed by the tests; M2 replays them in Chrome, Firefox and Safari (`docs/09` M2, `docs/10` §1).
- Constants that were written with `**` in shared (the cvar registry's i32 range) are now literals.

### D-017 — Trace epsilon, touching, and snapping to the nearest clear grid point (2026-10-05, accepted)
**Context:** M1 builds the brush traces (M1 design A, `docs/design/M1-design.md`) and needs a rule for contact. `docs/05` §4.1 and `docs/03` §6 rounded the origin to the nearest 1/32 u every tick. That is safe after a single stop, but not across repeated slides on a slope or a rotated wall: sliding keeps the distance to the plane unchanged, each tick's rounding moves the box by up to √3/64 u along the normal, and nothing pulls it back. Within tens of ticks the box sits inside the brush, the next trace starts solid and the player is stuck. Axis-aligned planes at grid distances can't drift, so only slopes and angled walls (the kick lanes) show it.
**Decision:**
- **ε = 1/32 u** (`TRACE_EPSILON` in `packages/shared/src/world/trace.ts`): a trace stops one skin short of the surface it hits. It is a design constant, not a cvar: client and server must trace identically, and ε is not a feel knob. It is exact in binary and one origin grid step.
- **Touching counts as outside.** Inside a brush means strictly behind every plane, so a box that exactly touches a brush is clear: a spawn with its feet on the floor, or a box flush against two brushes.
- **Trace rules:** entering times stop ε early and leaving times are exact, so in exact math a box can touch a brush but never enter it. A move that does not approach a plane, as computed, is free, which covers sliding on a face or inside the skin; one that approaches it from inside the skin stops at once without `startSolid`. Ties between brushes go to the lower brush index, so the result never depends on visiting order. `endpos` copies the end exactly at fraction 1 and the start at fraction 0, and the reported plane is the brush plane, not the box-expanded one.
- **End-of-tick snap** (`snapOrigin`): the nearest **clear** 1/32 u grid point, in this order:
  1. the rounded point, if a position test says it is clear;
  2. otherwise the 8 corners of the grid cell holding the exact position, nearest first, ties in corner bit order (bit 0 = x rounded up, bit 1 = y, bit 2 = z);
  3. otherwise last tick's origin, which was on the grid and clear.
- The snap tests world brushes only (the mask excludes players), so a client's prediction never depends on where it thinks other players are. The common case costs one position test per player-tick.

**Consequences:**
- pmove calls `snapOrigin` at the end of every tick from M2, instead of plain rounding. `quantizeOrigin` stays the codec primitive: the snap only chooses which grid point, and the result is already on the grid. Positions stay out of solid by induction: traces never end inside a brush, the snap never accepts a solid point, and the course tests check that spawns are clear.
- **Map metrics:** on a flat floor a player rests at floor + 1/32. Crouched, the hull top is then at 40 + 1/32 u, so a 40 u gap blocks: slide gaps are 41–44 u (the courses use 41, 42 and 44) and the crouch tunnel is 48 u. An 18 u step still clears and a 19 u step blocks. `docs/07` §3 and §6 say so.
- `docs/05` §4.1 and `docs/03` §6 say "nearest clear 1/32 u grid point"; `docs/03` §4 states the trace contract.
- **Tangency is not exact on angled planes.** On slopes and rotated walls a move along the stored plane can round to approaching it by a few ulps (about 1e-14 u), and from inside the skin that stops the trace at fraction 0. We keep the rule table rather than add a tolerance, because a tolerance would let slow inward drift through; M2's slide move leaves a plane through the overclip (`docs/03` §4.7) and the same-plane nudge (§4.8), not exact tangency. The M2 feel tests on the slope set watch for stalls.
- An `allSolid` trace reports no hit (brush and plane −1, zero normal, no surface flags; contents are the brushes it started in), even when a later brush lies on its path: the box never moves, so that brush is not a contact (M1 review; one committed trace vector changed).
- Traces and position queries reject coordinates beyond ±2^20 u (`TRACE_COORD_LIMIT`) like NaN: farther out, f64 rounding eats the skin and then whole brushes.
- The cost is corner snags of up to ε when a box passes within ε of an edge. Shrinking the leaving time by ε instead would allow real penetrations of up to ε, which would show up as `startSolid` on the next tick.
- Tests: `packages/shared/test/world/{trace,traceQueries,snapOrigin}.test.ts`, including slide-and-snap chains on 0.69/0.71/0.8 slopes and 15/30/45/60° walls: the snap never goes solid, and plain rounding does on every surface except the 45° wall, where rounding x and y moves the plane distance monotonically and by less than ε, so it cannot drift. Committed trace vectors in `packages/shared/test/vectors/trace.ts` (input bits → output bits on a fixed world) are recomputed by the tests, and M2 replays them in browsers. The increment 9 fuzz test adds 200-step snap chains (P7).

### D-018 — PlayerState and UserCmd layout for M1 (2026-10-05, accepted)
**Context:** M1 implements `PlayerState` (`docs/03` §6) and `UserCmd` (`docs/05` §3.4). Both docs leave the bit order, the fixed-point stamina format and the field ranges open, and `docs/05` lists "kick-eligible" among the buttons although it reads as derived state.
**Decision:**
- **Kick-eligible is not a button.** It reads as state derived from the player and the weapon, not an input, so it is left out until the kick is built in M4 (M1 plan, open question 1). `buttons` bits 0–11 are attack … drop in the `docs/05` order; bits 12–15 are spare.
- **Stamina** is an integer count of hundredths (u16). `flags` bits 0–9 are the `docs/03` §6 flags in the listed order.
- **Ranges:** `origin` ±16384 u and `velocity` ±(2^19 − 1)/16 u/s (±32767.9375, the i20 range) per axis, clamped by the end-of-tick quantizers so a stored value is exactly what the codec carries; `groundEntity` −1 (none) to 32767 (the world); `waterLevel` 0–3; move axes ±127 (the i8 never carries −128); pitch ±89°; `weaponSlot` 0–7 (the knife plus the seven `docs/04` §9 loadout slots); `tick` 0…2^30 − 1 (not the full u32), so ticks stay V8 small integers (about 207 days at 60 Hz).
- `quantizePlayerState` maps a non-finite `groundEntity` to −1, not 0, because 0 is a real entity. `sanitizeUserCmd` clamps and masks untrusted input and never throws. It is idempotent, and the client applies it before predicting, storing and sending a cmd (`docs/05` §5), so client and server simulate the same cmd.

**Consequences:**
- `docs/03` §6 and `docs/05` §3.4 carry "Pinned down in M1" notes; the code is in `packages/shared/src/sim/`.
- M1 implements the `docs/03` §6 fields `origin`, `velocity`, the view angles, `flags`, `groundEntity`, `waterLevel` and `stamina`. `wallJumps`, `health`, `armor`, `breathMs`/`drownMs`, `climbTarget`, the timers and `movementEvents` are appended to `PlayerState` (with their quantize, codec and parity coverage) by the milestone that first simulates them.
- Open for later milestones: whether kick-eligible needs any wire bit (M4), and which `weaponSlot` index is which and whether out-of-range slots clamp or mean "no change" (weapon switching). The `docs/03` §2 hull table is labelled FACT for Q3 (Mustafa, 2026-10-06).

### D-019 — Brush contents, surface flags and build rules for M1 (2026-10-05, accepted)
**Context:** M1 implements the collision brushes of `docs/07` §2. The doc names the contents flags and optional per-side surface flags but leaves their bits open, and §4.3 says to reject degenerate brushes without saying what degenerate means. Traces also need bevel planes, which the doc does not mention (M1 design B).
**Decision:**
- Contents bits 0–7 in the `docs/07` §2 order; masks `MASK_PLAYERSOLID` (solid + playerclip), `MASK_SOLID`, `MASK_WATER`.
- Surface flags per side: ladder, slick and nodamage bits (`docs/03` §4.10, §4.14, §5.6), plus a 4-bit footstep material field (`docs/07` §6 prefixes). M2 decides whether ladders use the face flag or the LADDER volume; M1 provides both.
- Brushes are built from f32-rounded planes, so polygons, bevels, bounds and render vertices agree with what traces use. Axial bevels follow the faces with outward-rounded distances; they make boxes, boxes rotated about Z and axis-aligned wedges exact. `buildBrush` adds only axial bevels, so other shapes build but trace inexactly: the greybox MapBuilder (increment 7) rejects shapes that would need edge bevels, and `mapc` adds edge bevels in M5.
- Cleanup rules the design left open: a vertex near its neighbours' line (1e-4 u) is removed only when it lies on fewer than 3 kept faces, so a real corner where two faces meet almost flat stays; vertices within 1e-5 u of an exactly axial face snap onto it, so axial coordinates are exact and the face distance is a tight bound.
- Each brush's bounds must be exactly the distances of six axial planes among its faces and bevels; `createCollisionWorld` rejects other bounds (increment 5). The BVH culls by these bounds, so a brush reaching past them would make `traceBox` drop hits that `traceBoxBrute` reports.
- Validation thresholds: weld 1/64 u (§4.3), minimum edge 1/8 u, no two vertices of a face within the weld distance, minimum volume above 1 u³, vertex-on-plane tolerance 1e-4 u, world limit ±16384 u (a plane further than 16384·√3 + 1 u from the origin is rejected up front, since no face of an in-bounds brush can be there).

**Consequences:**
- `docs/07` §2 carries a "Pinned down in M1" note and `docs/06` §3 lists the world modules.
- The shared polygonizer is the single implementation: the greybox compiler (M1), `mapc` (M5) and the trace fuzz oracle all use it, and its own tests cross-check it against brute-force triple-plane intersection.
- Outward-rounded bevels make the traced brush reach up to one f32 step of the coordinate past its vertices (about 1e-4 u at 1000 u, 1e-3 u near the ±16384 u limit), and position tests call a box in that sliver solid. Traces stop ε short of bevels like any other plane and the snap only accepts clear points, so a player never ends up there. The trace fuzz test (`packages/tools/test/fuzz/`) compares traces with exact geometry, so wherever the runtime may report contact beyond the true brush (P2, P3, P4) it allows that brush's sliver on top of τ = 1e-5, capped at one f32 step of the brush's largest vertex coordinate so a misplaced bevel cannot widen its own tolerance. P1 inherits the allowance: it excuses the brushes the runtime puts the start inside, and by M1 design A.4 (a box may move out of a brush it starts in) a box starting in the sliver may move through that brush; P2 bounds that set to τ + sliver, and such starts are unreachable in play. P4 checks the stop two-sided: at most M1 design G's 2√3·ε + τ (+ sliver), and at least ε − 1e-6 when the trace moved, because the entering plane is then exactly ε away.

### D-020 — cmap v1 layout: contentHash in a binary preamble (2026-10-05, accepted)
**Context:** `docs/07` §2 put `contentHash` in the JSON header, which would make the hash cover a header that contains it, and allowed a `.cmap.json` + `.cmap.bin` pair in dev. D-008 fixes the format's role, not its layout (M1 plan, spec change 3).
**Decision:**
- One little-endian file: a 32-byte preamble (magic, `formatVersion`, JSON length, section count, the 64-bit `contentHash`, total length), a section table, canonical ASCII JSON metadata, then 8-aligned binary sections (`PLNS`, `PLSF`, `BRSH`, `SURF`, `VTXS`, `IDXS`). No dev file pair: the greybox compiler writes the single file directly.
- `contentHash` is two Murmur3 x86_32 lanes over the whole file with the hash field read as zero: every other byte is covered, the hash never covers itself. This includes the preamble (the M1 plan said bytes [32, EOF)), so a corrupted `formatVersion`, length or reserved word also changes it. Identity and caching only, not security.
- The decoder accepts only the exact layout the encoder writes (sections contiguous in table order, zero padding, nothing after the last section, JSON followed by fewer than 8 spaces), so no two accepted files differ only in filler bytes.
- M1 review tightened this to the content the encoder writes as well: the JSON must be exactly `canonicalJson` of its parsed value (moved from tools to `packages/shared/src/world/canonicalJson.ts` so the decoder can check it), entity origins lie within ±16384 u, the header bounds equal the union of the brush bounds, and render surfaces tile `VTXS`/`IDXS` in order, one non-empty surface per material in increasing order. Overlapping surfaces made the index check cost surfaces × indices, so a small hostile file could stall a loader; tiled, it is linear. Every committed map already met these rules, so no map changed. A size cap for maps sent over the network is left to the milestone that first sends one.
- The BVH is built at load time, deterministically, not stored. Unknown section tags are ignored; `formatVersion` changes when the layout breaks, `compiler.version` when output changes on purpose.

**Consequences:**
- `docs/07` §2 carries the layout tables; `decodeCmap` validates everything and throws `CmapError`; `*.cmap` is `binary` in `.gitattributes`. Tests: `packages/tools/test/greybox/cmap.test.ts`, `packages/shared/test/world/cmap{,Hash}.test.ts`.

### D-021 — Greybox builder API and render-surface conventions (2026-10-05, accepted)
**Context:** M1 increment 7 builds the greybox compiler and `MapBuilder` (`docs/07` §3). The doc's API sketch has no slopes with a target normal, rotated boxes, ladders with a face flag or named anchors, which the courses need (M1 design I), and it leaves open where entity yaw goes, which faces render and how uv0 is mapped.
**Decision:**
- `MapBuilder` adds `slope` (rise = run·√(1 − nz²)/nz, returns the compiled wedge's f32 top so a platform at that z shares the crest's plane distance), `rotatedBox` (closed-form cos/sin, D-016), `ladder` (wall with the ladder surface flag plus a 16 u LADDER volume, both until M2 picks one, D-019) and `anchor` (`info_target` with `targetname`). `stairs`, `ramp` and `slope` return their top z.
- `ramp` must be axis-aligned; the builder throws otherwise. Every brush also passes an exactness check (each edge × axis, oriented outward between the edge's two face normals, is parallel within 1e-6 to an axis or points the same way as a face normal), so nothing that needs edge bevels compiles before `mapc` adds them in M5. A call that throws adds none of its brushes.
- Entity `angles` are [pitch, yaw, roll] in degrees, yaw 0 facing +x (now stated in `docs/07` §2); the builder stores yaw there as [0, yaw, 0], not in `props`.
- Render surfaces: one per material in material order (the table is in order of first use); solid brushes and water volumes render, clip, trigger, nodraw and other non-solid volumes don't; fans from each polygon's canonical start vertex, counter-clockwise from outside, f32 positions, flat face normals.
- uv0 is a world-space planar projection on the normal's dominant axis (ties to z, then x) at 1 uv per 64 u, which M2's grid texture relies on.
- `compile()` returns the decoded file (validated, with its hash); `compiler.version` starts at 1.

**Consequences:**
- `docs/07` §3 lists the API and conventions. Courses (increment 8) use anchors instead of coordinates in tests.
- The D-016 math ban now also guards `packages/tools/src/greybox` (`greybox-determinism.test.ts`), as D-016 already required.
- Tests: `packages/tools/test/greybox/{brushCompiler,mapBuilder}.test.ts`.
- Courses (increment 8): each course in `packages/tools/src/greybox/courses/` is a function that builds and returns its Cmap, listed in a fixed order in `courses/index.ts`. `pnpm greybox` writes them to `content/maps/<name>.cmap`, which is committed (M1 plan); a test fails with "run pnpm greybox and commit" when a file is stale. Anchors and spawns are standing spots (origin = ground + 24 u). `docs/07` §3 lists the sizes the courses pin down (lab area, water depths 12/36/128 u, slide gaps 41/42/44 u plus a blocking 40 u gap, 48 u tunnel, runway timers 2048 u apart, catch rails 64 u tall in separate columns so one catches a 768 u fall); they are design values, not ESTIMATEs of the original game.

---

<!-- Template
### D-### — Title (YYYY-MM-DD, proposed|accepted|superseded by D-###)
**Context:**
**Decision:**
**Consequences:**
-->
