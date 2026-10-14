# M4 plan: the UrT movement set

> **Status:** the M4 plan, approved by Mustafa on 2026-10-14 after one review round (61 findings) and his answers. Once approved it is kept as `docs/design/M4-plan.md`, so citations such as "M4 plan, increment 6" resolve. It is a record, not a spec: the numbered docs and the decision log win where they differ. The engineering detail is in `docs/design/M4-design.md` ("the design", committed with this plan). The research it weighs is `docs/design/M4-movement-research.md` ("the research").

## Context
M3 is merged: real multiplayer on a Node server, with bots, demos and Windows support. M4 makes the movement play like Urban Terror 4.3, fully predicted and networked (`docs/09` M4, prompt M4).

**Acceptance (`docs/09` M4):**
- MV-01…MV-20 pass. Targets marked ESTIMATE may be tuned; the final values are recorded in the decision log.
- NET-03 and NET-04 still pass with every mechanic on.
- Your feel sign-off after a play session, with the tuning changes logged.

**Out of scope:** weapons and combat beyond the damage hooks (M6). Game modes and real respawn rules (M7). Art (M8).

## In short
- **What you'll be able to do:**
  - sprint with stamina, wall-kick up walls and power-slide;
  - grab and climb ledges, get onto a ladder from the top, climb out of a pool over its rim;
  - drown, take fall damage and limp;
  - bump into players, stand on their heads, stomp them and boot them.
  
  All of it is predicted on your screen and checked online.
- **Tuning tools:**
  - switch whole value sets live, and see what you changed;
  - record and replay runs, and race your own ghost;
  - a strafe helper, and probe drawings for kicks and ledges.
- **When I need you:** a 15-minute feel check after increment 6, then your feel session at the end. M4 is marked finished only after that session, when your changes become the defaults (increment 17).

## Your answers (binding)
1. **Values: the research values for UrT 4.3.** These are run 220, sprint 340, walk 110, crouch 99; a softer start and stop; jumps 48.5 u high; stamina frozen in the air and slowing you below 25; wall kicks only while falling; slides about 150 u; ledges grabbed near the top of a jump; falls hurt from 200 u and kill from 394 u. The current docs set stays one command away as `movement_preset docs`.
2. **Solid players, predicted on your screen.** Contact nudges at high ping are measured on their own and never counted as bugs. I show you their numbers after increment 4, before building on it.
   - **Boots at high ping:** keep the netcode doc. M4 checks boots against current positions, logged as a temporary difference; M6 adds the rewind for boots as it does for shots.
3. **UrT capture: in parallel, whenever you like.** About 75 minutes: base speeds and ramps, plus the low-stamina slowdown. Results come in as logged setting changes. I don't wait for them.
4. **Feel check: yes, after increment 6.** You play 15 minutes, compare presets, and `cvardiff` prints your changes. I continue on what you confirm.
5. **FACT labels approved (golden rule 7):** slide entry speed 300 ("about 300", the manual) and "the goomba stomper takes no damage" (three sources).
6. **`docs/02` corrections approved:** the research's 17 corrections (A1–A17) to our notes on the original game, with their sources.

## Defaults I'll use unless you say no
| # | Default | Alternative |
|---|---|---|
| 1 | Sprint drain 12 per second (instead of 11). With 11, a full bar lasts 9.3 s, outside the 8–9 s target; with 12 it lasts 8.3 s. | Keep 11 and mark that target "off until the feel session". |
| 2 | Jumping at a ladder's foot jumps. In the air you only catch a ladder while holding forward, so a standing jump doesn't leave you hanging on it. | Catch a ladder without forward, but only when really falling. |
| 3 | Walking backward off a ladder's top while facing it puts you on the ladder. The view drop is smoothed like a step. | No top mount in M4: you fall, as today. |
| 4 | Crouching slows you on the ground only; in the air you keep full air control (as in Quake 3). | Crouch also slows you in the air, as today. |
| 5 | A water-jump lets a swimmer climb out over a rim at the water line, so pools may have flush rims. | No water-jump: every pool needs a low exit. |
| 6 | You respawn right after dying (the next tick). Real respawn rules come with game modes in M7. | A 1 s delay. |
| 7 | Drowning takes 12.5 HP per second: exactly 8 s at full health, sooner when hurt. | Always 8 s. |
| 8 | Self-bandage: hold F for 3 s to fix broken legs. M6 adds bleeding and the rest. | A test-only hook until M6. |
| 9 | Booting a teammate with friendly fire off swings with no effect (UrT blocks it). | Our docs' "shove": a push but no damage. |
| 10 | Boots only while airborne (UrT 4.3). | "Airborne or moving" (our docs). |
| 11 | Stomping a teammate only counts with friendly fire on (until M6). | It always counts. |
| 12 | Placeholder sounds also for jump, land and boot; the boot's hit sound waits for the server's confirmation. (UrT's slide is silent.) | Only wall kick, grab and slide. |
| 13 | The speed trail uses horizontal speed. Capture item 16 can change that. | Full 3D speed. |
| 14 | The strafe helper is a cheat setting: it works offline and on servers that allow cheats. | Allowed everywhere. |
| 15 | Health is shown rounded up, so a living player never reads 0. | Rounded down. |

## The two value sets (headline numbers)
| | Research (the spec) | `movement_preset docs` |
|---|---|---|
| Run / sprint / walk / crouch (u/s) | 220 / 340 / 110 / 99 | 320 / 365 / 160 / 80 |
| Time to full run speed | about 0.6 s | about 0.2 s |
| Jump height, time in the air | 48.5 u, 0.72 s | 45.6 u, 0.68 s |
| Sprint with a strafe key | not allowed | allowed while forward dominates |
| Stamina in the air | frozen | sprint drains, refill runs |
| Low stamina | slower below 25; weak jump at 0 | no penalty |
| Wall kick | up 270, push 200, only while falling | up 290, push 140, also while rising |
| Slide from sprint | about 150 u | about 320 u |
| Ledges you can grab from a standing jump (height above the floor) | 58–115 u (UrT: 60–115) | 24–122 u |
| Falls: first damage / death | 200 u / 394 u (UrT's measured heights) | about 196 u / 757 u |
| Broken legs from | about 282 u | about 452 u |
| Ladders and swimming | 110 u/s | 160 u/s |

## Architecture (by package)
The full module map and field list are in the design §1–§3.
- **`packages/shared`**
  - The new mechanics live in `sim/urt/` (sprint, stamina, wall jump, slide, ledge, fall damage, goomba and boot) and `combat/medic.ts` (health, bandage, drowning), all called from the pmove pipeline in `docs/03` §3 order. They follow the hot-path rules: Float64Array scratch, out-params, no allocations, D-016 deterministic maths (a new deterministic power function for the fall curve).
  - Player boxes get their own collision routine.
  - Protocol v4: eleven new PlayerState values (health, armor, wall jumps, time under water, the climb, five timers) and one flag. Four new events go on the wire, plus a reliable `PLAYER_DEATH` and a `HIT_CONFIRM`. The layout is fixed once, in increment 2.
  - The snapshot size bound still holds: 954 B at 32 players, 1100 B at 37; above 37 the existing scheduler takes over. A field guard proves every value is encoded, compared and copied.
- **`packages/server`**
  - Players are simulated in client-id order. Boot and stomp effects are applied after everyone has moved, so the order doesn't matter.
  - Deaths are broadcast, and a respawn is a teleport.
  - New admin commands: `movement_preset` and `cvardiff`.
- **`packages/client`**
  - Prediction against other players' latest known positions, moved ahead by their speed.
  - Contact corrections are classified through a 4-bit contact counter (as D-050 does for starves) plus the client's own touch log.
  - HUD: HP and stamina. Also the speed trail, synthesized placeholder sounds, the landing dip, the strafe helper, probe drawings, `cmdrecord`/`ghost`, and the F bandage.
- **`packages/tools`**
  - Courses: an "M4 yard" on `movement_lab` and test ledges on `jump_lab`. `?map=` plays any course offline.
  - The "mechanics tour" bot, `pnpm cmd-replay`, and the full feel report with "implementation" and "how far from UrT" columns.
  - The primer grows with every new branch and stays at or under 500 ms cold.

**No new dependencies.**

## Decisions you approve with this plan
| ID | Decision |
|---|---|
| D-052 | **The values: the research set is the spec** (answer 1), with one formula per rule so the docs set still works as a preset. The player hull stays Quake 3's. Old NET tests whose bots hop non-stop turn stamina costs off; the new M4 tests use the real rules. Labels: the base cvars change from FACT-Q3 to INFERRED; the two approved FACT upgrades (answer 5); `docs/02` gets A1–A17 (answer 6). |
| D-053 | **Protocol 4**, laid out once: the new values, the flag, four events on the wire, the death message and the hit confirmation. A guard proves every value is sent, compared and copied. Old demos stop playing. |
| D-054 | **Health and deaths:** 100 HP; at 0 you stop steering; you respawn the next tick; everyone gets the death message; the F bandage (defaults 6–8). |
| D-055 | **Sprint and stamina** per the research; walk cancels sprint; no sprint on ladders; drain 12/s (default 1). |
| D-056 | **Wall jumps:** short probes when you press jump in the air; a fixed rule picks the wall; up 270, push 200, only while falling. |
| D-057 | **Power slide:** entry checked at landing, at the landing speed; constant deceleration; it ends at 300 u/s, when you release crouch, when you jump, or when you leave the ground. |
| D-058 | **Ledge grab:** checked over the whole tick, so a fast fall can't skip a ledge; not while leaving the wall; the climb pulls you to the wall, raises you and puts you on top crouched. |
| D-059 | **Ladders and water:** defaults 2, 3 and 5; breath 16 s, then drowning. |
| D-060 | **Fall damage:** from the landing speed, the same at any frame timing; first damage is at least 1 HP. |
| D-061 | **Solid players** (answer 2): the server's player order; what your screen collides with; contact nudges counted on their own; an exact replay check of every server tick; boots and stomps (defaults 9–11); the boot-rewind difference logged until M6. |
| D-062 | **Presentation from M8:** trail, placeholder sounds, landing dip, HP and stamina (defaults 12, 13, 15). |
| D-063 | **Tuning tools:** presets, `cvardiff`, recorder and ghosts, strafe helper (default 14), probe drawings, `?map=`. |
| D-064 | **Feel report and tests:** four courses, the full `docs/03` §8 table, two target columns, the mechanics-tour bot, and the acceptance guard learning to read "MV-01…MV-20". |
| D-065 | **Courses:** the M4 yard on `movement_lab` and two test ledges on `jump_lab`. |

## New settings (highlights; the full table with labels and sources is in the design §4.1)
- **Existing settings that change default:**
  - `pm_runSpeed` 220, `pm_duckScale` 0.45, `pm_friction` 4, `pm_accelerate` ≈ 4.5 (fitted);
  - gravity for players 750 (it matches UrT's 48.5 u apex), `pm_sprintSpeed` 340;
  - wall kick 270/200; slide end 300; ledge window 58–66.1 u; climb 70 u/s;
  - fall 547.8 / 768.8 u/s; jump and kick cost 6 each.
- **New:**
  - `pm_sprintStrafe` 0, `pm_wallJumpRising` 0, `pm_wallJumpCancel` 0;
  - weak kick 170/100 below 12 stamina, `pm_slideDecel` 125, climb ramp 750, re-grab on a fresh press;
  - `pm_fallMinDamage` 1 HP;
  - regen 20 − 0.0764 × speed, frozen in the air and while climbing;
  - low-stamina scale 0.75 below 25 stamina, weak jump 202 at 0;
  - `sv_ghostAll` / `sv_ghostTeammates` 0.
- **Labels:** every value keeps its FACT, INFERRED or ESTIMATE label, and every ESTIMATE is a setting.
- **ESTIMATEs used for the first time:**
  - wall-kick reach 10 u, minimum wall height 40 u, ledge reach 18 u;
  - fall curve 1.6, limp × 0.6;
  - boot push 120 u/s, boot cooldown 0.5 s;
  - crouch cost 2, slide cost 6, refill delay 0.5 s;
  - bandage 3 s, the water-jump values.
- **Client:** `cl_strafeHelper`, `cl_speedometerDetail`, `s_volume`, `cl_landDipScale`/`Ms`, `r_debugProbes`; F = bandage.

## How each acceptance test is covered
| Acceptance | Test |
|---|---|
| MV-01, 03–08 | Targets come from the active values. Research set: the run ramp at the fitted points, the stop, and the 66.5 u jump-up with no damage. |
| MV-02 | Sprint speed, also in the air; drain exactly 12/s; no sprint with strafe, walk, crouch, ladder, water, limp or empty stamina. |
| MV-09 | A sprint circle-jump bot reaches ≥ 540 u/s within 12 hops. The band comes from an unverified figure; if it misses, I ask you. |
| MV-10 / 11 | 3 kicks, then the 4th is refused until you land; never off players or a 24 u curb; stamina tiers; speed along the wall kept; chimney gains 120–160 u; an apex kick reaches a 118.75 u grab, never 120 u. |
| MV-12 | A slide needs crouch pressed in the air at speed; strafe steers it; a jump keeps the speed; leaving the ground ends it; it fits under a 41 u bar. |
| MV-13 | Catches a 768 u fall with no damage; grabs exactly inside the window at every frame timing; UrT's 60.375 u and 114.625 u limits; climbing under a low ceiling. |
| MV-14 | Every stamina cost is exact; the refill rule; frozen where the rules say; the weak jump; the vest; the maximum follows health. |
| MV-15 | A 200.125 u drop costs 1 HP and 200 u nothing; 394.125 u kills and 394 u doesn't; legs at about 282 u; limp; bandage; no damage into water or onto no-damage floors. |
| MV-16 | A stomp kills at broken-legs speed and the stomper is unhurt; a boot does 20 HP with knife, sidearm or grenade, airborne, with a cooldown; mutual boots both land. |
| MV-17 / 18 | Breath 16 s, then death in exactly 8 s; water-jump over flush and raised rims. Ladder from the top; a jump at the foot never hangs; a ladder catch stops a fall. |
| MV-19 / 20 | 10,000 ticks bit-identical with two players. The recorded mechanics tour: your screen equals the server every tick, and a restart from any snapshot gives the same result. |
| NET-03 / 04 | Every mechanic joins the tour in its own increment: 0 corrections on a perfect link. At 100 ms / 1% and 150 ms / 2% loss: < 1 correction per second, mean < 2 u, **0 mispredictions**, with contact nudges reported on their own; 16 players on the arena. |
| Your feel sign-off | The kit below; increment 17 applies your changes. |

## Increments (each green, committed and pushed)
| # | What | You can try |
|---|---|---|
| 1 | Test guard, scenario records, `?map=` for offline play | http://localhost:5173/?map=jump_lab |
| 2 | Protocol 4, laid out once | "HP 100  ST 100" on screen |
| 3 | The research values, and the `movement_preset` and `cvardiff` commands | `movement_preset docs` / `research` |
| 4 | Solid players; I report the nudge numbers | Two windows bump; stand on a head |
| 5 | A deterministic power function for the fall-damage curve | — |
| 6 | Sprint and stamina; the tour starts | Shift sprints. **Feel check (answer 4)** |
| 7 | Fall damage, broken legs, limp, deaths, the F bandage | Drops on `fall_tower` |
| 8 | Wall jumps and the probe drawings | Chimney on `jump_lab`; `set r_debugProbes 1` |
| 9 | Power slide | `slide_lab` |
| 10 | Ledge grab and climb | `jump_lab` ledges |
| 11 | Ladders and water completed | Ladder from the top; out of a pool; drown |
| 12 | Goomba stomp and boot | Boot and stomp the idle dummy |
| 13 | Speed trail, sounds, landing dip, HUD, strafe helper | `set cl_strafeHelper 1` |
| 14 | Input recorder, `cmd-replay`, ghost runs, MV-20 | `cmdrecord`, `cmdstop`, `ghost` |
| 15 | The full feel report, MV-19 with two players | `pnpm feel-report` |
| 16 | Full review, `/feel-check`, `/net-check`, handoff, PR (I merge it once CI is green) | Your feel session |
| 17 | **After your feel session:** your changes become the defaults; M4 is marked done | — |

## How it will be built
- **Per increment:** an implementer, then 4–5 reviewers: spec, correctness, determinism and speed, and tests. The `movement-reviewer` joins every movement increment, and the `netcode-reviewer` joins increments 2–4, 6–12 and 14. An integrator applies the fixes.
- **Before each commit:** `pnpm typecheck && pnpm lint && pnpm test`, plus `test:movement`, `test:net`, `test:long` and `test:browser` when they're touched.
  - I report the `pnpm test` time; M4 may add at most +5 s and +15 CPU-s.
  - Long sweeps go to `test:long`.
- **Bot runs:** a 2-minute 16-bot run on a 100 ms / 1% loss link after increments 2, 3, 4, 6 and 12.
- **Each new movement branch** comes with its primer warm-up and a native-ESM no-garbage check in the same commit.
- **Docs:** each increment updates the docs its code makes true, with its decision-log entry (the design's §6 lists them).
- **Close-out:**
  - a fresh-clone run;
  - movement, netcode, performance and clean-room reviews;
  - `/feel-check` and `/net-check`;
  - the strict 2-minute 16-bot run and `pnpm bench`;
  - `/handoff` with your kit;
  - the PR to `main`, which I merge (merge commit) once CI is green, including the Windows job.

## Risks
| Risk | What I do about it |
|---|---|
| Values change after M4 (your feel session, a capture) | One formula per rule and presets; the base is settled first and felt halfway; increment 17 lands your values. |
| Solid players make your screen guess wrong near moving players | Built early (increment 4) and measured on their own; an exact replay of every server tick shows no real bug hides among the nudges; fallback options if the numbers are bad. |
| The snapshot is nearly full at 37 players (4 bits spare) | The layout is fixed once in increment 2 with build-time checks; any growth is decided in the open. |
| A new value forgotten somewhere | A field guard; the tour compares everything every tick; restarts from any snapshot. |
| A fast fall skips a ledge, or a kick reaches too high | The whole tick is checked; no grab while leaving the wall; sweeps over every frame timing and height. |
| One fitted acceleration makes walking and crouching slow to reach their caps (1–2 s) | Tests re-targeted and logged; capture item 1 settles it; it's a live setting. |
| Old NET tests were tuned on bots that hop non-stop | Those tests turn stamina costs off; load-test bots pace their hops; everything re-runs when the values change. |
| Deaths are new | Shown on everyone's screen; the respawn is a teleport, never a correction; tested. |
| `pnpm test` gets slow | Time reported per increment; long sweeps in `test:long`. |
| Clean room | Values come from the research's text and telemetry only; no UrT code or assets; synthesized sounds; a clean-room review at the end. |

## Verification and your feel-session kit
- **At the end:**
  - a fresh clone runs everything;
  - `pnpm feel-report` shows every row on target, and how far each is from UrT;
  - `/feel-check` and `/net-check` pass;
  - the 2-minute 16-bot run on 100 ms / 1% loss passes with 0 mispredictions;
  - `pnpm bench` is within budget;
  - CI is green: fast, long, browsers and Windows;
  - the full review is done.
- **Kit:**
  - **Offline, one course each:** `pnpm dev`, then `?map=movement_lab` (the M4 yard), `jump_lab`, `slide_lab` or `fall_tower`.
  - **Compare the value sets:** `movement_preset research` and `movement_preset docs`. Change any value with `set`. `cvardiff` prints your changes as a table for the decision log.
  - **Helpers:** `cl_speedometer`, `cl_speedometerDetail`, `cl_strafeHelper` and `r_debugProbes`.
  - **Your own runs:** `cmdrecord`, run, `cmdstop`, then `ghost` to race yourself. `pnpm cmd-replay <file> --set …` replays a run under other values.
  - **Bump, boot and stomp:**
    1. Terminal 1: `pnpm dev:server --map fall_tower`. Terminal 2: `pnpm dev`.
    2. Window 1: `?connect=ws://localhost:28700`.
    3. Window 2: `?connect=ws://localhost:28700&bot=idle`, a player that stands still.
  - **With bots:** `pnpm bots --server ws://localhost:28700 --count 16 --minutes 10`.
