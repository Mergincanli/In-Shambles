# 08 — Art Direction: "Comic Noir"

> **Status: DECIDED (O-4)**: a modern Franco-Belgian comic look, inspired by XIII (2003), rebuilt for a competitive browser FPS. Exact parameters (band thresholds, line widths, palettes) are tuned in look-dev and logged in the decision log.
> **Reference material:** `docs/08a-xiii-style-reference.md` (corrected research on the original look and techniques).
> **Priority order when rules collide:** 1) gameplay readability & fairness → 2) performance budgets → 3) style fidelity.

## 1. The look in one paragraph

Every frame should read like a panel from a European adventure album: flat, confident color blocks, crisp ink contours, stepped light with tinted (never muddy) shadows, and ink texture only where shadows live. Sound becomes visible as lettering, big moments get comic panels, and the UI is built from captions, frames and lettering. The **modern upgrade**:
- lines stay crisp at any resolution (pixel-accurate widths, anti-aliasing)
- palettes are authored, not filtered
- line weight reacts to light the way a human inker's does
- everything stays readable at competitive speed

## 2. Pillars (ranked)

1. **Readable first.** Players, teams and threats must be instantly legible at movement speeds above 600 u/s. Style never hides an enemy.
2. **Ink and flat color.** Large flat color fields, bold contours, detail drawn with lines rather than texture noise or normal maps.
3. **Sound you can see, fairly.** Onomatopoeia is a core identity feature *and* an honest sound visualizer. It never shows more than your ears would tell you (§11.2).
4. **Comic moments, not comic clutter.** Panels and lettering mark *important* beats. Everyday actions stay clean.
5. **Crisp everywhere.** Stable lines, no shimmering hatching, no shower-door patterns, no blurry ink at distance.

## 3. Inspiration vs. originality (IP rules)

- We borrow a **style family**: Franco-Belgian adventure comics and the cel-shaded comic FPS presentation XIII popularized. Styles aren't owned. Specific works are.
- **Never use:**
  - XIII characters, story elements, logos (including the "XIII" numeral or a key/tattoo motif)
  - their UI layouts copied 1:1, or traced panels or art
  - fonts without a license that covers web embedding
- All lettering artwork, panel frames, characters, maps and words are **original**.

## 4. Gameplay readability rules (style-specific, non-negotiable)

- **No pure-black shadows in playable space.** Shadows use the map's tint color. Pure black (`#0B0B0C`-ish ink) is reserved for lines and small spot accents. Target: ≤ 5% of a gameplay frame is ink-black.
- **Hatching never covers characters.** Player models get no hatching. On environments, hatching is limited to the mid/shadow bands and capped in density (§7.4) so it can't camouflage a player.
- **Silhouette contrast:** characters carry a dark outline at all distances (§7.1). Their main color blocks must differ in value from typical backgrounds by ≥ 25% (measured in look-dev).
- **Team colors are reserved.** The two team hues (plus colorblind presets) may not appear as large surfaces in maps. They're used on characters (torso/arm/leg blocks), the HUD and team VFX only.
- **Clear center:** no lettering, panel or effect may enter a central zone around the crosshair (≈ 40% of screen width × 40% of screen height) during play, except the crosshair itself and hit markers.
- **Panels are small and peripheral during play** (§12). Full-page panels happen only when you're dead or spectating.

## 5. Color and palette

- **Flat local colors.** Every surface has a dominant flat color; variation comes from the light bands and ink, not texture noise.
- **Per-map palette sheet** (an art deliverable for every map):
  - 3–5 dominant hues + 2 neutrals + 1 accent
  - one **shadow tint** (e.g., indigo for day maps, violet or teal for night)
  - one **sky treatment** (painted gradient bands or flat sky with ink clouds)
- **Color pipeline:** light in linear space → tone map (neutral or none) → optional per-map LUT → sRGB output. Saturation is authored in the palette, never boosted globally in post.
- **Team colors:** two default hues chosen for contrast against every map palette, plus colorblind presets (deuteranopia/protanopia/tritanopia). Each team also has a **shape cue** (e.g., stripes vs. chevrons on armbands) so color isn't the only signal.

## 6. Lighting model

- **One key light per map** (sun or moon) that drives the bands and the ink direction. Optional small set of local lights (lamps, fires) that also band.
- **Stepped lighting:** 3 bands (lit / mid / shadow) by default, anti-aliased band edges, shared thresholds (`docs/08a` §4.1). Cast shadows are combined *before* quantizing.
- **World lighting is baked.** The map compiler/baker produces lightmaps (direct + 1 bounce). The material **quantizes the lightmap luminance into bands**, so static shadows stay crisp and comic-like at almost no runtime cost. This fits the brush-based pipeline (`docs/07` §5).
- **Dynamic actors** (players, dropped weapons) use the key light + a light-probe/ambient term, banded the same way. They get **one shadow-map cast shadow** from the key light on medium/high presets (hard-edged, banded). On low, they get a flat ink-blob contact shadow.
- **Specular:** none on cloth and skin. Binary, sharp highlights only on metal, glass and scopes.
- **Weather and time of day:** palettes and the shadow tint change with the map variant. Rain is drawn as ink streaks; snow as white dots with ink rims.

## 7. Ink: outlines, lines and hatching

### 7.1 Characters, weapons and the viewmodel: hull outlines
- Back-face hull pass with **smoothed outline normals** baked at import, extruded in clip space, so the width is defined **in pixels**.
- **Widths:**
  - characters: 2.5 px near → 1 px far
  - viewmodel: fixed 2 px
  - dropped items: 1.5 px
- **Modern twist:** line weight scales slightly with the key light: thicker on the shadow side (×1.0–1.4), like a human inker.
- The outline pass must apply skinning (same bones as the mesh).

### 7.2 World: compiled crease lines + screen-space edges
- **Crease lines (primary, our advantage):** the TrenchBroom compiler (`docs/07` §4.3) already knows every brush edge. It emits **crease edges** (dihedral angle > ~30°, and all boundary edges between different materials) as line geometry. Lines are rendered at a fixed pixel width (1.5 px), never shimmer, and cost little.
- **Screen-space edges (secondary):** a depth/normal/ID edge pass catches silhouettes and intersections that crease lines can't (props against walls, distant skylines).
  - Linear depth, with distance- and angle-aware thresholds.
  - Smooth edge mask.
  - Excludes objects that already have hull outlines.
  - Off on the low preset.

### 7.3 Texture ink
- Albedo textures carry hand-inked detail lines: seams, panel joints, brick courses, folds.
- Minimum 2–3 texels thick at the standard texel density.
- Trilinear + anisotropic filtering.
- Mips generated with a line-preserving filter.

### 7.4 Hatching (environment only)
- **World-space triplanar** hatching with a tonal-art-map set (light strokes / dense strokes). Mid band = light strokes, shadow band = dense strokes.
- **Never screen-space.** In first person the camera moves constantly, so screen-fixed strokes "swim".
- **Density cap:** stroke coverage ≤ 35% in shadow bands, ≤ 15% in mid bands.
- Off on low preset; optional on medium.
- **Halftone dots:** not used in the 3D world. Allowed as a UI/print accent only (captions, menus), to keep the European-album identity.

### 7.5 Post stack
In order:
1. Edge composite
2. MSAA (main pass) and/or FXAA
3. Per-map LUT
4. **Paper grain**: very subtle, static, low frequency; the page, not noise
5. Bloom off (or tightly clamped for muzzle flashes and explosions only)

## 8. Materials, textures and assets

| Item | Rule |
|---|---|
| Base material | One shared toon material family (world / actor / viewmodel variants) with the same band parameters. |
| Albedo | Flat color blocks + ink lines. No photo textures. No baked lighting in albedo (lighting comes from bands/lightmaps). |
| Normal maps | None by default. Allowed only for clean bevels on hero props, and only if they don't break band stability. |
| Roughness/metal | Not used as PBR. Specular masks only (metal, glass, scopes). |
| Texture budgets | Per `docs/08` §16 and `docs/10`. KTX2/Basis compression. Ink lines checked after compression (no smearing). |
| Decals | Ink-style: bullet holes as small ink stars, scorch as cross-hatched splats, blood as flat dark-red ink shapes (stylized, not gory). |
| Contact shadows | Flat ink blobs under props and actors on low; banded shadow maps on medium/high. |

## 9. Characters, weapons and the viewmodel

- **Proportions fixed by gameplay:**
  - standing hull 30×30×56 u
  - eye height 50 u above feet
  - head top ≈ 58–60 u (`docs/03`, `docs/04` §10)
  - silhouettes that clearly show stance (crouch, slide, climb, ladder)
- **Color blocking:** team color on torso, arms and legs (large blocks) + team shape cue on armbands. Personal accent on one small block (optional).
- **Faces and hands:** simple planes with ink-drawn features. Readable at 10 m, no photoreal detail.
- **Weapons:** chunky, iconic silhouettes that read in a kill-feed icon at 32 px. Ink line details drawn into textures. Names and type tags per O-2.
- **Viewmodel:**
  - separate render pass with its own FOV
  - same light bands as the world (uses the key light) so it never looks pasted on
  - ejected brass as small flat-colored shapes with ink rims, flying across the screen (a nod to the arena-shooter tradition)

## 10. Environments and maps

- **Brush-first architecture** (TrenchBroom): bold, readable masses; walls meant for wall-kicks are flat and clearly inked. No noisy micro-geometry on surfaces players kick or grab.
- **Readable materials by line language:** brick = horizontal courses, wood = grain strokes, metal = rivet dots and panel seams, concrete = sparse cracks.
- **Wayfinding through ink and accent color:** routes, ledges and kickable walls get subtly stronger crease lines or an accent trim. Readable for good players, never a neon signpost.
- **Skyboxes:** painted gradient bands or flat color with inked clouds and silhouettes.
- **Props:** `misc_model` art meshes with hull outlines are allowed. They never affect collision (`docs/07` §6).

## 11. Comic FX

### 11.1 Onomatopoeia system (lettering in the world)
- **Rendering:** MSDF text billboards (black outline + colored fill), pooled, data-driven word lists in `content/fx/onomatopoeia.json` (per sound kind × surface material × weapon class).
- **Animation (sequenced):** pop 0 → 1.2 (60 ms) → 1.0 (60 ms), drift up ~24 u, fade over 0.5–0.9 s.
- **Caps:** ≤ 12 words on screen; priority = threats > teammates > self. Words never enter the clear center zone (§4); they're pushed to its edge.
- **Categories:**

| Category | Shown when | Position | Notes |
|---|---|---|---|
| Own actions (shots, wall-kicks, slides, landings) | always (cosmetic; can be reduced in settings) | near the viewmodel or feet, peripheral | small, short |
| Visible others (gunfire, explosions, kicks, grabs) | source is visible | exact source position | the classic "BAM" moments |
| **Heard, unseen** (footsteps, reloads, gunfire behind walls) | **only if the sound is audible to you**, per the audio engine | **coarse server position** (64 u grid, `docs/05` §9.1) | the "sixth sense" homage, but fair (§11.2) |

### 11.2 Fairness rules (multiplayer integrity)
- Lettering is generated **only from sound events the client legitimately receives**. Enemies outside relevance are never sent (`docs/05` §9), so there is nothing extra to leak.
- **Precision ≤ audio precision:** unseen sources use the server's coarse position, and the word is placed with ±32 u jitter, stable per event.
- **Walking is silent:** walking makes no footstep sound, so it shows no footstep words. Sprinting is loudest. This creates counterplay and fits UrT's walk/run/sprint rules.
- **Same for everyone.** The info level is a server setting (default on), never a client toggle, so nobody gains an advantage. Clients may change size and opacity only.
- Doubles as an **accessibility feature** for deaf and hard-of-hearing players.

### 11.3 Other comic FX
- **Speed lines:** above 600 u/s (`docs/03` §5.10), fast players leave team-tinted motion lines. In first person, optional faint screen-edge speed lines (motion-comfort setting).
- **Hit markers:** small ink splats (server-confirmed), with a stronger variant for headshots.
- **Damage taken:** directional comic splash marks at the screen edge showing direction. Zone shown on the HUD figure.
- **Bleeding:** ink drips at the screen edges + the periodic blackout pulse (`docs/04` §3.3).
- **Explosions:** flat-color fireball shapes with ink rims + spiked lettering burst. No realistic smoke sims; smoke grenades are layered flat-shaded puffs with ink outlines (they must block vision reliably).
- **Muzzle flashes:** flat star shapes with ink rims. Suppressed weapons: none (gameplay rule).

## 12. Comic panels

### 12.1 Killer stinger (during play)
- **Triggers:** headshots, long shots (> 1500 u), thrown-knife kills, goomba stomps.
- **Layout:** 1–3 small panels in the **top-left**, together ≤ 22% of screen width, visible ≤ 1.2 s, sliding in with a slight offset.
- **Content:** **stills**, not live video. Captured from the client's own interpolated view of the victim at hit, +150 ms and +450 ms, each rendered once at low resolution (e.g., 384×216). Nearly free to render, and very comic-like.
- **Fairness:** uses only state the killer's client already has (the victim was visible to the killer).
- Can be disabled in settings.

### 12.2 Victim death page (while dead)
- **v1:** a single panel framing the killer from the victim's last view + caption: "TAKEN OUT BY <name> · <weapon name + type tag>".
- **v2** (with the killcam backlog item, `docs/09`): a 3–4 panel page replayed from the server's snapshot buffer (killer aiming → shot → fall), shown during the respawn timer.

### 12.3 Event panels
- Objective moments (flag taken, round start, last player standing) appear as caption boxes or a small panel showing **the objective, never hidden enemies**.
- Panels must not reveal anything the player couldn't otherwise know.

## 13. UI, HUD and typography

- **Visual language:**
  - caption boxes (flat yellow, black border, hard drop shadow)
  - panel frames (black border + white inner matte)
  - lettering
  - halftone and print-registration accents allowed in the UI only
- **HUD (our mechanics):**
  - health/stamina bar with used-stamina and lost-health segments
  - **wound figure** drawn as an inked silhouette, with hit zones filled in red ink
  - ammo (mag + spare mags) in a slanted caption
  - fire-mode and zoom indicators
  - item toggles
  - minimap as an inked map with teammate arrows
  - kill feed as a **mini comic strip** (icons + names + type tags)
- **Crosshair:** clean ink cross with white inner pips. Shows spread (UrT-style ring states). Shape varies by weapon class.
- **Scoreboard and menus:** comic-page layouts with panels.
- **Fonts:** one lettering face (all caps, hand-lettered sans) + one UI face. **Licenses must allow web embedding.** Open-licensed candidates to test: Bangers (display/lettering), Comic Neue (UI). Or commission custom lettering.
- **Scaling:** all frame and border sizes are relative to screen height (no fixed pixels). Text respects the UI scale setting.

## 14. Accessibility and comfort

- Colorblind team presets + shape cues.
- Lettering size and opacity sliders; *information level stays fixed* (§11.2).
- Reduce motion: disables pop animations, screen-edge speed lines and panel slide-ins (panels fade in instead).
- Panel stinger on/off.
- Text contrast ≥ 4.5:1 on captions and HUD.

## 15. Render architecture in our engine (Three.js)

**Frame order:**
1. **Depth/normal/ID prepass** (MRT; medium/high presets only).
2. **Main forward pass** (MSAA on medium/high):
   - world: lightmap-banded toon material + triplanar hatching (medium/high) + texture ink
   - actors: banded toon material + key-light shadow map (medium/high)
   - hull outline pass for actors
   - crease-line pass (world)
3. **Viewmodel pass:** own FOV and depth range, hull outline, same band parameters.
4. **Onomatopoeia and FX:** pooled MSDF billboards and flat FX sprites.
5. **Post:** edge composite (medium/high) → FXAA (low) → LUT → paper grain → UI.

**Starting points to evaluate, not obligations:**
- `MeshToonMaterial` with a `gradientMap` (quick banding prototype)
- `OutlineEffect` (hull outlines with skinning)
- `SobelOperatorShader` (edge pass reference)
- an MSDF text library for lettering (check its license)

Production shaders are ours (`docs/08a` §8 has corrected recipes).

**Quality presets**

| Preset | Edges | Hatching | Shadows | AA | Notes |
|---|---|---|---|---|---|
| Low | crease lines + hull only | off | ink blobs | FXAA | integrated GPUs |
| Medium | + screen-space edges (half-res) | light only | banded shadow map (1024) | MSAA 2× | |
| High | full-res edges | full | banded shadow map (2048) | MSAA 4× | |

## 16. Performance budgets (art-specific; add up within `docs/10` §4.3)

| Item | Budget (mid-range GPU, 1080p, high) |
|---|---|
| Prepass (depth/normal/ID) | ≤ 1.0 ms |
| Screen-space edge pass | ≤ 0.6 ms |
| Hull outlines (16 players + viewmodel) | ≤ 0.5 ms, ≤ +20 draw calls |
| Crease lines (whole map) | ≤ 0.3 ms, merged into ≤ 4 draw calls |
| Onomatopoeia + FX | ≤ 0.4 ms |
| Panel stills | ≤ 1.0 ms per capture (max 3 captures per stinger) |
| Post (LUT, grain, AA) | ≤ 0.8 ms |
| Textures | ≤ 256 MB high / ≤ 128 MB low (`docs/10`) |

**Low preset:** must hold ≥ 60 fps on integrated graphics at 1080p.

## 17. Look-dev plan (FORGE first)

1. **Recreate the core shader stack in FORGE:**
   - banded toon material
   - hull outline with pixel width
   - triplanar hatching
   - crease lines on a box-built scene
   - edge pass
   - LUT + grain
2. **Test scenes:** a greybox street corner (day + night tint), a character silhouette at 5 / 20 / 40 m, a viewmodel close-up, team colors in lit/mid/shadow bands, a smoke grenade, a lettering stress test (12 words).
3. **Lock these parameters** (record them as a D-### entry):
   - band count and thresholds
   - mid level
   - shadow tints per palette
   - line widths near/far
   - ink-weight factor
   - hatching density caps
   - grain strength
   - team colors + colorblind presets
   - lettering font
4. **Readability test:** spot an enemy at 20 / 40 / 80 m in lit and shadow bands at movement speed. Identify team in < 250 ms (playtest with 3+ people).
5. **Port to the engine** as the shared material family (M8).

## 18. Implementation plan across milestones

| When | What |
|---|---|
| After M2 (optional, recommended) | **Style spike** (1–2 sessions): toon material + hull outline + crease lines on greybox, measured against §16 on the low preset. Confirms the pipeline early, before content production. |
| M5 | Compiler emits crease-edge line data and per-material line-language IDs; lightmap UV generation planned. |
| M6 | Comic FX hooks: hit/kill events → hit-marker splats, kill stinger capture, onomatopoeia events for shots. |
| M7 | Caption boxes for match flow, comic-strip kill feed, scoreboard page. |
| M8 | Full implementation: material family, lightmap banding, hatching, edge pass, presets, characters, viewmodels, FX, UI, fonts, accessibility. |
| M9 | Fairness tests for onomatopoeia with relevance culling active; v2 death page if the killcam buffer lands. |

## 19. Acceptance tests (ART-xx)

| ID | Test |
|---|---|
| ART-01 | Band stability: no shimmering band edges in a 10 s camera sweep (frame-diff check on a static scene). |
| ART-02 | Line width: hull outlines measure within ±0.5 px of target at 5 / 20 / 40 m. |
| ART-03 | No shower-door: hatching moves with surfaces (world-space), verified with a camera-translation test. |
| ART-04 | Readability: §17.4 targets met; characters never receive hatching; ink-black ≤ 5% of a gameplay frame. |
| ART-05 | Clear center: no lettering, panel or FX pixels in the central zone during play (automated screenshot test). |
| ART-06 | Fairness: onomatopoeia for unseen sources only from received sound events; positions match the coarse grid ±32 u; no words while the source walks. |
| ART-07 | Budgets: §16 and `docs/10` §4.3 met per preset on the reference machines. |
| ART-08 | Licenses: every font, texture source and library is listed in `content/LICENSES.md` with a web-embedding-compatible license. |

## 20. Open questions

1. Band count: 3 (default) or 2 for an even more graphic look?
2. Do day and night variants share a palette with different shadow tints, or get separate palettes?
3. How far can the "ink weight follows light" twist go before it flickers on moving characters?
4. Does lettering adopt the naming tone (e.g., Italian comic sound words, if O-2 picks Italian-food names)?
5. Custom lettering font: commission, or adapt an open-licensed one?
