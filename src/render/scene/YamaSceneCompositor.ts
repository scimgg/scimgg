import { isYamaSnapshot } from '../../core/encounters/snapshot';
import type { GameEvent } from '../../core/events/types';
import { getFireballDangerTiles } from '../../encounters/yamaP3/fireball';
import { YAMA_ENCOUNTER_RENDER_CONFIG } from '../../encounters/yamaP3/renderConfig';
import type { WaveConfig } from '../../encounters/yamaP3/waves';
import type { SpotAnimModelLoader } from '../../rs/model/SpotAnimModelLoader';
import { packHsl } from '../../rs/util/ColorUtil';
import type { Coordinate, DamageHistoryEntry, SimulationState } from '../../types/simulation';
import type { Projection2D, Viewport } from '../core/camera';
import type { FillStyle, RenderQueue } from '../core/commands';
import type { ReplayEffectDestination, ReplayFrameReader } from '../core/replayEffectIndex';
import { rgba, rgbaFromHex, vec2 } from '../core/types';
import { FIREBALL_PRELOAD_IDS, FireballController } from '../effects/controllers/FireballController';
import { VOID_FLARE_PRELOAD_IDS, VoidFlareController } from '../effects/controllers/VoidFlareController';
import { WAVE_PRELOAD_IDS, WaveController } from '../effects/controllers/WaveController';
import { YAMA_ATTACK_PRELOAD_IDS, YamaAttackController } from '../effects/controllers/YamaAttackController';
import { type NpcAnimationTrigger, PRIMARY_NPC_ACTOR_ID } from '../npc/NpcInstanceManager';
import { getLocCenterHeight } from '../shared/renderUtils';
import type { NpcRenderConfig } from './encounterRenderConfig';
import { SceneCompositor, Z_LAYERS } from './SceneCompositor';
import type { RenderContext, SceneOptions } from './types';
import { describeYamaPrimaries, YamaReplayIndex } from './yamaReplayIndex';

const YAMA_COLORS = {
  npc: rgbaFromHex('#4a0404'),
  npcBorder: rgbaFromHex('#ff1a1a'),
};

const FIREBALL_SOURCES = new Set(['Fireball']);

function tilePolygonCommand(
  projection: Projection2D,
  coord: Coordinate,
  fill?: import('../core/types').ColorRGBA,
  stroke?: import('../core/commands').StrokeStyle,
  zIndex = 0,
): import('../core/commands').RenderCommand {
  const tile = { x: coord[0], y: coord[1] };
  const points = projection.tilePolygonScreen(tile);
  return {
    kind: 'poly2d',
    points,
    fill,
    stroke,
    zIndex,
  };
}

export class YamaSceneCompositor extends SceneCompositor {
  private waveController = new WaveController();
  private attackController = new YamaAttackController();
  private fireballController = new FireballController();
  private voidFlareController = new VoidFlareController();
  private yamaAttackOutlineIsMagic = false;
  private yamaAttackOutlineEndTick: number | undefined = undefined;
  private _fadedDamageEntries = new Set<DamageHistoryEntry>();
  private _fadedDamageHistoryLen = 0;
  private cachedWaveConfig: WaveConfig | undefined = undefined;
  private flareFrame: number | undefined;

  constructor() {
    super();
    // Register Yama's transient render/audio state with the base discontinuity
    // reset. Registration IS participation: a future encounter that forgets to
    // register a controller is the only way to leave state stale on seek,
    // and it's a one-line, co-located declaration.
    this.registerTransientReset('yama-effects', () => {
      this.flareFrame = undefined;
      this.waveController.clearActive(this.spotAnimRenderer);
      this.attackController.clearActive(this.spotAnimRenderer);
      this.fireballController.clearActive(this.spotAnimRenderer);
      this.voidFlareController.clearActive(this.spotAnimRenderer);
    });
    this.registerTransientReset('yama-overlays', () => {
      // Replay frames share one cumulative damage log, so a DamageHistoryEntry
      // keeps object identity across frames; the reference-keyed fade Set would
      // wrongly suppress an overlay that should be visible again at an earlier
      // seeked tick. The attack outline is latched to attackTick+3 and must not
      // render for a future attack after seeking back.
      this._fadedDamageEntries.clear();
      this._fadedDamageHistoryLen = 0;
      this.yamaAttackOutlineEndTick = undefined;
      this.yamaAttackOutlineIsMagic = false;
    });
  }

  override dispose(): void {
    this.waveController.clearActive(this.spotAnimRenderer);
    this.attackController.clearActive(this.spotAnimRenderer);
    this.fireballController.clearActive(this.spotAnimRenderer);
    this.voidFlareController.clearActive(this.spotAnimRenderer);
    super.dispose();
    this._fadedDamageEntries.clear();
    this._fadedDamageHistoryLen = 0;
    this.yamaAttackOutlineEndTick = undefined;
  }

  override build(ctx: RenderContext, projection: Projection2D, viewport: Viewport): RenderQueue {
    const snapshot = ctx.simulationState.encounter;
    this.cachedWaveConfig = isYamaSnapshot(snapshot) ? snapshot.state.waveConfig : undefined;
    return super.build(ctx, projection, viewport);
  }

  protected override onEncounterEvents(events: GameEvent[], ctx: RenderContext): void {
    if (ctx.replayHistory) return;
    this.waveController.consumeEvents(events);
    this.attackController.consumeEvents(events);
    this.voidFlareController.consumeEvents(events);
  }

  protected override reconstructEncounterVisuals(ctx: RenderContext): void {
    const history = ctx.replayHistory;
    const index = this.yamaReplayIndex();
    if (!history || !index) return;
    const destination = { cycle: this.effectTick * 30, throughFrameIndex: history.throughFrameIndex };
    const attack = index.latestAttack(destination);
    if (attack) {
      const castDuration = this.effectDuration(attack.npcCast.spotAnimId);
      const impactDuration = this.effectDuration(attack.playerImpact.spotAnimId);
      const npcCast =
        castDuration === undefined || destination.cycle < attack.npcCast.startCycle + castDuration
          ? attack.npcCast
          : null;
      const playerImpact =
        impactDuration === undefined || destination.cycle < attack.playerImpact.startCycle + impactDuration
          ? attack.playerImpact
          : null;
      this.attackController.consumeDescriptor({ npcCast, playerImpact });
      if (npcCast) this.prepareReplaySpotAnim(npcCast.spotAnimId);
      if (playerImpact) this.prepareReplaySpotAnim(playerImpact.spotAnimId);
    }
    for (const id of VOID_FLARE_PRELOAD_IDS) this.prepareReplaySpotAnim(id);
    if (this.flareFrame !== history.throughFrameIndex) {
      this.voidFlareController.reconstruct(index.recentFlareEvents(destination), this.spotAnimRenderer);
      this.flareFrame = history.throughFrameIndex;
    }
  }

  protected override createEncounterReplayReader(): ReplayFrameReader {
    return new YamaReplayIndex();
  }

  /** Yama's body, from his own primary timeline: a seek lands on the clip and phase playback shows. */
  protected override restoreEncounterTimelines(destination: ReplayEffectDestination): boolean {
    const index = this.yamaReplayIndex();
    return (
      index !== undefined &&
      this.npcInstanceManager.restoreReplayPrimary(PRIMARY_NPC_ACTOR_ID, index.primaryTimeline, destination)
    );
  }

  /** Live, Yama's body trigger for the snapshot's tick, played on the NPC clock from that tick. */
  protected override encounterNpcTriggers(simulationState: SimulationState): readonly NpcAnimationTrigger[] {
    return describeYamaPrimaries(simulationState);
  }

  private yamaReplayIndex(): YamaReplayIndex | undefined {
    const reader = this.replayEffectIndex?.encounter;
    return reader instanceof YamaReplayIndex ? reader : undefined;
  }

  protected override renderEncounterEffectsEarly(
    queue: RenderQueue,
    currentTick: number,
    interpolatedTick: number,
    mechanicsConfig: SimulationState['mechanicsConfig'],
    options: SceneOptions,
  ): void {
    if (mechanicsConfig?.waves !== false) {
      this.waveController.setTerrainHeights(this.terrainHeights);
      this.waveController.update(
        this.spotAnimRenderer,
        currentTick,
        interpolatedTick,
        queue,
        !!options.encounterDebugFlags?.waveTiles,
        this.cachedWaveConfig,
      );
    } else {
      this.waveController.clearActive(this.spotAnimRenderer);
    }
  }

  protected override renderEncounterEffectsLate(
    queue: RenderQueue,
    projection: Projection2D,
    currentTick: number,
    interpolatedTick: number,
    simulationState: SimulationState,
    mechanicsConfig: SimulationState['mechanicsConfig'],
    _is2D: boolean,
    options: SceneOptions,
  ): void {
    // Not gated on the Fireballs toggle here: the snapshot's fireball visuals already leave out the
    // fight's own fireballs while it is off and keep the practice-spawned ones.
    this.fireballController.setTerrainHeights(this.terrainHeights);
    this.fireballController.update(
      this.spotAnimRenderer,
      currentTick,
      interpolatedTick,
      queue,
      projection,
      simulationState,
      options.renderMode ?? '3d',
    );
    this.voidFlareController.setTerrainHeights(this.terrainHeights);
    this.voidFlareController.update(
      this.spotAnimRenderer,
      currentTick,
      this.effectTick,
      queue,
      projection,
      options.renderMode ?? '3d',
      { npcs: simulationState.npcs, showScheduled: mechanicsConfig?.voidFlares !== false },
    );
  }

  protected override renderEncounterDebugOverlays(
    queue: RenderQueue,
    projection: Projection2D,
    simulationState: SimulationState,
    interpolatedTick: number,
    is2D: boolean,
    debugFlags: Record<string, boolean | number>,
  ): void {
    if (debugFlags?.damageTiles) {
      this.buildDamageTileOverlays(queue, projection, simulationState, interpolatedTick, is2D);
    }
    if (debugFlags?.fireballDangerTiles) {
      this.buildFireballDangerTileOverlays(queue, projection, simulationState, is2D);
    }
  }

  protected override renderEncounterNpc2D(
    queue: RenderQueue,
    projection: Projection2D,
    simulationState: SimulationState,
  ): void {
    const snapshot = simulationState.encounter;
    const lastAttackKind = isYamaSnapshot(snapshot) ? (snapshot.state.lastAttackKind ?? undefined) : undefined;
    this.buildYama(
      queue,
      projection,
      simulationState.primaryNpcPosition,
      simulationState.currentTick,
      simulationState.mechanicsConfig?.yamaMageRange !== false,
      lastAttackKind,
      simulationState.primaryNpcSize,
    );
  }

  protected override renderEncounterAttackEffects(
    currentTick: number,
    _interpolatedTick: number,
    playerVisualPos: [number, number],
    npcPosition: Coordinate,
    npcFacingAngle: number,
    playerFacingAngle: number,
    mechanicsConfig: SimulationState['mechanicsConfig'],
    is2D: boolean,
  ): void {
    if (!is2D && mechanicsConfig?.yamaMageRange !== false) {
      this.attackController.setTerrainHeights(this.terrainHeights);
      this.attackController.update(
        this.spotAnimRenderer,
        currentTick,
        this.effectTick,
        playerVisualPos,
        this.resolvePrimaryNpcCenter(npcPosition),
        npcFacingAngle,
        playerFacingAngle,
      );
    } else {
      this.attackController.clearActive(this.spotAnimRenderer);
    }
  }

  /**
   * Yama's model center THIS FRAME, for effects that hang off him.
   *
   * Under Contract of sensory clouding he walks, so anything anchored to his spawn tile or even
   * to his simulation tile detaches from the model — the tile only updates on a tick boundary,
   * while the model slides between tiles every frame. `NpcInstanceManager`'s matrix is the same
   * interpolated position the model itself is drawn at, which is why the death spotanim already
   * reads it; the simulation tile is the fallback for the frames before the instance exists.
   */
  private resolvePrimaryNpcCenter(npcPosition: Coordinate): [number, number, number] {
    const size = this.latestSimulationState?.primaryNpcSize ?? this.getPrimaryNpcRenderConfig()?.size ?? 5;
    const modelMatrix = this.npcInstanceManager.getModelMatrix(PRIMARY_NPC_ACTOR_ID);
    if (modelMatrix) {
      return [modelMatrix[12], modelMatrix[13], modelMatrix[14]];
    }
    return [
      npcPosition[0] + size / 2,
      npcPosition[1] + size / 2,
      getLocCenterHeight(this.terrainHeights, npcPosition[0], npcPosition[1], size, size),
    ];
  }

  protected override async loadEncounterSpotAnims(spotAnimModelLoader: SpotAnimModelLoader): Promise<void> {
    await this.loadWaveSpotAnims(spotAnimModelLoader);
    await this.loadFireballSpotAnims(spotAnimModelLoader);
    await this.loadVoidFlareSpotAnims(spotAnimModelLoader);
  }

  protected override isEncounterSpotAnimsLoaded(): boolean {
    return this.isWaveSpotAnimsLoaded();
  }

  private async loadWaveSpotAnims(spotAnimModelLoader: SpotAnimModelLoader): Promise<void> {
    this.spotAnimModelLoader = spotAnimModelLoader;
    this.spotAnimRenderer.preload(spotAnimModelLoader, WAVE_PRELOAD_IDS);
    await this.loadAttackSpotAnims(spotAnimModelLoader);
  }

  private getPrimaryNpcRenderConfig(): NpcRenderConfig {
    return this.encounterRenderConfig?.primaryNpc ?? YAMA_ENCOUNTER_RENDER_CONFIG.primaryNpc!;
  }

  private isWaveSpotAnimsLoaded(): boolean {
    return WAVE_PRELOAD_IDS.every((id) => this.spotAnimRenderer.isLoaded(id));
  }

  private async loadFireballSpotAnims(spotAnimModelLoader: SpotAnimModelLoader): Promise<void> {
    this.spotAnimModelLoader = spotAnimModelLoader;
    this.spotAnimRenderer.preload(spotAnimModelLoader, FIREBALL_PRELOAD_IDS);
  }

  private async loadVoidFlareSpotAnims(spotAnimModelLoader: SpotAnimModelLoader): Promise<void> {
    this.spotAnimModelLoader = spotAnimModelLoader;
    this.spotAnimRenderer.preload(spotAnimModelLoader, VOID_FLARE_PRELOAD_IDS);
  }

  private async loadAttackSpotAnims(spotAnimModelLoader: SpotAnimModelLoader): Promise<void> {
    this.spotAnimModelLoader = spotAnimModelLoader;
    this.spotAnimRenderer.preload(spotAnimModelLoader, YAMA_ATTACK_PRELOAD_IDS);
  }

  private buildYama(
    queue: RenderQueue,
    projection: Projection2D,
    yamaPos: Coordinate,
    currentTick?: number,
    mageRangeEnabled = true,
    lastAttackKind?: string,
    npcSize = 5,
  ): void {
    if (currentTick !== undefined && mageRangeEnabled && lastAttackKind) {
      if (lastAttackKind === 'magic_fire' || lastAttackKind === 'range_shadow') {
        this.yamaAttackOutlineIsMagic = lastAttackKind === 'magic_fire';
        this.yamaAttackOutlineEndTick = currentTick + 3;
      }
    }

    let borderColor = YAMA_COLORS.npcBorder;
    let borderWidth = 2;
    if (
      currentTick !== undefined &&
      this.yamaAttackOutlineEndTick !== undefined &&
      currentTick < this.yamaAttackOutlineEndTick
    ) {
      const isLastTick = currentTick === this.yamaAttackOutlineEndTick - 1;
      if (this.yamaAttackOutlineIsMagic) {
        borderColor = isLastTick ? rgbaFromHex('#FFAA44') : rgbaFromHex('#FF4500');
      } else {
        borderColor = isLastTick ? rgbaFromHex('#B08FE0') : rgbaFromHex('#6B3FA0');
      }
      borderWidth = isLastTick ? 4 : 3;
    }

    const [swCol, swRow] = yamaPos;
    const npcSizeOffset = npcSize - 1;
    const minTileX = swCol;
    const maxTileX = swCol + npcSizeOffset;
    const minTileY = swRow;
    const maxTileY = swRow + npcSizeOffset;

    const allCorners = [
      ...projection.tilePolygonScreen({ x: minTileX, y: minTileY }),
      ...projection.tilePolygonScreen({ x: maxTileX, y: minTileY }),
      ...projection.tilePolygonScreen({ x: maxTileX, y: maxTileY }),
      ...projection.tilePolygonScreen({ x: minTileX, y: maxTileY }),
    ];

    if (allCorners.length >= 4) {
      let sMinX = Infinity;
      let sMaxX = -Infinity;
      let sMinY = Infinity;
      let sMaxY = -Infinity;
      for (const c of allCorners) {
        if (c.x < sMinX) sMinX = c.x;
        if (c.x > sMaxX) sMaxX = c.x;
        if (c.y < sMinY) sMinY = c.y;
        if (c.y > sMaxY) sMaxY = c.y;
      }

      const points = [vec2(sMinX, sMinY), vec2(sMaxX, sMinY), vec2(sMaxX, sMaxY), vec2(sMinX, sMaxY)];

      const centerX = (sMinX + sMaxX) / 2;
      const centerY = (sMinY + sMaxY) / 2;
      const radius = Math.max(sMaxX - sMinX, sMaxY - sMinY) * 0.6;

      const fill: FillStyle = {
        center: vec2(centerX, centerY),
        radius,
        stops: [
          { offset: 0, color: YAMA_COLORS.npc },
          { offset: 1, color: rgba(YAMA_COLORS.npc.r * 0.7, YAMA_COLORS.npc.g * 0.7, YAMA_COLORS.npc.b * 0.7, 1) },
        ],
      };

      queue.commands.push({
        kind: 'poly2d',
        points,
        fill,
        stroke: { color: borderColor, widthPx: borderWidth },
        zIndex: Z_LAYERS.NPC,
      });
    }
  }

  private buildDamageTileOverlays(
    queue: RenderQueue,
    projection: Projection2D,
    simulationState: SimulationState,
    interpolatedTick: number,
    is2D: boolean,
  ): void {
    const FADE_TICKS = 10;
    const MAX_ALPHA = 0.45;
    const { damageHistory } = simulationState;

    if (!damageHistory || damageHistory.length === 0) return;

    if (damageHistory.length < this._fadedDamageHistoryLen) {
      this._fadedDamageEntries.clear();
    }
    this._fadedDamageHistoryLen = damageHistory.length;

    const { currentTick } = simulationState;
    const tileFades = new Map<string, { x: number; y: number; alpha: number; source: string }>();

    for (const entry of damageHistory) {
      if (this._fadedDamageEntries.has(entry)) continue;
      if (currentTick - entry.tick > FADE_TICKS + 2) {
        this._fadedDamageEntries.add(entry);
        continue;
      }
      if (entry.effectiveDamage <= 0) continue;
      if (!FIREBALL_SOURCES.has(entry.source)) continue;
      const age = interpolatedTick - entry.tick;
      if (age < 0 || age > FADE_TICKS) continue;

      const pos = entry.playerPosition;
      if (!pos) continue;

      const key = `${pos[0]},${pos[1]}`;
      const alpha = MAX_ALPHA * (1 - age / FADE_TICKS);
      if (alpha <= 0) continue;

      const existing = tileFades.get(key);
      if (!existing || alpha > existing.alpha) {
        tileFades.set(key, { x: pos[0], y: pos[1], alpha, source: entry.source });
      }
    }

    if (tileFades.size === 0) return;

    if (is2D) {
      for (const { x, y, alpha } of tileFades.values()) {
        queue.commands.push(
          tilePolygonCommand(projection, [x, y], rgba(1, 0.1, 0.1, alpha), undefined, Z_LAYERS.EXPLOSION + 1),
        );
      }
    } else {
      const redHsl = packHsl(2, 248, 98);
      for (const { x, y, alpha } of tileFades.values()) {
        this.pushTileMesh3D(queue, x, y, redHsl, alpha, 'damage-tile', 0.015, Z_LAYERS.EXPLOSION + 1);
      }
    }
  }

  private buildFireballDangerTileOverlays(
    queue: RenderQueue,
    projection: Projection2D,
    simulationState: SimulationState,
    is2D: boolean,
  ): void {
    const { currentTick } = simulationState;
    const snapshot = simulationState.encounter;
    const fireballStates = isYamaSnapshot(snapshot) ? snapshot.visuals.fireballStates : [];
    if (fireballStates.length === 0) return;

    const ALPHA = 0.35;
    const dangerTileSet = new Set<string>();

    for (const fb of fireballStates) {
      if (!fb.active || !fb.centerPosition || !fb.angle) continue;
      const startTick = currentTick - fb.ticksIntoPhase;
      const tiles = getFireballDangerTiles(
        fb.centerPosition,
        fb.angle as Parameters<typeof getFireballDangerTiles>[1],
        startTick,
        currentTick,
      );
      for (const [tx, ty] of tiles) {
        dangerTileSet.add(`${tx},${ty}`);
      }
    }

    if (dangerTileSet.size === 0) return;

    if (is2D) {
      for (const key of dangerTileSet) {
        const [sx, sy] = key.split(',');
        const x = Number(sx);
        const y = Number(sy);
        queue.commands.push(
          tilePolygonCommand(projection, [x, y], rgba(1, 0.5, 0, ALPHA), undefined, Z_LAYERS.EXPLOSION),
        );
      }
    } else {
      const orangeHsl = packHsl(8, 248, 120);
      for (const key of dangerTileSet) {
        const [sx, sy] = key.split(',');
        const x = Number(sx);
        const y = Number(sy);
        this.pushTileMesh3D(queue, x, y, orangeHsl, ALPHA, 'danger-tile', 0.012, Z_LAYERS.EXPLOSION);
      }
    }
  }
}
