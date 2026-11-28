# Sound-ID audit

Sound ids in the event-audio rules ([`coreAudioRules.ts`](../../src/audio/coreAudioRules.ts),
[`yamaAudioRules.ts`](../../src/audio/yamaAudioRules.ts)), checked against private gameplay captures
(cited by file name). This is the canonical record of what is verified, what is a
best-effort candidate and what is deliberately silent: cite it rather than re-deriving an id from a
capture by eye. Zuk's live rules ([`zukAudioRules.ts`](../../src/audio/zukAudioRules.ts)) and their
gating are in [Zuk policy: presentation](../encounters/zuk-policy.md#presentation); §5 is
raw evidence only. When this file and the code disagree, this record wins, and within it the cited
capture facts take precedence over unverified candidates.

**Method.** Enumerate every `synth_sound` / `sound_area` line in the 19 captures audited (255
distinct ids, zero unparsed), and attribute each by pairing it with the same tick's `sequence`,
`hit`, `varbit`, `spotanim` and `map_anim` lines. Adopt an id only when it fires on ~100% of its
candidate's ticks **and** ~100% of its own plays land on that candidate. Near-misses on either side
are where misattributions come from. Sound 600 is the standing example: it looks
like Jal-Xil's launch by raw count, but sits on only 34% of the mager's attack ticks and 45% of the
player's atlatl ticks, with 52% of its plays on the latter. It stays unassigned.

Format facts:

- **`synth_sound` is non-positional** (local player, full volume). **`sound_area` is positional**,
  with `range` + `coord`; only those are attenuated.
- **`delay` is in client cycles, 30 = 1 tick.** Most combat sounds carry one; rules preserve it.
- **A capture cannot see a frame sound.** The server sends only "play spotanim 3247 on this
  player"; the client resolves it to seq 12099 and fires 10263 on frame 1 locally. "Absent from all
  captures" proves only that a sound is not server-sent. Frame sounds hang off NPC/player clips
  **and** spotanim sequences; `FrameSoundTracker` walks both, so those need no rule.

## 1. Player hitsplats

rsmod's [`StandardPlayerHitProcessor`](https://github.com/rsmod/rsmod/blob/main/api/player/src/main/kotlin/org/rsmod/api/player/hit/processor/StandardPlayerHitProcessor.kt)
and the captures agree exactly:

```
soundSynth(defendSound, delay = 20) where defendSound =
  damage > 0 and body type A -> random of human_hit_1..4
  damage > 0 and body type B -> random of female_hit_1..2
  damage == 0               -> lefthand's item_block_sound1..5,
                               else torso's item_block_sound1..5,
                               else human_block_1
```

rsmod `synth.sym`: **509/510 = female_hit_1/2, 511 = human_block_1, 512 = human_death, 518–521 =
human_hit_1–4**. (RuneLite names 510/511 `TAKE_DAMAGE_SPLAT`/`ZERO_DAMAGE_SPLAT`; 510 is not a
generic damage sound.) Only player-owned hitsplats emit these, one sound per splat:
`yama-packet-data.txt` t707 has two `(16, …)` player splats and exactly two sounds; t846 has one
`(16, 10)` and one `(12, 0)` and one sound from each set.

| Player hitsplat | Sound | Notes |
|---|---|---|
| `DAMAGE_ME` (16), value > 0 | one of **518 / 519 / 520 / 521** | uniform random |
| `BLOCK_ME` (12), value 0 | **511** | see below |
| `DAMAGE_MAX_ME_CYAN` (44), `POISON` (65), `DOOM` (73), `BURN` (74) | none | silent in every capture |
| any hitsplat on an NPC | none | — |

**The damage set is the body type**: the recording player (16 captures, body type A) always emits
518–521 and a second recording account (3 Inferno captures, body type B) always 509/510, across
every loadout. `PlayerModelLoader` defaults `gender: 0` = body type A, so we play 518–521.

**The block sound is the worn gear.** Observed sets:

| Set | Where |
|---|---|
| 2841, 2842, 2843, 2844, 2845 | yama base (melee loadout), colosseum, duke, vardorvis, leviathan |
| 2772, 2777, 2778, 2779, 2780 | yama glyphic attenuation |
| 2963, 2964, 2965, 2966, 2967 | yama divine severance |
| 2811, 2812, 2813, 2814, 2815 | inferno |
| 2766, 2767, 2768, 2769, 2770 | leviathan (second loadout) |
| 30, 1345, 1349, 1350, 2968 | whenever `human_shield_defence` plays (the left-hand branch) |
| 511 | yama base on the staff/robe loadout, forfeit breath throughout |

Gear, not incoming style: at Leviathan t7126 an equip fires (2239, a metal body) and the set flips
2841–2845 → 2766–2770 permanently, with magic *and* ranged producing the new set either side.
**Per-item sets cannot be resolved**: `item_block_sound1..5` are rsmod params 65417–65421 in its own
custom range, carried by zero `ObjType`s in both the rev-232 and 2485 caches, and the captures show no
appearance packet. Every loadout therefore falls through to `human_block_1`, as rsmod does. No
armour-set stand-in is supported without per-item data.

## 2. Player weapon and spell sounds

Every entry fires on 100% of its animation's ticks. "Exclusive" is the share of that sound's plays
landing on this animation.

| Animation / weapon | Sound | Ticks | Exclusive |
|---|---|---|---|
| `human_sword_slash` (Emberlight) | 2500 | 122 | 99% |
| `human_inquisitors_mace_crush` | 2508 | 251 | 100% |
| `scythe_of_vitur_attack` | **2524** | 501 | 100% |
| `ghrazi_rapier_attack` (Lunge; the stab clip) | **2549** | 12 | 100% |
| `dh_sword_update_slash` (godswords) | **3847** | 10 | 100% |
| `human_bow` | **2700** | 201 | 87% (the rest are a Manticore projectile) |
| `xbows_human_fire_and_reload_pvn` | 2695 | 72 | 100% |
| `human_atlatl_attack_ranged_01` (Eclipse atlatl) | 2699 | 2384 | 100% |
| `snakeboss_blowpipe_attack` (toxic blowpipe) | **2696** | 27 | 100% |
| `toa_sot_cast_b` (Tumeken's shadow) | 6410, then 1460 `sound_area range=10` at the target at the projectile's `endtime` when the cast lands (227 there on a splash) | 69 | 100% (1460 on 55/55 landed casts) |
| `human_spellcast_demonbane` | 5053 + `sound_area 5035, delay=60` at the target | 394 | 100% (5035 on 90% of ticks, only when it hits) |
| `human_special_accursed` | 183, then 163 at the projectile's `endTime` (`46 + 10 × distance`), landed or splashed | 5 | 100% |
| `human_eat` | 2393 (food) / 2401 (potion) | 427 | 100% |
| `human_weapon_bow_venator01_shoot` (Venator bow) | 6797, + 6672 when the arrow ricochets once, + 6735 when twice | 124 (three Colosseum wave captures) | 100% (6672 on 105/105 ricocheting shots, 6735 on 85/85 double) |
| `human_axe_chop` (393, the claws Slash swing, com_mode 1) | **4139** | 25 | 100% (weapon category 4 on every tick) |

The weapon sweep capture (capture `weapon-attacks-sgs-…-dragon-pickaxe-packet-data.txt`) swings
every style a few times, giving the sound per style:

| Weapon | Sound per style |
|---|---|
| Godswords (Saradomin, Armadyl, Zamorak) | 3847 on Chop, Slash and Block; **3846** on Smash (`dh_sword_update_smash`) |
| Elder maul | **3454** on every style |
| Burning and Dragon claws | 4139 on every style, Lunge's `d_claws_punch` included |
| Ghrazi rapier | 2549 on Stab (8145); **2548** on Slash (390) |
| Holy scythe of vitur | 2524 on Reap, Chop and Block; **2522** on Jab |
| Abyssal tentacle (or) | **2720** on every style |
| Dragon scimitar, Emberlight, Voidwaker | 2500 on the slash styles; **2501** on Lunge (`human_sword_stab`) |
| Dragon hunter lance | 2562 stab (8288), 2524 slash (8289), 2555 crush (8290) |
| Zamorakian spear | 2562 stab (1711), **2556** slash (1712), 2555 crush (1710) |
| Zamorakian hasta | 2562 stab, 2524 slash, 2555 crush |
| Dragon pickaxe | **2498** on Spike, Impale and Block (401); **2497** on Smash (400) |
| Armadyl crossbow | 2695, as every crossbow |
| Powered Accursed sceptre | 178, then 227 at the target on a splash (every captured cast splashed) |
| Surge potion drink | 6182 beside the ordinary 2401 |

Special attacks, same thresholds:

| Spec | Sound stack | Ticks |
|---|---|---|
| `human_dragon_claws_spec` | **4138 `delay=10`, 4140 `delay=30`, 4141 `delay=42`, 4141 `delay=60`** | 16 |
| `sgs_special_player` | **3869** | 18 |
| `human_special02_voidwaker` | **5027 + 6182 `delay=30`** | 9 |
| `ags_special_player`, `zgs_special_player` | **3869**, as the Saradomin godsword's | 1 each |
| Abyssal tentacle Binding Tentacle (`slayer_abyssal_whip_attack`) | **2713** | 1 |
| `human_weapon_emberlight_01_spec` | **9319 `delay=11`, 9320 `delay=28`, 9321 `delay=53`** | 1 + 2 (two audit counts) |
| Armadyl crossbow (`xbows_human_fire_and_reload_pvn`, projectile `acb_specialattack`) | **3892 `delay=15`** in place of 2695 | 1 |
| Scorching bow (`human_weapon_bow_scorched_01_spec`) | 2700 + 9327 `delay=11` + 9328 `delay=46`, then **9325 + 9326 at the projectile's `endtime`**, hit or miss | 10 |
| `human_elder_maul_spec` | **8984 `delay=2`** | 6 |

`zaros_vertical_casting_walkmerge` is the shared Ancients cast animation, so 178 sits on only 4% of
its ticks: it is Shadow Barrage's specifically, which is how `magic_shadow` uses it. Blood and Ice
casts on that animation use 104/105/106 and 170/171.

2517 (stab), 2567 (crush) and 160/220/211 (fire/air/water casts) are unverifiable (no capture uses
those weapons or spells) and remain unsourced. Bow 2693, widely copied, appears in no capture.

**Splashes.** **227** is on 94/94 `failedspell_impact` spotanims in the Inferno capture, 12/12 in
zuk-atlatl, 3/3 in zuk, never without one. `hit_applied.accurate` is the only thing distinguishing a
splash from a spell that hit for 0. A splash emits **no hitsplat at all** (Jad ticks 754/759,
Inferno ranger tick 6159: no `hit` at cast or impact), so "splash" and "hit a 0" are disjoint. 227
is delivered as `sound_area` 140 of 158 times **at the target's tile with `range=10`**: replayed
through our curve, 31% of splashes are inaudible and mean volume is 0.28. Played unpositioned it
would be ~3.5× louder than the client's, so the rule passes `position` and range 10. Splash rate
tracks target magic defence: 94/317 (30%) across Inferno, 17/142 (12%) vs Yama with demonbane,
12/13 (92%) Ice Burst into Jad.

**Purging staff "Scatter ashes"** is **9315**, a bare `synth_sound` at `delay=5`, on the killing-blow
tick of every Purging-staff special kill alongside `spotanim slot=5, id=vfx_ignite_staff_01_2x2 (2812)`
on the killed NPC: 462/462 co-occurrence, never without it, ~219/231 with a ≥20% special-energy
refund (capture `yama_divine_severance.txt` tick 3214: the void flare's `hit id=16, value=81`,
the 2812 spotanim and `synth_sound id=9315, delay=5`). The sim emits `npc_graphic_applied` from the
special's `onKillEffect`, picking 2811/2812/2813 by NPC size, and `coreAudioRules` plays 9315 off
it. Only 2x2 is captured (every kill is a void flare); the other sizes follow gameval names. It is
not the void flare's death sound.

Not modeled (cosmetic): the Venator bow's three-sound stack (weapon not in our roster).

## 3. Prayers, items, death

| Event | Sound |
|---|---|
| Protect from Magic on | 2675 |
| Protect from Missiles on | 2677 |
| Protect from Melee on | 2676 |
| Piety on | 3825 |
| Rigour on (`prayer_rigour`) | 2685 |
| Augury on (`prayer_augury`) | 2670 |
| Deadeye on (`prayer_eagleeye` + `prayer_deadeye` together) | 10194 |
| any prayer off | 2663, **once per deactivation batch** |
| activation rejected / drained | 2672 |
| item picked up (`ground_item_taken`) | **2582**, bare synth on the `obj_del` tick |
| Death Charge cast (`spell_self_cast`, spotanim 1854/3288) | **5034** alone |
| Death Charge proc (`death_charge_proc`) | **5047**, once per paying kill |
| Death Charge faded (`status_effect_expired`, `death_charge`) | **5056** |

2582 is on 54/54 pickup ticks across 17 captures, each beside the item's `obj_del`
(`tob-normal-mage-packet-data-1.txt` ticks 542, 2092, 2174).

Death Charge shares `human_cast_selfimbue` (8970) with Mark of Darkness, so the rule keys the cast
on its spotanim; keying on the animation would play Mark of Darkness's 5046 + 5015 for both. Across the
captures, 5034 is on 151/151 casts (`arceuus_death_charge_active` 0 → 1 or 2) and nowhere else.
Every cast is the upgraded spotanim 3288; the base 1854 cast is uncaptured and assumed to match.
5047 is on 247/247 proc ticks (`arceuus_death_charge_active` decremented by a kill, with
`sa_energy` +150). 5056 is on 42/42 "Your Death Charge has faded away." ticks, where the window
ran out with a proc unspent. A charge whose last proc pays out does not play it.
`colosseum-no-sol-packet-data.txt` shows all three: cast 1478, procs 1543 and 1546, fade 2257.

10194's 1957 hits in the Inferno capture are Deadeye flicks, not Rigour. Mystic Vigour appears
(`prayer_mysticmight` + `prayer_mysticvigour`) but its rule's 10100 is in no capture.

`human_death` carries no sound in either capture that contains it, and cache seq 8970 has no frame
sounds, so player death is very likely silent in game. We still play 512, gated to the player:
ungated, every boss kill would end on the player's death cry.

## 4. Yama

**Yama's attacks emit no sound packet.** 40 `npc_yama01_magic01` and 19 `npc_yama01_melee01` ticks
in `yama-packet-data.txt` carry only unrelated player/thrall sounds, and his magic/range impacts on
the player (216 and 174 ticks) are silent in the packet stream. Every Yama sound is a **frame
sound**, on two kinds of sequence; checking only NPC clips concludes half of them do not exist.

On his own clips:

| Seq | Role | Frame sounds |
|---|---|---|
| 12144 | attack (non-melee), renderer's `default` clip | f56 → 10251 |
| 12146 | attack (melee), renderer's `secondary` clip | f3 → 10247, f20 → 10242, f62 → 10242 |
| 12156 | summon | f5 → 10258, f47/f68 → 10242 |
| 12161 | death | 10277, 10248, 10275, 10269, 10240 |
| 12134 | voidflare death (killed) | f3 → 10239 |
| 12136 | voidflare explode (`npc_voidflare_explode`), render config `deathClips.detonated` | f4 → 10249 (range 10), f24 → 10217 (range 31) |
| 12135 | voidflare spawn (`npc_voidflare_spawn`), render config `spawnSeqId` | f9 → 10253 (range 31) |

On the attack spotanims, the only audible tell for which style is incoming:

| Spotanim | Seq | Frame sounds |
|---|---|---|
| `vfx_npc_yama_magic_shadow_spotanim01` (range cast) | 12095 | f1 → 10254 |
| `vfx_player_yama_magic_shadow_impact01` (range impact) | 12096 | f1 → 10272, f23 → 10252 |
| `vfx_npc_yama_magic_fire_spotanim01` (mage cast) | 12098 | f1 → 10261 |
| `vfx_player_yama_magic_fire_impact01` (mage impact) | 12099 | f1 → 10263, f23 → 10216 |
| `vfx_yama_flaming_rock_spotanim_01` (fireball) | 12104 | f1 → 10221, f19 → 10234, f33 → 10230 |

None needs a rule; adding one double-plays (the melee trio 10247 + 10242 ×2 rides seq 12146).

Packet-sent Yama mechanics:

| Mechanic | Sound | Shape |
|---|---|---|
| Fireball barrage | 9335 `delay=3`, 10255 `delay=100`, 10268 `delay=105` | bare `synth_sound`, full volume |
| Shadow wave sweep | 10238 | one per tick **per live wave**, for the 10–13 ticks it crosses; bare synth |
| Yama ambient | `sound_area 4997, range=9` at Yama's center tile | ~every 3 ticks; **not implemented** |

In the captures but not simulated: fire wall → 10215 `delay=3` once per tick on the floor; shadow
spike/meteor → 10246 + 10255 at a shared `delay` of 150 or 180; shadow roots → 10273 and 10270
`delay=6`; shadow/fire immunity → 99.

**A void flare sends no sound packet for anything it does**; all its audio is frame sounds:

- **Killed:** `npc_voidflare_death` (12134, 90 cycles), `del`eted exactly 3 ticks after that
  sequence (263/263). The capture sends the sequence the tick after the killing hit
  (`yama_divine_severance.txt`: hit 3214, sequence 3215, `del` 3218); the renderer starts it on the
  hit tick, when the sim marks the NPC dead, so the corpse lasts 3 ticks but starts and ends a tick
  early.
- **Detonated** (fuse, `spawn+25` in phase 3): `spotanim vfx_voidflare_explode_red|blue (3237|3238)`
  plus `npc_voidflare_explode` (12136, 30 skeletal frames) on the detonation tick, `del` exactly 2
  ticks later (36/36; `yama-contract-forfeit-breath-p3-voidflare-explosions-packet-data.txt` ticks
  2364 → 2366). The sim records `deathCause: 'detonated'`, mapped to 12136 with a 2-tick corpse
  (last frame held). The explode spotanims' own seq (12137, 50 cycles) and the human-impact
  spotanims' (12139) have no frame sounds; the explode spotanim plays at natural length.
- A detonation that hits the player puts `vfx_voidflare_human_impact_red|blue (3241|3242)` on the
  player with `delay=30`, matching the explosion color; the splat lands a tick later. Which color a
  detonation shows is unresolved, so the renderer always draws blue.
- **Spawn:** `npc_voidflare_spawn` (12135) on the add tick; its frame 9 fires 10253, played via the
  render config's `spawnSeqId`. Idle seq 12133 has no frame sounds.

### The fireball barrage's delays are measured from the set's START tick

All **268** barrage triples across nine captures sit on the tick carrying the set's three
`vfx_player_yama_falling_rock_impact01` markers (the sim's `startTick`), with delays constant at
3/100/105. The 100/105 members are the crash, landing 3⅓ ticks later on `startTick + 3`, where
`vfx_flaming_skull_shadow_impact01` is in every capture that reaches it (263 of 268; the five
absences are each a capture's last burst, cut off by the kill).

So the *delivery* tick of `fireball_spawned` is load-bearing: `EventAudioPlayer` turns `delayCycles`
into a delay from the flush it arrives on. Yama captures positions a tick early (the barrage targets
the player's tile at `startTick - 1`); emitting the event then would put the whole barrage a tick
early. `YamaFireballRuntime.emitDueSpawnEvents`
([`fireballRuntime.ts`](../../src/encounters/yamaP3/fireballRuntime.ts)) holds it to `startTick`.

## 5. TzKal-Zuk: capture observations

Raw observations across the Inferno recordings, including `inferno-waves-69-zuk-packet-data.txt`.
They do not on their own authorize playback; the partial counts for 900 and 899 in particular do
not support unconditional playback on every spark or healer death. The live gating is in
[Zuk policy: presentation](../encounters/zuk-policy.md#presentation).

| Captured action | Observed sound | Observed ticks |
|---|---|---|
| `zuk_attack` | 155 + 156 | 135/135 |
| `jalakxil_attack_magic` (mager) | 598 | 768/768 |
| `jaltokjad_attack_magic` | 159 | 131/131 |
| `jaltokjad_attack_melee` | 408 | 4/4 |
| `lizard_cleric_attack` (Yt-HurKot) | 608 | 47/47 |
| Jal-MejJak spark | 900 | 39/42 spark ticks |
| Jal-MejJak death | 899 | 3/4 death ticks |
| Jal-Zek / Jal-Xil death | 599 | 4/4 death ticks (two of each) |
| JalTok-Jad death | 409 | 1/1 death tick |

Jad also plays 162 on magic release, with 163 delayed to the projectile end for magic but observed on
the rock-smash tick for ranged; not a live timing policy. 608's 16% exclusivity is Inferno-wide (wave
1–68 lizards use it too). Jal-Xil's impact carries 598 `delay=50`; Jal-MejJak's heal/spark launch
carries `sound_area 155, range=8, delay=51` at the healer, and its ground blasts one
`sound_area 156, range=8` per target tile. Raw assets and observations are not proof of per-event
scheduling.

## 6. Inferno waves 1–68

Live in [`zukAudioRules.ts`](../../src/audio/zukAudioRules.ts) through the ordinary-wave definitions'
`zuk_attack` / `zuk_hit` / `zuk_death` / `inferno_ability` events and the encounter's
`inferno_pillar_collapse`. Both wave captures (**P** = `inferno-waves-1-68-packet-data.txt`, **Q** =
`inferno-waves-(35ish)-to-68-packet-data.txt`), same two-sided method; "positional" is `sound_area`
centered on the actor's SW tile, everything else a bare `synth_sound`. No new NPC, projectile or
graphic sequence carries frame sounds.

| Owner | Sound | Shape | Evidence |
|---|---|---|---|
| Jal-Nib swing (pillar or player) | 595 | positional, range 7, at the nibbler; one per swing | P:530; on every 7709 pillar splat, 384/384 |
| Jal-Nib / Jal-Ak / children hit | 597 | zero hits included | P:464 |
| Jal-Nib / Jal-Ak / children death | 596 | with the death sequence | P:490; 66/66 each Ak death |
| Jal-MejRah launch | 291 `delay=15` | | P:380; 281/281 projectile 1382 |
| Jal-MejRah hit / death | 296 / 295 | | P:688 / P:839 (91/91) |
| Jal-Ak or Mej magic | 595, then 3528 at the projectile endtime | | P:2241–2242; delay = endtime on 336 plays |
| Jal-Ak or Xil ranged | 3403 at the endtime only | | P:2145; delay = endtime on 386 plays |
| Jal-Ak or Ket melee | 595 | | Q (65/65 Ket swings) |
| Jal-ImKot swing / hit / death | 608 / 610 / 609 | 608 shared with Yt-HurKot | P:8429 (609, 73/73) |
| Jal-ImKot dig down / up | 1641 / 1644 | positional, range 10, old / resurfaced SW | P:11211 / P:11242; 42/42 each |
| Jal-Zek resurrection | 1095 | positional, range 10, at the mager | P:57172; 34/34 |
| Rocky support collapse | 1021 | positional, range 10, at the pillar's SW + (1, 1), once per pillar | P:175810–175813 |
| Ordinary Jal-Xil, Jal-Zek, JalTok-Jad, Yt-HurKot | as wave 69 (§5) | 598 `delay=50` / 598, 600 hit, 599 death; 159/162/163, 410, 409; 608, 610 | P+Q, all ticks |

Defend sequences have no sound of their own; the hit sound covers them. NPC synths reach the player
only within ~13 tiles in the captures (nibbler deaths at 13–17 tiles are silent); like wave 69 we play
them without a distance cutoff. Nibbler zero hits carried 597 on few of their 10 captured ticks; the rule
still plays it, as for every Inferno hit.

## 7. Deliberately silent

Every remaining id in the 255-id inventory belongs to something outside the simulation: the Arceuus
thrall's cast/impact (211/212) and resurrect (5063/5054), fire walls and the stepping-stone approach
(10215, 2461), the Inferno captures' remaining player-spell ids (104–106, 170/171), Vardorvis
(7139, 7078, 7145, 7109), the Leviathan (7028–7051) and
Colosseum waves (8348 javelin, 8382 manticore, 5774 shockwave, 8339 serpent mager). When one of
those is added, its ids are here.

## 8. Uncaptured lookups

For sounds no capture covers, consult
[`SoundEffectID.java`](https://github.com/runelite/runelite/blob/ced4c4aba7a3cb7cace42e1f0c25a5f79b7faef2/runelite-api/src/main/java/net/runelite/api/SoundEffectID.java)
(RuneLite, BSD-2-Clause) for prayer/UI/skilling constants and rsmod's `synth.sym` /
`ElementalSpells.kt` (ISC) for spell cast/impact names. Treat those as unverified candidates: where
they disagree with a capture (bow 2693, 510 as "damage taken"), the capture wins. Undead Grasp's
5030 + 5055 are not used anywhere; the spell is not implemented. 6412 is a frame sound (seq 9543, spotanim 2125, in `extracted-frame-sounds.json`), not
a rule candidate.
