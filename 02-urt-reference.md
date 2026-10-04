# 02 — Urban Terror Reference (research compendium)

> Purpose: everything we learned about the original game, in our own words, so Claude Code never has to guess where a rule came from. This is **reference**, not the spec. The specs are `docs/03` (movement), `docs/04` (combat) and `docs/05` (netcode).

## 0. Confidence labels (used across all docs)

| Label | Meaning |
|---|---|
| **FACT** | Documented by an official source or a well-established community reference (sources in §14). |
| **INFERRED** | Derived from facts or community measurements with reasoning shown. |
| **ESTIMATE** | Our starting value where the original is unknown. Tune by feel or reference capture (§13). |

UrT's game code was **closed source** (only the engine was GPL). Exact physics constants were never published, so many movement values are INFERRED/ESTIMATE by necessity.

## 1. Snapshot and timeline

- **1998:** started as a planned Quake III Arena map pack with real-world locations. Grew into a total conversion with realistic weapons, in the spirit of Action Quake 2.
- **Aug 2000:** Beta 1.0 debuts at QuakeCon 2000 (team: Silicon Ice Development).
- **2006:** the team renames itself FrozenSand.
- **Apr 2007:** 4.0 ships as a free **standalone game on ioquake3** (Q3 engine fork). It introduces power sliding, new weapons and player models, and improved hit detection.
- **Dec 2007:** 4.1.
- **Aug 2012:** 4.2 public beta. New hit locations and hit mesh, reworked player animations, Last Man Standing, Jump mode, auth system, updater.
- **Oct 2016:** 4.3 "Still Dying", announced as the last version on the Q3 engine.
  - New weapons: Benelli, FR-F1, P90, .44 Magnum.
  - Gun Game mode and an Instagib modifier.
  - Groin/butt damage rebalance.
- **Jun 2018:** 4.3.4, the final Q3-engine release.
- **Successor:** "HD" started in 2009, then moved to Unreal Engine 4 ("Resurgence") because of id Tech 3 licensing issues. It is now a full rewrite on **Unreal Engine 5**. The stated goal is to keep the 4.3 movement and feel. As of late 2025 it was still in internal QA builds.
- **Branding:** billed as a "Hollywood tactical shooter"; site tagline "Fun Over Realism". It blends Quake III Arena, Unreal Tournament and Counter-Strike.

## 2. Design DNA (the rules that made it UrT)

- **Realism lives in damage and loadout.** Kills take 1–3 shots and hit zones matter, yet movement is unrestricted. Arena speed with tactical lethality.
- **Weapons are hitscan** except knife, thrown grenades and launcher grenades. No bullet drop, no penetration (except breakables), no ricochets, no jams.
- **No iron sights**; crosshair only. Scoped weapons have scopes.
- **No classes, perks or unlocks.** Choose anything within slot limits. Pick up weapons and items from bodies.
- **Gear timing:** once you've moved or fired, gear changes wait until your next respawn. You can select gear while dead or spectating.
- **Reloading discards** the remaining rounds in the current magazine; there is no auto-reload. The shotgun is the exception, with shell-by-shell reloads.
- **Loadout slots:** 1 primary, 1 secondary, 1 sidearm, 1 grenade slot, 3 item slots, but **never all at once**. Legal combos:
  - 2 weapons + sidearm + grenades + 1 item
  - 2 weapons + sidearm + 2 items
  - 1 weapon + sidearm + 3 items
  - 1 weapon + sidearm + grenades + 2 items

  Minimum gear: primary (or a secondary in the primary slot), sidearm, and one item. Secondaries may sit in the primary slot, not vice versa.
- **The Negev (LMG) cannot be combined with a secondary.**
- **Recommended max:** 16 players per server (developer guidance).

## 3. Movement (all FACT unless labeled)

### 3.1 Base physics
- UrT kept Quake III's movement speeds and **circle jumping**, so skilled players cross maps extremely fast.
- **Straight-line bunny hopping gains nothing.** Speed comes from steering in the air (air has no friction).
- Because UrT has **sprint**, circle jumping is much stronger than classic strafe jumping. Technique: sprint for initial speed, keep jumping with sprint held, sweep the mouse smoothly left/right. Turning more than 90° carries you around corners.
- Community speed measurements (4.x era, ups = units/second):

  | Technique | Speed |
  |---|---|
  | forward + jump + turn | ~350 |
  | forward + sprint + turn (ground) | ~368 |
  | forward + sprint + small turns + jump | ~428 |
  | forward + sprint + large turning arc + jump | ~555 |

- **Speed trail:** above 600 ups a team-colored trail appears behind the player.
- **Units:** 1 Quake unit = 1 inch in UrT.

### 3.2 Sprint and stamina
- Sprint is a held modifier on top of forward, noticeably faster than running. It drains stamina and is the main way to build speed for jumps and slides.
- Sprint is **forward-only**: no sprinting sideways or backwards, and none while swimming.
- **Stamina costs:** sprinting, jumping and crouching down (not standing up). Walking, running, climbing and swimming are free.
  - Sliding also drains (wiki). Wall jumps cost stamina (they are jumps).
- **Regeneration:** fastest when standing still; slow while moving. **No regen in water.** Crouching does *not* speed up regen (common myth).
- **Stamina equals health.** Wounded players have less stamina, hence less sprint time and lower practical top speed.
- **Kevlar vest halves stamina.** There is no weight system; other gear does not affect stamina. (The Negev affected stamina in the 3.x era only.)
- Health does **not** directly slow you, except an **unbandaged leg wound**. In 4.2+, only lower-leg and foot hits cause a limp.

### 3.3 Wall jumping
- Added in 3.5 as an offshoot of the "boot" (kicking players by jumping into them).
- Jump into a wall you're running/sprinting at and you rebound off it.
- **Uses:** scale obstacles faster than climbing, gain height to reach otherwise-too-high ledges, gain speed by kicking a wall sideways, and break a descent from heights (tricky).
- **Limit:** 3 wall jumps in a row before touching a horizontal surface. Jump-mode servers could change this (cvar `g_walljumps`).
- Not off short ledges and not off other players.
- Jumpers experimented with kick angles (including back-first) to squeeze out more speed.
- The exact impulse math is **unknown** (closed code). See `docs/03` §5.3 for our reconstruction.

### 3.4 Power slide (added in 4.0)
- Build speed with sprint or strafe jumps, then press crouch while still airborne just before landing. You land crouched and slide, keeping speed.
- **Once sliding, your facing doesn't matter**, so you can aim anywhere (shoot while sliding).
- Works even with broken legs; used to clear gaps, squeeze through doors/tunnels and burst out from corners.

### 3.5 Ledge grab and climb (since the first beta)
- Jump at any reachable edge **holding forward**. Keep holding and you pull yourself up. (The manual mentions holding jump; community guides say forward. Support both.)
- **Grabbing anything mid-fall stops you instantly with zero fall damage.** Makes a distinctive sound.
- If the ledge is out of reach you fall and may injure yourself.

### 3.6 Other movement facts
- **Goomba stomp (4.0):** falling from a height that would hurt you (break legs or kill) and landing on someone's head kills them instantly.
- **Boot (kick):** requires holding knife, pistol or grenade. Always counts as a body hit, **20 damage**. Used to shove teammates out of doorways (needs friendly fire on).
- **Ladders:** you stick when touching while facing the ladder. Forward always = up, back = down, regardless of view pitch. Turning too far away drops you. No sliding down; you can drop and re-grab at the last moment without injury.
- **Swimming:** jump/crouch control ascent/descent, so you can strafe and aim like on ground.
  - **16 s of breath**, refilled instantly on surfacing.
  - Drowning kills **8 s** after it starts.
- **Fall damage** can break legs (limp until bandaged). The exact thresholds are unknown.
- **Order quirks:** bandage → reload → climb can overlap if started in that order.
- **Doors:** "use" opens/closes; you can close a door behind you at full speed.

## 4. Health, damage, bleeding, healing (FACT)

- **100 HP.** Damage depends on the body zone hit. Players can survive several hits.
- **Hit zones (4.2+):** head, torso, arms, groin, butt, upper leg, lower leg, foot. Armor variants: **helmet** (head) and **vest** (torso).
  - The 4.2 hit mesh was a low-poly copy of the player model, so "legs" start at the belt line.
  - **Torso has priority over arms** in hit detection.
- **Bleeding:** every wound bleeds **except hits on the vest or helmet**. Knife hits bleed even through armor.
  - Rate: **about 5% HP per second**.
  - While bleeding you leave a blood trail and make noise periodically, the view gets a red blackout pulse, and aim jerks.
- **Bandage:** anyone can bandage themselves or others, enemies included. It only **stops bleeding** and **fixes legs broken by falls**; it does not heal.
  - Historical datapoint: bandaging took 3.5 s in beta 1.1.
- **Medkit:** a carrier can heal **others** up to **90%**. Without a medkit on either side the cap is **50%**. If only the patient carries one, healing is slower.
  - You cannot heal yourself.
  - The kit never depletes.
  - Several healers stack.
- **Vest:** reduces damage from every weapon except the SR-8. Vest hits don't bleed (except knife). Halves stamina.
- **Helmet:** only snipers can one-shot your head. No stamina cost.
- **HUD:** health/stamina bar (gray segments for used stamina, dark red for lost health). A body figure shows wound locations. Health blinks while bleeding.

## 5. Weapons

### 5.1 Roster (4.3) with roles (FACT, paraphrased)

| UrT name | Class / slot | Role notes |
|---|---|---|
| Knife | melee (all) | Slash or throw (same damage). 5 knives; can't throw the last one (4.2+). Thrown knife flies flat, slightly rising, range < 600 u. Not an instakill; fast slashes. |
| Beretta 92 | sidearm | Weak but very accurate, no recoil even when spammed, fast reload. |
| Glock | sidearm | Middle ground between Beretta and Deagle. Semi/burst. |
| Colt 1911 | sidearm | Low recoil, good damage; popular. |
| Desert Eagle | sidearm | Heavy hitter; the only non-sniper that can "blow heads off". |
| .44 Magnum | sidearm (4.3) | Devastating but slow. |
| MP5K | secondary | Very high fire rate, mediocre accuracy. Can't one-shot heads. |
| MAC-11 | secondary | Fastest fire rate, weakest damage, high recoil and spread; close range only. |
| P90 | secondary (4.3) | Secondary alternative. Toned down after testing (less damage, more accuracy). |
| UMP45 | secondary | Rifle-like damage. Unique **"spam" hyper-burst** mode (much faster than auto, short lockout if you miss). |
| SPAS-12 | secondary | Pellet cone, each pellet traced separately. Random damage, poor at range. **Shell-by-shell reload** (cancellable); can't reload while bandaging. |
| Benelli M4 | primary or secondary (4.3) | Faster semi-auto shotgun with different pellet mechanics (details unknown). |
| HK69 | primary | 40 mm launcher. Grenades **don't explode on contact**. Short/long range modes. 1 + 3 rounds. |
| LR300 | primary | **The** competitive rifle: high fire rate, controllable recoil. |
| M4 | primary | Mechanically a twin of the LR300. |
| G36 | primary | LR damage + scope, but slow (AK-like) fire rate. Favored by CTF defenders. |
| AK-103 | primary | Higher damage, slower fire, high recoil and spread kicking in almost immediately. |
| Negev | primary (no secondary) | Low damage, low recoil, very high spread that builds slowly. 90-round belt, very long belt change. |
| PSG-1 | primary (sniper) | Semi-auto; can empty the mag scoped; lighter movement penalty than SR-8. Torso hit ≈ bleed-out. Scope 2/4/6×. |
| FR-F1 | primary (sniper, 4.3) | For fast, sharp long-range shooters. |
| SR-8 | primary (sniper) | Bolt action, ignores armor. Long, **uncancellable** bolt cycle. **Unscopes when you're hit** (4.1+). No auto re-scope after the bolt (since 2.6a). Scope 4/6/8×. Heavy movement penalty. |
| HE grenade | grenade | Damage by distance from the explosion. Cooking can be cancelled by switching weapons (accepted quirk). |
| Smoke grenade | grenade | Vision blocker. |

### 5.2 Damage table, UrT 4.3 (FACT: % of 100 HP per hit)

Values as posted by an official forum moderator (2019). Shotgun values are point-blank. HK69 = direct impact only; explosions vary with distance.

| Weapon | Head | Helmet | Torso | Vest | Arms | Groin | Butt | U.leg | L.leg | Foot |
|---|---|---|---|---|---|---|---|---|---|---|
| Knife | 100 | 60 | 44 | 35 | 20 | 40 | 37 | 20 | 18 | 15 |
| Beretta | 100 | 40 | 33 | 22 | 13 | 24 | 22 | 15 | 13 | 11 |
| Desert Eagle | 100 | 66 | 57 | 38 | 22 | 42 | 40 | 28 | 22 | 18 |
| SPAS-12* | 100 | 80 | 80 | 40 | 32 | 59 | 59 | 40 | 40 | 40 |
| MP5K | 50 | 34 | 30 | 20 | 11 | 22 | 20 | 15 | 13 | 11 |
| UMP45 | 100 | 51 | 44 | 29 | 17 | 31 | 28 | 21 | 17 | 14 |
| HK69 (impact) | 20 | 20 | 20 | 20 | 20 | 20 | 20 | 20 | 20 | 20 |
| LR300 | 100 | 51 | 44 | 29 | 17 | 31 | 28 | 20 | 17 | 14 |
| G36 | 100 | 51 | 44 | 29 | 17 | 31 | 28 | 20 | 17 | 14 |
| PSG-1 | 100 | 100 | 97 | 63 | 36 | 75 | 70 | 41 | 36 | 29 |
| SR-8 | 100 | 100 | 100 | 100 | 50 | 100 | 97 | 60 | 50 | 40 |
| AK-103 | 100 | 58 | 51 | 34 | 19 | 36 | 33 | 22 | 19 | 15 |
| Negev | 50 | 34 | 30 | 20 | 11 | 23 | 21 | 13 | 11 | 9 |
| M4 | 100 | 51 | 44 | 29 | 17 | 31 | 28 | 20 | 17 | 14 |
| Glock | 100 | 45 | 35 | 29 | 15 | 29 | 27 | 20 | 15 | 11 |
| Colt 1911 | 100 | 60 | 40 | 30 | 15 | 32 | 29 | 22 | 15 | 11 |
| MAC-11 | 50 | 29 | 20 | 16 | 13 | 16 | 15 | 15 | 13 | 11 |
| FR-F1 | 100 | 100 | 90 | 75 | 40 | 75 | 74 | 50 | 40 | 30 |
| Benelli* | 100 | 100 | 90 | 67 | 32 | 60 | 50 | 35 | 30 | 20 |
| P90 | 50 | 40 | 33 | 27 | 16 | 27 | 25 | 17 | 15 | 12 |
| .44 Magnum | 100 | 82 | 66 | 59 | 33 | 57 | 52 | 40 | 33 | 25 |

\* point-blank. HE and smoke grenades: 0 direct. Kick ("boot"): 20 (always body).

> Historical note: 4.2 had different groin/butt values (and a Glock head value of 60). 4.3 revised groin/butt and buffed Beretta/Glock/Colt/SPAS. We use **4.3**.

### 5.3 Magazines and fire modes (FACT, 4.2-era guide; 4.3 newcomers marked)

"30 × 3" = one 30-round magazine loaded + 2 spare. **Extra ammo** item → ×5 (×3 for Negev, ×7 for snipers).

| Weapon | Ammo | Modes | Attachments |
|---|---|---|---|
| Knife | 5 knives | slash / throw | – |
| Beretta | 15 × 3 | semi | laser, silencer |
| Glock | 12 × 3 | semi, burst | laser, silencer |
| Colt 1911 | 10 × 3 | semi | laser, silencer |
| Desert Eagle | 7 × 3 | semi | laser |
| .44 Magnum (4.3) | unknown (6-round revolver assumed) | semi | ? |
| SPAS-12 | 8 + 24 shells (4.2) | semi, shell-by-shell reload | – |
| Benelli (4.3) | 8 + 24 (wiki) | semi | ? |
| MAC-11 | 32 × 3 | auto | silencer |
| MP5K | 30 × 3 | burst, auto | laser, silencer |
| UMP45 | 30 × 3 | spam (hyper-burst), auto | laser, silencer |
| P90 (4.3) | unknown (50 assumed) | auto | laser (pre-release info) |
| HK69 | 1 + 3 | short / long range | – |
| LR300 / M4 | 30 × 3 | semi, burst, auto | laser, silencer |
| AK-103 | 30 × 3 | semi, burst, auto | laser, silencer |
| G36 | 30 × 3 | semi, burst, auto (scoped) | silencer |
| Negev | 90 × 2 | auto | silencer |
| PSG-1 | 8 × 4 | semi | silencer |
| FR-F1 (4.3) | unknown | bolt | ? |
| SR-8 | 5 × 4 | bolt | – |

**Burst** = auto limited to 3 rounds per trigger pull, with slightly tighter spread (except the UMP's special mode).

### 5.4 Fire rate and reload datapoints (versions differ; verify via §13)

| Weapon | Source A: wiki infobox | Source B: forum stopwatch test (4.x) |
|---|---|---|
| LR300 / M4 | 415 RPM, reload 2.35 s | ~493 RPM (30 rds in 3.65 s) |
| AK-103 | 282 RPM, reload 4.28 s | ~423 RPM (30 rds in 4.25 s) |
| G36 | – | ~435 RPM |
| MP5K | 497 RPM, reload 2.6 s | ~600 RPM (30 rds in 3.0 s) |
| Negev | – | ~600 RPM |
| UMP45 | 349 RPM, reload 2.8 s | – |

Source B agrees with the qualitative guides: G36 ≈ AK in fire rate, LR fastest of the rifles, MP5/Mac fastest overall. Our v1 baseline leans on B, with all values flagged ESTIMATE until captured (see `docs/04` §6).

### 5.5 Accuracy model (FACT, qualitative)
- **Base accuracy:** how far the *first* shot can deviate.
- **Spread:** random deviation that grows the more you fire. This is the main source of weapon personality.
- **Recoil:** linear upward drift of the aim point while firing; temporary, recovers after you stop.
- **Recovery:** each weapon has its own cooldown back to base.
- **Movement:**
  - Scoped weapons (and snipers) get a huge penalty for walking, running, jumping, sliding or being airborne/in water.
  - Other weapons' movement penalty is negligible.
  - **Crouching gives no accuracy bonus.**
- **Snipers:** 100% accurate scoped, wildly inaccurate unscoped. A small delay after zooming in prevents instant full accuracy (anti-script).
- **Laser** tightens grouping but its dot is visible to enemies. The **silencer** removes muzzle flash and lowers sound, with no damage or spread change.

## 6. Items (FACT)
- **Vest, helmet, medkit:** see §4.
- **Tactical goggles (NVG):** highlight players with brackets. Since 4.0 there is no friend/foe coloring; you identify by aiming (crosshair/name). Most useful in heavy smoke. Repeatedly re-balanced through history.
- **Laser, silencer:** see §5.5. Both can be used together where supported.
- **Extra ammo:** more spare magazines. Mostly useful for the launcher. Cannot be dropped.
- **Bomb:** mode item. Grenades drop on death; other items can be dropped deliberately.

## 7. Game modes (FACT)
- **FFA**
- **Last Man Standing**
- **TDM**
- **Team Survivor (TS):** round-based; the main competitive mode.
- **Follow the Leader**
- **Capture & Hold**
- **CTF:** the other competitive staple. A "hot potato" timer explodes both flags during standoffs; the EU competitive scene used wave respawns.
- **Bomb:** Counter-Strike-like.
- **Jump:** timers, save/load positions, ghosting, configurable stamina and wall-jump limit.
- **Freeze Tag**
- **Gun Game (4.3)**
- **Instagib** modifier (4.3)
- A strong **jump-map sub-community** grew around the movement.

## 8. Networking facts
- Classic Q3 architecture: client prediction using the **same movement code compiled into client and server**.
  - The server sends snapshots; clients could request a snapshot rate (default 20).
  - Movement physics ran per client command, so it depended on client frame rate. At 125 fps, velocity rounding let players jump slightly higher. Mods later fixed this by forcing physics into exact 8 ms steps.
- UrT 4.3.0 unlocked the server frame rate (`sv_fps`, 20–125, default 60). **4.3.2 locked it back to 20.**
- 4.2 rebuilt hit detection along with new animations.
- The in-game **lagometer** showed ping, ping variance and packet loss. The HUD showed hit/kill messages to attacker and victim, and a default hit sound ("plink").

## 9. Engine, rendering and lighting (FACT)
- **Engine:** id Tech 3 via ioquake3. The official 4.x client was a 2007-era ioquake3 fork with minor changes and **no advanced rendering features** (fixed-function OpenGL 1.x renderer). Community builds added bump mapping, and later the ioquake3 OpenGL2 renderer.
- **World rendering:** BSP + PVS + lightmaps.
  - A visibility pass precomputes what each area can see.
  - A light compiler bakes lighting into lightmap textures stored in the map file.
  - At runtime each surface's texture is multiplied by its lightmap.
- **Shader scripts:** multi-pass materials on the fixed pipeline. Vertex deforms, scrolling, blending, env-mapped "shine". They also define gameplay properties (water volumes, emitted light, footstep sounds).
- **Lighting:**
  - Fully baked, with no real-time lights or shadows ("dynamic" lights faked with shader tricks).
  - Lightmap sample every **16 u**, packed in **128×128 pages**, giving soft, low-frequency shadows. Optional radiosity bounces.
  - **Moving models** are lit from a precomputed **light grid**: they pick up local color and brightness but don't really cast or receive shadows.
- **Overbright:** standard settings `r_overBrightBits 1`, `r_mapOverBrightBits 2`. The engine used the hardware gamma ramp for a 0–2 brightness range, giving the punchy, contrasty Q3 look. Ports that lose it look flat/dark.
- **Models:** MD3 vertex animation. Players are split into head/upper/lower meshes joined by tags, driven by an animation config.

## 10. Art direction and presentation (FACT + light interpretation)

**Settings.** Grounded real-world locales:
- Abbey (urban/religious), Algiers (city), Austria (European village), Casa (Spanish city), Kingdom (castle)
- Mandolin (desert city), Prague (city), Riyadh (desert), Tombs (Egyptian ruins), Thingley (English city)
- Ramelle (bombed city), Toxic (factory), Subway (transport), Swim (indoor pool)
- Turnpike / Uptown (city), and more. 4.3 added Mykonos and Paris.
- Some maps had weather.

*Interpretation:* lots of sunlit Mediterranean, desert and European-town spaces. Chunky brushwork, with detail carried by textures and baked light.

**Characters** were read mainly by color.
- Team skins plus alternate skin sets: green, desert, cowboy, cavalry, droogs, Dr. Pink, etc.
- Personal color on arm/leg bands and minimap arrows.
- Optional cosmetic "funstuff" (hats, goggles, masks).

**"Hollywood" tone.** Ejection port on the left so brass flies across your screen (an Action Quake 2 habit).
- Adjustable FOV and gun size.
- HUD modernized in 4.2.021 (Roboto font).
- Minimap with teammate arrows.
- Kill feed, hit messages, wound figure, speed trail.

## 11. Lessons for us (interpretation)
- **Movement is the identity.** Even the official remake lists it as the thing to preserve.
- **Damage + bleeding are one system.** Several weapons stop just short of a kill (e.g., 3 Beretta torso hits = 99), and bleeding finishes the job unless the victim bandages.
- **Armor is a mobility trade-off** (vest halves stamina). Competitive players dropped the vest when low on HP.
- **20 Hz was the original server rate.** Modern expectations are higher; we use 60 Hz (see `docs/05` §1).
- The Q3 look came from **baked light + overbright**. Our art will differ, but readable lighting and silhouettes still matter.

## 12. IP and legal notes (not legal advice)
- "Urban Terror" and "FrozenSand" are trademarks of Frozensand Games Limited. Their files may not be reused without permission. → **We use none of their files, code or names.**
- Quake III Arena's source is GPL v2 (released 2005). Porting its code would make our code GPL. → **Clean-room: implement from our specs only.**
- Real gun brand names carry trademark baggage. The community suspects trademark caution was part of why UrT once swapped the M4 for the LR300. → **Fictional names (O-2).**
- Observing the original game's behavior for reference is fine. **Do not decompile or reverse-engineer** its closed binaries/QVMs.

## 13. Reference capture protocol (how we turn ESTIMATEs into measured values)

UrT 4.3.4 is still freely downloadable. Run it locally (offline server) purely to **observe and measure behavior**. Do not copy files.

**Movement**
- Enable the in-game speedometer (4.2.021+ has one; find it via the options or `/cvarlist`).
- Record at 60 fps:
  - run, sprint, walk and crouch top speeds on flat ground
  - jump apex height against a known-height wall
  - wall-jump height gain per kick
  - slide distance from sprint speed
  - ledge-grab max reach (stack crates of known size)
  - stamina sprint duration from full, and empty → full regen time standing vs. moving
  - fall-damage vs. height (staircase of drops)
  - bandage time, heal rates

**Weapons**
- Time to empty a full magazine on auto (→ RPM).
- Reload time (button press → first shot).
- Bolt-cycle time (SR-8, FR-F1).
- Semi-auto max click rate (pistols).

**Workflow**
- Count frames in a video editor and log results in `docs/04` §6 and `docs/03` §7 with date and version.
- Jump mode helps here (timers, save/load positions, no damage).

## 14. Sources (accessed Oct 2026)

**General and history**
- Wikipedia, "Urban Terror": https://en.wikipedia.org/wiki/Urban_Terror
- Urban Terror wiki (fandom), Urban Terror / Version History / Standard Maps: https://urbanterror.fandom.com/wiki/Urban_Terror
- urbanterror.info (official): news "4.3 Still Dying" https://www.urbanterror.info/news/495-urban-terror-4-3-still-dying/ · manual https://www.urbanterror.info/support/109-/ · weapons https://www.urbanterror.info/support/119-weapons/
- ModDB 4.3 release: https://www.moddb.com/games/iourbanterror
- UrT 5 / Resurgence: https://urbanterror.fandom.com/wiki/Urban_Terror_5:_Resurgence · https://barbatos.fr/projects/urban-terror

**Community guides and data**
- DSWP wiki, beginner's guide: http://www.dswp.de/old/wiki/doku.php/tutorials:urban_terror:beginner
- DSWP wiki, weapons & equipment: http://www.dswp.de/old/wiki/doku.php/tutorials:urban_terror:weapons-and-equipment
- Forum, 4.3 damage table: https://www.urbanterror.info/forums/topic/35445-weapon-stats-listing/
- Forum, jump speeds: https://www.urbanterror.info/forums/topic/9278-jump-speeds-bugging-the-hell-out-of-me/
- Forum, assault rifle stats: https://www.urbanterror.info/forums/topic/13263-assault-rifle-stats/
- Wiki weapon pages (LR300, AK103, MP5K, UMP45): https://urbanterror.fandom.com/wiki/ZM_LR300

**Engine, rendering and physics**
- Fabien Sanglard, Quake 3 renderer review: https://fabiensanglard.net/quake3/renderer.php
- OpenArena wiki, frame-rate-dependent physics: https://openarena.fandom.com/wiki/Game_physics
- ETJump docs, pmove_fixed: https://etjump.readthedocs.io/en/latest/

**Tools and networking**
- TrenchBroom manual: https://trenchbroom.github.io/manual/latest/
- Tick-rate comparison (Edgegap): https://edgegap.com/blog/game-server-tick-rate-explained-gameplay-precision-vs-infrastructure-cost

## 15. Known unknowns (closed source; resolve via §13 or by feel)

**Movement**
- Run/sprint/walk/crouch speeds (sprint ≈ 365–368 inferred).
- Air acceleration tweaks vs. Q3.
- Wall-jump impulse vectors and detection distance.
- Slide friction and entry threshold.
- Ledge reach heights and climb speed.
- Stamina drain/regen rates and costs.
- Fall-damage thresholds.
- Whether holding jump auto-hops.

**Weapons**
- Exact RPM, reload, spread and recoil numbers.
- Pellet counts.
- Benelli mechanics.
- Magazine sizes of the 4.3 newcomers.
- Grenade radius and damage falloff.
- Heal rates.
