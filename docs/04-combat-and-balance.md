# 04 — Combat & Balance Spec

> Goal: reproduce **how Urban Terror's guns were balanced**. That means hit-zone damage, armor, bleeding/healing, ammo, fire modes and the accuracy model. Names, visuals, sounds and fiction are ours.
> FACT values (sources in `docs/02` §14) must not change without an explicit instruction from Mustafa. ESTIMATE values are tunables in weapon data files.

## 1. Combat model in one paragraph

Health is 100. Every bullet is a hitscan ray resolved on the **server** against lag-compensated hitboxes (`docs/05` §7).
- **Damage** comes from a lookup table indexed by weapon and hit zone. Helmet and vest swap in their own columns.
- **Bleeding:** unprotected wounds bleed (~5 HP/s) until bandaged.
- **Healing:** only a medic restores health (max 90% with a medkit, 50% without).
- **Accuracy** is base accuracy + spread that grows while firing + temporary recoil, recovering per weapon.
- **Movement** barely affects non-scoped weapons and destroys scoped accuracy.

## 2. Stable IDs (internal) and the original reference

Display names are **TBD** (decision O-2). They live in `content/names/weapons.json` and are never hard-coded. The LR300 and M4 were mechanical twins, so they merge into one archetype.

| ID | UrT reference | Slot | Notes |
|---|---|---|---|
| `melee_knife` | Knife | always carried | slash + throw |
| `pistol_9mm` | Beretta 92 | sidearm | |
| `pistol_burst` | Glock | sidearm | semi/burst |
| `pistol_45` | Colt 1911 | sidearm | |
| `pistol_50` | Desert Eagle | sidearm | |
| `revolver_44` | .44 Magnum | sidearm | 4.3 |
| `smg_compact` | MP5K | secondary* | |
| `smg_mp` | MAC-11 | secondary* | |
| `smg_pdw` | P90 | secondary* | 4.3 |
| `smg_45` | UMP45 | secondary* | hyper-burst |
| `shotgun_tactical` | SPAS-12 | secondary* | pellets, shell reload |
| `shotgun_auto` | Benelli M4 | primary or secondary | 4.3 |
| `launcher_40mm` | HK69 | primary | timed grenades |
| `rifle_ar` | LR300 / M4 | primary | the competitive staple |
| `rifle_ar_heavy` | AK-103 | primary | |
| `rifle_ar_scoped` | G36 | primary | scope |
| `lmg` | Negev | primary | blocks secondary |
| `sniper_semi` | PSG-1 | primary | |
| `sniper_bolt_fast` | FR-F1 | primary | 4.3 |
| `sniper_bolt_heavy` | SR-8 | primary | ignores vest |
| `grenade_he` | HE grenade | grenade | |
| `grenade_smoke` | Smoke grenade | grenade | |

\* Secondaries may be placed in the primary slot, not vice versa (FACT).

**Items:** `armor_vest`, `armor_helmet`, `medkit`, `attach_laser`, `attach_suppressor`, `nvg`, `ammo_extra`.

## 3. Health, zones, armor, bleeding, healing

### 3.1 Zones (FACT list; geometry ESTIMATE, see §10)
Zones: `head`, `torso`, `arms`, `groin`, `butt`, `upperLeg`, `lowerLeg`, `foot`.

Armor variants:
- Head hit while wearing `armor_helmet` uses the **helmet** column.
- Torso hit while wearing `armor_vest` uses the **vest** column.
- Arms, groin, butt and legs are never armored.

**Torso has priority over arms** (FACT): if the ray intersects both torso and arm volumes of the same target, resolve to torso.

### 3.2 Damage application
`damage = table[weaponId][zoneColumn]`, as % of 100 HP. Clamp health at 0. For shotguns, see §8.3.
- **No distance falloff for bullet weapons** (INFERRED from 4.x data; verify).
- Shotguns and explosives fall off with distance.

### 3.3 Bleeding (FACT)
- A hit causes a **wound** unless it was absorbed by the vest or helmet column. Knife hits **always** wound, even through armor.
- While wounded: lose `bl_rate` = 5 HP/s (FACT ≈5%/s).
  - `bl_stack` = 0: v1 uses a flat rate regardless of wound count (ESTIMATE).
- Presentation while bleeding:
  - blood-trail decals
  - periodic pain sound (audible to others)
  - red blackout pulse every ~3 s (ESTIMATE)
  - small random aim jerk at each pulse (ESTIMATE 0.6°)
- **Leg wounds** (lowerLeg, foot) set `legWound` → limp (`docs/03` §5.6) until bandaged (FACT: in 4.2+ only these zones limp).

### 3.4 Bandage (FACT behavior; timing ESTIMATE)
- Hold the bandage key. Duration `bd_time` = 3.0 s (historical datapoint: 3.5 s in beta 1.1).
- **Effect:** clears bleeding, `legWound` and `legsBroken`. Does **not** restore HP.
- **Targets:** self, or another player (teammate or enemy) within 64 u and roughly in view (ESTIMATE).
- **Restrictions:** cannot fire while bandaging. Reload may overlap if started first (order quirk; optional). SPAS cannot reload while bandaging (FACT).

### 3.5 Healing / medic (FACT caps; rates ESTIMATE)
- Healing a teammate raises their health up to a cap:
  - **90%** if the healer carries `medkit`
  - **50%** if neither carries one
  - if only the patient carries one, healing is slower (`hl_rateNoKit`) up to 90%
- Rates (ESTIMATE): `hl_rateKit` = 12 HP/s, `hl_rateNoKit` = 6 HP/s.
- Multiple healers **stack** (FACT).
- **You cannot heal yourself.** The medkit is a tool, never consumed (FACT).
- Healing also bandages (clears bleeding) on the first tick.

### 3.6 Armor side effects (FACT)
- `armor_vest`: max stamina × 0.5. Players can drop it at will (competitive habit).
- `armor_helmet`: no side effects.

## 4. Damage table (FACT: UrT 4.3, % per hit)

Machine-readable source of truth: `content/weapons/damage.json`. A golden test asserts it matches this table exactly. Shotgun rows are the **point-blank full blast**; per-pellet = value ÷ pellet count (§8.3).

| ID | Head | Helmet | Torso | Vest | Arms | Groin | Butt | U.leg | L.leg | Foot |
|---|---|---|---|---|---|---|---|---|---|---|
| melee_knife | 100 | 60 | 44 | 35 | 20 | 40 | 37 | 20 | 18 | 15 |
| pistol_9mm | 100 | 40 | 33 | 22 | 13 | 24 | 22 | 15 | 13 | 11 |
| pistol_burst | 100 | 45 | 35 | 29 | 15 | 29 | 27 | 20 | 15 | 11 |
| pistol_45 | 100 | 60 | 40 | 30 | 15 | 32 | 29 | 22 | 15 | 11 |
| pistol_50 | 100 | 66 | 57 | 38 | 22 | 42 | 40 | 28 | 22 | 18 |
| revolver_44 | 100 | 82 | 66 | 59 | 33 | 57 | 52 | 40 | 33 | 25 |
| smg_compact | 50 | 34 | 30 | 20 | 11 | 22 | 20 | 15 | 13 | 11 |
| smg_mp | 50 | 29 | 20 | 16 | 13 | 16 | 15 | 15 | 13 | 11 |
| smg_pdw | 50 | 40 | 33 | 27 | 16 | 27 | 25 | 17 | 15 | 12 |
| smg_45 | 100 | 51 | 44 | 29 | 17 | 31 | 28 | 21 | 17 | 14 |
| shotgun_tactical | 100 | 80 | 80 | 40 | 32 | 59 | 59 | 40 | 40 | 40 |
| shotgun_auto | 100 | 100 | 90 | 67 | 32 | 60 | 50 | 35 | 30 | 20 |
| launcher_40mm (impact) | 20 | 20 | 20 | 20 | 20 | 20 | 20 | 20 | 20 | 20 |
| rifle_ar | 100 | 51 | 44 | 29 | 17 | 31 | 28 | 20 | 17 | 14 |
| rifle_ar_heavy | 100 | 58 | 51 | 34 | 19 | 36 | 33 | 22 | 19 | 15 |
| rifle_ar_scoped | 100 | 51 | 44 | 29 | 17 | 31 | 28 | 20 | 17 | 14 |
| lmg | 50 | 34 | 30 | 20 | 11 | 23 | 21 | 13 | 11 | 9 |
| sniper_semi | 100 | 100 | 97 | 63 | 36 | 75 | 70 | 41 | 36 | 29 |
| sniper_bolt_fast | 100 | 100 | 90 | 75 | 40 | 75 | 74 | 50 | 40 | 30 |
| sniper_bolt_heavy | 100 | 100 | 100 | 100 | 50 | 100 | 97 | 60 | 50 | 40 |

Other damage:
- **Kick:** 20 (body, FACT).
- **HE grenade:** distance-based (ESTIMATE: 100 at center → 0 at 256 u, quadratic falloff, line-of-sight required).
- **Launcher explosion:** same model, radius 200 u (ESTIMATE).
- **Fall/drown:** see `docs/03`.

## 5. Hits-to-kill (derived from §4; ignores bleeding)

| ID | Head | Helmet | Torso | Vest | Notes |
|---|---|---|---|---|---|
| rifle_ar / rifle_ar_scoped / smg_45 | 1 | 2 | 3 | 4 | |
| rifle_ar_heavy | 1 | 2 | **2** | 3 | the AK trade: harder hits, slower and wilder |
| pistol_9mm | 1 | 3 | 4 | 5 | 3 torso hits = 99 → bleed finishes |
| pistol_burst | 1 | 3 | 3 | 4 | |
| pistol_45 | 1 | 2 | 3 | 4 | |
| pistol_50 | 1 | 2 | 2 | 3 | |
| revolver_44 | 1 | 2 | 2 | 2 | |
| smg_compact / lmg | 2 | 3 | 4 | 5 | can't one-tap heads |
| smg_mp | 2 | 4 | 5 | 7 | |
| smg_pdw | 2 | 3 | 4 | 4 | 3 torso = 99 |
| sniper_semi | 1 | 1 | 2* | 2 | *97 + bleed ≈ kill |
| sniper_bolt_fast | 1 | 1 | 2 | 2 | |
| sniper_bolt_heavy | 1 | 1 | 1 | 1 | arms 2 |

**Design reading:**
- Helmets make one-taps sniper-only (plus a point-blank `shotgun_auto`).
- High-fire-rate guns are capped at 50 to the head.
- Several weapons land just short of a kill, so bleeding is part of the kill.

## 6. Ammo, fire rate, reload

Ammo is FACT where noted. RPM/reload are mostly ESTIMATE; datapoints are in `docs/02` §5.4. "Mags" = loaded + spare; extra ammo per FACT patterns.

| ID | Mag × total mags (extra ammo) | Modes | RPM (v1) | Reload (v1) | Attachments |
|---|---|---|---|---|---|
| melee_knife | 5 knives | slash, throw | slash every 0.35 s (E) | – | – |
| pistol_9mm | 15 × 3 (×5) F | semi | 400 cap (E) | 1.6 s (E) | laser, suppressor |
| pistol_burst | 12 × 3 (×5) F | semi, burst | 400 / burst 1100 (E) | 1.8 s (E) | laser, suppressor |
| pistol_45 | 10 × 3 (×5) F | semi | 360 (E) | 1.9 s (E) | laser, suppressor |
| pistol_50 | 7 × 3 (×5) F | semi | 200 (E) | 2.2 s (E) | laser |
| revolver_44 | 6 × 3 (×5) (E) | semi | 120 (E) | 3.0 s (E) | – |
| smg_compact | 30 × 3 (×5) F | burst, auto | 600 (I: stopwatch) | 2.6 s (wiki) | laser, suppressor |
| smg_mp | 32 × 3 (×5) F | auto | 800 (E: "fastest") | 2.2 s (E) | suppressor |
| smg_pdw | 50 × 3 (×5) (E) | auto | 650 (E) | 3.0 s (E) | laser |
| smg_45 | 30 × 3 (×5) F | hyper-burst, auto | auto 350 (wiki) / hyper 1100 (E) | 2.8 s (wiki) | laser, suppressor |
| shotgun_tactical | 8 + 24 shells (+48) F | semi | 70 (E) | 0.5 s/shell (E), cancellable | – |
| shotgun_auto | 8 + 24 shells (+48) (wiki) | semi | 150 (E) | 0.45 s/shell (E) | – |
| launcher_40mm | 1 + 3 (+6) F | short, long range | – | 2.5 s (E) | – |
| rifle_ar | 30 × 3 (×5) F | semi, burst, auto | 490 (I: stopwatch ≈493; wiki 415) | 2.35 s (wiki) | laser, suppressor |
| rifle_ar_heavy | 30 × 3 (×5) F | semi, burst, auto | 420 (I: stopwatch ≈423; wiki 282) | 4.28 s (wiki; verify) | laser, suppressor |
| rifle_ar_scoped | 30 × 3 (×5) F | semi, burst, auto | 435 (I: stopwatch) | 2.6 s (E) | suppressor |
| lmg | 90 × 2 (×3) F | auto | 600 (I: stopwatch) | 6.0 s (E: "very long") | suppressor |
| sniper_semi | 8 × 4 (×7) F | semi | 150 cap (E) | 3.2 s (E) | suppressor |
| sniper_bolt_fast | 10 × 4 (×7) (E) | bolt | bolt 0.9 s (E) | 3.0 s (E) | – |
| sniper_bolt_heavy | 5 × 4 (×7) F | bolt | bolt 1.3 s (E), uncancellable F | 3.5 s (E) | – |
| grenade_he | 1–2 per slot (E) | throw (cook) | – | – | – |
| grenade_smoke | 1–2 per slot (E) | throw | – | – | – |

(F = FACT, I = INFERRED, E = ESTIMATE)

**Rules (FACT):**
- Reloading **discards** the remaining rounds of the current magazine.
- No auto-reload: empty click, then manual reload.
- Shells reload one at a time and can be interrupted by firing.
- Ammo pickups are allowed up to the extra-ammo maximum.

**TTK sanity check (v1 RPM):**

| Weapon | Unarmored torso | Vest |
|---|---|---|
| rifle_ar | 0.24 s | 0.37 s |
| rifle_ar_heavy | 0.14 s | 0.29 s |
| smg_45 hyper-burst | ≈0.11 s (one burst) | – |

`pnpm balance-report` prints the full matrix.

## 7. Accuracy model

### 7.1 Parameters (per weapon, all ESTIMATE, in `content/weapons/<id>.json`)

| Field | Meaning |
|---|---|
| `spreadBase` (deg) | First-shot cone half-angle ("accuracy") |
| `spreadPerShot` (deg) | Added per shot fired |
| `spreadMax` (deg) | Cap |
| `spreadRecovery` (deg/s) | Decay back toward base when not firing |
| `recoilPitch` (deg/shot) | Temporary aim climb per shot (applied to the shot direction, and to the view as a kick that recovers) |
| `recoilRecovery` (deg/s) | |
| `movePenalty` (deg at run speed) | Added spread scaled by horizontal speed ÷ run speed. Tiny for non-scoped weapons (FACT: negligible) |
| `airPenalty` (deg) | Added while airborne / in water. Tiny for non-scoped |
| `scoped` | bool; scope levels list |
| `scopedSpread` | Usually 0 (snipers 100% accurate when scoped and still, FACT) |
| `unscopedSpread` | Large for snipers (FACT: wildly inaccurate unscoped) |
| `zoomInDelay` (s) | Time after zooming before full scoped accuracy (FACT: a small delay exists; value ESTIMATE 0.15) |
| `laserMul` | Spread multiplier with laser (ESTIMATE 0.7; FACT: tighter groups) |
| `burstMul` | Spread multiplier in burst mode (ESTIMATE 0.85; FACT: slightly tighter) |

**Rules:**
- **Crouching gives no bonus** (FACT).
- **Suppressor:** no spread or damage change (FACT). It removes the muzzle flash and lowers the audible radius (ESTIMATE ×0.35).
- **Scoped weapons** (snipers and `rifle_ar_scoped` while scoped): any horizontal speed > 10 u/s, airborne, sliding or in water → use `unscopedSpread` (FACT: movement "reduces accuracy to nothing").

### 7.2 Initial values (ESTIMATE; shaped by FACT descriptions)

| ID | base | perShot | max | recov | recoil | Character (source) |
|---|---|---|---|---|---|---|
| pistol_9mm | 0.4 | 0.10 | 1.5 | 6 | 0.0 | very accurate, **no recoil** even spammed (F) |
| pistol_burst | 0.5 | 0.35 | 2.5 | 5 | 0.6 | between 9mm and .50 (F) |
| pistol_45 | 0.5 | 0.30 | 2.2 | 5 | 0.5 | low recoil, good damage (F) |
| pistol_50 | 0.5 | 1.20 | 4.0 | 4 | 2.5 | heavy kick |
| revolver_44 | 0.4 | 1.60 | 4.5 | 3.5 | 3.5 | devastating but slow (F) |
| smg_compact | 0.9 | 0.25 | 3.5 | 4 | 0.6 | mediocre accuracy, more recoil loss than UMP (F) |
| smg_mp | 1.4 | 0.40 | 5.5 | 4 | 0.9 | high recoil and spread (F) |
| smg_pdw | 0.8 | 0.18 | 3.0 | 4.5 | 0.45 | tuned toward accuracy in 4.3 (F) |
| smg_45 | 0.6 | 0.25 | 3.0 | 5 | 0.5 | very controllable (F) |
| rifle_ar | 0.3 | 0.22 | 3.0 | 6 | 0.45 | controllable, fast (F) |
| rifle_ar_heavy | 0.45 | 0.60 | 4.0 | 5 | 0.9 | spread kicks in almost instantly, high recoil (F) |
| rifle_ar_scoped | 0.15 | 0.20 | 2.5 | 6 | 0.4 | most accurate start of clip (F); scope 2.5× (E) |
| lmg | 1.0 | 0.08 | 6.0 | 3 | 0.15 | very high spread that builds slowly; low recoil (F) |
| sniper_semi | unscoped 8 / scoped 0 | – | – | – | 1.5 | zoom 2/4/6× (F), lighter move penalty than heavy bolt (F) |
| sniper_bolt_fast | unscoped 9 / scoped 0 | – | – | – | 1.2 | zoom 3/6× (E) |
| sniper_bolt_heavy | unscoped 10 / scoped 0 | – | – | – | 2.0 | zoom 4/6/8× (F), heaviest move penalty (F) |

### 7.3 Deterministic spread
- Spread offsets come from a seeded PRNG (mulberry32), seeded with `hash(matchSeed, shooterId, tick, shotIndexInTick)`. Client and server compute **identical** cones, so predicted tracers line up with server results.
- Sample uniformly within the cone disk (sqrt-radius).

## 8. Special mechanics

### 8.1 Fire modes (FACT)
- `semi`, `burst` (3 rounds per trigger pull, tighter spread), `auto`. A toggle key cycles the modes available to the weapon.
- **Hyper-burst** (`smg_45`):
  - 3 rounds at ~1100 RPM.
  - 0.25 s between bursts.
  - **If the burst hits nothing**, an extra 0.35 s lockout (FACT: short delay after a miss; durations ESTIMATE).

### 8.2 Snipers (FACT unless noted)
- Multi-level zoom (cycle key; zoom-reset key).
- `sniper_bolt_heavy`:
  - **Unscopes when hit** (any damage).
  - **Bolt cycle cannot be cancelled.**
  - **No automatic re-scope** after the bolt.
  - **Ignores vest.**
- `sniper_semi`: you can empty the magazine while scoped.

### 8.3 Shotguns
- `shotgun_tactical`:
  - **20 pellets** (INFERRED: 4.1 SPAS did 4 per pellet, 80 total).
  - Cone half-angle 4° (ESTIMATE). Each pellet traced and zoned separately.
  - Per-pellet damage = table value ÷ 20.
  - Falloff: full to 192 u, linear to 25% at 1024 u (ESTIMATE).
  - **Shell-by-shell reload**, cancel by firing (FACT).
- `shotgun_auto`: different mechanics in the original (unknown). v1 ESTIMATE: 9 pellets, cone 2.5°, falloff as above, shell reload.
- Spread multi-zone hits make bleeding likely (FACT).

### 8.4 Knife (FACT behavior; numbers ESTIMATE)
- **Slash:** melee trace 48 u from the eye, 0.35 s interval, same damage table.
- **Throw:**
  - Projectile at ~1500 u/s on a very flat, slightly rising path; despawns past ~580 u (FACT: < 600 u).
  - **Cannot throw your last knife** (FACT).
  - Thrown knives can be picked up.
- Knife wounds bleed even through armor (FACT).

### 8.5 Grenades and launcher
- `grenade_he`:
  - Hold to cook, release to throw. Fuse 3.0 s (ESTIMATE).
  - **Switching weapons while cooking cancels the cook and keeps the grenade** (FACT, accepted quirk).
  - Bounces off surfaces. No hit-zone damage; distance-based falloff with line of sight.
- `grenade_smoke`: thick volume ~15 s (ESTIMATE). NVG brackets help see through it (FACT intent).
- `launcher_40mm`:
  - Grenades **do not explode on contact** (FACT): timed fuse ~2.0 s (ESTIMATE), bounce.
  - Short/long modes = two launch speeds (ESTIMATE 650 / 1100 u/s).
  - Direct impact deals the table's 20.
  - **Do not replicate the original's bugs** (random instakills, grenades stuck in hit meshes).

### 8.6 Kick
See `docs/03` §5.8 (20 damage, body, eligible weapons only).

## 9. Loadout system (FACT rules)

- **Slots:** primary, secondary, sidearm, grenade, item1, item2, item3.
- **Legal combinations** (enforced server-side):
  - 2 weapons + sidearm + grenades + 1 item
  - 2 weapons + sidearm + 2 items
  - 1 weapon + sidearm + 3 items
  - 1 weapon + sidearm + grenades + 2 items

  "Weapons" = primary and secondary. Minimum loadout: primary (or a secondary in the primary slot), sidearm, and an item in item slot 1.
- `lmg` disallows a secondary.
- Attachments (laser, suppressor) only take effect on weapons that support them. Both can be active together; they're toggled on/off in-game (spawn on).
- **Gear changes:** once the player has moved or fired this life, changes apply at the next respawn. Selection is allowed while dead or spectating.
- **Death drops:** primary, secondary and grenades drop and can be picked up. Items stay with the corpse unless deliberately dropped earlier (FACT).
- **Pickup:** walk-over auto-pickup (client setting) or crouch + use (FACT: 4.2 made weapons require crouching to pick up). You can exceed the selectable gear by picking up secondaries and grenades.
- **Server gear restrictions** (admin cvar; FACT concept): disallow categories per server/mode.

## 10. Hitboxes (geometry ESTIMATE; finalize against the character model in M8)

**Principles**
- Hitboxes are **zone volumes** (capsules/OBBs) posed from a deterministic, low-cost pose function. Inputs: stance (stand/crouch/slide/climb/ladder/swim), view pitch, yaw and limb phase. The server never runs full skeletal animation for hit detection.
- The same pose function runs on the client for debug visualization.

**Standing layout** (heights above feet; the hull is 30×30×56; volumes may poke slightly outside the hull):

| Zone | Volume | Height range |
|---|---|---|
| foot ×2 | boxes | 0–4 |
| lowerLeg ×2 | capsules | 4–18 |
| upperLeg ×2 | capsules | 18–31 |
| pelvis | box | 30–36 (front half = `groin`, back half = `butt`, by shot direction vs. target facing) |
| torso | capsule | 36–50 |
| arms ×2 | capsules | shoulder to hand, posed by weapon hold |
| head | sphere r=5.5 | centered at 52 |

**Crouched:** compress legs and pelvis/torso downward to fit the 40 u hull.
**Slide:** torso reclined.

**Resolution rules**
- Nearest intersection along the ray wins, **except** torso overrides arms on the same target.
- One ray hits at most one player (FACT: no penetration).
- The ray stops at world geometry, except breakable brushes (later).

## 11. Feedback (FACT behaviors; presentation ours)

**Hit confirmation**
- Hit sound ("plink"-style) for the attacker on every confirmed hit; optional kill sound.
- Hit messages to attacker and victim with zone and damage %.
- **Server-confirmed** hit markers. No client-predicted hit markers on players. Client-predicted tracers, muzzle flash and impact decals on world are fine.

**HUD**
- Victim HUD: wound figure showing hit zones, bleeding blink, blackout pulse.
- Health/stamina bar with used-stamina and lost-health segments.
- Ammo display: rounds in mag + spare mags.
- Fire-mode indicator, zoom level, item toggles.

## 12. Data schema (`content/weapons/<id>.json`)

```jsonc
{
  "id": "rifle_ar",
  "slotClass": "primary",            // primary | secondary | sidearm | grenade | melee
  "fireModes": ["semi", "burst", "auto"],
  "rpm": { "auto": 490, "burst": 490, "semi": 490 },
  "burst": { "count": 3, "intervalAfter": 0.20 },
  "magazine": 30, "spareMags": 2, "spareMagsExtraAmmo": 4,
  "reload": { "type": "magazine", "seconds": 2.35 },  // or { "type": "shell", "perShell": 0.5, "start": 0.3 }
  "damage": "rifle_ar",              // row in content/weapons/damage.json (FACT table)
  "pellets": 1,
  "accuracy": { "spreadBase": 0.3, "spreadPerShot": 0.22, "spreadMax": 3.0, "spreadRecovery": 6,
                "recoilPitch": 0.45, "recoilRecovery": 8, "movePenalty": 0.15, "airPenalty": 0.3,
                "laserMul": 0.7, "burstMul": 0.85 },
  "scope": null,                     // or { "levels": [4,6,8], "zoomInDelay": 0.15, "unscopedSpread": 10, "unscopeOnHit": true }
  "attachments": ["laser", "suppressor"],
  "labels": { "rpm": "INFERRED", "reload": "FACT-wiki", "accuracy": "ESTIMATE" }
}
```

Names come from `content/names/weapons.json` (`{ "rifle_ar": { "name": "TBD", "typeTag": "Rifle" } }`).

## 13. Balance tests (`pnpm test:balance`) and report

| ID | Test |
|---|---|
| BAL-01 | `damage.json` equals the §4 table exactly (golden). |
| BAL-02 | Helmet/vest column substitution; knife bleeds through armor; vest hits don't bleed. |
| BAL-03 | Torso-over-arms priority; groin/butt by shot direction; no penetration. |
| BAL-04 | HTK matrix generated from data equals the §5 table. |
| BAL-05 | Loadout legality matrix (all combos, Negev rule, minimum gear). |
| BAL-06 | Reload discards remaining rounds; shell reload is incremental and cancellable; SPAS blocked while bandaging. |
| BAL-07 | Spread determinism: client and server produce identical shot vectors for 10k shots. |
| BAL-08 | Snipers: unscope on hit, uncancellable bolt, no auto re-scope, zoom-in delay, movement voids scoped accuracy. |
| BAL-09 | Hyper-burst miss lockout. |
| BAL-10 | Medic caps 90/50, no self-heal, stacking healers, heal clears bleeding. |
| BAL-11 | Bleed rate 5 HP/s; leg-wound limp; bandage clears limp and broken legs. |

`pnpm balance-report` writes `reports/balance.md`: HTK per zone and armor state, TTK at v1 RPM, DPS, and damage-per-magazine. Diff it in PRs.

## 14. Open questions
1. Exact RPM/reload/spread numbers: capture per `docs/02` §13, then update §6/§7 labels.
2. Benelli pellet model.
3. Grenade radius/falloff.
4. Bleed stacking.
5. Heal rates.
6. Do bullets lose damage over distance in 4.3? (v1: no.)
