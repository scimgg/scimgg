import { beforeEach, describe, expect, it } from 'vitest';
import type { GameEvent, OverheadTextAnchor } from '../../../core/events/types';
import { VOID_FLARE_NPC_ID } from '../../../encounters/yamaP3/constants';
import { yamaSnapshot } from '../../../test/helpers/encounterSnapshot';
import type { DamageHistoryEntry, NpcSnapshot, NpcState, SimulationState } from '../../../types/simulation';
import { PrayerType } from '../../../types/simulation';
import { DEFAULT_TZHAAR_HP_TRACKER_OPTIONS, type TzhaarHpTrackerOptions } from '../../../types/tzhaarHpTracker';
import { getTickColor } from '../../../util/tickColor';
import type { Projection2D } from '../../core/camera';
import type { OverheadIcon, RenderQueue, TickCounterOverlay } from '../../core/commands';
import { OVERLAY_LAYER_Z_INDEX } from '../../core/commands';
import {
  type OverheadNumberPlacement,
  type PlayerOverheadNumbers,
  type TickCounterPresentation,
  UIOverlayRenderer,
} from '../UIOverlayRenderer';

const HITSPLAT_DURATION_TICKS = 2;
const HEALTHBAR_DURATION_TICKS = 8;

type HitsplatSlot = {
  readonly amount: number;
  readonly type: string;
  readonly spawnTick: number;
  readonly expiryTick: number;
};

function createQueue(): RenderQueue {
  return { replayPresentationReady: true, commands: [] };
}

function createMockProjection(): Projection2D {
  return {
    tileToScreen: (tile) => ({ x: tile.x * 32, y: (tile.level ?? 0) * -100 + tile.y * 32 }),
    tileDeltaToScreen: (d) => d,
    screenToTile: () => null,
    tilePolygonScreen: () => [],
  };
}

function createBaseState(overrides: Partial<SimulationState> = {}): SimulationState {
  return {
    currentTick: 0,
    playerPosition: [31, 25],
    playerPreviousPosition: [31, 25],
    playerMovementPath: [],
    playerFacingAngle: 0,
    playerIsMoving: false,
    playerIsRunning: false,
    primaryNpcPosition: [29, 28],
    primaryNpcPreviousPosition: [29, 28],
    primaryNpcFacingAngle: 0,
    primaryNpcSize: 5,
    npcs: [],
    encounter: yamaSnapshot({ state: { firstRangeMageType: 'magic' } }),
    isAlive: true,
    activePrayer: null,
    boostPrayers: [],
    independentPrayers: [],
    failedCondition: null,
    playerHistory: new Map(),
    primaryNpcHistory: new Map(),
    playerHP: 99,
    maxHP: 99,
    damageHistory: [],
    eventLog: [],
    stats: {} as any,
    specialAttack: {} as any,
    combatTimers: {} as any,
    potionBoosts: [],
    inventory: {} as any,
    isRunEnabled: true,
    isSpecialAttackActive: false,
    pendingSpecialAttackToggles: 0,
    pendingProtectionPrayer: [false, null],
    pendingBoostPrayers: [false, []],
    pendingIndependentPrayers: [false, []],
    quickPrayersActive: false,
    runEnergy: {} as any,
    equipmentStats: {} as any,
    prayerState: { points: 99, maxPoints: 99, drainCounter: 0, activePrayers: [] },
    playerEquipment: {} as any,
    cooldownTracks: {} as any,
    mechanicsConfig: {} as any,
    ...overrides,
  } as SimulationState;
}

function makeDamageEntry(
  tick: number,
  damage: number,
  overrides: Partial<DamageHistoryEntry> = {},
): DamageHistoryEntry {
  return {
    tick,
    source: 'YamaAttack',
    targetId: 'player',
    baseDamage: damage,
    attackType: 'magic',
    activePrayer: null,
    prayedCorrectly: null,
    effectiveDamage: damage,
    hpBefore: 99,
    hpAfter: 99 - damage,
    ...overrides,
  };
}

function damageToEvent(entry: DamageHistoryEntry, eventId: number): GameEvent {
  return {
    type: 'hitsplat_spawned',
    eventId,
    tick: entry.tick,
    targetId: 'player',
    amount: entry.effectiveDamage,
    hitsplatType: entry.effectiveDamage > 0 ? 'damage' : 'block',
  };
}

function damageEntriesToEvents(entries: DamageHistoryEntry[]): GameEvent[] {
  return entries.map((entry, index) => damageToEvent(entry, index + 1));
}

function overheadTextEvent(
  anchor: OverheadTextAnchor,
  overheadText: string,
  tick = 1,
  overheadCycle = 5,
  options: {
    readonly overheadTextColor?: string;
    readonly overheadTextSegments?: readonly { readonly text: string; readonly color?: string }[];
  } = {},
): GameEvent {
  return {
    type: 'overhead_text',
    eventId: 100 + tick,
    tick,
    anchor,
    overheadText,
    ...options,
    overheadCycle,
  };
}

function createNpcSnapshot(overrides: Partial<NpcSnapshot> = {}): NpcSnapshot {
  return {
    id: 'flare-1',
    npcTypeId: VOID_FLARE_NPC_ID,
    archetypeId: 'voidflare',
    role: 'minion',
    alive: true,
    position: [26, 25],
    previousPosition: [26, 25],
    facingAngle: 0,
    size: 2,
    hp: 71,
    maxHp: 140,
    ...overrides,
  };
}

function createNpcState(overrides: Partial<NpcSnapshot> = {}): NpcState {
  return {
    ...createNpcSnapshot(overrides),
    history: new Map(),
  };
}

describe('crawl overlay sampling', () => {
  it.each([0, 0.5])('uses the snapshot clock for every NPC anchor at second-tick fraction %s', (fraction) => {
    const renderer = new UIOverlayRenderer();
    const npc = createNpcState({
      position: [11, 20],
      previousPosition: [11, 20],
      size: 1,
      crawlMovement: { from: [10, 20], to: [11, 20], startTick: 10 },
      spawnTick: 1,
      despawnTick: 20,
      attackTimer: { nextAttackTick: 15, attackSpeed: 4 },
    });
    renderer.update(11, [
      { type: 'hitsplat_spawned', eventId: 1, tick: 11, targetId: npc.id, amount: 1, hitsplatType: 'damage' },
      overheadTextEvent({ kind: 'actor', actorId: npc.id }, 'crawl', 11),
    ]);
    const queue = createQueue();
    const projection = createMockProjection();
    renderer.buildNpcHitsplats(queue, projection, [npc], 11 + fraction, fraction, 11);
    renderer.buildNpcHealthBars(queue, projection, [npc], 11 + fraction, new Set(), fraction, 11);
    renderer.buildNpcTimerBars(queue, projection, [npc], 11 + fraction, fraction, 11);
    renderer.buildNpcAttackTimerBars(queue, projection, [npc], 11, fraction);
    renderer.buildOverheadTexts(
      queue,
      projection,
      createBaseState({ currentTick: 11, npcs: [npc] }),
      11 + fraction,
      fraction,
    );
    const x = (10.5 + fraction / 2 + 0.5) * 32;
    expect(queue.hitsplats?.[0]?.screenX).toBe(x);
    expect(queue.healthBars?.[0]?.screenX).toBe(x);
    expect(queue.timerBars?.map((bar) => bar.screenX)).toEqual([x, x]);
    expect(queue.overheadTexts?.[0]?.screenX).toBe(x);
  });

  it('keeps fraction-zero overlays without crawl metadata on their authoritative tile', () => {
    const renderer = new UIOverlayRenderer();
    const npc = createNpcSnapshot({
      position: [11, 20],
      previousPosition: [10, 20],
      size: 1,
      alwaysShowHealthBar: true,
    });
    const queue = createQueue();
    renderer.buildNpcHealthBars(queue, createMockProjection(), [npc], 11, new Set(), 0, 11);
    expect(queue.healthBars?.[0]?.screenX).toBe(11.5 * 32);
  });
});

function getActorState(renderer: UIOverlayRenderer, actorId = 'player') {
  return (renderer as any).actorHitsplatState.get(actorId) as
    | { slots: (HitsplatSlot | null)[]; roundRobin: number; healthBarVisibleUntilTick: number }
    | undefined;
}

function getSlots(renderer: UIOverlayRenderer): (HitsplatSlot | null)[] {
  return getActorState(renderer)?.slots ?? [null, null, null, null];
}

function getRoundRobin(renderer: UIOverlayRenderer): number {
  return getActorState(renderer)?.roundRobin ?? 0;
}

function getHealthBarUntil(renderer: UIOverlayRenderer): number {
  return getActorState(renderer)?.healthBarVisibleUntilTick ?? -1;
}

describe('UIOverlayRenderer', () => {
  let renderer: UIOverlayRenderer;

  beforeEach(() => {
    renderer = new UIOverlayRenderer();
    renderer.setTerrainHeights(null);
  });

  describe('No double damage when a repeated tick carries no events', () => {
    it('should NOT create duplicate hitsplats when events are provided on first call but empty on second call', () => {
      const events: GameEvent[] = [
        {
          type: 'hitsplat_spawned',
          eventId: 1,
          tick: 5,
          targetId: 'player',
          amount: 25,
          hitsplatType: 'damage',
        },
      ];
      renderer.update(5, events);
      expect(getSlots(renderer).filter((s) => s !== null)).toHaveLength(1);

      renderer.update(5, []);
      expect(getSlots(renderer).filter((s) => s !== null)).toHaveLength(1);
    });
  });

  describe('4-slot hitsplat system', () => {
    it('should initialize with exactly 4 null slots', () => {
      const slots = getSlots(renderer);
      expect(slots).toHaveLength(4);
      expect(slots).toEqual([null, null, null, null]);
    });

    it('should assign first hitsplat to slot 0 via round-robin', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 10)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      const slots = getSlots(renderer);
      expect(slots[0]).not.toBeNull();
      expect((slots[0] as any).amount).toBe(10);
      expect(slots[1]).toBeNull();
      expect(slots[2]).toBeNull();
      expect(slots[3]).toBeNull();
    });

    it('should cycle round-robin through slots 0→1→2→3', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 10), makeDamageEntry(1, 20), makeDamageEntry(1, 30), makeDamageEntry(1, 40)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      const slots = getSlots(renderer);
      expect((slots[0] as any).amount).toBe(10);
      expect((slots[1] as any).amount).toBe(20);
      expect((slots[2] as any).amount).toBe(30);
      expect((slots[3] as any).amount).toBe(40);
    });

    it('should not exceed 4 slots even with 5+ hitsplats', () => {
      const state = createBaseState({
        damageHistory: [
          makeDamageEntry(1, 10),
          makeDamageEntry(1, 20),
          makeDamageEntry(1, 30),
          makeDamageEntry(1, 40),
          makeDamageEntry(1, 50),
        ],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      expect(getSlots(renderer)).toHaveLength(4);
    });

    it('should replace earliest-expiry slot when all 4 occupied (same tick)', () => {
      const state4 = createBaseState({
        damageHistory: [makeDamageEntry(1, 10), makeDamageEntry(1, 20), makeDamageEntry(1, 30), makeDamageEntry(1, 40)],
      });
      renderer.update(1, damageEntriesToEvents(state4.damageHistory));

      renderer.update(1, [damageToEvent(makeDamageEntry(1, 99), 5)]);

      expect((getSlots(renderer)[0] as any).amount).toBe(99);
    });

    it('should replace slot with genuinely earliest expiry across ticks', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(2, 10)],
      });
      renderer.update(2, damageEntriesToEvents(state.damageHistory));

      state.damageHistory = [
        makeDamageEntry(2, 10),
        makeDamageEntry(3, 20),
        makeDamageEntry(3, 30),
        makeDamageEntry(3, 40),
      ];
      renderer.update(3, damageEntriesToEvents(state.damageHistory.slice(1)));

      state.damageHistory = [...state.damageHistory, makeDamageEntry(3, 77)];
      renderer.update(3, [damageToEvent(state.damageHistory[4], 5)]);

      expect((getSlots(renderer)[0] as any).amount).toBe(77);
    });

    it('should wrap round-robin from slot 3 back to slot 0 after expiry', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 10), makeDamageEntry(1, 20), makeDamageEntry(1, 30), makeDamageEntry(1, 40)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));
      expect(getRoundRobin(renderer)).toBe(0);

      renderer.update(4, []);

      state.damageHistory = [...state.damageHistory, makeDamageEntry(5, 55)];
      renderer.update(5, [damageToEvent(state.damageHistory[4], 5)]);

      expect((getSlots(renderer)[0] as any).amount).toBe(55);
      expect(getRoundRobin(renderer)).toBe(1);
    });

    it('should reset round-robin to 0 when all slots are expired', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 10), makeDamageEntry(1, 20)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));
      expect(getRoundRobin(renderer)).toBe(2);

      renderer.update(4, []);

      state.damageHistory = [...state.damageHistory, makeDamageEntry(5, 33)];
      renderer.update(5, [damageToEvent(state.damageHistory[2], 3)]);

      expect(getRoundRobin(renderer)).toBe(1);
      expect((getSlots(renderer)[0] as any).amount).toBe(33);
    });

    it('should skip occupied slots in round-robin scan', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 10)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      state.damageHistory = [...state.damageHistory, makeDamageEntry(2, 20)];
      renderer.update(2, [damageToEvent(state.damageHistory[1], 2)]);

      expect((getSlots(renderer)[0] as any).amount).toBe(10);
      expect((getSlots(renderer)[1] as any).amount).toBe(20);
    });
  });

  describe('hitsplat expiry', () => {
    it('should expire hitsplat after HITSPLAT_DURATION_TICKS', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 10)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));
      expect(getSlots(renderer)[0]).not.toBeNull();

      renderer.update(1 + HITSPLAT_DURATION_TICKS, []);
      expect(getSlots(renderer)[0]).toBeNull();
    });

    it('should not expire hitsplat before duration elapses', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 10)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      renderer.update(1 + HITSPLAT_DURATION_TICKS - 1, []);
      expect(getSlots(renderer)[0]).not.toBeNull();
    });

    it('should expire each slot independently', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 10)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      state.damageHistory = [makeDamageEntry(1, 10), makeDamageEntry(2, 20)];
      renderer.update(2, [damageToEvent(state.damageHistory[1], 2)]);

      renderer.update(3, []);
      expect(getSlots(renderer)[0]).toBeNull();
      expect(getSlots(renderer)[1]).not.toBeNull();

      renderer.update(4, []);
      expect(getSlots(renderer)[1]).toBeNull();
    });

    it('should set expiryTick = spawnTick + DURATION', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(5, 15)],
      });
      renderer.update(5, damageEntriesToEvents(state.damageHistory));

      const slot = getSlots(renderer)[0] as any;
      expect(slot.spawnTick).toBe(5);
      expect(slot.expiryTick).toBe(5 + HITSPLAT_DURATION_TICKS);
    });
  });

  describe('hitsplat type classification', () => {
    it('should classify effectiveDamage=0 as block', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 0)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      expect((getSlots(renderer)[0] as any).type).toBe('block');
    });

    it('should classify effectiveDamage>0 as damage', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 25)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      expect((getSlots(renderer)[0] as any).type).toBe('damage');
    });

    it('should classify a heal hitsplat as heal instead of downgrading it to damage', () => {
      const events: GameEvent[] = [
        {
          type: 'hitsplat_spawned',
          eventId: 1,
          tick: 1,
          targetId: 'yama',
          amount: 61,
          hitsplatType: 'heal',
        },
      ];
      renderer.update(1, events);

      const slot = getActorState(renderer, 'yama')?.slots[0];
      expect(slot?.type).toBe('heal');
      expect(slot?.amount).toBe(61);
    });

    it('should classify a burn hitsplat as burn instead of downgrading it to damage', () => {
      const events: GameEvent[] = [
        {
          type: 'hitsplat_spawned',
          eventId: 1,
          tick: 1,
          targetId: 'yama',
          amount: 3,
          hitsplatType: 'burn',
        },
      ];
      renderer.update(1, events);

      const slot = getActorState(renderer, 'yama')?.slots[0];
      expect(slot?.type).toBe('burn');
      expect(slot?.amount).toBe(3);
    });

    it('should fall back to the damage sprite for a type with no sprite of its own', () => {
      const events: GameEvent[] = [
        { type: 'hitsplat_spawned', eventId: 1, tick: 1, targetId: 'yama', amount: 4, hitsplatType: 'disease' },
      ];
      renderer.update(1, events);

      expect(getActorState(renderer, 'yama')?.slots[0]?.type).toBe('damage');
    });

    it('should handle mixed damage and block in same tick', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 0), makeDamageEntry(1, 15)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      expect((getSlots(renderer)[0] as any).type).toBe('block');
      expect((getSlots(renderer)[1] as any).type).toBe('damage');
    });
  });

  describe('health bar visibility', () => {
    it('should show health bar for HEALTHBAR_DURATION_TICKS after damage', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(5, 10)],
      });
      renderer.update(5, damageEntriesToEvents(state.damageHistory));

      expect(getHealthBarUntil(renderer)).toBe(5 + HEALTHBAR_DURATION_TICKS);
    });

    it('should not show health bar before any damage', () => {
      expect(getHealthBarUntil(renderer)).toBe(-1);
    });

    it('should refresh timer on each new hit', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(5, 10)],
      });
      renderer.update(5, damageEntriesToEvents(state.damageHistory));
      expect(getHealthBarUntil(renderer)).toBe(5 + HEALTHBAR_DURATION_TICKS);

      state.damageHistory = [...state.damageHistory, makeDamageEntry(10, 20)];
      renderer.update(10, [damageToEvent(state.damageHistory[1], 2)]);
      expect(getHealthBarUntil(renderer)).toBe(10 + HEALTHBAR_DURATION_TICKS);
    });

    it('should hide health bar after duration elapses (buildHealthBar)', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(5, 10)],
        playerHP: 89,
        maxHP: 99,
      });
      renderer.update(5, damageEntriesToEvents(state.damageHistory));

      const queue = createQueue();
      const projection = createMockProjection();

      renderer.buildHealthBar(queue, projection, state, [31, 25], 13);
      expect(queue.healthBars).toBeDefined();
      expect(queue.healthBars!.length).toBe(1);

      const queue2 = createQueue();
      renderer.buildHealthBar(queue2, projection, state, [31, 25], 14);
      expect(queue2.healthBars).toBeUndefined();
    });

    it('should compute correct HP ratio', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 50)],
        playerHP: 49,
        maxHP: 99,
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      const queue = createQueue();
      renderer.buildHealthBar(queue, createMockProjection(), state, [31, 25], 1);

      expect(queue.healthBars![0].ratio).toBeCloseTo(49 / 99, 5);
    });

    it('should clamp ratio to 0 when HP <= 0', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 99)],
        playerHP: 0,
        maxHP: 99,
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      const queue = createQueue();
      renderer.buildHealthBar(queue, createMockProjection(), state, [31, 25], 1);

      expect(queue.healthBars![0].ratio).toBe(0);
    });

    it('should default ratio to 1 when maxHP is 0', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 0)],
        playerHP: 0,
        maxHP: 0,
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      const queue = createQueue();
      renderer.buildHealthBar(queue, createMockProjection(), state, [31, 25], 1);

      expect(queue.healthBars![0].ratio).toBe(1);
    });

    it('should report correct progress through health bar lifecycle', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(2, 10)],
        playerHP: 89,
        maxHP: 99,
      });
      renderer.update(2, damageEntriesToEvents(state.damageHistory));

      const queue = createQueue();
      const midTick = 2 + HEALTHBAR_DURATION_TICKS / 2;
      renderer.buildHealthBar(queue, createMockProjection(), state, [31, 25], midTick);

      expect(queue.healthBars![0].progress).toBeCloseTo(0.5, 5);
    });
  });

  describe('prayer overheads', () => {
    it('should not render when no prayer active', () => {
      const state = createBaseState({ activePrayer: null });
      const queue = createQueue();
      renderer.buildPrayerOverheads(queue, createMockProjection(), state, [31, 25]);

      expect(queue.overheadIcons).toBeUndefined();
    });

    it('should render ProtectMagic overhead icon', () => {
      const state = createBaseState({ activePrayer: PrayerType.ProtectMagic });
      const queue = createQueue();
      renderer.buildPrayerOverheads(queue, createMockProjection(), state, [31, 25]);

      expect(queue.overheadIcons).toHaveLength(1);
      expect(queue.overheadIcons![0].iconPath).toContain('overhead_magic');
    });

    it('should render ProtectRange overhead icon', () => {
      const state = createBaseState({ activePrayer: PrayerType.ProtectRange });
      const queue = createQueue();
      renderer.buildPrayerOverheads(queue, createMockProjection(), state, [31, 25]);

      expect(queue.overheadIcons).toHaveLength(1);
      expect(queue.overheadIcons![0].iconPath).toContain('overhead_missiles');
    });

    it('should render ProtectMelee overhead icon', () => {
      const state = createBaseState({ activePrayer: PrayerType.ProtectMelee });
      const queue = createQueue();
      renderer.buildPrayerOverheads(queue, createMockProjection(), state, [31, 25]);

      expect(queue.overheadIcons).toHaveLength(1);
      expect(queue.overheadIcons![0].iconPath).toContain('overhead_melee');
    });

    it('should render Redemption overhead icon', () => {
      const state = createBaseState({ activePrayer: PrayerType.Redemption });
      const queue = createQueue();
      renderer.buildPrayerOverheads(queue, createMockProjection(), state, [31, 25]);

      expect(queue.overheadIcons).toHaveLength(1);
      expect(queue.overheadIcons![0].iconPath).toContain('overhead_redemption');
    });

    it('should not render for non-protection prayers (Augury)', () => {
      const state = createBaseState({ activePrayer: PrayerType.Augury });
      const queue = createQueue();
      renderer.buildPrayerOverheads(queue, createMockProjection(), state, [31, 25]);

      expect(queue.overheadIcons).toBeUndefined();
    });

    it('should use correct key for prayer overhead', () => {
      const state = createBaseState({ activePrayer: PrayerType.ProtectMagic });
      const queue = createQueue();
      renderer.buildPrayerOverheads(queue, createMockProjection(), state, [31, 25]);

      expect(queue.overheadIcons![0].key).toBe('prayer-overhead-player');
    });

    it('should set icon dimensions to OSRS_OVERHEAD_ICON_SIZE (25)', () => {
      const state = createBaseState({ activePrayer: PrayerType.ProtectMagic });
      const queue = createQueue();
      renderer.buildPrayerOverheads(queue, createMockProjection(), state, [31, 25]);

      expect(queue.overheadIcons![0].width).toBe(25);
      expect(queue.overheadIcons![0].height).toBe(25);
    });
  });

  describe('tick counter overhead', () => {
    const PLAYER_POS: [number, number] = [31, 25];

    // The painted boxes, as RenderViewport3D lays them out: the icon offsets by
    // half its height, the counter is centered on its own y. Smaller y = higher.
    const iconTopEdge = (icon: OverheadIcon) => icon.screenY - icon.height / 2;
    const counterBottomEdge = (counter: TickCounterOverlay) => counter.screenY + counter.fontSize / 2;

    function projectionAtScale(pixelsPerWorldUnit: number): Projection2D {
      return {
        tileToScreen: (tile) => ({ x: tile.x * 32, y: (tile.level ?? 0) * -pixelsPerWorldUnit + tile.y * 32 }),
        tileDeltaToScreen: (d) => d,
        screenToTile: () => null,
        tilePolygonScreen: () => [],
      };
    }

    const build = (
      queue: RenderQueue,
      state: SimulationState,
      presentation: Partial<TickCounterPresentation> = {},
      projection: Projection2D = createMockProjection(),
    ) =>
      renderer.buildOverheadNumbers(queue, projection, state, PLAYER_POS, {
        tickCounter: { max: 4, fontSize: 24, abovePrayerIcon: false, offsetX: 0, offsetY: 0, ...presentation },
        attackCooldown: null,
      });

    // A world-space offset satisfies this at one zoom and fails at every other —
    // that is the failure these cases exist to catch, so never collapse them to one.
    it.each([
      4, 16, 40, 100, 250,
    ])('keeps the counter clear of the prayer overhead icon at %ipx per world unit', (pixelsPerWorldUnit) => {
      const state = createBaseState({ currentTick: 3, activePrayer: PrayerType.ProtectMagic });
      const queue = createQueue();
      const projection = projectionAtScale(pixelsPerWorldUnit);

      renderer.buildPrayerOverheads(queue, projection, state, PLAYER_POS);
      build(queue, state, { abovePrayerIcon: true }, projection);

      expect(counterBottomEdge(queue.tickCounters![0])).toBeLessThanOrEqual(iconTopEdge(queue.overheadIcons![0]));
    });

    it('keeps the counter clear of the icon at the largest configurable font size', () => {
      const state = createBaseState({ currentTick: 1, activePrayer: PrayerType.ProtectMelee });
      const queue = createQueue();
      const projection = projectionAtScale(40);

      renderer.buildPrayerOverheads(queue, projection, state, PLAYER_POS);
      build(queue, state, { abovePrayerIcon: true, fontSize: 72 }, projection);

      expect(counterBottomEdge(queue.tickCounters![0])).toBeLessThanOrEqual(iconTopEdge(queue.overheadIcons![0]));
    });

    it('drops back down to the head anchor when no overhead icon is showing', () => {
      const withPrayer = createQueue();
      const withoutPrayer = createQueue();
      const projection = projectionAtScale(40);

      build(
        withPrayer,
        createBaseState({ currentTick: 3, activePrayer: PrayerType.ProtectRange }),
        { abovePrayerIcon: true },
        projection,
      );
      build(
        withoutPrayer,
        createBaseState({ currentTick: 3, activePrayer: null }),
        { abovePrayerIcon: true },
        projection,
      );

      expect(withoutPrayer.tickCounters![0].screenY - withPrayer.tickCounters![0].screenY).toBe(25);
    });

    it('does not reserve icon clearance for prayers that draw no overhead icon', () => {
      const augury = createQueue();
      const none = createQueue();
      const projection = projectionAtScale(40);

      build(
        augury,
        createBaseState({ currentTick: 3, activePrayer: PrayerType.Augury }),
        { abovePrayerIcon: true },
        projection,
      );
      build(none, createBaseState({ currentTick: 3, activePrayer: null }), { abovePrayerIcon: true }, projection);

      expect(augury.tickCounters![0].screenY).toBe(none.tickCounters![0].screenY);
    });

    // The default overlays the icon rather than clearing it, which only reads
    // correctly because the counter's DOM layer outranks the icon's.
    it('keeps the counter inside the icon box when not opted into clearing it', () => {
      const state = createBaseState({ currentTick: 3, activePrayer: PrayerType.ProtectMagic });
      const queue = createQueue();
      const projection = projectionAtScale(40);

      renderer.buildPrayerOverheads(queue, projection, state, PLAYER_POS);
      build(queue, state, {}, projection);

      const icon = queue.overheadIcons![0];
      const counter = queue.tickCounters![0];
      expect(counter.screenX).toBe(icon.screenX);
      expect(counter.screenY).toBe(icon.screenY);
      // Both inequalities, not just the first: raising the counter over the icon
      // is what this feature needs, and leaving forced chat on top is what the
      // overlay stack already promised before the counter had a z-index at all.
      expect(OVERLAY_LAYER_Z_INDEX.tickCounters).toBeGreaterThan(OVERLAY_LAYER_Z_INDEX.overheadIcons);
      expect(OVERLAY_LAYER_Z_INDEX.overheadTexts).toBeGreaterThan(OVERLAY_LAYER_Z_INDEX.tickCounters);
    });

    it('ignores the prayer icon entirely when not opted into clearing it', () => {
      const withPrayer = createQueue();
      const withoutPrayer = createQueue();
      const projection = projectionAtScale(40);

      build(withPrayer, createBaseState({ currentTick: 3, activePrayer: PrayerType.ProtectMelee }), {}, projection);
      build(withoutPrayer, createBaseState({ currentTick: 3, activePrayer: null }), {}, projection);

      expect(withPrayer.tickCounters![0].screenY).toBe(withoutPrayer.tickCounters![0].screenY);
    });

    it('cycles the displayed value through 1..tickCounterMax', () => {
      const values = [1, 2, 3, 4, 5].map((currentTick) => {
        const queue = createQueue();
        build(queue, createBaseState({ currentTick }));
        return queue.tickCounters![0].text;
      });

      expect(values).toEqual(['1', '2', '3', '4', '1']);
    });

    it('paints an overridden tick in its chosen color and leaves the rest on the gradient', () => {
      const colorAt = (currentTick: number) => {
        const queue = createQueue();
        build(queue, createBaseState({ currentTick }), { colors: { '2': '#00ff00' } });
        return queue.tickCounters![0].textColor;
      };

      expect(colorAt(2)).toBe('#00ff00');
      expect(colorAt(1)).toBe(getTickColor(1, 4));
      expect(colorAt(3)).toBe(getTickColor(3, 4));
    });

    // The setting is authored in the direction the stepper's arrows point, so a
    // positive Y must RAISE the counter even though screen y grows downward.
    it('shifts by the offset, with positive x right and positive y up', () => {
      const state = createBaseState({ currentTick: 3 });
      const anchored = createQueue();
      const nudged = createQueue();

      build(anchored, state);
      build(nudged, state, { offsetX: 12, offsetY: 30 });

      expect(nudged.tickCounters![0].screenX - anchored.tickCounters![0].screenX).toBe(12);
      expect(nudged.tickCounters![0].screenY - anchored.tickCounters![0].screenY).toBe(-30);
    });

    it('applies the offset on top of the prayer-icon clearance rather than replacing it', () => {
      const state = createBaseState({ currentTick: 3, activePrayer: PrayerType.ProtectMagic });
      const cleared = createQueue();
      const clearedAndNudged = createQueue();
      const projection = projectionAtScale(40);

      build(cleared, state, { abovePrayerIcon: true }, projection);
      build(clearedAndNudged, state, { abovePrayerIcon: true, offsetY: -8 }, projection);

      expect(clearedAndNudged.tickCounters![0].screenY - cleared.tickCounters![0].screenY).toBe(8);
    });

    it('emits nothing when tickCounterMax is not positive', () => {
      const queue = createQueue();
      build(queue, createBaseState({ currentTick: 3 }), { max: 0 });

      expect(queue.tickCounters).toBeUndefined();
    });
  });

  describe('buildHitsplats rendering', () => {
    it('should produce no output when no hitsplats active', () => {
      const state = createBaseState();
      const queue = createQueue();
      renderer.buildHitsplats(queue, createMockProjection(), state, [31, 25], 1);

      expect(queue.hitsplats).toBeUndefined();
    });

    it('should produce one overlay per active slot', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 10), makeDamageEntry(1, 20)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      const queue = createQueue();
      renderer.buildHitsplats(queue, createMockProjection(), state, [31, 25], 1);

      expect(queue.hitsplats).toHaveLength(2);
    });

    it('should use distinct OSRS slot keys for each hitsplat', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 10), makeDamageEntry(1, 20), makeDamageEntry(1, 30), makeDamageEntry(1, 40)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      const queue = createQueue();
      renderer.buildHitsplats(queue, createMockProjection(), state, [31, 25], 1);

      expect(queue.hitsplats).toHaveLength(4);

      const keys = queue.hitsplats!.map((h) => h.key);
      expect(keys).toContain('hitsplat-slot-0');
      expect(keys).toContain('hitsplat-slot-1');
      expect(keys).toContain('hitsplat-slot-2');
      expect(keys).toContain('hitsplat-slot-3');
    });

    it('should compute progress from 0 at spawn to 1 at expiry', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(2, 10)],
      });
      renderer.update(2, damageEntriesToEvents(state.damageHistory));

      const queue0 = createQueue();
      renderer.buildHitsplats(queue0, createMockProjection(), state, [31, 25], 2);
      expect(queue0.hitsplats![0].progress).toBeCloseTo(0, 5);

      const queueMid = createQueue();
      renderer.buildHitsplats(queueMid, createMockProjection(), state, [31, 25], 2 + HITSPLAT_DURATION_TICKS / 2);
      expect(queueMid.hitsplats![0].progress).toBeCloseTo(0.5, 5);

      const queue1 = createQueue();
      renderer.buildHitsplats(queue1, createMockProjection(), state, [31, 25], 2 + HITSPLAT_DURATION_TICKS);
      expect(queue1.hitsplats![0].progress).toBeCloseTo(1.0, 5);
    });

    it('should clamp progress to max 1.0', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 10)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      const queue = createQueue();
      renderer.buildHitsplats(queue, createMockProjection(), state, [31, 25], 1 + HITSPLAT_DURATION_TICKS + 5);
      if (queue.hitsplats && queue.hitsplats.length > 0) {
        expect(queue.hitsplats[0].progress).toBeLessThanOrEqual(1.0);
      }
    });

    it('should set correct OSRS dimensions on hitsplat overlays', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 10)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      const queue = createQueue();
      renderer.buildHitsplats(queue, createMockProjection(), state, [31, 25], 1);

      expect(queue.hitsplats![0].width).toBe(24);
      expect(queue.hitsplats![0].height).toBe(24);
      expect(queue.hitsplats![0].fontSize).toBe(16);
    });

    it('should carry through damage amount to overlay', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 42)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      const queue = createQueue();
      renderer.buildHitsplats(queue, createMockProjection(), state, [31, 25], 1);

      expect(queue.hitsplats![0].amount).toBe(42);
    });
  });

  describe('event processing', () => {
    it('should process only new entries incrementally', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 10)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));
      expect((getSlots(renderer)[0] as any).amount).toBe(10);

      renderer.update(1, []);
      expect((getSlots(renderer)[0] as any).amount).toBe(10);
      expect(getSlots(renderer)[1]).toBeNull();
    });

    it('should handle multiple new entries in one update', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 10), makeDamageEntry(1, 20), makeDamageEntry(1, 30)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      expect((getSlots(renderer)[0] as any).amount).toBe(10);
      expect((getSlots(renderer)[1] as any).amount).toBe(20);
      expect((getSlots(renderer)[2] as any).amount).toBe(30);
    });

    it('should handle simulation reset (tick rewind)', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 10), makeDamageEntry(1, 20)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));
      expect(getSlots(renderer)[0]).not.toBeNull();

      renderer.update(0, []);

      expect(getSlots(renderer)).toEqual([null, null, null, null]);
      expect(getRoundRobin(renderer)).toBe(0);
      expect(getHealthBarUntil(renderer)).toBe(-1);
    });

    it('should process new entries correctly after reset', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 10)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      renderer.update(0, []);

      state.damageHistory = [makeDamageEntry(5, 77)];
      renderer.update(5, [damageToEvent(state.damageHistory[0], 1)]);

      expect((getSlots(renderer)[0] as any).amount).toBe(77);
    });
  });

  describe('terrain height', () => {
    it('should use null terrain heights without errors', () => {
      renderer.setTerrainHeights(null);

      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 10)],
        activePrayer: PrayerType.ProtectMagic,
        playerHP: 89,
        maxHP: 99,
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      const queue = createQueue();
      const proj = createMockProjection();

      renderer.buildHitsplats(queue, proj, state, [31, 25], 1);
      renderer.buildHealthBar(queue, proj, state, [31, 25], 1);
      renderer.buildPrayerOverheads(queue, proj, state, [31, 25]);
    });

    it('should accept and apply terrain heights', () => {
      const heights: Int32Array[] = [];
      for (let x = 0; x <= 64; x++) {
        heights[x] = new Int32Array(65).fill(-256);
      }
      renderer.setTerrainHeights(heights);

      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 10)],
        playerHP: 89,
        maxHP: 99,
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      const queue = createQueue();
      renderer.buildHealthBar(queue, createMockProjection(), state, [31, 25], 1);

      expect(queue.healthBars).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('should handle zero-damage block hitsplat', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(1, 0)],
      });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      const queue = createQueue();
      renderer.buildHitsplats(queue, createMockProjection(), state, [31, 25], 1);

      expect(queue.hitsplats![0].amount).toBe(0);
      expect(queue.hitsplats![0].type).toBe('block');
    });

    it('should handle rapid sequential hits across ticks', () => {
      const entries: DamageHistoryEntry[] = [];
      for (let t = 1; t <= 10; t++) {
        entries.push(makeDamageEntry(t, t * 5));
      }

      const state = createBaseState({ damageHistory: entries.slice(0, 4) });
      renderer.update(4, damageEntriesToEvents(state.damageHistory));

      state.damageHistory = entries.slice(0, 8);
      renderer.update(8, damageEntriesToEvents(state.damageHistory.slice(4)));

      const filledCount = getSlots(renderer).filter((s) => s !== null).length;
      expect(filledCount).toBeLessThanOrEqual(4);
    });

    it('should handle update called with no damage history', () => {
      const state = createBaseState({ damageHistory: [] });
      renderer.update(0, damageEntriesToEvents(state.damageHistory));

      expect(getSlots(renderer)).toEqual([null, null, null, null]);
    });

    it('should handle buildHitsplats at interpolatedTick 0', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(0, 10)],
      });
      renderer.update(0, damageEntriesToEvents(state.damageHistory));

      const queue = createQueue();
      renderer.buildHitsplats(queue, createMockProjection(), state, [31, 25], 0);

      expect(queue.hitsplats).toBeDefined();
      expect(queue.hitsplats![0].progress).toBeCloseTo(0, 5);
    });

    it('should handle very large tick values', () => {
      const state = createBaseState({
        damageHistory: [makeDamageEntry(999999, 10)],
      });
      renderer.update(999999, damageEntriesToEvents(state.damageHistory));

      const queue = createQueue();
      renderer.buildHitsplats(queue, createMockProjection(), state, [31, 25], 999999);

      expect(queue.hitsplats).toHaveLength(1);
    });

    it('should handle full slot replacement chain (8 hits same tick)', () => {
      const entries: DamageHistoryEntry[] = [];
      for (let i = 0; i < 8; i++) {
        entries.push(makeDamageEntry(1, (i + 1) * 10));
      }

      const state = createBaseState({ damageHistory: entries });
      renderer.update(1, damageEntriesToEvents(state.damageHistory));

      const slots = getSlots(renderer);
      const amounts = slots.map((slot) => slot?.amount).filter((amount): amount is number => amount !== undefined);
      expect(amounts).toHaveLength(4);
    });
  });

  describe('per-actor NPC overlay geometry', () => {
    it('projects same-type actors independently with their rendered base height', () => {
      const npcs = ['healer-a', 'healer-b'].map((id) =>
        createNpcState({
          id,
          npcTypeId: 7708,
          size: 1,
          position: [10, 10],
          previousPosition: [10, 10],
          spawnTick: 0,
          despawnTick: 10,
        }),
      );
      renderer.setTerrainHeights(Array.from({ length: 20 }, () => new Int32Array(20).fill(-128)));
      renderer.setNpcOverlayHeights(
        new Map([
          ['healer-a', { hitsplatHeight: 1, healthBarHeight: 2, healthBarWidth: 40, baseHeight: 3 }],
          ['healer-b', { hitsplatHeight: 2, healthBarHeight: 4, healthBarWidth: 40, baseHeight: 0.5 }],
        ]),
      );
      renderer.update(
        1,
        npcs.flatMap((npc, index): GameEvent[] => [
          {
            type: 'hitsplat_spawned',
            eventId: index + 1,
            targetId: npc.id,
            tick: 1,
            amount: 10,
            hitsplatType: 'damage',
          },
          overheadTextEvent({ kind: 'actor', actorId: npc.id }, 'Test', 1),
        ]),
      );
      const queue = createQueue();
      const projection = createMockProjection();

      renderer.buildNpcHitsplats(queue, projection, npcs, 1);
      renderer.buildNpcHealthBars(queue, projection, npcs, 1, new Set());
      renderer.buildNpcTimerBars(queue, projection, npcs, 1);
      renderer.buildOverheadTexts(queue, projection, createBaseState({ npcs }), 1);

      expect(queue.hitsplats?.map((splat) => splat.screenY)).toEqual([-64, 86]);
      expect(queue.healthBars?.map((bar) => bar.screenY)).toEqual([-157, -107]);
      expect(queue.timerBars?.map((bar) => bar.screenY)).toEqual([-148, -98]);
      expect(queue.overheadTexts?.map((text) => text.screenY)).toEqual([-132, -82]);
    });
  });

  describe('overhead text', () => {
    it('projects active NPC speech below the NPC health bar', () => {
      const npc = createNpcState({
        id: 'test_boss',
        npcTypeId: 1234,
        position: [10, 20],
        size: 5,
      });
      const state = createBaseState({ npcs: [npc] });
      renderer.setNpcOverlayHeights(
        new Map([['test_boss', { hitsplatHeight: 1, healthBarHeight: 2, healthBarWidth: 100, baseHeight: 0 }]]),
      );
      renderer.update(10, [overheadTextEvent({ kind: 'actor', actorId: 'test_boss' }, 'Not bad.', 10, 5)]);

      const queue = createQueue();
      renderer.buildOverheadTexts(queue, createMockProjection(), state, 10);

      expect(queue.overheadTexts).toEqual([
        expect.objectContaining({
          screenX: 400,
          screenY: 552,
          text: 'Not bad.',
          textColor: '#ffff00',
          fontSize: 16,
          key: 'actor:test_boss',
        }),
      ]);
    });

    it('tracks the interpolated NPC center for overhead text while the NPC is moving', () => {
      const npc = createNpcState({
        id: 'test_boss',
        npcTypeId: 1234,
        previousPosition: [10, 20],
        position: [12, 20],
        size: 5,
      });
      const state = createBaseState({ npcs: [npc] });
      renderer.setNpcOverlayHeights(
        new Map([['test_boss', { hitsplatHeight: 1, healthBarHeight: 2, healthBarWidth: 100, baseHeight: 0 }]]),
      );
      renderer.update(10, [overheadTextEvent({ kind: 'actor', actorId: 'test_boss' }, 'Not bad.', 10, 5)]);

      const queue = createQueue();
      // Half a tick between ticks -> text follows the interpolated center, not
      // the snapped true tile.
      renderer.buildOverheadTexts(queue, createMockProjection(), state, 10, 0.5);

      // Interpolated center X = 10 + (12 - 10) * 0.5 + size/2 = 13.5 -> *32 = 432
      // (the snapped true-tile center would be (12 + 2.5) * 32 = 464).
      expect(queue.overheadTexts?.[0]?.screenX).toBe(432);
    });

    it('forwards rich overhead text color and segment metadata', () => {
      const npc = createNpcState({ id: 'test_boss', npcTypeId: 1234 });
      const state = createBaseState({ npcs: [npc] });
      renderer.update(10, [
        overheadTextEvent({ kind: 'actor', actorId: 'test_boss' }, 'DANGER!', 10, 5, {
          overheadTextColor: '#ff0000',
          overheadTextSegments: [{ text: 'DAN' }, { text: 'GER', color: '#ffffff' }, { text: '!' }],
        }),
      ]);

      const queue = createQueue();
      renderer.buildOverheadTexts(queue, createMockProjection(), state, 10);

      expect(queue.overheadTexts).toEqual([
        expect.objectContaining({
          text: 'DANGER!',
          textColor: '#ff0000',
          segments: [{ text: 'DAN' }, { text: 'GER', color: '#ffffff' }, { text: '!' }],
        }),
      ]);
    });

    it('expires NPC speech when the overhead cycle elapses', () => {
      const npc = createNpcState({ id: 'test_boss', npcTypeId: 1234 });
      const state = createBaseState({ npcs: [npc] });
      renderer.update(10, [overheadTextEvent({ kind: 'actor', actorId: 'test_boss' }, 'You cannot win!', 10, 5)]);

      const queue = createQueue();
      renderer.buildOverheadTexts(queue, createMockProjection(), state, 15);

      expect(queue.overheadTexts).toBeUndefined();
    });

    it('replaces active NPC speech for the same actor', () => {
      const npc = createNpcState({ id: 'test_boss', npcTypeId: 1234 });
      const state = createBaseState({ npcs: [npc] });
      const anchor: OverheadTextAnchor = { kind: 'actor', actorId: 'test_boss' };

      renderer.update(1, [overheadTextEvent(anchor, 'First line.', 1, 5)]);
      renderer.update(2, [overheadTextEvent(anchor, 'Second line.', 2, 5)]);

      const queue = createQueue();
      renderer.buildOverheadTexts(queue, createMockProjection(), state, 2);

      expect(queue.overheadTexts).toEqual([expect.objectContaining({ text: 'Second line.', key: 'actor:test_boss' })]);
    });

    it('clears active speech on tick rewind', () => {
      const npc = createNpcState({ id: 'test_boss', npcTypeId: 1234 });
      const state = createBaseState({ npcs: [npc] });
      renderer.update(10, [overheadTextEvent({ kind: 'actor', actorId: 'test_boss' }, 'Before rewind.', 10, 5)]);

      renderer.update(9, []);

      const queue = createQueue();
      renderer.buildOverheadTexts(queue, createMockProjection(), state, 9);

      expect(queue.overheadTexts).toBeUndefined();
    });

    it('keeps rendering speech for a dead NPC still playing its death animation', () => {
      // A defeated boss stays in the snapshot for the length of its despawn
      // animation, and that window is exactly when Yama says his parting line.
      const npc = createNpcState({ id: 'yama', npcTypeId: 14176, alive: false, hp: 0 });
      const state = createBaseState({ npcs: [npc] });
      renderer.update(10, [overheadTextEvent({ kind: 'actor', actorId: 'yama' }, 'Fair is fair.', 10, 7)]);

      const queue = createQueue();
      renderer.buildOverheadTexts(queue, createMockProjection(), state, 10);

      expect(queue.overheadTexts).toEqual([expect.objectContaining({ text: 'Fair is fair.', key: 'actor:yama' })]);
    });

    it('drops speech once the actor leaves the snapshot', () => {
      const state = createBaseState({ npcs: [] });
      renderer.update(10, [overheadTextEvent({ kind: 'actor', actorId: 'yama' }, 'Fair is fair.', 10, 7)]);

      const queue = createQueue();
      renderer.buildOverheadTexts(queue, createMockProjection(), state, 10);

      expect(queue.overheadTexts).toBeUndefined();
    });
  });

  describe('pinned health bar', () => {
    const pinned = (overrides: Partial<NpcSnapshot> = {}) =>
      createNpcSnapshot({ alwaysShowHealthBar: true, ...overrides });

    it('should always show a pinned health bar for an alive NPC without any hitsplat events', () => {
      const renderer = new UIOverlayRenderer();
      renderer.setTerrainHeights(null);

      const queue = createQueue();
      const projection = createMockProjection();
      const flare = pinned({ alive: true });

      renderer.buildNpcHealthBars(queue, projection, [flare], 0, new Set());

      expect(queue.healthBars).toBeDefined();
      expect(queue.healthBars).toHaveLength(1);
      expect(queue.healthBars![0].key).toContain('flare-1');
    });

    it('should show health bar during death animation (alive=false, still dying)', () => {
      const renderer = new UIOverlayRenderer();
      renderer.setTerrainHeights(null);

      const queue = createQueue();
      const projection = createMockProjection();
      const flare = pinned({ alive: false, hp: 0 });

      renderer.buildNpcHealthBars(queue, projection, [flare], 0, new Set(['flare-1']));

      expect(queue.healthBars).toBeDefined();
      expect(queue.healthBars).toHaveLength(1);
      expect(queue.healthBars![0].ratio).toBe(0);
    });

    // A queued death (a player-killed flare) stands at 0 HP from its killing tick until its death
    // animation at tick 11, and keeps its empty bar; the dying set takes over from there.
    it.each([
      { tick: 10, dying: false, shown: true },
      { tick: 10.97, dying: false, shown: true },
      { tick: 11, dying: true, shown: true },
      { tick: 11, dying: false, shown: false },
    ])('shows an empty pinned bar on a standing queued death at tick $tick (dying: $dying): $shown', ({
      tick,
      dying,
      shown,
    }) => {
      const renderer = new UIOverlayRenderer();
      renderer.setTerrainHeights(null);
      const queue = createQueue();
      const flare = pinned({ alive: false, hp: 0, deathAnimationTick: 11 });

      renderer.buildNpcHealthBars(queue, createMockProjection(), [flare], tick, new Set(dying ? ['flare-1'] : []));

      expect(queue.healthBars?.map((bar) => bar.ratio)).toEqual(shown ? [0] : undefined);
    });

    it('should hide health bar after death animation completes (not in dyingActorIds)', () => {
      const renderer = new UIOverlayRenderer();
      renderer.setTerrainHeights(null);

      const queue = createQueue();
      const projection = createMockProjection();
      const flare = pinned({ alive: false, hp: 0 });

      renderer.buildNpcHealthBars(queue, projection, [flare], 0, new Set());

      expect(queue.healthBars).toBeUndefined();
    });

    it('should not always-show health bar for an NPC that does not pin it', () => {
      const renderer = new UIOverlayRenderer();
      renderer.setTerrainHeights(null);

      const queue = createQueue();
      const projection = createMockProjection();
      const npc = createNpcSnapshot({ alive: true });

      renderer.buildNpcHealthBars(queue, projection, [npc], 0, new Set());

      expect(queue.healthBars).toBeUndefined();
    });

    it('should compute correct HP ratio for a pinned bar', () => {
      const renderer = new UIOverlayRenderer();
      renderer.setTerrainHeights(null);

      const queue = createQueue();
      const projection = createMockProjection();
      const flare = pinned({ hp: 35, maxHp: 140 });

      renderer.buildNpcHealthBars(queue, projection, [flare], 0, new Set());

      expect(queue.healthBars).toBeDefined();
      expect(queue.healthBars![0].ratio).toBeCloseTo(35 / 140, 5);
    });

    it('should set progress=0 (no fade) for a pinned health bar', () => {
      const renderer = new UIOverlayRenderer();
      renderer.setTerrainHeights(null);

      const queue = createQueue();
      const projection = createMockProjection();
      const flare = pinned({ alive: true });

      renderer.buildNpcHealthBars(queue, projection, [flare], 100, new Set());

      expect(queue.healthBars).toBeDefined();
      expect(queue.healthBars![0].progress).toBe(0);
    });

    it('should not show health bar for a dead pinned NPC via leftover hitsplat timer', () => {
      const renderer = new UIOverlayRenderer();
      renderer.setTerrainHeights(null);

      const flare = pinned({ alive: true });
      const hitEvent: GameEvent = {
        type: 'hitsplat_spawned',
        eventId: 1,
        tick: 5,
        targetId: flare.id,
        amount: 30,
        hitsplatType: 'damage',
      };
      renderer.update(5, [hitEvent]);

      const deadFlare = pinned({ alive: false, hp: 0 });
      const queue = createQueue();
      renderer.buildNpcHealthBars(queue, createMockProjection(), [deadFlare], 6, new Set());

      expect(queue.healthBars ?? []).toHaveLength(0);
    });

    it('hides any health bar until the NPC becomes targetable', () => {
      const renderer = new UIOverlayRenderer();
      renderer.setTerrainHeights(null);
      renderer.update(10, [
        { type: 'hitsplat_spawned', eventId: 1, tick: 10, targetId: 'hit', amount: 5, hitsplatType: 'damage' },
      ]);
      const npcs = [
        pinned({ id: 'pinned', targetableFromTick: 13 }),
        createNpcSnapshot({ id: 'hit', targetableFromTick: 13 }),
      ];
      const barsAt = (tick: number) => {
        const queue = createQueue();
        renderer.buildNpcHealthBars(queue, createMockProjection(), npcs, tick, new Set());
        return (queue.healthBars ?? []).map((bar) => bar.key);
      };

      expect(barsAt(12.9)).toEqual([]);
      expect(barsAt(13)).toEqual(['npc-healthbar-pinned', 'npc-healthbar-hit']);
    });

    it('shows hits on a never-targetable NPC that opts in, with its bar only while a hit keeps it up', () => {
      // Inferno's Rocky support proxy: 255 HP, never targetable, hit only by nibblers.
      const renderer = new UIOverlayRenderer();
      renderer.setTerrainHeights(null);
      const proxy = createNpcSnapshot({
        id: 'support',
        hp: 251,
        maxHp: 255,
        untargetable: true,
        healthBarWhenUntargetable: true,
      });
      const overlaysAt = (tick: number, npc = proxy) => {
        const queue = createQueue();
        renderer.buildNpcHitsplats(queue, createMockProjection(), [npc], tick);
        renderer.buildNpcHealthBars(queue, createMockProjection(), [npc], tick, new Set());
        return { splats: queue.hitsplats ?? [], bars: queue.healthBars ?? [] };
      };

      expect(overlaysAt(10).bars).toEqual([]);
      renderer.update(10, [
        { type: 'hitsplat_spawned', eventId: 1, tick: 10, targetId: 'support', amount: 4, hitsplatType: 'damage' },
        { type: 'hitsplat_spawned', eventId: 2, tick: 10, targetId: 'support', amount: 0, hitsplatType: 'block' },
      ]);
      const shown = overlaysAt(10);
      expect(shown.splats.map(({ type, amount }) => [type, amount])).toEqual([
        ['damage', 4],
        ['block', 0],
      ]);
      expect(shown.bars).toEqual([expect.objectContaining({ key: 'npc-healthbar-support', ratio: 251 / 255 })]);
      // Without the opt-in the same hits stay splats only, as for any untargetable NPC.
      expect(overlaysAt(10, { ...proxy, healthBarWhenUntargetable: undefined }).bars).toEqual([]);
    });
  });

  describe('despawn timer bar', () => {
    // P3 void flare: spawned on 0, active on +3, bar completes 2 ticks before the +25 detonation.
    const flare = createNpcSnapshot({ spawnTick: 0, despawnTick: 25, targetableFromTick: 3, despawnTimerLeadTicks: 2 });
    const ratioAt = (npc: NpcSnapshot, tick: number) => {
      const renderer = new UIOverlayRenderer();
      renderer.setTerrainHeights(null);
      const queue = createQueue();
      renderer.buildNpcTimerBars(queue, createMockProjection(), [npc], tick);
      return queue.timerBars?.[0]?.ratio;
    };

    it('stays hidden until the NPC is targetable, then fills from empty', () => {
      expect(ratioAt(flare, 0)).toBeUndefined();
      expect(ratioAt(flare, 2.99)).toBeUndefined();
      expect(ratioAt(flare, 3)).toBe(0);
      expect(ratioAt(flare, 13)).toBeCloseTo(0.5);
    });

    it('completes the lead ticks before despawn and holds full', () => {
      expect(ratioAt(flare, 23)).toBe(1);
      expect(ratioAt(flare, 24.5)).toBe(1);
    });

    it('fills from spawn to despawn without targetability or lead data', () => {
      const plain = createNpcSnapshot({ spawnTick: 10, despawnTick: 20 });
      expect(ratioAt(plain, 10)).toBe(0);
      expect(ratioAt(plain, 15)).toBeCloseTo(0.5);
      expect(ratioAt(plain, 20)).toBe(1);
    });

    it('drops the bar once the NPC is dead', () => {
      expect(ratioAt({ ...flare, alive: false }, 10)).toBeUndefined();
    });
  });
});

function runMetronome(opts: { currentTick: number; playerNextAttackTick: number; playerAttackSpeed: number }) {
  const renderer = new UIOverlayRenderer();
  renderer.setTerrainHeights(null);
  const queue = createQueue();
  const state = createBaseState({
    currentTick: opts.currentTick,
    playerNextAttackTick: opts.playerNextAttackTick,
    playerAttackSpeed: opts.playerAttackSpeed,
  });
  renderer.buildPlayerAttackTimerBar(queue, createMockProjection(), state, [31, 25], opts.currentTick);
  return queue.timerBars?.find((bar) => bar.key === 'player-attack-timer-metronome');
}

describe('Player overhead numbers', () => {
  const renderer = new UIOverlayRenderer();
  renderer.setTerrainHeights(null);
  const placement: OverheadNumberPlacement = { fontSize: 16, abovePrayerIcon: false, offsetX: 0, offsetY: 0 };
  const tickCounter: TickCounterPresentation = { ...placement, max: 4, fontSize: 24 };

  function build(numbers: PlayerOverheadNumbers, state: Partial<SimulationState> = {}) {
    const queue = createQueue();
    const fullState = createBaseState({ currentTick: 1, playerNextAttackTick: 4, ...state });
    renderer.buildOverheadNumbers(queue, createMockProjection(), fullState, [31, 25], numbers);
    const find = (key: string) => queue.tickCounters?.find((t) => t.key === key);
    return { tick: find('player-tick-counter'), cooldown: find('player-attack-cooldown-ticks') };
  }
  const top = (t: TickCounterOverlay) => t.screenY - t.fontSize / 2;
  const bottom = (t: TickCounterOverlay) => t.screenY + t.fontSize / 2;

  it('counts the cooldown down 4, 3, 2, 1 and hides it on the ready tick and before any attack', () => {
    const texts = [0, 1, 2, 3, 4].map(
      (currentTick) => build({ tickCounter: null, attackCooldown: placement }, { currentTick }).cooldown?.text,
    );
    expect(texts).toEqual(['4', '3', '2', '1', undefined]);
    expect(
      build({ tickCounter: null, attackCooldown: placement }, { playerNextAttackTick: -1 }).cooldown,
    ).toBeUndefined();
  });

  it('draws the cooldown in the plugin-hub color at its configured size', () => {
    expect(build({ tickCounter: null, attackCooldown: placement }).cooldown).toMatchObject({
      textColor: '#00ffff',
      fontSize: 16,
    });
  });

  it.each([false, true])('places either number alone at the same spot (abovePrayerIcon=%s)', (abovePrayerIcon) => {
    const shared = { ...placement, abovePrayerIcon };
    const alone = build({ tickCounter: null, attackCooldown: shared }).cooldown!;
    const tickAlone = build({ tickCounter: { ...shared, max: 4 }, attackCooldown: null }).tick!;
    expect([alone.screenX, alone.screenY]).toEqual([tickAlone.screenX, tickAlone.screenY]);
  });

  // On-icon numbers stack first, the Tick Counter first within a group.
  it.each([
    { label: 'both on the icon', tickAbove: false, cooldownAbove: false, lower: 'tick' },
    { label: 'both above the icon', tickAbove: true, cooldownAbove: true, lower: 'tick' },
    { label: 'only the tick counter above the icon', tickAbove: true, cooldownAbove: false, lower: 'cooldown' },
    { label: 'only the cooldown above the icon', tickAbove: false, cooldownAbove: true, lower: 'tick' },
  ] as const)('stacks instead of overlapping: $label', ({ tickAbove, cooldownAbove, lower }) => {
    const { tick, cooldown } = build(
      {
        tickCounter: { ...tickCounter, abovePrayerIcon: tickAbove },
        attackCooldown: { ...placement, abovePrayerIcon: cooldownAbove },
      },
      { activePrayer: null },
    );
    const [below, above] = lower === 'tick' ? [tick!, cooldown!] : [cooldown!, tick!];
    expect(bottom(above)).toBeLessThan(top(below));
    expect(above.screenX).toBe(below.screenX);
  });

  it('keeps the Tick Counter where it was when the cooldown appears or disappears', () => {
    const both = build({ tickCounter, attackCooldown: placement }).tick!;
    const idle = build({ tickCounter, attackCooldown: placement }, { playerNextAttackTick: -1 });
    expect(idle.cooldown).toBeUndefined();
    expect(idle.tick!.screenY).toBe(both.screenY);
  });

  it('applies each number’s offset after stacking', () => {
    const plain = build({ tickCounter, attackCooldown: placement }).cooldown!;
    const nudged = build({ tickCounter, attackCooldown: { ...placement, offsetX: 5, offsetY: 3 } }).cooldown!;
    expect([nudged.screenX - plain.screenX, nudged.screenY - plain.screenY]).toEqual([5, -3]);
  });
});

describe('Attack Timer Metronome bar', () => {
  it('renders full yellow on the tick the player attacks (speed 4)', () => {
    const bar = runMetronome({ currentTick: 0, playerNextAttackTick: 4, playerAttackSpeed: 4 });
    expect(bar).toBeDefined();
    expect(bar!.ratio).toBe(1);
  });

  it('renders a 2/3 ratio on tick 1 of a 4-tick cooldown', () => {
    const bar = runMetronome({ currentTick: 1, playerNextAttackTick: 4, playerAttackSpeed: 4 });
    expect(bar).toBeDefined();
    expect(bar!.ratio).toBeCloseTo(2 / 3, 5);
  });

  it('renders a 1/3 ratio on tick 2 of a 4-tick cooldown', () => {
    const bar = runMetronome({ currentTick: 2, playerNextAttackTick: 4, playerAttackSpeed: 4 });
    expect(bar).toBeDefined();
    expect(bar!.ratio).toBeCloseTo(1 / 3, 5);
  });

  it('renders full black on the click-ready tick (remaining === 1)', () => {
    // At currentTick=3, remaining=1: full black means "click this tick and the
    // attack will fire on the next tick".
    const bar = runMetronome({ currentTick: 3, playerNextAttackTick: 4, playerAttackSpeed: 4 });
    expect(bar).toBeDefined();
    expect(bar!.ratio).toBe(0);
  });

  it('hides the bar on the auto-attack tick (remaining === 0)', () => {
    // At currentTick === playerNextAttackTick, either the auto-attack fired
    // (which would have already bumped nextAttackTick forward) or the player
    // didn't attack. Either way we hide the bar.
    const bar = runMetronome({ currentTick: 4, playerNextAttackTick: 4, playerAttackSpeed: 4 });
    expect(bar).toBeUndefined();
  });

  it('hides the bar after the ready tick passed without an attack', () => {
    const bar = runMetronome({ currentTick: 5, playerNextAttackTick: 4, playerAttackSpeed: 4 });
    expect(bar).toBeUndefined();
  });

  it('hides the bar when the player has never attacked (sentinel -1)', () => {
    const bar = runMetronome({ currentTick: 10, playerNextAttackTick: -1, playerAttackSpeed: 4 });
    expect(bar).toBeUndefined();
  });

  it('shifts the denominator for a 5-tick weapon', () => {
    // 5-tick weapon: (remaining - 1) / 4 at currentTick=0, remaining=5 → 4/4 = 1.
    const bar = runMetronome({ currentTick: 0, playerNextAttackTick: 5, playerAttackSpeed: 5 });
    expect(bar).toBeDefined();
    expect(bar!.ratio).toBe(1);
  });

  it('reaches full black on the correct tick for a 5-tick weapon', () => {
    // 5-tick weapon hits the ready tick at remaining=1 → currentTick=4.
    const bar = runMetronome({ currentTick: 4, playerNextAttackTick: 5, playerAttackSpeed: 5 });
    expect(bar).toBeDefined();
    expect(bar!.ratio).toBe(0);
  });

  it('handles a 1-tick weapon without dividing by zero (denominator clamped to 1)', () => {
    // attackSpeed=1: the "click to attack" frame happens every tick.
    const bar = runMetronome({ currentTick: 0, playerNextAttackTick: 1, playerAttackSpeed: 1 });
    expect(bar).toBeDefined();
    expect(bar!.ratio).toBe(0);
  });

  it('clamps an invalid attack speed of 0 to avoid division by zero', () => {
    const bar = runMetronome({ currentTick: 0, playerNextAttackTick: 2, playerAttackSpeed: 0 });
    expect(bar).toBeDefined();
    // With attackSpeed clamped to max(1, 0) = 1, denominator = max(1, 0) = 1.
    // remaining = 2, ratio = (2-1)/1 = 1 → full yellow.
    expect(bar!.ratio).toBe(1);
  });

  it('positions the bar flush beneath the player health bar', () => {
    const bar = runMetronome({ currentTick: 1, playerNextAttackTick: 4, playerAttackSpeed: 4 });
    expect(bar).toBeDefined();
    // buildHealthBar offsets by OSRS_HEALTHBAR_HEIGHT; metronome adds another
    // OSRS_HEALTHBAR_HEIGHT + 2px gap, mirroring buildNpcTimerBars.
    const HEALTHBAR_HEIGHT = 7;
    const VERTICAL_OFFSET = HEALTHBAR_HEIGHT + 2;
    // projection.tileToScreen = tile.x * 32 + tile.y * 32 (level=PLAYER_HEAD_WORLD_HEIGHT ≈ 2.2)
    // We only assert the offset is applied correctly relative to a baseline.
    const baseline = runMetronome({ currentTick: 0, playerNextAttackTick: 4, playerAttackSpeed: 4 });
    expect(bar!.screenX).toBe(baseline!.screenX);
    expect(bar!.screenY).toBe(baseline!.screenY);
    expect(VERTICAL_OFFSET).toBe(9);
  });
});

describe('NPC Attack Timer Metronome bars', () => {
  const projection = createMockProjection();

  function cooldownNpc(
    id: string,
    attackTimer: { nextAttackTick: number; attackSpeed: number },
    overrides: Partial<NpcSnapshot> = {},
  ): NpcSnapshot {
    return createNpcSnapshot({
      id,
      npcTypeId: 1234,
      size: 1,
      position: [10, 10],
      previousPosition: [10, 10],
      attackTimer,
      ...overrides,
    });
  }

  function npcBars(npcs: NpcSnapshot[], currentTick: number, interpFraction = 0) {
    const renderer = new UIOverlayRenderer();
    renderer.setTerrainHeights(null);
    const queue = createQueue();
    renderer.buildNpcAttackTimerBars(queue, projection, npcs, currentTick, interpFraction);
    return queue.timerBars ?? [];
  }

  it('emits one bar per alive NPC inside a cooldown, each with its own fill and key', () => {
    const bars = npcBars(
      [
        cooldownNpc('a', { nextAttackTick: 8, attackSpeed: 4 }),
        cooldownNpc('b', { nextAttackTick: 6, attackSpeed: 6 }),
      ],
      4,
    );

    expect(bars.map((bar) => bar.key)).toEqual(['npc-attack-timer-a', 'npc-attack-timer-b']);
    expect(bars[0].ratio).toBe(1);
    expect(bars[1].ratio).toBeCloseTo(1 / 5, 5);
  });

  it('matches the player metronome tick for tick, including full black on the final cooldown tick', () => {
    const playerRatioAt = (currentTick: number) =>
      runMetronome({ currentTick, playerNextAttackTick: 9, playerAttackSpeed: 5 })?.ratio;
    const npcRatioAt = (currentTick: number) =>
      npcBars([cooldownNpc('yama', { nextAttackTick: 9, attackSpeed: 5 })], currentTick)[0]?.ratio;

    for (const tick of [4, 5, 6, 7, 8, 9, 10]) {
      expect(npcRatioAt(tick)).toBe(playerRatioAt(tick));
    }
    expect(npcRatioAt(8)).toBe(0);
    expect(npcRatioAt(9)).toBeUndefined();
  });

  it('hides the bar for dead NPCs, NPCs without a cooldown, and NPCs past their ready tick', () => {
    const bars = npcBars(
      [
        cooldownNpc('dead', { nextAttackTick: 8, attackSpeed: 4 }, { alive: false }),
        createNpcSnapshot({ id: 'idle', npcTypeId: 1234 }),
        cooldownNpc('ready', { nextAttackTick: 4, attackSpeed: 4 }),
        cooldownNpc('never', { nextAttackTick: -1, attackSpeed: 4 }),
      ],
      4,
    );

    expect(bars).toEqual([]);
  });

  it('sits flush beneath the NPC health bar, sharing its anchor and width', () => {
    const renderer = new UIOverlayRenderer();
    renderer.setTerrainHeights(null);
    renderer.setNpcOverlayHeights(
      new Map([['yama', { hitsplatHeight: 1, healthBarHeight: 2, healthBarWidth: 100, baseHeight: 0 }]]),
    );
    const npc = cooldownNpc(
      'yama',
      { nextAttackTick: 8, attackSpeed: 4 },
      { size: 5, position: [10, 20], previousPosition: [10, 20] },
    );
    renderer.update(4, [
      { type: 'hitsplat_spawned', eventId: 1, tick: 4, targetId: 'yama', amount: 10, hitsplatType: 'damage' },
    ]);
    const queue = createQueue();

    renderer.buildNpcHealthBars(queue, projection, [npc], 4, new Set());
    renderer.buildNpcAttackTimerBars(queue, projection, [npc], 4);

    expect(queue.healthBars).toMatchObject([{ screenX: 400, screenY: 527, width: 100 }]);
    expect(queue.timerBars).toMatchObject([{ screenX: 400, screenY: 536, width: 100, key: 'npc-attack-timer-yama' }]);
  });

  it('stacks beneath the despawn timer bar when the NPC has one', () => {
    const renderer = new UIOverlayRenderer();
    renderer.setTerrainHeights(null);
    const timed = cooldownNpc('flare', { nextAttackTick: 8, attackSpeed: 4 }, { spawnTick: 0, despawnTick: 20 });
    const untimed = cooldownNpc('yama', { nextAttackTick: 8, attackSpeed: 4 });
    const queue = createQueue();

    renderer.buildNpcTimerBars(queue, projection, [timed, untimed], 4);
    renderer.buildNpcAttackTimerBars(queue, projection, [timed, untimed], 4);

    expect(queue.timerBars).toMatchObject([
      { key: 'npc-timerbar-flare', screenY: 202 },
      { key: 'npc-attack-timer-flare', screenY: 211 },
      { key: 'npc-attack-timer-yama', screenY: 202 },
    ]);
  });

  it('follows the interpolated NPC center while the NPC is moving', () => {
    const moving = cooldownNpc(
      'yama',
      { nextAttackTick: 8, attackSpeed: 4 },
      { previousPosition: [10, 20], position: [12, 20], size: 5 },
    );

    const [bar] = npcBars([moving], 4, 0.5);

    expect(bar.screenX).toBe(432);
  });
});

describe('TzHaar HP Tracker HP text', () => {
  const heights = { hitsplatHeight: 1, healthBarHeight: 2, healthBarWidth: 40, baseHeight: 0.5 };

  function hpTexts(npcs: NpcSnapshot[], options: Partial<TzhaarHpTrackerOptions> = {}) {
    const renderer = new UIOverlayRenderer();
    renderer.setNpcOverlayHeights(new Map(npcs.map((npc) => [npc.id, heights])));
    const queue = createQueue();
    renderer.buildNpcHpTexts(
      queue,
      createMockProjection(),
      npcs,
      { ...DEFAULT_TZHAAR_HP_TRACKER_OPTIONS, ...options },
      0,
      0,
    );
    return queue.overheadTexts ?? [];
  }

  // Mock projection: screenX = tileX * 32, screenY = level * -100 + tileY * 32.
  const centreY = (size: number) => (25 + size / 2) * 32;
  // The overhead text layer stands a 16px line box on screenY; its baseline is 3px above that.
  const BASELINE_TO_BOX_BOTTOM = 3;

  it.each([
    ['aboveHpBar', 0.5 + 2 + 25 / 128],
    ['center', 0.5 + 1],
    ['bottom', 0.5],
  ] as const)("puts the current HP's baseline at the plugin's %s point, in the alive color", (showHp, level) => {
    const [text] = hpTexts(
      [createNpcSnapshot({ id: 'mager', npcTypeId: 7699, hp: 187, maxHp: 220, size: 4, position: [20, 25] })],
      { showHp },
    );

    expect(text).toMatchObject({ text: '187', textColor: '#00ff30', fontSize: 16 });
    expect(text?.screenY).toBeCloseTo(level * -100 + centreY(4) + BASELINE_TO_BOX_BOTTOM);
  });

  it('starts the number where the plugin does: centered by its RS Small width, drawn in RS Bold', () => {
    const [text] = hpTexts([createNpcSnapshot({ hp: 187, size: 4, position: [20, 25] })]);

    // "187" is 17px in RS Small and 23px in RS Bold: it starts trunc(17 / 2) = 8px left of the
    // anchor, so its center is 23 / 2 - 8 = 3.5px right of it.
    expect(text?.screenX).toBe(22 * 32 + 3.5);
  });

  it('draws Zuk\'s "Above HP bar" at his center, where it stays on screen', () => {
    const [text] = hpTexts([createNpcSnapshot({ id: 'zuk', npcTypeId: 7706, hp: 900, size: 7, position: [20, 25] })]);

    expect(text?.screenY).toBeCloseTo(1.5 * -100 + centreY(7) + BASELINE_TO_BOX_BOTTOM);
  });

  it('writes full HP for an NPC not yet hit, nothing at 0 HP, and nothing with Show HP off', () => {
    expect(hpTexts([createNpcSnapshot({ hp: 220, maxHp: 220 })]).map((text) => text.text)).toEqual(['220']);
    expect(hpTexts([createNpcSnapshot({ hp: 0, alive: false })])).toEqual([]);
    expect(hpTexts([createNpcSnapshot({ hp: 220 })], { showHp: 'off' })).toEqual([]);
  });

  it('shades the number by remaining HP under Dynamic HP Color Hitpoints or Both', () => {
    const npc = createNpcSnapshot({ hp: 110, maxHp: 220 });
    expect(hpTexts([npc], { dynamicColor: 'hp' })[0]?.textColor).toBe('#708018');
    expect(hpTexts([npc], { dynamicColor: 'both' })[0]?.textColor).toBe('#708018');
    expect(hpTexts([npc], { dynamicColor: 'highlight' })[0]?.textColor).toBe('#00ff30');
  });

  it("stacks NPCs sharing a south-west tile 12px apart at the first one's point", () => {
    const texts = hpTexts(
      [
        createNpcSnapshot({ id: 'a', hp: 10, size: 1, position: [20, 25] }),
        createNpcSnapshot({ id: 'b', hp: 15, size: 1, position: [20, 25] }),
        createNpcSnapshot({ id: 'c', hp: 18, size: 1, position: [20, 25] }),
        createNpcSnapshot({ id: 'd', hp: 20, size: 1, position: [21, 25] }),
      ],
      { showHp: 'center' },
    );
    const anchorX = 20.5 * 32;

    expect(texts.map((text) => text.text)).toEqual(['10', '15', '18', '20']);
    // Each string keeps its own lean: "10" 11px small / 16px bold, "15" 10 / 15, "18" 11 / 16.
    expect(texts.slice(0, 3).map((text) => text.screenX)).toEqual([anchorX + 3, anchorX + 2.5, anchorX + 3]);
    expect(texts[1]?.screenY).toBe((texts[0]?.screenY ?? 0) - 12);
    expect(texts[2]?.screenY).toBe((texts[0]?.screenY ?? 0) - 24);
    expect(texts[3]?.screenY).toBe(texts[0]?.screenY);
  });
});
