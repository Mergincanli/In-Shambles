# 01 — Vision & Scope

> Status: living document. Owner: Mustafa. Claude Code must treat anything marked **TBD** as undecided and must not invent it.

## One-liner

A browser-native, server-authoritative arena/tactical FPS. It reproduces Urban Terror's movement and gun balance one-to-one, on an original engine, with its own look, names and twist.

## The deal: what we copy vs. what is ours

### Copy (must match UrT 4.x behavior; see `docs/02`, `docs/03`, `docs/04`)

**Movement**
- Quake-3-style ground and air physics, including strafe jumping and circle jumping (with sprint).
- Walk, run and sprint, plus a stamina pool tied to health.
- Wall jumps (max 3 before touching ground), power slide, ledge grab and climb.
- Ladders, swimming and breath.
- Fall damage, broken legs and limp, goomba stomp, and the boot (kick).

**Gun balance**
- Per-hit-zone damage table (UrT 4.3 values).
- Armor: vest and helmet.
- Bleeding, bandaging and medkit healing rules.
- Magazines, reload rules, fire modes (incl. hyper-burst).
- Accuracy model: base accuracy, spread, recoil, recovery, movement penalties.
- Scope behavior, knife, grenades and launcher behavior.
- Loadout slot rules.

### Ours (original work)

- Engine, netcode, tooling, map pipeline.
- Art direction, rendering, animation, VFX, audio, UI/UX.
- Weapon, item and character **names** and fiction.
- Maps, mode selection and rules beyond the copied mechanics.
- **The twist**, progression/meta, business model.

## Pillars (use these to settle arguments)

1. **Movement mastery.** UrT's skill ceiling. The feel *is* the spec; when numbers and feel disagree, feel (measured against reference) wins.
2. **Readable lethality.** Fast time-to-kill, hit zones matter, armor is a trade-off (vest halves stamina), bleeding creates pressure and team play.
3. **Netcode you can trust.** Fair and smooth at 20–150 ms and up to 2% loss. No rubber-banding on clean connections. Smooth on 144–240 Hz displays.
4. **Click-to-play.** URL → in a match within seconds. Small first download. Works in all current major desktop browsers.
5. **Original identity.** Our own visual language, names and twist. Never a reskin.

## Targets

- **Platform:** desktop browsers (current Chrome, Edge, Firefox, Safari). Keyboard + mouse, Pointer Lock.
- **Players per match:** up to 16. UrT's developers recommended ≤16 for a good experience.
- **Session model:** public servers + private match links. Accounts optional until a later milestone.
- **Performance:** see `docs/10` (frame-time, tick-time and bandwidth budgets).

## Non-goals for v1

- Iron sights / ADS. UrT used a crosshair only; scopes exist for scoped weapons.
- Leaning, going prone, bullet drop, bullet penetration (none of these existed in UrT).
- Vehicles, destructible environments, PvE, battle-royale scale, mobile/touch, gamepad.
- Character classes, perks or unlock-gated weapons. UrT had none; anything in the loadout is selectable.

## Open decisions (owner: Mustafa)

| ID | Decision | Status | Notes |
|---|---|---|---|
| O-1 | Working title and branding | **Decided**: working title "In Shambles" | See D-014. Must not use "Urban Terror", "UrT" or "FrozenSand" (trademarks of Frozensand Games Ltd). |
| O-2 | Weapon/item naming direction | **Exploring**: Italian-food names vs. slightly modified real names | Internal IDs are fixed (`docs/04` §2). Display names live in `content/names/*.json`, so switching later is cheap. |
| O-3 | The twist | **TBD** | Reserved for M10. Keep systems modular (data-driven weapons, mode rules as plug-ins). |
| O-4 | Art direction | **Decided** — see `docs/08` | "Comic Noir" (D-013). Reference research: `docs/08a`. |
| O-5 | Business model and license | **TBD** | Default assumption until decided: closed source, free-to-play, **no GPL code**. |
| O-6 | v1 game modes | **Proposed**: FFA, TDM, Team Survivor (rounds), CTF, Movement Trials (timed courses) | Modes are "ours"; these are suggestions. |
| O-7 | Hosting regions | **TBD** | Proposal: start with one EU region (NL/DE), add more later. |
| O-8 | Max players and team sizes | **Partly decided** (D-034): up to 64 players per match, `sv_maxClients` default 32; 5v5 for round modes still proposed | Budgets (`docs/05` §9.2, `docs/10` §4) are set for 16 players. Until the byte-budget scheduler (D-046) a match admits at most 37, so every snapshot fits 1100 B (`docs/05` §2). |

### Guidance for O-2 (naming)

- **Names should telegraph the role**, by shape or character. If Italian food, pick foods that "look like" the weapon: a long, thin *Grissino* sniper, an *Arancino* frag grenade, a small fast *Espresso* SMG, a fat *Mortadella* LMG.
- **Always pair the name with a plain type tag** in UI and killfeed (e.g., "Grissino · Sniper"). A flavorful name means nothing to new players otherwise. Arc Raiders does this: evocative names, each with a type label.
- **Tone is an art-direction decision.** Food names push the game playful; the art, UI copy, VO and VFX must commit to the same tone.
- **Slightly modified real names** (a known pattern; e.g., older Counter-Strike buy menus) read instantly but keep each gun tied to real-world expectations. That fights you when balance (copied from UrT) doesn't match the real gun.

## Glossary

| Term | Meaning |
|---|---|
| UrT | Urban Terror; the reference game, 4.3.4 being its final Quake-3-engine release. |
| pmove | The player movement step (our implementation of Q3-style movement). |
| u | Map/game unit; 1 u = 1 inch. |
| Tick | One fixed simulation step (1/60 s). |
| Snapshot | Server → client state update for a tick. |
| Lag compensation | Server rewinds other players' hitboxes to what the shooter saw. |
| HTK / TTK | Hits-to-kill / time-to-kill. |
| FACT / INFERRED / ESTIMATE | Confidence labels on numbers (see `docs/02` §0). |
