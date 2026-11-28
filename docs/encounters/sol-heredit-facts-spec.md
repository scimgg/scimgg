# Sol Heredit — facts spec

What the captures establish, separated from published rules and simulator models.
Detailed derivations are in [`sol-heredit-capture-analysis.md`](./sol-heredit-capture-analysis.md).
Every implemented assumption, extrapolation and known omission, and the recording that would
settle it, is in the [unverified behavior register](./sol-heredit-unverified.md).

## Captures

The captures are private; the facts the tests use are extracted into
`src/encounters/solHeredit/__tests__/fixtures/`, `src/npcs/colosseum/__tests__/fixtures/` and
`src/encounters/colosseum/modifiers/__tests__/fixtures/`. All seven are contiguous over the listed
ticks. C and K are one run: K continues C at wave 12 (C:3728..K:3958 is not captured). The wave
captures are described in the [Fortis Colosseum facts spec](./fortis-colosseum-facts-spec.md#sources).
Sim coordinates are world coordinates minus `(1792, 3072)`.

| Alias | File | Ticks | Contents | Outcome |
|---|---|---|---|---|
| K | `colosseum-sol-heredit-packet-data.txt` | 3959..4237 | Sol, wave 12 of C's run; Frailty and Doom records present | Sol killed |
| M | `colosseum-sol-heredit-solar-flare-doom-volatility-packet-data.txt` | 8266..8537 | Sol; Solarflare I, Doom, Volatility | Sol killed |
| N | `colosseum-sol-heredit-packet-data-2.txt` | 7279..7796 | Sol; Doom and Volatility records present | Sol killed |
| L | `colosseum-sol-heredit-long-fight-packet-data-3.txt` | 3422..5848 | Sol; Relentless II from L:3440 (stacks 1→2), Solarflare | Sol killed |
| A | `colosseum-waves-1-12-damage-trials-solarflare3-volatility3-bees1-totemic-doom1-death-packet-data.txt` | 770..5369 | Waves 3–11 and Sol (it opens in the wave-3 intermission; first `Wave: 3` at A:837); Solarflare III, Volatility III, Bees I, Totemic, Doom; Relentless rank 0 throughout | Player death at A:5308; Sol not killed |
| B | `colosseum-waves-bees-death(no-sol)-packet-data-1.txt` | 1821..3435 | Waves only; Bees I at wave 5 (B:2356), II at waves 6–7 (B:2625), III at wave 8 (B:3342); Relentless III from B:2032 (in force from wave 3, B:2037); antipoison active (negative `poison` varp) | No Sol fight |
| C | `colosseum-no-sol-packet-data.txt` | 1418..3727 | Waves 1–11, ending in the 11→12 intermission; K continues the same run | No Sol fight in C (Sol killed in K) |

| Sol fight | K | M | N | L | A |
|---|---|---|---|---|---|
| Control tick | 3998 | 8273 | 7302 | 3451 | 4976 |
| Death spotanim `2680` | 4221 | 8512 | 7781 | 5833 | — |
| Fight length from control | 223 | 239 | 479 | 2382 | 332 (player death) |

K/M/N Relentless ranks are unknown because no stack changes are recorded. No capture contains
inventory or equipment packets. Run A also supplies the Sol Bees I spawn (NPC63415, A:4984) and the
tier-III Solarflare spawn A:4979 / first step A:4980.

**Control is the tick Sol spawns**, in all four kills: `busy (12393)` goes 1→0 on exactly the tick
`colosseum_sol_p1` is added. In K, `busy` toggles four times earlier (t3967, 3979, 3987, 3992):
those are the walk-in and the lobby, not the fight.

## Timing verification ledger

**VERIFIED** means agreement within the cited captures, not proof of universality;
exceptions are retained explicitly. **SINGLE-OBSERVATION** means only one discriminating sample.
**WIKI-ONLY** means a published rule without capture verification. **UNVERIFIED** means the rule
or boundary is not established. **MODEL** means an implemented fit or assumption, not a recovered
server law. **CAPTURE-FIT** means a model that reproduces every cited sample. **DERIVED** means a
consequence of other cited rules, not observed directly. **CACHE** means a game-cache fact.
Counts are observations of the stated property, not independent fights.

`T` is the attack warning/charge or grapple shout, `H` a triple hit, and `E` a hazard emission.
**30 client cycles = 1 tick**; visual floor time = emission + floor(delay/30). Visual timing alone
does not establish damage timing. In this table `K:L153–196` means **file lines**; `K:t3998`
means a tick. The analysis uses tick citations without the `t` prefix.

Code shorthand: **A** = [`src/npcs/colosseum/constants.ts`](../../src/npcs/colosseum/constants.ts),
**E** = [`src/encounters/solHeredit/constants.ts`](../../src/encounters/solHeredit/constants.ts).
This code-column **A** is distinct from tick-prefixed **A:…**, which denotes Run A evidence.
Other filenames are their actor or encounter owners, not additional evidence.
Wiki rules refer to [Sol Heredit](https://oldschool.runescape.wiki/w/Sol_Heredit) and the
[strategy guide](https://oldschool.runescape.wiki/w/Fortis_Colosseum/Strategies#Sol_Heredit).
Where their geometry is simplified, the captures win: the arena is the 14×14-minus-corners set, not
[Fortis Colosseum](https://oldschool.runescape.wiki/w/Fortis_Colosseum)'s 16×16 with protrusions
or the guide's "roughly 16×15"; spear prongs run until the arena clips them (6 tiles at K:t4115),
not the guide's "4×1 lines"; and the guide omits Spear 2's full forward row, which every capture
sample has.

| Timing | Value | Code | Capture evidence (n) | Status |
|---|---|---|---|---|
| Entrance → control | 6t | Encounter starts at control; entrance omitted | K:L153–196; M:L7–49; N:L84–138 (3) | VERIFIED |
| Opening taunt | control+3 | E `SOL_OPENING_TAUNT_TICK` | K:t4001, M:t8276, N:t7305 (3) | VERIFIED |
| Initial attack readiness | control+5, reach-gated | E `SOL_FIRST_ATTACK_TICK` | K +5; M +6, N +8 after approach (1 discriminating sample) | SINGLE-OBSERVATION |
| Initial movement release | control+6 | E `SOL_OPENING_HOLD_UNTIL_TICK` | N:L138–293 (1); M holds through +5 | SINGLE-OBSERVATION |
| Fight/phase opener identity | spear | `attackScheduler.ts` | K:L1340; M:L904; N:L4707 and other openers (18/18) | VERIFIED |
| Spear cooldown | 7t slow / 6t fast | A `SPEAR_COOLDOWN_TICKS`, `FAST_PHASE_COOLDOWN_REDUCTION` | Uninterrupted slow/fast pairs (22/33) | VERIFIED |
| Shield cooldown | 6t slow / 5t fast | A `SHIELD_COOLDOWN_TICKS`, `FAST_PHASE_COOLDOWN_REDUCTION` | Uninterrupted slow/fast pairs (19/28) | VERIFIED |
| Regular warning → ground | +3t | A `TELEGRAPH_TO_GROUND_TICKS` | All ground bursts (114: K 25, M 29, N 60) | VERIFIED |
| Spear/shield damage | +3t, pre-movement tile | `sol.ts` local effects | N:t7386/7565/7716/7763 (2 each) | VERIFIED |
| Regular damage roll | no accuracy roll; max of two independent uniform 0..44 rolls; no Relentless bonus | `sol.ts`, A `REGULAR_AOE_MAX_HIT` | 37/37 unprayed exposures hit (L 25, N 4, A 8); L:5538 = 5, L:4551 = 7 contradict a floor near 8; all 25 Relentless-II L hits ≤44 | 37/37 sampled exposures hit; no accuracy roll and the distribution are MODEL, minimum 0 |
| Regular protection window | none; typeless | `sol.ts` local effects | No controlled prayer comparison; Wiki only | WIKI-ONLY |
| Spear movement release | T+6 | `sol.ts` movement lock | Boundary samples (12) | VERIFIED |
| Shield movement release | T+4 | `sol.ts` movement lock | Boundary samples (12) | VERIFIED |
| Pursuit | ≤2 steps/tick, observed Wiki-order routes | `sol.ts` pursuit profile | K/M/N replay (922 living frames); analysis §10 | VERIFIED |
| Triple hit offsets | short +3/+6/+9; long +3/+6/+10 | A `TRIPLE_HIT_OFFSETS_SHORT/LONG` | Complete triples (4 each) | VERIFIED |
| Successful triple prayer | activation processed on hit tick | `sol.ts` local effects | K/M/N blocked hits (25); A:5193/5242/5245/5285/5288/5291 (six listed zero hits) | VERIFIED |
| Early/held triple prayer disable boundary | off at H-1; no earlier cutoff inferred | `sol.ts` local effects | A:5186/5247 activation is cleared that tick with eager-prayer message; full hits A:5187/5248 | VERIFIED for H-1; earlier boundaries UNVERIFIED |
| Triple prayer re-enable | failed H refuses H; after Sol drops an early prayer, refused through the following hit (or H when last) | A `TRIPLE_PRAYER_LOCKOUT_TICKS`; `sol.ts` early-prayer lockout | A:5248 injured/rejected, A:5249 allowed after the last hit; A:5186 drop then A:5193 block. No click timestamps | UNVERIFIED model within these bounds |
| Blocked triple hitsplat | 0 on H | `sol.ts` local effects | Zero hitsplats (25) | VERIFIED |
| Triple damage | fixed short 15/25/35; long 15/30/45; add Relentless +1/+3/+6 on unprayed hits | `sol.ts`, A `TRIPLE_DAMAGE_SHORT/LONG`, `RELENTLESS_MAX_HIT_BONUS` | A:5148/5151/5154/5187/5190/5248 short base hits; II: L:4511 = 28, L:5584 = 18, L:5150/5201/5400 = 48 | VERIFIED short base and II +3 on sampled indices; other long base/I/III values WIKI-ONLY |
| Triple → next action | 11t after short phase-2 triple (75–50%); otherwise 12t | A `SHORT_FAST_TRIPLE_COOLDOWN_TICKS`, `TRIPLE_COOLDOWN_TICKS`; `attackScheduler.ts` | Fast short 10/10 (L:4575→4586, L:5105→5116, M:8380→8391); slow short 15/15; long 17/17 (L:5140→5152) | VERIFIED |
| Triple movement release | T+1: no additional root after launch; retained later locks still apply | `sol.ts` movement lock | Long chases when player leaves reach: L:5581→5582, L:5628→5629, L:5191→5194, L:5444→5447 (4/4); no short-triple escape samples (0/25) | VERIFIED long; UNVERIFIED short |
| Special selection ramp | No phase-0 specials; first special 25%; afterwards 0 below g=2, then min(60%, 2% + 7.5% × (g−2)); g counts regulars since special, including forced openers | A `FIRST_SPECIAL_CHANCE`, `SPECIAL_CHANCE_AFTER_REFRACTORY`, `SPECIAL_CHANCE_STEP`, `SPECIAL_CHANCE_CAP`; `attackScheduler.ts` | 358 eligible K/M/N/L slots; observed 5/97 at g=2–3, 21/101 at g=4–6, 23/46 at g≥7; no phase-0 specials (0/104); first-special 4/16 | MODEL; cap and exact law UNVERIFIED |
| Special type split | Grapple share 10/38 (~26%) once unlocked/available; otherwise triple | A `GRAPPLE_SHARE_OF_SPECIALS`; `attackScheduler.ts` | 10 grapples of 38 specials below 75% across K/M/N/L | MODEL |
| Minimum regulars between specials | 2, after each triple or grapple | A `SPECIAL_REFRACTORY_REGULARS` | 0/98 slots at g=0–1; L:5628 triple → shields 5640/5645 → triple 5650 disproves minimum 3 | MODEL refractory rule; two-regular gap VERIFIED |
| Grapple shout → visual | T+1 | `sol.ts` grapple clip delay | Delay 30 cycles (4) | VERIFIED |
| Grapple window/result | Closes T+4; correct defence resolves immediately on its processing tick | A `GRAPPLE_WINDOW_TICKS`; `grapple.ts` | L:4698→4701 early success at T+3; nine perfect results at T+4 across K/M/N/L | VERIFIED early resolution (SINGLE-OBSERVATION); VERIFIED T+4 results |
| Grapple early/perfect click boundary | Before T+4 defends without reward; T+4 perfect; code accepts processing ticks T..T+4 | `grapple.ts` / `sol.ts` | L:4701 success at T+3; L:4858/5007/5291/5482/5544 perfect at T+4; other early/late inputs not isolated | VERIFIED sampled T+3/T+4; other boundaries UNVERIFIED |
| Perfect-parry reward duration | 5t per Wiki | A `PERFECT_PARRY_REWARD_TICKS` | No expiry trial | WIKI-ONLY |
| Reward endpoints/consumption | unestablished | `sol.ts` reward handling | Timestamped reward trials (0) | UNVERIFIED |
| Grapple attack cooldown | T+7, even after early defence | A `GRAPPLE_COOLDOWN_TICKS` | 10/10 K/M/N/L, including M:8436→8443 and L:4698→4705 | VERIFIED |
| Grapple readiness | T+1 model | `sol.ts` `grappleReadyTick` | No isolating trial | UNVERIFIED |
| Grapple movement release | T+5 | `sol.ts` movement lock | Boundary samples (2) | VERIFIED |
| Grapple wrong clicks | Wrong slot has no negative impact; correct slot can still defend on the same or a later tick within the window | `grapple.ts` / `sol.ts` | L:4701 wrong-part message then success in the same tick | Same-tick recovery SINGLE-OBSERVATION; cross-tick recovery simulator policy, UNVERIFIED |
| Grapple equipment/failure | Uniform target-slot choice; empty clicks cannot defend; pending slot clicks do not unequip; failure rolls the higher of two 0..44 rolls, no Relentless; item stays equipped | `grapple.ts` / `sol.ts`, A `GRAPPLE_FAIL_MAX_HIT` | No inventory/equipment packets or failed grapples in any capture; fully unequipped targeting claim untestable | MODEL weights; failure damage and item-strip omission are simulator policy; empty-slot/no-unequip WIKI-ONLY |
| HP phase thresholds | 90/75/50/25/10% | `phases.ts` | Compatible transitions (15), exact-boundary experiments (0) | WIKI-ONLY |
| Transition scheduling/resume | next attack slot; resume taunt+7 | E `TRANSITION_ATTACK_RESUME_TICKS`; encounter scheduling | All transitions (15); analysis §11 | VERIFIED |
| Transition movement release | taunt+5 | `SolHereditEncounter.ts` movement lock | Boundary samples (7) | VERIFIED |
| Overlapping transitions | consecutive slots model | `SolHereditEncounter.ts` | Double-threshold crossings (0) | UNVERIFIED |
| Transition invulnerability | none in model | `SolHereditEncounter.ts` | Damage in 10 windows does not test every tick | UNVERIFIED |
| Transition sand/crystal emission | taunt+1 / taunt+2 | E `TRANSITION_SAND_DELAY_TICKS`, `TRANSITION_CRYSTAL_DELAY_TICKS` | Sand/crystal transitions (15/12) | VERIFIED |
| White forming pool (spotanim 2698) visual onset | E+1 | `moltenSand.ts` visual delay | Delay 30 cycles (34) | VERIFIED |
| Pool LOC appearance | E+5 | E `SAND_POOL_DELAY_TICKS` | Completed pool batches (29) | VERIFIED |
| Sand damage onset | E+3, against the tile the player starts the tick on, forming or formed | E `SAND_DAMAGE_ONSET_TICKS` | Moved off during E+1 (K:4106/4161/4200, A:5132) or E+2 (K:4023, A:5222, M:8460): no hit (7). Single positive fit: K E=4064 → hit 4067 (8 damage), the player on the struck tile at the end of E+2; source inferred by elimination | Consistent with 7 negatives and one positive fit |
| Sand damage interval | every tick per Wiki | `moltenSand.ts` | No sustained tanking sample | WIKI-ONLY |
| Pool lifetime | Until death in model; observed ≥1,853t without expiry | `moltenSand.ts` | L:3982..5835 earliest pool; all 47 survive to death and cleanup, agreeing with K/M/N | VERIFIED lower bound; longer natural expiry UNVERIFIED |
| Enrage drip grid | 3t | E `ENRAGE_SAND_INTERVAL_TICKS` | Observed grid gaps (14) | VERIFIED |
| First enrage single | random +6..8 model | E `ENRAGE_SAND_FIRST_SINGLE_DELAY_TICKS` | N +6, K +7, M +8, L +7 (L:5749→5756) (4); no evidence for a random law | MODEL; distribution UNVERIFIED |
| Beam warning → charge | +3t; in an ordinary fight, warnings go out on Sol launches, including grapples | E `BEAM_PREPARATION_LEAD_TICKS` | 26 K/M/N warnings plus 57 L; grapple warning L:5478 | VERIFIED |
| First crystal → charge | spawn+8 | `beams.ts` | First crystals (3) | VERIFIED |
| Beam charge → fire | 4t ordinary / 3t enraged | E `BEAM_CHARGE_TICKS`, `BEAM_ENRAGE_CHARGE_TICKS` | Completed rounds (19/5) | VERIFIED |
| Beam readiness | Post-fire uniform 22–29t in phases 0–4; 5t enraged; in an ordinary fight the next eligible Sol launch warns | E `BEAM_READY_DELAY_TICKS`, `BEAM_ENRAGE_READY_DELAY_TICKS`; `beams.ts` | K/M/N/L/A conditioned replay; the pooled skipped/warned bounds show no phase dependence (e.g. L:4172 needs (26,32], L:5647 (20,25]); bounds, not a measured random law | MODEL; distribution/endpoints UNVERIFIED |
| Beam enrage reset | Idle clock ready immediately; already prepared/charging round unchanged | `beams.ts` `enrage` | K:4199→4206, N:7724→7731, L:5748→5755 accelerate; M:8501→8508 consistent | VERIFIED acceleration; MODEL exact reset |
| Beam reach/grapple coupling | In an ordinary fight, warnings follow Sol's attack gate; grapple can carry one | `beams.ts`, `sol.ts` | Grapple L:5478 carries warning; deliberate out-of-reach trials absent | VERIFIED grapple warning; reach coupling UNVERIFIED |
| Beam damage timing | Select fire-tick start tile; deliver at fire+1, without rechecking tile | `beams.ts` `fireIfDue` / `takeHitIfDue` | L:5583→5584 beam 67 plus separate long-triple 18; step-on misses L:5409/5446/5744. A:5184 unexplained: launch suppression, index-ordered underfoot check or i≤9 range remain undistinguished | VERIFIED timing (SINGLE-OBSERVATION positive); exception UNVERIFIED |
| Beam damage roll | Higher of two inclusive 40..(75+Relentless bonus) rolls, floor stays 40; one hit at line crossings, no prayer reduction | E `BEAM_MIN_HIT`, `BEAM_MAX_HIT`; `beams.ts` `takeHitIfDue` | Only hit 67 at L:5584 (unprayed, II); distribution, bonus, crossing multiplicity and prayer immunity untested | Simulator policy, capture UNVERIFIED; see the [damage register](./sol-heredit-unverified.md#damage-rolls) |
| Crystal first step | spawn+4 on edge low end; +3 otherwise | `crystal.ts` | L:3978→3982, A:5133→5137, N:7570→7574 (3/3 low-end); other spawns 15/15 at +3 | VERIFIED |
| Crystal patrol/hold/resume | 1 tile/2t; hold from warning; resume fire+3 ordinary / +2 enraged | A `CRYSTAL_STEP_INTERVAL_TICKS`; E `CRYSTAL_RESUME_AFTER_FIRE_TICKS`, `CRYSTAL_ENRAGED_RESUME_AFTER_FIRE_TICKS` | Three capture timelines; analysis §10 | VERIFIED |
| Visual propagation | melee 2 cycles/ring; beam 3 cycles/tile, impact delay 39 | `solAttacks.ts`, `crystal.ts` | Repeated tile-delay agreement; analysis §§1,2,7 | VERIFIED |
| Audio delays | beam warning 75 / fire cue 210 ordinary, 180 enraged cycles | `solHereditAudioRules.ts` | Warning pairs (26); other effect delays in analysis §7 | VERIFIED |
| Regeneration | first control+101, then every 100t | `sol.ts`, `npcRegeneration.ts` | K/M/N HP increments (7; N's first opportunity was at full HP); L agrees from +101 to +2201, then increments at L:5754 (+2303) | Fitted cadence; L's +2303 unexplained |
| Completion | death+9 | E `SOL_VICTORY_COMPLETION_DELAY_TICKS` | Sol removal in K/M/N (3); not a universal chest-spawn time | VERIFIED |
| Death line | D+1 | E `SOL_DEATH_CLEANUP_DELAY_TICKS`; `SolHereditEncounter.ts` | All four kills (K:4222, M:8513, N:7782, L:5834) | VERIFIED |
| Crystal cleanup | despawn sequence on D, removal D+1; the simulator removes every crystal at D+1 | E `SOL_DEATH_CLEANUP_DELAY_TICKS`; `SolHereditEncounter.ts` | Every crystal in K/M/N and all but one in L; L's crystal indexed below Sol despawns on D+1 and is removed D+2 (L:5834→5835); pinned in `beamTimeline.test.ts` | VERIFIED usual case; L exception not modeled |
| Pool cleanup | despawn animation 10814 on D and D+1, removal D+2 | E `SOL_DEATH_SAND_REMOVAL_DELAY_TICKS` | K/M/N/L (4/4), `beamTimeline.test.ts` | VERIFIED |
| Overhead expiry | 5t model | `SolHereditEncounter.ts` overhead events | No expiry measurement | UNVERIFIED |
| Input processing / lag | unestablished | Encounter input handling | Timestamped prayer/equipment inputs (0) | UNVERIFIED |
| Solarflare departure collision | start-of-tick tile on departure T; hit T+1 | `colosseum/modifiers/solarflare.ts` | Eleven hits A:1406/1508/1560/1597/1599/1891/1921/1985/2291/2311/2331; arrival-only skips A:1854/1888 | VERIFIED |
| Solarflare III prayer disable | overhead off on T, no lockout | same | A:2290 off -> A:2291 on; A:2330 off | VERIFIED |
| Solarflare tier timing/routes | I 2/7, II 2/0, III 1/2 step/corner gap | `routeRunner.ts`, Sol routes | Run A waves 5–7; Sol A:4979..5307; M tier-I timeline | VERIFIED |
| Volatility hit | explosion tick, player's start-of-tick tile | `colosseum/modifiers/volatility.ts` | A:2800/2852/3487/3592/3608/4026; leave still hits A:3260/4638, enter misses A:2979 | VERIFIED |
| Modifier damage ranges | Solarflare uniform 10–20; Volatility uniform 16–24, all tiers | shared modifier helpers | Observed values span these ranges, not enough to establish distributions | MODEL |
| Blasphemy | floor(damage/5) × tier; no Solarflare/Volatility/Bees drain | `colosseum/modifiers/rules.ts` | A:4985 36->21, A:5005 33->18, A:5030 44->24, A:4263 7->3; Solarflare/Volatility exclusions A:1508/2800/2852/3487/4026 | Formula and exclusions fit these samples; Bees exclusion simulator policy; sand interaction UNVERIFIED |
| Bees count and wave spawn | tiers 1/2/3; simultaneous, wave-message+5 | `colosseum/modifiers/bees.ts` factory | B:2361->2366, 2630->2635, 2975->2980, 3347->3352 | VERIFIED |
| Sol Bees spawn | control+8 | E `SOL_BEES_SPAWN_TICK` | A:4976 control -> A:4984 NPC63415 | VERIFIED in Run A |
| Bees spawn tiles | distinct seeded draws from nine A/B tiles | `bees.ts` | Eight B spawn positions; A:4984 adds (1828,3110); local origin 1792/3072 | MODEL distribution |
| Bees decision window | first spawn+1 or teleport+55; window+12k; crawl offsets 0/2/4/6/8/10, hold after arrival | `bees.ts` | All 320 crawls (A 31, B 289) on grid; zero off-grid | VERIFIED grid |
| Bees destination | seeded uniform valid SW tile within player ±6 at window start | `bees.ts` | 30 fully observed reached endpoints: X −2..+6, Y −4..+4; SW radii 3/4/5/6 cover 15/26/26/30; footprint-centered cover 10/18/26/26 | MODEL distribution, 30/30 support fit |
| Bees routing | exact SW destination, clear diagonal-first path or shared size-2 collision search | `npcRouteFinding.ts`, `bees.ts` | Real cache loc collision: 30/30 reached paths and tick sequences, including 4/4 non-naive detours | CAPTURE-FIT 30/30 |
| Bees under-player movement hold | no special hold; fixed destination controls stopping | `bees.ts` | No sampled window starts under player; no sampled crawl leaves from under player | UNVERIFIED; the samples cannot isolate a hold rule |
| Bees sting selection | player start tile in swarm's start-of-tick 2x2 footprint; a swarm killed on K still stings on K+1, not from K+2 | `bees.ts` | B:3098–3132 incl. double B:3109; B:3400; B:3402 kill -> B:3403 sting; no sting at B:2694/3404 or on movement-only entry B:3105/3125 | CAPTURE-FIT 15/15 stings on 14 ticks |
| Bees antipoison damage | typeless uniform 5–10 at every tier | `bees.ts` | B tier-II observed 5,8,8,10,8,5,8,9,7,8,10,9,6; Relentless III active | Observed range; uniform/tier-independent MODEL |
| Bees III damage exceptions | 12 at B:3400/3403, not simulated | — | Antipoison and Relentless III active | UNVERIFIED attribution/tier effect |
| Bees without antipoison | 10–20 and ordinary poison starting at 1 | `bees.ts`, environmental `applyPoison` | Wiki Bee Swarm oldid=15211088 says antipoison halves stings; no unprotected B sample | MODEL range; WIKI-ONLY poison |
| Bees kill -> teleport | +5 selected; actual +3/+4/+5/+6 counts 1/5/5/5 | `bees.ts` | B:3117->3122 matches; B:2425->2431 differs. Despawn sequence -> teleport is +3 in all 16 | MODEL kill-relative schedule |
| Bees teleport -> resume | +55, at full 1 HP | `bees.ts` | All 10 complete B intervals (e.g. 2431->2486, 3122->3177); overrides Wiki 30s | VERIFIED pause |
| Bees size | 2x2, SW anchored | `actors.ts` | NPC12823 cache rev232, model53132, idle/walk10822; apparent adjacent stings lie within footprint | CACHE + CAPTURE-FIT |
| Bees at Sol death | remove with crystals at D+1 | `SolModifierEffects` / encounter | B has no Sol; A has no Sol kill | Simulator policy, not capture-verified |

The size-2 footprint covers the apparently adjacent sting positions, including both B:3109 swarms.
B has 15 hitsplat-65 records on 14 ticks, all reproduced. Cache hitsplat 65 is drawn as the
ordinary `damage` splat.

Bee routing conformance
([`arenaCache.test.ts`](../../src/encounters/solHeredit/__tests__/arenaCache.test.ts)) uses the
cache-baked arena collision and is conditioned on the recorded endpoint: each window's destination
is taken from the capture. It therefore verifies the mover, not the destination sampler or the
absence of an under-player rule. The primary set is **30 complete reached windows** (1..5 steps,
all 12 ticks observed, no killing hit or removal during the window); all 30 match. Taking the last
recorded tile as the destination in all 80 nonempty windows gives **78/80** geometric paths,
including **8/10** non-naive paths, and **77/80** with exact step ticks. The misses are
death-interrupted or cut-off windows whose real destination is unknown: B:2415 NPC63828 reverses
on its killing-hit tick B:2425; B:2648 NPC34219 has six steps and stops at the cutoff; B:2733
NPC34219 matches geometry but holds one extra slot before its killing-tick crawl at B:2741. The
destination support fits 30/30 endpoints; that is not evidence of a uniform random law.

Run A caveat: A:1703 shows **13 damage -> 7 prayer**, one more than the formula's **6**. The
player toggled four protection prayers on that tick, so the extra point is most likely ordinary
prayer drain rather than Blasphemy; this is an inference, not an isolated measurement.

The conformance tests replay recorded inputs to the model. In particular,
[`beamTimeline.test.ts`](../../src/encounters/solHeredit/__tests__/beamTimeline.test.ts)
supplies K/M/N/L/A attack ticks, fitted ready-delay rolls, crystal spawn tiles and which crystals
precede Sol in NPC order, and omits K:4221's death-tick charge. Production fixes one spawn tile per
edge and does not reproduce server NPC index allocation. Passing tests do not prove autonomous timing
correctness or a random-delay law.

### Relentless (offered Sol modifier)

Relentless is offered by `solHeredit/modifiers.ts`. Its shared definition follows
[Wiki Modifiers](https://oldschool.runescape.wiki/w/Fortis_Colosseum/Modifiers#Relentless):
tiers I/II/III give **+1/+3/+6 max hit**, bypass **33%/66% Defence** at I/II,
and skip accuracy checks at III (`RELENTLESS_MAX_HIT_BONUS`,
`RELENTLESS_DEFENCE_BYPASS_PERCENT`). Sol adds the bonus to each unprayed triple
hit; II's +3 is **VERIFIED** at L:4511/5584/5150/5201/5400. I/III scaling is
**UNVERIFIED** in captures (Wiki extrapolation).

Quartet/warband attacks apply both the max-hit bonus and accuracy changes in
`warband.ts`; bypass uses current boosted Defence and floors the removed levels
(**MODEL**, warband Relentless effects capture **UNVERIFIED**). Regular Sol AoE
keeps max 44 and no accuracy roll (L's 25 Relentless-II hits ≤44); grapple damage,
sand and other modifier hazards receive no Relentless bonus. The beam's upper-bound
bonus is simulator policy, not capture-established; see the
[damage-roll register](./sol-heredit-unverified.md#damage-rolls). A generic bonus to every
scripted/environmental hit is not established by these captures.

### Fremennik warband and Quartet

Evidence: the three wave captures A, B and
`colosseum-no-sol-packet-data.txt` (`C:<tick>`,
waves 1–11, no Sol), 28 warband waves in all, local origin 1792/3072. No capture has a Sol fight
with Quartet, so every Sol-specific row below is derived or modeled.

| Fact | Value | Code | Capture evidence (n) | Status |
|---|---|---|---|---|
| Pursuit target | slot tile beside the player's start-of-tick tile, evaluated every tick; an empty fresh route does not clear the queued tail (see Leftover route) | `core/npcStickyPursuit.ts`, `npcs/colosseum/warband.ts` | 1393/1393 scored decisions (C 417, B 464, A 512) through the production helper and cache pillars, [`warbandCapture.test.ts`](../../src/npcs/colosseum/__tests__/warbandCapture.test.ts); C:1800–1801 the trio starts 1801 on its slots and still walks two queued steps | VERIFIED |
| Slot | spawn offset from the formation center (one south of the berserker): berserker N, archer W, seer E, Quartet extra S | `WARBAND_SLOT_OFFSETS` | Every wave spawn; the 4-member groups B:2201/2361/2630/2975/3347 add an S member (seer at 2201/2630/2975, archer at 2361/3347), which keeps S | VERIFIED for extra seers and archers; an extra berserker and Sol with Quartet unobserved |
| Route | plain breadth-first search, straight steps before diagonals; no straight-line shortcut | `findNpcExactTileRoute` | Diagonal-first shortcut scores 342/423/477 instead | VERIFIED |
| Speed and stop | up to 2 steps per tick, 1 when one remains; stops on the slot | `WARBAND_MAX_STEPS` | Same 1393 | VERIFIED |
| Leftover route | a fresh empty route keeps walking the previous route's tail | `NpcStickyPursuitState` | C:1801, all three members (one episode) | SINGLE-OBSERVATION |
| Blocked slot | archer/seer slot inside a pillar or wall: player's south tile | `WARBAND_FALLBACK_OFFSETS` | 145 decisions, about 31 episodes (seer 116, archer 29) | VERIFIED |
| Berserker / S-slot fallback | berserker as archer/seer; Quartet in Sol: nearest tile in melee reach, else nearest reachable | `warbandPursuitProfile` | Never observed | UNVERIFIED |
| Collision | ignores other NPCs and the player; walks through the player's tile | `npcStickyPursuit.ts` | Stacking on members and a Javelin Colossus; C:1539 crosses the player; adding NPC blocking lowers every fit | VERIFIED |
| Player underneath | still moves while it is the player's attack target | `movesWithAttackerUnder` | 13 decisions with it as the player's last attack target | VERIFIED (target from last op only) |
| Others blocked by it | does not block other NPCs | `blocksNpcMovement: false` | No discriminating sample | UNVERIFIED |
| Spawn hold | still on spawn and spawn+1, moves from spawn+2 | `WARBAND_FIRST_MOVE_TICKS` | 89/89 | VERIFIED |
| Attack cycle | spawn+phase+6k: berserker 3, seer 4, archer 5; skipped out of position | `WARBANDER_PROFILES` | Every one of the 82 captured launches is on its phase, incl. the S members; berserker 3 attacks | VERIFIED (berserker thin) |
| Attack gate | its start-of-tick tile is the destination its pursuit selects (slot, else the fallback) for the player's start-of-tick tile, one tile straight out; moving off it that tick along a leftover route does not cancel the attack | `isWarbanderAttackPosition`, `isAtStickyPursuitDestination` | 82/82 launches (78 attack sequences + 4 seer casts seen only by projectile) and 0 attacks on the other phase ticks, incl. the 79 that end one tile out (C:1644 arrival, C:1808 wrong side, A:2654 through the player); C:1801 berserker swings while walking its tail | VERIFIED |
| Kill-tick attacks | a member killed in its own hit pass keeps that tick's turn (queued death) unless its death is promoted to K: a 0 splat after the lethal hit, or a thrall indexed below it queueing a hit before its turn | `deathPolicy: 'queued'`, `canNpcActThisTurn` | All 7 admitted phase ticks that are also killing ticks: 5 swing (C:1688, B:2998, B:3356, A:2205, A:3271); the C:2142 and C:2432 archers, each promoted by a lower-index thrall, do not | CAPTURE-FIT |
| Hit delay | all next tick: archer/seer by projectile (`iron_arrow_travel` 9 / `fireblast_travel` 130, cycles 10->30), berserker melee | same | Archer 31/52 and seer 17/23 next-tick splats, the rest coincide with other sources; berserker C:1801->1802 and A:1788->1789 (9 each); B:3356's killing-tick swing shows no splat at 3357: its melee is `cancel-before-impact`, canceled by its death processed at 3357 | Archer/seer CAPTURE-FIT; berserker CAPTURE-FIT (2 swings) |
| Stats and max hits | 48/50/50 HP; stab 29, ranged 14, magic 12; speed 6 | `monsters.json`, plans | Wiki Fremennik warband berserker/archer/seer infoboxes | WIKI-ONLY |
| Weakness | berserker magic, archer melee, seer ranged hits are always maximum | `alwaysMaximumPlayerHitStyles` | Wiki | WIKI-ONLY |
| Death | death seq 47 cycles; corpse removed 3 ticks after it | render `deathDurationMs` | 89/89 | VERIFIED |
| Death start | queued death: processed at K + 1, or K when the hit queue promotes it (a trailing 0 splat, or a lower-index thrall's hit queued before the member's turn); may move and attack on its final permitted turn at K unless promoted; death seq at max(processTick, last step + 3), with standing presentation until then but no extra turns | `deathPolicy: 'queued'` -> `queuedDeathAnimationTick` | 89/89 through the production rule (`warbandCapture.test.ts`), 13 promoted (B:2210->2212 still after a step, B:2218->2221 mid-walk, B:1882->1883 long still). The 7 that start on K are all promoted: 5 by a lower-index thrall (C:2142, C:2432, B:3386, B:3392, A:4279), 2 by overkill (C:1815, A:1141). Thralls are unsimulated, so their promotions are fitted from the packets | CAPTURE-FIT |
| Facing | faces its steps while moving (facing reset), the player once stopped | `facesStepsWhileMoving` | All three wave captures: 565/565 facing updates on a moving member are resets (e.g. B:2203, 2210–2212); 437/441 on a still member face the player's tile, start or end of that tick (e.g. B:2213, 2217) | VERIFIED |
| Projectiles | archer 9 angle 15, heights 163->146; seer 130 angle 16, heights 172->124; both start 10, end 30, progress 64; seer impact 131 on the player, delay 30, height 124 | `WARBAND_PROJECTILES`, `WARBAND_SEER_IMPACT_HEIGHT` | Every projectile record: archer 52/52 (C/B/A 14/13/25), seer 27/27 (6/7/14), all from one tile (e.g. C:1461/1462, B:1941/1873, A:853/854); each launches on its attack sequence's tick (archer 10850 52/52; seer 10853 23/27, the other four showing a same-tick defend 10854 instead); impact on 25/27 seer casts, the other two (C:3455, B:3369) had the slot taken by 2254; [`warbandCapture.test.ts`](../../src/npcs/colosseum/__tests__/warbandCapture.test.ts) | VERIFIED (distance 1 only) |
| Sol Quartet spawn tick | control+3 | E `SOL_QUARTET_SPAWN_TICK` | Warband adds on the "Wave: N" tick in all 28 waves; Bees at wave+5 (B:2361->2366) and at Sol control+8 (A:4984) | DERIVED |
| Sol Quartet spawn tile | seeded draw from the five captured S-member tiles | E `SOL_QUARTET_SPAWN_TILES` | B:2201/2361/2630/2975/3347; all inside Sol's arena | MODEL distribution |
| Sol Quartet type | seeded uniform berserker/archer/seer, drawn only when Quartet is on | `SolModifierEffects` | Wiki: "An extra random Fremennik Warbander" | MODEL |
| Sol Quartet lifecycle | one per fight, no respawn; attacks only while Sol lives; removed with the crystals at Sol death+1; unaffected by the Sol Attacks toggle | `SolModifierEffects` / encounter | Matches the Bees lifecycle; no Sol+Quartet capture | Simulator policy, not capture-verified |
| Volatility on its death | not simulated | — | Wiki: every enemy explodes | Gap |

### Totemic

Evidence: Run A's 55 healing totems (NPC 12825, A:850–4832) in waves 3–11; its Sol fight never
brought Sol below 892 HP, and no other capture has Totemic, so no capture has a Sol totem. Sol takes
every behavior from these wave totems except his heal amount. Wiki: [Healing totem](https://oldschool.runescape.wiki/w/Healing_totem)
rev 15259848, [Modifiers](https://oldschool.runescape.wiki/w/Fortis_Colosseum/Modifiers) rev 15163385,
[Strategies](https://oldschool.runescape.wiki/w/Fortis_Colosseum/Strategies) rev 15358918. Code:
`colosseum/modifiers/totemic.ts` (shared totem), `SolModifierEffects` (Sol's schedule), conformance in
[`totemic.test.ts`](../../src/encounters/colosseum/modifiers/__tests__/totemic.test.ts). A totem's
target is the NPC it faces on its add tick, or failing that the one it launches at: 54 of 55 (A:1695
did neither).

Headbars are the only HP evidence: the captures show a 30-wide fill, which the server sets to
`1 + floor(29 × hp / max)` (RuneLite `OpponentInfoOverlay`, BSD-2). Fill 15 therefore spans 48.3–51.7%
HP, and 14 is always below half. Tracking HP from splats drifts upward of the fills for the larger
wave NPCs, so it is not used as exact evidence.

| Fact | Value | Code | Evidence (n) | Status |
|---|---|---|---|---|
| Trigger | target at or below 50% HP, on the crossing tick | `TOTEMIC_HP_THRESHOLD` | 54/54: added on the tick the headbar first shows ≤15 (50) or, after waiting at 15, ≤14 (4: A:1470, 2829, 4136, 4425); never at 16+. 3 came at exactly 15 (A:889, 3326, 3665), so 15 straddles the threshold as the formula predicts. Wiki "reduced to 50% hitpoints or below" | VERIFIED to headbar resolution; exactly 50% unresolved |
| One per target | no sampled wave target received a second totem during observation | `SolModifierEffects` (one at a time) | 54/54 targets had one; A:3665's target fell back through half HP with its totem alive and got none | Not observed in these samples |
| After a kill | no new totem for the same target within 50 ticks, even falling back through half HP | `SOL_TOTEMIC_RESPAWN_TICKS` | 36 targets outlived their killed totem, by up to 50 ticks (A:1592); 5 of them were healed over half and fell below it again 2–30 ticks after the kill (A:934, 1026, 1592, 2283, 4425); none got another | VERIFIED lower bound; the 200 is WIKI-ONLY |
| "Destroyed" | the player's kill | `onNpcDefeated` | 43 of 55 were killed; the other 12 left with their dying target | VERIFIED |
| Spawn tile | diagonal SW of the target's SW tile; if a pillar or wall blocks it, diagonal NE of its footprint | `healingTotemSpawnTile` | 52/55 SW, all walkable on the cache arena; 3/3 NE where SW was blocked (A:889, A:1274, A:3007) | VERIFIED |
| NPC occupancy | other NPCs do not block the spawn tile | same | A:1592 appeared on the tile a thrall had stood on since A:1583 (A:2194's archer only walked onto its tile that tick) | SINGLE-OBSERVATION |
| Both blocked | nearest free tile of the ring around the footprint | same | Wiki "spawning elsewhere"; never captured | UNVERIFIED |
| NPC | size 1, 1 HP, 0 Defence, idle 10827, attack 10828, no spawn/death seq, never moves | `actors.ts`, `COLOSSEUM_SEQS.totem` | Cache rev 232 (model 51251); Wiki infobox; 0 totem movements; 53/53 `sequence` lines are 10828 | CACHE + VERIFIED |
| Player hits | every hit lands for 1 and kills | `alwaysAccuratePlayerHit` | 43/43 hit totems took exactly one splat, `16:1`; no 0 splat on any totem | Outcome VERIFIED; forced accuracy a MODEL (also fits a roll against 0 Defence) |
| Attackable from | spawn tick | no untargetable window | Earliest interactions: an `opnpc` at spawn+1 (A:4002), ricochet arrows (2007) at totems from spawn+2, Venator primaries from spawn+4 | Consistent; whether spawn+0 accepts an attack is unobserved |
| Blocks NPCs | no | `blocksNpcMovement: false` | Only warband archers walked onto a live totem's tile (A:1809+1, A:2194+0), and they ignore all NPCs; no other NPC's route crossed one | UNVERIFIED |
| Removal | killed: 3 ticks after the killing hit; with its target: 0–1 ticks after the target dies | render `deathDurationMs` 1800; `advanceTotemic` | 55/55: 37 kill+3; the 6 killed totems removed at kill+1/+2 were all removed 1 tick after their target died (A:850, 1796, 2448, 2694, 3584, 4257); 12/12 unkilled at target death+0 (5) or +1 (7) | VERIFIED |
| First launch | spawn+7 | `TOTEM_FIRST_LAUNCH_TICKS` | 35 of the 36 totems alive with a hurt target at +7 | VERIFIED, one exception |
| Relaunch | 6 ticks after the last launch, on the first tick the target is missing HP | `TOTEM_LAUNCH_INTERVAL_TICKS`, `advanceHealingTotem` | Gaps 6 ×17, 8 ×1 (A:934+37 topped up, hurt again +39); replaying the rule on headbars gives 54/55 totems' launch ticks | VERIFIED, one exception |
| A:3734 | no launch at +7 | — | Its target was alive at fill 13 and the totem lived to +9, exactly like A:3364/3503/2041/3919/4618, which all launched with a Venator arrow in the air at +7. Its +7 tick (A:3741) carries no NPC update block at all, as about 960 other Run A ticks do, so a lost packet can be neither shown nor ruled out | Unexplained; not modeled |
| Projectile | 2687, start 90, end 180, angle 0, progress 0, heights 220->138 | `HEALING_TOTEM_PROJECTILE` | 53/53, all from a tile diagonal to the target | VERIFIED (distance 1 only) |
| Heal timing | launch+6 | `TOTEM_HEAL_FLIGHT_TICKS` | +6 when the totem's NPC index is above its target's (16/16), +5 when below (3 heals, all from one totem: A:1599/1605/1611); not size or distance (all from 1 tile; another 3x3 Javelin took +6) | MODEL: always +6. Server index allocation is not reproduced; live turns use registration order, see [npc-behaviors.md](../architecture/npc-behaviors.md#npc-index-order-not-modeled). Wave totems outranked 180/189 live wave NPCs, but Sol's later crystals took lower indices than Sol (A:4976 63273 vs A:5133 33430), so his case is open |
| Heal impact | spotanim 2688 on the target as the heal lands; heal splat | `advanceHealingTotem` | 19/19: 17 show 2688; the other two show another default-slot spotanim on that tick instead (A:1616 the Javelin's own 2676, A:4444 `sanguinesti_staff_heal`); no 2688 without a heal | VERIFIED |
| Destroyed in flight | no heal | same | 0 heals from the 33 launches whose totem was gone by landing | VERIFIED; Wiki agrees |
| Wave heal amount | floor(30% max HP), capped at missing HP | not used by Sol | 17/19 full (Jaguar 37, Minotaur 67, Javelin 66, Shaman 37), 2 capped (A:2283 54, A:934 27) | VERIFIED |
| Sol heal amount | 75 | E `SOL_TOTEMIC_HEAL_AMOUNT` | Strategies: "heal him for 75 hitpoints"; the wave rule would give 450 | WIKI-ONLY |
| Sol heal cadence | the wave cadence: spawn+7, then every 6 ticks while hurt | shared | Waves above. Strategies says "every 4.2 seconds" (7 ticks); not used | VERIFIED in waves; Wiki discrepancy noted |
| Sol spawns | one at a time: the first on his half-HP tick, the next 200 ticks after the player destroys it, whatever his HP by then | `SolModifierEffects`, E `SOL_TOTEMIC_RESPAWN_TICKS` | Strategies "After the first totem is destroyed, it will respawn in 2 minutes" (the Modifiers page's "an additional totem ... once every two minutes" is not used). No sampled wave target received a second totem during observation, up to 50 ticks after a kill | Trigger VERIFIED in waves; one active totem and the 200-tick replacement WIKI-ONLY, not observed on Sol; respawning above half HP MODEL |
| Sol phases | heals never repeat an announced transition; HP healed back above a pending threshold defers it | `SolHereditEncounter` | — | MODEL (pending case UNVERIFIED) |
| Venator | an ordinary ricochet candidate, but its SW-diagonal tile is 3 from Sol's center, so no Sol hop reaches it | ricochet rules | Wave hops onto totems: 18 | DERIVED |

## 1. Actors, and which tiles are fixed

K and M only; N's diagonal spears and the varied crystal spawns are in capture analysis §10 and §13.

| NPC | id | K | M | Sim tile |
|---|---|---|---|---|
| `colosseum_sol_p1` | 12821 | t3998 | t8273 | `[31,36]` |
| `colosseum_beam_crystal` (first) | 12824 | t4024 | t8294 | `[29,41]` |
| `colosseum_solar_flare` | 12826 | — | t8276 | `[34,36]` (one of four) |
| `colosseum_sol_gib` | 12832 | — | t8521 | `[31,32]` |
| `colosseum_master` | 12808 | t4229 | t8522 | post-fight |

Sol spawns on the same tile in every kill. The first beam crystal spawns at north x=29 in K, M and
N but at x=27 in L and A; later crystals vary along their edges too (the register's crystal spawn
row lists the observed range). Production fixes one spawn per edge, including the first crystal.
Relative to control the first crystal is not fixed in time either: control+26 in K, control+21 in
M; it spawns at its transition's taunt+2.

Solarflare orbs appear at control+3 (M:8276, A:4979) and first step at control+4 (M:8277, A:4980,
L:3455).

## 2. Effect id dictionary

Everything below is Sol's. Player weapon effects in these captures (`dragon_halberd_special_*`,
`dragon_claws_spot`, `spotanim_elder_maul_special`, `sanguinesti_staff_heal`) are the recording
player's gear and must not be modeled as encounter mechanics.

| Effect | id | Kind | Role |
|---|---|---|---|
| `spotanim_colossi_finalboss_01/02/03_melee` | 2669 / 2670 / 2671 | `map_anim` | Per-tile melee telegraphs. ~780-860 emits each per capture — these dominate the file |
| `npc_colossi_colossi_tripleattack_01_telegraph_shorter` | 2668 | `spotanim` | Short triple, above the 50% transition |
| `npc_colossi_colossi_tripleattack_01_telegraph` | 2667 | `spotanim` | Long triple, after the 50% transition |
| `vfx_colosseum_crystal_charge_01_beam_01..04` | 2689-2692 | `map_anim` | Laser charge, one id per beam |
| `vfx_colosseum_crystal_attack_01_beam_01..04` | 2693-2696 | `map_anim` | Laser fire, one id per beam |
| `vfx_colosseum_crystal_attack_01_impact_01` | 2697 | `map_anim` | Laser impact |
| `vfx_colosseum_sunfire_lightning_01_beam_01` | 2698 | `map_anim` | Sunfire lightning |
| `npc_colossi_colossi_01_land` | 2666 | `spotanim` | Sol's arrival, on the spawn tick |
| `npc_colossi_finalboss_01_death` | 2680 | `spotanim` | Death |
| `vfx_colosseum_finalboss_explosion_01` | 2724 | `map_anim` | Volatility death explosion, in M and N |

## 3. Triple telegraphs follow phase, not first use

| Capture | Telegraph ticks | id used |
|---|---|---|
| K | 4051, 4124, 4218 | 2668 at 4051; 2667 at 4124 and 4218 |
| M | 8380, 8489 | 2668 at 8380; 2667 at 8489 |
| N | 7470, 7515, 7649, 7678 | 2668 at 7470 and 7515; 2667 at 7649 and 7678 |

N's second triple is still short (t7515, HP 1227); both long triples follow the 50% taunt at t7630,
so the variant follows the phase, not first use. The variants differ in their third-hit offset,
not the first hit's warning time; see the ledger and capture analysis §10.

Intervals between telegraphs are 73 and 94 (kill) and 109 (modifier). They do not agree, so **the
triple attack is not on a fixed period** — do not derive a cadence from these five samples.

## 4. Death

Every kill emits death spotanim `2680`; in K, M and N Sol is removed nine ticks later. Cleanup
and reward events have separate timings; see the ledger. The Volatility kills M and N additionally
emit the explosion `2724` and per-tile `fireblast_impact (131)` on a single tick, D+9: 81 tiles at
M:8521 and 49 at N:7790. M also adds `colosseum_sol_gib` (12832) at M:8521.

## 5. Evidence present, and remaining limits

- **Sol animations are recorded as `sequence`, not `anim`.** Attack and death clips can be
  tick-anchored (e.g. K:t4003, M:t8380); actor update ownership must be respected.
- **N contains diagonal spears:** SW variants at t7353/t7360 and NW at t7558. NE/SE remain
  unobserved and are modeled by symmetry, not by rotating a cardinal fan.
- **N contains four regular damaging hits**, two spear and two shield. K's single nonzero player
  hit at t4067 is plausibly sand, but attribution is inferred. These do not establish damage ranges.
- **1500 HP is explicit:** `hpbar_hud_hp (6099)` and `hpbar_hud_basehp (6100)` both become 1500
  (K:4000, M:8275; also present in N). Exact transition boundary tests remain absent.
