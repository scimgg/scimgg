# Fortis Colosseum: open questions (waves 1–11)

What the evidence does not settle, where sources disagree, and what was never observed. Facts and
citations are in the [facts spec](./fortis-colosseum-facts-spec.md); the simulator's choice for each
gap is in the [policy](./fortis-colosseum-policy.md). Wave 12 (Sol) has its own register,
[`sol-heredit-unverified.md`](./sol-heredit-unverified.md). Capture aliases A, B, C, K and the Wiki
shorthands (W-Main, W-Strat, W-Mod, W-NPC, W-News) are as in the facts spec.

## A. Unexplained capture observations

| ID | Summary | Evidence; hypotheses considered | Would settle it |
|---|---|---|---|
| A1 | **Spawn-point rule: radius and decision tick.** W-Strat says the start tile keeps NPCs from spawning "too close" and that clicking on the 5th tick keeps them out of "the west area"; the simulator leaves out points within Chebyshev 4 of the player's tile at the start of T0 | Every used point was at least 6 from that tile (82 spawns), so the radius is under 6, and the west area being kept clear from (23,36) (A2) needs at least 4; B:1862 puts the decision after T0−3. Not separated: radius 4 or 5, the metric (Chebyshev, Euclidean and Manhattan all fit), SW tile or footprint, and T0−2, T0−1 or T0. C waves 1–4 used only the three points farthest from the player (8/8, p ≈ 2×10⁻⁵ under the rule with all 12 points), which no single radius squares with (29,37) at 6 from (23,36); treated as chance | Wave starts with the player 4–6 tiles from a point, and walking off one on T0−2 or T0−1 |
| A2 | **Resolved by maintainer decision: the other three "default spawns".** W-Strat and W-Mod say 12; only nine occur in A, B and C | The three, (19,32), (25,34) and (19,37), were observed in third-party encounter recordings (not redistributed), used by both the shaman and the 3×3 species; both footprints lie on the floor at each. All three are on the west side, within Chebyshev 4 of the Wiki's start tile (23,36), so the avoidance rule (A1) keeps them out from where the captures' player mostly stood, matching W-Strat's "the west area". The maintainer chose to place them from that source | — (resolved; a first-party capture with the player away from the west side at T0 would confirm them) |
| A3 | Warband anchor distribution | 23 distinct centers in 28 waves, inside a 7×7 box (berserker x 29..35, y 34..40); not obviously player-relative | Many more wave starts |
| A4 | Reinforcement x choice among (31..33, 48) | Two together always take distinct x; no type↔x mapping | Many more reinforcement waves |
| A5 | **Minotaur heal limits.** One positive case; every negative is explained by the Wiki rule (facts spec §6.5), but the radius (W-Strat 6 vs the quoted 7, or 8) is not separated, and only one heal shows what a heal targets and restores | C:2478 heals a javelin at 4.5% from 3 tiles; no captured enemy sat 6–8 tiles from a ready minotaur with center line of sight | Hurt enemies kept 5–8 tiles from a minotaur, out of its melee reach |
| A6 | Minotaur heal action delay: 10 ticks | C:2487 adjacent, first melee C:2488 = heal + 10 (one witness) | More heals followed by melee reach |
| A7 | Spawn lockout | No attack before add+3 (javelin, shaman, minotaur); shockwave and jaguar never had the chance earlier than add+5, so their add+3 is the shared rule, not observed. The manticore's spot → charge delay of 4 is fitted. A fixed lockout and a target-acquisition delay predict the same samples | An NPC spawning in reach with line of sight, tick-logged |
| A8 | Serpent shaman hit tick at d 9–10 is cast+4, although floor(end/30) gives +3 (end 103/107). d ≤ 8 is +3, also with end 99 | 241 casts. The colossi's floor(end/30) rule does not fit the shaman | — (the observed table is used) |
| A9 | Two shaman deaths start at K+3 (A:1286→1289, B:2473→2476), not K or K+1 | No cause found; they are also the only shaman ticks the movement model misses | More shaman kills with the player's attacks logged |
| A10 | Jaguar movement when the player is under its 2×2 footprint, and its diagonal tie-breaks | 25 of 595 greedy decisions unmatched (C:1610–1625, C:1885–1887, C:1609, C:1730) | A trace with the player under a jaguar |
| A11 | Colossus movement residue and manticore steps | Javelin and shockwave replay 7,572/7,581 ticks; two stalls (B:2742, C:3367) are unexplained. Manticores take the same step but were not replayed on their own | A manticore step replay |
| A12 | Minimus when the tile north of the player is blocked | Always free in 27/27 | An intermission with the player south of a wall or NPC |
| A13 | Shockwave prayer timing | Consistent with launch-time protection (9/9 off-at-landing zeros), but no witness of off at launch and on at landing | One such cast |
| A14 | Javelin artillery release turn: T+3 or T+4 | A death on T+3 cancels (A:915 → A:918); deaths on T+5 do not (A:2124, C:3359); nothing died on T+4 | A colossus killed on T+4 of an artillery cast |
| A15 | **Does a diagonal player suppress the heal?** The Wiki's "melee range" includes diagonal; the minotaur swings only cardinally (66/66). The simulator heals with the player diagonal | Never captured | A ready minotaur with the player diagonal and a hurt enemy in reach |

## B. Contradictions between sources

| ID | Conflict | Winner and why | Status |
|---|---|---|---|
| B1 | Minotaur heal radius: Mod Arcane (quoted on W-NPC Minotaur) ≤ 7 tiles inside a 10-tile scan vs W-Strat "within 6 tiles"; heal amount "to full" (W) | Neither separated; the quote's center ≤ 7 with center line of sight explains every capture witness and is the more specific source. Its 10-tile scan adds nothing once both radii are measured from the center | open (A5) |
| B2 | Serpent shaman max hit: infobox 28 vs W-Strat 27 | Infobox, which the capture's 28 at C:1871 reaches | settled |
| B3 | Manticore max hits: infobox 31 / 36 / 31 vs W-Strat "34 per hit"; captured melee 33 under Relentless III | Infobox; 33 is consistent with a Relentless max-hit bonus | open (distribution) |
| B4 | Javelin artillery: W-NPC "lands a few ticks afterwards" vs W-Strat "6 ticks afterwards"; damage "up to 40 typeless" (W-Strat) | Captures fix the cues (target T+2, shadow T+3, blast T+6), not the damage | open (C2) |
| B5 | Javelin cadence: "every five attacks" (W-NPC) vs "after every four auto-attacks" (W-Strat) | Same rule: R R R R A in 34/34 instances | settled |
| B6 | Warband cycle: infobox attack speed 6 vs cache param 5 | The captured fixed 6-tick cycle | settled (Sol facts) |
| B7 | Reentry III's extra tile: "west of the second tile" (W-Strat) vs "west of the targeted tile" (W-Mod) | Neither; Reentry is unobserved and deferred | open |
| B8 | Bees damage: W-Mod "up to 10" vs Bee Swarm article and W-Strat "15-20" | Existing Sol policy ([Sol register](./sol-heredit-unverified.md)) | unchanged |
| B9 | Offer cut-offs: W-Mod says Dynamic Duo, Mantimayhem, Reentry and Red Flag are not offered after wave 11; only Mantimayhem has a news post (W-News, 24 Apr 2024) | Consistent with A and C/K (none offered after wave 11); followed as policy | open |
| B10 | Archer and seer articles: the warband appears every wave "except wave 12 without Quartet"; the berserker article and W-Main omit the caveat | Sol's existing Quartet rule | unchanged |
| B11 | Glory for wave 12: Wiki *Glory* 1,200 vs ClientScript `colosseum_intermission_2_summary_draw` 100·12 + 1000 = 2,200 | Glory is not simulated | deferred |

## C. Never observed

| ID | Question | What the evidence gives | Would settle it |
|---|---|---|---|
| C1 | **Wave-1 reinforcement.** Does a slow wave 1 get the jaguar W-Strat lists? | Both captured wave 1s ended before T0+66 (T0+28, T0+51) | A wave 1 kept alive past T0+66 |
| C2 | **Javelin artillery damage**: value, distribution, Doom +2, exact tile and tick of the check | 0/74 casts damaged the player; only a 1×1 check on the start-of-T+6 tile fits every miss | A deliberate stand-still on the target tile, unprotected and with Doom |
| C3 | **South-gate reinforcements**: the tiles, the distance measure and the decision tick of the "closest gate" rule (W-Main). The simulator mirrors the north footprints (SW y = 22 − size), measures SW tile to (32,48) / (32,19) at the start of T0+66 and sends ties north | Every captured reinforcement entered north at y = 48 (38/38). C:1600 had the player on (42,34), nearer the south gate's opening than the north's (16 against 17), yet the jaguar came north: either the measure is not to the openings or the decision is earlier (the player was on (43,36) at the start of T0+64) | Waves with the player south of center at T0+66, and one on y 33–35 |
| C4 | **Same-tick clear**: are reinforcements "automatically killed" (W-Main, W-Strat) or never spawned when the wave clears on T0+66, and does clearing early cancel pending reinforcements? | Only wave 1 was cleared before +66, and no reinforcement appeared (C1) | A clear on or just before T0+66 |
| C5 | **Offer probabilities**: weights, per-modifier wave gates other than Red Flag and Dynamic Duo, and whether the wave-0 offer is fixed | 30 offers in three runs; three distinct ids, never a maxed or owned single, upgrades often but not always offered | Many runs; no recoverable algorithm |
| C6 | **Max hits and distributions**: jaguar (one unprayed 0/0/0 attack), minotaur (never unprayed), shockwave (one 21), manticore (3 samples), javelin (9, max 46), shaman (10, max 28) | Wiki infobox maxima only | Unprayed damage logs at fixed gear and Relentless ranks |
| C7 | Manticore overlap (one not yet ready when the other throws: delayed or not), orbs after line of sight is lost mid-throw (one case, A:2864), and the copy condition between paired manticores | Pairs always alternated 5 apart and shared one order (6/6); every blocked tick fits the Wiki's "ready" wording and a broader one equally; the copy condition (other within 15 tiles with sight) and "random if the first dies" are untested | Paired manticores peeked one at a time |
| C8 | **Mantimayhem, Reentry, Dynamic Duo, Red Flag**: picked in no capture | W-Mod tier text only. Dynamic Duo's partner "spawns near the main Colossus, but not necessarily on one of the 12 default spawns" (W-Mod); the simulator's nearest-legal-tile placement (south, then west) is policy. Red Flag's 12813 routes and does not block others (W-Strat); its speed, whether others still block its steps, its step out from under the player and its no-route fallback are policy (`minotaur.ts`). Mantimayhem and Reentry are not simulated | Runs taking each |
| C9 | Volatility III's temporary molten pool in waves | Pools are replaced at Tc (A:4868–4869); damage and lifetime not established for waves | A Volatility III wave tanked on a pool |
| C10 | Shaman poison or venom on hit | Untestable: the recorder held poison immunity throughout | An unprotected capture without antipoison |
| C11 | Intermission time-out | Longest captured 197 ticks, none forced | A long idle intermission |
| C12 | Meaning of NPC 12820 `COLOSSEUM_SAFESPOT_DYING` ("Pillar", size 3) and of cache param 26 = 4 on minotaur 12813 (12812 has 2) | Absent from every capture | — |
| C13 | Reinforcement first step at +68/+76 instead of +67 for three shamans (C:1864, A:4311, C:3511) | Probably blocked steps; not checked | Replay with NPC occupancy |
| C14 | **Frailty and current HP**: when the maximum drops, is current HP clamped to it or set to it? | The player was at full HP at every captured change (B:2975, C:3064, K:3992) | A tier change taken while injured |
| C15 | Frailty III from base 99 = 60 | Wiki only; no III change captured | A Frailty III pick |
| C16 | Volatility gibs for the jaguar warrior (12810) and the Red Flag minotaur (12813) | No Volatility capture has a jaguar wave or Red Flag | A Volatility run through waves 2–6, and with Red Flag |
| C17 | Solarflare hits pending at completion | No departure on the tick before a completion was captured | — |
| C18 | Doom from javelin artillery: W-NPC and W-Strat say two stacks (a bug); the splat and message for a double stack are unseen | No artillery hit the player | Same as C2 |
| C19 | Serpent shaman walk-in with the player adjacent on add+1: does it still step? | No capture has it; the simulator stops on melee contact (MODEL) | A shaman spawning next to the player |
| C20 | Totemic targets and totem removal: is every wave fighter, warband and Quartet member included, eligible? Is the totem removed on its target's death tick or 0–1 ticks later? | Run A's 55 totems; the captured removal is 0–1 ticks after the target dies (5 at +0, 7 at +1 among unkilled totems); the simulator removes it on the death tick | More Totemic waves, with warband members taken below half HP |
