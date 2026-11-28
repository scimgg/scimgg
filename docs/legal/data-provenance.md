# Data provenance

Where the game data this project uses comes from, and the terms it carries. The licensing summary
is in [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md); this file has the per-file detail.
Update the retrieval date below whenever `scripts/sync-osrs-data.ts` or
`scripts/sync-osrs-spells.ts` is re-run and its output committed.

## Summary

Two origins, kept apart:

| Origin | Covers | Terms |
|---|---|---|
| The OSRS game cache | Player-equipment bonuses, weapon attack speed and attack range, item names, models, animations, map data | Jagex's. Not in the repository: `npm run setup` downloads it, and its terms bind whoever downloads it. |
| The Old School RuneScape Wiki | Weapon categories, item slot and id groupings, monster combat stats, combat spell stats | CC BY-NC-SA 3.0 |

*Equipment* bonuses come from the cache, not the Wiki. Monster stats are the other way round:
`monsters.json` carries the Wiki's own offensive, defensive and attack-speed values.

---

## Cache-derived data

`npm run setup` downloads the pinned cache (`scripts/pinnedCache.ts`) from
`https://archive.openrs2.org/caches/` with `scripts/fetch-cache.ts`, and reduces it with
`scripts/trim-cache.ts`. None of it is committed.

Equipment bonuses are read from the object-type parameter map (opcode 249) in
`src/types/equipmentStats.ts`. This is Jagex's own data and the source of every worn-equipment
combat bonus, attack speed and attack range in the simulator. It does not cover monsters; those
come from the Wiki dataset below. `npx tsx scripts/verify-equipment-params.ts` checks the param ids
against the Wiki's published bonuses for a set of witness items.

---

## Wiki-derived datasets

Retrieved from the OSRS Wiki's public Bucket API by
[`scripts/sync-osrs-data.ts`](../../scripts/sync-osrs-data.ts).

**Endpoint:** `https://oldschool.runescape.wiki/api.php?action=bucket`

**Retrieved:** 2026-09-16

The Duke Sucellus entries in `monsters.json` were retrieved on 2026-11-25.

The table lists the fields each file keeps after the transformations below, not every field the
bucket offers. A field the sync script reads and then discards is not redistributed.

| File | Bucket | Fields retained |
|---|---|---|
| `src/data/osrs/equipment.json` | `infobox_bonuses` ⋈ `infobox_item` | `ids`, `name`, `slot`, `category` (weapon category), and `version` from the version anchor or, failing that, the page title's qualifier. No bonuses: those come from the cache. |
| `src/data/osrs/monsters.json` | `infobox_monster` | `ids`, `name`, `size`, `levels`, `offensive`, `defensive`, `attackSpeed`, `attributes`, `elementalWeakness`, `immunities`, and `version` on the rows that have a version anchor. |
| `src/data/osrs/itemAliases.json` | Derived from the above | Variant item id → canonical id |

Two more files sit in the same directory and are distributed under the same license:

- **`manualEquipment.json`** is hand-written metadata for the few pages whose row counts disagree
  and which the sync therefore drops. Each entry carries a `_why`. It is merged with
  `equipment.json` in `src/data/equipmentCatalog.ts`.
- **`spells.json`** is built from spell articles by a separate script; see
  [below](#spellsjson).

Wiki-derived data outside this directory, under the same license, is listed in
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md#osrs-wiki-derived-data).

### Transformations applied

Recorded because the CC license distinguishes a verbatim Collection from an Adaptation, and
because these shapes are ours rather than the Wiki's.

- **Field selection and renaming.** Our own schema, grouped by concern (`attack` / `defence` /
  `strength`), not the Wiki's flat infobox fields. Fields not listed in the table above are dropped
  at sync time.
- **Bonuses dropped from `equipment.json`.** They are read from the game cache instead. Only
  metadata survives.
- **Version pairing.** `infobox_bonuses` carries no version anchor, so its rows are paired by
  position against `infobox_item` rows to keep charged and uncharged variants apart. The anchor is
  kept as `version` on rows that carry one. A row without one, on a page titled
  `<item name> (<qualifier>)` (Last Man Standing copies, team colors, heraldry), takes the
  qualifier as its `version` instead; stacked qualifiers are joined with a comma. Otherwise
  `version` is omitted. Pages whose row counts disagree are dropped and reported by the script.
  When every stat row on a page is identical, each item row keeps its own name and version rather
  than taking the first row's.
- **Unequippable ids dropped.** Ids the local game cache cannot put in an equipment slot (broken
  and mangled copies, inactive Bounty Hunter gear and similar) are removed from `equipment.json`
  and never become aliases: an id needs both a wear position and an equip op (Wear, Wield, Equip,
  Hold or Ride). The cache is read only for this check; ids it does not contain yet are kept.
- **Monsters filtered.** `sync-osrs-data.ts` filters `monsters.json` to the NPCs the simulator can
  spawn, the NPC roots the cache trim follows (`collectCacheRoots(discoverCacheUsage(...))`).
- **Alias derivation.** Two ids alias only when they share a base name after stripping selected
  qualifiers (`(or)`, `(l)`, `(deadman)`, `(beta)`, `(bh)`, `(cr)`, `(ritual)`, `(nz)`), an
  equipment slot, and a byte-identical stat line. Derived mechanically, with no hand-maintained
  exceptions. These aliases do not establish combat equivalence: equal bonuses do not prove equal
  charge rules, passives, special attacks or mode restrictions. The separate, cited
  [equipment combat families](../architecture/equipment-combat-families.md) preserve those
  boundaries without changing this dataset.
- **Normalization.** Monster attributes and elemental-weakness elements are lower-cased; magic
  damage is stored as a percentage.

### `spells.json`

Rebuilt from the OSRS Wiki (CC BY-NC-SA 3.0) on 2026-11-24 by
[`scripts/sync-osrs-spells.ts`](../../scripts/sync-osrs-spells.ts). Every field (`name`,
`spellbook`, `element`, `maxHit`, `scalesWithMagic`, `secondaryEffect`) comes from the Wiki pages
below, and `--check` compares the Wiki with the committed file.

**Endpoint:** `https://oldschool.runescape.wiki/api.php?action=query&prop=revisions`, reading page
wikitext, because the Wiki's `infobox_spell` bucket does not carry damage. Consumed by
`src/data/spellCatalog.ts` and `src/core/combat/playerAttackRuntime.ts`.

| Field | Source |
|---|---|
| `name` | The spell's article title, which must equal its `{{Infobox Spell}}` `name`. Which 48 spells are listed, and their order, is this project's choice (the combat spells the simulator can cast, in autocast-picker order). |
| `spellbook` | Infobox `spellbook`: `Normal` → `standard`, `Ancient` → `ancient`, `Arceuus` → `arceuus`. |
| `element` | Infobox `element` when it is Air, Water, Earth or Fire, lower-cased; otherwise `null`. The Elemental weakness article limits elemental spells to the standard strike, bolt, blast, wave and surge spells, and the script fails if an infobox disagrees. |
| `maxHit` | Infobox `damage`. See the simplifications below. |
| `scalesWithMagic` | Set for Magic Dart, whose infobox damage is "10% of level + 10". `maxHit` is 0, and `playerAttackRuntime.ts` computes floor(Magic / 10) + 10. |
| `secondaryEffect` | The Ancient Magicks family articles: Smoke spells (poison severity 10 for Rush and Burst, 20 for Blitz and Barrage, from the article text), Shadow spells (Attack reduced, from the table), Blood spells (heals 25% of damage dealt, from the article text), Ice spells (base freeze duration, from the table). |

Three simulator simplifications are applied to the Wiki's `damage` value:

- **Standard elemental spells take their tier's top value.** The Wiki gives a range (Wind Strike
  "2, 4, 6, or 8") because a spell's base maximum rises with the highest spell of its tier the
  player can cast. The simulator stores the top value, which is reached once the tier's fire spell
  is available, and does not model the lower values.
- **God spells take the uncharged value** (20). Charge's 30 is not modeled.
- **Magic Dart ignores the Slayer's staff (e) on-task formula.**

The script also compares each infobox's `level`, rune types and cast `speed` with
`src/data/spellRunes.ts` and `SPELL_CAST_SPEED`, and writes none of them. All 48 agreed.

Revisions read on 2026-11-24 (title: revision id). Spell articles: Wind Strike 15341514,
Water Strike 15341515, Earth Strike 15341516, Fire Strike 15341518, Wind Bolt 15341519,
Water Bolt 15341520, Earth Bolt 15341521, Fire Bolt 15341476, Wind Blast 15394306,
Water Blast 15394305, Earth Blast 15394304, Fire Blast 15394303, Wind Wave 15341526,
Water Wave 15341527, Earth Wave 15341528, Fire Wave 15341529, Wind Surge 15394286,
Water Surge 15394289, Earth Surge 15394290, Fire Surge 15394291, Saradomin Strike 15410418,
Claws of Guthix 15366111, Flames of Zamorak 15366096, Crumble Undead 15395706, Iban Blast 15252693,
Magic Dart 15373581, Smoke Rush 14938734, Shadow Rush 15368093, Blood Rush 14779879,
Ice Rush 15407219, Smoke Burst 14938742, Shadow Burst 15252682, Blood Burst 15102375,
Ice Burst 15407217, Smoke Blitz 14938735, Shadow Blitz 14779886, Blood Blitz 14779887,
Ice Blitz 15407214, Smoke Barrage 15132555, Shadow Barrage 15358570, Blood Barrage 15020225,
Ice Barrage 15407223, Ghostly Grasp 15394298, Skeletal Grasp 15394299, Undead Grasp 15395454,
Inferior Demonbane 15353560, Superior Demonbane 15353559, Dark Demonbane 15353558. Reference
articles: Smoke spells 15409181, Shadow spells 15008756, Blood spells 15387785, Ice spells 15410917,
Elemental weakness 15384298.

Rerun with `npx tsx scripts/sync-osrs-spells.ts` to rebuild, or with `--check` to compare the Wiki
with the committed file without writing; `--check` exits 1 on any difference. Set
`OSRS_WIKI_USER_AGENT` as for the other sync. Responses are cached under `$SPELLS_WIKI_CACHE_DIR`
(default: `.setup-cache/wiki/spells/`, which git ignores), so a rerun makes no requests unless
`--refresh` is passed.

### Attribution

> This project contains data derived from the
> [Old School RuneScape Wiki](https://oldschool.runescape.wiki/), by OSRS Wiki contributors,
> licensed under [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/).

The dataset files are supplied under CC BY-NC-SA 3.0. The application source code is a separate
work under the MIT license; the CC license's own text is explicit that a Collection need not be
relicensed "apart from the Work itself".

### Conditions that carry over to forks

- **NonCommercial.** CC BY-NC-SA 3.0 §4(c) forbids use "primarily intended for or directed toward
  commercial advantage or private monetary compensation". A fork that takes revenue must remove or
  replace this data first.
- **ShareAlike.** Adaptations of the data must be distributed under the same license.
- **Automated access.** `sync-osrs-data.ts` makes bulk, rate-limited requests to the Wiki's API;
  `sync-osrs-spells.ts` makes two. The Wiki's operator, Weird Gloop, does not allow using its sites
  "in an automated fashion without prior consent" ([terms](https://weirdgloop.org/terms/)), which
  takes in these scripts' requests to the Wiki's API. A fork that runs
  either script must obtain that consent itself; no consent is recorded here, and none passes to a
  fork. The default `npm run setup` does not query the Wiki: it uses the committed datasets. Set
  `OSRS_WIKI_USER_AGENT` to your project and a contact address, as the Wiki's API etiquette asks of
  automated clients. Each script's default User-Agent is generic, identifies nobody, and makes it
  print a warning.

---

## Jagex's content

The game cache, and everything generated from it, belongs to Jagex Ltd. This project does not
license it and claims no permission from Jagex. Whoever runs `npm run setup` downloads it under
Jagex's own terms, linked from
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md#downloaded-by-npm-run-setup).

---

*This file records sourcing and the terms attached to it. It is not legal advice.*
