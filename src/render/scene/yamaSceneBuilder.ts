import type { EventAudioPlayer, FrameSoundTracker } from '../../audio';
import type { CacheManager, LocWithType } from '../../cache/CacheManager';
import { YAMA_ENCOUNTER_RENDER_CONFIG } from '../../encounters/yamaP3/renderConfig';
import type { OverlayTypeLoader, UnderlayTypeLoader } from '../../rs/config/flotype/FloTypeLoader';
import type { LocModelLoader } from '../../rs/config/loctype/LocModelLoader';
import type { LocationData, LocTypeInfoLoader, MapLoader } from '../../rs/map/MapLoader';
import type { NpcModelLoader } from '../../rs/model/NpcModelLoader';
import type { PlayerAppearance, PlayerEquipment, PlayerModelLoader } from '../../rs/model/PlayerModelLoader';
import type { SpotAnimModelLoader } from '../../rs/model/SpotAnimModelLoader';
import type { AnimationSystem } from '../core/animation';
import type { Projection2D, Viewport } from '../core/camera';
import type { RenderQueue } from '../core/commands';
import type { ImmutableMeshSource } from '../core/meshSource';
import { withDescriptorMapBlock } from './encounterMapBlock';
import type { EncounterRenderConfig } from './encounterRenderConfig';
import type { RenderContext, SceneBuilder, TextureIndexMapper } from './types';
import { YamaSceneCompositor } from './YamaSceneCompositor';

export type { NpcMesh3DCommand, TerrainMesh3DCommand } from '../core/commands';

export class YamaSceneBuilder implements SceneBuilder {
  private readonly compositor: YamaSceneCompositor;

  constructor(options?: {
    eventAudioPlayer?: EventAudioPlayer;
    frameSoundTracker?: FrameSoundTracker;
    encounterRenderConfig?: EncounterRenderConfig;
    cacheManager?: CacheManager;
  }) {
    this.compositor = new YamaSceneCompositor();
    this.compositor.setEncounterRenderConfig(
      options?.encounterRenderConfig ?? withDescriptorMapBlock(YAMA_ENCOUNTER_RENDER_CONFIG, 'yama_p3'),
    );
    this.compositor.setEventAudioPlayer(options?.eventAudioPlayer ?? null);
    this.compositor.setFrameSoundTracker(options?.frameSoundTracker ?? null);
    this.compositor.setGroundItemLoaderSource(options?.cacheManager ?? null);
  }

  build(ctx: RenderContext, projection: Projection2D, viewport: Viewport): RenderQueue {
    return this.compositor.build(ctx, projection, viewport);
  }

  async loadTerrain(
    mapLoader: MapLoader,
    underlayLoader?: UnderlayTypeLoader,
    overlayLoader?: OverlayTypeLoader,
    textureIndexMapper?: TextureIndexMapper,
    locations?: LocationData[],
    locTypeInfoLoader?: LocTypeInfoLoader,
    smoothTerrain?: boolean,
  ): Promise<void> {
    await this.compositor.loadTerrain(
      mapLoader,
      underlayLoader,
      overlayLoader,
      textureIndexMapper,
      locations,
      locTypeInfoLoader,
      smoothTerrain,
    );
  }

  async buildTerrainMesh3D(
    mapLoader: MapLoader,
    underlayLoader?: UnderlayTypeLoader,
    overlayLoader?: OverlayTypeLoader,
    locations?: LocationData[],
    locTypeInfoLoader?: LocTypeInfoLoader,
  ): Promise<import('../core/commands').TerrainMesh3DCommand> {
    return this.compositor.buildTerrainMesh3D(mapLoader, underlayLoader, overlayLoader, locations, locTypeInfoLoader);
  }

  isTerrainLoaded(): boolean {
    return this.compositor.isTerrainLoaded();
  }

  setSmoothTerrain(enabled: boolean): void {
    this.compositor.setSmoothTerrain(enabled);
  }

  getTerrainHeights(): Int32Array[] | null {
    return this.compositor.getTerrainHeights();
  }

  async loadNpc(npcModelLoader: NpcModelLoader, animSystem?: AnimationSystem): Promise<void> {
    await this.compositor.loadNpc(npcModelLoader, animSystem);
  }

  isNpcLoaded(): boolean {
    return this.compositor.isNpcLoaded();
  }

  getAllNpcHitTestData(): Array<{ actorId: string; hitTestData: import('./types').NpcHitTestData }> {
    return this.compositor.getAllNpcHitTestData();
  }

  getAllGroundItemHitTestData(): Array<{ groundItemId: string; hitTestData: import('./types').NpcHitTestData }> {
    return this.compositor.getAllGroundItemHitTestData();
  }

  async loadNpcType(
    npcTypeId: number,
    npcModelLoader: NpcModelLoader,
    animSystem?: AnimationSystem,
    config?: import('../npc/NpcInstanceManager').NpcTypeLoadConfig,
  ): Promise<void> {
    await this.compositor.loadNpcType(npcTypeId, npcModelLoader, animSystem, config);
  }

  isNpcTypeLoaded(npcTypeId: number): boolean {
    return this.compositor.isNpcTypeLoaded(npcTypeId);
  }

  async loadPlayer(
    playerModelLoader: PlayerModelLoader,
    appearance?: PlayerAppearance,
    equipment?: PlayerEquipment,
  ): Promise<void> {
    await this.compositor.loadPlayer(playerModelLoader, appearance, equipment);
  }

  isPlayerLoaded(): boolean {
    return this.compositor.isPlayerLoaded();
  }

  async loadSpotAnims(spotAnimModelLoader: SpotAnimModelLoader): Promise<void> {
    await this.compositor.loadSpotAnims(spotAnimModelLoader);
  }

  isSpotAnimsLoaded(spotAnimModelLoader?: SpotAnimModelLoader): boolean {
    return this.compositor.isSpotAnimsLoaded(spotAnimModelLoader);
  }

  getResidentMeshSources(): readonly ImmutableMeshSource[] {
    return this.compositor.getResidentMeshSources();
  }

  isIntroAnimationComplete(): boolean {
    return this.compositor.isIntroAnimationComplete();
  }

  getIntroAnimationRemainingMs(expectedSpeedMultiplier: number): number | null {
    return this.compositor.getIntroAnimationRemainingMs(expectedSpeedMultiplier);
  }

  resetIntroState(): void {
    this.compositor.resetIntroState();
  }

  getPrimaryAnimMovementBlock(): { blocksRunning: boolean; blocksWalking: boolean } {
    return this.compositor.getPrimaryAnimMovementBlock();
  }

  async loadLocs(locModelLoader: LocModelLoader, locsWithTypes: LocWithType[]): Promise<void> {
    await this.compositor.loadLocs(locModelLoader, locsWithTypes);
  }

  isLocsLoaded(): boolean {
    return this.compositor.isLocsLoaded();
  }

  dispose(): void {
    this.compositor.dispose();
  }
}

export function createYamaSceneBuilder(options?: {
  eventAudioPlayer?: EventAudioPlayer;
  frameSoundTracker?: FrameSoundTracker;
  encounterRenderConfig?: EncounterRenderConfig;
  cacheManager?: CacheManager;
}): SceneBuilder {
  return new YamaSceneBuilder(options);
}
