import { describe, expect, it } from 'vitest';
import { selectInfoboxes } from '../../components/InfoBox/selectInfoboxes';
import { INFOBOX_ITEM_IDS } from '../../data/infoboxItemIds';
import { YamaEncounter } from '../../encounters/yamaP3/YamaEncounter';
import { SimulationEngine } from '../SimulationEngine';

const START_POS: [number, number] = [31, 37];

function createEngine(startHp = 99) {
  const engine = new SimulationEngine({
    encounter: new YamaEncounter(undefined, 100),
    startPos: START_POS,
    startHp,
    mechanics: {
      infiniteHealth: false,
      yamaMageRange: false,
      yamaMelee: false,
      waves: false,
      fireballs: false,
      voidFlares: false,
      autoPrepot: true,
    },
    combatSeed: 100,
  });
  return engine;
}

describe('Overload (+) potion (20996..20993)', () => {
  it('refuses drinking below 51 HP without consuming a dose', () => {
    const engine = createEngine(50);
    engine.setInventory([{ id: 20996 }, ...Array(27).fill(null)]);
    engine.queueItemAction(0);
    engine.advanceTick(START_POS);

    const state = engine.getState();
    expect(state.inventory[0]?.id).toBe(20996);
    expect(state.playerHP).toBe(50);
    expect(state.overloadTicksRemaining).toBeUndefined();
  });

  it('deals 5x10 self-damage, boosts combat stats to 120, blocks re-drinking, re-boosts after brew, and expires with 50 HP heal', () => {
    const engine = createEngine(99);
    // Slot 0: Overload (+)(4), Slot 1: Saradomin brew(4)
    engine.setInventory([{ id: 20996 }, { id: 6685 }, ...Array(26).fill(null)]);

    // Drink Overload(+) on tick 1.
    engine.queueItemAction(0);
    engine.advanceTick(START_POS);

    let state = engine.getState();
    expect(state.inventory[0]?.id).toBe(20995); // Decanted 4 -> 3
    expect(state.overloadTicksRemaining).toBe(500);
    expect(state.stats.attack.current).toBe(120);
    expect(state.stats.strength.current).toBe(120);
    expect(state.stats.defence.current).toBe(120);
    expect(state.stats.ranged.current).toBe(120);
    expect(state.stats.magic.current).toBe(120);

    // Infobox displays Overload(+) item 20996.
    const boxes = selectInfoboxes(state);
    expect(boxes.some((b) => b.id === 'overload-plus' && b.itemId === INFOBOX_ITEM_IDS.overloadPlus)).toBe(true);

    // Advance 9 more ticks to complete all 5x10 self-damage hits (99 -> 49 HP).
    for (let i = 0; i < 9; i++) engine.advanceTick(START_POS);
    state = engine.getState();
    expect(state.playerHP).toBe(49);

    // Refuses drinking a second dose while overload is still active.
    engine.queueItemAction(0);
    engine.advanceTick(START_POS);
    expect(engine.getState().inventory[0]?.id).toBe(20995);

    // Drink Saradomin brew to drain combat stats, then advance until the 25-tick pulse re-boosts them to 120.
    engine.queueItemAction(1);
    engine.advanceTick(START_POS);
    expect(engine.getState().stats.attack.current).toBeLessThan(120);

    for (let i = 0; i < 25; i++) engine.advanceTick(START_POS);
    state = engine.getState();
    expect(state.stats.attack.current).toBe(120);
    expect(state.stats.magic.current).toBe(120);
    expect(state.stats.ranged.current).toBe(120);

    // Advance through expiry (500 ticks total from tick 1).
    const remaining = state.overloadTicksRemaining ?? 0;
    for (let i = 0; i < remaining; i++) engine.advanceTick(START_POS);

    state = engine.getState();
    expect(state.overloadTicksRemaining).toBeUndefined();
    expect(state.stats.attack.current).toBe(99);
    expect(state.stats.magic.current).toBe(99);
    expect(state.stats.ranged.current).toBe(99);
    expect(state.playerHP).toBe(99); // Healed up to maxHp on expiry
  });

  it('auto-prepots Overload (+) with full combat boosts and zero self-damage', () => {
    const engine = createEngine(99);
    engine.setInventory([{ id: 20996 }, ...Array(27).fill(null)]);
    engine.applyPrepotEffects();

    for (let i = 0; i < 12; i++) engine.advanceTick(START_POS);
    const state = engine.getState();
    expect(state.playerHP).toBe(99);
    expect(state.inventory[0]?.id).toBe(20996); // Prepot does not consume inventory dose
    expect(state.stats.attack.current).toBe(120);
    expect(state.stats.magic.current).toBe(120);
    expect(state.overloadTicksRemaining).toBeGreaterThan(480);
  });
});
