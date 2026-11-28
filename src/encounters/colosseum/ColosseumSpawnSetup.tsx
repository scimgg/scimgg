import { useEffect, useId, useState } from 'react';
import {
  SpawnLayoutMap,
  type SpawnMapBounds,
  type SpawnMapObstacle,
  type SpawnMapSpot,
  type SpawnMapTileBox,
} from '../../components/SpawnLayoutMap';
import { DisclosureChevron } from '../../components/ui/DisclosureChevron';
import { OsrsButton } from '../../components/ui/OsrsButton';
import type { Coordinate, MechanicsConfig } from '../../types/simulation';
import {
  COLOSSEUM_SPAWN_LAYOUT_KEY,
  COLOSSEUM_START_TILE_KEY,
  resolveColosseumPlayerStart,
  resolveColosseumSpawnLayout,
  resolveColosseumStartWave,
} from '../solHeredit/controls';
import { colosseumWaveFloorTiles } from './waves/arena';
import { COLOSSEUM_SPAWN_POINTS, COLOSSEUM_SPECIES_SIZES } from './waves/layout';
import {
  COLOSSEUM_WAVE_START_TILE,
  type ColosseumLayoutSpecies,
  type ColosseumSpawnLayoutIssue,
  colosseumLayoutSpeciesForWave,
  colosseumSpawnLayoutWarnings,
  isColosseumStartTileOpen,
  serializeColosseumSpawnLayout,
  serializeColosseumStartTile,
  validateColosseumSpawnLayout,
} from './waves/spawnLayout';
import { SOL_WAVE } from './waves/waveTable';
import './ColosseumSpawnSetup.css';

/** The waves floor and its edge (x 16-48, y 18-51), the plane the map draws. */
const FLOOR = colosseumWaveFloorTiles();
const FLOOR_TILES = [...FLOOR].map((key) => key.split(',').map(Number) as Coordinate);
const BOUNDS: SpawnMapBounds = {
  minX: Math.min(...FLOOR_TILES.map(([x]) => x)),
  maxX: Math.max(...FLOOR_TILES.map(([x]) => x)),
  minY: Math.min(...FLOOR_TILES.map(([, y]) => y)),
  maxY: Math.max(...FLOOR_TILES.map(([, y]) => y)),
};
const MAP_WIDTH = BOUNDS.maxX - BOUNDS.minX + 1;
const MAP_HEIGHT = BOUNDS.maxY - BOUNDS.minY + 1;
/** Each floor tile as its own square, so the stroke draws the grid on the floor and nowhere else. */
const FLOOR_PATH = FLOOR_TILES.map(([x, y]) => `M${x - BOUNDS.minX} ${BOUNDS.maxY - y}h1v1h-1z`).join('');

/** Indexed as `COLOSSEUM_SPAWN_POINTS`, named by where each lies in the arena. */
const SPOT_NAMES = [
  'East, south',
  'Center north-west',
  'Center south-west',
  'South',
  'Center north-east',
  'East, inner',
  'Center south-east',
  'East, north',
  'North',
  'West, south',
  'West, inner',
  'West, north',
];
const SPOTS: readonly SpawnMapSpot[] = COLOSSEUM_SPAWN_POINTS.map((position, index) => ({
  name: SPOT_NAMES[index]!,
  position,
}));
/** Every spawn point takes any species; the largest is 3x3. */
const SPOT_SIZE = 3;
const EMPTY_POINTS: readonly (ColosseumLayoutSpecies | null)[] = COLOSSEUM_SPAWN_POINTS.map(() => null);

/** The four 3x3 pillars: the gaps the floor leaves in rows 26-28 and 41-43. */
const PILLARS: readonly SpawnMapObstacle[] = (
  [
    ['South-west', [24, 26]],
    ['South-east', [39, 26]],
    ['North-west', [24, 41]],
    ['North-east', [39, 41]],
  ] as const
).map(([name, position]) => ({ key: name, position, size: 3, ariaLabel: `${name} pillar` }));

const SPECIES_LABELS: Readonly<Record<ColosseumLayoutSpecies, string>> = {
  serpentShaman: 'Shaman',
  javelinColossus: 'Javelin',
  manticore: 'Manticore',
  shockwaveColossus: 'Shockwave',
};
const SPECIES_NAMES: Readonly<Record<ColosseumLayoutSpecies, string>> = {
  serpentShaman: 'serpent shaman',
  javelinColossus: 'javelin colossus',
  manticore: 'manticore',
  shockwaveColossus: 'shockwave colossus',
};
const speciesLabel = (species: ColosseumLayoutSpecies) => SPECIES_LABELS[species];
const speciesSize = (species: ColosseumLayoutSpecies) => COLOSSEUM_SPECIES_SIZES[species];

const floorTerrain = (tileBox: SpawnMapTileBox) => (
  <svg
    className="spawn-map__grid colosseum-spawn-map__floor"
    style={tileBox([BOUNDS.minX, BOUNDS.minY], MAP_WIDTH, MAP_HEIGHT)}
    viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
    preserveAspectRatio="none"
    shapeRendering="crispEdges"
    aria-hidden="true"
  >
    <path d={FLOOR_PATH} vectorEffect="non-scaling-stroke" />
  </svg>
);

/** What the warning says, from the layout's issues; null when the game could produce it. */
export function colosseumLayoutWarningText(issues: readonly ColosseumSpawnLayoutIssue[]): string | null {
  const close = new Set(issues.filter((issue) => issue.kind === 'spawn-too-close').map((issue) => issue.point));
  if (close.size === 0) return null;
  const under = issues.find((issue) => issue.kind === 'start-in-footprint');
  return [
    close.size === 1
      ? 'The marked spawn is within 4 tiles of your start.'
      : `${close.size} marked spawns are within 4 tiles of your start.`,
    'The game never spawns monsters that close, but this run will.',
    ...(under ? [`You also start inside the ${SPECIES_NAMES[under.species]}.`] : []),
  ].join(' ');
}

export interface ColosseumSpawnSetupProps {
  readonly config: MechanicsConfig;
  readonly onChange: (config: MechanicsConfig) => void;
  /** `rail` is the setup rail's disclosure; `tool` is the map open in the layout tool (`ColosseumLayoutTool`). */
  readonly surface: 'rail' | 'tool';
  /** The tool's Start: restarts the fight on the edited setup. Absent without a run. */
  readonly onStart?: () => void;
}

/**
 * The start wave's layout, as the Inferno's: in the setup rail an Edit layout disclosure with a
 * one-line summary, opening a map of the waves arena; in the layout tool the map itself, with Start.
 * Pick a monster, then tap spawn points; tap floor to move the start. A partial placement is a layout
 * like a complete one: the run draws the rest at random, and the warband, the reinforcements and the
 * manticores' first style stay random.
 *
 * Placements the game would never make from the start tile get a warning beside the map and a mark
 * on each such point. It is only a warning: the run honors the layout.
 *
 * The rail draws nothing for a direct Sol Heredit start, which has no wave layout; the tool says so.
 */
export function ColosseumSpawnSetup({ config, onChange, surface, onStart }: ColosseumSpawnSetupProps) {
  const startWave = resolveColosseumStartWave(config);
  const editable = startWave < SOL_WAVE;
  const [open, setOpen] = useState(false);
  const editorId = useId();
  useEffect(() => {
    if (!editable) setOpen(false);
  }, [editable]);
  const start = onStart && (
    <OsrsButton variant="primary" onClick={onStart}>
      Start wave {startWave}
    </OsrsButton>
  );
  if (!editable) {
    return surface === 'rail' ? null : (
      <>
        <div className="colosseum-spawn-setup spawn-layout-tool__arena">
          <div className="spawn-progress" />
          <div className="spawn-map-frame">
            <div className="spawn-map__tools" />
            <p className="colosseum-layout-editor__caption spawn-layout-tool__caption">
              Spawns and your start are fixed.
            </p>
            <div className="spawn-map-space">This wave has a fixed layout.</div>
          </div>
        </div>
        <footer className="spawn-layout-tool__footer">{start}</footer>
      </>
    );
  }

  const kinds = colosseumLayoutSpeciesForWave(startWave);
  const applied = resolveColosseumSpawnLayout(config);
  const points = applied?.points ?? EMPTY_POINTS;
  const startTile = resolveColosseumPlayerStart(config);
  const placed = points.filter(Boolean).length;
  const moved = startTile[0] !== COLOSSEUM_WAVE_START_TILE[0] || startTile[1] !== COLOSSEUM_WAVE_START_TILE[1];
  const issues = applied ? colosseumSpawnLayoutWarnings(applied, startTile) : [];
  const warning = colosseumLayoutWarningText(issues);
  const flagged = new Map<number, string>();
  for (const issue of issues) {
    flagged.set(issue.point, issue.kind === 'start-in-footprint' ? 'on your start' : 'too close to your start');
  }

  const setPoints = (next: readonly (ColosseumLayoutSpecies | null)[]) => {
    const result = validateColosseumSpawnLayout(startWave, next);
    // Emptied, this wave's layout goes; a layout saved for another wave is not this map's to clear.
    const value = result.ok
      ? serializeColosseumSpawnLayout(result.layout)
      : applied
        ? ''
        : config[COLOSSEUM_SPAWN_LAYOUT_KEY];
    // The tool reports every edit, as the Inferno's: its draft owns the layout it shows.
    if (surface === 'tool' || value !== config[COLOSSEUM_SPAWN_LAYOUT_KEY])
      onChange({ ...config, [COLOSSEUM_SPAWN_LAYOUT_KEY]: value });
  };
  const pickStart = (tile: Coordinate) => {
    if (isColosseumStartTileOpen(tile)) {
      onChange({ ...config, [COLOSSEUM_START_TILE_KEY]: serializeColosseumStartTile(tile) });
    }
  };
  const summary = [
    placed === 0 ? 'Random' : placed < kinds.length ? 'Custom, rest random' : 'Custom',
    ...(moved ? ['Moved start'] : []),
  ].join(' · ');

  const map = (
    <SpawnLayoutMap
      key={startWave}
      bounds={BOUNDS}
      terrain={floorTerrain}
      spots={SPOTS}
      spotSize={SPOT_SIZE}
      kinds={kinds}
      slots={points}
      kindLabel={speciesLabel}
      kindSize={speciesSize}
      obstacles={PILLARS}
      playerTile={startTile}
      startMovable
      onSlotsChange={setPoints}
      onStartChange={pickStart}
      flaggedSpots={flagged}
      caption={
        <p className="colosseum-layout-editor__caption spawn-layout-tool__caption">
          <span>
            {surface === 'tool' && placed > 0 && placed < kinds.length
              ? 'Unplaced monsters spawn at random.'
              : 'Pick a monster above, then tap its spots.'}
          </span>
          <span>Tap floor to move You. The warband and reinforcements stay random.</span>
        </p>
      }
      actions={
        <>
          <button
            type="button"
            tabIndex={-1}
            disabled={placed === 0}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setPoints(EMPTY_POINTS)}
          >
            Clear spawns
          </button>
          <button
            type="button"
            tabIndex={-1}
            disabled={!moved}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange({ ...config, [COLOSSEUM_START_TILE_KEY]: '' })}
          >
            Reset start
          </button>
        </>
      }
    />
  );
  const warningNote = warning && (
    <div className="colosseum-layout-warning spawn-layout-tool__note" role="status">
      <p className="colosseum-layout-warning__title">Not possible in the game</p>
      <p>{warning}</p>
    </div>
  );

  if (surface === 'tool') {
    return (
      <>
        <section
          className="colosseum-spawn-setup colosseum-layout-editor spawn-layout-tool__arena"
          aria-label={`Wave ${startWave} layout`}
        >
          {map}
          {warningNote}
        </section>
        <footer className="spawn-layout-tool__footer">{start}</footer>
      </>
    );
  }
  return (
    <div className="colosseum-spawn-setup">
      <button
        type="button"
        tabIndex={-1}
        className="colosseum-layout-summary"
        aria-expanded={open}
        aria-controls={editorId}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        <span className="colosseum-layout-summary__label">
          <DisclosureChevron open={open} />
          Edit layout
        </span>
        <span className="colosseum-layout-summary__state" role="status">
          {summary}
          {warning && <span className="colosseum-layout-summary__warning"> · Not possible in game</span>}
        </span>
      </button>
      {open && (
        <section id={editorId} className="colosseum-layout-editor" aria-label={`Wave ${startWave} layout`}>
          {map}
          {warningNote}
        </section>
      )}
    </div>
  );
}
