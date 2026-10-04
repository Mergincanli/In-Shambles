# 08 — Art Direction & Presentation

> **Status: TBD (decision O-4).** Our art direction is original. Nothing is taken from Urban Terror's look. This doc defines the **process**, the **non-negotiable readability rules** and the **technical budgets**. The style itself is chosen by Mustafa through look-dev.

## 1. Process (look-dev first, production second)

1. **Explore in FORGE** (the Three.js look-dev sandbox): render styles, lighting setups, palettes and post-processing on representative subjects.
   - Subjects: a greybox street corner, a character silhouette at 3 distances, a weapon viewmodel, team colors in sun and shade.
2. **Pick 2–3 candidate directions.** For each, capture the same 5 test views (snapshot comparison mode) and a 10 s movement clip.
3. **Readability test** each candidate in-engine on `arena_greybox`: can players spot enemies at 20/40/80 m in light and shadow? Is team identification instant? Are speed trails, tracers and hit feedback clear?
4. **Lock the direction:** write the style guide section below (palette, materials, lighting model, post, UI language) and log it as a decision (D-###).
5. **Production:** build assets to the specs in §4; Claude Code implements the rendering features required by the chosen style (M8).

## 2. Readability rules (style-independent; these are gameplay)

- **Silhouette first:** characters must read against every background (value contrast ≥ a target set during look-dev). Avoid environment colors that match team colors.
- **Team identification:** team color on large surfaces (torso/arms/legs bands) plus a shape cue (colorblind-safe). Personal accent color on armbands (an idea UrT also used) is optional.
- **Enemy vs. friend:** friendly name tags/markers on teammates only. No through-wall enemy outlines.
- **Movement readability:** speed trail above 600 u/s (team-tinted). Clear wall-kick and ledge-grab animations and sounds, so opponents can read and counter movement.
- **Combat feedback:**
  - Tracers visible but thin.
  - Muzzle flash removed by the suppressor (gameplay rule).
  - Impact effects distinguish world vs. player.
  - Server-confirmed hit sound and markers.
  - Bleeding visible to others (blood trail) and to self (blackout pulse, HUD blink).
- **Lighting:** no pitch-black hiding spots, and no blown-out areas where players vanish. Keep player-relevant areas within a readable luminance range.
- **Accessibility:** colorblind presets (team colors + shape cues), adjustable FOV, viewmodel size/position, reduced camera shake, subtitle/captions for VO.

## 3. Lessons from the original's look (for inspiration, not copying)

- **Grounded, recognizable places** (Mediterranean towns, desert cities, European streets, castles, ruins). Players learned maps quickly because the spaces made sense.
- **Baked lighting + overbright** gave strong contrast and clear shapes on modest hardware. Our modern equivalent: baked GI or stylized lighting + HDR tone mapping.
- **Chunky brush architecture** reads well at high movement speeds. Avoid noisy micro-geometry on surfaces players kick and grab.
- **"Hollywood" flavor:** ejected brass flying across the screen, punchy hit sounds, a speed trail. Feel over realism.

## 4. Technical asset specs and budgets (browser)

| Item | Budget / spec |
|---|---|
| Character (third person) | ≤ 15k tris LOD0, 3 LODs; 1–2 materials; glTF 2.0 skinned; ≤ 60 bones |
| Viewmodel (weapon + arms) | ≤ 12k tris; 1–2 materials; separate render pass |
| Weapon world model | ≤ 4k tris |
| Textures | KTX2/Basis; 2048 max for hero assets, 1024 typical; texel density target set in look-dev |
| Map (visible set) | target ≤ 300 draw calls; merge static by material; instancing for props |
| Total GPU texture memory | ≤ 256 MB on the "high" preset; ≤ 128 MB on "low" |
| First-match download | ≤ 30 MB compressed (client + one map + characters + weapons) |
| Frame time | see `docs/10` (≥ 144 fps mid-range desktop; ≥ 60 fps integrated GPU on "low") |

**Character scale vs. hull:** gameplay uses the 30×30×56 u standing hull (`docs/03` §2). Author characters so the visual body fits the hull, with the head top around 58–60 u. The eye height at 50 u above the feet is fixed by gameplay. Any style (realistic or stylized) must respect these proportions so hitboxes (`docs/04` §10) match visuals.

## 5. Naming, tone and UI language (coupled to decision O-2)

- Food names → playful tone everywhere (UI copy, kill feed, VO, VFX accents).
- Modified-real names → grounded tone.
- Whatever is chosen: every weapon shows **name + type tag** (e.g., "Grissino · Sniper"). Kill feed uses icons + names.
- UI typography: one display face + one UI face (licenses must allow web embedding).

## 6. Style guide (fill in when O-4 is decided)

| Aspect | Decision |
|---|---|
| Rendering style | TBD (e.g., stylized PBR, painterly, flat-shaded, toon, retro-modern) |
| Palette | TBD (world, team colors, UI accent) |
| Lighting model | TBD (baked lightmaps / probes / stylized) |
| Post-processing | TBD (tone mapping, bloom, outline, grain…) |
| Materials | TBD |
| VFX language | TBD |
| UI language | TBD |
| Reference board | link to FORGE snapshots |
