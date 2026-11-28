import type { ActorFrameState, FrameSoundTracker } from '../../audio/FrameSoundTracker';
import { COVER_TILES, PILLARS, square, VENTS, WARDEN_TILE } from '../../encounters/dukePractice/arena';
import {
  DUKE_GROUND_ICICLES,
  DUKE_ORB_NPC_ID,
  DUKE_SEQS,
  DUKE_SPOT_ANIMS,
} from '../../encounters/dukePractice/constants';
import { DUKE_PRACTICE_KIND } from '../../encounters/dukePractice/controls';
import { DUKE_PRACTICE_RENDER_CONFIG } from '../../encounters/dukePractice/renderConfig';
import type { DukePracticePose, WardenHazardKind } from '../../encounters/dukePractice/snapshot';
import { DUKE_ASLEEP_NPC_ID, DUKE_NPC_ID, LEGACY_DUKE_TYPE_ID, WARDEN_ID, WARDEN_SIZE } from '../../npcs/duke/duke';
import { NpcType } from '../../rs/config/npctype/NpcType';
import type { ModelLoader } from '../../rs/model/ModelLoader';
import type { NpcModelLoader } from '../../rs/model/NpcModelLoader';
import { HSL_RGB_MAP, packHsl } from '../../rs/util/ColorUtil';
import type { Coordinate, NpcSnapshot, SimulationState } from '../../types/simulation';
import type { AnimationSystem } from '../backends/picogl/AnimationSystem';
import type { Projection2D, Viewport } from '../core/camera';
import type { RenderQueue } from '../core/commands';
import type { ReplayEffectDestination } from '../core/replayEffectIndex';
import { ReplayPrimaryIndex } from '../core/replayPrimaryIndex';
import { rgba } from '../core/types';
import type { EncounterEffectFilter } from '../effects/NpcProjectileFlights';
import type { AnimClipRef } from '../npc/animationTypes';
import type { NpcAnimationTrigger } from '../npc/NpcInstanceManager';
import { interpolateNpcPosition } from '../npc/npcRenderPosition';
import { DukeGazeOverlay } from './dukeGazeOverlay';
import { DukePracticeEffects } from './dukePracticeEffects';
import { configureEncounterScene } from './encounterSceneBuilder';
import { isNpcModelHidden } from './npcPluginVisibility';
import { SceneCompositor, Z_LAYERS } from './SceneCompositor';
import type { SceneBuilderFactory } from './sceneBuilderFactory';
import type { RenderContext, SceneOptions } from './types';

const METAL = packHsl(147, 94, 62);
const TEAL = packHsl(123, 175, 100);
const VENT_RIM = packHsl(23, 230, 166);
const ORB_LIGHT = packHsl(203, 244, 133);
const ORB_RENDER_ACTOR_ID = 'duke-practice-orb';

// The Awakened sleeping form uses the regular fight's Feed interaction.
export const DUKE_ASLEEP_MENU_TYPE = Object.assign(
  new NpcType(DUKE_ASLEEP_NPC_ID, {
    name: 'Practice',
    game: 'oldschool',
    environment: 'local',
    revision: 0,
    timestamp: '',
    size: 0,
  }),
  { name: 'Duke Sucellus', size: WARDEN_SIZE, actions: ['Feed'] },
);
export const LEGACY_DUKE_MENU_TYPE = Object.assign(new NpcType(LEGACY_DUKE_TYPE_ID, DUKE_ASLEEP_MENU_TYPE.cacheInfo), {
  name: 'Duke Sucellus',
  size: WARDEN_SIZE,
  actions: ['Attack'],
});
const HAZARD_COLORS: Record<Exclude<WardenHazardKind, 'spikes'>, number> = {
  slam: packHsl(2, 246, 123),
  gaze: packHsl(126, 238, 151),
  magic: packHsl(149, 228, 163),
  vent: packHsl(31, 242, 129),
  gasSpit: packHsl(42, 236, 153),
  bile: packHsl(58, 220, 98),
};

function paintTile(
  queue: RenderQueue,
  projection: Projection2D,
  [x, y]: Coordinate,
  hsl: number,
  alpha: number,
  inset = 0,
) {
  const rgb = HSL_RGB_MAP[hsl];
  const corners = projection.tilePolygonScreen({ x, y });
  const center = inset > 0 ? projection.tileToScreen({ x, y }) : null;
  const points = center
    ? corners.map((corner) => ({
        x: corner.x + (center.x - corner.x) * inset,
        y: corner.y + (center.y - corner.y) * inset,
      }))
    : corners;
  queue.commands.push({
    kind: 'poly2d',
    points,
    fill: rgba(((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255, alpha),
    zIndex: Z_LAYERS.WAVE,
  });
}

export class DukePracticeSceneCompositor extends SceneCompositor {
  private dukeRenderTypeId: number | undefined;
  private readonly effects = new DukePracticeEffects();
  private readonly gazeOverlay = new DukeGazeOverlay();
  private visualHistory: RenderContext['replayHistory'];
  private replayUsesVisualEvents = false;
  private replayPose: DukePracticePose | undefined;
  private sampledPose: DukePracticePose | undefined;
  private poseTimeline = new ReplayPrimaryIndex<NpcAnimationTrigger, AnimClipRef>([]);

  constructor(
    private readonly getModelLoader?: () => ModelLoader | null,
    frameSoundTracker?: FrameSoundTracker,
  ) {
    super();
    if (frameSoundTracker) this.setFrameSoundTracker(frameSoundTracker);
    this.registerTransientReset('dukePracticeEffects', () => this.effects.reset());
  }

  protected override frameAudioStates(): ActorFrameState[] {
    // Duke's combat sounds use captured cues. His sleep and the player's clips use frame sounds.
    const dukeId = this.actorRenderIdOf(WARDEN_ID);
    return this.collectActorFrameStates().filter(({ actorId, seqId }) =>
      actorId === dukeId
        ? seqId === DUKE_SEQS.asleep
        : !actorId.startsWith('spotanim:duke-') && !actorId.startsWith('spotanim:cue-'),
    );
  }

  override build(ctx: RenderContext, projection: Projection2D, viewport: Viewport): RenderQueue {
    this.visualHistory = ctx.replayHistory ?? ctx.restoredPresentation?.history;
    const queue = super.build(ctx, projection, viewport);
    const { encounter } = ctx.simulationState;
    if (ctx.options.renderMode !== '2d' && encounter.kind === DUKE_PRACTICE_KIND) {
      const pose = encounter.visuals.pose;
      if (pose?.clip === 'gaze') this.gazeOverlay.draw(queue, this.effectTick - pose.startTick);
    }
    return queue;
  }

  protected override encounterNpcTriggers(state: SimulationState): readonly NpcAnimationTrigger[] {
    if (state.encounter.kind !== DUKE_PRACTICE_KIND || state.encounter.visuals.usesVisualEvents) return [];
    const { pose } = state.encounter.visuals;
    return pose && pose.startTick === state.currentTick
      ? [{ actorId: this.actorRenderIdOf(WARDEN_ID), trigger: 'attack', tick: pose.startTick, clipId: pose.clip }]
      : [];
  }

  protected override reconstructEncounterVisuals({ simulationState }: RenderContext): void {
    const visuals =
      simulationState.encounter.kind === DUKE_PRACTICE_KIND ? simulationState.encounter.visuals : undefined;
    this.replayPose = visuals?.pose;
    this.replayUsesVisualEvents =
      visuals?.usesVisualEvents === true && !(this.replayPose && this.legacyEffectAtTick(this.replayPose.startTick));
  }

  /** A takeover retains old frames as recorded, including attacks with only snapshot visuals. */
  private readonly legacyEffectAtTick = (tick: number): boolean => {
    const history = this.visualHistory;
    if (!history) return false;
    let low = 0;
    let high = Math.min(history.frames.length, history.throughFrameIndex + 1);
    if (high === 0) return false;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (history.frames[mid].state.currentTick <= tick) low = mid + 1;
      else high = mid;
    }
    // A trimmed prefix can start after windup while still carrying its legacy hazard.
    const source = history.frames[Math.max(0, low - 1)]?.state;
    return (
      (source?.currentTick === tick || (low === 0 && source && tick < source.currentTick)) &&
      source.encounter.kind === DUKE_PRACTICE_KIND &&
      !source.encounter.visuals.usesVisualEvents
    );
  };

  protected override encounterEffectFilter(state: SimulationState): EncounterEffectFilter | undefined {
    if (state.encounter.kind !== DUKE_PRACTICE_KIND) return undefined;
    const { hazards, fadingEffects = [] } = state.encounter.visuals;
    const effects = [...hazards, ...fadingEffects];
    return (spotAnimId, tick) => {
      if (spotAnimId === DUKE_SPOT_ANIMS.magicProjectile) {
        return effects.some((effect) => effect.kind === 'magic' && effect.windupTick === tick);
      }
      if (spotAnimId === DUKE_SPOT_ANIMS.magicImpact) {
        return effects.some((effect) => effect.kind === 'magic' && effect.impactTick === tick && !effect.missed);
      }
      if (spotAnimId === DUKE_SPOT_ANIMS.npcIcicles || DUKE_GROUND_ICICLES.some((id) => id === spotAnimId)) {
        return effects.some((effect) => effect.kind === 'spikes' && effect.impactTick === tick);
      }
      return true;
    };
  }

  protected override restoreEncounterTimelines(destination: ReplayEffectDestination): boolean {
    if (this.replayUsesVisualEvents) return false;
    const pose = this.replayPose;
    const actorId = this.actorRenderIdOf(WARDEN_ID);
    if (pose?.startTick !== this.sampledPose?.startTick || pose?.clip !== this.sampledPose?.clip) {
      this.sampledPose = pose;
      this.poseTimeline = new ReplayPrimaryIndex(
        pose
          ? [
              {
                frameIndex: 0,
                tick: pose.startTick,
                value: { actorId, trigger: 'attack', clipId: pose.clip },
              },
            ]
          : [],
      );
    }
    return this.npcInstanceManager.restoreReplayPrimary(actorId, this.poseTimeline, destination);
  }

  override async loadNpc(loader: NpcModelLoader, animationSystem?: AnimationSystem): Promise<void> {
    await super.loadNpc(loader, animationSystem);
    const modelLoader = this.getModelLoader?.();
    if (modelLoader && animationSystem) this.gazeOverlay.load(modelLoader, animationSystem);
  }

  protected override syncNpcInstances(
    npcs: NpcSnapshot[],
    is2D: boolean,
    state?: SimulationState,
    paused = false,
  ): void {
    super.syncNpcInstances(this.renderedNpcs(npcs, state), is2D, state, paused);
  }

  private renderedNpcs(npcs: NpcSnapshot[], state?: SimulationState): NpcSnapshot[] {
    const actorId = this.actorRenderIdOf(WARDEN_ID);
    const duke = npcs.find((npc) => npc.id === WARDEN_ID);
    const isLegacy = duke?.npcTypeId === LEGACY_DUKE_TYPE_ID;
    const dukeTypeId = isLegacy ? DUKE_NPC_ID : duke?.npcTypeId;
    if (dukeTypeId !== this.dukeRenderTypeId) {
      // Replace the pose on wake and on replay seeks across the wake tick.
      this.npcInstanceManager.removePresentation(actorId);
      this.dukeRenderTypeId = dukeTypeId;
    }
    const visibleNpcs = isLegacy ? npcs.map((npc) => (npc === duke ? { ...npc, npcTypeId: DUKE_NPC_ID } : npc)) : npcs;
    const visuals = state?.encounter.kind === DUKE_PRACTICE_KIND ? state.encounter.visuals : undefined;
    if (!visuals?.orbTile) return visibleNpcs;
    const { orbTile, orbPreviousTile } = visuals;

    return [
      ...visibleNpcs,
      {
        id: ORB_RENDER_ACTOR_ID,
        archetypeId: ORB_RENDER_ACTOR_ID,
        npcTypeId: DUKE_ORB_NPC_ID,
        role: 'npc',
        alive: true,
        position: orbTile,
        previousPosition: orbPreviousTile ?? orbTile,
        facingAngle: 0,
        size: 1,
        hp: 1,
        maxHp: 1,
        untargetable: true,
      },
    ];
  }

  override getAllNpcHitTestData() {
    return super.getAllNpcHitTestData().filter(({ actorId }) => actorId !== ORB_RENDER_ACTOR_ID);
  }

  protected override renderEncounterAttackEffects(
    _currentTick: number,
    interpolatedTick: number,
    playerVisualPosition: Coordinate,
    _npcPosition: Coordinate,
    _npcFacingAngle: number,
    _playerFacingAngle: number,
    _mechanicsConfig: SimulationState['mechanicsConfig'],
    is2D: boolean,
    state: SimulationState,
  ): void {
    if (is2D || state.encounter.kind !== DUKE_PRACTICE_KIND) return;
    this.effects.update(
      this.spotAnimRenderer,
      state.encounter.visuals,
      interpolatedTick,
      playerVisualPosition,
      this.resolveSurfaceHeight,
      this.legacyEffectAtTick,
    );
  }

  protected override renderEncounterEffectsLate(
    queue: RenderQueue,
    projection: Projection2D,
    tick: number,
    interpolatedTick: number,
    state: SimulationState,
    _mechanics: SimulationState['mechanicsConfig'],
    is2D: boolean,
    options: SceneOptions,
  ): void {
    if (state.encounter.kind !== DUKE_PRACTICE_KIND) return;
    if (is2D) {
      for (const tile of COVER_TILES) paintTile(queue, projection, tile, TEAL, 0.5);
      for (const tile of PILLARS) paintTile(queue, projection, tile, METAL, 1);
      for (const tile of VENTS) paintTile(queue, projection, tile, VENT_RIM, 0.95, 0.14);
    }
    const { hazards, orbTile, orbPreviousTile } = state.encounter.visuals;
    const warden = state.npcs.find((npc) => npc.id === WARDEN_ID);
    const wardenVisible =
      is2D &&
      warden?.alive &&
      !isNpcModelHidden(
        warden,
        {
          entityHider: options.entityHider ?? null,
          tzhaarHpTracker: options.tzhaarHpTracker ?? null,
        },
        'player',
      );

    if (wardenVisible) {
      const enraged = state.encounter.state.enraged && warden?.npcTypeId !== DUKE_ASLEEP_NPC_ID;
      let color = enraged ? HAZARD_COLORS.slam : TEAL;
      for (const { kind } of hazards) {
        if (kind === 'gaze' || kind === 'magic' || kind === 'slam') {
          color = HAZARD_COLORS[kind];
          break;
        }
      }
      const radius = Math.floor(WARDEN_SIZE / 2);
      for (const tile of square([WARDEN_TILE[0] + radius, WARDEN_TILE[1] + radius], radius)) {
        paintTile(queue, projection, tile, color, 0.95);
      }
    }
    const tiles = new Map<string, { kind: keyof typeof HAZARD_COLORS; tile: Coordinate; active: boolean }>();
    for (const hazard of hazards) {
      if (hazard.kind === 'magic' || hazard.kind === 'spikes' || hazard.kind === 'slam') continue;
      if (!is2D && (hazard.kind === 'vent' || hazard.kind === 'bile')) continue;
      const active = hazard.impactTick <= tick;
      for (const tile of hazard.tiles) {
        const key = `${hazard.kind}-${tile[0]}-${tile[1]}`;
        if (active || !tiles.has(key)) tiles.set(key, { kind: hazard.kind, tile, active });
      }
    }
    for (const { kind, tile, active } of tiles.values()) {
      const color = HAZARD_COLORS[kind];
      const alpha = active ? 0.64 : 0.36;
      if (is2D) paintTile(queue, projection, tile, color, alpha);
      else
        this.pushTileMesh3D(
          queue,
          tile[0],
          tile[1],
          color,
          alpha,
          `duke-practice-${kind}-${Number(active)}`,
          0.035,
          Z_LAYERS.WAVE,
        );
    }
    if (is2D && orbTile) {
      const position = interpolateNpcPosition(
        { position: orbTile, previousPosition: orbPreviousTile ?? orbTile },
        Math.max(0, Math.min(1, interpolatedTick - tick)),
      );
      paintTile(queue, projection, position, ORB_LIGHT, 1);
    }
  }
}

export const createDukePracticeSceneBuilder: SceneBuilderFactory = (options) =>
  configureEncounterScene(new DukePracticeSceneCompositor(() => options.cacheManager.getModelLoader()), {
    ...options,
    encounterRenderConfig: options.encounterRenderConfig ?? DUKE_PRACTICE_RENDER_CONFIG,
  });
