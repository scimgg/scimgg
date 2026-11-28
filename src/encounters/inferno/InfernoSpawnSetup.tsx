import type React from 'react';
import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { UndoButton } from '../../components/ResetToDefaults';
import {
  SpawnLayoutMap,
  type SpawnMapObstacle,
  type SpawnMapSpot,
  type SpawnMapTileBox,
} from '../../components/SpawnLayoutMap';
import { CloseButton } from '../../components/ui/CloseButton';
import { DisclosureChevron } from '../../components/ui/DisclosureChevron';
import { HoverHintButton } from '../../components/ui/HoverHintControl';
import { OsrsButton } from '../../components/ui/OsrsButton';
import { OsrsCheckbox } from '../../components/ui/OsrsCheckbox';
import { infernoIdentity } from '../../npcs/inferno/actors';
import type { Coordinate, MechanicsConfig } from '../../types/simulation';
import { ZUK_PLAYER_START } from '../zuk/constants';
import { INFERNO_ARENA_MAP_IMAGE } from './arenaMapImage';
import { INFERNO_ARENA_BOUNDS, INFERNO_LANDING_TILE, INFERNO_SPAWN_SLOTS, LAST_PILLAR_WAVE } from './constants';
import {
  INFERNO_DESTROYED_PILLAR_KEYS,
  INFERNO_SPAWN_LAYOUT_KEY,
  INFERNO_START_TILE_KEY,
  resolveInfernoRunSetup,
} from './controls';
import { INFERNO_PILLARS, PILLAR_SIZE, type PillarKey } from './pillars';
import { dismissInfernoSetupLinkNotice, useInfernoSetupLinkNotice } from './setupLinkNotice';
import {
  buildInfernoSetupUrl,
  type SlotKind,
  serializeSpawnLayout,
  slotKindsForWave,
  validateSpawnLayout,
} from './spawnLayout';
import {
  INFERNO_PRACTICE_START_TILE,
  serializeInfernoStartTile,
  startTileApplies,
  validateInfernoStartTile,
} from './startTile';
import { WAVE_NPC_NAMES } from './waveInfo';
import './InfernoSpawnSetup.css';

const EMPTY_SLOTS: readonly (SlotKind | null)[] = INFERNO_SPAWN_SLOTS.map(() => null);

const SLOT_NAMES = [
  'North-west',
  'West',
  'South-west',
  'Inner south-west',
  'South',
  'South-east',
  'Center',
  'East',
  'North-east',
];
const SPAWN_SPOTS: readonly SpawnMapSpot[] = INFERNO_SPAWN_SLOTS.map((position, index) => ({
  name: SLOT_NAMES[index]!,
  position,
}));
/** Every Inferno spot holds a 4x4 footprint; smaller monsters sit in its south-west corner. */
const SPOT_SIZE = 4;
const ARENA_WIDTH = INFERNO_ARENA_BOUNDS.maxX - INFERNO_ARENA_BOUNDS.minX + 1;
const ARENA_HEIGHT = INFERNO_ARENA_BOUNDS.maxY - INFERNO_ARENA_BOUNDS.minY + 1;
const GRID_PATH = [
  ...Array.from({ length: ARENA_WIDTH + 1 }, (_, x) => `M${x} 0V${ARENA_HEIGHT}`),
  ...Array.from({ length: ARENA_HEIGHT + 1 }, (_, y) => `M0 ${y}H${ARENA_WIDTH}`),
].join('');

export function kindLabel(kind: SlotKind): string {
  const name = WAVE_NPC_NAMES[kind].one;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const kindSize = (kind: SlotKind) =>
  infernoIdentity(kind === 'mager' || kind === 'ranger' ? { kind, variant: 'ordinary' } : kind).size;

// The diagram includes two tiles of terrain beyond the playable bounds, so edge pillars
// sit inside the arena picture rather than being mistaken for part of its frame.
const arenaTerrain = (tileBox: SpawnMapTileBox) => (
  <>
    <img
      className="spawn-map__terrain"
      src={INFERNO_ARENA_MAP_IMAGE.url}
      width={INFERNO_ARENA_MAP_IMAGE.width}
      height={INFERNO_ARENA_MAP_IMAGE.height}
      crossOrigin="anonymous"
      alt=""
      aria-hidden="true"
      draggable={false}
    />
    <span className="spawn-map__terrain-wash" aria-hidden="true" />
    <svg
      className="spawn-map__grid"
      style={tileBox([INFERNO_ARENA_BOUNDS.minX, INFERNO_ARENA_BOUNDS.minY], ARENA_WIDTH, ARENA_HEIGHT)}
      viewBox={`0 0 ${ARENA_WIDTH} ${ARENA_HEIGHT}`}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <path d={GRID_PATH} vectorEffect="non-scaling-stroke" />
    </svg>
  </>
);

function pillarObstacles(wave: number, destroyed: Readonly<Record<PillarKey, boolean>>): SpawnMapObstacle[] {
  if (wave > LAST_PILLAR_WAVE) return [];
  return INFERNO_PILLARS.map((pillar) => ({
    key: pillar.key,
    position: pillar.position,
    size: PILLAR_SIZE,
    ariaLabel: `${pillar.key === 'northEast' ? 'North-east' : pillar.key === 'west' ? 'West' : 'South'} pillar`,
    label: destroyed[pillar.key] ? 'Down' : 'Pillar',
    down: destroyed[pillar.key],
  }));
}

export interface InfernoSpawnSetupProps {
  readonly config: MechanicsConfig;
  readonly onChange: (config: MechanicsConfig) => void;
  readonly surface: 'rail' | 'tool';
  readonly onStart?: () => void;
  readonly exportGear?: () => string;
  readonly actionFooter?: HTMLElement | null;
}

export function InfernoSpawnSetup({
  config,
  onChange,
  surface,
  onStart,
  exportGear,
  actionFooter,
}: InfernoSpawnSetupProps) {
  const { startWave, destroyedPillars, spawnLayout: saved, startTile } = resolveInfernoRunSetup(config);
  const editable = startWave !== 69;
  const [open, setOpen] = useState(false);
  const arenaId = useId();
  useEffect(() => {
    if (!editable) setOpen(false);
  }, [editable]);
  const [includeGear, setIncludeGear] = useState(true);
  const withGear = includeGear && exportGear !== undefined;
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  const kinds = slotKindsForWave(startWave);
  // A partial placement is the saved layout like a complete one: the run spawns the rest at random.
  const applied = saved?.wave === startWave ? saved : null;
  const slots = kinds.length ? (applied?.slots ?? EMPTY_SLOTS) : EMPTY_SLOTS;
  const placed = slots.filter(Boolean).length;
  const partial = placed > 0 && placed < kinds.length;
  const setSlots = (next: readonly (SlotKind | null)[]) => {
    const result = validateSpawnLayout(startWave, next);
    // Emptied, this wave's layout goes; a layout saved for another wave is not this map's to clear.
    const value = result.ok ? serializeSpawnLayout(result.layout) : applied ? '' : config[INFERNO_SPAWN_LAYOUT_KEY];
    if (surface === 'tool' || value !== config[INFERNO_SPAWN_LAYOUT_KEY])
      onChange({ ...config, [INFERNO_SPAWN_LAYOUT_KEY]: value });
  };
  const pickStart = (tile: Coordinate) => {
    if (validateInfernoStartTile(tile, { startWave, destroyedPillars }).ok) {
      onChange({ ...config, [INFERNO_START_TILE_KEY]: serializeInfernoStartTile(tile) });
    }
  };
  const moved =
    startTileApplies(startWave) &&
    (startTile[0] !== INFERNO_PRACTICE_START_TILE[0] || startTile[1] !== INFERNO_PRACTICE_START_TILE[1]);
  const spawnSummary =
    kinds.length === 0
      ? startWave < 67
        ? 'Only nibblers this wave'
        : startWave < 69
          ? 'Jad spawns are fixed'
          : 'Fixed'
      : placed === 0
        ? 'Random'
        : partial
          ? 'Custom, rest random'
          : 'Custom';
  const downPillars = startWave <= LAST_PILLAR_WAVE ? Object.values(destroyedPillars).filter(Boolean) : [];
  const summary = [
    spawnSummary,
    ...(downPillars.length
      ? [
          downPillars.length === 3
            ? 'All pillars down'
            : `${downPillars.length} ${downPillars.length === 1 ? 'pillar' : 'pillars'} down`,
        ]
      : []),
    ...(moved ? ['Moved start'] : []),
  ].join(' · ');
  const copy = async () => {
    const selected = resolveInfernoRunSetup(config);
    try {
      const url = buildInfernoSetupUrl(
        window.location.origin,
        {
          startWave: selected.startWave,
          layout: selected.spawnLayout?.wave === selected.startWave ? selected.spawnLayout : null,
          destroyedPillars: selected.destroyedPillars,
          startTile: selected.startTile,
        },
        includeGear ? exportGear?.() : undefined,
      );
      await navigator.clipboard.writeText(url);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };
  const copyLabel = copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Try again' : 'Copy link';
  const copyButton = (
    <HoverHintButton
      type="button"
      tabIndex={-1}
      className="osrs-btn osrs-btn--default inferno-copy-link"
      aria-label={copyLabel}
      hint={
        copyState === 'failed'
          ? 'Clipboard unavailable. Try copying again.'
          : withGear
            ? `Shares the edited wave ${startWave} setup. Opening the link starts it with your gear.`
            : `Shares the edited wave ${startWave} setup. Opening the link shows setup without gear.`
      }
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void copy()}
    >
      {copyLabel}
    </HoverHintButton>
  );
  const copyControls = (
    <fieldset
      className="inferno-copy"
      aria-label="Share setup"
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest('button')) event.preventDefault();
      }}
    >
      {exportGear && (
        <div className="inferno-copy__option">
          <OsrsCheckbox label="Include gear" checked={includeGear} onChange={setIncludeGear} />
          <span className="inferno-copy__consequence">{withGear ? 'Link auto-starts' : 'Link opens setup'}</span>
        </div>
      )}
      {copyButton}
    </fieldset>
  );
  const arenaCaption = () => {
    if (surface === 'tool' && partial) return 'Unplaced monsters spawn at random.';
    return (
      <>
        <span>
          {kinds.length ? 'Pick a monster above, then tap its spots.' : surface === 'tool' ? spawnSummary : ''}
        </span>
        <span>
          {startWave <= LAST_PILLAR_WAVE ? 'Tap a pillar to knock it down. ' : ''}
          {startTileApplies(startWave) ? 'Tap floor to move You.' : 'Your start is fixed.'}
        </span>
      </>
    );
  };
  const arena = (
    <div className={surface === 'tool' ? 'inferno-arena spawn-layout-tool__arena' : 'inferno-arena'} id={arenaId}>
      <SpawnLayoutMap
        key={startWave}
        bounds={INFERNO_ARENA_MAP_IMAGE.bounds}
        terrain={arenaTerrain}
        spots={SPAWN_SPOTS}
        spotSize={SPOT_SIZE}
        kinds={kinds}
        slots={slots}
        kindLabel={kindLabel}
        kindSize={kindSize}
        obstacles={pillarObstacles(startWave, destroyedPillars)}
        onObstacleToggle={(key) => {
          const pillar = key as PillarKey;
          onChange({ ...config, [INFERNO_DESTROYED_PILLAR_KEYS[pillar]]: !destroyedPillars[pillar] });
        }}
        playerTile={startWave === 1 ? INFERNO_LANDING_TILE : startWave === 69 ? ZUK_PLAYER_START : startTile}
        startMovable={startTileApplies(startWave)}
        onSlotsChange={setSlots}
        onStartChange={pickStart}
        caption={<p className="inferno-arena__caption spawn-layout-tool__caption">{arenaCaption()}</p>}
        actions={
          <>
            <button
              type="button"
              tabIndex={-1}
              disabled={placed === 0}
              style={kinds.length === 0 ? { visibility: 'hidden' } : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setSlots(EMPTY_SLOTS)}
            >
              Clear spawns
            </button>
            <button
              type="button"
              tabIndex={-1}
              disabled={!moved}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChange({ ...config, [INFERNO_START_TILE_KEY]: '' })}
            >
              Reset start
            </button>
          </>
        }
      />
    </div>
  );
  return (
    <>
      {surface === 'rail' ? (
        <>
          <div>
            <button
              type="button"
              tabIndex={-1}
              className="inferno-arena-summary"
              disabled={!editable}
              aria-expanded={editable && open}
              aria-controls={arenaId}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setOpen(!open)}
            >
              <span className="inferno-arena-summary__label">
                <DisclosureChevron open={editable && open} />
                Edit layout
              </span>
              <span className="inferno-arena-summary__state" role="status">
                {summary}
              </span>
            </button>
            {editable && open && (
              <section className="inferno-layout-editor" aria-label={`Wave ${startWave} layout`}>
                {arena}
              </section>
            )}
          </div>
          {actionFooter === undefined ? copyControls : actionFooter && createPortal(copyControls, actionFooter)}
        </>
      ) : (
        <>
          {editable ? (
            arena
          ) : (
            <div className="inferno-arena spawn-layout-tool__arena">
              <div className="spawn-progress" />
              <div className="spawn-map-frame">
                <div className="spawn-map__tools" />
                <p className="inferno-arena__caption spawn-layout-tool__caption">Spawns and your start are fixed.</p>
                <div className="spawn-map-space">This wave has a fixed layout.</div>
              </div>
            </div>
          )}
          <footer className="spawn-layout-tool__footer">
            {copyControls}
            {onStart && (
              <OsrsButton variant="primary" onClick={onStart}>
                Start wave {startWave}
              </OsrsButton>
            )}
          </footer>
        </>
      )}
    </>
  );
}

export const InfernoLinkNotice: React.FC = () => {
  const notice = useInfernoSetupLinkNotice();
  if (!notice) return null;
  return (
    <div className={`inferno-link-notice is-${notice.tone}`} role="status">
      {/* Undo rides the end of the sentence it takes back, rather than a row of its own. */}
      <p>
        {notice.message}
        {notice.undo && (
          <>
            {' '}
            <UndoButton
              className="inferno-link-notice__undo"
              onClick={notice.undo}
              hint="Puts back the wave, layout and gear you had before the link."
            />
          </>
        )}
      </p>
      <CloseButton
        aria-label="Dismiss"
        tabIndex={-1}
        className="inferno-link-notice__close"
        onMouseDown={(event) => event.preventDefault()}
        onClick={dismissInfernoSetupLinkNotice}
      />
    </div>
  );
};
