import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SPECIAL_ATTACK_REGISTRY } from '../../core/combat/player/specialAttacks/registry';
import { PLAYER_ANIMATION_SEQ_IDS } from '../../data/weaponAnimations';
import { HANDWRITTEN_WEAPON_COMBAT_VISUALS } from '../../data/weaponCombatVisuals';
import {
  collectDeclaredNpcSeqIds,
  collectDeclaredSpotAnimIds,
  collectLoadedNpcTypes,
} from '../../encounters/renderConfigs';
import type { ReplayEffectSourceFrame } from '../../render/core/replayEffectContext';
import { PlayerGraphicController } from '../../render/effects/controllers/PlayerGraphicController';
import { describePlayerEffects } from '../../render/effects/playerEffectDescriptors';
import { SpotAnimRenderer } from '../../render/effects/SpotAnimRenderer';
import { npcBaseSeqIds } from '../../render/npc/npcBaseSeqIds';
import type { CacheInfo } from '../../rs/cache/CacheInfo';
import { CacheSystem } from '../../rs/cache/CacheSystem';
import { Bzip2 } from '../../rs/compression/Bzip2';
import { ArchiveNpcTypeLoader } from '../../rs/config/npctype/NpcTypeLoader';
import type { SeqSoundEffect, SeqType } from '../../rs/config/seqtype/SeqType';
import { ArchiveSeqTypeLoader } from '../../rs/config/seqtype/SeqTypeLoader';
import { readCacheZipFiles } from '../../test/helpers/cacheZipFiles';
import { setupOutputPath, skipWithoutSetup } from '../../test/helpers/setupAssets';
import type { AudioEngine } from '../AudioEngine';
import extractedFrameSounds from '../extracted-frame-sounds.json';
import { FrameSoundTracker } from '../FrameSoundTracker';
import { FRAME_SOUND_IDS } from '../frameSoundManifest';

/**
 * The extraction keeps only ids; the frame tables stay in the cache. Cases that need a table read
 * it from the pinned cache `npm run setup` downloads, and skip without it.
 */
const noCache = skipWithoutSetup('fullCache');
let seqs: ArchiveSeqTypeLoader;
let npcTypes: ArchiveNpcTypeLoader;

beforeAll(async () => {
  if (noCache) return;
  await Bzip2.initWasm();
  const cache = CacheSystem.fromMap('dat2', await readCacheZipFiles(setupOutputPath('fullCache')), [2]);
  const info: CacheInfo = {
    name: 'osrs',
    game: 'oldschool',
    environment: 'live',
    revision: 242,
    timestamp: '',
    size: 0,
  };
  seqs = new ArchiveSeqTypeLoader(info, cache.getIndex(2).getArchive(12));
  npcTypes = new ArchiveNpcTypeLoader(info, cache.getIndex(2).getArchive(9));
}, 120_000);

/** A sequence's frame sounds as `[frame, sound ids]`, in frame order. */
function frameSoundIds(seq: SeqType): [number, number[]][] {
  return [...(seq.frameSounds ?? new Map<number, SeqSoundEffect[]>())]
    .sort(([a], [b]) => a - b)
    .map(([frame, sounds]) => [frame, sounds.map((sound) => sound.id)]);
}

describe('FRAME_SOUND_IDS', () => {
  // A clip declared after the last extraction run would play with its baked frame sounds silent:
  // their ids never reach the preload set or the trimmed cache's sound effects.
  it('was extracted after every npc clip the encounter render configs declare', () => {
    const checked = new Set(extractedFrameSounds.checkedSeqIds);
    const unchecked = [...collectDeclaredNpcSeqIds()]
      .filter(([seqId]) => !checked.has(seqId))
      .map(([seqId, label]) => `${seqId} (${label})`);

    expect(unchecked, 'run `npx tsx scripts/extract-frame-sounds.ts`').toEqual([]);
  });

  // An encounter effect's sequence carries frame sounds as an NPC clip does, and most encounter
  // effects are not `SpotAnimID` members, so the extraction has to walk the render configs' list.
  it('was extracted after every spotanim the encounter render configs declare', () => {
    const checked = new Set(extractedFrameSounds.checkedSpotAnimIds);
    const unchecked = [...collectDeclaredSpotAnimIds()]
      .filter(([spotAnimId]) => !checked.has(spotAnimId))
      .map(([spotAnimId, label]) => `${spotAnimId} (${label})`);

    expect(unchecked, 'run `npx tsx scripts/extract-frame-sounds.ts`').toEqual([]);
  });

  // A loaded type without an idle or walk override plays its cache type's own (Sol Heredit walks on
  // cache seq 10878, whose steps are sounds 8248 and 8143). No render config names those clips.
  it.skipIf(noCache)("was extracted after every loaded npc type's idle and walk, cache defaults included", () => {
    const checked = new Set(extractedFrameSounds.checkedSeqIds);
    const unchecked: string[] = [];
    for (const { npcTypeId, overrides, label } of collectLoadedNpcTypes()) {
      const { idleSeqId, walkSeqId } = npcBaseSeqIds(npcTypes.load(npcTypeId), overrides);
      if (idleSeqId >= 0 && !checked.has(idleSeqId)) unchecked.push(`${idleSeqId} (${label} idle)`);
      if (walkSeqId >= 0 && !checked.has(walkSeqId)) unchecked.push(`${walkSeqId} (${label} walk)`);
    }

    expect(unchecked, 'run `npx tsx scripts/extract-frame-sounds.ts`').toEqual([]);
  });

  it.skipIf(noCache)('includes the voidflare spawn clip sound', () => {
    expect(frameSoundIds(seqs.load(12135))).toEqual([[9, [10253]]]);
    expect(FRAME_SOUND_IDS).toContain(10253);
  });
});

/**
 * Sounds that hang off a weapon's or special attack's spotanim exist only in its sequence's frame
 * sounds: the server never sends them. A graphic played without its sequence having been extracted
 * ships those ids with no sound data in the trimmed cache and no preload.
 */
describe('weapon and special attack frame sounds', () => {
  const checkedSpotAnims = new Set(extractedFrameSounds.checkedSpotAnimIds);
  const checkedSeqs = new Set(extractedFrameSounds.checkedSeqIds);

  it('was extracted after every spotanim a weapon or special attack plays', () => {
    const played = [
      ...HANDWRITTEN_WEAPON_COMBAT_VISUALS.flatMap((v) => [v.castSpotanim, v.projectileId, v.hitSpotanim]),
      ...Object.values(SPECIAL_ATTACK_REGISTRY).flatMap((def) => [
        def.graphicId,
        def.targetGraphic?.spotAnimId,
        ...(def.onKillEffect?.targetGraphicBySize ?? []),
      ]),
    ].filter((id): id is number => typeof id === 'number' && id >= 0);

    expect(
      played.filter((id) => !checkedSpotAnims.has(id)),
      'run `npx tsx scripts/extract-frame-sounds.ts`',
    ).toEqual([]);
  });

  it("was extracted after every player clip, special attacks' included", () => {
    const clips = [
      ...PLAYER_ANIMATION_SEQ_IDS,
      ...Object.values(SPECIAL_ATTACK_REGISTRY).map((def) => def.animationId),
    ].filter((id): id is number => typeof id === 'number' && id > 0);

    expect(
      clips.filter((id) => !checkedSeqs.has(id)),
      'run `npx tsx scripts/extract-frame-sounds.ts`',
    ).toEqual([]);
  });

  // Eviscerate: spotanim 2833 (spotanim_weapon_sword_osmumten_special) runs seq 11239, whose frames
  // carry the special's whole sound; capture `weapon-soulreaper-fang-…-packet-data.txt`
  // sends none on its tick (522).
  const EVISCERATE_SEQ = 11239;

  it.skipIf(noCache)("carries Eviscerate's three swipes on its player graphic's sequence", () => {
    expect(frameSoundIds(seqs.load(EVISCERATE_SEQ))).toEqual([
      [1, [9367]],
      [7, [9366]],
      [8, [9365]],
    ]);
    expect(FRAME_SOUND_IDS).toEqual(expect.arrayContaining([9365, 9366, 9367]));
  });

  it.skipIf(noCache)('plays them off the graphic an Eviscerate attaches to the player', () => {
    const eviscerate = seqs.load(EVISCERATE_SEQ);
    const attack = {
      state: { playerPosition: [30, 30], primaryNpcPosition: [30, 31], primaryNpcSize: 1, npcs: [] },
      events: [
        {
          type: 'attack_started',
          eventId: 1,
          tick: 10,
          sourceId: 'player',
          targetId: 'dummy',
          style: 'melee',
          attackKind: 'melee_stab',
          weaponId: 26219,
          usingSpecialAttack: true,
        },
      ],
    } as unknown as ReplayEffectSourceFrame;
    const graphic = describePlayerEffects(attack).find((effect) => effect.kind === 'graphic');
    expect(graphic).toMatchObject({ spotAnimId: 2833, tick: 10 });
    if (graphic?.kind !== 'graphic') return;

    const FRAMES = 15;
    const renderer = new SpotAnimRenderer();
    renderer['meshCache'].set(2833, {
      static: [],
      frames: Array.from({ length: FRAMES }, () => []),
      frameLengths: Array.from({ length: FRAMES }, () => 4),
      frameStep: -1,
      heightOffset: 0,
      seqType: {
        id: EVISCERATE_SEQ,
        frameSounds: eviscerate.frameSounds,
        isLooping: () => false,
      } as never,
    });
    const controller = new PlayerGraphicController();
    controller.consumeDescriptor(graphic);
    const play = vi.fn();
    const tracker = new FrameSoundTracker({ play } as unknown as AudioEngine);

    // Two game ticks of client cycles cover the graphic's 60.
    for (let cycle = 300; cycle <= 360; cycle += 2) {
      controller.update(renderer, {
        currentTick: Math.floor(cycle / 30),
        interpolatedTick: cycle / 30,
        playerVisualPosition: [30, 30],
        facingAngle: 0,
        playerModelLift: 0,
        spotAnimModelLoader: null,
      });
      renderer.tick(Math.floor(cycle / 30), cycle / 30);
      tracker.update(renderer.getFrameStates(), [30, 30]);
    }

    expect(play.mock.calls.map(([id]) => id)).toEqual([9367, 9366, 9365]);
  });
});
