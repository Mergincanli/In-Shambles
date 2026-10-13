# M4 research: Urban Terror 4.x movement values

> **Status:** a research record, not a spec (2026-10-13). Cited as "M4 research §n". It is input for the M4 plan: nothing here changes a value or a label until Mustafa approves it there (golden rules 6, 7 and 9). Until then the code keeps the values in `docs/03`.
>
> **How it was made:** a web research run. Six researchers each took one topic: speeds, stamina, wall jumps and the kick, slide and ledge grab, damage and the environment, and cvars and the jump community. A verifier re-checked each topic's findings against the source page. A completeness round then searched for what was still missing, and a final pass wrote this synthesis. 244 findings passed verification and 43 were rejected (§6).
>
> **Clean room (golden rule 1):** only prose sources were read: manuals, changelogs, wikis, forums, community guides, and the text of issues on the FrozenSand issue tracker. The run also used recorded gameplay telemetry: per-frame positions, velocities, stamina and held keys that urtjumpmaps.com serves for recorded runs. That is observed behaviour. No source code of Urban Terror, ioquake3 or Quake III was opened, and no game files were downloaded. Every number taken from telemetry is INFERRED.


Built only from the findings that passed verification in this research run. Findings that failed verification appear in §6 as unconfirmed leads. The synthesis fetched nothing new; it relies on the verifiers' checks.

**What the synthesis read.** `docs/02` §3, §13, §14, §15 and `docs/03` §2.2, §5, §7, §10. It did not read `docs/03` §2.1 (base constants) or §8 (tests); the §2.1 values quoted under "our current" were checked against `docs/03` §2.1 when this record was filed, and they match.

**How to read this report**
- **Labels** follow our docs. FACT = stated by an official source or a well-established community reference. INFERRED = derived from facts or measurements with reasoning. ESTIMATE = our guess. When two verifiers gave the same quote different labels, I use the lower one.
- **Telemetry** means per-frame records served as JSON by the urtjumpmaps.com demo viewer: position, 2-D velocity, stamina, held keys and view height.
  - They are recorded runs on jump servers. The JSON does not state the game version; 4.3.x is assumed.
  - This is observed behaviour, not code, so it fits golden rule 1. Every value taken from it is INFERRED.
  - Caveats: jump-mode servers (no fall damage, vest usually removed, stamina options) and mostly expert players. UrT runs player physics in 8 ms frames and stores velocity as whole numbers.
- **Units:** u = Quake unit (1 inch); speeds in u/s. Stamina is in points on the 0–100 telemetry scale (full health, no vest).
- **Source keys** such as `T5`, `RM43` or `DEV32198` are listed with their URLs at the end.

## 1. Summary

1. `docs/03` has 39 ESTIMATE items: 26 cvars in §2.2/§5.2 and 13 rules or targets in §5. 2 are now stated by a source (slide entry "about 300"; the goomba attacker is unhurt). 22 are pinned by INFERRED values from telemetry or from arithmetic on the lead developer's 4.2.018 measurements. 10 are only bounded or described, some only by leads that failed verification. 5 have no public data: wall-jump reach and minimum wall height, ledge reach, fall-curve shape, boot cooldown.
2. The biggest correction is outside the ESTIMATE list: our Q3 base constants do not describe UrT 4.3. Run is ≈ 220 u/s (not 320), walk ≈ 111, crouch ≈ 100 (0.45 × run, not 0.25), friction ≈ 4 (not 6), and ground acceleration is much softer. Effective gravity is ≈ 750, which gives a 48.5 u apex and 0.72 s airtime from the same 270 u/s take-off.
3. Sprint tops out at 329–340 u/s (not 365) and engages only with forward and no strafe key. Jumps and wall kicks cost 6 stamina each. On the ground, stamina regenerates at ≈ 20 − 0.076 × speed points/s; in the air it is frozen. Below ≈ 25 points, run and sprint slow toward 75 %, and a jump at 0 is weak.
4. A wall kick sets vz to 270 and adds ≈ 200 u/s along the wall normal, whatever the view. A slide loses a constant ≈ 125 u/s² and ends at ≈ 300 u/s (≈ 150 u from sprint speed). Ledges are grabbed only ≈ 58–66 u above the feet and climbed at 70 u/s. Falls hurt from a 200 u drop and kill from 394 u.
5. Most of the new numbers come from third-party jump-server telemetry. A short local 4.3.4 capture should confirm the base speeds and the low-stamina penalty before we retune. Only a capture can settle vest and health scaling, the fall-damage curve, boot knockback and the wall and ledge probe distances.

## 2. Findings by mechanic

"Our current" is what our docs say today. "Agrees?" is yes, no, partly, or new (we have nothing yet).

### 2.1 Speeds and jumping

| Quantity | Value found | Version | Label | Source | Our current | Agrees? |
|---|---|---|---|---|---|---|
| Run speed on flat ground, any direction | 220 u/s plateau, the same forward, back, strafe and diagonal; 221–225 only while turning; a few unexplained plateaus at 201–213 | 4.3.x | INFERRED | T1, T2, 5 more demos | 320 (§7; §2.1 `pm_runSpeed`) | No |
| 4.1 speedometer test (one player) | forward 207, forward+strafe 202, strafe 219, walk 110, crouch 99, forward+sprint 329, forward+sprint+jump 340 | 4.1 (Apr 2008) | INFERRED | F9278 #8 | 320 / 160 / 80 | No |
| Walk speed | 111–112 u/s (≈ 0.505 × run) | 4.3.x | INFERRED | T2 | 160 (walk scale 0.5 × 320) | Scale yes, value no |
| Crouch-walk speed | 99–100 u/s (≈ 0.45 × run), also with sprint held and at low stamina | 4.3.x | INFERRED | T2, T4 | 80 (duck scale 0.25 × 320) | No |
| Crouch-walk vs walk | "about 10% slower than normal walking"; silent like walking | undated wiki | FACT (approximate) | MOV | 50 % slower | No |
| Sprint top speed | 329 when accelerating from below (328–330); ≈ 340 (339–342) when slowing from a higher speed | 4.3.x; the 4.1 test agrees | INFERRED | T3, F9278 | 365 (INFERRED from "~368") | No |
| The "~368 sprint + turn" figure | a ground-turning overshoot above the sprint cap, not the sprint speed | 4.1 | INFERRED | F9278, T3 | used as the sprint speed | No |
| Sprint with a strafe key held | does not engage: ≈ 220 on the ground (≤ 230 while turning), and air gain matches a 220 wish speed. 4.1: "when you start Strafing ... Sprint goes off" | 4.3.x, 4.1 | INFERRED | T2, F9278 | sprints while forward is dominant | No |
| Sprint while walking | "Sprinting no longer works when walking" | Beta 2.1 | FACT | RM42 | not a §5.1 condition | No (missing) |
| "Oldschool" sprint | forward + left + right (AWD) also sprints, but only with the default move binds | 4.1/4.2 | FACT | DSWP | absent | New |
| Ground friction | ≈ 4 /s (× 0.968 per 8 ms frame); below ≈ 100 u/s a constant 375 u/s²; 220 → 0 takes ≈ 0.46 s (derived) | 4.3.x | INFERRED | T6 | friction 6, stop speed 100 | Friction no, stop speed yes |
| Ground acceleration | run from rest: 100 u/s at ≈ 168 ms, 150 at 264, 200 at 408, 219 at 488; sprint from rest +8 u/s per 8 ms frame (≈ 1000 u/s²) | 4.3.x | INFERRED | T2 + pooled demos | accelerate 10 (220 in ≈ 0.13 s) | No |
| Air acceleration | ≈ 1 × wish speed: forward+sprint ≈ 3 u/s per frame (≈ 317 u/s²), strafe keys ≈ 2 u/s per frame | 4.3.x | INFERRED | T11 | air accelerate 1 | Yes |
| Jump | take-off 270 u/s; effective gravity ≈ 750 u/s² (whole-number velocities every 8 ms); apex 48.53 u (exactly, in 36 of 42 jumps); airtime ≈ 0.72 s | 4.3.x | INFERRED | T5 | 270, gravity 800, apex 45.6 u, airtime 0.675 s | Partly |
| Jump-onto and step heights | "jump up" 66.5 u (= apex 48.5 + 18 step); "walk up" 18 u | 4.2.018 | FACT | DEV32198 | apex 45.6 + 18 = 63.6 | No |
| Jump height vs run speed | independent, except when jumping up a slope | 4.2.018 | FACT | DEV32198 | same | Yes |
| Gravity cvar | `g_gravity` default 800; "moon mode" servers use 300 or 100 | 4.2 cfg | FACT | CFG-SRV | 800 | Yes (as a cvar) |
| Frame-rate independence | `cg_physics` "jump same distances regardless of your fps" (3.0), locked in 4.2.001; every checked jump has the same apex | 3.0–4.3 | FACT (lines), INFERRED (4.x behaviour) | VH, RM42, T5 | fixed tick | Yes |
| Speed trail | team-coloured trail above 600 u/s; horizontal or 3-D speed not stated | 4.1/4.2 | FACT | DSWP | 600 (FACT) | Yes |
| Jump pressed just before landing | "il est possible d'appuyer sur la touche de saut un peu avant de toucher le sol" | 2011 tutorial | INFERRED (low) | SINON | `pm_autoHop` 0 | Open |
| `g_speed` | "the g_speed var now has no effect" since Beta 1.1, so base speed is not server-tunable (4.x inferred) | Beta 1.1 | INFERRED for 4.x | VH, RM42 | – | New |
| Sprint history | "Sprinting is faster now" in 4.0, so only 4.0+ data apply | 4.0 | FACT | RM42, RM43 | – | – |
| Top-speed anecdote | ≈ 900 u/s horizontal is typical; 1007 once, via an angled wall kick | 4.1 (2010) | INFERRED (low) | F22147 | – | Consistent |
| Overbounce and ice | a vertical overbounce exists (it needs specific fall heights and liquid depths); on "icy" surfaces, sprint plus a curving path builds speed without jumping | 4.2/4.3 | FACT | UJM-VOB, FR-TERMS | not specified | New |

### 2.2 Stamina

| Quantity | Value found | Version | Label | Source | Our current | Agrees? |
|---|---|---|---|---|---|---|
| Pool and maximum | stamina "is equal to your health"; "the more wounded you are, the less stamina you will have"; the telemetry field reads 0–100 at full health | 4.1/4.2 | FACT (DSWP), INFERRED (TUX) | DSWP, UTW, TUX | `staminaMax` = health (FACT) | Yes |
| Kevlar vest | "kevlar cuts stamina in half" and "severely affects the users stamina"; the helmet does not; the sources don't say whether the maximum or the drain changes | 4.2 | FACT (wording only) | CFG-JUMP, KEV, WP07 | × 0.5 on the maximum (FACT) | Partly |
| What costs stamina | sprinting, jumping (including strafe jumping), crouching down (not standing up), sliding; walking, running, climbing and swimming are free | 4.1/4.2 | FACT | MAN41, UTW, DSWP | same list | Yes |
| Ground jump cost | 6 points (396 of 399 clean take-offs) | 4.3.x | INFERRED | T5 | 5 | No |
| Wall-kick cost | 6 points (588 of 588 kicks) | 4.3.x | INFERRED | T10 | 8 | No |
| Moving while crouched | no drain; a drain here was a bug, fixed in 4.2.007 | 4.2.007 | FACT | RM42, RM43 | cost only on crouch-down | Yes |
| Idle regen | ≈ 20 /s (0 → 100 in ≈ 5 s); crouched idle is the same | 4.3.x | INFERRED | T6 | 18 /s; target 5–6 s | Close |
| Regen vs ground speed | ≈ 20 − 0.0764 × speed per s, any stance, without sprint or jump: ≈ 11.5 walking, ≈ 3.2 running, 0 near 260 u/s, ≈ −11 at 400 u/s | 4.3.x | INFERRED | T6 + pooled demos | 18 idle, 5 moving | No |
| Regen ordering | standing or crouching still beats running; crouching is not faster than standing | 4.1 manual, DSWP | FACT | MAN41, DSWP, UTW | same | Yes |
| In the air | frozen: no regen and no sprint drain (0.00 /s over ≈ 480 s of free flight) | 4.3.x | INFERRED | T5 | sprint drains in the air | No |
| While ledge-climbing | frozen (0 /s over 172 climb segments) | 4.3.x | INFERRED | T7 | "free" (regen not excluded) | Partly |
| In water | "your stamina won't refill while you're in the water" | 4.1/4.2 | FACT | DSWP | 0 at water level ≥ 2 | Yes |
| Sprint on a ladder | drained stamina until fixed in 4.3.0 (#188); the reporter saw no extra climb speed | 4.2–4.3 | FACT (fix), INFERRED (speed) | RM43, GH188 | drains whenever sprint is active | No |
| Low-stamina speed | below ≈ 25 points the run and sprint caps fall roughly linearly to ≈ 75 % at 0. Run is 165–168 at 0; sprint ≈ 311–318 at 16–20 points and ≈ 274 at 6–10; crouch is unaffected | 4.3.x | INFERRED | T4 + pooled demos | no penalty | No |
| Wiki wording at zero | "very slow and unable to jump to even the lowest/nearest platforms" | undated wiki | FACT (qualitative) | MOV | ground jumps at full strength | No |
| 3.x history | "running with low stamina doesnt slow you so much" | 3.5 | FACT | VH, RM42 | – | Supports the penalty |
| Jump at 0 stamina | weak: take-off ≈ 202 u/s (apex ≈ 27 u) and horizontal speed halved (161 → 81); take-offs at ≥ 8 points are normal; exact threshold not pinned | 4.3.x | INFERRED | T7 | full jump, cost clamps at 0 | No |
| Sprint at 0 | not available: forward+sprint runs at the penalised run speed (165–168) | 4.3.x | INFERRED | T4 | sprint unavailable | Yes |
| Version notes | drain "tweaked" in 4.2.004; regen frozen when paused (4.2.001); stamina reset when frozen in Freeze Tag (4.2.020) | 4.2.x | FACT | RM42, RM43 | – | – |
| Server stamina modes | `g_stamina` 0 = default, 1 = regain (refills when the player stops, after `/regainstamina`), 2 = infinite; changeable only in Jump mode | 4.2.013–014 | FACT (cvar), INFERRED (regain detail) | RM43, CFG-SRV, F31273 | none | New |
| Breathing sound | heavy breathing when tired; trigger threshold unknown | 3.5–4.2 | INFERRED | RM43, PL, MAN35 | – | New |
| Weaker claims | one guide: slides cost less than jumps for getting around. One comment: crouch spam never drops more than 1–1.5 bar segments. One review claims gear weight matters, which other sources contradict (no weight system) | 4.1/4.2 | INFERRED (low) | PL, DEDO, UTW | slide 6 > jump 5; crouch 2 | Unclear |

### 2.3 Wall jumps and the boot (kick)

| Quantity | Value found | Version | Label | Source | Our current | Agrees? |
|---|---|---|---|---|---|---|
| Consecutive kick limit | 3, then you fall; `g_walljumps` default 3, range 3–100, Jump mode only (added as `g_maxWallJumps` in 4.2.010, renamed in 4.2.013) | 3.7–4.3 | FACT | WJ, CVARS, CFG-SRV, RM42 | 3 (FACT) | Yes |
| Counter reset | on touching a horizontal surface | 4.1/4.2 | FACT | DSWP | on walkable ground | Yes |
| Kick while falling, without jumping first | allowed (4.1 behaviour restored in 4.2.015) | 4.2.015+ | FACT | VH, RM42, RM43 | "airborne" | Yes |
| Not off players or low ledges | 3.7 changelog; manual: "You cannot wall jump off short ledges or other gamers" | 3.7–4.x | FACT | VH, MAN | world only, two-height probe | Yes |
| Trigger | a fresh jump press (key up the frame before) in 601 of 601 kicks | 4.3.x | INFERRED | T10 | "jump newly pressed" | Yes |
| Vertical phase | only while descending (600 of 601) | 4.3.x | INFERRED (rule or habit) | T10 | not required | No (missing) |
| Vertical velocity | set to 270 whatever the incoming vz (−699 to −6) | 4.3.x | INFERRED | T10 | max(vz, 290) | No |
| Push along the wall normal | +198 to +200 u/s (quartiles 198 / 199 / 200) | 4.3.x | INFERRED | T10 | 140 | No |
| Velocity along the wall | unchanged | 4.3.x | INFERRED | T10 | unchanged | Yes |
| View yaw at contact | no effect on the push (facing the wall 198, side-on 199, facing away 200) | 4.3.x | INFERRED | T10 | ignored | Yes |
| Velocity into the wall | not cancelled before the push (−434 → −236, −400 → −202) | 4.3.x | INFERRED | T10, T5 | cancelled first (step 1) | No |
| Kick at low stamina | 6–10 points (5 too, in the finding's data): weak (vz 170, push ≈ 100); 11 mixed; ≥ 12 full; no kicks seen at 0–4 | 4.3.x | INFERRED | T2 + pooled demos | refused below 8 | No |
| Kick at the apex against the brush you're grabbing | lets you grab 4.125 u higher (114.625 → 118.750) | 4.2.018 | FACT | DEV32198 | – | Test case |
| Kick-angle advice | back to the wall = height, side = speed, look where you want to go, turn fast at contact | 2008–2013 | INFERRED | FR-WJ, F11680, F11673 | – | See §3, row 11 |
| Breaking a fall | a kick can sometimes get you down without injury, but it is tricky | 4.1/4.2 | INFERRED | DSWP, DSWP-DE | vz reset | Yes |
| Edge cases | on curved walls a kick sometimes turns into a grab; a kick right after a full pull-up stays crouched; mappers could make walls unjumpable (method unknown) | 4.1 | INFERRED | F22078, F9131, F21059 | undefined | New |
| Boot weapons | 3.5 knife only; 3.7 adds Beretta, DE and grenades; 4.2.001 also allows booting while holding the bomb; wiki: knife, grenade or sidearm | 3.5–4.2 | FACT | VH, BOOTS | knife, pistol, grenade | Yes (bomb is new) |
| Boot damage | 20 % of 100 HP (5 kicks kill); always a body hit | 4.x | FACT | BOOTS, DSWP | 20 to the body zone | Yes |
| Boot trigger | sprint at the player, jump, time the apex with the collision ("doesn't have to be exact") | 4.x | FACT | BOOTS | airborne or moving | Partly |
| Boot from the ground | 4.3.0 fixed booting "while holding the jump key despite being on the ground", so the kicker must be airborne | 4.3.0 | FACT (fix), INFERRED (rule) | VH, RM43 | "airborne or moving" | No |
| Boot knockback scale | `g_knockback` (default 1000) scales "weapons and booting" | 4.x | FACT | SRVCVAR, BOOTS | fixed 120 u/s | Partly |
| Boot knockback size | "a big boost" forward (one thread) | 4.1 | INFERRED (low) | F23425 | 120 u/s | Probably too small |
| Booting teammates | not possible with friendly fire off | 3.5–4.x | FACT | DSWP, VH | knockback-only shove allowed with FF off | No (deviation) |
| Mutual kicks | since 4.2, two players can kick each other at the same moment | 4.2+ | FACT | BOOTS | unspecified | New |
| Boot repeat | before 4.3, holding jump while running into an enemy booted them; once it booted twice without a re-press | 4.1/4.2 | INFERRED | F29481 | 0.5 s cooldown (ESTIMATE) | Open |

### 2.4 Power slide

| Quantity | Value found | Version | Label | Source | Our current | Agrees? |
|---|---|---|---|---|---|---|
| Entry input | build speed, press crouch while airborne before landing; you land crouched and slide | 4.x manual | FACT | MAN | same | Yes |
| Entry speed | "about 300" on the speedometer; a higher speed gives a "more effective" slide | 4.1-era manual | FACT (approximate) | MAN, MAN41 | 300 (ESTIMATE) | Yes |
| Slide regime | exists only above ≈ 300 u/s | 4.3.x | INFERRED | T9 | – | Yes |
| Deceleration | constant ≈ 1 u/s per 8 ms frame (≈ 125 u/s²) from 300 to ≈ 1000 u/s, with crouch, forward+sprint+crouch or strafe+crouch held; ≈ 1.4 per frame at 1000–1200 | 4.3.x | INFERRED | T8 | friction 0.8 (proportional to speed) | No |
| End of the slide | at ≈ 300 u/s; normal friction after that (≈ × 0.80 per 56 ms) | 4.3.x | INFERRED | T9 | 120 u/s | No |
| Distance from sprint speed | ≈ 150 u with only crouch held: ≈ 89 u of slide from 335, plus ≈ 62 u of friction stop. From 600 u/s the slide phase alone covers ≈ 1080 u | derived | INFERRED | T8, T9, T6 | 300–420 u from 365 | No |
| Distance vs entry speed | the more speed, the further | 2013 guide | FACT | FR-SLIDE | – | Yes |
| Jump out of a slide | keeps 100 % of horizontal speed; take-off 270 | 4.3.x | INFERRED | T7 | momentum carries | Yes |
| Steering (French guides) | strafe keys steer only together with the mouse; looking to one side curves the path; mouse plus all four keys change the trajectory | 2013 | INFERRED | FR-SLIDE, FR-TERMS, F35674 | almost none (`pm_slideSteer` 0.5) | Partly |
| Facing (DSWP) | "it doesn't really matter which way you are facing, so you can aim at the most likely threat direction" | 4.1/4.2 | INFERRED | DSWP | "ignores view direction (FACT)" | Label too strong |
| Slide stamina | sliding drains stamina; faster slides use less; holding sprint during the slide uses much less | 2008–2013 | INFERRED | FR-SLIDE, F11686 | 6 at slide start | No (model) |
| Slide at zero stamina | no extra speed loss | 4.1/4.2 | INFERRED | DSWP-DE | – | New |
| Broken legs | the slide still works | 4.1/4.2 | FACT | DSWP | limp ignored | Yes |
| Sticky air crouch | a crouch pressed during a jump stays on until landing | 3.5 (4.x not stated) | FACT | VH, RM43 | crouch must be held at landing | Open |
| Sound | silent; the developer "couldn't find a suitable sound effect" | 4.1 | FACT | F11686 | `slideStart` event | Note |
| Surfaces | "any solid object", including teammates' heads | 4.1 | INFERRED | F26086 | walkable ground | Yes |
| History | introduced in 4.0; a "power slide physics exploit" fixed in 4.1 (not described) | 4.0/4.1 | FACT | RM43 | – | – |

### 2.5 Ledge grab and climb

| Quantity | Value found | Version | Label | Source | Our current | Agrees? |
|---|---|---|---|---|---|---|
| Grab heights above the floor (standing jump) | min 60.375; max 114.625; 118.750 with a kick at the apex; ledges of 60.375–66.5 can be grabbed or jumped onto | 4.2.018 | FACT | DEV32198 | "ESTIMATE" (§7) | New |
| Grab window above the feet (derived) | ≈ 58–60 to ≈ 66 u. Max = 114.625 − 48.53 apex; min = 60.375 − ≈ 2 u first-frame rise | derived | INFERRED | DEV32198, T5 | 24–76 u | No |
| Openings and bounding box | minimum width 30.25, standing height 69.375, crouch height 48.25; box stated as 32 × 32 × 72 | 4.2.018 | FACT | DEV32198 | §2 hull (not reviewed) | – |
| Grab effect | a grab mid-fall stops you instantly with no damage; horizontal velocity is zeroed | 4.1/4.2; 4.3.x | FACT (DSWP), INFERRED (horizontal) | DSWP, T7 | vz = 0, no fall damage | Partly |
| Climb speed | constant 70 u/s after a ≈ 90 ms ramp (+6 u/s per 8 ms frame) | 4.3.x | INFERRED | T7 + 6 demos | 180 u/s | No |
| Pull-up | ≈ 59 u in ≈ 0.79 s, ending with a one-frame pop of ≈ 6.5–8.5 u onto the ledge; you arrive crouched | 4.3.x | INFERRED | T7, T10 | up to +1 u, then forward over 0.15 s | No |
| Stamina while climbing | frozen | 4.3.x | INFERRED | T7 | free | Partly |
| Input | manual: keep the jump key held; French glossary: press forward at the obstacle and keep holding it; rung climbing: forward only | 4.x | FACT (manual wording), INFERRED (guides) | MAN, FR-TERMS, F15676 | forward or jump | Yes (support both) |
| Release and re-grab | releasing forward drops you; you can re-grab "immediately", e.g. to shimmy: release, strafe, re-grab | 4.1/4.2 | INFERRED | F15676, F32317 | after 0.2 s or after touching ground | No |
| Grab while rising | an apex kick followed by a grab reaches higher, so you can grab while moving up | 4.2.018 | INFERRED | DEV32198 | open (Q4) | Answers Q4 |
| Crouched | you can't grab ledges or ladders while crouched | 4.1/4.2 | INFERRED | F32581, F15676 | not crouched | Yes |
| Rounded surfaces | can't be grabbed | 2013 glossary | INFERRED | FR-TERMS | walkable top probe | Yes |
| Rung pull-up | holding forward while pulling up on a rung you can't stand on makes you fall all the way down | 4.1 | INFERRED | F15676 | space probe | Yes |
| Other notes | 3.3 adjusted anti-warp "so you can ledgeclimb properly"; 4.2 grabbing differs from 4.1 (shown only in a video) | 3.3, 4.2 | FACT, INFERRED | RM43, GH9 | – | Net-test idea |

### 2.6 Fall damage, goomba, ladders, water

| Quantity | Value found | Version | Label | Source | Our current | Agrees? |
|---|---|---|---|---|---|---|
| First damage | from a walk-off drop of 200.125 u | 4.2.018 | FACT | DEV32198 | safe 560 u/s (≈ 196 u drop at gravity 800) | Yes |
| Lethal fall | walk-off drop of 394.125 u (full health assumed) | 4.2.018 | FACT | DEV32198 | 768 u lethal; 512 u ≈ 50 damage | No |
| Impact speeds at those heights | ≈ 548 and ≈ 769 u/s at effective gravity 750 (566 and 794 at 800) | derived | INFERRED | DEV32198, T5 | safe 560, lethal 1100 | Safe yes, lethal no |
| Broken legs | Beta 1.1: a fall doing ≥ 30 damage injures the legs (was 20). A 4.3 developer: the limp comes from lower-leg or foot hits, or "falling from high places, just not high enough to kill you" | Beta 1.1; 4.3 | FACT (1.1 rule; 4.3 wording) | RM42, F34762 | 850 u/s, above the lethal speed | No |
| Fall-damage height history | raised in Beta 2.1, no number | Beta 2.1 | FACT | RM42 | – | – |
| Limp | no sprint; leg wounds slow you "considerably" until bandaged; 3.5: "legshots dont slow you so much" | 3.5–4.3 | FACT (qualitative) | F34762, UTW, VH | × 0.6 and no sprint | Partly (no number) |
| Bandage | fixes legs broken by a fall | 4.1/4.2 | FACT | DSWP, DSWP-DE | yes | Yes |
| Legs vs HP | a defuse-on-landing bug skips the HP loss but still hurts the legs | 4.3 era | INFERRED | GH402 | separate flag | Yes |
| Bugs not to copy | being squeezed between misaligned solids causes fall damage; facing a wall with jump held can evade fall damage (works better at low fps) | 4.3 era | INFERRED | GH268, GH438 | analytic impact speed | Add tests |
| Crouch landing | one ambiguous tip only ("Crouch ou bien tombe dans l'eau") | 2009 | INFERRED (low) | FR-49403 | no effect | No evidence |
| Goomba trigger | landing on a head after a fall that would "severely injure or kill" you kills the victim instantly | 4.x | FACT | BOOTS | impact ≥ legs speed, head region | Yes |
| Goomba attacker | "be uninjured" | 4.x | FACT | BOOTS (+ DSWP-DE, F23425) | ESTIMATE (design choice) | Yes |
| Goomba weapon | works with any weapon or none | 4.x | FACT | BOOTS | not stated | New |
| Goomba on teammates | you can stomp a teammate; the friendly-fire rule is not stated | 4.1 manual | FACT | MAN41 | only with FF on | Open |
| Jump-mode damage | `g_nodamage` 1 (the Jump-mode default) stops deaths from falling and telefrags | 4.2 | FACT | CFG-SRV, FR-ADMIN | – | New |
| Ladder rules | you stick only while facing the ladder; forward = up and back = down whatever the view; turn too far and you fall off; no sliding down; drop and turn back at the last moment to stop unhurt | 4.x | FACT | DSWP | `docs/02` §3.6 | Yes |
| Ladder walk and crouch | walking on a ladder is "very slow" and silent (4.3.0); crouching does not slow climbing | 4.3.0 | FACT | GH424, RM43 | – | New |
| Ladder history | "Ladder speed increased" in Beta 1.2 (no number); mounting a ladder with a cooked grenade puts the pin back in (4.2.001) | 1.2, 4.2.001 | FACT | RM43 | – | – |
| Swimming | jump and crouch to rise and sink; no sprint; 16 s of breath, refilled at once on surfacing; drowning kills 8 s after it starts | 4.x | FACT | DSWP | `docs/02` §3.6 | Yes |
| Crouched swimming | possible only through a bug, so normally you are not crouched in water | 4.3 era | INFERRED | GH439 | – | New |

### 2.7 Capture tooling (feeds `docs/02` §13)

| Item | Value found | Version | Label | Source |
|---|---|---|---|---|
| Speedometer | `cg_speedo` 1 = u/s, 2 = km/h, 3 = mph (units added in 4.2.016); the cvar is already in the 4.1 default.cfg; it reads horizontal speed in whole units | 4.1–4.3 | FACT; INFERRED (4.1 presence, horizontal) | RM43, CVARS, CFG-DEF, UJM-VOB |
| Accelerometer | `cg_accelero` 1 colours the readout green while speeding up and red while slowing; 2 draws a graph | 4.2.016 | FACT | RM43, CVARS |
| Key overlay | `cg_drawKeys` 2 always shows the held movement keys | 4.3.0 | FACT | RM43 |
| Health percentage | `cg_drawhealth` | 4.2.021 | FACT | RM43 |
| Frame rate | client cap 125 fps since 4.0; `com_maxfps` defaults to 85 | 4.0+ | FACT | RM42, CFG-DEF |
| Server rate | `sv_fps` and snaps locked back to 20 in 4.3.2, so 20 Hz on 4.3.4 | 4.3.2 | FACT; INFERRED for 4.3.4 | RM43 |
| Jump mode | `g_gametype` 9 (4.2.006); `/ready` toggles the run timer; `/save` and `/load` (load also refills stamina and works while moving), `/regainstamina`, `/goto`; the shipped cfg calls them `/savePos` and `/loadPos` | 4.2–4.3 | FACT | RM42, JM, CHEATS, CFG-SRV |
| Jump-mode defaults | `g_stamina` 0, `g_nodamage` 1, `g_novest` 1 (cfg) or 0 (wiki), `g_walljumps` 3, `g_allowPosSaving` 0, `g_persistentPositions` 0 | 4.2–4.3 | FACT | CFG-SRV, CVARS |
| Save/load fixes | 4.3.3 fixed a wrong y-axis on load and loading another player's save | 4.3.3 | FACT | RM43 |
| Default binds | jump SPACE, crouch C, sprint E (`+button8`), walk SHIFT | 4.1–4.2 | FACT | CFG-DEF |
| Stamina meter | greys out segment by segment, so it is a coarse readout | 4.1/4.2 | FACT | DSWP |

## 3. Conflicts between sources and how to resolve them

| # | Conflict | Sources | Resolution |
|---|---|---|---|
| 1 | `docs/02` §3.1 says UrT "kept Quake III's movement speeds", but run is ≈ 220 (207 in a 4.1 test) and sprint 329–340 | docs/02, T1–T3, F9278 | The claim is wrong for ground speeds. It holds for air physics (air acceleration ≈ 1 × wish speed) and for circle jumping. Rewrite §3.1. |
| 2 | The 4.1 test has forward at 207; 4.3 telemetry has 220, though a few 4.3 segments also sit at 201–213 | F9278, T1, T2 | Use 220 for 4.3. The low readings may be the low-stamina penalty (≈ 18 points gives ≈ 205) or a version difference. Capture a forward run at full stamina. |
| 3 | Sprint 365/368 vs 329/340 | docs/03 §2.2, F9278, T3 | 368 is a turning overshoot. 340 is the cap (reached when slowing from above). 329 is a stall from below caused by UrT's whole-number velocities at 125 Hz. Set the cap to 340 and accept 329–340 in the feel test. |
| 4 | Our sprint rule needs forward to be "dominant"; the data show sprint drops out as soon as any strafe key is held | docs/03 §5.1, T2, F9278, DSWP | Follow the data: any net side input cancels sprint. AWD (both strafe keys, net side input 0) still sprints. |
| 5 | Crouch × 0.25 (80) vs "about 10% slower than walking" and 99–100 | docs/03, MOV, T2, F9278 | Three sources agree on ≈ 100 u/s, i.e. 0.45 × run. |
| 6 | Jump apex 45.6 vs 48.53 | docs/03 §7, T5, DEV32198 | Same 270 take-off. UrT rounds velocities every 8 ms frame, so gravity acts like ≈ 750. The developer's "jump up 66.5" = 48.5 + 18 confirms it. Match the observables (apex, airtime), not UrT's internals. |
| 7 | Our fall targets (512 u ≈ 50 damage, 768 u lethal) vs lethal at 394.125 u | docs/03 §5.6, DEV32198 | Follow the developer's measured heights. |
| 8 | `pm_fallLegsSpeed` 850 sits above the derived lethal speed (769) | docs/03 §2.2, DEV32198 | Move the legs threshold inside 548–769. Beta 1.1's "≥ 30 damage" rule gives ≈ 650 on our curve. |
| 9 | At zero stamina: we allow full jumps; the wiki says you "can't jump to even the lowest platforms"; telemetry shows a weak 202 u/s jump | docs/03 §5.2, MOV, T7 | Adopt the weak jump. The wiki's "very slow" is the ≈ 75 % speed penalty. |
| 10 | Slide steering: DSWP "facing doesn't matter" vs French guides "the view curves the slide; strafe keys need the mouse" | DSWP, FR-SLIDE, FR-TERMS, F35674 | Both hold if the slide keeps Q3-style acceleration driven by movement input. With no input, or forward along a velocity already above the wish speed, nothing is added, so the view alone doesn't steer. A strafe key, or forward with the view turned well away from the velocity, adds sideways acceleration. An unconfirmed telemetry lead shows exactly this. Confirm by capture (§5, item 4). |
| 11 | Kick-angle advice (back = height, side = speed) vs telemetry (yaw at contact doesn't change the kick) | FR-WJ, F11680, F11673, T10 | The kick ignores the view. What players feel comes from air control in the frames after the kick, under the new view. Keep our view-independent impulse. |
| 12 | "Press jump slightly before touching the wall" vs "kicks only on a fresh press, while descending, at contact" | SINON, T10 | Unresolved: either detection reaches a little beyond the hull, or presses made while descending near the wall count. Capture. |
| 13 | Ledge-grab input: the manual says "keep the jump key depressed"; the guides say forward | MAN, FR-TERMS, F15676 | Keep supporting both until a capture. An unconfirmed lead says forward is required and jump is not. |
| 14 | We allow a re-grab after 0.2 s; sources say "immediately" | docs/03 §5.5, F15676, F32317 | Gate re-grabs on a fresh forward press, with no timer. |
| 15 | `g_walljumps` minimum: the shipped cfg says "min = 3"; the 2012 announcement said 0 turns wall jumps off | CFG-SRV, F28664 | The shipped range (3–100) wins; 0 = off was the announced intent. Only matters for a trials mode. |
| 16 | `g_noVest` default: 1 in the cfg, 0 in the CVARS wiki | CFG-SRV, CVARS | Set it explicitly on the capture server. |
| 17 | Save/load names: `/save` and `/load` vs `/savePos` and `/loadPos` | RM43, CHEATS, CFG-SRV | Try both in 4.3.4. |
| 18 | Kevlar: "halves stamina" vs "affects stamina drain" | CFG-JUMP, KEV, WP07 | Mechanism unresolved. Capture sprint duration and regen time with and without a vest. |
| 19 | A 2007 Wikipedia copy says crouching speeds up regen; DSWP and the wiki say not, and telemetry shows the same rate | WP07, DSWP, UTW, T6 | No speed-up; keep our rule. |
| 20 | One review says gear weight affects stamina; the wiki and DSWP say there is no weight system | DEDO, UTW, DSWP | No weight system. |
| 21 | UrT needs friendly fire on to boot teammates; our spec allows a knockback-only shove with FF off | DSWP, VH, docs/03 §5.8 | A design decision: follow UrT, or keep ours and log the deviation in the decision log. |
| 22 | Verifier label splits: the same quote was judged FACT by one verifier and INFERRED by another (the urban-terror.fr glossary on slide steering, slide stamina and grabbing; DSWP-DE on the goomba) | – | This report uses the lower label. |

## 4. Proposed changes to our docs

**Process.**
- These changes need your approval (golden rule 9), and each adopted change needs a decision-log entry (golden rule 6).
- Two items replace an ESTIMATE with a value that a verified source states outright: `pm_slideMinSpeed` (B11) and the goomba attacker rule (B44). Golden rule 7 forbids upgrading an ESTIMATE on our own say-so, so please confirm those two explicitly.
- Everything taken from telemetry or arithmetic is INFERRED. Everything else stays ESTIMATE and is tuned through cvars.
- The §2.1 values were checked against `docs/03` when this record was filed; §8's tests were not. Check the tests (`pnpm test:movement`, `pnpm feel-report`) before editing.

**Principle behind B1–B7: match what a player sees in UrT (speeds, apex, airtime, heights), not UrT's internals.** UrT's whole-number velocity rounding at 125 Hz creates artifacts: gravity acting like 750, and the 329/340 sprint split. Our 60 Hz quantised sim will not reproduce them on its own.

### 4.1 `docs/02` (facts and sources)

| ID | Where | Change | Label | Sources |
|---|---|---|---|---|
| A1 | §3.1 bullet 1 | Replace "kept Quake III's movement speeds" with: kept Q3-style air movement and circle jumping, but ground speeds are far below Q3's (run ≈ 220, sprint ≈ 329–340, walk ≈ 111, crouch ≈ 100; a 4.1 test gave 207/329/110/99) | INFERRED | T1, T2, T3, F9278 |
| A2 | §3.1, new bullets | Jump: 270 take-off, 48.5 u apex, 0.72 s airtime; gravity acts like ≈ 750 while `g_gravity` reads 800. Jump-onto 66.5 u, step 18 u, jump height independent of run speed. Ground friction ≈ 4, stop speed ≈ 100, soft ground acceleration (0 → 219 in ≈ 0.49 s); air acceleration ≈ 1 × wish speed | INFERRED; FACT for the developer's heights | T5, T6, T2, T11, DEV32198, CFG-SRV |
| A3 | §3.1 speed table | Note that "~368 forward + sprint + turn (ground)" is above the ≈ 340 sprint cap (a turning overshoot) | INFERRED | F9278, T3 |
| A4 | §3.2 sprint bullets | "Forward-only" becomes: forward with no net strafe input (AWD with both strafe keys still sprints). Not while walking (Beta 2.1). No extra speed on ladders, where a sprint drain was a bug fixed in 4.3.0 | INFERRED; FACT for walk, AWD and the fix | T2, F9278, DSWP, RM42, RM43, GH188 |
| A5 | §3.2, new numeric bullet | 0–100 pool at full health; 6 per jump and per kick; regen ≈ 20 − 0.0764 × speed on the ground; frozen in the air and while ledge-climbing; below ≈ 25 points run and sprint fall to ≈ 75 % at 0; weak jump at 0 | INFERRED | T4, T5, T6, T7, T10 |
| A6 | §3.2 Kevlar | Keep "halves stamina" as the wiki's wording and add "whether the maximum or the drain changes is not documented" | FACT (wording) | CFG-JUMP, KEV, WP07 |
| A7 | §3.2, version notes | 4.2.004 drain tweak; 4.2.007 crouch-walk drain fix; 4.2.001 regen frozen when paused; 4.3.0 ladder-sprint fix; `g_stamina` modes, Jump mode only | FACT | RM42, RM43, CFG-SRV |
| A8 | §3.3 | Add the limit cvar facts and the 4.2.015 falling-kick rule. Replace "the exact impulse math is unknown" with the telemetry reconstruction. Note that kick angles act through air control after the kick | FACT + INFERRED | CFG-SRV, CVARS, RM42, VH, T10, T2 |
| A9 | §3.4 | Add: entry ≈ 300 (manual); constant ≈ 125 u/s² deceleration down to ≈ 300, then friction; ≈ 150 u from sprint speed; a jump out keeps the speed; silent (4.1). Change "your facing doesn't matter" to "the view alone doesn't steer; strafe keys with the mouse bend the path (sources conflict)" | FACT (entry, sound); INFERRED (rest) | MAN, T8, T9, T7, F11686, DSWP, FR-SLIDE, FR-TERMS |
| A10 | §3.5 | Add: the developer's heights; the derived 58–66 u window; climb at 70 u/s; pull-up ≈ 0.8 s, ending crouched; immediate re-grab; no grab while crouched or on rounded surfaces; grabs while rising work | FACT (heights); INFERRED (rest) | DEV32198, T5, T7, F15676, F32317, F32581, FR-TERMS |
| A11 | §3.6 fall damage | Replace "The exact thresholds are unknown" with: damage starts at a 200.125 u drop and 394.125 u is lethal (4.2.018). Beta 1.1 ruled that ≥ 30 fall damage injures the legs (not confirmed for 4.x). Curve shape unknown | FACT | DEV32198, RM42, F34762 |
| A12 | §3.6 goomba and boot | Goomba: attacker unhurt, any weapon, teammates can be stomped. Boot: also while holding the bomb (4.2.001); no ground boot from 4.3.0; knockback scales with `g_knockback` (1000); mutual kicks since 4.2; 5 kicks kill | FACT | BOOTS, MAN41, VH, RM43, SRVCVAR |
| A13 | §3.6 other facts | Ladders: walking is very slow and silent, crouching doesn't slow climbing (4.3.0), a cooked grenade is re-pinned (4.2.001), sprint adds no speed. Add the vertical overbounce and icy surfaces | FACT; INFERRED for sprint | GH424, GH188, RM43, UJM-VOB, FR-TERMS |
| A14 | §13 Movement | Replace the speedometer line with `cg_speedo 1` (u/s; units added in 4.2.016; cvar already in 4.1; horizontal, whole units). Add `cg_drawKeys 2`, `cg_accelero 1`, `cg_drawhealth 1`, `com_maxfps 125`. Physics is frame-rate independent, so the capture fps doesn't change jumps. Time sprint duration from the speedometer, not the segmented bar | FACT; INFERRED (fps, horizontal) | RM43, CVARS, CFG-DEF, RM42, VH, DSWP, UJM-VOB, T5 |
| A15 | §13 Workflow | Jump-mode checklist: `g_gametype 9`; `/ready`; `/save` and `/load` (or `/savePos` and `/loadPos`); `g_stamina 0` for stamina; `g_nodamage 0` for falls (the default is 1); set the vest explicitly; check `g_gravity 800` and `g_walljumps 3`; use 4.3.3+ for save/load; capture only your own player (the server runs at 20 Hz). Repeat base speeds in a normal gametype | FACT | RM42, RM43, JM, CHEATS, CFG-SRV, CVARS |
| A16 | §14 Sources | Add the official changelogs, the wiki pages (read through the MediaWiki API), the manual mirrors, the developer measurements thread and its table image, the community guides, the issue tracker and the telemetry demos (key list at the end of this report) | FACT (references) | all keys below |
| A17 | §15 Known unknowns | Mark as now INFERRED: base speeds, wall-jump vectors, slide model and threshold, ledge heights and climb speed, stamina costs and regen, fall thresholds. Keep as unknown: auto-hop, probe distances, vest and health scaling, fall-curve shape, boot knockback, ladder and swim speeds | INFERRED | this report |

### 4.2 `docs/03` (values and labels)

| ID | Where | Current → proposed | Label | Sources |
|---|---|---|---|---|
| B1 | §2.1 `pm_runSpeed` | 320 → 220 | INFERRED | T1, T2, F9278 |
| B2 | §2.1 `pm_walkScale` | keep 0.5 (gives 110; measured 111–112); label it INFERRED for UrT | INFERRED | T2, F9278 |
| B3 | §2.1 `pm_duckScale` | 0.25 → 0.45 | INFERRED | T2, MOV, F9278 |
| B4 | §2.1 `pm_friction`, `pm_stopSpeed` | 6 → 4; keep 100 | INFERRED | T6 |
| B5 | §2.1 `pm_accelerate` | 10 → ≈ 4.5, tuned so the feel test matches the ramp times (the coefficient itself is a fit) | INFERRED (low–medium) | T2 + pooled ramps |
| B6 | §2.1 `pm_gravity`, `pm_jumpVelocity` | player move 800 → 750 (projectiles keep 800); keep 270 | INFERRED | T5, CFG-SRV, VH |
| B7 | §2.2 `pm_sprintSpeed` | 365 → 340 (the feel test accepts a 329–340 plateau) | INFERRED | T3, F9278 |
| B8 | §2.2 `pm_maxWallJumps` | keep 3 (FACT); add: `g_walljumps` range 3–100, Jump mode only; resets on a horizontal surface | FACT | CFG-SRV, CVARS, WJ, DSWP |
| B9 | §2.2 `pm_wallJumpUp` | 290 as a floor → 270, set | INFERRED | T10 |
| B10 | §2.2 `pm_wallJumpPush` | 140 → 200 | INFERRED | T10 |
| B11 | §2.2 `pm_slideMinSpeed` | 300 ESTIMATE → 300 FACT ("about 300") | FACT | MAN, MAN41, T9 |
| B12 | §2.2 `pm_slideFriction` | 0.8 (proportional to speed) → new `pm_slideDecel` 125 u/s² (constant) | INFERRED | T8 |
| B13 | §2.2 `pm_slideEndSpeed` | 120 → 300 | INFERRED | T9, T8 |
| B14 | §2.2 `pm_slideSteer` | 0.5 → 1.0 (as in air), redefined as acceleration driven by movement input | ESTIMATE | FR-SLIDE, FR-TERMS, DSWP, F35674 |
| B15 | §2.2 `pm_ledgeMinHeight` | 24 → 58 | INFERRED | DEV32198, T5 |
| B16 | §2.2 `pm_ledgeMaxHeight` | 76 → 66 | INFERRED | DEV32198, T5 |
| B17 | §2.2 `pm_climbSpeed` | 180 → 70, plus a 750 u/s² ramp | INFERRED | T7 |
| B18 | §2.2 `pm_fallSafeSpeed` | 560 → 548 | INFERRED | DEV32198, T5 |
| B19 | §2.2 `pm_fallLethalSpeed` | 1100 → 769 | INFERRED | DEV32198, T5 |
| B20 | §2.2 `pm_fallLegsSpeed` | 850 → ≈ 650 (must lie between 548 and 769) | ESTIMATE | RM42, F34762, DEV32198 |
| B21 | §2.2 `pm_autoHop` | keep 0; add the evidence | ESTIMATE | SINON |
| B22 | §5.1 sprint conditions | "forward dominant" → forward held and no net strafe input; add "walk not held" and "not on a ladder" | INFERRED; FACT (walk) | T2, F9278, DSWP, RM42, GH188, RM43 |
| B23 | §5.1 sprint drain | "on ground or in air" → on the ground only | INFERRED | T5 |
| B24 | §5.1/§5.2, new | low-stamina scale on the run and sprint wish speeds: × (0.75 + 0.25 × min(1, stamina / 25)); walk and crouch unaffected | INFERRED | T4, MOV, VH |
| B25 | §5.2 `st_jumpCost` | 5 → 6 | INFERRED | T5 |
| B26 | §5.2 `st_wallJumpCost` | 8 → 6 | INFERRED | T10 |
| B27 | §5.2 regeneration | `st_regenIdle` 18 and `st_regenMove` 5 → regen = 20 − 0.0764 × horizontal speed (new `st_regenSpeedSlope`). Applies on the ground, in any stance, when not sprinting or jumping; it goes negative above ≈ 262 u/s. 0 in the air, while ledge-climbing and in water | INFERRED | T6, T5, T7, DSWP |
| B28 | §5.2 "when stamina runs out" | a ground jump below the jump cost is weak (take-off 202, horizontal × 0.5); kicks below 12 points are weak (vz 170, push 100); no kick below 5. Thresholds are ESTIMATEs, the weak values INFERRED | INFERRED / ESTIMATE | T7, T2, MOV, T4 |
| B29 | §5.2 `staminaMax` label | the health relation is FACT; applying the vest's × 0.5 to the maximum is our reading of "cuts stamina in half" | FACT / INFERRED | DSWP, CFG-JUMP, KEV |
| B30 | §5.2 feel target | "empty → full standing ≈ 5–6 s" → ≈ 5 s; sprint 100 → 0 stays ESTIMATE | INFERRED | T6 |
| B31 | §5.2 slide stamina | keep `st_slideCost` ESTIMATE; note that slides on the ground follow the regen law and that holding sprint reduces the drain | INFERRED | T6, FR-SLIDE, F11686 |
| B32 | §5.2 crouch | add: no drain while moving crouched | FACT | RM42, RM43 |
| B33 | §5.2, new | trials-only stamina-mode cvar (normal / regain when stopped / infinite), locked to normal elsewhere | FACT (UrT behaviour), design | RM43, CFG-SRV, F31273 |
| B34 | §5.3 preconditions | add "descending (vz ≤ 0)"; replace "stamina ≥ cost" with the B28 rule | INFERRED | T10, T2 |
| B35 | §5.3 impulse | drop step 1 (no cancel); push 200; vz = 270; along-wall velocity kept; view ignored; "math ESTIMATE" → "math INFERRED" | INFERRED | T10, T5 |
| B36 | §5.3 tuning goals | chimney: each apex kick gains ≈ 48.5 u, so 3 kicks gain ≈ 146 u (inside 120–160); add the developer test (apex kick, then grab: +4.125 u) | INFERRED; FACT (test) | DEV32198, T10, T5 |
| B37 | §5.4 entry | note that a crouch tap in the air may be enough (crouch is sticky in the air since 3.5) | FACT (3.5) / open | VH, RM43, MAN |
| B38 | §5.4 while sliding | constant deceleration above 300; steering driven by movement input; "ignores view direction (FACT)" → INFERRED with the conflict noted; slide speed independent of stamina | INFERRED | T8, DSWP, FR-SLIDE, FR-TERMS, DSWP-DE |
| B39 | §5.4 exit and feel target | below 300 → normal crouched move with friction 4; a jump keeps 100 % of speed; target "300–420 u from 365" → ≈ 150 u from 335 with crouch only | INFERRED | T9, T7, T6, T8 |
| B40 | §5.5 grab and climb | on a grab, also zero horizontal velocity; ramp to 70 u/s; finish with a one-frame pop (≈ 7–8 u) and arrive crouched; stamina frozen | INFERRED | T7, T10, DSWP |
| B41 | §5.5 re-grab | 0.2 s timer → a fresh forward press | INFERRED | F15676, F32317 |
| B42 | §5.5 rising grab, priority | grabs while rising are allowed; run the grab check after a kick, and the grab wins on the next frame | INFERRED | DEV32198, F22078 |
| B43 | §5.6 targets and tests | 256 / 512 / 768 u targets → first damage at 200.125 u, lethal at 394.125 u. Add tests: a wedge squeeze causes no fall damage; wall-hugging with jump held doesn't cancel fall damage without a grab | FACT (heights), INFERRED (tests) | DEV32198, GH268, GH438 |
| B44 | §5.7 goomba | attacker "no fall damage (ESTIMATE; our design choice)" → FACT; works with any weapon; teammates can be stomped (the FF gate stays our ESTIMATE) | FACT | BOOTS, MAN41, DSWP-DE |
| B45 | §5.8 boot "When" | "airborne or moving" → airborne; add the bomb carrier | INFERRED (rule), FACT (fix, bomb) | VH, RM43, BOOTS |
| B46 | §5.8 boot knockback and teammates | drive knockback from a replicated knockback scale (UrT: `g_knockback` 1000); size stays ESTIMATE, probably above 120. With FF off UrT blocks teammate boots, so follow UrT or log our shove as a deviation. Resolve mutual kicks in the same tick, independent of player order | FACT / ESTIMATE | SRVCVAR, BOOTS, F23425, DSWP, VH |
| B47 | §5.9 ghosting | note: in UrT ghosting was a per-player opt-in (`cg_ghost`, client side since 4.2.013), and you can't stand on heads while ghosted | FACT | RM42, CVARS, CHEATS |
| B48 | §5.10 presentation | the original slide is silent; crouched movement is silent; low-stamina breathing needs a replicated or derived flag; using horizontal speed for the trail is our choice | FACT / INFERRED | F11686, MOV, PL, RM43, DSWP |
| B49 | §7 log | new targets: run 220, sprint 329–340, walk/crouch 111/100, apex 48.5 u (0.72 s), kick +48.5 u at the apex, slide ≈ 150 u, ledge reach 114.625 (118.75), regen 5 s, falls 200.125 / 394.125. Put labels and sources in Notes; leave "Measured in UrT 4.3.4" for our own capture | FACT / INFERRED | as above |
| B50 | §10 questions | Q2 and Q4 answered (INFERRED); Q5 mostly answered; Q1 and Q3 stay open with the evidence. New questions: reproduce UrT's rounding artifacts? grab vs kick priority; teammate boot with FF off; overbounce, corner cut and icy surfaces; rising kicks and early presses | INFERRED | as above |

### 4.3 Derivations used above (so they can be checked)

- **Effective gravity.** Each 8 ms frame vz drops by 6 instead of 6.4 (whole-number velocities), so gravity acts like 6 / 0.008 = 750 u/s². Apex = 270² / (2 × 750) = 48.6 u (measured 48.53); airtime = 2 × 270 / 750 = 0.72 s.
- **Fall speeds.** √(2 × 750 × 200.125) = 548 u/s and √(2 × 750 × 394.125) = 769 u/s. With continuous gravity 800 they would be 566 and 794. If we keep `pm_gravity` 800, use 566 / 794 instead.
- **Ledge window, top.** At the apex the feet are 48.53 u up, so the highest grabbable top is 114.625 − 48.53 = 66.1 u above the feet.
- **Ledge window, floor.** A ledge sits highest above the feet when the feet are lowest: about 2.1 u up on the first and last airborne frames. So the lowest grabbable top (60.375 u above the floor) puts the window floor at ≈ 58.2–60.4 u. This assumes the grab check can run on those frames. An unconfirmed telemetry lead agrees: falling grabs at 58.3–59.3 u and rising grabs at ≈ 64–66 u above the feet.
- **Slide from sprint speed.** The slide phase from 335 covers (335² − 300²) / (2 × 125) = 89 u in 0.28 s. Friction 4 from 300 to 100 adds (300 − 100) / 4 = 50 u, and the constant 375 u/s² from 100 to 0 adds 13 u: ≈ 152 u in total. From 600 u/s the slide phase alone covers (600² − 300²) / 250 = 1080 u.
- **Legs threshold.** On our curve (safe 548, lethal 769, exponent 1.6), 30 damage comes at 548 + 221 × 0.3^(1/1.6) ≈ 652 u/s, a drop of ≈ 283 u.
- **Chimney.** After a kick (vz 270) the player must wait until vz ≤ 0 for the next kick. Each kick at the apex therefore gains about one jump apex (≈ 48.5 u), so 3 kicks gain ≈ 146 u.
- **Low-stamina scale check.** 220 × (0.75 + 0.01 × s) gives 165 at s = 0, 172 at 3, 183 at 8, 194 at 13, 205 at 18 and 216 at 23. All fall within the measured bins.
- **Ground acceleration fit.** At 60 Hz with friction 4, an accelerate of 4.5 adds 16.5 u/s per tick against 6.7 of friction below 100 u/s. That reaches 100 u/s at ≈ 170 ms and 150 at ≈ 270 ms (measured 168 and 264). It is about 10–15 % slow near the top, so tune between 4.5 and 5 against the ramp test.

## 5. Still unknown: what only a 4.3.4 capture can settle

The text sources gave no numbers for speeds, stamina rates, kick vectors, slide friction or climb speed. The telemetry now covers those, so this list is shorter than the research dead-end list. What remains needs our own capture, or confirmation outside Jump mode.

**Setup** (about 20 minutes, once):
- a local 4.3.4 listen server;
- `cg_speedo 1`, `cg_drawKeys 2`, `cg_accelero 1`, `cg_drawhealth 1`, `cg_drawfps 1`, `com_maxfps 125`;
- Jump mode (`g_gametype 9`) with `g_stamina 0`, `g_gravity 800`, `g_walljumps 3` and the vest set explicitly; `g_nodamage 0` whenever falls matter;
- repeat the base-speed tests in a normal gametype (for example `g_gametype 0`) to rule out jump-mode effects;
- `/record` a demo for each test and step through playback;
- for heights and distances, a throwaway test map made of our own brushes (never shipped, no UrT files copied), or `/viewpos` if the 4.3.4 client has it.

Ordered by how much each item matters for feel:

| # | Quantity | Simplest capture | Effort |
|---|---|---|---|
| 1 | Base ground speeds and ramps at full stamina, outside Jump mode: run (220, or 4.1's 207?), sprint (329 from rest, 340 when slowing from above), walk, crouch, run and sprint from rest, stop time | Flat ground, normal gametype. Read the `cg_speedo` plateaus for F, F+S, F+W, F+C, F+L and B. Time 0 → 100 and 0 → 200 u/s, and 220 → 0, in demo playback | 45 min |
| 2 | Low-stamina speed penalty, and sprint duration 100 → 0 (full HP, no vest) | Sprint from full along a long flat path. Note the speed at each bar segment, time the drop from ≈ 329 to run speed, and confirm run ≈ 165 at 0 | 30 min |
| 3 | Jump buffer and auto-hop: does holding jump re-jump, and does a press 1–3 frames before landing count? Also confirm the apex and airtime | `cg_drawKeys 2` + demo playback. Hold jump through 10 landings, then press at varying times before touchdown. Get airtime by frame count | 30 min |
| 4 | Slide steering, entry and length: no keys + a 90° view turn; forward + a view turn; strafe + mouse; crouch tapped in the air vs held; distance from ≈ 335 u/s | Sprint-jump into a slide on flat ground. Watch the path and `cg_speedo`: expect −1 u/s per 8 ms, ending at ≈ 300. Mark start and stop to get the distance (≈ 150 u expected) | 30 min |
| 5 | Wall-kick timing: can you kick while rising, or with a press just before contact? Kicks at 0–5 stamina; the weak-kick threshold (6–11) | Jump at a flat wall and press jump while rising, at the apex and while falling. Drain stamina first; read the push on the speedometer (≈ 200 full, ≈ 100 weak) | 45 min |
| 6 | Ledge-grab window above the feet; input key (jump only vs forward only); re-grab timing; climb time | Test map with ledges every 2 u from 56 to 70 u and from 108 to 120 u. Grab with jump only, then forward only. Release and re-press. Time the pull-up over a known height | 1.5 h incl. map |
| 7 | Fall-damage curve between 200 and 394 u, the legs threshold, and whether a crouched landing changes damage | `g_nodamage 0`, `cg_drawhealth 1`. Drops every 25 u from 200 to 400 u at full HP, landing standing and crouched. Note the HP lost and whether sprint still works (limp) | 1.5 h incl. map |
| 8 | Stamina costs we only have leads for: crouch-down on the ground and in the air, slide entry, regen delay after a jump or landing, regen on ladders, in water and while partly submerged | Use the low-stamina penalty as a gauge: below 25 points, run speed = 220 × (0.75 + 0.01 × stamina). Run at ≈ 20 points, do one action, then read the run speed again | 1 h |
| 9 | Vest and health scaling (Q5): is the maximum halved or the drain doubled? Does a wounded player's maximum equal current HP? Are rates in points or a fraction of the maximum? | Measure sprint duration and the 0 → full regen time with and without a vest, at 100 HP and at ≈ 50 HP (take fall damage first) | 45 min |
| 10 | Boot: knockback size and direction at `g_knockback` 1000; cooldown; whether you must face the target; teammates with FF off | Two clients on a LAN. The victim reads `cg_speedo` right after the kick. Spam kicks to find the repeat limit | 1 h |
| 11 | Wall-jump detection distance and minimum wall height | Test map with walls 8–48 u tall (4 u steps) and floor marks every 2 u from the wall | 1.5 h (shares #6's map) |
| 12 | Ledge forward reach | Same map: try grabs from marked distances off the wall | 30 min |
| 13 | Limp speed multiplier | Break your legs with a drop found in #7, then read the run speed | 15 min |
| 14 | Ladder speeds (up, down, with walk, with crouch) and swim speeds (surface, under water, rise, sink) | Time a ladder of known height; read `cg_speedo` while swimming level | 30 min |
| 15 | Does a grab, ladder or water reset the wall-kick counter? Which wins when a grab and a kick fire on the same frame? | Kick 3 times, grab, then try a 4th kick | 20 min |
| 16 | Do the speed trail and `cg_speedo` use horizontal or 3-D speed? | With `g_nodamage 1`, fall straight down past 600 u/s (a drop of ≥ 240 u) with no horizontal speed. Does the trail appear, and does the meter read 0? | 10 min |

## 6. Unconfirmed leads (rejected in verification)

**Superseded.** One verifier rejected these only because the page would not load. Another verifier loaded it and confirmed the same values, and the confirmed versions are used above:
- the thread-9278 ground-speed table (207/202/219/329/340/110/99);
- the 4.2.018 developer measurements (66.5, 18, grab heights, fall heights, openings);
- the manual's "about 300" slide-entry speed;
- the AWD sprint (re-sourced to DSWP);
- the 48.5 u jump apex. Telemetry confirms the apex, but as a 270 take-off with gravity acting like 750, not a 279 take-off.

**Not usable yet:**

| Lead | Why it was rejected | What would fix it |
|---|---|---|
| Typical max ground speed 220–240 u/s (forum 6674) | page blocked; an offhand remark | not needed (telemetry covers it) |
| Crouch "11 u/s slower" than walk (forum 7294) | page blocked | covered by the wiki's "about 10%" and by telemetry |
| Sprint + strafe + turn peaks at 230; circle-jump peaks 428 / 502 / 555 / 584 and timed runs of 5.41 vs 5.73 s (forum 9278) | only the ground table could be checked | re-read the thread. `docs/02` §3.1 still lists 350/428/555 as cited; they were not re-verified in this pass |
| High-end claims of 700–1400 u/s, "1200+" and "1100 xy" (forum 22147) | page blocked or claim not on the page; anecdotes | none needed |
| Turning past 90° loses speed (forum 22147) | page blocked; DSWP says nothing about speed loss | capture it if circle-jump tuning needs it |
| UrT has no CPM-style air control (forum 33349) | page blocked; the post is about UrT 5 | telemetry already shows air acceleration ≈ 1 × wish speed |
| Corner clipping | the cited thread is blocked and about UrT 5 | re-source to urban-terror.fr ("le corner cut permet de 'traverser' l'extrémité d'un mur") |
| Exhausted jumps go "no higher than a few centimetres" (TV Tropes) | site unreachable | covered by the telemetry weak jump |
| Vest "halves" stamina, helmet has no effect, jump servers strip vests (Kevlar Armor page) | the page says "severely affects", not "halves" | use the Config: Jump Mode wording ("cuts stamina in half") |
| Kevlar makes the bar refill faster (Polish thread) | a misreading: the stopwatch test reported equal regen | capture item 9 |
| `pm_ledgeMaxHeight` 66–69 from a Q3 apex | built on an assumed Q3 apex | re-derived in §4.3 with the verified 48.53 u apex |
| Water prevents fall damage from any height (TV Tropes) | site unreachable; the Tropedia mirror and a forum post agree | cite Tropedia or forum 9349 if we keep it |
| A `surfaceparm nodamage` shader; a map name starting with "q" turns off fall damage (forum 9349) | the prefix rule is in the thread; the shader is not | treat the shader as unsourced |
| A grab or a wall kick breaks a fall from any height (All The Tropes) | site unreachable; DSWP calls the kick method "tricky" | grab: FACT via DSWP; kick: INFERRED at most |
| Regen while walking and running, crouching not needed (Movement wiki) | the page only says "while you are walking your stamina will slowly regenerate" | covered by other sources |
| Telemetry leads with broken or wrong demo links. The verifier reproduced most of the values in other demos. They cover: apex unchanged by crouching in the air; stamina frozen in water even with sprint; sprint drain ≈ 12.5 /s (100 → 0 in ≈ 8 s); crouch-down cost ≈ 10 on the ground and 0 in the air; slide entry cost 0 and slide drain ≈ 13–15 /s with sprint held; regen delay ≈ 0 (first +1 ≈ 40 ms after landing); slide-steering ratios (strafe key ≈ 0.8–1.0, forward or no keys ≈ 0); grab window 58–59 u falling and ≈ 65 u rising; 19–21 % of grabs while rising; re-grab timings; no auto-hop and no pre-press buffer | the links return 404 or don't contain the quoted frames | re-cite each to a demo that loads (for the crouch cost: the maki demo, t = 480032, 493104, 1234632), then promote it to INFERRED |

## Sources

**Official and changelogs**
- RM43: official 4.3 readme and changelog. https://download.salixos.org/sbo/14.2/games/UrbanTerror/docs/readme43.txt (also https://slackbuilds.org/slackbuilds/15.0/games/UrbanTerror/docs/readme43.txt)
- RM42: official 4.2 readme and changelog. https://download.salixos.org/sbo/14.1/games/UrbanTerror/docs/readme42.txt
- VH: wiki Version History. https://urbanterror.fandom.com/wiki/Version_History
- MAN: official manual, User Interface page. https://www.urbanterror.info/support/109-/
- MAN41: mirror of the 4.1-era official manual. https://sites.google.com/site/urtmanual/
- MAN35: mirror of the 3.5 manual. https://sites.google.com/site/urtmanual/oldurtmanual/urban-terror-35-manual---900---combat-techniques
- SRVCVAR: official server cvars page. https://www.urbanterror.info/support/180-server-cvars/
- CFG-SRV: FrozenSand's server_example.cfg (4.2), reproduced on the wiki. https://urbanterror.fandom.com/wiki/Config:_Default_Server
- CFG-DEF: stock default.cfg (4.1, 4.2.017–019). https://urbanterror.fandom.com/wiki/Config:_Default
- DEV32198: the lead developer's 4.2.018 measurements. https://www.urbanterror.info/forums/topic/32198-urban-terror-42-measurements/ and the table image http://www.mhermann.net/q3ut4/pics/stuff/urt42_measurements.jpg
- GH###: FrozenSand/UrbanTerror4 issue tracker, prose only. https://github.com/FrozenSand/UrbanTerror4/issues/9, /188, /268, /402, /424, /438, /439

**Wiki** (read through the MediaWiki API)
- MOV https://urbanterror.fandom.com/wiki/Movement
- CVARS https://urbanterror.fandom.com/wiki/CVARS
- BOOTS https://urbanterror.fandom.com/wiki/Boots
- WJ https://urbanterror.fandom.com/wiki/Wall_jump
- JM https://urbanterror.fandom.com/wiki/Jump_Mode
- CHEATS https://urbanterror.fandom.com/wiki/Cheats
- CFG-JUMP https://urbanterror.fandom.com/wiki/Config:_Jump_Mode
- UTW https://urbanterror.fandom.com/wiki/Urban_Terror
- KEV https://urbanterror.fandom.com/wiki/Kevlar_Armor
- WP07, a 2007 Wikipedia copy. https://wikipedia2007.classicistranieri.com/u/r/b/Urban_Terror_f2b8.html

**Community guides**
- DSWP http://www.dswp.de/old/wiki/doku.php/tutorials:urban_terror:beginner
- DSWP-DE http://www.dswp.de/old/wiki/doku.php/tutorials:urban_terror:beginner_german
- FR-SLIDE https://www.urban-terror.fr/tutoriels/le-slide/
- FR-WJ https://www.urban-terror.fr/tutoriels/les-walljumps/
- FR-TERMS https://www.urban-terror.fr/tutoriels/differents-termes-utilises-en-jump/
- FR-ADMIN https://www.urban-terror.fr/tutoriels/commandes-admin/
- FR-49403 https://www.urban-terror.fr/forums/viewtopic.php?p=49403
- PL https://www.urban-terror.pl/artykuly/stamina-dla-poczatkujacych
- SINON https://sinon.org/games/urt.html
- TUX https://www.tuxarena.com/intro/guide_urbanterror.php
- UJM-VOB https://urtjumpmaps.com/other/learning (the article is served from /other/fetchlearning/verticalob)
- DEDO https://www.dedoimedo.com/games/urban-terror-review.html

**Forum threads** (all under https://www.urbanterror.info/forums/topic/)
- F9278 9278-jump-speeds-bugging-the-hell-out-of-me (post #8)
- F22147 22147-jumping-faster/page__st__10
- F28664 28664-jump-mode-notice (page 1, post #10)
- F11680 11680-jump-map-for-beginners/page__st__10
- F11673 11673-sprint-crouch-strafe-slide
- F9131 9131-help
- F22078 22078-list-of-bugs-and-good-suggestions
- F21059 21059-ut4-bstjumps-wip
- F23425 23425-boot-kick
- F29481 29481-booting-glitch
- F11686 11686-power-slide-sound
- F35674 35674-jump-mode-in-urban-terror-5
- F26086 26086-powerslide
- F15676 15676-queries-about-jumping
- F32317 32317-holding-onto-a-ledge
- F32581 32581-i-am-looking-for-a-script
- F34762 34762-a-point-about-bleeding
- F31273 31273-g-stamina-1

**Telemetry** (all under https://urtjumpmaps.com/demo/demojson/)
- T1 ssmc24-baba_b2_way2_258296_jrulbens_20250917_150948.urtdemo (run 220)
- T2 maki-teamjumps_a2_way1_2669520_lau_20251205_214920.urtdemo (directions, sprint with strafe, walk, crouch, sprint ramp, weak kicks)
- T3 ut4_impossible2_b6_way2_19480784_Noobinours_20260505_225247.urtdemo (sprint 329)
- T4 castlebaba_b1_way1_176328_0StupZ_20241023_013319.urtdemo (sprint at 0 stamina)
- T5 ut43_speedjumps_b2_way1_543624_quak_20250711_195412.urtdemo (jump, jump cost, stamina in the air)
- T6 ut43_steroid_a1_way2_2474080_Noobinours_20260412_142822.urtdemo (regen, friction)
- T7 ujfm2k18_japanero_b1_way1_118392_lau_20251202_213139.urtdemo (weak jump, ledge climb, jump out of a slide)
- T8 ut42_caerdunh_b2_way6_273024_lau_20251202_211546.urtdemo (slide deceleration)
- T9 ujsm02-quak_v1_way1_132576_gooti_20240226_130644.urtdemo (slide end)
- T10 ut43_wjump_b2_way1_704128_6quak_20260618_230514.urtdemo (wall kicks)
- T11 ut43_steroid_a1_way1_53896_jrxaze_20261011_211501.urtdemo (air acceleration)
