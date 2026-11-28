import { baseEncounterKind } from '../encounters/catalog';
import type { TileMarker, TilePackPreset } from '../types/tileMarkers';

/** A RuneLite `#AARRGGBB` marker, whose alpha is the BORDER's. */
function rl(x: number, y: number, aarrggbb: string, label?: string): TileMarker {
  const hex = aarrggbb.startsWith('#') ? aarrggbb.slice(1) : aarrggbb;
  const alpha = parseInt(hex.slice(0, 2), 16);
  const rgb = hex.slice(2);
  return {
    x,
    y,
    color: `#${rgb.toUpperCase()}`,
    opacity: Math.round((alpha / 255) * 100) / 100,
    ...(label ? { label } : {}),
  };
}

// Consistent across all packs so users learn the color meanings once.
const C = {
  DANGER: '#CCFF6B35', // Hot orange — danger zones, no-fly areas
  SAFE: '#CC00BFA5', // Teal — safe tiles, landing spots
  CYCLE: '#CCFFAB00', // Warm gold — primary numbered cycle tiles
  WAVE: '#CC9B59B6', // Soft purple — wave dodge, early wave positions
  REFERENCE: '#9990A4AE', // Muted gray — faint reference/reset markers
} as const;

// All coordinates are region-local (regionId 6045 → sim coords are identical).

/**
 * "Yama No Fly" — pack id 66 in the RuneLite Tile Packs plugin (BSD-2-Clause, attributed in
 * scripts/vendoredNotices.ts), recolored onto `C`. Tiles and labels as published at
 * https://github.com/TrevorMDev/tile-packs/blob/fa48c15408c9dc86f1739c8d6def18d7a2fb19a6/src/main/resources/com/tilepacks/tilePacks.jsonc
 */
const YAMA_NO_FLY: TilePackPreset = {
  id: 'yama_p3_no_fly',
  name: 'Nofly',
  description: 'Safe tiles, no-fly zones, and wave dodge sequence (RuneLite Tile Packs)',
  encounterKind: 'yama_p3',
  link: 'https://www.youtube.com/watch?v=N6c-jW0kZC0',
  markers: [
    // Red — no-fly danger corners
    rl(24, 35, C.DANGER),
    rl(24, 34, C.DANGER),
    rl(23, 35, C.DANGER),
    rl(38, 35, C.DANGER),
    rl(38, 34, C.DANGER),
    rl(39, 35, C.DANGER),
    rl(23, 28, C.DANGER),
    rl(22, 28, C.DANGER),
    rl(22, 29, C.DANGER),
    rl(39, 28, C.DANGER),
    rl(40, 28, C.DANGER),
    rl(40, 29, C.DANGER),
    // Black — reference points
    rl(8, 47, C.REFERENCE),
    rl(7, 47, C.REFERENCE),
    rl(6, 47, C.REFERENCE),
    // Green — safe tiles
    rl(30, 35, C.SAFE),
    rl(30, 31, C.SAFE),
    rl(30, 30, C.SAFE),
    // Blue — early skip tiles
    rl(32, 35, C.WAVE, 'early skip'),
    rl(32, 31, C.WAVE),
    rl(32, 30, C.WAVE),
    // Yellow — wave dodge sequence
    rl(27, 33, C.WAVE, '1'),
    rl(28, 32, C.WAVE, '2'),
    rl(28, 31, C.WAVE, '3'),
    // Purple — alternate wave dodge
    rl(30, 33, C.WAVE, '2'),
    rl(29, 33, C.WAVE, '3'),
    rl(30, 34, C.WAVE, '1'),
  ],
};

/**
 * "Donofly" — OSRS Wiki documented advanced melee method.
 */
const YAMA_DONOFLY: TilePackPreset = {
  id: 'yama_p3_donofly',
  name: 'Donofly',
  description: 'Advanced melee P3 method. Avoids waves, crashes, and melee (OSRS Wiki)',
  encounterKind: 'yama_p3',
  link: 'https://oldschool.runescape.wiki/w/Yama/Strategies#Advanced_Yama_Methods',
  markers: [
    rl(30, 38, C.REFERENCE), // Landing/start reference
    rl(30, 34, C.SAFE),
    rl(30, 36, C.SAFE),
    rl(35, 35, C.CYCLE, '1'),
    rl(38, 31, C.CYCLE, '2'),
    rl(29, 33, C.CYCLE, '3'),
    rl(26, 30, C.CYCLE, '4w'),
    rl(32, 33, C.CYCLE, '5'),
  ],
};

/**
 * "Yama Mage Contract" — OSRS Wiki Phase 3 mage strategy tile pack.
 * Tile module: https://oldschool.runescape.wiki/w/Module:Tile_markers/Yama_mage_contract.json
 */
const YAMA_MAGE_CONTRACT: TilePackPreset = {
  id: 'yama_p3_mage_contract',
  name: 'Yama Mage Contract',
  description: 'Phase 3 mage strategy: wave-dodge tile path (OSRS Wiki)',
  encounterKind: 'yama_p3',
  link: 'https://oldschool.runescape.wiki/w/Yama/Strategies',
  markers: [
    // Wiki "solid white" — primary wave-dodge positions
    rl(31, 35, C.CYCLE),
    rl(29, 35, C.CYCLE),
    rl(31, 36, C.CYCLE),
    rl(29, 36, C.CYCLE),
    rl(30, 36, C.CYCLE),
    // Wiki "faint white" — fallback/reference positions
    rl(30, 38, C.REFERENCE),
    rl(31, 38, C.REFERENCE),
    rl(29, 38, C.REFERENCE),
    rl(30, 40, C.REFERENCE),
    // Wiki "green" — sentinel anchor tiles
    rl(29, 34, C.SAFE),
    rl(30, 39, C.SAFE),
  ],
};

/**
 * "Wave Dodge Lane" — beginner practice markers for the Shadow Waves tutorial.
 * The shadow wave sweeps north up the lane; each time it reaches the tile four
 * ahead of you, you run one tile to the next marker and let the wave pass beneath
 * you. Alternating colors show the step pattern: you shuttle from one color to the
 * next.
 */
const YAMA_WAVE_CROSS: TilePackPreset = {
  id: 'yama_p3_wave_cross',
  name: 'Wave Dodge Lane',
  description: 'Beginner shadow-wave dodge. Run between the marked tiles as each wave sweeps past',
  encounterKind: 'yama_p3',
  hidden: true,
  markers: [rl(30, 40, C.SAFE), rl(30, 38, C.WAVE), rl(30, 36, C.SAFE), rl(30, 34, C.WAVE)],
};

const YAMA_P3_PRESETS: TilePackPreset[] = [YAMA_DONOFLY, YAMA_NO_FLY, YAMA_MAGE_CONTRACT, YAMA_WAVE_CROSS];

/**
 * Inferno tiles as published by RuneMarkers (MIT; it and its tile credits are attributed in
 * scripts/vendoredNotices.ts), recolored onto `C`. Tiles and the UNSAFE label as at the pinned
 * `link`; the pack's name and description are our own.
 */
const ZUK_INFERNO: TilePackPreset = {
  id: 'zuk_inferno',
  name: 'Zuk Inferno Tiles',
  description: 'Zuk safe columns, danger tiles, and positional references',
  encounterKind: 'zuk',
  link: 'https://github.com/jamiegyoung/runemarkers/blob/b6fb9d0b3aa5706662267c2bdf0b00d4113dd158/entities/inferno.json',
  // Declared here rather than seeded into TILE_MARKER_DEFAULTS.activePresetIds, so
  // a user can switch it off durably.
  defaultActive: true,
  markers: [
    rl(36, 46, C.SAFE),
    rl(42, 46, C.SAFE),
    rl(26, 46, C.SAFE),
    rl(20, 46, C.SAFE),
    rl(40, 46, C.DANGER),
    rl(39, 46, C.DANGER),
    rl(38, 46, C.DANGER),
    rl(31, 45, C.DANGER, 'UNSAFE'),
    rl(23, 46, C.DANGER),
    rl(22, 46, C.DANGER),
    rl(24, 46, C.DANGER),
    rl(33, 43, C.REFERENCE),
    rl(32, 29, C.REFERENCE),
    rl(26, 34, C.REFERENCE),
  ],
};

const ZUK_PRESETS: TilePackPreset[] = [ZUK_INFERNO];

function rlTiles(aarrggbb: string, tiles: readonly (readonly [x: number, y: number])[]): TileMarker[] {
  return tiles.map(([x, y]) => rl(x, y, aarrggbb));
}

/**
 * The OSRS Wiki's "Guide:Colosseum tile markers" (CC BY-NC-SA 3.0, attributed in
 * scripts/vendoredNotices.ts), revision 14689691 of 2024-06-29: all 195 tiles and every label
 * of its RuneLite export, recolored onto `C` by the purpose the page gives each group. All are
 * region 7216 (map square 28_48, the encounter's origin), so region-local tiles are sim tiles.
 * The page's colors carry no meaning: 187 tiles are `#00000000` and the destack and jaguar-trap
 * tiles `#7D000000`. RuneLite draws the stored color as the border and label, so there those are
 * only its black fill (GroundMarkerOverlay.drawTile, runelite/runelite@53c583ab); here, with no
 * fill by default, they would draw nothing.
 */
const COLOSSEUM: TilePackPreset = {
  id: 'sol_heredit_colosseum',
  name: 'Colosseum Tiles',
  description: "Wave starts, off-tick, stall and destack tiles, dead zones, and Sol's Solarflare paths (OSRS Wiki)",
  encounterKind: 'sol_heredit',
  link: 'https://oldschool.runescape.wiki/w/Guide:Colosseum_tile_markers?oldid=14689691',
  // On for a first run, which needs it most; declared like Zuk's so switching it off sticks.
  defaultActive: true,
  markers: [
    // Dead zones: the edge of the arena, which the page says you cannot enter. All but four
    // corners, (20,22) (20,47) (45,47) (45,22), lie off the walkable waves floor.
    ...rlTiles(C.REFERENCE, [
      [20, 22],
      [20, 21],
      [20, 20],
      [21, 20],
      [22, 20],
      [22, 19],
      [23, 19],
      [24, 19],
      [24, 18],
      [25, 18],
      [26, 18],
      [27, 18],
      [28, 18],
      [28, 17],
      [29, 17],
      [30, 17],
      [19, 22],
      [18, 23],
      [18, 22],
      [18, 24],
      [17, 24],
      [17, 25],
      [17, 26],
      [16, 26],
      [16, 27],
      [16, 28],
      [16, 29],
      [16, 30],
      [15, 30],
      [15, 31],
      [15, 32],
      [15, 33],
      [15, 36],
      [15, 37],
      [15, 38],
      [15, 39],
      [16, 39],
      [16, 40],
      [16, 41],
      [16, 43],
      [17, 43],
      [17, 44],
      [17, 45],
      [18, 45],
      [18, 46],
      [18, 47],
      [19, 47],
      [20, 47],
      [20, 48],
      [21, 49],
      [20, 49],
      [22, 49],
      [22, 50],
      [23, 50],
      [24, 50],
      [24, 51],
      [25, 51],
      [26, 51],
      [27, 51],
      [28, 51],
      [29, 52],
      [30, 52],
      [28, 52],
      [35, 52],
      [36, 52],
      [37, 52],
      [37, 51],
      [38, 51],
      [39, 51],
      [40, 51],
      [41, 51],
      [41, 50],
      [42, 50],
      [43, 50],
      [43, 49],
      [44, 49],
      [45, 49],
      [45, 48],
      [45, 47],
      [46, 47],
      [47, 47],
      [47, 46],
      [47, 45],
      [48, 45],
      [48, 44],
      [48, 43],
      [49, 42],
      [49, 43],
      [49, 41],
      [49, 28],
      [49, 27],
      [49, 26],
      [48, 26],
      [48, 25],
      [48, 24],
      [47, 24],
      [47, 23],
      [47, 22],
      [46, 22],
      [45, 22],
      [45, 21],
      [45, 20],
      [44, 20],
      [43, 20],
      [43, 19],
      [42, 19],
      [41, 19],
      [41, 18],
      [40, 18],
      [39, 18],
      [38, 18],
      [37, 18],
      [37, 17],
      [36, 17],
      [35, 17],
      [16, 42],
    ]),
    // Solarflare paths for the Sol fight: four side-4 squares, the routes of SOL_SOLARFLARE_ROUTES.
    // The waves' orbs circle outward from these squares' outer corners (WAVE_SOLARFLARE_ROUTES), off these tiles.
    ...rlTiles(C.DANGER, [
      [27, 29],
      [27, 33],
      [31, 33],
      [31, 29],
      [30, 29],
      [29, 29],
      [28, 29],
      [27, 30],
      [27, 32],
      [27, 31],
      [28, 33],
      [29, 33],
      [30, 33],
      [31, 32],
      [31, 31],
      [31, 30],
      [27, 40],
      [27, 39],
      [27, 38],
      [27, 37],
      [27, 36],
      [28, 40],
      [29, 40],
      [30, 40],
      [31, 40],
      [28, 36],
      [29, 36],
      [30, 36],
      [31, 36],
      [31, 37],
      [31, 38],
      [31, 39],
      [38, 40],
      [37, 40],
      [36, 40],
      [35, 40],
      [34, 40],
      [34, 39],
      [34, 38],
      [34, 37],
      [34, 36],
      [35, 36],
      [36, 36],
      [37, 36],
      [38, 37],
      [38, 38],
      [38, 39],
      [38, 36],
      [34, 33],
      [35, 33],
      [36, 33],
      [37, 33],
      [38, 33],
      [38, 32],
      [38, 31],
      [38, 30],
      [38, 29],
      [37, 29],
      [36, 29],
      [35, 29],
      [34, 29],
      [34, 30],
      [34, 31],
      [34, 32],
    ]),
    // Wave starts for both west pillars; the unlabeled tile is the page's start for offticking a
    // shaman and a ranger stacked, in that order.
    rl(21, 33, C.SAFE, 'start SW'),
    rl(23, 36, C.SAFE, 'start NW'),
    rl(26, 44, C.SAFE),
    // Offticking double south spawns, and the reinforcement serpent shamans' offtick (NW) and stall (SW).
    rl(23, 43, C.CYCLE, 'A'),
    rl(23, 42, C.CYCLE, 'B'),
    rl(21, 43, C.CYCLE, 'offtick'),
    rl(21, 26, C.CYCLE, 'stall'),
    // The page's semi-transparent group: NW jaguar trap and destack tiles.
    rl(26, 50, C.WAVE, 'jaguar trap'),
    rl(25, 50, C.WAVE),
    rl(17, 41, C.WAVE, 'destack'),
    rl(16, 38, C.WAVE, 'destack'),
    rl(26, 19, C.WAVE, 'destack'),
    rl(29, 18, C.WAVE, 'destack'),
    rl(17, 28, C.WAVE, 'destack'),
    rl(16, 31, C.WAVE, 'destack'),
  ],
};

const COLOSSEUM_PRESETS: TilePackPreset[] = [COLOSSEUM];

const PRESETS_BY_ENCOUNTER = new Map<string, TilePackPreset[]>();

function registerPresets(presets: TilePackPreset[]): void {
  for (const preset of presets) {
    // Keyed by the owning kind, so a pack authored for a retired kind (Zuk's) serves the Inferno.
    const kind = baseEncounterKind(preset.encounterKind);
    const existing = PRESETS_BY_ENCOUNTER.get(kind) ?? [];
    existing.push(preset);
    PRESETS_BY_ENCOUNTER.set(kind, existing);
  }
}

registerPresets(YAMA_P3_PRESETS);
registerPresets(ZUK_PRESETS);
registerPresets(COLOSSEUM_PRESETS);

/**
 * A variant kind answers with its parent's packs: Yama's contracts are the same arena and the
 * same movement, so a pack authored for the base fight applies unchanged.
 */
export function getPresetsForEncounter(encounterKind: string): TilePackPreset[] {
  return PRESETS_BY_ENCOUNTER.get(baseEncounterKind(encounterKind)) ?? [];
}

/**
 * The packs a player may pick from. Use this for anything that renders the pack
 * list; every other caller — resolving active ids into markers, clearing every
 * pack, exporting one — wants `getPresetsForEncounter`, because a hidden pack a
 * tutorial switched on still has to render and still has to be clearable.
 */
export function getListedPresetsForEncounter(encounterKind: string): TilePackPreset[] {
  return getPresetsForEncounter(encounterKind).filter((preset) => !preset.hidden);
}

export function getPresetById(presetId: string): TilePackPreset | undefined {
  for (const presets of PRESETS_BY_ENCOUNTER.values()) {
    const found = presets.find((p) => p.id === presetId);
    if (found) return found;
  }
  return undefined;
}

export function getAllPresets(): TilePackPreset[] {
  const all: TilePackPreset[] = [];
  for (const presets of PRESETS_BY_ENCOUNTER.values()) {
    all.push(...presets);
  }
  return all;
}
