import type { SimulationEngine } from '../../core/SimulationEngine';
import { VENTS_HP } from '../../encounters/duke/controls';
import { WARDEN_ID, WARDEN_MAX_HP } from '../../npcs/duke/duke';
import type { Coordinate } from '../../types/simulation';

/** Enter an awake checkpoint then jump to Opening to exercise its rotation without the feed sequence. */
export function startAwakeDukeOpening(engine: SimulationEngine, position: Coordinate = [31, 51]): void {
  const hp = engine.getState().npcs[0].hp;
  engine.applyBossHpPreset(VENTS_HP);
  engine.setBossHp(hp);
  engine.setAttackTarget(WARDEN_ID);
  engine.advanceTick(position);
  engine.setAttackTarget(null);
  const remainingHp = engine.getState().npcs[0].hp;
  engine.applyBossHpPreset(WARDEN_MAX_HP);
  engine.setBossHp(remainingHp);
}
