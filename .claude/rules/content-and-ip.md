---
paths:
  - "content/**"
  - "packages/tools/**"
---

# Rules for content and tools

- **No third-party game assets.** Nothing extracted from Urban Terror, Quake III or any other game: no textures, models, sounds or maps. Only original content or assets with a permissive license recorded in `content/LICENSES.md` (source, license, author).
- **No trademarks in player-facing strings.** Display names live in `content/names/*.json`; never hard-code names in code.
- **FACT data is locked.** `content/weapons/damage.json` mirrors `docs/04` §4 and is protected by a golden test. Change it only on explicit instruction and log a decision.
- **Deterministic tools.** Compilers and report generators produce byte-identical output for identical input.
- **Maps.** Collision comes from brushes only; art meshes never affect movement (`docs/07`).
