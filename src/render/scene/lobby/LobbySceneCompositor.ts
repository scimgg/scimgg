import type { OverlayTypeLoader, UnderlayTypeLoader } from '../../../rs/config/flotype/FloTypeLoader';
import type { LocationData, LocTypeInfoLoader, MapLoader, MapSquareData } from '../../../rs/map/MapLoader';
import type { NpcSnapshot } from '../../../types/simulation';
import type { Projection2D, Viewport } from '../../core/camera';
import type { Mesh3DCommand, RenderQueue } from '../../core/commands';
import { SceneCompositor } from '../SceneCompositor';
import type { NpcHitTestData, RenderContext } from '../types';
import { buildLobbyRenderContext, lobbyNpcRenderId, syncLobbyNpcInstances } from './lobbyAnimations';
import { LobbyArenaRenderer } from './lobbyArenaRenderer';
import type { LobbyCelShadedCache, LobbyFootprintCache } from './lobbyBossModels';
import { applyLobbyBossTransforms, forceTransparentPlayerMeshToOpaque, remapLobbyHitTestData } from './lobbyBossModels';

export class LobbySceneCompositor extends SceneCompositor {
  private forcedTerrain: MapSquareData | null = null;
  private readonly arenaRenderer = new LobbyArenaRenderer();
  private readonly celShadedCache: LobbyCelShadedCache = new Map();
  private readonly footprintCache: LobbyFootprintCache = new Map();

  constructor(
    private readonly lobbyMapX: number,
    private readonly lobbyMapY: number,
    private readonly lobbyLevel: number,
  ) {
    super();
    this.deferNpcClickbox = true;
  }

  override dispose(): void {
    super.dispose();
    this.forcedTerrain = null;
    this.celShadedCache.clear();
    this.footprintCache.clear();
    this.arenaRenderer.dispose();
  }

  protected override getTerrainMapSquare(): { x: number; y: number } {
    return { x: this.lobbyMapX, y: this.lobbyMapY };
  }

  protected override syncNpcInstances(npcs: Parameters<typeof syncLobbyNpcInstances>[1], is2D: boolean): void {
    syncLobbyNpcInstances(this.npcInstanceManager, npcs, is2D);
  }

  protected override npcRenderIdOf(npc: NpcSnapshot): string {
    return lobbyNpcRenderId(npc);
  }

  setForcedTerrain(terrain: MapSquareData | null): void {
    this.forcedTerrain = terrain;
  }

  override build(ctx: RenderContext, projection: Projection2D, viewport: Viewport): RenderQueue {
    const queue = super.build(buildLobbyRenderContext(ctx), projection, viewport);

    if (ctx.options.renderMode === '2d') {
      return queue;
    }

    for (let i = 0; i < queue.commands.length; i++) {
      const command = queue.commands[i];
      if (command.kind === 'mesh3d') {
        queue.commands[i] = forceTransparentPlayerMeshToOpaque(command);
      }
    }

    this.arenaRenderer.setTerrainHeights(this.npcInstanceManager.getTerrainHeights());
    this.arenaRenderer.setEffectFlags(ctx.options.encounterDebugFlags || {});
    this.arenaRenderer.renderTo(queue);

    queue.commands = queue.commands.filter((command) => {
      if (command.kind !== 'mesh3d') return true;
      const meshId = (command as Mesh3DCommand).meshId;
      return (
        !meshId.startsWith('terrain-') &&
        !meshId.startsWith('npc-') &&
        !meshId.startsWith('loc-') &&
        !meshId.startsWith('merged-static-locs')
      );
    });

    applyLobbyBossTransforms(this.npcInstanceManager, this.celShadedCache, this.footprintCache);
    this.renderNpcModels(queue);

    if (ctx.options.showNpcClickbox) {
      this.buildNpcClickboxOverlay3D(queue);
    }

    return queue;
  }

  override getAllNpcHitTestData(): Array<{ actorId: string; hitTestData: NpcHitTestData }> {
    return remapLobbyHitTestData(super.getAllNpcHitTestData());
  }

  override async buildTerrainMesh3D(
    mapLoader: MapLoader,
    underlayLoader?: UnderlayTypeLoader,
    overlayLoader?: OverlayTypeLoader,
    locations?: LocationData[],
    locTypeInfoLoader?: LocTypeInfoLoader,
  ): Promise<import('../../core/commands').TerrainMesh3DCommand> {
    const forcedTerrain = this.forcedTerrain;
    const level = this.lobbyLevel;

    const wrappedMapLoader = {
      loadMapSquare: async (mapX: number, mapY: number, xteas?: number[]) => {
        let data =
          mapX === this.lobbyMapX && mapY === this.lobbyMapY
            ? (forcedTerrain ?? (await mapLoader.loadMapSquare(this.lobbyMapX, this.lobbyMapY, xteas)))
            : await mapLoader.loadMapSquare(mapX, mapY, xteas);

        if (data && level !== 0) {
          data = {
            ...data,
            tileHeights: [[...data.tileHeights[level]], ...data.tileHeights.slice(1)],
            tileUnderlays: [[...data.tileUnderlays[level]], ...data.tileUnderlays.slice(1)],
            tileOverlays: [[...data.tileOverlays[level]], ...data.tileOverlays.slice(1)],
            tileShapes: [[...data.tileShapes[level]], ...data.tileShapes.slice(1)],
            tileRotations: [[...data.tileRotations[level]], ...data.tileRotations.slice(1)],
            tileRenderFlags: [[...data.tileRenderFlags[level]], ...data.tileRenderFlags.slice(1)],
            tileLightOcclusions: [[...data.tileLightOcclusions[level]], ...data.tileLightOcclusions.slice(1)],
          };
        }

        return data;
      },
    } as unknown as MapLoader;

    return super.buildTerrainMesh3D(wrappedMapLoader, underlayLoader, overlayLoader, locations, locTypeInfoLoader);
  }
}
