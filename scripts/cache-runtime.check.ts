/**
 * Runtime cache coverage: drives production simulation and render-loading code against the
 * trimmed artifact that ships, records every archive it reads, and fails on any read the artifact
 * serves empty or in a container the production mirror may not use (stored and gzip only, no bzip2).
 * Independent of the trimmer's root discovery by design; see `cacheRuntimeFixture.ts`. Run with
 * `npm run check:cache-runtime` (`CACHE_RUNTIME_TRIMMED_DIR=dist/osrs-cache` checks a built artifact). */
// biome-ignore-all lint/complexity/useLiteralKeys: the check reads private engine and renderer state, which TypeScript allows only through bracket access.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CacheManager } from '../src/cache/CacheManager';
import { toCollisionLocInput } from '../src/core/arena/collisionSpec';
import { isAmmoCompatible, weaponRequiresExternalAmmo } from '../src/core/combat/ammoCompatibility';
import type { AttackKind } from '../src/core/combat/attackTypes';
import { getSpecialAttackDef } from '../src/core/combat/player/specialAttacks/registry';
import { hasRune } from '../src/core/combat/runeAvailability';
import {
  clearResolvedArenaConfigs,
  setArenaConfig,
  setDefaultArenaConfig,
  setResolvedArenaConfig,
} from '../src/core/constants';
import type { EncounterCommand } from '../src/core/encounters/commands';
import type { EncounterModifierSelection, EncounterModifierTier } from '../src/core/encounters/encounterFactory';
import { isEncounterVisualEvent } from '../src/core/events/encounterVisual';
import { type GameEvent, isCoreEvent } from '../src/core/events/types';
import { mulberry32 } from '../src/core/rng';
import type { SimulationEngine } from '../src/core/SimulationEngine';
import { CUSTOMIZABLE_GEAR_SLOTS, getAmmoCatalog, getGearCatalog } from '../src/data/customEquipmentPresets';
import { findEquipmentCatalogItem } from '../src/data/equipmentCatalog';
import { getItemAction, ITEM_ACTIONS, type ItemActionOption } from '../src/data/itemEffects';
import { collectItemIconIds } from '../src/data/itemIconIds';
import { EQUIPMENT_PRESETS } from '../src/data/playerPresets';
import { getAutocastableSpells } from '../src/data/spellCatalog';
import { DEATH_CHARGE_SPELL, getSpellRuneRequirement } from '../src/data/spellRunes';
import { getMeleeSweep, getWeaponCombatVisuals } from '../src/data/weaponCombatVisuals';
import { isRetiredEncounterKind } from '../src/encounters/catalog';
import { LOBBY_BOSS_NPCS } from '../src/encounters/lobby/metadata';
import { encounterControlsForKind, encounterEnablesIntro, resolveEncounterEntry } from '../src/encounters/modules';
import { encounterDefaultCamera } from '../src/encounters/presentationModules';
import { ALL_ENCOUNTER_KINDS, encounterRegistry } from '../src/encounters/registry';
import { createSimulationEngineForNewRun } from '../src/encounters/simulationEngineFactory';
import { COLOSSEUM_SPOTANIMS } from '../src/npcs/colosseum/constants';
import type { AnimationSequence } from '../src/render/core/animation';
import type { RenderQueue } from '../src/render/core/commands';
import { sharedModelTextureIndex } from '../src/render/core/modelTextures';
import { playerAttackSequenceIds } from '../src/render/core/replayPrimaryCues';
import { describePlayerEffects, type PlayerEffectDescriptor } from '../src/render/effects/playerEffectDescriptors';
import type { PlayerAnimationSet, PlayerPoseSet } from '../src/render/player/playerAnimationTypes';
import { createProjection3D, type Projection3D } from '../src/render/projections/Projection3D';
import { getEncounterRenderConfig } from '../src/render/scene/encounterRenderConfig';
import { SceneCompositor } from '../src/render/scene/SceneCompositor';
import { createSceneBuilderForKind } from '../src/render/scene/sceneBuilderFactory';
import type { RenderContext, SceneBuilderLike } from '../src/render/scene/types';
import type { LocTypeInfo } from '../src/rs/map/MapLoader';
import type { ModelData } from '../src/rs/model/ModelData';
import type { PlayerEquipment } from '../src/rs/model/PlayerModelLoader';
import { getAutocastSpell, getWeaponCategory, resolveActiveSpell } from '../src/types/attackStyles';
import type { CombatSupplies } from '../src/types/encounterLoadout';
import { createEmptyCombatSupplies } from '../src/types/encounterLoadout';
import { createEmptyInventory, type Inventory } from '../src/types/inventory';
import { DEFAULT_PLAYER_CONFIG } from '../src/types/player';
import { createDefaultStats } from '../src/types/playerState';
import type { MechanicsConfig } from '../src/types/simulation';
import { ALL_SPELLBOOKS, type SpellbookType } from '../src/types/spellbook';
import { log } from '../src/util/Logger';
import {
  type ArchiveProblem,
  ArchiveReadRecorder,
  DEFAULT_TRIMMED_DIR,
  findArchiveProblems,
  findUncoveredEncounterKinds,
  formatArchiveProblems,
  InMemoryCacheStorage,
  installArchiveReadTracing,
  LocalCacheTransport,
  readTrimmedManifest,
  type ScenarioContext,
  ScenarioRunner,
} from './cacheRuntimeFixture';

const TRIMMED_DIR = path.resolve(process.env.CACHE_RUNTIME_TRIMMED_DIR ?? DEFAULT_TRIMMED_DIR);
const VIEWPORT = { width: 1280, height: 720, dpr: 1 } as const;
const TICK_MS = 600;
const FRAMES_PER_TICK = 6;

/** Surge potion's graphic: an archive this check guards. */
const SURGE_GRAPHIC_MODEL_ARCHIVE = { indexId: 7, archiveId: 48339 } as const;

/**
 * Encounter-specific dynamic assets per kind. Every kind in `ALL_ENCOUNTER_KINDS` needs an entry,
 * so a new encounter fails this check until its runtime assets have a scenario.
 */
const fightAndDeath = (kind: string) => [`${kind} fight`, `${kind} boss death`];
const ENCOUNTER_DYNAMIC_COVERAGE: Readonly<Record<string, readonly string[]>> = {
  yama_p3: [...fightAndDeath('yama_p3'), 'yama_p3 commands'],
  // Contracts are Yama's fight under another contract config: their branches run in the fight.
  yama_p3_divine: fightAndDeath('yama_p3_divine'),
  yama_p3_forfeit_breath: fightAndDeath('yama_p3_forfeit_breath'),
  yama_p3_sensory: fightAndDeath('yama_p3_sensory'),
  yama_p3_bloodied: fightAndDeath('yama_p3_bloodied'),
  yama_p3_glyphic: fightAndDeath('yama_p3_glyphic'),
  // The lobby's only runtime assets are its scene bosses, loaded and posed by its startup.
  lobby: ['startup lobby'],
  // Run from the Zuk entry (wave 69), where the boss and Zuk's practice commands live.
  inferno: [...fightAndDeath('inferno'), 'inferno commands'],
  sol_heredit: [
    ...fightAndDeath('sol_heredit'),
    'sol_heredit commands',
    'sol modifier bees',
    'sol modifier solarflare',
    'sol modifier totemic',
    'sol modifier volatility',
    'sol modifier quartet berserker',
    'sol modifier quartet archer',
    'sol modifier quartet seer',
  ],
};

const recorder = new ArchiveReadRecorder();
const runner = new ScenarioRunner(recorder);
let tracing: ReturnType<typeof installArchiveReadTracing>;
let virtualNowMs = 1_000;
let cacheManager: CacheManager;
let cacheId = 0;

/** Session seed for `Math.random`, reset before each engine so its encounter seeds are fixed. */
const DEFAULT_RANDOM_SEED = 1;
let random = mulberry32(DEFAULT_RANDOM_SEED);

beforeEach(() => {
  log.setLevel('none');
  vi.spyOn(performance, 'now').mockImplementation(() => virtualNowMs);
  vi.spyOn(Math, 'random').mockImplementation(() => random());
  tracing = installArchiveReadTracing(recorder);
});

afterEach(() => {
  tracing.restore();
  vi.restoreAllMocks();
  sharedModelTextureIndex.setMapper(null);
  clearResolvedArenaConfigs();
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, false);
  setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
  log.setLevel('warn');
});

const OPTIONS_3D: RenderContext['options'] = {
  renderMode: '3d',
  showCoordinates: false,
  showNpcClickbox: false,
  showTileMarkers: false,
  showTileMarkerLabels: false,
  showLineMarkers: false,
  showLineMarkerLabels: false,
  smoothTerrain: false,
  brightness: 1,
  contrast: 1,
  saturation: 1,
  encounterDebugFlags: {},
};

interface Loadout {
  readonly equipment?: PlayerEquipment;
  readonly inventory?: Inventory;
  readonly supplies?: CombatSupplies;
}

interface EncounterSession {
  readonly kind: string;
  readonly engine: SimulationEngine;
  readonly scene: SceneBuilderLike;
  readonly compositor: SceneCompositor;
  readonly projection: Projection3D;
  events: GameEvent[];
  lastQueue: RenderQueue | null;
}

function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`[cache-runtime] ${what} unavailable`);
  return value;
}

/** The compositor behind a scene builder: Yama and the lobby wrap theirs, the others are one. */
function compositorOf(scene: SceneBuilderLike): SceneCompositor {
  if (scene instanceof SceneCompositor) return scene;
  const inner = (scene as unknown as { compositor?: unknown }).compositor;
  if (inner instanceof SceneCompositor) return inner;
  throw new Error('[cache-runtime] scene builder exposes no SceneCompositor');
}

/** Non-empty geometry for a spotanim the scene has loaded; undefined when it never loaded. */
function loadedSpotAnimParts(compositor: SceneCompositor, spotAnimId: number): number | undefined {
  const cache = compositor['spotAnimRenderer']['meshCache'] as Map<
    number,
    { static: unknown[]; frames: unknown[][]; seqType?: unknown; frameLengths: number[] }
  >;
  const entry = cache.get(spotAnimId);
  if (!entry) return undefined;
  const skeletal = compositor['spotAnimRenderer']['skeletalPosers'].has(spotAnimId) ? 1 : 0;
  return entry.static.length + entry.frames.reduce((sum, frame) => sum + frame.length, 0) + skeletal;
}

/**
 * Opens an encounter the way the app does: arena collision and map locs from the cache manager
 * (`useEncounterManager`), the registered scene builder loaded in `RenderViewport3D`'s order, and
 * an engine from the new-run factory.
 */
interface EncounterOptions {
  readonly enableIntro?: boolean;
  readonly mechanics?: Partial<MechanicsConfig>;
  readonly modifiers?: EncounterModifierSelection;
  /** Seeds `Math.random` just before the engine is built, which fixes its encounter and combat seeds. */
  readonly randomSeed?: number;
}

async function openEncounter(
  kind: string,
  loadout: Loadout = {},
  options: EncounterOptions = {},
): Promise<EncounterSession> {
  const descriptor = need(encounterRegistry.getDescriptorForKind(kind), `descriptor for ${kind}`);
  const mapLocs = descriptor.loadsMapLocs
    ? ((await cacheManager.loadMapLocs(descriptor.mapSquare.x, descriptor.mapSquare.y, descriptor.mapSquareOffsets)) ??
      [])
    : null;

  if ((descriptor.collision?.mode ?? 'auto') !== 'custom') {
    const seed = descriptor.collision?.seed ?? descriptor.playerStart;
    const config = await cacheManager.buildArenaConfig({
      mapX: descriptor.mapSquare.x,
      mapY: descriptor.mapSquare.y,
      seedX: seed[0],
      seedY: seed[1],
      mapSquareOffsets: descriptor.mapSquareOffsets,
      extraLocs: descriptor.collision?.dynamicLocs?.map(toCollisionLocInput),
      excludedStaticLocIds: descriptor.collision?.excludedStaticLocIds,
    });
    if (config.bounds !== null) setResolvedArenaConfig(descriptor.kind, config);
  }

  const renderConfig = getEncounterRenderConfig(kind);
  const scene = createSceneBuilderForKind(kind, { cacheManager, encounterRenderConfig: renderConfig });
  const compositor = compositorOf(scene);
  const animationSystem = need(cacheManager.getAnimationSystem(), 'animation system');
  const npcModelLoader = need(cacheManager.getNpcModelLoader(), 'npc model loader');

  const locTypeInfo = new Map<number, LocTypeInfo>();
  for (const { location, locType } of mapLocs ?? []) {
    locTypeInfo.set(location.id, { clipped: locType.clipped, sizeX: locType.sizeX, sizeY: locType.sizeY });
  }
  await scene.loadTerrain(
    need(cacheManager.getMapLoader(), 'map loader'),
    cacheManager.getUnderlayLoader() ?? undefined,
    cacheManager.getOverlayLoader() ?? undefined,
    textureLayerOf,
    mapLocs?.map((entry) => entry.location),
    mapLocs ? (locId) => locTypeInfo.get(locId) : undefined,
    false,
  );
  if (mapLocs && mapLocs.length > 0) {
    await scene.loadLocs(need(cacheManager.getLocModelLoader(), 'loc model loader'), mapLocs);
  }
  await scene.loadNpc(npcModelLoader, animationSystem);
  // `loadNpc` settles a declared type whose model fails without failing; report it rather than
  // load it again here, which would pass a scene the app could not draw.
  const declaredNpcTypeIds = [
    renderConfig?.primaryNpc?.npcTypeId,
    ...(renderConfig?.preloadNpcTypes ?? []).map((type) => type.npcTypeId),
  ].filter((id) => id !== undefined);
  const unloaded = [...new Set(declaredNpcTypeIds)].filter((id) => !compositor.isNpcTypeLoaded(id));
  if (unloaded.length > 0)
    throw new Error(`[cache-runtime] ${kind} declared NPC types not loaded: ${unloaded.join(', ')}`);
  await scene.loadSpotAnims(need(cacheManager.getSpotAnimModelLoader(), 'spotanim model loader'));
  await scene.loadPlayer(
    need(cacheManager.getPlayerModelLoader(), 'player model loader'),
    DEFAULT_PLAYER_CONFIG.appearance,
    loadout.equipment ?? DEFAULT_PLAYER_CONFIG.equipment,
  );

  const modifiers = options.modifiers ?? descriptor.defaultModifierSelection;
  random = mulberry32(options.randomSeed ?? DEFAULT_RANDOM_SEED);
  const engine = createSimulationEngineForNewRun({
    encounterConfig: {
      kind,
      mechanics: options.mechanics ?? {},
      ...(modifiers && Object.keys(modifiers).length > 0 ? { options: { modifiers } } : {}),
    },
    objTypeLoader: cacheManager.getObjTypeLoader(),
    enableIntro: options.enableIntro ?? encounterEnablesIntro(kind),
    stats: createDefaultStats(),
    inventory: loadout.inventory ?? createEmptyInventory(),
    equipment: loadout.equipment ?? {},
    combatSupplies: loadout.supplies ?? createEmptyCombatSupplies(),
    attackStylePerCategory: {},
  });
  const state = engine.getState();
  const camera = encounterDefaultCamera(kind);
  const projection = createProjection3D(VIEWPORT, {
    pitch: camera.pitch,
    yaw: camera.yaw,
    ...(camera.zoom === undefined ? {} : { fovScale: camera.zoom }),
    targetX: state.playerPosition[0] + 0.5,
    targetY: state.playerPosition[1] + 0.5,
  });
  return { kind, engine, scene, compositor, projection, events: engine.getLastTickEvents(), lastQueue: null };
}

let textureLayers = new Map<number, number>();
const textureLayerOf = (textureId: number): number => textureLayers.get(textureId) ?? -1;

function drawFrame(session: EncounterSession, interpolatedTick: number): RenderQueue {
  virtualNowMs += TICK_MS / FRAMES_PER_TICK;
  const state = session.engine.getState();
  const queue = session.scene.build(
    {
      simulationState: state,
      events: session.events,
      options: OPTIONS_3D,
      interaction: { hoveredTile: null, targetTile: null },
      interpolatedTick,
      frameDeltaMs: TICK_MS / FRAMES_PER_TICK,
      speedMultiplier: 1,
      timeline: { timelineKey: `live:${session.kind}`, paused: false },
    },
    session.projection,
    VIEWPORT,
  );
  session.lastQueue = queue;
  return queue;
}

/**
 * Plays `ticks` game ticks with several frames each, so animations and effects advance through
 * their frames rather than stopping at the first. `beforeTick` queues inputs for the next tick.
 */
function play(session: EncounterSession, ticks: number, beforeTick?: (tick: number) => void): void {
  const { engine } = session;
  for (let step = 0; step < ticks; step++) {
    const tick = engine.getState().currentTick;
    for (let frame = 0; frame < FRAMES_PER_TICK; frame++) drawFrame(session, tick + frame / FRAMES_PER_TICK);
    if (engine.getState().introActive && session.scene.isIntroAnimationComplete?.()) engine.completeIntro();
    if (!engine.canAdvance()) continue;
    beforeTick?.(tick);
    engine.advanceTick(engine.getState().playerPosition);
    session.events = engine.getLastTickEvents();
  }
  drawFrame(session, engine.getState().currentTick);
}

function meshCommandCount(queue: RenderQueue | null): number {
  return queue?.commands.filter((command) => command.kind === 'mesh3d').length ?? 0;
}

function playerOf(engine: SimulationEngine) {
  return engine['player']();
}

it('serves every archive the production runtime reads from the trimmed cache', async () => {
  // ---- Bootstrap: the real CacheManager over the trimmed artifact, as the mirror serves it. ----
  const manifest = readTrimmedManifest(TRIMMED_DIR);
  cacheId = manifest.id;
  const zip = readFileSync(path.join(TRIMMED_DIR, 'disk.zip'));
  cacheManager = new CacheManager(
    new InMemoryCacheStorage(),
    new LocalCacheTransport(manifest, zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer),
  );
  // A scenario stops at the first asset the artifact lacks; the archive report below still names it.
  let workloadError: unknown;
  try {
    await runner.run('bootstrap', 'cache bootstrap', async (scenario) => {
      await cacheManager.ensureCache();
      scenario.require(cacheManager.getState().state === 'LOADED', 'CacheManager reached LOADED');
      scenario.require(tracing.sources.length === 1, 'one traced cache store');
    });

    await runner.run('bootstrap', 'renderer textures', (scenario) => {
      const textureLoader = need(cacheManager.getTextureLoader(), 'texture loader');
      const ids = textureLoader.getTextureIds();
      // PicoGLRenderer.loadTextures decodes every cache texture into its layer array at 128px.
      textureLayers = new Map(ids.map((id, index) => [id, index + 1]));
      let decoded = 0;
      for (const id of ids) {
        if (textureLoader.getPixelsArgb(id, 128, true, 1).length > 0) decoded++;
        textureLoader.getAnimationUv(id);
      }
      sharedModelTextureIndex.setMapper(textureLayerOf);
      scenario.require(decoded === ids.length && ids.length > 0, `decoded ${decoded}/${ids.length} textures`);
    });

    await runEncounterStartups();
    await runItemActions();
    await runEquipment();
    await runGroundItems();
    await runPresetFights();
    await runSpellCasts();
    await runWeaponCatalogFights();
    await runEncounterDynamics();
  } catch (error) {
    workloadError = error;
  }

  // ---- Every recorded read, re-read from the artifact the way production decodes it. ----
  const observed = recorder.entries();
  const traced = tracing.sources[0];
  const archiveProblems = traced ? findArchiveProblems(observed, traced) : [];

  report(archiveProblems, observed.length);

  const surgeKey = `${SURGE_GRAPHIC_MODEL_ARCHIVE.indexId}:${SURGE_GRAPHIC_MODEL_ARCHIVE.archiveId}`;
  const problems: string[] = [];
  if (workloadError) {
    problems.push(
      `workload stopped: ${workloadError instanceof Error ? workloadError.message : String(workloadError)}`,
    );
  } else {
    // The workload must reach Surge's graphic model without being told about it.
    if (!recorder.has(SURGE_GRAPHIC_MODEL_ARCHIVE.indexId, SURGE_GRAPHIC_MODEL_ARCHIVE.archiveId)) {
      problems.push(`Surge potion graphic model ${surgeKey} was never read`);
    }
    const uncovered = findUncoveredEncounterKinds(ALL_ENCOUNTER_KINDS, ENCOUNTER_DYNAMIC_COVERAGE, (label) =>
      runner.ran(label),
    );
    problems.push(...uncovered.map((entry) => `uncovered encounter kind ${entry}`));
  }
  if (archiveProblems.length > 0) {
    problems.push(
      `${archiveProblems.length} archive(s) the runtime read are not served by the trimmed cache:\n${formatArchiveProblems(archiveProblems)}`,
    );
  }
  expect(problems, problems.join('\n')).toEqual([]);
});

function report(archiveProblems: readonly ArchiveProblem[], observed: number): void {
  const lines = [
    `[cache-runtime] cache ${cacheId}, trimmed artifact ${TRIMMED_DIR}`,
    `[cache-runtime] ${runner.results.length} scenarios, ${observed} archives read, ${archiveProblems.length} failing`,
    `[cache-runtime] peak rss ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MiB`,
  ];
  const byFamily = new Map<string, { scenarios: number; reads: number; ms: number }>();
  for (const result of runner.results) {
    const entry = byFamily.get(result.family) ?? { scenarios: 0, reads: 0, ms: 0 };
    entry.scenarios++;
    entry.reads += result.newArchiveReads;
    entry.ms += result.durationMs;
    byFamily.set(result.family, entry);
  }
  for (const [family, { scenarios, reads, ms }] of byFamily) {
    lines.push(`  ${family}: ${scenarios} scenarios, ${reads} new archive reads, ${(ms / 1000).toFixed(1)}s`);
  }
  const failuresByScenario = new Map<string, number>();
  for (const { read } of archiveProblems) {
    failuresByScenario.set(read.scenario, (failuresByScenario.get(read.scenario) ?? 0) + 1);
  }
  for (const [scenario, count] of failuresByScenario) lines.push(`  FAIL ${scenario}: ${count} archive(s)`);
  if (refusedSpecials.size > 0) {
    lines.push(
      `  note: ${refusedSpecials.size} registered specials the engine refuses to launch: ${[...refusedSpecials].join(', ')}`,
    );
  }
  if (undecodableGroundModels.length > 0) {
    lines.push(
      `  note: ${undecodableGroundModels.length} ground-item models were read but could not be baked: ${undecodableGroundModels.join(', ')}`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------------------------
// Family 1: encounter and lobby startup.

async function runEncounterStartups(): Promise<void> {
  for (const kind of ALL_ENCOUNTER_KINDS) {
    await runner.run('encounter startup', `startup ${kind}`, async (scenario) => {
      const session = await openEncounter(kind);
      const { scene, engine } = session;
      scenario.require(scene.isTerrainLoaded(), 'terrain mesh built');
      scenario.require(scene.isPlayerLoaded(), 'player model loaded');
      scenario.require(scene.isNpcLoaded(), 'encounter NPCs loaded');
      scenario.require(scene.isSpotAnimsLoaded(), 'encounter spotanims loaded');
      if (encounterRegistry.getDescriptorForKind(kind)?.loadsMapLocs) {
        scenario.require(scene.isLocsLoaded(), 'map locs loaded');
      }
      const introPlays = engine.getState().introActive;
      play(session, introPlays ? 40 : 12);
      if (introPlays) scenario.require(!engine.getState().introActive, 'intro animation played to completion');
      if (kind === 'lobby') {
        for (const boss of LOBBY_BOSS_NPCS) {
          scenario.require(session.compositor.isNpcTypeLoaded(boss.npcTypeId), `lobby boss ${boss.npcTypeId} loaded`);
        }
      } else {
        scenario.require(engine.getState().npcs.length > 0, `${engine.getState().npcs.length} NPCs simulated`);
      }
      scenario.require(
        meshCommandCount(session.lastQueue) > 0,
        `3D frame with ${meshCommandCount(session.lastQueue)} meshes`,
      );
      scene.dispose?.();
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Family 4: item actions.

async function runItemActions(): Promise<void> {
  const session = await openEncounter('lobby');
  play(session, 2);
  const options: ItemActionOption[] = ['default', 'guzzle'];
  for (const itemId of Object.keys(ITEM_ACTIONS).map(Number)) {
    for (const option of options) {
      const def = getItemAction(itemId, option);
      if (!def) continue;
      // An item with nothing to apply (an empty vial's "Drink") has no runtime assets to cover.
      if (def.effects.length === 0 && def.playerGraphic === undefined) continue;
      const label = option === 'default' ? `item action ${itemId}` : `item action ${itemId} ${option}`;
      await runner.run('item actions', label, (scenario) => exerciseItemAction(session, itemId, option, scenario));
    }
  }
  session.scene.dispose?.();
}

function exerciseItemAction(
  session: EncounterSession,
  itemId: number,
  option: ItemActionOption,
  scenario: ScenarioContext,
): void {
  const { engine } = session;
  const def = need(getItemAction(itemId, option), `item action ${itemId}`);
  const player = playerOf(engine);
  // A state every action accepts: hurt but above any minimum, spec energy to restore, no surge cooldown.
  player.vitals.hp = Math.max(def.minHpToUse ?? 0, Math.floor(player.vitals.maxHp / 2), 20);
  player.specialAttack = { ...player.specialAttack, energy: 40 };
  player.combatTimers = { ...player.combatTimers, surgePotionCooldownTicks: 0 };
  const inventory = createEmptyInventory();
  inventory[0] = { id: itemId, quantity: 1 };
  engine.setInventory(inventory);

  let applied: GameEvent[] = [];
  play(session, 1, () => engine.queueItemAction(0, option));
  applied = session.events;
  // Leave the effect long enough to play out across its frames.
  play(session, 6);

  const after = engine.getState().inventory[0];
  const consumed = def.consume.type === 'none' || after?.id !== itemId || after.quantity !== inventory[0]?.quantity;
  scenario.require(consumed, `inventory consumed per ${def.consume.type}`);
  const observable = applied.some(
    (event) =>
      isCoreEvent(event, 'item_consumed') ||
      isCoreEvent(event, 'player_graphic_applied') ||
      isCoreEvent(event, 'hitsplat_spawned'),
  );
  scenario.require(observable || def.consume.type !== 'none', 'engine applied the action');
  if (def.playerGraphic !== undefined) {
    scenario.require(
      applied.some((event) => isCoreEvent(event, 'player_graphic_applied') && event.spotAnimId === def.playerGraphic),
      `player_graphic_applied ${def.playerGraphic}`,
    );
    const parts = loadedSpotAnimParts(session.compositor, def.playerGraphic);
    scenario.require(parts !== undefined && parts > 0, `spotanim ${def.playerGraphic} rendered (${parts} parts)`);
  }
}

// ---------------------------------------------------------------------------------------------
// Family 2: equipment, presets and player poses.

/** Plays a runtime-selected sequence through the animation system frame by frame, once per seq. */
function playSequence(model: ModelData, sequence: AnimationSequence | null | undefined, played: Set<number>): number {
  if (!sequence || played.has(sequence.id)) return 0;
  played.add(sequence.id);
  const animationSystem = need(cacheManager.getAnimationSystem(), 'animation system');
  const animated = animationSystem.createAnimatedModel(model);
  animationSystem.startAnimation(animated, sequence);
  // A fractional first step applies frame 0; each later step advances exactly one frame.
  animationSystem.updateAnimation(animated, 0.5);
  for (let frame = 0; frame < sequence.frameIds.length; frame++) {
    animationSystem.updateAnimation(animated, Math.max(1, sequence.frameLengths[frame] ?? 1));
  }
  return 1;
}

const POSE_KEYS: readonly (keyof PlayerPoseSet)[] = [
  'idle',
  'walk',
  'run',
  'turnLeft',
  'turnRight',
  'walkBack',
  'idleTurnLeft',
  'idleTurnRight',
];

/** Loads `equipment` onto the scene's player and plays every pose the runtime selected for it. */
async function wearAndPose(
  session: EncounterSession,
  equipment: PlayerEquipment,
  played: Set<number>,
): Promise<{ loaded: boolean; posesPlayed: number }> {
  const { compositor } = session;
  await session.scene.loadPlayer(
    need(cacheManager.getPlayerModelLoader(), 'player model loader'),
    DEFAULT_PLAYER_CONFIG.appearance,
    equipment,
  );
  const controller = compositor['playerAnimController'];
  if (!session.scene.isPlayerLoaded() || !controller) return { loaded: false, posesPlayed: 0 };
  const model: ModelData = controller['playerModelData'].mergedModel;
  const set: PlayerAnimationSet = controller['animationSet'];
  let posesPlayed = 0;
  for (const poses of [set, set.unarmed]) {
    if (!poses) continue;
    for (const key of POSE_KEYS) posesPlayed += playSequence(model, poses[key], played);
  }
  for (const sequence of [set.attack, set.block, set.eat]) posesPlayed += playSequence(model, sequence, played);
  return { loaded: true, posesPlayed };
}

async function runEquipment(): Promise<void> {
  const session = await openEncounter('lobby');
  const playerModelLoader = need(cacheManager.getPlayerModelLoader(), 'player model loader');
  const played = new Set<number>();

  for (const slot of CUSTOMIZABLE_GEAR_SLOTS) {
    const ids = [
      ...new Set([
        ...getGearCatalog(slot).map((item) => item.id),
        ...Object.values(EQUIPMENT_PRESETS).flatMap((presets) =>
          Object.values(presets).flatMap((preset) => preset.equipment[slot] ?? []),
        ),
      ]),
    ];
    // Weapons and shields choose the player's animation set, so they go through the scene's
    // player load and pose playback; every other slot changes only the worn models.
    const posed = slot === 'weapon' || slot === 'shield';
    await runner.run('equipment', `equip every ${slot}`, async (scenario) => {
      let models = 0;
      let poses = 0;
      for (const id of ids) {
        for (const gender of [0, 1] as const) {
          const model = playerModelLoader.loadPlayerModel(
            { ...DEFAULT_PLAYER_CONFIG.appearance, gender },
            { [slot]: id },
          );
          if (model && model.mergedModel.faceCount > 0) models++;
        }
        if (posed) {
          const result = await wearAndPose(session, { [slot]: id }, played);
          scenario.require(result.loaded, `${slot} ${id} worn by the scene player`);
          poses += result.posesPlayed;
        }
      }
      scenario.require(models === ids.length * 2, `${models}/${ids.length * 2} ${slot} player models (both genders)`);
      if (posed) scenario.confirm(`${poses} new poses played`);
    });
  }
  session.scene.dispose?.();
}

// ---------------------------------------------------------------------------------------------
// Family 3: ground items.

/**
 * Ground models read but not baked. A trimmed-out model also fails the archive check; one served
 * intact is a model-decoder defect, reported here rather than failed.
 */
const undecodableGroundModels: string[] = [];

async function runGroundItems(): Promise<void> {
  const session = await openEncounter('lobby');
  const objTypeLoader = need(cacheManager.getObjTypeLoader(), 'obj type loader');
  const ids = collectItemIconIds();
  const [baseX, baseY] = session.engine.getState().playerPosition;
  const BATCH = 400;
  for (let start = 0; start < ids.length; start += BATCH) {
    const batch = ids.slice(start, start + BATCH);
    await runner.run('ground items', `ground items ${start}-${start + batch.length - 1}`, (scenario) => {
      session.engine.setGroundItems(
        batch.map((itemId, index) => ({
          id: `gi-${start + index + 1}`,
          itemId,
          quantity: 1,
          position: [baseX - 10 + (index % 20), baseY - 10 + Math.floor(index / 20)],
          droppedTick: 0,
        })),
      );
      play(session, 1);
      const drawn = new Set(session.compositor.getAllGroundItemHitTestData().map((entry) => entry.groundItemId));
      const undrawn = batch.filter((_, index) => !drawn.has(`gi-${start + index + 1}`));
      // An undrawn item must have had no ground model, or its model must have been read (and so
      // checked by the archive check) and failed to bake.
      const unattempted: number[] = [];
      for (const itemId of undrawn) {
        let modelId = -1;
        try {
          modelId = objTypeLoader.load(itemId).inventoryModel;
        } catch {
          continue;
        }
        if (modelId < 0) continue;
        if (recorder.has(7, modelId)) undecodableGroundModels.push(`${itemId} (model ${modelId})`);
        else unattempted.push(itemId);
      }
      scenario.require(
        unattempted.length === 0,
        `${drawn.size}/${batch.length} drawn; never attempted: ${unattempted.join(', ') || 'none'}`,
      );
    });
  }
  session.engine.setGroundItems([]);
  session.scene.dispose?.();
}

// ---------------------------------------------------------------------------------------------
// Family 5: weapons, specials and spells, selected and launched by the engine.

/** Fight mechanics: the boss cannot end the run, so every attack the player starts plays out. */
const FIGHT_MECHANICS: Partial<MechanicsConfig> = {
  infiniteHealth: true,
  infiniteSpecialAttack: true,
  yamaMageRange: false,
  yamaMelee: false,
  waves: false,
  fireballs: false,
  voidFlares: false,
};

/** Registered specials the engine arms but never launches (no attack plan); they read nothing. */
const refusedSpecials = new Set<number>();

function bossOf(engine: SimulationEngine) {
  const npcs = engine['worldState'].getNpcs();
  return need(npcs.find((npc) => npc.role === 'boss') ?? npcs.find((npc) => npc.alive), 'attackable boss');
}

type PlayerAttack = Extract<GameEvent, { type: 'attack_started' }>;

interface Fight {
  readonly special?: boolean;
  readonly styleIndex?: number;
  /** Keeps attacking until an attack this accepts starts (a spell that hits, say). */
  readonly accept?: (attack: PlayerAttack) => boolean;
  /** Ticks to wait for that attack; default 48. */
  readonly ticks?: number;
}

/**
 * Attacks the encounter's boss with whatever the engine currently has equipped until the player
 * starts an attack with that weapon, then lets its animation, projectile and impact play out.
 * Requires the attack to have happened and every effect the renderer derived from it to load.
 */
async function fightBoss(
  session: EncounterSession,
  fight: Fight,
  scenario: ScenarioContext,
  what: string,
): Promise<void> {
  const { engine } = session;
  const player = playerOf(engine);
  const weaponId = player.equipment.weapon;
  if (fight.styleIndex !== undefined) engine.setSelectedAttackStyleIndex(fight.styleIndex);
  carryRunesForActiveSpell(engine);
  await session.scene.loadPlayer(
    need(cacheManager.getPlayerModelLoader(), 'player model loader'),
    DEFAULT_PLAYER_CONFIG.appearance,
    engine.getState().playerEquipment,
  );
  const boss = bossOf(engine);
  engine.setBossHp(boss.vitals.maxHp);
  engine.setAttackTarget(boss.id);

  let attack: PlayerAttack | undefined;
  let effects: readonly PlayerEffectDescriptor[] = [];
  const seen: string[] = [];
  // Specials are switched on once the player is attacking, as a player does: some weapons' special
  // switches itself off again while the player is still walking up.
  let specialQueued = false;
  let specialArmed = false;
  let specialRefused = false;
  const instantBefore = player.powerOfDeathUntilTick;
  for (let tick = 0; tick < (fight.ticks ?? 48) && !attack && !specialRefused; tick++) {
    const toggle = fight.special === true && !specialQueued && seen.length > 0 && !player.isSpecialAttackActive;
    if (toggle) specialQueued = true;
    play(session, 1, () => {
      if (toggle) engine.queueSpecialAttackToggle();
    });
    for (const event of session.events) {
      if (isCoreEvent(event, 'attack_started') && event.sourceId === 'player') {
        seen.push(`${event.weaponId}${event.usingSpecialAttack ? '(spec)' : ''}`);
      }
    }
    attack = session.events.find(
      (event): event is PlayerAttack =>
        isCoreEvent(event, 'attack_started') &&
        event.sourceId === 'player' &&
        event.weaponId === weaponId &&
        (fight.special !== true || event.usingSpecialAttack === true) &&
        (fight.accept?.(event) ?? true),
    );
    if (attack) effects = describePlayerEffects({ state: engine.getState(), events: session.events });
    // The engine switches a special it cannot plan back off without launching it.
    if (player.isSpecialAttackActive) specialArmed = true;
    else if (specialArmed && !attack) specialRefused = true;
  }
  if (fight.special && !attack && weaponId !== undefined) {
    if (getSpecialAttackDef(weaponId)?.instantEffect !== undefined) {
      scenario.require(player.powerOfDeathUntilTick !== instantBefore, `${what}: instant special applied`);
      return;
    }
    if (specialRefused) {
      refusedSpecials.add(weaponId);
      scenario.confirm(`${what}: special armed, then refused by the engine without launching`);
      return;
    }
  }
  scenario.require(
    attack,
    `${what}: player ${fight.special ? 'special ' : ''}attack started (saw ${seen.join(', ') || 'no player attacks'}; ` +
      `player at ${engine.getState().playerPosition}, boss ${boss.id} at ${boss.position})`,
  );
  play(session, 8);
  if (player.isSpecialAttackActive) engine.queueSpecialAttackToggle();
  engine.setAttackTarget(null);
  play(session, 1);

  for (const effect of effects) {
    const ids =
      effect.kind === 'projectile' ? [effect.visuals.projectileId, effect.visuals.hitSpotanim] : [effect.spotAnimId];
    for (const id of ids.filter((spotAnimId) => spotAnimId >= 0)) {
      const parts = loadedSpotAnimParts(session.compositor, id);
      scenario.require(parts !== undefined, `${what}: ${effect.kind} spotanim ${id} loaded (${parts} parts)`);
    }
  }
}

/** Carries one of each rune the selected or built-in autocast needs, so a casting style can cast. */
function carryRunesForActiveSpell(engine: SimulationEngine): void {
  const player = playerOf(engine);
  const spell = resolveActiveSpell({
    weaponId: player.equipment.weapon,
    selectedStyleIndex: engine.getState().selectedAttackStyleIndex,
    selectedSpell: player.combatSupplies.selectedSpell,
    spellbook: player.combatSupplies.spellbook,
  });
  const runes = spell ? (getSpellRuneRequirement(spell.name) ?? []) : [];
  const inventory = [...player.inventory];
  for (const runeId of runes) {
    if (hasRune(runeId, { equipment: player.equipment, inventory, runePouch: player.combatSupplies.runePouch }))
      continue;
    const free = inventory.indexOf(null);
    if (free >= 0) inventory[free] = { id: runeId, quantity: 1000 };
  }
  engine.setInventory(inventory);
}

function isWeapon(itemId: number): boolean {
  return findEquipmentCatalogItem(itemId)?.slot === 'weapon';
}

/** Empties the last inventory slot holding a consumable (a potion or food), leaving gear and runes. */
function freeConsumableSlot(engine: SimulationEngine): void {
  const inventory = [...engine.getState().inventory];
  let index = inventory.length - 1;
  for (; index >= 0; index--) {
    const slot = inventory[index];
    if (slot && getItemAction(slot.id) !== undefined && !findEquipmentCatalogItem(slot.id)) break;
  }
  if (index < 0) throw new Error('[cache-runtime] no consumable to drop for a two-handed switch');
  inventory[index] = null;
  engine.setInventory(inventory);
}

/**
 * Every shipped preset's weapons, equipped and switched to through the engine's own inventory
 * equip, fought against Yama: an open arena with nothing blocking line of sight, so each attack
 * the loadout can make actually launches.
 */
async function runPresetFights(): Promise<void> {
  const session = await openEncounter('yama_p3', {}, { enableIntro: false, mechanics: FIGHT_MECHANICS });
  const { engine } = session;
  for (const [kind, presets] of Object.entries(EQUIPMENT_PRESETS)) {
    // A retired kind (the `zuk` alias) maps to its owning encounter's presets, fought under that kind.
    if (isRetiredEncounterKind(kind)) continue;
    if (!ALL_ENCOUNTER_KINDS.includes(kind)) throw new Error(`[cache-runtime] presets for unknown encounter ${kind}`);
    for (const [presetId, preset] of Object.entries(presets)) {
      if (preset.equipment.weapon === undefined) continue;
      await runner.run('weapons and spells', `preset ${kind}/${presetId} fight`, async (scenario) => {
        engine.setEquipment(preset.equipment);
        engine.setInventory(preset.inventory.map((slot) => (slot ? { ...slot } : null)));
        engine.setCombatSupplies(preset.supplies ?? createEmptyCombatSupplies());
        const weapons = [preset.equipment.weapon, ...preset.inventory.map((slot) => slot?.id)].filter(
          (id): id is number => id !== undefined && isWeapon(id),
        );
        for (const weaponId of weapons) {
          if (engine.getState().playerEquipment.weapon !== weaponId) {
            const index = engine.getState().inventory.findIndex((slot) => slot?.id === weaponId);
            // A two-handed switch must return the worn off-hand too, which a full inventory refuses
            // (as in OSRS), so drop one consumable to make room. Its item actions run elsewhere.
            if (!engine.previewInventoryAfterEquipFromInventory(index, 'weapon')) freeConsumableSlot(engine);
            play(session, 1, () => engine.queueEquipFromInventory(index, weaponId, 'weapon'));
            scenario.require(engine.getState().playerEquipment.weapon === weaponId, `switched to weapon ${weaponId}`);
          }
          // A paired ammo swap (atlatl and its darts) equips the carried ammo with the weapon.
          const equippedAmmo = engine.getCombatSupplies().equippedAmmo?.id;
          if (weaponRequiresExternalAmmo(weaponId) && !(equippedAmmo && isAmmoCompatible(weaponId, equippedAmmo))) {
            const inventory = engine.getState().inventory;
            const index = inventory.findIndex((slot) => slot !== null && isAmmoCompatible(weaponId, slot.id));
            const ammoId = inventory[index]?.id;
            if (ammoId !== undefined) play(session, 1, () => engine.queueEquipAmmoFromInventory(index, ammoId));
          }
          await fightBoss(session, {}, scenario, `weapon ${weaponId}`);
          if (getSpecialAttackDef(weaponId))
            await fightBoss(session, { special: true }, scenario, `weapon ${weaponId}`);
        }
      });
    }
  }
  session.scene.dispose?.();
}

/** A staff with a casting style, so any selected spell autocasts. */
const SPELL_CASTING_STAFF = 4675; // Ancient staff

/** Arms the casting staff with `spell` and the runes it needs. */
function readySpell(engine: SimulationEngine, spellbook: SpellbookType, spellName: string): number {
  const inventory = createEmptyInventory();
  need(getSpellRuneRequirement(spellName), `runes for ${spellName}`).forEach((runeId, index) => {
    inventory[index] = { id: runeId, quantity: 1000 };
  });
  engine.setEquipment({ weapon: SPELL_CASTING_STAFF });
  engine.setInventory(inventory);
  engine.setCombatSupplies({ ...createEmptyCombatSupplies(), spellbook, selectedSpell: spellName });
  const casting = getWeaponCategory(SPELL_CASTING_STAFF).styles.findIndex((style) => style.combatStyle === 'Casting');
  if (casting < 0) throw new Error(`[cache-runtime] weapon ${SPELL_CASTING_STAFF} has no casting style`);
  return casting;
}

/** Yama resists magic, so a weak spell can take many casts to land one hit. */
const SPELL_HIT_TICKS = 150;

/**
 * Every autocastable spell until one cast hits, so its impact graphic loads, then one shared case
 * that must splash (a Magic level 1 Wind Strike) and the Death Charge self-cast.
 */
async function runSpellCasts(): Promise<void> {
  const session = await openEncounter('yama_p3', {}, { enableIntro: false, mechanics: FIGHT_MECHANICS });
  const { engine } = session;
  for (const spellbook of ALL_SPELLBOOKS) {
    for (const spell of getAutocastableSpells(spellbook)) {
      await runner.run('weapons and spells', `cast ${spell.name}`, async (scenario) => {
        const styleIndex = readySpell(engine, spellbook, spell.name);
        const accept = (attack: PlayerAttack) => attack.spellId === spell.name && attack.spellCast?.accurate === true;
        await fightBoss(session, { styleIndex, accept, ticks: SPELL_HIT_TICKS }, scenario, `${spell.name} hit`);
      });
    }
  }
  await runner.run('weapons and spells', 'spell splash', async (scenario) => {
    const stats = createDefaultStats();
    engine.setPlayerStats({ ...stats, magic: { current: 1, max: 1 } });
    const styleIndex = readySpell(engine, 'standard', 'Wind Strike');
    const accept = (attack: PlayerAttack) => attack.spellId === 'Wind Strike' && attack.spellCast?.accurate === false;
    await fightBoss(session, { styleIndex, accept }, scenario, 'Wind Strike splash');
    scenario.require(loadedSpotAnimParts(session.compositor, SPLASH_SPOTANIM) !== undefined, 'splash graphic loaded');
    engine.setPlayerStats(stats);
  });
  // Self-casts are not autocasts: the engine's own action casts them and picks the graphic.
  await runner.run('weapons and spells', 'self-cast Death Charge', async (scenario) => {
    const inventory = createEmptyInventory();
    need(getSpellRuneRequirement(DEATH_CHARGE_SPELL), 'Death Charge runes').forEach((runeId, index) => {
      inventory[index] = { id: runeId, quantity: 1000 };
    });
    engine.setAttackTarget(null);
    engine.setInventory(inventory);
    engine.setCombatSupplies({ ...createEmptyCombatSupplies(), spellbook: 'arceuus' });
    play(session, 1, () => engine.applyAction({ type: 'castDeathCharge' }));
    const cast = session.events.find((event) => event.type === 'spell_self_cast');
    const spotAnimId = (cast as { spotAnimId?: number } | undefined)?.spotAnimId;
    scenario.require(spotAnimId !== undefined, `spell_self_cast emitted (graphic ${spotAnimId})`);
    play(session, 6);
    const parts = spotAnimId === undefined ? undefined : loadedSpotAnimParts(session.compositor, spotAnimId);
    scenario.require(parts !== undefined && parts > 0, `Death Charge graphic ${spotAnimId} rendered (${parts} parts)`);
  });
  session.scene.dispose?.();
}

/** `failedspell_impact`, the graphic every splashed magic attack shows on its target. */
const SPLASH_SPOTANIM = 85;

const ATTACK_KINDS = Object.keys({
  melee_slash: true,
  melee_stab: true,
  melee_crush: true,
  range_arrow: true,
  range_shadow: true,
  magic_fire: true,
  magic_shadow: true,
  magic_air: true,
  magic_water: true,
  typeless: true,
} satisfies Record<AttackKind, true>) as AttackKind[];

const CARDINALS = ['south', 'north', 'east', 'west'] as const;

/**
 * Everything the renderer selects for a weapon's attacks, from the runtime's own selectors: attack
 * sequences per attack kind, normal and special visuals (per compatible ammo), the special's
 * definition, melee sweeps and autocasts. Weapons that share it read the same archives in a fight
 * (their worn models are covered by the equipment family), so one representative fights for all.
 */
function weaponAttackSignature(weaponId: number, ammoIds: readonly number[]): string {
  const special = getSpecialAttackDef(weaponId);
  const ammoVisuals = new Set<string>();
  if (weaponRequiresExternalAmmo(weaponId)) {
    for (const ammoId of ammoIds) {
      if (isAmmoCompatible(weaponId, ammoId)) ammoVisuals.add(JSON.stringify(ammoVisualKey(weaponId, ammoId)));
    }
  }
  const styles = getWeaponCategory(weaponId).styles;
  return JSON.stringify({
    sequences: ATTACK_KINDS.map((attackKind) => [
      playerAttackSequenceIds({ kind: 'weapon', weaponId, attackKind }),
      special?.animationId === undefined
        ? null
        : playerAttackSequenceIds({ kind: 'weapon', weaponId, attackKind, specAnimationId: special.animationId }),
    ]),
    visuals: [getWeaponCombatVisuals(weaponId), getWeaponCombatVisuals(weaponId, undefined, true)],
    ammoVisuals: [...ammoVisuals].sort(),
    special,
    sweeps: CARDINALS.map((direction) => getMeleeSweep(weaponId, direction)),
    autocasts: styles.map((_, index) => ALL_SPELLBOOKS.map((book) => getAutocastSpell(weaponId, index, book)?.name)),
    styles: styles.map((style) => `${style.combatStyle}/${style.attackType}`),
  });
}

function ammoVisualKey(weaponId: number, ammoId: number) {
  return [getWeaponCombatVisuals(weaponId, ammoId), getWeaponCombatVisuals(weaponId, ammoId, true)];
}

/** Catalog weapons, one representative per attack signature, in every style plus special and ammo. */
async function runWeaponCatalogFights(): Promise<void> {
  const ammoIds = getAmmoCatalog().map((item) => item.id);
  const representatives = new Map<string, number>();
  for (const weaponId of getGearCatalog('weapon').map((item) => item.id)) {
    const signature = weaponAttackSignature(weaponId, ammoIds);
    if (!representatives.has(signature)) representatives.set(signature, weaponId);
  }

  const session = await openEncounter('yama_p3', {}, { enableIntro: false, mechanics: FIGHT_MECHANICS });
  const { engine } = session;
  for (const weaponId of representatives.values()) {
    await runner.run('weapons and spells', `weapon ${weaponId} attacks`, async (scenario) => {
      // One compatible ammo per distinct ammo appearance; none for weapons that carry their own.
      const ammoChoices = new Map<string, number>();
      if (weaponRequiresExternalAmmo(weaponId)) {
        for (const ammoId of ammoIds) {
          if (!isAmmoCompatible(weaponId, ammoId)) continue;
          const key = JSON.stringify(ammoVisualKey(weaponId, ammoId));
          if (!ammoChoices.has(key)) ammoChoices.set(key, ammoId);
        }
      }
      const ammo = [...ammoChoices.values()];
      const supplies = (ammoId: number | undefined): CombatSupplies => ({
        ...createEmptyCombatSupplies(),
        equippedAmmo: ammoId === undefined ? null : { id: ammoId },
        blowpipe: BLOWPIPE_DART,
      });
      engine.setInventory(createEmptyInventory());
      engine.setEquipment({ weapon: weaponId });
      engine.setCombatSupplies(supplies(ammo[0]));
      const styles = getWeaponCategory(weaponId).styles;
      for (let styleIndex = 0; styleIndex < styles.length; styleIndex++) {
        await fightBoss(
          session,
          { styleIndex },
          scenario,
          `weapon ${weaponId} style ${styles[styleIndex].combatStyle}`,
        );
      }
      if (getSpecialAttackDef(weaponId)) await fightBoss(session, { special: true }, scenario, `weapon ${weaponId}`);
      for (const ammoId of ammo.slice(1)) {
        engine.setCombatSupplies(supplies(ammoId));
        await fightBoss(session, {}, scenario, `weapon ${weaponId} with ammo ${ammoId}`);
        if (getSpecialAttackDef(weaponId)) {
          await fightBoss(session, { special: true }, scenario, `weapon ${weaponId} with ammo ${ammoId}`);
        }
      }
    });
  }
  session.scene.dispose?.();
}

/** Dragon dart: loads the blowpipe for any representative that is one. */
const BLOWPIPE_DART = { id: 11230 } as const;

// ---------------------------------------------------------------------------------------------
// Family 6: encounter-specific dynamic assets, driven by each encounter's own runtime controls.

/** The encounter's own mechanics, with only the player kept alive so the fight runs its course. */
function fightMechanicsFor(kind: string): Partial<MechanicsConfig> {
  return {
    ...encounterControlsForKind(kind)?.defaultMechanicsConfig,
    infiniteHealth: true,
    infiniteSpecialAttack: true,
  };
}

/** NPC attacks started, or hits landed on the player (Sol's attacks arrive through its own visual events). */
function npcAttacksIn(events: readonly GameEvent[]): number {
  return events.filter(
    (event) =>
      (isCoreEvent(event, 'attack_started') && event.sourceId !== 'player') ||
      (isCoreEvent(event, 'hitsplat_spawned') && event.targetId === 'player'),
  ).length;
}

function livingBoss(engine: SimulationEngine) {
  return engine['worldState'].getNpcs().find((npc) => npc.role === 'boss' && npc.alive);
}

/** Plays `ticks` ticks attacking the boss, returning how many NPC attacks started. */
function fightFor(session: EncounterSession, ticks: number): number {
  const { engine } = session;
  let npcAttacks = 0;
  for (let tick = 0; tick < ticks; tick++) {
    const boss = livingBoss(engine);
    if (boss && engine.getAttackTarget() !== boss.id) engine.setAttackTarget(boss.id);
    play(session, 1);
    npcAttacks += npcAttacksIn(session.events);
  }
  return npcAttacks;
}

/**
 * Plays until `outcome` holds (at most `ticks` ticks), then lets what appeared play out. Returns
 * whether it was seen.
 */
function playUntil(
  session: EncounterSession,
  ticks: number,
  outcome: () => boolean,
  beforeFirstTick?: () => void,
): boolean {
  let seen = false;
  for (let tick = 0; tick < ticks && !seen; tick++) {
    play(session, 1, tick === 0 ? beforeFirstTick : undefined);
    seen = outcome();
  }
  if (seen) play(session, 10);
  return seen;
}

const npcCount = (session: EncounterSession, match: (npc: { id: string; archetypeId: string }) => boolean) =>
  session.engine.getState().npcs.filter(match).length;
const hasEvent = (session: EncounterSession, type: string) => session.events.some((event) => event.type === type);
const colosseumCue = (session: EncounterSession, match: (clipIds: string[], spotAnimIds: number[]) => boolean) =>
  session.events.some(
    (event) =>
      isEncounterVisualEvent(event) &&
      match(
        event.animations.map((cue) => cue.clipId),
        event.graphics.map((cue) => cue.spotAnimId),
      ),
  );

interface CommandCase {
  readonly command: EncounterCommand;
  /** What the command must visibly produce. */
  readonly outcome: string;
  readonly produced: (session: EncounterSession, countBefore: (archetype: string) => number) => boolean;
}

const archetypeAdded =
  (archetype: string): CommandCase['produced'] =>
  (session, before) =>
    npcCount(session, (npc) => npc.archetypeId === archetype) > before(archetype);

/**
 * The asset-producing practice commands, each run on a live boss and required to produce its
 * spawn or visual. Reset and clear commands produce nothing new and are left out.
 */
const ENCOUNTER_COMMANDS: Readonly<Record<string, readonly CommandCase[]>> = {
  yama_p3: [
    {
      command: { encounter: 'yama_p3', type: 'spawn-fireball' },
      outcome: 'fireball spawned',
      produced: (session) => hasEvent(session, 'fireball_spawned'),
    },
    {
      command: { encounter: 'yama_p3', type: 'spawn-void-flare' },
      outcome: 'void flare spawned',
      produced: archetypeAdded('voidflare'),
    },
  ],
  inferno: [
    {
      command: { encounter: 'zuk', type: 'spawn-set' },
      outcome: 'mager spawned',
      produced: archetypeAdded('zuk_mager'),
    },
    { command: { encounter: 'zuk', type: 'spawn-jad' }, outcome: 'Jad spawned', produced: archetypeAdded('zuk_jad') },
    {
      command: { encounter: 'zuk', type: 'spawn-healers' },
      outcome: 'healers spawned',
      produced: archetypeAdded('zuk_healer'),
    },
  ],
  sol_heredit: [
    {
      command: { encounter: 'sol_heredit', type: 'trigger-grapple' },
      outcome: 'grapple clip',
      produced: (session) => colosseumCue(session, (clips) => clips.includes('grapple')),
    },
    {
      command: { encounter: 'sol_heredit', type: 'trigger-triple' },
      outcome: 'triple attack clip',
      produced: (session) => colosseumCue(session, (clips) => clips.some((clip) => clip.startsWith('triple'))),
    },
    {
      command: { encounter: 'sol_heredit', type: 'spawn-crystal' },
      outcome: 'beam crystal spawned',
      produced: archetypeAdded('colosseum_beam_crystal'),
    },
    {
      command: { encounter: 'sol_heredit', type: 'strike-sand' },
      outcome: 'molten sand struck',
      produced: (session) =>
        colosseumCue(session, (_, graphics) => graphics.includes(COLOSSEUM_SPOTANIMS.sunfireLightning)),
    },
  ],
};

/** Natural mechanics switched off while commands run, so each outcome is the command's own. */
const QUIET_FOR_COMMANDS: Readonly<Record<string, Partial<MechanicsConfig>>> = {
  yama_p3: { fireballs: false, voidFlares: false },
};

/** The retired kind whose entry an encounter's dynamics start from: the Inferno's boss is on Zuk's wave. */
const DYNAMICS_ENTRY_KIND: Readonly<Record<string, string>> = { inferno: 'zuk' };

async function openArmed(kind: string, options: EncounterOptions = {}): Promise<EncounterSession> {
  const preset = Object.values(EQUIPMENT_PRESETS[kind] ?? {}).find((entry) => entry.equipment.weapon !== undefined);
  return openEncounter(
    kind,
    preset ? { equipment: preset.equipment, inventory: preset.inventory, supplies: preset.supplies } : {},
    { enableIntro: false, mechanics: fightMechanicsFor(kind), ...options },
  );
}

/** Each encounter's ordinary fight, its asset-producing commands, and the boss's death. */
async function runEncounterDynamics(): Promise<void> {
  for (const kind of ALL_ENCOUNTER_KINDS) {
    if (!ENCOUNTER_DYNAMIC_COVERAGE[kind]?.includes(`${kind} fight`)) continue;
    const entry = need(resolveEncounterEntry(DYNAMICS_ENTRY_KIND[kind] ?? kind), `entry for ${kind}`);
    if (entry.kind !== kind) throw new Error(`[cache-runtime] ${kind} dynamics enter ${entry.kind}`);
    const session = await openArmed(kind, { mechanics: { ...fightMechanicsFor(kind), ...entry.mechanics } });
    const { engine } = session;

    await runner.run('encounter dynamics', `${kind} fight`, (scenario) => {
      const npcAttacks = fightFor(session, 120);
      scenario.require(npcAttacks > 0, `${npcAttacks} NPC attacks or hits on the player over 120 ticks`);
    });

    const commands = ENCOUNTER_COMMANDS[kind];
    if (commands) {
      await runner.run('encounter dynamics', `${kind} commands`, (scenario) => {
        engine.setMechanicsConfig({ ...engine.getMechanicsConfig(), ...QUIET_FOR_COMMANDS[kind] });
        for (const { command, outcome, produced } of commands) {
          scenario.require(livingBoss(engine), `${command.type} on a live boss`);
          const counts = new Map<string, number>();
          for (const npc of engine.getState().npcs) counts.set(npc.archetypeId, (counts.get(npc.archetypeId) ?? 0) + 1);
          const before = (archetype: string) => counts.get(archetype) ?? 0;
          const seen = playUntil(
            session,
            20,
            () => produced(session, before),
            () => engine.queueEncounterCommand(command),
          );
          scenario.require(seen, `${command.type}: ${outcome}`);
        }
      });
    }

    await runner.run('encounter dynamics', `${kind} boss death`, (scenario) => {
      const boss = bossOf(engine);
      engine.setBossHp(0);
      play(session, 20);
      scenario.require(!boss.alive, `${boss.id} died and its death played for 20 ticks`);
    });
    session.scene.dispose?.();
  }
  await runSolModifiers();
}

/** Encounter seeds that give each Quartet warbander role; the scenario fails if one stops matching. */
const QUARTET_ROLE_SEEDS = { berserker: 2, archer: 4, seer: 1 } as const;

/**
 * The Sol modifiers that bring assets of their own; the rest only change numbers. Each opens a
 * run with that modifier at its highest tier and requires its NPCs or graphics to appear.
 */
async function runSolModifiers(): Promise<void> {
  const tierOf = (id: string): EncounterModifierTier => {
    const modifier = encounterRegistry.getDescriptorForKind('sol_heredit')?.modifiers?.find((entry) => entry.id === id);
    return need(modifier, `Sol modifier ${id}`).tiers.length as EncounterModifierTier;
  };
  const withModifier = async (
    label: string,
    id: string,
    outcome: string,
    observe: (session: EncounterSession) => boolean,
    options: { randomSeed?: number; trigger?: (session: EncounterSession) => void } = {},
  ) =>
    runner.run('encounter dynamics', label, async (scenario) => {
      const session = await openArmed('sol_heredit', {
        modifiers: { [id]: tierOf(id) },
        ...(options.randomSeed === undefined ? {} : { randomSeed: options.randomSeed }),
      });
      options.trigger?.(session);
      scenario.require(
        playUntil(session, 30, () => observe(session)),
        outcome,
      );
      session.scene.dispose?.();
    });

  const idStarts = (prefix: string) => (session: EncounterSession) =>
    npcCount(session, (npc) => npc.id.startsWith(prefix)) > 0;
  await withModifier('sol modifier bees', 'bees', 'bee swarms spawned', idStarts('sol_bees'));
  await withModifier('sol modifier solarflare', 'solarflare', 'solar flares spawned', idStarts('sol_solarflare'));
  await withModifier('sol modifier totemic', 'totemic', 'healing totem spawned at half HP', idStarts('sol_totem'), {
    trigger: (session) => session.engine.setBossHp(Math.floor(bossOf(session.engine).vitals.maxHp / 2)),
  });
  await withModifier(
    'sol modifier volatility',
    'volatility',
    'death explosion',
    (session) => colosseumCue(session, (_, graphics) => graphics.includes(COLOSSEUM_SPOTANIMS.finalBossExplosion)),
    { trigger: (session) => session.engine.setBossHp(0) },
  );
  for (const [role, randomSeed] of Object.entries(QUARTET_ROLE_SEEDS)) {
    await withModifier(
      `sol modifier quartet ${role}`,
      'quartet',
      `${role} warbander spawned (seed ${randomSeed}; update QUARTET_ROLE_SEEDS if the roll changed)`,
      (session) => npcCount(session, (npc) => npc.archetypeId === `colosseum_warband_${role}`) > 0,
      { randomSeed },
    );
  }
}
