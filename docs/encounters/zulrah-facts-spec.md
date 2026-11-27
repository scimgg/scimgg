# Zulrah — facts spec

Sourced facts behind `src/encounters/zulrah/` and `src/npcs/zulrah/`. There are no Zulrah captures;
the sources are the OSRS Wiki, a Jagex statement quoted on it, the pinned cache and RuneLite's
gameval names. Unsettled behavior: [open questions](./zulrah-open-questions.md). Decisions past the
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
| Venom damage: 6 per 18 s, +2 a hit, capped at 20; antipoison converts it to poison | WV Venom |
| Anti-venom 12905/7/9/11: cures, venom immunity 36–54 s. Anti-venom+ 12913/5/7/9: 216 s (Venom table). Extended anti-venom+ 29824/27/30/33: 378 s per dose | WV |
| Serpentine helm 12931 (charged) and its cosmetic recolours tanzanite 13197 and magma 13199: immunity to venom and poison while worn; does not cure | WV Serpentine helm; equipment data |
| Zulrah "will appear as soon as the player continues the dialogue or performs an action"; it "will never attack directly at the start; rather, Zulrah will fill the area with venom clouds" | W Transportation; WS All rotations |
| Zulrah is one NPC that "changes forms by diving into the swamp and resurfacing somewhere else" | W |
| The dive plays the death animation "forwards and backwards at faster speeds" (Mod Ash, quoted) | W Trivia |

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
| spotanim 1230 | SNAKEBOSS_MINION_SPELL | magic snakeling's bolt | G |
| loc 11700 | SNAKEBOSS_POISONCLOUD | venom cloud (3x3, no collision, animated) | G ObjectID; C |
| map squares | 35_47 and 35_48 (regions 9007/9008): the island's base and its north arms | WS tile-marker regions; C walkability |
