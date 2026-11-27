/**
 * Extract frameSounds from SeqType cache data for every animation sequence the
 * app can play: core player clips, weapon attack clips, spotanim sequences (encounter
 * render config effects included), and every NPC clip declared by an encounter render config.
 *
 * Usage: npx tsx scripts/extract-frame-sounds.ts
 *
 * Reads the pinned full cache `npm run setup` downloads, iterates over all relevant SeqType IDs,
 * prints their frameSounds data, and writes src/audio/extracted-frame-sounds.json: the sound ids
 * those frames play, and which seqs and spotanims were checked. The frame tables themselves stay in
 * the cache. The JSON is written unformatted, so then run `npm run check` to format it. Re-run after
 * declaring a new clip; frameSoundManifest.test.ts fails until you do.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SPECIAL_ATTACK_REGISTRY } from '../src/core/combat/player/specialAttacks/registry';
import { SPELL_VISUALS } from '../src/data/spellVisuals';
import { PLAYER_ANIMATION_SEQ_IDS } from '../src/data/weaponAnimations';
import { HANDWRITTEN_WEAPON_COMBAT_VISUALS } from '../src/data/weaponCombatVisuals';
import {
  ATTACK_ANIM_NAMES,
  WEAPON_ANIMATION_SETS,
  WEAPON_COMBAT_VISUALS,
} from '../src/data/weaponCombatVisuals.generated';
import { collectDeclaredNpcSeqIds, collectDeclaredSpotAnimIds } from '../src/encounters/renderConfigs';
import type { CacheInfo } from '../src/rs/cache/CacheInfo';
import { CacheSystem } from '../src/rs/cache/CacheSystem';
import { Bzip2 } from '../src/rs/compression/Bzip2';
import type { SeqSoundEffect, SeqType } from '../src/rs/config/seqtype/SeqType';
import { ArchiveSeqTypeLoader } from '../src/rs/config/seqtype/SeqTypeLoader';
import { SpotAnimID } from '../src/rs/config/spotanimtype/SpotAnimID';
import { ArchiveSpotAnimTypeLoader } from '../src/rs/config/spotanimtype/SpotAnimTypeLoader';
import { readCacheZipFiles } from '../src/test/helpers/cacheZipFiles';
import { FULL_CACHE_ZIP, PINNED_CACHE } from './pinnedCache';

const SCRIPT_DIR = import.meta.dirname;

const CONFIG_INDEX = 2;
const SEQ_ARCHIVE = 12;
const SPOTANIM_ARCHIVE = 13;

const CACHE_INFO: CacheInfo = {
  name: 'osrs-extract',
  game: 'oldschool',
  environment: 'live',
  revision: PINNED_CACHE.builds[0].major,
  timestamp: PINNED_CACHE.timestamp,
  size: 0,
};

/**
 * Sequences no encounter render config declares. NPC clips do NOT belong here: they are collected
 * from the render configs by `collectDeclaredNpcSeqIds`, so a newly declared clip is extracted
 * without anyone remembering this list.
 */
const CORE_SEQ_IDS: Record<number, string> = {
  714: 'Player eat',
  829: 'Player eat (renderer)',
  8970: 'Player death',
  12152: 'Player intro',
  12156: 'Yama summon',
};

/**
 * Every spotanim the app can draw: from a weapon, spell or special attack, and every effect an
 * encounter render config declares. The handwritten visuals and the special-attack registry matter
 * as much as the generated table: Eviscerate's swipe sounds hang off its player graphic's sequence,
 * not off the swing or the server. Encounter effects need not be `SpotAnimID` members.
 */
function collectPlayedSpotAnimIds(): Set<number> {
  const visuals = [...Object.values(WEAPON_COMBAT_VISUALS), ...HANDWRITTEN_WEAPON_COMBAT_VISUALS];
  return new Set<number>(
    [
      ...Object.values(SpotAnimID),
      ...collectDeclaredSpotAnimIds().keys(),
      ...visuals.flatMap((v) => [v.castSpotanim, v.projectileId, v.hitSpotanim]),
      ...Object.values(SPELL_VISUALS).flatMap((v) => [v.castSpotanimId, v.projectileId, v.hitSpotanimId]),
      ...Object.values(SPECIAL_ATTACK_REGISTRY).flatMap((def) => [
        def.graphicId,
        def.targetGraphic?.spotAnimId,
        ...(def.onKillEffect?.targetGraphicBySize ?? []),
      ]),
    ].filter((id): id is number => typeof id === 'number' && id >= 0),
  );
}

/**
 * Sequences reached through a SPOTANIM rather than an actor's own animation. `FrameSoundTracker`
 * walks both, and some sounds exist only on this side — Yama's range-vs-mage tell is entirely
 * spotanim frame sounds — so leaving them out ships rules whose sounds the trimmed cache lacks.
 */
function collectSpotAnimSeqIds(spotLoader: ArchiveSpotAnimTypeLoader, spotAnimIds: Set<number>): Map<number, string> {
  const ids = new Map<number, string>();
  for (const spotAnimId of spotAnimIds) {
    if (typeof spotAnimId !== 'number' || spotAnimId < 0) continue;
    let seqId: number;
    try {
      seqId = spotLoader.load(spotAnimId).sequenceId;
    } catch (error) {
      // Most ids in this set are not spotanims (projectile ids, sentinels), so a load failure is
      // expected and must not abort the run. It is still logged because a broken SpotAnimTypeLoader
      // throws here too, and swallowing that emits a manifest with no spotanim sounds and no sign
      // anything went wrong.
      console.warn(`  ! spotanim ${spotAnimId} did not load: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    if (seqId > 0 && !ids.has(seqId)) {
      ids.set(seqId, `spotanim_${spotAnimId}`);
    }
  }
  return ids;
}

function collectAllSeqIds(): Map<number, string> {
  const ids = new Map<number, string>();

  for (const [id, label] of Object.entries(CORE_SEQ_IDS)) {
    ids.set(Number(id), label);
  }

  for (const [seqId, label] of collectDeclaredNpcSeqIds()) {
    if (!ids.has(seqId)) ids.set(seqId, label);
  }

  for (const [itemId, animSet] of Object.entries(WEAPON_ANIMATION_SETS)) {
    const attackFields = ['attackStyle1', 'attackStyle2', 'attackStyle3', 'attackStyle4', 'mainAttack'] as const;
    for (const field of attackFields) {
      const seqId = animSet[field];
      if (seqId > 0 && !ids.has(seqId)) {
        const name = ATTACK_ANIM_NAMES[seqId] ?? `weapon_${itemId}_${field}`;
        ids.set(seqId, name);
      }
    }
  }

  for (const [itemId, visuals] of Object.entries(WEAPON_COMBAT_VISUALS)) {
    const seqId = visuals.attackAnimation;
    if (seqId > 0 && !ids.has(seqId)) {
      const name = ATTACK_ANIM_NAMES[seqId] ?? `combatVisual_${itemId}`;
      ids.set(seqId, name);
    }
  }

  // The player's own clips outside the generated table: handwritten poses and per-style swings,
  // handwritten attack visuals, spell casts, and every special attack's swing.
  const playerSeqIds = [
    ...PLAYER_ANIMATION_SEQ_IDS.map((seqId) => [seqId, 'player_animation'] as const),
    ...HANDWRITTEN_WEAPON_COMBAT_VISUALS.map((v) => [v.attackAnimation, 'handwritten_attack'] as const),
    ...Object.entries(SPELL_VISUALS).flatMap(([spell, v]) => [
      [v.castAnimationId, `spell_${spell}`] as const,
      [v.fallbackAnimationId, `spell_${spell}_fallback`] as const,
    ]),
    ...Object.entries(SPECIAL_ATTACK_REGISTRY).map(([itemId, def]) => [def.animationId, `special_${itemId}`] as const),
  ];
  for (const [seqId, label] of playerSeqIds) {
    if (typeof seqId === 'number' && seqId > 0 && !ids.has(seqId)) ids.set(seqId, label);
  }

  return ids;
}

interface FrameSoundEntry {
  seqId: number;
  label: string;
  isSkeletalSeq: boolean;
  frameCount: number;
  frameSounds: Array<{
    frame: number;
    sounds: Array<{ id: number; loops: number; location: number; retain: number }>;
  }>;
}

function extractFrameSounds(seqType: SeqType): FrameSoundEntry['frameSounds'] {
  if (!seqType.frameSounds || seqType.frameSounds.size === 0) return [];
  const result: FrameSoundEntry['frameSounds'] = [];
  const sortedFrames = [...seqType.frameSounds.keys()].sort((a, b) => a - b);
  for (const frame of sortedFrames) {
    const effects = seqType.frameSounds.get(frame);
    if (!effects || effects.length === 0) continue;
    result.push({
      frame,
      sounds: effects.map((e: SeqSoundEffect) => ({
        id: e.id,
        loops: e.loops,
        location: e.location,
        retain: e.retain,
      })),
    });
  }
  return result;
}

async function main(): Promise<void> {
  console.log('=== OSRS SeqType frameSounds Extraction ===\n');

  if (!existsSync(FULL_CACHE_ZIP))
    throw new Error(`No pinned cache at ${FULL_CACHE_ZIP}: run \`npm run setup\` first.`);
  await Bzip2.initWasm();
  const files = await readCacheZipFiles(FULL_CACHE_ZIP);
  const cacheSystem = CacheSystem.fromMap('dat2', files, [CONFIG_INDEX]);
  const configIndex = cacheSystem.getIndex(CONFIG_INDEX);
  const seqArchive = configIndex.getArchive(SEQ_ARCHIVE);
  const loader = new ArchiveSeqTypeLoader(CACHE_INFO, seqArchive);
  const spotLoader = new ArchiveSpotAnimTypeLoader(CACHE_INFO, configIndex.getArchive(SPOTANIM_ARCHIVE));

  const seqIds = collectAllSeqIds();
  const spotAnimIds = collectPlayedSpotAnimIds();
  for (const [seqId, label] of collectSpotAnimSeqIds(spotLoader, spotAnimIds)) {
    if (!seqIds.has(seqId)) {
      seqIds.set(seqId, label);
    }
  }
  console.log(`\nCollected ${seqIds.size} unique seq IDs to check.\n`);

  const results: FrameSoundEntry[] = [];
  const allSoundIds = new Set<number>();
  let withSounds = 0;
  let withoutSounds = 0;
  let loadErrors = 0;

  for (const [seqId, label] of seqIds) {
    try {
      const seqType = loader.load(seqId);
      const frameSounds = extractFrameSounds(seqType);
      const entry: FrameSoundEntry = {
        seqId,
        label,
        isSkeletalSeq: seqType.isSkeletalSeq(),
        frameCount: seqType.getFrameCount(),
        frameSounds,
      };
      results.push(entry);

      if (frameSounds.length > 0) {
        withSounds++;
        for (const fs of frameSounds) {
          for (const s of fs.sounds) {
            allSoundIds.add(s.id);
          }
        }
      } else {
        withoutSounds++;
      }
    } catch (e) {
      loadErrors++;
      console.error(`  ERROR loading seq ${seqId} (${label}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log('=== Results ===\n');
  console.log(`Total: ${results.length} loaded, ${loadErrors} errors`);
  console.log(`With frameSounds: ${withSounds}`);
  console.log(`Without frameSounds: ${withoutSounds}`);
  console.log(`Unique sound IDs found: ${allSoundIds.size}`);
  console.log('');

  const withSoundEntries = results.filter((r) => r.frameSounds.length > 0);
  if (withSoundEntries.length > 0) {
    console.log('--- Sequences with frameSounds ---\n');
    for (const entry of withSoundEntries) {
      const skeletal = entry.isSkeletalSeq ? ' [skeletal]' : '';
      console.log(`  seq=${entry.seqId} (${entry.label})${skeletal} frames=${entry.frameCount}`);
      for (const fs of entry.frameSounds) {
        for (const s of fs.sounds) {
          console.log(
            `    frame ${fs.frame}: soundId=${s.id} loops=${s.loops} location=${s.location} retain=${s.retain}`,
          );
        }
      }
    }
  }

  if (allSoundIds.size > 0) {
    const sorted = [...allSoundIds].sort((a, b) => a - b);
    console.log(`\n--- All unique sound IDs (${sorted.length}) ---\n`);
    console.log(`  ${sorted.join(', ')}`);
  }

  console.log('\n--- Core and encounter NPC seq IDs status ---\n');
  const statusSeqIds: Array<[number, string]> = [
    ...Object.entries(CORE_SEQ_IDS).map(([id, label]): [number, string] => [Number(id), label]),
    ...collectDeclaredNpcSeqIds(),
  ];
  for (const [id, label] of statusSeqIds) {
    const entry = results.find((r) => r.seqId === Number(id));
    if (!entry) {
      console.log(`  seq=${id} (${label}): LOAD FAILED`);
    } else if (entry.frameSounds.length > 0) {
      const soundIds = entry.frameSounds.flatMap((fs) => fs.sounds.map((s) => s.id));
      console.log(`  seq=${id} (${label}): ${soundIds.length} sound(s) → [${soundIds.join(', ')}]`);
    } else {
      const skeletal = entry.isSkeletalSeq ? ' [skeletal - sounds may be in opcode 14]' : '';
      console.log(`  seq=${id} (${label}): no frameSounds${skeletal}`);
    }
  }

  const outputDir = join(resolve(SCRIPT_DIR, '..'), 'src', 'audio');
  const outputPath = join(outputDir, 'extracted-frame-sounds.json');
  const jsonOutput = {
    cache: PINNED_CACHE.id,
    uniqueSoundIds: [...allSoundIds].sort((a, b) => a - b),
    // Every seq id that loaded and was inspected, sounds or not, so tests can tell "checked and
    // silent" from "never checked" (declared after the last extraction run).
    checkedSeqIds: results.map((r) => r.seqId).sort((a, b) => a - b),
    // Every spotanim whose sequence was looked up, so tests can tell a newly played graphic (a special
    // attack's `graphicId`, say) from one this run already covered.
    checkedSpotAnimIds: [...spotAnimIds].sort((a, b) => a - b),
  };
  writeFileSync(outputPath, `${JSON.stringify(jsonOutput, null, 2)}\n`);
  console.log(`\nJSON output written to: ${outputPath}`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exitCode = 1;
});
