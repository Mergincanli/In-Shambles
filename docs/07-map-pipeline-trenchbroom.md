# 07 — Map Pipeline (greybox now, TrenchBroom later)

> Quake-style movement depends on **clean convex brush collision**. Crisp edges for wall jumps, ledge grabs and slides come from plane-based brushes. Triangle-mesh collision snags on internal edges and ruins exactly those moves. So the whole pipeline is **brush-first**.

## 1. Phases

| Phase | Milestone | Source of maps |
|---|---|---|
| A | M1–M4 | **Greybox builder:** maps defined in TypeScript (boxes, ramps, stairs, walls, volumes) → compiled map (`cmap`) |
| B | M5 | **TrenchBroom:** `.map` files (Valve 220 format) → our compiler (`pnpm mapc`) → `cmap` |
| C | M8+ | Lighting bake + art meshes layered on top of brush collision |

Both A and B produce the **same compiled format**, so the engine never cares where a map came from.

## 2. Compiled map format (`cmap`, version 1)

- **Container:** one little-endian binary file, `<name>.cmap` (layout below).
- **Header:** a 32-byte binary preamble (`formatVersion`, `contentHash`, lengths) plus canonical ASCII JSON metadata: `bounds`, `compiler: {name, version}`, `entities`, `materials`, `name`, `units: "inch"`, `up: "z"`. All geometry is in binary sections.
- **Brushes:** for each brush:
  - planes (normal xyz f32 + dist f32), bounds
  - `contents` bitflags: SOLID, PLAYERCLIP, WATER, LADDER, SLICK, NODAMAGE, TRIGGER, NODRAW
  - optional `surfaceFlags` per side (ladder face, footstep material)
- **BVH:** built at load time over the brush bounds, deterministically (not stored in v1).
- **Render surfaces:**
  - per material: vertex buffer (position, normal, uv0; a later uv1 for lightmaps comes as a new section or format version), index buffer
  - static, merged
- **Entities:** `{ classname, origin?, angles?, props: Record<string,string>, brushes?: number[] }` (spawns, flags, triggers, items, lights, timers). `angles` is [pitch, yaw, roll] in degrees; yaw 0 faces +x and 90 faces +y (D-021).
- **Optional (later):** cluster visibility (PVS-like) for relevance (`docs/05` §9.1); lightmap atlas.
- **Determinism:** compiling the same source twice produces byte-identical output (tested).

**Pinned down in M1** (D-019, `packages/shared/src/world/`):
- `contents` bits 0–7 are SOLID, PLAYERCLIP, WATER, LADDER, SLICK, NODAMAGE, TRIGGER, NODRAW in that order; loaders reject other bits and brushes with no contents.
- `surfaceFlags` (u32 per side): bit 0 ladder face, bit 1 slick, bit 2 nodamage, bits 8–11 the footstep material (0 default, then concrete, metal, wood, grass, water; §6). Bevel sides carry 0.
- Brush build: round the planes to f32 first and derive everything from the rounded planes; polygonize (§4.3 step 3) and drop redundant planes; then add the axial bevels (the bounding-box planes not already a face), their distances rounded outward to f32. Planes are stored faces first, then bevels; the bevel extents are the bounds.
- Loaders reject a brush whose bounds are not exactly the distances of six axial planes among its faces and bevels: the BVH culls by the bounds, so a brush reaching past them would hide hits from `traceBox` that `traceBoxBrute` reports.
- `buildBrush` adds only axial bevels, which make boxes, boxes rotated about Z and axis-aligned wedges exact; the greybox builder rejects shapes that would need edge bevels until `mapc` adds them in M5.
- A brush is rejected (compile error naming the brush) unless it has ≥ 4 faces, is closed (every edge on exactly 2 faces, V − E + F = 2), every vertex lies on ≥ 3 faces and inside all planes within 1e-4 u, every edge is ≥ 1/8 u (8× the weld distance, so welding never joins the two ends of an edge), no two vertices of a face are within the 1/64 u weld distance, its volume is > 1 u³ and it stays within ±16384 u.

**cmap v1 layout** (M1; decoder `packages/shared/src/world/cmap.ts`, encoder `packages/tools/src/greybox/cmapEncode.ts`). Integers are u32 unless marked i32, floats are f32, all little-endian:

| Offset | Field |
|---|---|
| 0 | magic `"CMAP"` (4 ASCII bytes) |
| 4 | `formatVersion` = 1 |
| 8 | `jsonByteLength`: the JSON's length, padded with spaces to a multiple of 8 |
| 12 | `sectionCount` |
| 16, 20 | `hashLo`, `hashHi`: the `contentHash` |
| 24 | `totalByteLength`: the file length |
| 28 | reserved, 0 |
| 32 | section table: `sectionCount` × {fourcc `tag`, `offset`, `byteLength`, `count`} (16 B each) |
| … | the JSON (no leading or trailing whitespace, then fewer than 8 padding spaces), then the sections in table order, each at the first 8-aligned offset after the previous one and zero-padded to 8 bytes; the last one's padding ends the file |

| Tag | Record | Contents |
|---|---|---|
| `PLNS` | 16 B | plane nx, ny, nz, d (n·x ≤ d is inside); each brush's faces, then its bevels, brush by brush |
| `PLSF` | 8 B | per plane: `surfaceFlags`, i32 material index (−1 exactly for bevels) |
| `BRSH` | 40 B | `firstPlane`, `planeCount`, `faceCount`, `contents`, f32 bounds min xyz, max xyz |
| `SURF` | 24 B | render surface: material, `firstVertex`, `vertexCount`, `firstIndex`, `indexCount`, reserved 0 |
| `VTXS` | 32 B | vertex: position xyz, normal xyz, uv0 |
| `IDXS` | 4 B | triangle index, relative to its surface's `firstVertex` |

- **JSON** is canonical so compiles are byte-identical: keys sorted by UTF-16 code unit, numbers written with `String(n)` (finite only, −0 as 0), every character above 0x7E escaped as `\uXXXX`, no whitespace. Entities are `{classname, origin?, angles?, props, brushes?}` with `brushes` indexing `BRSH`; `materials` is the list `PLSF` and `SURF` index. Nothing in a file depends on time, paths or the machine.
- **contentHash:** 64 bits, two Murmur3 x86_32 lanes (seeds `0x636d6170` low, `0x9e3779b9` high) over the whole file with the 8 hash bytes read as zero, so it covers every other byte, the preamble included, and never itself. It is written as 16 lowercase hex digits, high lane first. It is for identity and caching (did client and server load the same map?), not security.
- **Versions:** `formatVersion` changes only when the layout breaks; `compiler.version` changes whenever compiler output changes on purpose, which explains a changed committed `.cmap`. Readers skip section tags they don't know, so new sections can be added without a new format version; the JSON keys are fixed for a format version (entities extend through `props`).
- **Validation:** the decoder checks everything before returning (magic, version, lengths, alignment, the exact layout above with no gaps, overlaps, trailing bytes or non-zero padding, record sizes, ASCII JSON and its structure, index ranges, finite floats, known contents and surface bits, each brush's bounds against its axial planes, brushes covering the plane list in order, materials per plane, render-surface ranges, the hash) and throws `CmapError`; it never returns partial data. `*.cmap` files are `binary` in `.gitattributes`.

## 3. Phase A: greybox builder and test courses

`packages/tools/src/greybox/` exposes a tiny API (`MapBuilder.ts`; the brush compiler is `brushCompiler.ts`):

```ts
const m = new MapBuilder("movement_lab");
m.box({ min: [-1024,-1024,-16], max: [1024,1024,0] });                        // floor
m.stairs({ origin: [256,0,0], steps: 6, stepHeight: 16, stepDepth: 24, width: 128 }); // → top z
m.ramp({ from: [512,-128,0], to: [768,-128,96], width: 128 });                // axis-aligned only
const top = m.slope({ from: [0,-512,0], run: 256, normalZ: 0.71, width: 128 }); // → crest z
m.box({ min: [256,-576,0], max: [512,-448,top] });                            // platform at the crest
m.wall({ min: [0,300,0], max: [512,316,256] });                               // wall-jump wall
m.rotatedBox({ center: [0,600,112], halfExtents: [256,8,128], cos: Math.sqrt(3)/2, sin: 0.5 }); // 30° kick lane
m.volume("WATER", { min: [-600,-600,-128], max: [-300,-300,0] });
m.ladder({ wallMin: [916,0,0], wallMax: [932,64,256], face: "-x" });         // wall + LADDER volume
m.spawn("info_player_start", [0,0,24], 0);                                    // yaw in degrees
m.timer("start", {...}); m.timer("stop", {...});
m.anchor("gap_96_takeoff", [128,0,0]);                                        // named place for tests
export default m.compile();
```

- **Primitives:**
  - `box({min, max, material?, contents?, surfaceFlags?})`, `wall({min, max})` (wall grey).
  - `stairs({origin, steps, stepHeight, stepDepth, width, direction?})`: one solid column per step from the origin (the bottom of the first riser, centred across the width), climbing `direction` (`"+x"` default, or `"-x"`, `"+y"`, `"-y"`). Returns the top step's z.
  - `ramp({from, to, width})`: a solid wedge whose floor is the lower end's z. `from` and `to` may differ along x or y, not both: **ramps must be axis-aligned until edge bevels arrive in M5** (D-019), and the builder throws on any other ramp.
  - `slope({from, run, normalZ, width, direction?})`: a wedge with rise = run·√(1 − nz²)/nz (computed with `Math.sqrt`, D-016), so the stored normal z is exactly `Math.fround(normalZ)`. Returns the compiled wedge's top (its +z bound, the f32 crest rounded up, not the f64 `from.z + rise`, which can sit several f32 steps lower far from the origin): a platform whose top is that value shares the plane distance with the crest, so the crest has no lip.
  - `rotatedBox({center, halfExtents, cos, sin, contents?})`: a box rotated about +Z, for kick lanes. Callers pass closed forms (sin 15° = (√6 − √2)/4) or dtrig values, never `Math.cos`.
  - `volume(kind, {min, max, material?})`: a non-solid box; `kind` is `WATER`, `LADDER`, `PLAYERCLIP`, `TRIGGER` or `NODRAW`.
  - `ladder({wallMin, wallMax, face, material?})`: the solid wall with the ladder surface flag on the `face` side and a 16 u LADDER volume in front of that whole face. M2 decides which of the two the movement code reads (`docs/03` §4.14).
  - Every solid primitive also takes `material?` and `surfaceFlags?`, applied to all of its faces. `box`, `wall`, `rotatedBox` and `volume` return the brush index (for entity `brushes` lists); directions and faces are checked at run time too.
- **Entities** (§4.2 classnames), in call order: `spawn(classname, origin, yaw, props?)` for `info_player_start`, `info_spawn_red`, `info_spawn_blue`; `timer("start" | "stop", {min, max})` makes an invisible TRIGGER brush and an `info_timer_start` / `info_timer_stop` entity whose `brushes` lists it; `anchor(name, origin, yaw?)` makes an `info_target` with `targetname` = name (snake_case, unique per map), so tests name places instead of hard-coding coordinates. Yaw goes in the entity's `angles` as [0, yaw, 0] degrees (§2); yaw 0 faces +x. Origins stay within ±16384 u like brushes, and prop keys are snake_case starting with a letter.
- **Checks:** each call builds and checks its brushes at once, so a bad shape throws at that call, naming the map and brush (`movement_lab brush 12 (ramp): …`), and a call that throws adds none of its brushes. Besides the brush rules of §2, a brush is refused when it would need edge bevels: for every edge e (between faces with normals n1, n2) and axis k, take u = e × axis_k with the sign that makes u·(n1 + n2) ≥ 0, the side the expanded brush's face would face; u must be parallel (within 1e-6) to an axis or point the same way as one of the brush's face normals. Boxes, boxes rotated about Z and axis-aligned wedges pass.
- **Materials** default from the contents: `grey/floor` (box, stairs, ramp, slope), `grey/wall` (wall, rotated box, ladder wall), `grey/water`, `tool/clip`, `tool/trigger`, `tool/nodraw`, `tool/ladder`. The cmap `materials` table lists them in order of first use, brush by brush and face by face.
- **Render surfaces:** one merged surface per material, in material order. Solid brushes and water volumes render; PLAYERCLIP, TRIGGER and NODRAW brushes and other non-solid volumes (LADDER) don't. Each face polygon is a triangle fan from its canonical start vertex (the lexicographically smallest (x, y, z)), counter-clockwise seen from outside, with f32 positions and the face normal as every vertex's normal.
- **uv0 convention** (M2's grid texture relies on it): a planar projection in world space on the face normal's dominant axis, **1 uv per 64 u**: z-dominant faces get (u, v) = (x, y)/64, x-dominant (y, z)/64, y-dominant (x, z)/64; ties go to z, then x, so a 45° ramp maps like the floor. A 64 u grid tile therefore lines up across brushes.
- **Determinism:** `compile()` returns the map as a loader reads it (it goes through `encodeCmap` and `decodeCmap`, so it is validated and carries its `contentHash`), and the same calls always give byte-identical files. `compiler` is `{name: "greybox", version}`; the version starts at 1 and is bumped whenever the output changes on purpose. The greybox modules are under the D-016 math ban and read no clock, randomness, locale or environment (guard: `packages/tools/test/guards/greybox-determinism.test.ts`).

**Required courses** (each doubles as an automated test fixture, `docs/03` §8):

| Course | Contents |
|---|---|
| `movement_lab` | flat runway (1024 u+), step ladder (16/18/19 u), slope set (normal.z 0.69/0.71/0.8), stairs, ladder, water pool (deep + wade), ceiling-height crouch tunnel |
| `jump_lab` | gap series (64…320 u step 32), ledge heights (24…120 u step 8), wall-jump chimney (walls 64 u apart, 512 u tall), single-wall kick lanes at 15/30/45/60°, curb (24 u) to verify no kick |
| `slide_lab` | long flat lane with distance markers, door frames (48 u wide), slide-under gaps (41–44 u high), ramp into slide |
| `fall_tower` | platforms at 128/256/384/512/640/768/1024 u above a floor, water landing pool, ledge-grab catch rails |
| `arena_greybox` | small combat map for netcode/combat tests: cover, verticality, 16 spawns |

## 4. Phase B: TrenchBroom integration (M5)

### 4.1 Game configuration (ships in `tools/trenchbroom/<GameName>/`)
TrenchBroom supports custom game configurations. Place a folder under its user-data `games` directory containing:
- `GameConfig.cfg`: game name, map formats, texture root and extensions, entity definitions file, face/brush tags, entity scale.
- `<game>.fgd`: entity definitions (Valve FGD format, which TrenchBroom supports).
- `icon.png`.

**Map format:** **Valve 220**. It stores explicit texture axes per face, giving better UV projection, and it's what most modern Quake-family pipelines use.

**Textures:** loose image files (PNG/JPG) under `content/textures/`. Use exclusion patterns to hide PBR helper maps (`*_normal`, `*_rough`, `*_orm`, etc.).

**Special tool textures** (names drive contents): `tool/clip` (PLAYERCLIP, invisible), `tool/nodraw`, `tool/skip`, `tool/trigger`, `tool/water`, `tool/ladder`, `tool/slick`, `tool/nodamage`.

**Prior art** to study (concepts only): FuncGodot (TrenchBroom → Godot), bevy_trenchbroom (TrenchBroom → Bevy), godot-tbloader. They solve the same import problem for other engines.

### 4.2 FGD entities (initial set)

| Class | Type | Purpose / key props |
|---|---|---|
| `worldspawn` | solid | `message`, `gravity_scale` (default 1), `ambient` |
| `func_group`, `func_detail` | solid | organization; detail brushes excluded from visibility pre-pass |
| `func_water` | solid | water volume (alternative to tool texture) |
| `func_ladder` | solid | ladder volume |
| `trigger_hurt` | solid | `damage`, `instakill` |
| `trigger_push` | solid | jump pad: `target`, `speed` |
| `trigger_teleport` | solid | `target` |
| `info_player_start` | point | FFA spawns |
| `info_spawn_red` / `info_spawn_blue` | point | team spawns, `group` (round-based spawn groups) |
| `info_ctf_flag` | point | `team` |
| `info_timer_start` / `info_timer_stop` / `info_checkpoint` | point / solid | Movement Trials |
| `item_spawn` | point | `item`, `respawn` |
| `light`, `light_spot`, `light_sun` | point | for baking (Phase C): `color`, `intensity`, `radius` |
| `info_target` | point | targets for push/teleport |
| `misc_model` | point | static art model placement (render only, never collision) |

### 4.3 Compiler (`pnpm mapc <file.map>`; `--watch` for hot reload)
1. **Parse** the `.map` text (Valve 220): entities → key/values → brushes → faces (3 points, texture name, U/V axes + offsets, rotation, scale). Strict errors with line/column numbers.
2. **Brush planes:** compute a plane from each face's 3 points (orientation per format convention). Validate convexity; reject degenerate brushes.
3. **Polygons:** for each face, clip a large polygon on its plane by all other planes of the brush (half-space intersection) → convex face polygon. Weld vertices (epsilon 1/64 u). Drop faces with tool textures that don't render.
4. **Hidden-face removal (optional v1.1):** drop faces fully covered by adjacent solid brushes.
5. **UVs:** project vertices with the face's Valve axes, offsets and scale. Divide by texture size (read the image header for dimensions).
6. **Batching:** merge polygons per material → triangulate (fan) → vertex/index buffers. Compute normals (flat per face; optional smoothing groups later).
7. **Collision:** emit brush planes + contents directly from the brushes (no triangles). Build the BVH.
8. **Entities:** convert classnames/props per the FGD; transform origins and angles. Brush entities keep their brush indices.
9. **Validation:**
   - spawn points not in solid, and enough of them per mode
   - entity keys match the FGD
   - map bounds within limits
   - no brush with < 4 planes
   - leak-style check (optional): spawns enclosed by solid
10. **Output** the `cmap` + a compile report (counts, warnings, timings).

**Coordinates:** TrenchBroom/Quake maps are Z-up in Quake units, matching our simulation exactly (1 u = 1 inch). No conversion in the compiler; the renderer converts (`docs/06` §7).

### 4.4 Hot reload (dev)
`pnpm mapc --watch` recompiles on save. The dev server then broadcasts a `MAP` reload to connected clients, which reload geometry and keep player positions where possible.

### 4.5 Tests
- Parser golden tests on small fixture maps (a cube, a stair, a ramp, a Valve 220 rotated texture).
- **Equivalence test:** `movement_lab` built in TrenchBroom vs. the greybox builder gives identical collision results for a recorded run (`docs/03` MV-19).
- Compile determinism (byte-identical output).
- Fuzz: malformed `.map` input never crashes the compiler (it errors cleanly).

## 5. Phase C: lighting and art (decide in M8, see `docs/08`)

| Option | Pros | Cons |
|---|---|---|
| 1. **Custom lightmap baker** in `tools` (worker threads; UV atlas via a WASM unwrapper; direct + bounce) | Closest to the Q3 workflow; fully automated from `.map` | Most engineering work |
| 2. **Blender bake** (export compiled geometry, bake in Cycles, import lightmaps) | Highest quality, least code | Manual steps |
| 3. **No lightmaps:** baked vertex AO + light probes + a stylized real-time look | Cheapest | Depends heavily on the chosen art style |

**Narrowed by D-013:** the Comic Noir art direction bakes world lighting into lightmaps (`docs/08` §6), which rules out option 3. M8 picks between options 1 and 2.

Whatever is chosen: static lighting is baked or stylized. **Collision always stays brush-based**, and art meshes (`misc_model`, detail meshes) never affect movement.

## 6. Mapping metrics (gameplay-first; from hull and physics in `docs/03`)

| Metric | Value |
|---|---|
| Standing hull | 30 × 30 × 56 u |
| Crouch / slide height | 40 u |
| Step height | 18 u (anything taller needs a jump) |
| Jump apex | ≈ 45 u (plain jump) |
| Ledge-grab reach | per `pm_ledge*` (ESTIMATE: ledge top up to ~76 u above feet at grab time) |
| Doors | ≥ 48 u wide × 96 u tall (comfortable); slide gaps 41–44 u high (a crouched player rests 1/32 u above the floor, so 40 u blocks; D-017) |
| Corridors | ≥ 64 u wide (two players can't pass in < 64) |
| Walls meant for wall jumps | ≥ 64 u tall, flat, vertical |
| Floor textures | footstep material via texture name prefix (`concrete_`, `metal_`, `wood_`, `grass_`, `water_`) |
