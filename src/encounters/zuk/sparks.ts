import type { EncounterContext, EnvironmentalDamage } from '../../core/encounters/types';
import { type EncounterVisualCue, emitEncounterVisual } from '../../core/events/encounterVisual';
import type { Coordinate } from '../../types/simulation';
import type { ZukSparkVolleyCommand } from './commands';

// Off-row and sampling models are simulator policy: docs/encounters/zuk-policy.md (Autonomous sparks).
export function generateSparkVolley({
  source,
  player,
  random,
}: {
  readonly source: Coordinate;
  readonly player: Coordinate;
  readonly random: () => number;
}): ZukSparkVolleyCommand['sparks'] {
  const deltaX = player[0] - source[0];
  const shift = deltaX <= -3 ? -2 : deltaX >= 3 ? 2 : 0;
  const centreX = source[0] + shift;
  let playerForced = false;
  const sampleStrip = (stripCentreX: number): ZukSparkVolleyCommand['sparks'][number] => {
    const forcePlayer =
      !playerForced &&
      Math.abs(player[0] - stripCentreX) <= 1 &&
      player[1] >= source[1] - 8 &&
      player[1] <= source[1] - 5;
    const position: Coordinate = forcePlayer
      ? [player[0], player[1]]
      : [stripCentreX - 1 + Math.floor(random() * 3), source[1] - 8 + Math.floor(random() * 4)];
    playerForced ||= forcePlayer;
    const amount = 5 + Math.floor(random() * 6);
    const slope = 40 + Math.floor(random() * 11);
    const delayCycles = Math.floor(random() * 6);
    const sourcePosition: Coordinate = [source[0] + 0.5, source[1] + 0.5];
    Object.freeze(position);
    Object.freeze(sourcePosition);
    return {
      position,
      amount,
      projectile: {
        sourcePosition,
        startDelayCycles: 0,
        endDelayCycles: 90,
        slope,
        startOffset: 0,
        startHeight: 70,
        endHeight: 0,
      },
      landing: { height: 0, delayCycles },
    };
  };
  return [sampleStrip(centreX + 2), sampleStrip(centreX), sampleStrip(centreX - 2)];
}

type Landing = {
  readonly tick: number;
  readonly spark: ZukSparkVolleyCommand['sparks'][number];
};

export class ZukSparkLandings {
  private pending: Landing[] = [];

  emit(command: Pick<ZukSparkVolleyCommand, 'sparks'>, tick: number): EncounterVisualCue | undefined {
    const sparks = structuredClone(command.sparks);
    this.pending.push(...sparks.map((spark) => ({ tick: tick + 3, spark })));
    const projectiles = sparks.flatMap((spark) =>
      spark.projectile
        ? [
            {
              ...spark.projectile,
              spotAnimId: 660,
              target: { kind: 'tile' as const, position: spark.position },
            },
          ]
        : [],
    );
    return projectiles.length > 0 ? { animations: [], projectiles, graphics: [] } : undefined;
  }

  resolve(ctx: EncounterContext): EnvironmentalDamage[] {
    const due = this.pending.filter((landing) => landing.tick === ctx.tick);
    this.pending = this.pending.filter((landing) => landing.tick > ctx.tick);
    const graphics = due.flatMap(({ spark }) =>
      spark.landing
        ? [
            {
              ...spark.landing,
              spotAnimId: 659,
              target: { kind: 'tile' as const, position: spark.position },
            },
          ]
        : [],
    );
    if (graphics.length > 0) emitEncounterVisual(ctx.tickEvents, { animations: [], projectiles: [], graphics });
    return due.flatMap(({ spark }): EnvironmentalDamage[] =>
      Math.abs(ctx.playerPos[0] - spark.position[0]) <= 1 && Math.abs(ctx.playerPos[1] - spark.position[1]) <= 1
        ? [{ baseDamage: spark.amount, attackType: 'typeless', source: 'ZukSpark', playerPosition: [...ctx.playerPos] }]
        : [],
    );
  }

  clear(): void {
    this.pending = [];
  }
}
