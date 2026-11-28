// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SimulationEngine } from '../../core/SimulationEngine';
import { YamaEncounter } from '../../encounters/yamaP3/YamaEncounter';
import { createEmptyCombatSupplies } from '../../types/encounterLoadout';
import type { Coordinate } from '../../types/simulation';
import { DetailedDpsOverlay } from '../DetailedDpsOverlay';

const PLAYER_POSITION: Coordinate = [31, 33];
const TARGET_ID = 'yama';

afterEach(cleanup);

function renderOverlay(engine: SimulationEngine, showDetails?: boolean) {
  return render(
    <DetailedDpsOverlay engine={engine} simulationState={engine.getState()} visible showDetails={showDetails} />,
  );
}

function targetedEngine(): SimulationEngine {
  const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: PLAYER_POSITION });
  engine.setAttackTarget(TARGET_ID);
  return engine;
}

describe('DetailedDpsOverlay Detailed DPS option', () => {
  it('uses the recorded projection when the live engine target is already dead', () => {
    const engine = targetedEngine();
    const simulationState = structuredClone(engine.getState());
    const recorded = engine.getAdjustedTheoreticalDps();
    if (!recorded) throw new TypeError('Expected supported recorded attack');
    engine.setBossHp(0);

    const view = render(
      <DetailedDpsOverlay engine={engine} simulationState={simulationState} dpsProjection={recorded} visible />,
    );

    expect(view.container.querySelector('.detailed-dps__value')?.textContent).toBe(recorded.dps.toFixed(3));
  });

  it('does not substitute live DPS when a recording has no projection', () => {
    const engine = targetedEngine();

    const view = render(
      <DetailedDpsOverlay engine={engine} simulationState={engine.getState()} dpsProjection={null} visible />,
    );

    expect(view.container.querySelector('.detailed-dps__value')).toBeNull();
  });

  it('shows only the caption and the DPS hero by default', () => {
    const engine = targetedEngine();

    const view = renderOverlay(engine);

    expect(engine.getAdjustedTheoreticalDps()).not.toBeNull();
    expect(view.container.querySelector('.detailed-dps__title')?.textContent).toBe('DPS');
    expect(view.container.querySelector('.detailed-dps__value')).not.toBeNull();
    expect(view.container.querySelector('.detailed-dps__formula')).not.toBeNull();
    expect(view.container.querySelector('.detailed-dps__rows')).toBeNull();
    expect(view.container.querySelector('.detailed-dps__breakdown')).toBeNull();
  });

  it('adds the stat rows under the hero once details are on', () => {
    const view = renderOverlay(targetedEngine(), true);

    expect(view.container.querySelector('.detailed-dps__value')).not.toBeNull();
    const labels = Array.from(view.container.querySelectorAll('.detailed-dps__rows dt'), (dt) => dt.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Style', 'Accuracy', 'Max hit', 'Attack roll', 'Defence roll']));
  });

  it('keeps the hit breakdown behind the option for a multi-hit attack', () => {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: PLAYER_POSITION });
    engine.setEquipment({ weapon: 28997 });
    engine.setAttackTarget(TARGET_ID);

    const view = renderOverlay(engine);

    expect(engine.getAdjustedTheoreticalDps()?.hits.length).toBeGreaterThan(1);
    expect(view.container.querySelector('.detailed-dps__breakdown')).toBeNull();
  });

  it('follows the option across rerenders without touching the hero', () => {
    const engine = targetedEngine();
    const view = renderOverlay(engine);
    const heroBefore = view.container.querySelector('.detailed-dps__value')?.textContent;

    view.rerender(<DetailedDpsOverlay engine={engine} simulationState={engine.getState()} visible showDetails />);
    expect(view.container.querySelector('.detailed-dps__rows')).not.toBeNull();

    view.rerender(
      <DetailedDpsOverlay engine={engine} simulationState={engine.getState()} visible showDetails={false} />,
    );
    expect(view.container.querySelector('.detailed-dps__rows')).toBeNull();
    expect(view.container.querySelector('.detailed-dps__value')?.textContent).toBe(heroBefore);
  });
});

describe('DetailedDpsOverlay elemental weakness', () => {
  const KODAI_WAND = 21006;

  function weaknessRow(view: ReturnType<typeof render>): Element | undefined {
    return Array.from(view.container.querySelectorAll('.detailed-dps__rows > div')).find(
      (row) => row.querySelector('dt')?.textContent === 'Weakness',
    );
  }

  function castingEngine(spell: string): SimulationEngine {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: PLAYER_POSITION });
    engine.setEquipment({ weapon: KODAI_WAND });
    engine.setSelectedAttackStyleIndex(3);
    engine.setCombatSupplies({
      ...createEmptyCombatSupplies(),
      selectedSpell: spell,
      // The wand supplies water runes; these cover the rest of a surge.
      runePouch: { kind: 'standard', slots: [{ id: 21880 }, { id: 565 }, { id: 556 }] },
    });
    engine.setAttackTarget(TARGET_ID);
    return engine;
  }

  it('marks the weakness applied while casting a spell of its element', () => {
    const engine = castingEngine('Water Surge');

    const view = renderOverlay(engine, true);

    expect(engine.getAdjustedTheoreticalDps()?.elementalWeakness).toEqual({
      element: 'water',
      percent: 50,
      applied: true,
    });
    const row = weaknessRow(view);
    expect(row?.querySelector('dd')?.textContent).toBe('Water 50%');
    expect(row?.querySelector('.detailed-dps__note')?.textContent).toBe('Applied to this spell');
    expect(row?.querySelector('.detailed-dps__inactive')).toBeNull();
  });

  it("shows the target's weakness as unused when the attack does not match it", () => {
    const engine = targetedEngine();

    const view = renderOverlay(engine, true);

    expect(engine.getAdjustedTheoreticalDps()?.elementalWeakness?.applied).toBe(false);
    const row = weaknessRow(view);
    expect(row?.querySelector('dd')?.textContent).toBe('Water 50%');
    expect(row?.querySelector('.detailed-dps__note')?.textContent).toBe('Needs a water spell');
    expect(row?.querySelector('.detailed-dps__inactive')).not.toBeNull();
  });

  it('omits the row when the target has no weakness, and keeps it behind the option', () => {
    const engine = castingEngine('Water Surge');
    const projection = engine.getAdjustedTheoreticalDps();
    if (!projection) throw new TypeError('Expected supported attack');
    const { elementalWeakness: _weakness, ...withoutWeakness } = projection;

    const withoutRow = render(
      <DetailedDpsOverlay
        engine={engine}
        simulationState={engine.getState()}
        dpsProjection={withoutWeakness}
        visible
        showDetails
      />,
    );
    expect(withoutRow.container.querySelector('.detailed-dps__rows')).not.toBeNull();
    expect(weaknessRow(withoutRow)).toBeUndefined();
    cleanup();

    expect(weaknessRow(renderOverlay(engine))).toBeUndefined();
  });
});

describe('DetailedDpsOverlay hit breakdown', () => {
  it('omits the breakdown for an ordinary single-hit attack', () => {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: PLAYER_POSITION });
    engine.setAttackTarget(TARGET_ID);

    const view = renderOverlay(engine, true);

    expect(engine.getAdjustedTheoreticalDps()?.hits).toHaveLength(1);
    expect(view.container.querySelector('.detailed-dps__breakdown')).toBeNull();
  });

  it('shows the breakdown for a multi-hit attack', () => {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: PLAYER_POSITION });
    engine.setEquipment({ weapon: 28997 });
    engine.setAttackTarget(TARGET_ID);

    const view = renderOverlay(engine, true);

    expect(engine.getAdjustedTheoreticalDps()?.hits.length).toBeGreaterThan(1);
    expect(view.container.querySelector('.detailed-dps__breakdown')).not.toBeNull();
  });
});
