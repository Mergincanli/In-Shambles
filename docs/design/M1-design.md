# M1 design: simulation core (headless)

> **Status:** the design record for M1, written before the code and kept so that citations such as "M1 design A.4" or "design G" in code, tests and `docs/11` resolve; section letters A–J are the ones below. It is not a spec: where it differs from `docs/03`–`docs/10` or the decision log, those win, and the approved plan (`docs/design/M1-plan.md`) wins over this record. Details pinned or changed while building M1 are in D-016–D-021, for example: the cmap hash covers the whole file with its own field read as zero, not bytes [32, EOF) as in E (D-020); `quantizePlayerState` maps a non-finite `groundEntity` to −1, not 0 (D-018); `weaponSlot` is 0–7 (D-018); an allSolid trace reports no hit brush or plane (D-017); traces reject coordinates beyond ±2^20 u (D-017); the polygonizer's cleanup rules and the fuzz test's sliver allowance (D-019); the builder API grew `rotatedBox` and `ladder` (D-021). It was written as a review of the first M1 draft, so "you" and "your draft" mean that draft.

Your draft is sound. These are the changes that matter most, most important first:

1. **Rounding positions to the 1/32 grid alone can push a player into solid on sloped or rotated planes.** It's safe after a single stop, but not across repeated slides. The fix is a collision-aware snap (A.9). That changes the spec, so it needs a new decision, D-017.
2. **Define "touching = outside".** It affects spawns, the 40 u gaps, and the trace rules (A.1, I).
3. **Break hit ties by brush index.** Then the trace result doesn't depend on BVH traversal order, and a brute-force trace must match the BVH trace bit for bit (C).
4. **Fix the quantization details** (H):
   - quantize normalizes −0 to +0 and clamps values to what the codec can store;
   - stamina is stored as integer hundredths;
   - every scalar field in PlayerState is an integer.
5. **The trig decision (D-016) must also cover the compiler and future pow/exp/log uses,** and the purity guard should ban the approximate Math functions and `**` (D).
6. **Put contentHash in the binary preamble** to avoid hashing a header that contains its own hash. Mark `*.cmap` as binary in `.gitattributes`, which is missing today (E).
7. **Add named anchor entities to the courses,** so tests don't hard-code coordinates (I).
8. **Tests that use the courses must live in `packages/tools/test`.** shared can't import tools, and it has no Node types to read `content/maps` (J).

---

## A. Trace algorithm

**A.1 Conventions**
- A brush is the intersection of half-spaces `n_i·x ≤ d_i`. "Inside the brush" means *strictly* inside: `f_i < 0` for every plane.
- **Touching (`f = 0`) counts as outside.** So a spawn at floor + 24 with feet exactly on the floor is valid, and positions that exactly touch two brushes are legal.
- ε = 1/32 (exactly representable).

**A.2 Per-trace setup** (works for uneven hulls such as −24/+32)
- Center offset `o = (mins + maxs)/2`, half extents `h = (maxs − mins)/2`.
- Work in center space: `S' = S + o`, `E' = E + o`.
- For each plane: `ext = |nx|·hx + |ny|·hy + |nz|·hz`, then `sd = n·S' − d − ext` and `ed = n·E' − d − ext`.
- This is the same as testing the box corner that sits furthest along −n (per axis: `mins_k` if `n_k ≥ 0`, else `maxs_k`).
- `traceRay` is the same code with `h = 0`.

**A.3 Rules per plane** (first match wins)

| Case | Condition | Action |
|---|---|---|
| Separating | `sd ≥ 0` and (`ed ≥ sd` or `ed ≥ ε`) | This brush can't be hit and can't contain the start. Skip the brush. |
| Entering | `sd ≥ 0` (and `ed < min(sd, ε)`) | `t = (sd − ε)/(sd − ed)`. The denominator is > 0 and t < 1 is guaranteed. If `t > tEnter`, set `tEnter = t` and `hitPlane = i`; a strict `>` keeps the first plane on ties. |
| Leaving | `sd < 0` and `ed > 0` | `t = sd/(sd − ed)`, the exact touch time with no ε. `tLeave = min(tLeave, t)`. |
| Inside throughout | `sd < 0` and `ed ≤ 0` | No constraint. |

Start with `tEnter = −Infinity` and `tLeave = 1`. A division only happens when `sd ≠ ed`, so parallel motion never divides by zero. Nearly parallel motion gives a large negative t, which is clamped to 0 later.

**A.4 Result per brush**
- **No entering plane** (every `sd < 0`): `startSolid = true`, and contents gets this brush's flags. If every `ed < 0` as well: `allSolid = true`, fraction = 0. Otherwise the brush puts no limit on the fraction, so you can move out of a brush you started in.
- **Otherwise, if `tEnter < tLeave`:** the candidate is `t = max(0, tEnter)`. It replaces the best hit if `t < best`, or if `t === best` and this brush's index is lower.

**A.5 Result across brushes**
- **Fraction:** the minimum over hit brushes; ties go to the lower brush index.
- **startSolid / allSolid:** true if any brush sets them. allSolid means fraction = 0.
- **endpos:**
  - fraction = 1: copy E exactly (`S + 1·(E − S)` can be off by one ulp).
  - fraction = 0: copy S.
  - otherwise: `S_k + f·(E_k − S_k)`, computed in origin space so o never enters it.
- **Reported plane:** the *unexpanded* brush plane (normal and dist) of the hit plane. On an exact edge tie the earliest plane in brush order wins, and faces are stored before bevels.
- **Other fields:** contents of the hit brush, plus the contents of any brush the trace started in; the hit plane's surface flags; entity = `ENTITY_WORLD` (propose 32767, which fits groundEntity's i16) or `ENTITY_NONE = −1`.

**A.6 Special cases**
- **Zero-length trace** (`S == E`): every plane is either separating or inside, so it is a pure position test. It returns fraction 1 or startSolid + allSolid. Expose it as `positionTest()`.
- **Grazing:**
  - Sliding exactly on a face (`sd = ed = 0`) or inside the skin (`0 < sd = ed < ε`) is separating, so wall and floor slides are free.
  - Starting in the skin and moving inward gives fraction 0, not startSolid.

**A.7 Why this never lets a box penetrate** (exact math)
- On a hit, the fraction is at most `t_e < t_touch` of the binding plane, so `f_binding ≥ ε > 0` over the whole swept part.
- With no hit, `tEnter_dilated ≥ tLeave` implies `t_touch_max ≥ tLeave`, so there is no t at which every `f_i < 0`.

So the dilated enter / exact leave pair gives **zero penetration**. The cost is corner snags of up to ε when a box passes within ε of an edge. Don't shrink the leave time by ε: that allows real corner penetrations of up to ε, which then show up as startSolid on the next tick.

**A.8 Numeric notes**
- **Planes:** stored as f32 in the file and widened into a Float64Array at load. f32 → f64 is exact, so every engine sees the same values.
- **f32 rounding error:** normals are off from unit length by about 6e-8, and at 16384 u the f32 step in d is about 0.002 u. Both are far below ε.
- **Order of operations:** use one fixed formula everywhere. ECMAScript rounds every operation to binary64, so results are identical across engines (see D).
- **NaN:** never let NaN into state; DEV_ASSERT that start and end are finite.

**A.9 Is ε = 1/32 with a 1/32 grid safe?**

For a single stop, yes. Rounding each axis by up to 1/64 changes `f` by at most `|n|₁/64 ≤ √3/64 ≈ 0.0271`. After a stop, `f = 0.03125`, so `f` stays ≥ 0.0042 after rounding.

Across repeated parallel slides on a slope or rotated wall, **no**:
- Sliding keeps `f` unchanged (separating case), and each tick's rounding adds an error of roughly ±0.009 standard deviation along n.
- Nothing pulls `f` back to ε: walking clips velocity to the plane, and overclip only adds about 0.001·v.
- So `f` wanders below 0 within tens of ticks. The next trace is then startSolid and the player is stuck.
- Axis-aligned planes with integer distances can't drift, because `f` stays on the grid. The problem hits exactly the slope and kick-lane tests.

**Fix (propose D-017): snap to the nearest *clear* grid point.** Ship `snapOrigin(world, exact, mins, maxs, mask, prevOrigin, out)` in M1; pmove calls it at end of tick in M2.
1. Round to the nearest grid point. If `positionTest` says it's clear, take it.
2. Otherwise try the 8 corners of the grid cell around the exact position. Order them by squared distance (ties by corner bit order) and take the first clear one.
3. Otherwise keep `prevOrigin`, which is on the grid and was clear last tick.

It costs one position test per player-tick, roughly 0.2–0.4 µs. Test against world brushes only, not other players, so prediction stays stable. Update docs/05 §4.1 and docs/03 §6 from "nearest 1/32" to "nearest clear 1/32 grid point".

Nothing else is needed. Positions stay out of solid by induction:
- traces never end inside a brush (A.7);
- snapping never accepts a solid position;
- the course tests verify that spawns are clear.

**A.10 What ε means for geometry**
- On flat axis-aligned floors the player rests at exactly floor + 1/32.
- Crouched, the hull top is then at 40 + 1/32, so **a 40 u gap blocks**; clearance must be at least 40 + 1/32. See I.
- Steps still work: an 18 u step clears (bottom at 18 + ε after stepping up) and a 19 u step blocks.

**A.11 Result object.** A class with fields set in a fixed order:

```ts
class TraceResult {
  fraction = 1;
  readonly endpos = new Float64Array(3);
  readonly normal = new Float64Array(3);
  planeDist = 0;
  plane = -1;
  brush = -1;
  contents = 0;
  surfaceFlags = 0;
  entity = -1;
  startSolid = false;
  allSolid = false;
}
```

Signature: `traceBox(world, start, end, mins, maxs, mask, out): void`. Also add `pointContents(world, p)` and `boxContents(world, mins, maxs)`; M2 needs them for water level and ladders, and they cost little.

## B. Bevels

Faces of the Minkowski sum of a brush P and a box come from three normal sets:
1. P's face normals;
2. the box face normals, which are the axes (giving P's bounding-box planes, i.e. the axial bevels);
3. `e × axis` for each edge e of P.

Without them the expanded-plane test is a **superset** of the true shape. That means false positives: phantom collisions near non-axis-aligned edges and corners, reported with the wrong normal, plus bumps at ramp crests. It never causes tunneling.

For the M1 shapes, every `e × axis` normal is either an axis or an existing face normal:
- **Axis-aligned boxes:** trivially exact.
- **Boxes rotated around Z:** horizontal edges give ±z or the perpendicular face normal; vertical edges give axes.
- **Wedges or ramps whose slope runs along an axis and whose sides are axis-aligned:** the hypotenuse edge (0, c, s) gives ±x or ±(slope normal); the other edges are axis-aligned.

**So axial bevels make every M1 shape exact.** The +z bevel at a ramp crest correctly reports flat ground when you stand over the edge.

Edge bevels are only needed for general brushes (M5) or ramps turned off an axis. For now, have the builder throw on those. The M5 algorithm, for each polygon edge `(a, b)` and each axis k:
- Let `n = normalize((b − a) × axis_k)`; skip if the length is below 1e-6.
- For each sign: `d = max_v n·v`. Accept if both a and b lie within 1e-6 of d and no existing plane has a matching normal.

**Compile rule:** add bevels *after* polygonization, because a bevel only touches an edge and would make an empty polygon. Round bevel d outward: if `fround(d)` falls inside, step to the next f32 outward through the bit pattern. Order planes as faces, then bevels. The axial planes double as the brush bounds.

**Check:** the fuzz test's two-sided "no phantom hits" property (G, P4) catches any missing bevel.

## C. BVH

- **Built at load time, in shared, deterministically. Not stored in the file.** At a few hundred to a few thousand brushes it takes well under 1 ms, and it leaves out a format you'd have to version.
- **Build: binned SAH from the start**, not median split. movement_lab mixes huge brushes (floor, outer walls) with small boxes. With median split the huge brushes inflate their siblings' bounds, so every query visits that subtree; SAH pushes big brushes toward the root.
  - Use 16 bins along the longest axis of the centroid bounds; ties go x < y < z.
  - Cost = `area(L)·nL + area(R)·nR` against leaf cost `n`; make a leaf at n ≤ 2 or when no split beats the leaf.
  - When centroids coincide, fall back to a median split sorted by (centroid, brush index). Cap depth at 48.
  - `Array.prototype.sort` is stable, and the comparator must be total.
- **Layout** (depth-first, so the left child is `i + 1`):

```
nodeBounds Float64Array(6N)  [minx,miny,minz,maxx,maxy,maxz]
nodeFirst  Int32Array(N)     right child index (internal) | first leafRef (leaf)
nodeCount  Int32Array(N)     0 = internal, >0 = leaf brush count
nodeAxis   Uint8Array(N)     split axis (for near-first ordering)
leafRefs   Uint32Array       brush indices, ascending within a leaf
brush:     planeStart Uint32Array, planeCount Uint16Array, faceCount Uint16Array,
           contents Uint32Array, bounds Float64Array(6B)
planes     Float64Array(4P)  nx,ny,nz,d ; planeSurf Uint32Array(P)
```

- **Traversal:** iterative, with a stack `Int32Array(64)` owned by the world. Synchronous and non-reentrant calls make this safe even with several matches in one process.
  1. **Node test 1:** query box overlap, where the query box is `[min(S,E) + mins − m, max(S,E) + maxs + m]` and `m = 1/16` (ε plus slack).
  2. **Node test 2, long traces only** (any `|ΔE−S|` > 64): a slab test of `S'→E'` against node bounds grown by `h + m`, with precomputed `1/Δ`. When `Δ_k = 0`, use an inside/outside branch to avoid `0·∞ = NaN`.
  3. Push the far child first, so the near child is visited first. Prune a node if its slab entry time is strictly greater than the best fraction.
  4. In leaves, check each brush's bounds against the query box (6 compares) before the plane loop. Each brush is in exactly one leaf, so no duplicate-visit tracking is needed.
- **Why the result doesn't depend on traversal order:**
  - With axial bevels, the stop point lies inside the brush bounds grown by ε, so the node margin m covers it.
  - Ties go to the lower brush index, and startSolid / allSolid are combined with OR.
  - So the BVH only affects speed. Test that `traceBox` and `traceBoxBrute` return identical bits on every fuzz case.
- **Expected speed in V8:** a short move (≤ 12 u) visits about 10–25 nodes at about 5 ns each and tests 2–5 brushes of 6–10 planes at about 3 ns per plane. That is about 150–450 ns, inside the 1 µs budget.
  - If it comes in over budget, the first optimization is a per-plane type tag (axis x/y/z or general), so axis-aligned planes skip the dot product.
- **V8 hygiene:**
  - Every vector is a Float64Array, never `number[]` and never Float32Array at the same call site.
  - World and result objects are classes with all fields set in the constructor in a fixed order.
  - No closures, `for…of`, destructuring or optional fields in the hot path.
  - Store integer data in Int32/Uint32 arrays.
- **Scratch vectors:** prefer named per-module scratch over a general vec3 pool. A pool adds bookkeeping and aliasing bugs. Rule: a function that uses its module's scratch must not call another function in that module that uses the same scratch.

## D. Deterministic math (D-016)

- **ECMA-262 marks these as approximate (allowed to differ between engines). Ban them from shared, and from compiler code that produces output:** acos, acosh, asin, asinh, atan, atanh, atan2, cbrt, cos, cosh, exp, expm1, **hypot**, log, log1p, log10, log2, **pow and `**`**, sin, sinh, tan, tanh.
- **Exact per spec (safe):**
  - `+ − * / %`
  - **Math.sqrt** (correctly rounded)
  - **Math.fround** (rounds to nearest-even f32)
  - **Math.round** (nearest, halves toward +∞; correct even for 0.49999999999999994 in modern engines)
  - floor, ceil, trunc, abs, sign, min, max, **imul**, clz32
  - all bitwise ops, number literal parsing, `Number→String`, Math.PI, Math.SQRT1_2
- **Platform behavior:**
  - **FMA:** engines can't fuse `a*b + c`, because every operation must round to binary64.
  - **x87:** not a concern; every current engine uses SSE2 on x86 and normal NEON doubles on ARM.
  - **Denormals:** the spec requires gradual underflow, and no engine flushes them to zero.
  - **NaN:** payload bits aren't canonical, so never store NaN.
  - **−0:** normalize it in quantize (see H). Otherwise it can turn into `1/−0 = −∞` in slab inverses.
- **Build-tool pitfalls:**
  - Never enable "unsafe math" in a minifier; esbuild doesn't use it.
  - Never send sim values through a Float32Array; render code must copy, not write back.
  - Use a single `TICK_DT` constant.
- **Implementation:** `math/dtrig.ts`, using only exact operations.
  - **Reduction:** `dsin(x)` / `dcos(x)` reduce the argument with `k = Math.round(x·2/π)`, then `r = (x − k·P1) − k·P2`, where P1 + P2 = π/2 and P1 has trailing zero bits, valid for |x| < 1e5. Then pick the quadrant.
  - **Polynomials:** degree-15 sine and degree-16 cosine Taylor series on |r| ≤ π/4, evaluated with Horner's rule. The truncation error is below 5e-17, so results are within 1–2 ulp, and deterministic regardless.
- **u16 angle table:** a quarter-wave `Float64Array(16385)` built when the module loads.
  - Use dsin for the first octant and dcos(π/2 − x) for the second.
  - Set `q[0] = 0` and `q[16384] = 1` exactly.
  - `sinU16(a)`: map the quadrant by symmetry and negate as needed. `cosU16(a) = sinU16(a + 16384)`.
  - This gives exact cardinal values and exact odd and even symmetry.
- **Accuracy:** about 1e-12 would be plenty for gameplay. What matters is determinism, exact cardinal angles, and symmetry.
- **Compiler:** the kick lanes use 15/30/60°, which don't fall on u16 steps (15° = 2730.67 units). Use closed forms built from sqrt (sin15 = (√6 − √2)/4, cos30 = √3/2, …) or dtrig.
- **Coming later:** M4's fall curve `x^1.6` needs `dpow = dexp(y·dlog(x))`; add it to the D-016 scope now.
- **Guard:** add the banned names, plus `**`, to the FORBIDDEN list in `shared-purity.test.ts`. The scanner already separates code from strings.

## E. cmap encoding (v1)

**Layout** (all little-endian, read and written through DataView):
```
0  "CMAP" (4 ASCII bytes)       16 u32 hashLo   20 u32 hashHi   (64-bit hash of bytes [32, EOF))
4  u32 formatVersion = 1        24 u32 totalByteLength           28 u32 reserved = 0
8  u32 jsonByteLength (padded with spaces to a multiple of 8)    12 u32 sectionCount
32 section table: sectionCount × {u32 tag(fourcc), u32 offset(8-aligned), u32 byteLength, u32 count}
.. ASCII JSON, then sections in table order, each zero-padded to 8 bytes
```

**Sections:**

| Tag | Record | Contents |
|---|---|---|
| `PLNS` | 16 B | f32 nx, ny, nz, d (faces then bevels, brush by brush) |
| `PLSF` | 8 B | u32 surfaceFlags, i32 material (−1 for a bevel) |
| `BRSH` | 40 B | u32 firstPlane, u32 planeCount, u32 faceCount, u32 contents, f32 × 6 bounds |
| `SURF` | 24 B | u32 material, firstVertex, vertexCount, firstIndex, indexCount, reserved |
| `VTXS` | 32 B | f32 position xyz, normal xyz, uv0 |
| `IDXS` | 4 B | u32 index |

**JSON** holds only metadata and strings: `bounds`, `compiler: {name, version}`, `entities: [{classname, origin?, angles?, props, brushes?}]`, `materials`, `name`, `units`, `up`. All geometry goes in binary.
- Write it with **your own canonical stringify**:
  - keys sorted by code unit;
  - numbers via `String(n)`, finite and never −0;
  - strings via `JSON.stringify`, then escape anything above 0x7E as `\uXXXX`, so the text is pure ASCII.
- Don't rely on `JSON.stringify` for objects. It puts integer-like keys first ("10" before "b"), whatever order you sorted them in.
- Keep out of the output: timestamps, file paths, git hashes, `localeCompare`.

**contentHash:**
- Two Murmur3 x86_32 lanes with different seeds, written from the published description and reading 32-bit little-endian words byte by byte. Report it as 16 hex digits.
- It's for identity and caching, not security.
- It lives in the preamble, which avoids hashing a header that contains its own hash. Change docs/07 §2 to say the header is the preamble plus the JSON.
- Reuse the same mixing step in `rng/hash32`.

**Decoder** (`shared/world/cmap.ts`): no TextDecoder.
- Check every JSON byte is below 0x80, build the string with `String.fromCharCode` in chunks of 4096 or fewer, then `JSON.parse`.
- Validate with your own code, not zod: magic, version, lengths, section bounds and alignment, `count × record size == byteLength`, index ranges, `faceCount ≤ planeCount`, finite floats, known contents bits, and the hash (optional).
- Throw `CmapError`. This runs at load time, so it doesn't break the "never throws in normal operation" rule.
- `buildCollisionWorld(cmap)` widens planes to f64 and builds the BVH.

**Versioning:**
- `formatVersion` changes when the layout breaks.
- `compiler.version` changes when compiler output changes on purpose, which explains why the committed .cmap files changed.
- Unknown section tags are ignored, so new sections can be added without a new version.

**Repo:** add `*.cmap binary` to `.gitattributes`. The current `* text=auto eol=lf` would otherwise risk line-ending conversion. When the recompile test fails it should say "run pnpm greybox and commit".

## F. Polygonization (`shared/world/polygonize.ts`; not a hot path, but only exact ops plus sqrt)

1. **Round first:** round the planes to f32 (`fround`), then derive everything from the rounded planes: polygons, bevels, bounds, render vertices and the fuzz oracle. This keeps all of them consistent with what the runtime uses.
2. **Base polygon:** for each face plane, build a large square on the plane.
   - Helper axis = the axis with the smallest `|n_k|`; `u = normalize(a × n)`, `v = n × u`, so `u × v = n` and the winding is counter-clockwise seen from outside.
   - Center `n·d`; half-size 2^16, given a world limit of ±16384.
3. **Clip** by every other plane, in plane order:
   - Classify each vertex with `ON = 1e-5`: in front, behind, or on the plane. Keep "behind" and "on".
   - For each crossing, insert `p + (q − p)·dp/(dp − dq)`, always measured from the earlier vertex in winding order.
   - If the polygon is empty or has an area below 1e-3, the plane is redundant: drop it.
4. **Clean up:**
   - Merge consecutive vertices within 1e-4 and remove collinear ones.
   - Weld vertices across the brush with a 1/64 u tolerance (docs/07): search the brush's earlier vertices in order and keep the first match.
   - Optionally snap values within 1e-7 of the 1/64 grid onto it, for clean axis-aligned output.
5. **Validate** (compile-time error with the brush's name):
   - at least 4 faces;
   - every edge shared by exactly 2 faces, and V − E + F = 2;
   - every vertex on at least 3 face planes and inside all planes within 1e-4;
   - minimum edge length 1/8 u, so welding can't merge two genuinely different vertices;
   - volume (divergence sum) above 1 u³.
6. **Canonical order:** rotate each polygon to start at its lexicographically smallest (x, y, z) vertex. Triangulate as a fan.
   - The Z-up to Y-up mapping `(x, z, −y)` has determinant +1, so counter-clockwise winding survives.
7. **Tests:**
   - Polygonized vertices must match each constructor's reference vertices within 1e-6.
   - Independent cross-check: intersect every triple of planes and keep the points inside all planes (fine at n ≤ 20). The resulting vertex set must match.

## G. Fuzz verifier (in `packages/tools/test`)

**Oracle:** the separation distance between the swept box (the convex hull of the box at S and at P(f)) and a brush, found by testing these axes:
- the brush's face normals;
- the three axes x, y, z;
- `d × x, d × y, d × z`, where d is the motion;
- `e × x, e × y, e × z, e × d` for each brush edge e.

Normalize each axis and skip any shorter than 1e-9.
- Swept-box interval: `[min(u·S′, u·P′) − r, max(u·S′, u·P′) + r]`, with `r = Σ|u_k|·h_k`.
- Brush interval: min and max of `u·v` over its vertices.
- `sep` = the largest gap over all axes. Positive means separated; negative means penetrating by −sep.

**Properties** (τ = 1e-5):

| ID | Property |
|---|---|
| P1 | **No tunneling.** The sweep up to P(f) has sep ≥ −τ against every masked brush the start isn't inside. |
| P2 | **startSolid is right.** If startSolid, some brush has sep(S) < τ. If not, every brush has sep(S) ≥ −τ. |
| P3 | **allSolid is right.** allSolid means fraction = 0 and the end is inside the same brush. |
| P4 | **No phantom hits.** If f < 1 and not startSolid, the box at P(f) is within 2√3·ε + τ of the hit brush. This catches missing bevels. |
| P5 | **BVH matches brute force bit for bit** (fraction, endpos, normal, brush, flags). |
| P6 | **Same case twice gives the same bits.** |
| P7 | **Snap chains never go solid.** 200 steps of trace + snap along every non-axis-aligned plane, with random tangential velocities and starting on the grid, never produce a startSolid. |

**Sampling** (about 20k cases, fixed seed; `FUZZ_SEED` and `FUZZ_CASES` override for long local runs):
- **Start positions:** 70% on the 1/32 grid. Distances from a face drawn from {0, 1/64, ε−1e-9, ε, ε+1e-9, 2ε, random}.
- **Directions:** into the face with jitter, parallel, tiny angles (1e-9 to 1e-2 rad), and aimed at vertices and edges.
- **Lengths:** 0, 0.25, 1–20, 18 vertical, and 100–4096 to try to pass through 1–4 u slabs.
- **Hulls:** standing, crouched, zero (ray), and random lopsided boxes.
- **Worlds:** the 5 courses plus synthetic piles of random boxes, Z-rotated boxes, axis-aligned wedges, abutting pairs and coplanar floor tiles.
- **Time:** about 2–5 µs per case (3–6 brushes × ~70 axes × ~12 vertices), so well under 2 s.
- **On failure:** print the seed, case index and inputs as f64 hex bits, so the case can become a permanent regression test.

**Independence:** the oracle depends on the polygonizer, so F's triple-intersection cross-check must pass first. Otherwise a dropped vertex could hide a tunnel.

## H. PlayerState and UserCmd

**PlayerState:** every scalar field holds an integer (so V8 keeps them as small integers) and every vector is a Float64Array. Future fields are appended at the end.

```ts
class PlayerState {
  readonly origin = new Float64Array(3);   // 1/32 grid
  readonly velocity = new Float64Array(3); // 1/16 grid
  viewYaw = 0;
  viewPitch = 0;       // u16 angle units
  flags = 0;           // PMF_* bits 0..9 from docs/03 §6
  groundEntity = -1;   // i16
  waterLevel = 0;      // 0..3
  stamina = 0;         // u16 integer hundredths (docs/03 §6 "fixed-point ×100")
}
```

**Functions:**
- `copyPlayerState(dst, src)`: uses `.set` for vectors; never allocates.
- `playerStateEquals(a, b)`: exact `===` comparison.
- `diffPlayerState`: for tests only.
- `PlayerStateRing(128)`: preallocated slots, indexed by `tick & 127`, each storing its tick so stale reads are detected.

**quantize** (pure):
- **Position and velocity:** `(Math.round(x·32) + 0)/32`, and the same at 16 for velocity.
  - Adding `+ 0` turns −0 into +0.
  - Multiplying and dividing by a power of two is exact, so quantize is idempotent.
  - Rounding is "half toward +∞", so `q(−x) ≠ −q(x)` exactly at halves; document this.
- **Clamps to the codec's range,** so the stored value is exactly what the codec can carry:
  - origin to ±16384;
  - velocity to ±(2^19 − 1)/16, the i20 range;
  - angles `& 0xFFFF`, flags `& FLAG_MASK`;
  - groundEntity to [−1, 32767], waterLevel to 0..3, stamina to 0..65535.
- DEV_ASSERT finite; in production, NaN becomes 0.
- Pure `quantize()` stays the codec and test primitive. pmove calls `snapOrigin` first, which makes origin rounding a no-op.

**UserCmd:** a class with integer fields `tick, buttons, forward, right, up, yaw, pitch, weaponSlot`.
- `sanitizeUserCmd`:
  - forward / right / up clamped to [−127, 127] integers (i8 allows −128; clamp it);
  - yaw `& 0xFFFF`;
  - pitch clamped to ±16201 units (floor(89·65536/360));
  - unknown button bits masked off;
  - weaponSlot ≤ the slot count from docs/04 §9.
- Button bits: ATTACK, JUMP, CROUCH, SPRINT, WALK, USE, RELOAD, BANDAGE, FIRE_MODE, ZOOM_IN, ZOOM_RESET, DROP. Four bits spare.
- docs/05's "kick-eligible" reads like derived state, not an input; ask before adding it as a button.
- `tick` stays a small integer only below 2^30 (about 207 days of play); note it.

**Side effects of the quantization rules, for M2 and M4:**
- **Stamina:** rounding to 0.01 every tick at 60 Hz means rates come in steps of 0.6/s. An 11/s drain becomes 10.8/s.
- **Position:** rounding each tick biases distance travelled. At 320 u/s a tick covers 170.67 grid steps, which rounds to 171, so the player covers 320.625 u/s while velocity still reads 320. Feel tests should measure velocity, not distance.

## I. Course notes

- **Named anchors:** `m.anchor(name, origin, yaw)` emits an `info_target`, so tests say "gap_96_takeoff" instead of coordinates.
- **Rotated ramps:** the builder throws on any ramp not aligned to an axis (they would need edge bevels).
- **Slopes:** use `m.slope({from, run, normalZ, width})`, which computes `rise = run·√(1 − nz²)/nz` with sqrt.
  - 0.8 is exact (a 3-4-5 triangle).
  - 0.71 needs rise/run = 0.99183; 0.69 needs 1.04900.
  - The sanity test checks `plane.nz === Math.fround(target)` and the correct side of 0.7.
  - Each ramp returns `topZ`, and its top platform is placed at that height, so the crest has no lip.
- **Kick lanes:** thin boxes rotated around Z (for example 512 × 16 × 256), with closed-form trig and their bottoms sunk 16 u into the floor.
  - They are at least 64 u tall and stand alone.
  - Add a 24 u curb next to them.
- **Slide gaps:** clearance must be ≥ 40 + 1/32. Use 41, 42 and 44 u, and optionally a 40 u gap marked as "expected to block".
  - Change docs/07 §6 from "40–44" to "41–44".
- **Crouch tunnel:** 48 u clearance, so crouched passes, standing is blocked, and standing up inside fails.
- **Water:** sample at feet, waist and eyes. Depths of 12 u (level 1), 36 u (level 2) and 128 u (level 3).
  - The fall tower's landing pool is 128 u deep. docs/03 §5.6 already excludes landings at level ≥ 2.
- **Ladders:** emit both a LADDER volume 16 u thick and a LADDER surface flag on the wall face behind it. docs/03 §4.14 needs a normal, and a volume doesn't provide one when you start inside it. M2 picks one.
- **Strafe room:** movement_lab needs a large open flat area, about 6144² u. Twelve circle-jump hops cover about 4000 u.
- **Runway markers:** alternating floor tiles every 128 u, which also tests that coplanar seams don't snag.
- **Sanity tests:**
  - every brush is valid;
  - bounds stay within ±16384 and nothing is NaN;
  - every spawn hull passes the position test and has ground within 1 u below;
  - spawns are at least 64 u apart;
  - movement_lab has steps of 16/18/19, three slope values, two water depths, a ladder and a tunnel;
  - every anchor exists;
  - arena_greybox has 16 `info_player_start` plus 8 red and 8 blue spawns.

## J. Build order (each step ends green)

| # | Increment |
|---|---|
| 1 | `time`, `math/{vec3, plane, aabb, quant, dtrig, angles}`, `rng/{mulberry32, hash32}` with fixed test vectors; extend the purity guard. |
| 2 | `sim/playerState` and `sim/usercmd`: structs, copy, equals, ring, quantize and sanitize tests. |
| 3 | `world/contents`, `CollisionWorld` built from raw arrays, `polygonize` plus the triple-intersection oracle. |
| 4 | Brute-force `traceBox` / `traceRay` / `positionTest` / `pointContents` / `snapOrigin`, with unit tests for every case in A. |
| 5 | BVH, plus the bit-for-bit match against brute force. |
| 6 | cmap decoder (shared) and encoder (tools), hash, round trip; `*.cmap binary`. |
| 7 | Tools brush compiler (f32 rounding, polygonize, validate, axial bevels, bounds, render surfaces), constructors, MapBuilder. |
| 8 | The 5 courses, `pnpm greybox`, committed .cmap files, compile-twice and compare-to-committed tests, sanity tests. |
| 9 | Fuzz test, properties P1–P7. |
| 10 | Bench and docs (below), then the reviewers (perf-auditor, clean-room-auditor) and the handoff. |

Step 10 detail:
- **Bench files:** `packages/tools/bench/`, which matches docs/10's `packages/*/bench`. Add `"bench"` to tools' tsconfig `include`.
- **Runner:** add `tsx` to tools' devDependencies; it is already in the lockfile (MIT). Tools script: `tsx bench/run.ts`. Root script: `pnpm --filter @game/tools --fail-if-no-match bench`.
- **Measurement:**
  - warm up with 1e5 calls, then time 1e6;
  - precompute the trace mix, a seeded mix weighted toward short moves, ground probes, step traces, position tests and rays, all near surfaces;
  - sum the results so the work can't be optimized away;
  - count GC events during the loop with a PerformanceObserver; 0 means no allocation.
  - Report ns/op per category and the weighted average for box traces against the 1 µs budget.
- **Guard and docs updates** (the guard tests fail otherwise):
  - Remove `bench` from CLAUDE.md's stub sentence (the stub guard will fail otherwise).
  - Add `pnpm greybox` to the CLAUDE.md commands table.
  - Add D-016 and D-017, and update docs/03 §6, docs/05 §4.1 and docs/07 §2/§6.

**Wrong or missing in the draft:**
- ε plus nearest rounding isn't enough without the snap.
- Touching semantics weren't defined.
- endpos at fraction = 1 must copy end exactly.
- Ties need to go to the lowest brush index.
- quantize needs −0 handling and clamps.
- Stamina should be stored as integer hundredths.
- The pool should be per-module scratch instead.
- D-016 needs to cover the compiler and pow/exp, and the guard needs updating.
- contentHash location and `.gitattributes`.
- The trace result needs `entity` and `surfaceFlags`, plus point and box contents queries.
- Named anchors.
- Course tests must live in tools.
- Bench location and the guard/CLAUDE.md updates.

## Prioritized risks

1. **Players stuck in slopes and rotated walls** because rounding drifts them into solid (A.9). Fix: D-017 snap plus fuzz P7. High.
2. **Hidden differences between browser engines:** approximate Math functions, `**`, minifier settings, Float32 round trips, NaN and −0. Fix: the guard and dtrig. Also commit test vectors in M1 (input bits → output bits) so M2 can replay them in real Chrome, Firefox and Safari. High, because it is costly to find late.
3. **Trace speed:** big overlapping brushes and V8 de-optimizations from mixed object shapes or array types. Fix: SAH from the start, classes with fixed fields, a bench that counts GC events. Medium.
4. **The ε rule changes mapping metrics** (40 u gaps, exact-fit tunnels). Needs doc updates and your sign-off. Medium.
5. **The fuzz oracle depends on the polygonizer.** Fix: the triple-intersection cross-check and the constructor-vertex tests. Medium.
6. **Committed binary maps:** frequent churn and line-ending corruption. Fix: `.gitattributes`, `compiler.version`, and a recompile test with a clear message. Medium-low.
7. **No edge bevels for general brushes in M5.** For now: the builder rejects such shapes, and the fuzz test checks both directions (P4). Low in M1.
8. **Spec questions to ask:**
   - docs/03 §4.8 says the slide move is stuck when the trace "starts in solid". Should that mean all-solid?
   - Ladder detection: wall surface flag or LADDER volume?
   - Is "kick-eligible" a real button?
   - May contentHash move into the preamble?
   - Are the stamina-rate and position rounding biases acceptable?

   Low.
9. **V8 number representation:** fields switching from small integers to heap numbers (tick above 2^30, float scalar fields). Fix: integer-only scalar fields. Low.
10. **TS 7 typing friction** with `Float64Array<ArrayBufferLike>`. Fix: one `Vec3` alias and a factory. Low.

### Critical Files for Implementation
- packages/shared/src/world/trace.ts (new; the A rules, plus snapOrigin)
- packages/shared/src/world/bvh.ts and packages/shared/src/world/cmap.ts (new)
- packages/shared/src/math/dtrig.ts and packages/shared/src/math/quant.ts (new; D-016 and H)
- packages/tools/test/guards/shared-purity.test.ts (extend the banned list) and packages/tools/test/guards/scripts.test.ts (constrains the bench and stub changes)
- .gitattributes, CLAUDE.md, docs/07-map-pipeline-trenchbroom.md, docs/11-decision-log.md (binary maps, commands, D-016/D-017)