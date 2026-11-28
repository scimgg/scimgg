import type React from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SimulationEngine } from '../core/SimulationEngine';
import type { SpellElement } from '../data/spellCatalog';
import type { UIPosition } from '../hooks/usePersistedSettings';
import type { NpcSnapshot, SimulationState } from '../types/simulation';
import { BOSS_HEALTH_BAR_WIDTH } from './BossHealthBarOverlay';
import type { ExclusionRect } from './DraggablePanel';
import { DraggablePanel } from './DraggablePanel';
import './DetailedDpsOverlay.css';

/**
 * Detailed DPS — the theoretical-DPS calculation behind the current attack.
 *
 * Width is the boss health bar's, shared rather than guessed, so the movable overlays agree
 * on one measurement.
 */
const PANEL_WIDTH = BOSS_HEALTH_BAR_WIDTH;

/** Default slot: left column, below the prayer flick helper's stack, clear of the minimap and the top-left buttons. */
const DEFAULT_POSITION: UIPosition = { x: 104, y: 248, anchorX: 'left', anchorY: 'top' };

/**
 * Height the panel occupies for the single layout pass before the content has
 * been measured. Never painted: the measuring effect below is a layout effect,
 * so its correction lands in the same frame.
 */
/** Height before the first measurement; the Mobile HUD also places the panel by it. */
export const DETAILED_DPS_SEED_HEIGHT = 200;
const SEED_HEIGHT = DETAILED_DPS_SEED_HEIGHT;

/**
 * DraggablePanel needs a height to place the panel, clamp it to the viewport
 * and publish its rect to the snap registry, but this panel's row count varies
 * with the calculation. Measuring the rendered content is what keeps the glass
 * the size of what is on it; deriving the height from row counts instead drifts
 * the moment any padding, gap or line-height in the CSS changes, and the panel
 * is `overflow: visible`, so an under-count paints the last rows outside the
 * background and border rather than scrolling them.
 */
function useMeasuredHeight(ref: React.RefObject<HTMLElement | null>, enabled: boolean): number {
  const [height, setHeight] = useState(SEED_HEIGHT);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;

    const sync = () => setHeight(element.offsetHeight);
    sync();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled]);

  return height;
}

const STYLE_LABELS = {
  melee_slash: 'Melee slash',
  melee_stab: 'Melee stab',
  melee_crush: 'Melee crush',
  ranged: 'Ranged',
  magic: 'Magic',
} as const;

const ELEMENT_LABELS: Record<SpellElement, string> = {
  air: 'Air',
  water: 'Water',
  earth: 'Earth',
  fire: 'Fire',
};

const ELEMENT_SPELLS: Record<SpellElement, string> = {
  air: 'an air spell',
  water: 'a water spell',
  earth: 'an earth spell',
  fire: 'a fire spell',
};

/** `note` is a subordinate line under the row, for a value that needs its state spelled out. */
type Row = { readonly label: string; readonly value: React.ReactNode; readonly note?: string };

function formatDps(value: number): string {
  return value.toFixed(3);
}

function formatDamage(value: number): string {
  return value.toFixed(2);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatInteger(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('en-US');
}

function displayTargetName(target: NpcSnapshot | undefined): string {
  if (target === undefined) return '';
  return target.archetypeId.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (character) => character.toUpperCase());
}

type DetailedDpsOverlayProps = {
  readonly overlayScale?: number;
  readonly engine: SimulationEngine | null;
  readonly dpsProjection?: ReturnType<SimulationEngine['getAdjustedTheoreticalDps']>;
  readonly simulationState: Pick<SimulationState, 'attackTarget' | 'npcs'>;
  readonly visible: boolean;
  readonly showDetails?: boolean;
  readonly position?: UIPosition | null;
  readonly onPositionChange?: (position: UIPosition) => void;
  /** Mobile layout: pinned in ordinary play (see mobileLayoutEdit). */
  readonly locked?: boolean;
  /** Mobile layout's "Edit layout": dragged by a plain press, touch included. */
  readonly editDrag?: boolean;
  /** The measured (unscaled) height, for a caller that places the panel itself (the Mobile HUD). */
  readonly onHeightChange?: (height: number) => void;
  readonly viewportWidth?: number;
  readonly viewportHeight?: number;
  readonly exclusionRects?: ExclusionRect[];
};

export const DetailedDpsOverlay: React.FC<DetailedDpsOverlayProps> = ({
  overlayScale = 1,
  engine,
  dpsProjection,
  simulationState,
  visible,
  showDetails = false,
  position,
  onPositionChange,
  locked,
  editDrag,
  onHeightChange,
  viewportWidth,
  viewportHeight,
  exclusionRects,
}) => {
  const contentRef = useRef<HTMLElement>(null);
  const measuredHeight = useMeasuredHeight(contentRef, visible);
  useEffect(() => {
    if (visible) onHeightChange?.(measuredHeight);
  }, [visible, measuredHeight, onHeightChange]);
  if (!visible) return null;

  const target =
    simulationState.npcs.find((npc) => npc.id === simulationState.attackTarget) ??
    simulationState.npcs.find((npc) => npc.role === 'boss');
  const calculation = dpsProjection === undefined ? (engine?.getAdjustedTheoreticalDps() ?? null) : dpsProjection;

  let body: React.ReactNode;

  if (calculation === null) {
    body = <p className="detailed-dps__empty">{target ? 'No supported attack.' : 'No target selected.'}</p>;
  } else {
    const rows: Row[] = [
      { label: 'Style', value: STYLE_LABELS[calculation.style] },
      { label: 'Accuracy', value: formatPercent(calculation.accuracy) },
      { label: 'Max hit', value: String(calculation.maxHit) },
    ];
    if (
      calculation.baseMaxHit !== null &&
      calculation.profileMaxHit !== null &&
      calculation.baseMaxHit !== calculation.profileMaxHit
    ) {
      rows.push({ label: 'Base max hit', value: formatInteger(calculation.baseMaxHit) });
    }
    rows.push(
      { label: 'Attack roll', value: formatInteger(calculation.baseAttackRoll) },
      { label: 'Defence roll', value: formatInteger(calculation.baseDefenceRoll) },
    );
    const weakness = calculation.elementalWeakness;
    if (weakness !== undefined) {
      rows.push({
        label: 'Weakness',
        value: (
          <span className={weakness.applied ? undefined : 'detailed-dps__inactive'}>
            {ELEMENT_LABELS[weakness.element]} {weakness.percent}%
          </span>
        ),
        note: weakness.applied ? 'Applied to this spell' : `Needs ${ELEMENT_SPELLS[weakness.element]}`,
      });
    }
    if (calculation.outgoingDamageMultiplier !== 1 || calculation.specialAttackDamageMultiplier !== 1) {
      rows.push({
        label: 'Multipliers',
        value: (
          <>
            ×{calculation.outgoingDamageMultiplier.toFixed(3)}
            <span className="detailed-dps__sep">·</span>×{calculation.specialAttackDamageMultiplier.toFixed(3)}
          </>
        ),
      });
    }

    const hits = calculation.hits;
    const showBreakdown = hits.length > 1 || hits.some((hit) => hit.procChance > 0 || hit.gateProbability < 1);
    const showProc = hits.some((hit) => hit.procChance > 0);
    const hitColumns = `20px repeat(${showProc ? 4 : 3}, 1fr)`;

    body = (
      <>
        <div className="detailed-dps__hero">
          <div className="detailed-dps__headline">
            <span className="detailed-dps__value">{formatDps(calculation.dps)}</span>
            <span className="detailed-dps__unit">dps</span>
          </div>
          <p className="detailed-dps__formula">
            {formatDamage(calculation.expectedAppliedDamagePerAttack)} damage ÷ {calculation.attackSpeedTicks} ticks (
            {calculation.attackIntervalSeconds.toFixed(2)}s)
          </p>
        </div>

        {showDetails && (
          <dl className="detailed-dps__rows">
            {rows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
                {row.note !== undefined && <dd className="detailed-dps__note">{row.note}</dd>}
              </div>
            ))}
          </dl>
        )}

        {showDetails && showBreakdown && (
          <section className="detailed-dps__breakdown">
            <h3>Hit breakdown</h3>
            <div className="detailed-dps__hit detailed-dps__hit--head" style={{ gridTemplateColumns: hitColumns }}>
              <span>Hit</span>
              <span>Acc</span>
              <span>Avg</span>
              <span>Max</span>
              {showProc && <span>Proc</span>}
            </div>
            {hits.map((hit, index) => (
              <div key={hit.planIndex} className="detailed-dps__hit" style={{ gridTemplateColumns: hitColumns }}>
                <span>{index + 1}</span>
                <span>{formatPercent(hit.accuracyProbability)}</span>
                <span>{formatDamage(hit.expectedAppliedDamage)}</span>
                <span>{hit.maximumAppliedDamage}</span>
                {showProc && <span>{hit.procChance > 0 ? formatPercent(hit.procChance) : '—'}</span>}
              </div>
            ))}
          </section>
        )}
      </>
    );
  }

  return (
    <DraggablePanel
      defaultPosition={DEFAULT_POSITION}
      position={position ?? undefined}
      width={PANEL_WIDTH}
      height={measuredHeight}
      scale={overlayScale}
      // Sized by Auto alone: Alt+scroll over it is taken and does nothing, so it never
      // reaches the camera or a panel underneath.
      scaleLocked
      onPositionChange={onPositionChange}
      locked={locked}
      editDrag={editDrag}
      viewportWidth={viewportWidth}
      viewportHeight={viewportHeight}
      exclusionRects={exclusionRects}
      pointerPassthrough
      altHintLabel="DPS Overlay"
      dataTutorial="detailed-dps-panel"
    >
      <section ref={contentRef} className="detailed-dps" aria-label="DPS Overlay">
        <div className="detailed-dps__caption">
          <span className="detailed-dps__title">DPS</span>
          <span className="detailed-dps__target">{displayTargetName(target)}</span>
        </div>
        {body}
      </section>
    </DraggablePanel>
  );
};
