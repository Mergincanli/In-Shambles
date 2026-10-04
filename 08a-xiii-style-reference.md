# 08a — XIII (2003) Style Reference (corrected & annotated)

> **What this is:** a reviewed and corrected version of `XIII_art_render_style_specification.md` (originally generated with another LLM).
> It describes the original game's look and the techniques that recreate it.
> **What this is not:** our rules. Our applied art direction lives in `docs/08-art-direction.md`.
>
> **Labels used in this doc**
> - **VERIFIED**: backed by a source (§9).
> - **LIKELY**: plausible but not confirmed by a primary source.
> - **DESIGN**: a proposal for a modern version, not a fact about XIII.

## 0. Review summary: what was wrong and what changed

| # | Original claim | Problem | Correction |
|---|---|---|---|
| 1 | The style is "Ligne Claire + pulp realism" with heavy hatching and pitch-black shadows | Ligne claire (Hergé's clear line) explicitly avoids hatching and downplays contrast, so the combination contradicts itself. XIII's source comic (William Vance) belongs to the realistic adventure tradition, not ligne claire. | §2 splits this into two coherent ink recipes and places the game's look between them. |
| 2 | Kill-cam = 3 panels sliding across the top third: sniper's eye → bullet in mid-air → impact | Contemporary coverage describes a **series of small panels popping up in the top-left corner** after a skilled shot, showing the enemy taking the hit and falling. The bullet-cam is an invention. | §5.2 describes the verified behavior. The bullet-cam is kept only as a labeled DESIGN idea. |
| 3 | The specific words "TATATATA", "BA-DA-BOOM", "KABOOM", "pfft", the falling "NOOOO" trail, and yellow/red alert colors | Unverified. What's verified: **"TAP TAP TAP" footsteps** (visible even through walls, part of a "sixth sense"), and big **"BAM"-style words** when shooting. | Verified items marked VERIFIED; the rest relabeled DESIGN. |
| 4 | "The original used inverted hulls for characters + hand-painted lines in textures" | No primary source found. Reviews confirm heavy black outlines on characters and solid colors. | Marked LIKELY. |
| 5 | Shadow band intensity = 0.0, while also saying "the darkest band adopts a tinted ambient" | Contradiction: 0 × color = black. Thresholds also differ between sections (0.45 vs 0.4; 0.05 vs 0.15). | One parameter set; the shadow band uses a **tint color**, never 0 (§4.1). |
| 6 | Banding uses only N·L | Ignores **cast shadows** (shadow maps) and baked lighting. Hard `if`/`step` thresholds alias and shimmer. | Combine shadow terms *before* quantizing; anti-alias band edges with `fwidth` (§4.1). |
| 7 | Outline formula multiplies thickness by camera distance, yet the text says "scale inversely with distance" | The formula and the rule contradict each other. Also missing: smoothed normals (hard edges split the hull), skinning, and correct normal transforms. | Define width **in pixels** via clip-space extrusion with a distance falloff curve (§4.2A, §8.2). |
| 8 | Sobel on the raw depth buffer with fixed thresholds | Raw depth is non-linear. Fixed thresholds create false edges at grazing angles and miss far edges. The object-ID buffer was listed but never used. Hard `step` aliases. | Linear depth, distance- and angle-aware thresholds, ID edges, smooth edge mask (§4.2B). |
| 9 | Screen-space hatching (with object-space as an aside) | In a first-person game the camera never stops moving. Screen-space strokes stay glued to the screen while surfaces slide underneath (the **"shower-door" effect**). | Object/world-space (triplanar) hatching with tonal art maps. Screen space is reserved for paper grain (§4.3). |
| 10 | "Ben-Day dots" as part of the classic look | Big visible dots are an American pulp / pop-art idiom, not typical of Franco-Belgian albums or XIII. | Kept only as an optional DESIGN twist. |
| 11 | The 7.1 "GLSL/HLSL" shader | It's GLSL only. It wouldn't compile as written: `v_Normal` and `u_ScreenResolution` are undeclared, and it mixes GLSL ES 3.00 `texture()` with ES 1.00 `gl_FragColor` (only engine shims like Three.js's hide that). It also uses screen-space hatching (see #9). | Rewritten for Three.js `ShaderMaterial` (§8.1). |
| 12 | The 7.2 hull shader | Normals transformed with `mat3(modelView)` (wrong under non-uniform scale). Constant view-space thickness makes width vary with distance. No skinning; no smoothed normals. | Rewritten (§8.2). |
| 13 | The 7.3 onomatopoeia pseudocode | Two scale tweens run **in parallel** and fight each other. Units are undefined. Allocates a new object per word (GC stutter). In multiplayer, footstep words through walls = **wallhack**. | Sequenced, pooled, unit-aware, fairness-gated (§8.4, §5.1). |
| 14 | Checklist: "disable bilinear filtering on line-art textures" | Nearest filtering makes thin ink lines alias and crawl in motion: the opposite of crisp. | Trilinear + anisotropic filtering, minimum line thickness, line-preserving mips, or MSDF line art (§6). |
| 15 | Fonts: "comic serif or block lettering (Badaboom, Komika Axis, CC Wild Words)" | Comic lettering is usually *sans*, hand-lettered style. Several named fonts need paid or web-embedding licenses. | License check required; open-license alternatives listed (§5.3). |
| 16 | Hex colors written as `$#000000$` | Inside LaTeX math, `#` breaks rendering. | Use backticks: `#000000`. |
| 17 | Palette examples: "XIII's iconic orange flight suit", "emerald green winter coats" | Unverified costume/palette claims. | Removed; palettes in §3 are generic DESIGN examples. |
| 18 | Caption example built from XIII's story (beach, key, tattoo) | Uses the original's narrative elements. | Removed; our captions must be original. |
| 19 | "Precise gamut mapping" and post-saturation boost | Vague. Boosting saturation in post muddies a palette-driven look. | Linear lighting → tone map/LUT → sRGB output; saturation is authored in the palette (§3). |
| 20 | Pipeline does banded lighting in mesh shaders *and* composites "light bands" in post | Mixes forward and deferred ideas, with two places doing the same job. | Forward toon materials + post-process ink edges only (§4.4). |

## 1. Facts about XIII (2003)

**VERIFIED**
- Developed by **Ubisoft Paris** on **Unreal Engine 2**. Released November 2003 for Windows, PS2 and GameCube; the Xbox version was developed by Southend Interactive. A Mac OS X port (Zonic / Feral Interactive) followed in June 2004.
- Loosely based on the first five volumes of the 1984 Belgian comic series *XIII* (writer Jean Van Hamme, artist William Vance).
- Presented in a **comic-book, cel-shaded** style. Single-player and multiplayer.
- Comic devices:
  - a **"sixth sense"** that reveals nearby enemies, with floating **"TAP TAP TAP"** words for footsteps, readable even through walls
  - big **"BAM"-style** words when shooting enemies
  - **series of small panels** popping up (top-left) after well-placed shots or sniper headshots, showing the enemy taking the hit and falling
  - comic panels used for storytelling
- Reviewers describe the visuals as **solid colors with heavy black outlines** on characters.
- The **2020 remake** (PlayMagic / Microids) was rebuilt from scratch because the original source code was considered lost.

**LIKELY (unconfirmed)**
- Character outlines via extruded shells ("inverted hull").
- Environment line work and hatching painted directly into textures, since real-time screen-space post-processing was costly on 2003 consoles.

## 2. Style vocabulary (corrected)

- **Ligne claire** (VERIFIED definition): Hergé's "clear line". Clear, strong lines, **no hatching**, downplayed contrast, strong colors; cast shadows are often omitted.
- **Realistic Franco-Belgian adventure inking** (the tradition XIII's comic belongs to): contour weight varies (thicker on the shadow side), with spot blacks and selective hatching in core shadows.
- **Two coherent recipes; don't mix them blindly:**
  - **A. Clear-line:** uniform contours, flat color, minimal shading, *no hatching*.
  - **B. Adventure ink:** weighted contours, flat color, spot blacks, hatching only in core shadows.
- **XIII's game look** sits between A and B: thick, fairly uniform outlines, flat colors, simple stepped shading, with textural line work (LIKELY painted).
- **Halftone / Ben-Day dots:** an American print idiom. Usable as a stylistic twist (DESIGN), not as authenticity.

## 3. Color (DESIGN unless noted)

- **Flat local colors.** Surfaces read as large, simple color blocks. Detail comes from ink lines, not texture noise.
- **Limited palette per zone/map:** 3–5 dominant hues + neutrals + one accent. Examples (generic):
  - *Sunny coast:* warm sand, saturated sea blue, white stucco, dark rock.
  - *Industrial:* olive and slate neutrals, hazard amber accents.
  - *Night city:* deep blue ambient, warm window light, wet-street highlights.
- **Shadows are tinted, not black:** e.g., indigo for day, violet for night. Pure black is reserved for ink: contours, spot blacks, small accents.
- **Color pipeline:** light in linear space → tone map (or none, for flat looks) → optional LUT → sRGB output. Author saturation in the palette instead of boosting it in post.
- Write hex codes in backticks: `#FFE600`.

## 4. Rendering techniques (corrected)

### 4.1 Stepped (banded) lighting
- **Inputs:**
  - key-light term `ndl = dot(N, L)`, where L points **from the surface toward the light**
  - cast-shadow term `s` (0–1) from shadow maps or baked lightmaps
  - optional baked/ambient luminance
- **Combine before quantizing:** `x = min(ndl, mix(-1.0, 1.0, s))`. A surface in cast shadow falls into the shadow band even if it faces the light.
- **Bands:** 2–3 (lit / mid / shadow). Typical thresholds: `T_lit ≈ 0.40`, `T_mid ≈ 0.05`. The mid level is ~0.6 of the way from shadow to lit. **Use one parameter set across all shaders.**
- **Shadow band = shadow tint × albedo**, never 0.
- **Anti-aliasing:** replace hard `if`/`step` with `smoothstep(T − w, T + w, x)`, where `w = fwidth(x)`. This gives about a 1-pixel transition and removes stair-stepping and shimmer.
- **Specular (metal, glass):** binary highlight `smoothstep(T_spec − w, T_spec + w, pow(max(dot(N, H), 0.0), shininess))`, colored white or light-colored. Matte materials (cloth, skin, paper-like surfaces) have no specular.

### 4.2 Outlines

**A. Inverted hull (characters, weapons, viewmodels)**
1. Draw a second copy of the mesh with **front faces culled** (render back faces only), colored ink-black.
2. Extrude along **smoothed normals**: averaged across hard edges and baked into a separate attribute or a duplicate geometry. Raw split normals leave gaps at every hard edge.
3. Define the width **in pixels**:
   - Extrude in clip space along the projected normal direction.
   - Multiply by `clip.w` to cancel the perspective divide.
   - Shrink the pixel width with distance on a curve (e.g., 2.5 px near → 1 px far) so distant figures don't become blobs.
4. Skinned meshes must run the same skinning on the outline pass.
5. The viewmodel gets its own width (it's always near).
6. Optional "ink weight" twist (DESIGN): slightly thicker on the shadow side (scale width by `1 − ndl`), as human inkers do.

**B. Screen-space edges (architecture, intersections)**
1. Prepass: linear view depth, view-space normals, object ID.
2. Edge sources:
   - **Depth:** relative depth difference over a 3×3 or Roberts-cross kernel. The threshold scales with depth and with the grazing angle (`1 − N·V`) to avoid false edges on slanted floors.
   - **Normals:** angular difference between neighbors.
   - **ID:** any change = edge (crisp separation of overlapping objects).
3. Build the mask with `smoothstep`, not `step`. Line thickness = kernel offset scaled by device pixel ratio.
4. Mask out objects that already have hull outlines (via ID) to avoid double lines, or accept the doubling deliberately.

**C. Precomputed crease lines (DESIGN; ideal for brush-built levels)**
- When levels are made of convex brushes (TrenchBroom/Quake-style), the compiler knows every crease edge. Emit them as line geometry with a fixed pixel width.
- Lines are rock-stable, never noisy, and LOD-able. Screen-space edges then only need to handle silhouettes.

### 4.3 Hatching and screentones
- **Never screen-space in an FPS** (shower-door effect).
- **Object/world-space:**
  - Triplanar or UV-mapped stroke textures.
  - A *tonal art map* (TAM) set: 2–4 stroke densities, mip-consistent so stroke width stays constant with distance.
  - Applied **only in the mid/shadow bands**.
- **Texture-painted hatching** (LIKELY the original's approach): paint hatching into albedo around folds, corners and recesses. It doesn't respond to dynamic light, but it's stable and cheap.
- **Halftone dots** (DESIGN option): same world-space rule; dot size driven by band.

### 4.4 Pipeline order (forward renderer)
1. Main pass: toon materials (bands + hatching + albedo ink lines). Characters and weapons also get the hull-outline pass. Optional crease-line pass.
2. Prepass (or MRT): depth / normals / ID for edge detection.
3. Post:
   - ink edges composite
   - anti-aliasing (MSAA in the main pass and/or FXAA/SMAA)
   - LUT grade
   - subtle paper grain (screen-space is fine here: the "paper" is the page)
   - bloom clamped or off

## 5. Comic mechanics

### 5.1 Onomatopoeia
- **VERIFIED in XIII:** "TAP TAP TAP" footstep words (also through walls, as a sixth sense) and big "BAM"-style words on shots.
- **DESIGN proposals:** per-weapon words, explosion bursts with spiked balloons, small words for suppressed shots, falling-scream trails, color by alert state.
- **Implementation:**
  - camera-facing billboards with **SDF/MSDF text** (crisp at any size), black outline + colored fill
  - pop animation, *sequenced*: scale 0 → 1.2 (≈60 ms), then → 1.0 (≈60 ms); drift up; fade over 0.5–1.0 s
  - pooled instances; caps on count and overlap; distance scaling
- **Multiplayer warning:** showing footsteps through walls reveals exact enemy positions. A competitive game must gate this to information the player could already hear, at the same precision.

### 5.2 Comic panels
- **VERIFIED in XIII:** a series of small panels pops up in the top-left after skilled kills or sniper headshots, showing the target taking the hit and falling. Gameplay continues. Panels were also used for story beats and "meanwhile" moments elsewhere in a level.
- **Framing (DESIGN):**
  - black border with an inner white matte line, sized as a percentage of screen height (not fixed pixels)
  - a slight offset/overlap reads as "panels on a page"
- **Technique:** secondary cameras render into textures. Cheapest, and most comic-like: render each panel **once as a still** at low resolution (e.g., 384×216) at three moments (hit, +150 ms, +450 ms) instead of re-rendering live every frame.
- **DESIGN idea (not XIII):** a "bullet-cam" sequence (shooter → projectile → impact).

### 5.3 Captions and lettering (DESIGN)
- Caption box: flat yellow (e.g., `#FFE600`), 2 px black border, hard drop shadow (+4/+4 px at 1080p, scaled).
- **Lettering:** all-caps, hand-lettered *sans* style.
- **License check:** many comic fonts (e.g., Comicraft, Blambot) are paid or restrict web embedding. Open-licensed options such as **Bangers** or **Comic Neue** (SIL OFL on Google Fonts) are safe starting points; verify each license before shipping.
- **Content must be original:** no story elements, names or text from XIII.

## 6. Textures and assets (corrected)

| Element | Rule |
|---|---|
| Albedo | Flat color blocks + **hand-inked lines** (seams, folds, panel lines) in near-black. Minimum line thickness ≈ 2–3 texels at the target texel density, so lines survive mipmaps. |
| Filtering | **Trilinear + anisotropic.** Don't use nearest filtering (it aliases). For very crisp large-scale line art, consider MSDF line textures. Generate mips with a line-preserving filter (avoid gray mush). |
| Normal maps | No photographic micro-detail. At most clean bevels/chamfers. Prefer geometry + ink. |
| Roughness/spec | Mostly matte. Specular only via sharp masks on metal, glass and scopes. |
| Topology | Clean, deliberate silhouettes. Hull outlines need **smoothed outline normals** baked at import. |
| Contact shadows | Hard-edged dark decals or stipple decals under props (DESIGN), kept readable. |

## 7. HUD (DESIGN reference only)

- Thick black frames, flat accent colors, segmented bars.
- A comic-style reticle that changes per weapon class.
- Damage shown as directional comic splash marks instead of soft red vignettes.
- **Note:** the example's "ARM 50%" assumes armor points. Our game uses armor *items* (vest/helmet), so `docs/08` adapts the HUD.

## 8. Corrected code recipes (Three.js, WebGL2)

> Three.js `ShaderMaterial` injects `#version 300 es`, precision qualifiers and compatibility defines (`gl_FragColor`, `texture2D` work). Raw GLSL outside Three.js needs those declared manually. Three.js also ships useful starting points to evaluate: `MeshToonMaterial` (with a `gradientMap` for stepped lighting), `OutlineEffect` (hull outlines, skinning-aware) and `SobelOperatorShader` in its examples.

### 8.1 Stepped toon fragment (key light + cast shadow + tinted shadows)
```glsl
uniform vec3  uAlbedo;          // or sample an albedo texture
uniform vec3  uShadowTint;      // e.g. vec3(0.42, 0.45, 0.70) – never black
uniform vec3  uKeyDirView;      // view space, surface -> light
uniform vec3  uKeyColor;
uniform float uLitT;            // 0.40
uniform float uMidT;            // 0.05
uniform float uMidLevel;        // 0.6
varying vec3  vNormalView;

float aaStep(float edge, float x) {
  float w = fwidth(x);
  return smoothstep(edge - w, edge + w, x);
}

void main() {
  vec3 N = normalize(vNormalView);
  float ndl = dot(N, normalize(uKeyDirView));
  float s = 1.0;                       // cast-shadow term (1 = lit); plug shadow map / lightmap here
  float x = min(ndl, mix(-1.0, 1.0, s));
  float light = aaStep(uMidT, x) * mix(uMidLevel, 1.0, aaStep(uLitT, x)); // 0 / mid / 1
  vec3 shadowCol = uAlbedo * uShadowTint;
  vec3 litCol    = uAlbedo * uKeyColor;
  gl_FragColor = vec4(mix(shadowCol, litCol, light), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
```

### 8.2 Hull outline vertex (pixel-accurate width)
```glsl
// Material: side = THREE.BackSide (front faces culled). Outline geometry carries smoothed normals.
uniform float uWidthNearPx;   // e.g. 2.5
uniform float uWidthFarPx;    // e.g. 1.0
uniform float uFadeStart;     // view-space distance where thinning starts
uniform float uFadeEnd;       // distance where uWidthFarPx is reached
uniform vec2  uViewportPx;    // drawing-buffer size in pixels
void main() {
  vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
  vec3 nView   = normalize(normalMatrix * normal);        // smoothed normal (skinned if SkinnedMesh)
  vec4 clip    = projectionMatrix * viewPos;
  vec2 dir     = (projectionMatrix * vec4(nView, 0.0)).xy;
  float len    = length(dir);
  dir          = len > 1e-5 ? dir / len : vec2(0.0);
  float px     = mix(uWidthNearPx, uWidthFarPx, smoothstep(uFadeStart, uFadeEnd, -viewPos.z));
  clip.xy     += dir * (px * 2.0 / uViewportPx) * clip.w;  // ×w cancels perspective divide
  gl_Position  = clip;
}
// For skinned meshes, build this via onBeforeCompile on a basic material so Three.js's
// skinning chunks transform position and normal before the extrusion.
```

### 8.3 World-space (triplanar) hatching sample
```glsl
uniform sampler2D uHatch;    // R = light strokes, G = dense strokes (tileable, mip-consistent)
uniform float uHatchScale;   // strokes per world unit
float hatch(vec3 wPos, vec3 wN, float band01) {
  vec3 b = pow(abs(wN), vec3(4.0)); b /= (b.x + b.y + b.z);
  vec2 h = texture2D(uHatch, wPos.yz * uHatchScale).rg * b.x
         + texture2D(uHatch, wPos.xz * uHatchScale).rg * b.y
         + texture2D(uHatch, wPos.xy * uHatchScale).rg * b.z;
  return mix(h.g, h.r, band01);   // band01: 0 = core shadow (dense), 1 = mid (light)
}
```

### 8.4 Onomatopoeia spawner (TypeScript sketch: pooled, sequenced, fairness-gated)
```ts
// Client presentation only — driven by events the client already received.
function onSoundEvent(e: SoundEvent, listener: Listener, now: number) {
  if (!audibleTo(listener, e)) return;                   // same rule as the audio engine
  const pos = e.sourceVisible ? e.exactPos : e.coarsePos; // unseen sources: server-quantized position
  const word = wordFor(e.kind, e.material, e.weaponClass); // from data, not code
  const w = wordPool.acquire(); if (!w) return;          // cap reached → skip (no allocation)
  w.begin(word, pos, styleFor(e), now);
  // keyframes (sequenced): 0–60 ms scale 0→1.2, 60–120 ms 1.2→1.0,
  // 0–800 ms rise +24 u (game units), 500–900 ms fade 1→0, then release to pool
}
```

## 9. Sources (accessed Oct 2026)

- Wikipedia, "XIII (2003 video game)": developer, engine, platforms, release, comic basis, cel-shaded presentation.
- GameSpot, "XIII Impressions" (E3 2003 preview): sixth sense, floating "Tap tap tap" footsteps, panels popping up top-left showing the enemy hit and falling.
- Old-Games.com review text: heavy black outlines and solid colors, "BAM" words, close-up panels on sniping headshots, tracking footsteps through walls.
- Wikipedia, "XIII (2020 video game)": remake rebuilt from scratch, source code considered lost.
- Wikipedia, "Ligne claire": definition (Hergé; strong lines, no hatching, downplayed contrast, strong colors; the name was coined by Joost Swarte in 1977).
