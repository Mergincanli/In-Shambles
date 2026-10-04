---
paths:
  - "packages/client/src/render/**"
  - "packages/client/src/hud/**"
  - "packages/client/src/audio/**"
  - "packages/client/src/input/**"
---

# Rules for client presentation code

- **Read-only consumer.** Rendering, HUD and audio read *interpolated* state and events. They never mutate simulation state or call sim functions with side effects.
- **One coordinate conversion.** Z-up inches → Three.js Y-up meters only via `render/space.ts`. No ad-hoc axis swaps elsewhere.
- **Per-frame discipline.**
  - No allocations in the frame loop. Reuse `Vector3`/`Matrix4`/`Quaternion` scratch objects.
  - Pool FX, decals and audio voices.
  - Dispose geometries, materials and textures when unloading maps.
- **Mouse look is immediate.** Apply mouse deltas to the camera every frame. UserCmds sample angles per tick. Never smooth or accelerate raw input unless the player enables it.
- **HUD updates are imperative** (refs/DOM writes). Throttle non-critical panels to ≤ 15 Hz. No framework re-render per frame.
- **Physical keys.** Bind with `KeyboardEvent.code` so non-QWERTY layouts work.
- **Budgets.** Respect draw-call and texture budgets (`docs/08` §4, `docs/10` §4.3). Check `renderer.info` in the dev overlay.
