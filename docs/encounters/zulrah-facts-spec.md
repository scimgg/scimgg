# Zulrah — facts spec

Sourced facts behind `src/encounters/zulrah/` and `src/npcs/zulrah/`. The sources are four private
gameplay captures (their facts are in `src/encounters/zulrah/__tests__/fixtures/zulrahCapture.ts`), the
OSRS Wiki, a Jagex statement quoted on it, the pinned cache and RuneLite's gameval names. Unsettled behavior: [open questions](./zulrah-open-questions.md). Decisions past the
evidence: [policy](./zulrah-policy.md).

## Sources

| Alias | Source | Retrieved |
|---|---|---|
| **W** | [Zulrah](https://oldschool.runescape.wiki/w/Zulrah), wikitext (`?action=raw`) | 2026-11-27 |
| **WS** | [Zulrah/Strategies](https://oldschool.runescape.wiki/w/Zulrah/Strategies), wikitext, read in full | 2026-11-27 |
| **WSn** | [Snakeling](https://oldschool.runescape.wiki/w/Snakeling), wikitext | 2026-11-27 |
| **WV** | [Venom](https://oldschool.runescape.wiki/w/Venom), [Anti-venom](https://oldschool.runescape.wiki/w/Anti-venom), [Anti-venom+](https://oldschool.runescape.wiki/w/Anti-venom%2B), [Extended anti-venom+](https://oldschool.runescape.wiki/w/Extended_anti-venom%2B), [Serpentine helm](https://oldschool.runescape.wiki/w/Serpentine_helm) | 2026-11-27 |
| **WSt** | [Stun (status)](https://oldschool.runescape.wiki/w/Stun_(status)) | 2026-11-27 |
| **C** | Pinned cache, OpenRS2 2772 (`npm run setup`): NpcType, SeqType, SpotAnimType, LocType, map squares 35_47 and 35_48 | — |
| **G** | RuneLite gameval tables (BSD-2-Clause), `runelite/runelite` at `9af7b54deaac35b3153af06195d66c1d68fbea5a`, `runelite-api/src/main/java/net/runelite/api/gameval/{NpcID,AnimationID,SpotanimID,ObjectID}.java` | 2026-11-27 |
| **Z1** | Private gameplay capture zulrah-packet-data-1.txt, ticks 229–605: rotation 3 from its magma phase, then the next rotation's phases 1–4 (rotation 3 again); the player dies at t567. Sim tile = world − (2240, 3008); an NPC's tile is its south-west tile | — |
| **Z2** | Private gameplay capture zulrah-packet-data-2.txt, ticks 2957–3260: the boat arrival, the opening spawn and rotation 2 through phase 10. Same tile frame | — |
| **Z3** | Private gameplay capture zulrah-packet-data-3.txt, ticks 810–1094: rotation 4 from phase 3's last snakeling orb through phase 12's first barrage (0-based), with one phase the table does not list; the player teleports out at t1092. Same tile frame | — |
| **Z4** | Private gameplay capture zulrah-packet-data-4.txt, ticks 2006–2301: rotation 2 from phase 3's last snakeling orb through phase 10, then the next rotation, rotation 2 again, through phase 3's barrages (0-based); the player uses a blowpipe in melee armor, then a noxious halberd. Same tile frame | — |
| **RL** | RuneLite (BSD-2-Clause) at the same commit, `runelite-client/src/main/java/net/runelite/client/plugins/timersandbuffs/TimersAndBuffsPlugin.java` (`VENOM_VALUE_CUTOFF`, `POISON_TICK_LENGTH`) | 2026-11-26 |

## Identity and stats

| Fact | Value | Source |
|---|---|---|
| Forms | 2042 SNAKEBOSS_BOSS_RANGED (green), 2043 SNAKEBOSS_BOSS_MELEE (red), 2044 SNAKEBOSS_BOSS_MAGIC (blue) | G NpcID; W infobox |
| Size | 5 | C NpcType; W |
| Hitpoints, Defence/Magic/Ranged | 500; 300/300/300 | W infobox; WS |
| Attack speed, max hit | 3 ticks; 41 | W infobox |
| Defensive bonuses | Green: magic −45, ranged +50; red: magic 0, ranged +300; blue: magic +300, ranged 0; melee 0 in every form | WS per-form figures (W's infobox row differs) |
| Damage cap | "capped at 50, with hits dealing more than that randomly hitting it for 45-50" | WS; W |
| Melee | "no melee defence in any form … can only be reached with a halberd-type weapon" | WS |
| Snakelings | 2045 SNAKEBOSS_MINION_MELEE, 2046 SNAKEBOSS_MINION_MAGIC (2047 SNAKEBOSS_MINION_DYING); 1 HP, size 1, combat 90, attack speed 3, max hit 15 (stab) / 13 (magic) | G NpcID; WSn infobox |

## Fight structure

| Fact | Source |
|---|---|
| Four rotations, "chosen at random"; the full phase tables (form, spot, attack counts, venom cloud barrages "VC", snakeling orbs "SO") | WS, Rotations (`src/encounters/zulrah/rotation.ts`) |
| Every rotation opens green in the middle; a rotation's last phase "counts as the first phase of the new rotation"; a new rotation may repeat the last | WS |
| Jad phase: rotations 1–2 west, 10 attacks starting ranged; rotation 3 east, 10 starting magic; rotation 4 east, 8 starting magic | WS |
| Blue (tanzanite) "will randomly attack with both Magic and Ranged attacks, although it uses magic much more frequently"; ranged "up to five times in succession" | WS; W |
| Damage "is calculated on animation/attack generation not when projectile hits you" | W |
| "about three minutes to complete each full rotation"; Jad phase "at approximately 2 minutes" | WS; W |

## Mechanics

| Fact | Source |
|---|---|
| Red tail: stares "at the player's position for several seconds before whipping its tail at that area"; 20–30 typeless damage and a stun "for several seconds"; "can be avoided by moving two tiles away" | WS Forms; W Fight overview |
| Stuns "disable a player's ability to perform several game actions such as attacking and moving" | WSt |
| Venom clouds come from "a barrage of dark-green orbs"; a cloud covers a 3x3 area and deals "varying damage per tick"; clouds "do not envenom the player"; the opening fill leaves "the tips on the east and west sides clear" | WS |
| Snakelings come from "white orbs"; "attacks with either magic or melee, but never both"; "Protection prayers block their attacks"; they die after "more than 40 seconds" and "die off with Zulrah when it is killed" | WS; WSn |
| Venom: "The ranged and magic attacks will envenom the player unless they miss, even if blocked by a protection prayer"; snakelings "inflict venom with their attacks" | WS; W |
| Venom damage: 6 per 18 s, +2 a hit, capped at 20; an antipoison "will convert the venom to regular poison, which starts at the same damage the venom had", and a second dose cures it; anti-venom "will completely cure venom" | WV Venom |
| Anti-venom 12905/7/9/11: cures; poison immunity 12 min, venom 36–54 s. Anti-venom+ 12913/5/7/9: 15 min, venom ~3.6 min. Extended anti-venom+ 29824/27/30/33: 17.7 min, venom ~6.3 min per dose | WV item pages |
| Poison, venom and both immunities are one varp; immunity counts toward 0 one step per 30 ticks, and blocks venom only below -38 (`VENOM_VALUE_CUTOFF = -38; // Antivenom < -38 <= Antipoison < 0`) | RL |
| Serpentine helm 12931 (charged) and its cosmetic recolours tanzanite 13197 and magma 13199: immunity to venom and poison while worn; does not cure | WV Serpentine helm; equipment data |
| Zulrah "will appear as soon as the player continues the dialogue or performs an action"; it "will never attack directly at the start; rather, Zulrah will fill the area with venom clouds" | W Transportation; WS All rotations |
| Zulrah is one NPC that "changes forms by diving into the swamp and resurfacing somewhere else" | W |
| The dive plays the death animation "forwards and backwards at faster speeds" (Mod Ash, quoted) | W Trivia |

## Measured in the captures

| Fact | Source |
|---|---|
| Tail stun: without a knockback a hit on t blocks t..t+6, the player moving again on t+7 (hit t3015, "You're stunned!" on t3016–t3021, first move t3022; hit t3247, stunned t3248–t3253, the next hit on t3254; Z1 t249, first move t256). "You're stunned!" answers clicks from t+1. With a knockback the player first moves a tick later (t3119→t3127; Z1 t549→t557), and only those hits play player seq 1157 `human_troll_flyback` (t3119; Z1 t242, t549). Z4 the same without a knockback: hit t2064, stunned t2065–t2070, first move t2071. Z4's knockback, the only eastward one: hit t2256 on (32,69), teleport and exactmove to (34,69), the player facing angle 512 (toward Zulrah), seq 1157 and the `busy` varbit for that tick; first move t2265, an upper bound, as clicks were not made every tick. Stun graphic spotanim 245 `stunned_thieving`, height 124, on every hit. Eating works while stunned (Z1 t245) | Z1; Z2; Z4 |
| Poison counter: steps every 30 ticks on one clock (t2962, t2992, … t3172); envenoming at -37 on t3193 first stepped on t3202, and an extended anti-venom+ sip on t3222 (venom → -59) next stepped on t3232, both on that phase. Messages: stepping to -39, "Your venom resistance is about to wear off." (t3112); to -38, "Your venom resistance has worn off, but you are still resistant to poison." (t3142) | Z2 |
| Re-drinking extended anti-venom+ while its immunity runs resets the counter to the full -59. Reported by the project owner from play; not yet captured (Z2's sip, above, shows the step clock keeping its phase across a drink) | Reported |

## Cache ids

| Id | Gameval name | Used for | Source |
|---|---|---|---|
| seq 5070 | SNAKEBOSS_IDLE | idle (also each form's NpcType stand seq) | G AnimationID; C |
| seq 5069 | SNAKEBOSS_ATTACK_ACIDX1 | ranged/magic attack | G |
| seq 5071 | SNAKEBOSS_SPAWN | the fight's opening rise | G |
| seq 5072 / 5073 | SNAKEBOSS_SINKFAST / SNAKEBOSS_EMERGEFAST | dive / resurface between forms | G |
| seq 5806 / 5807 | SNAKEBOSS_ATTACK_TAIL_LEFT / _RIGHT | the tail | G |
| seq 5804 | SNAKEBOSS_DEATH | death | G |
| seq 1721, 2405, 1741, 2413, 2408 | SNAKEBOSS_PET_IDLE, _WALK_FORWARD, _ATTACK, _SPAWN, _DEATH | snakeling | G |
| spotanim 1044, 1045, 1046 | SNAKEBOSS_ORB, SNAKEBOSS_DOUBLE_ORB, SNAKEBOSS_FIREBALL | projectiles (assignment: [open questions](./zulrah-open-questions.md)) | G SpotanimID |
| spotanim 1047 | SNAKEBOSS_EGG | snakeling orb (1044's model recoloured white) | G; C recolours |
| spotanim 245 | `stunned_thieving` | the tail stun on the player | Z1 |
| spotanim 1230 | SNAKEBOSS_MINION_SPELL | magic snakeling's bolt | G |
| loc 11700 | SNAKEBOSS_POISONCLOUD | venom cloud (3x3, no collision, animated) | G ObjectID; C |
| map squares | 35_47 and 35_48 (regions 9007/9008): the island's base and its north arms | WS tile-marker regions; C walkability |
