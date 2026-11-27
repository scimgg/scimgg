/**
 * The minimap's terrain: one map square's level underlays and overlays, lit and blended as the
 * client's minimap draws them, rasterized top-down (north up) into ABGR pixels. Shared by
 * `Minimap` and offline generators (scripts/generate-inferno-arena-map.mts), so both color the
 * terrain by the same rules.
 */
import type { OverlayTypeLoader, UnderlayTypeLoader } from '../rs/config/flotype/FloTypeLoader';
import { MAP_SQUARE_SIZE, type MapSquareData } from '../rs/map/MapLoader';
import type { TextureLoader } from '../rs/texture/TextureLoader';
import { adjustOverlayLight, adjustUnderlayLight, HSL_RGB_MAP, INVALID_HSL_COLOR, packHsl } from '../rs/util/ColorUtil';

const MAP_SIZE = MAP_SQUARE_SIZE;
const LOCAL_TILE_SIZE = 128;
const HALF_TILE_SIZE = LOCAL_TILE_SIZE / 2;
const QUARTER_TILE_SIZE = LOCAL_TILE_SIZE / 4;
const THREE_QTR_TILE_SIZE = (LOCAL_TILE_SIZE * 3) / 4;

const tileShapeVertexIndices = [
  [1, 3, 5, 7],
  [1, 3, 5, 7],
  [1, 3, 5, 7],
  [1, 3, 5, 7, 6],
  [1, 3, 5, 7, 6],
  [1, 3, 5, 7, 6],
  [1, 3, 5, 7, 6],
  [1, 3, 5, 7, 2, 6],
  [1, 3, 5, 7, 2, 8],
  [1, 3, 5, 7, 2, 8],
  [1, 3, 5, 7, 11, 12],
  [1, 3, 5, 7, 11, 12],
  [1, 3, 5, 7, 13, 14],
];

const tileShapeFaces = [
  [0, 1, 2, 3, 0, 0, 1, 3],
  [1, 1, 2, 3, 1, 0, 1, 3],
  [0, 1, 2, 3, 1, 0, 1, 3],
  [0, 0, 1, 2, 0, 0, 2, 4, 1, 0, 4, 3],
  [0, 0, 1, 4, 0, 0, 4, 3, 1, 1, 2, 4],
  [0, 0, 4, 3, 1, 0, 1, 2, 1, 0, 2, 4],
  [0, 1, 2, 4, 1, 0, 1, 4, 1, 0, 4, 3],
  [0, 4, 1, 2, 0, 4, 2, 5, 1, 0, 4, 5, 1, 0, 5, 3],
  [0, 4, 1, 2, 0, 4, 2, 3, 0, 4, 3, 5, 1, 0, 4, 5],
  [0, 0, 4, 5, 1, 4, 1, 2, 1, 4, 2, 3, 1, 4, 3, 5],
  [0, 0, 1, 5, 0, 1, 4, 5, 0, 1, 2, 4, 1, 0, 5, 3, 1, 5, 4, 3, 1, 4, 2, 3],
  [1, 0, 1, 5, 1, 1, 4, 5, 1, 1, 2, 4, 0, 0, 5, 3, 0, 5, 4, 3, 0, 4, 2, 3],
  [1, 0, 5, 4, 1, 0, 1, 5, 0, 0, 4, 3, 0, 4, 5, 3, 0, 5, 2, 3, 0, 1, 2, 5],
];

type TileFace = {
  localScreenX: [number, number, number];
  localScreenY: [number, number, number];
  hsl: [number, number, number];
};

function averageMinimapHsl(a: number, b: number): number {
  if (a === INVALID_HSL_COLOR || b === INVALID_HSL_COLOR || a < 0 || b < 0) {
    return INVALID_HSL_COLOR;
  }
  return (a + b) >> 1;
}

function buildTileFaces(
  tileScale: number,
  shape: number,
  rotation: number,
  lightSw: number,
  lightSe: number,
  lightNe: number,
  lightNw: number,
  blendUnderlayHslSw: number,
  overlayMinimapHsl: number,
): TileFace[] {
  const vertexIndices = tileShapeVertexIndices[shape] ?? tileShapeVertexIndices[0];
  const vertexCount = vertexIndices.length;

  const vertexX = new Int32Array(vertexCount);
  const vertexZ = new Int32Array(vertexCount);
  const underlayHsls = new Int32Array(vertexCount);
  const overlayHsls = new Int32Array(vertexCount);

  const hasUnderlay = blendUnderlayHslSw !== -1;
  const hasOverlay = overlayMinimapHsl >= 0;

  const underlayMinimapHslSw = hasUnderlay ? adjustUnderlayLight(blendUnderlayHslSw, lightSw) : INVALID_HSL_COLOR;
  const underlayMinimapHslSe = hasUnderlay ? adjustUnderlayLight(blendUnderlayHslSw, lightSe) : INVALID_HSL_COLOR;
  const underlayMinimapHslNe = hasUnderlay ? adjustUnderlayLight(blendUnderlayHslSw, lightNe) : INVALID_HSL_COLOR;
  const underlayMinimapHslNw = hasUnderlay ? adjustUnderlayLight(blendUnderlayHslSw, lightNw) : INVALID_HSL_COLOR;

  const overlayMinimapHslSw = hasOverlay ? adjustOverlayLight(overlayMinimapHsl, lightSw) : INVALID_HSL_COLOR;
  const overlayMinimapHslSe = hasOverlay ? adjustOverlayLight(overlayMinimapHsl, lightSe) : INVALID_HSL_COLOR;
  const overlayMinimapHslNe = hasOverlay ? adjustOverlayLight(overlayMinimapHsl, lightNe) : INVALID_HSL_COLOR;
  const overlayMinimapHslNw = hasOverlay ? adjustOverlayLight(overlayMinimapHsl, lightNw) : INVALID_HSL_COLOR;

  for (let i = 0; i < vertexCount; i++) {
    let vertexIndex = vertexIndices[i];
    if ((vertexIndex & 1) === 0 && vertexIndex <= 8) {
      vertexIndex = ((vertexIndex - rotation * 2 - 1) & 7) + 1;
    }

    if (vertexIndex > 8 && vertexIndex <= 12) {
      vertexIndex = ((vertexIndex - 9 - rotation) & 3) + 9;
    }

    if (vertexIndex > 12 && vertexIndex <= 0x10) {
      vertexIndex = ((vertexIndex - 13 - rotation) & 3) + 13;
    }

    let vertX = 0;
    let vertZ = 0;
    let vertUnderlayHsl = INVALID_HSL_COLOR;
    let vertOverlayHsl = INVALID_HSL_COLOR;

    if (vertexIndex === 1) {
      vertX = 0;
      vertZ = 0;
      vertUnderlayHsl = underlayMinimapHslSw;
      vertOverlayHsl = overlayMinimapHslSw;
    } else if (vertexIndex === 2) {
      vertX = HALF_TILE_SIZE;
      vertZ = 0;
      vertUnderlayHsl = averageMinimapHsl(underlayMinimapHslSe, underlayMinimapHslSw);
      vertOverlayHsl = averageMinimapHsl(overlayMinimapHslSe, overlayMinimapHslSw);
    } else if (vertexIndex === 3) {
      vertX = LOCAL_TILE_SIZE;
      vertZ = 0;
      vertUnderlayHsl = underlayMinimapHslSe;
      vertOverlayHsl = overlayMinimapHslSe;
    } else if (vertexIndex === 4) {
      vertX = LOCAL_TILE_SIZE;
      vertZ = HALF_TILE_SIZE;
      vertUnderlayHsl = averageMinimapHsl(underlayMinimapHslSe, underlayMinimapHslNe);
      vertOverlayHsl = averageMinimapHsl(overlayMinimapHslSe, overlayMinimapHslNe);
    } else if (vertexIndex === 5) {
      vertX = LOCAL_TILE_SIZE;
      vertZ = LOCAL_TILE_SIZE;
      vertUnderlayHsl = underlayMinimapHslNe;
      vertOverlayHsl = overlayMinimapHslNe;
    } else if (vertexIndex === 6) {
      vertX = HALF_TILE_SIZE;
      vertZ = LOCAL_TILE_SIZE;
      vertUnderlayHsl = averageMinimapHsl(underlayMinimapHslNw, underlayMinimapHslNe);
      vertOverlayHsl = averageMinimapHsl(overlayMinimapHslNw, overlayMinimapHslNe);
    } else if (vertexIndex === 7) {
      vertX = 0;
      vertZ = LOCAL_TILE_SIZE;
      vertUnderlayHsl = underlayMinimapHslNw;
      vertOverlayHsl = overlayMinimapHslNw;
    } else if (vertexIndex === 8) {
      vertX = 0;
      vertZ = HALF_TILE_SIZE;
      vertUnderlayHsl = averageMinimapHsl(underlayMinimapHslNw, underlayMinimapHslSw);
      vertOverlayHsl = averageMinimapHsl(overlayMinimapHslNw, overlayMinimapHslSw);
    } else if (vertexIndex === 9) {
      vertX = HALF_TILE_SIZE;
      vertZ = QUARTER_TILE_SIZE;
      vertUnderlayHsl = averageMinimapHsl(underlayMinimapHslSe, underlayMinimapHslSw);
      vertOverlayHsl = averageMinimapHsl(overlayMinimapHslSe, overlayMinimapHslSw);
    } else if (vertexIndex === 10) {
      vertX = THREE_QTR_TILE_SIZE;
      vertZ = HALF_TILE_SIZE;
      vertUnderlayHsl = averageMinimapHsl(underlayMinimapHslSe, underlayMinimapHslNe);
      vertOverlayHsl = averageMinimapHsl(overlayMinimapHslSe, overlayMinimapHslNe);
    } else if (vertexIndex === 11) {
      vertX = HALF_TILE_SIZE;
      vertZ = THREE_QTR_TILE_SIZE;
      vertUnderlayHsl = averageMinimapHsl(underlayMinimapHslNw, underlayMinimapHslNe);
      vertOverlayHsl = averageMinimapHsl(overlayMinimapHslNw, overlayMinimapHslNe);
    } else if (vertexIndex === 12) {
      vertX = QUARTER_TILE_SIZE;
      vertZ = HALF_TILE_SIZE;
      vertUnderlayHsl = averageMinimapHsl(underlayMinimapHslNw, underlayMinimapHslSw);
      vertOverlayHsl = averageMinimapHsl(overlayMinimapHslNw, overlayMinimapHslSw);
    } else if (vertexIndex === 13) {
      vertX = QUARTER_TILE_SIZE;
      vertZ = QUARTER_TILE_SIZE;
      vertUnderlayHsl = underlayMinimapHslSw;
      vertOverlayHsl = overlayMinimapHslSw;
    } else if (vertexIndex === 14) {
      vertX = THREE_QTR_TILE_SIZE;
      vertZ = QUARTER_TILE_SIZE;
      vertUnderlayHsl = underlayMinimapHslSe;
      vertOverlayHsl = overlayMinimapHslSe;
    } else if (vertexIndex === 15) {
      vertX = THREE_QTR_TILE_SIZE;
      vertZ = THREE_QTR_TILE_SIZE;
      vertUnderlayHsl = underlayMinimapHslNe;
      vertOverlayHsl = overlayMinimapHslNe;
    } else {
      vertX = QUARTER_TILE_SIZE;
      vertZ = THREE_QTR_TILE_SIZE;
      vertUnderlayHsl = underlayMinimapHslNw;
      vertOverlayHsl = overlayMinimapHslNw;
    }

    vertexX[i] = vertX;
    vertexZ[i] = vertZ;
    underlayHsls[i] = vertUnderlayHsl;
    overlayHsls[i] = vertOverlayHsl;
  }

  const faces: TileFace[] = [];
  const shapeFaces = tileShapeFaces[shape] ?? tileShapeFaces[0];

  for (let i = 0; i < shapeFaces.length; i += 4) {
    const isOverlay = shapeFaces[i] === 1;
    let a = shapeFaces[i + 1];
    let b = shapeFaces[i + 2];
    let c = shapeFaces[i + 3];

    if (a < 4) {
      a = (a - rotation) & 3;
    }

    if (b < 4) {
      b = (b - rotation) & 3;
    }

    if (c < 4) {
      c = (c - rotation) & 3;
    }

    if (isOverlay && !hasOverlay) {
      continue;
    }
    if (!isOverlay && !hasUnderlay) {
      continue;
    }

    const hslA = isOverlay ? overlayHsls[a] : underlayHsls[a];
    const hslB = isOverlay ? overlayHsls[b] : underlayHsls[b];
    const hslC = isOverlay ? overlayHsls[c] : underlayHsls[c];

    if (hslA === INVALID_HSL_COLOR || hslB === INVALID_HSL_COLOR || hslC === INVALID_HSL_COLOR) {
      continue;
    }

    faces.push({
      localScreenX: [(vertexX[a] * tileScale) >> 7, (vertexX[b] * tileScale) >> 7, (vertexX[c] * tileScale) >> 7],
      localScreenY: [
        ((LOCAL_TILE_SIZE - vertexZ[a]) * tileScale) >> 7,
        ((LOCAL_TILE_SIZE - vertexZ[b]) * tileScale) >> 7,
        ((LOCAL_TILE_SIZE - vertexZ[c]) * tileScale) >> 7,
      ],
      hsl: [hslA, hslB, hslC],
    });
  }

  return faces;
}

function rasterGouraud(
  pixels: Uint32Array,
  canvasWidth: number,
  clipW: number,
  clipH: number,
  y0: number,
  y1: number,
  y2: number,
  x0: number,
  x1: number,
  x2: number,
  hsl0: number,
  hsl1: number,
  hsl2: number,
): void {
  if (y0 > y1) {
    let t: number;
    t = y0;
    y0 = y1;
    y1 = t;
    t = x0;
    x0 = x1;
    x1 = t;
    t = hsl0;
    hsl0 = hsl1;
    hsl1 = t;
  }
  if (y1 > y2) {
    let t: number;
    t = y1;
    y1 = y2;
    y2 = t;
    t = x1;
    x1 = x2;
    x2 = t;
    t = hsl1;
    hsl1 = hsl2;
    hsl2 = t;
  }
  if (y0 > y1) {
    let t: number;
    t = y0;
    y0 = y1;
    y1 = t;
    t = x0;
    x0 = x1;
    x1 = t;
    t = hsl0;
    hsl0 = hsl1;
    hsl1 = t;
  }

  if (y0 >= clipH || y2 < 0) return;

  const dx10 = x1 - x0,
    dy10 = y1 - y0;
  const dx20 = x2 - x0,
    dy20 = y2 - y0;
  const area2 = dx10 * dy20 - dx20 * dy10;
  if (area2 === 0) return;

  const dhsl10 = hsl1 - hsl0,
    dhsl20 = hsl2 - hsl0;
  // Fixed-point <<8 HSL gradients per pixel
  const dHslDx = (((dhsl10 * dy20 - dhsl20 * dy10) << 8) / area2) | 0;
  const dHslDy = (((dhsl20 * dx10 - dhsl10 * dx20) << 8) / area2) | 0;

  // Fixed-point <<14 edge slopes
  const longDx = ((dx20 << 14) / dy20) | 0;
  const shortTopDx = dy10 > 0 ? ((dx10 << 14) / dy10) | 0 : 0;
  const shortBotDx = y2 - y1 > 0 ? (((x2 - x1) << 14) / (y2 - y1)) | 0 : 0;

  let longX = x0 << 14;
  let shortX = x0 << 14;
  let hslRow = (hsl0 << 8) + dHslDx - x0 * dHslDx;

  if (y0 < 0) {
    longX -= y0 * longDx;
    shortX -= y0 * shortTopDx;
    hslRow -= y0 * dHslDy;
    y0 = 0;
  }

  for (let half = 0; half < 2; half++) {
    const yEnd = Math.min(half === 0 ? y1 : y2, clipH);
    const shortSlope = half === 0 ? shortTopDx : shortBotDx;

    if (half === 1) {
      shortX = x1 << 14;
      if (y1 < 0) {
        shortX -= y1 * shortBotDx;
      }
    }

    for (let y = half === 0 ? y0 : Math.max(y1, 0); y < yEnd; y++) {
      const lx = longX >> 14;
      const sx = shortX >> 14;
      let left: number, right: number;
      if (lx < sx) {
        left = lx;
        right = sx;
      } else {
        left = sx;
        right = lx;
      }

      if (left < 0) left = 0;
      if (right > clipW) right = clipW;

      if (left < right) {
        const rowOffset = y * canvasWidth;
        let hslCur = hslRow + left * dHslDx;
        for (let x = left; x < right; x++) {
          const hsl = hslCur >> 8;
          if (hsl >= 0 && hsl < HSL_RGB_MAP.length) {
            pixels[rowOffset + x] = rgbToAbgr(HSL_RGB_MAP[hsl]);
          }
          hslCur += dHslDx;
        }
      }

      longX += longDx;
      shortX += shortSlope;
      hslRow += dHslDy;
    }
  }
}

/** Convert 0xRRGGBB → 0xAABBGGRR (little-endian ABGR for Uint32Array ImageData) */
function rgbToAbgr(rgb: number): number {
  return 0xff000000 | ((rgb & 0xff) << 0x10) | (rgb & 0xff00) | ((rgb >> 0x10) & 0xff);
}

const BLEND_RADIUS = 5;
const LIGHT_DIR_X = -50;
const LIGHT_DIR_Y = -10;
const LIGHT_DIR_Z = -50;
const LIGHT_INTENSITY_BASE = 96;
const LIGHT_INTENSITY_FACTOR = 768;
const HEIGHT_SCALE = 65536;

export function blendUnderlays(
  mapData: MapSquareData,
  underlayLoader: UnderlayTypeLoader,
  level: number,
): Int32Array[] {
  const colors: Int32Array[] = new Array(MAP_SIZE);
  for (let i = 0; i < MAP_SIZE; i++) {
    colors[i] = new Int32Array(MAP_SIZE).fill(-1);
  }

  const hues = new Int32Array(MAP_SIZE);
  const sats = new Int32Array(MAP_SIZE);
  const light = new Int32Array(MAP_SIZE);
  const mul = new Int32Array(MAP_SIZE);
  const num = new Int32Array(MAP_SIZE);

  const blendStartX = -BLEND_RADIUS;
  const blendStartY = -BLEND_RADIUS;
  const blendEndX = MAP_SIZE + BLEND_RADIUS;
  const blendEndY = MAP_SIZE + BLEND_RADIUS;

  for (let xi = blendStartX; xi < blendEndX; xi++) {
    for (let yi = 0; yi < MAP_SIZE; yi++) {
      const xEast = xi + BLEND_RADIUS;
      if (xEast >= 0 && xEast < MAP_SIZE) {
        const underlayId = mapData.tileUnderlays[level][xEast][yi];
        if (underlayId > 0) {
          const type = underlayLoader.load(underlayId - 1);
          hues[yi] += type.hue;
          sats[yi] += type.saturation;
          light[yi] += type.lightness;
          mul[yi] += type.hueMultiplier;
          num[yi]++;
        }
      }

      const xWest = xi - BLEND_RADIUS;
      if (xWest >= 0 && xWest < MAP_SIZE) {
        const underlayId = mapData.tileUnderlays[level][xWest][yi];
        if (underlayId > 0) {
          const type = underlayLoader.load(underlayId - 1);
          hues[yi] -= type.hue;
          sats[yi] -= type.saturation;
          light[yi] -= type.lightness;
          mul[yi] -= type.hueMultiplier;
          num[yi]--;
        }
      }
    }

    if (xi < 0 || xi >= MAP_SIZE) {
      continue;
    }

    let runningHues = 0;
    let runningSat = 0;
    let runningLight = 0;
    let runningMultiplier = 0;
    let runningNumber = 0;

    for (let yi = blendStartY; yi < blendEndY; yi++) {
      const yNorth = yi + BLEND_RADIUS;
      if (yNorth >= 0 && yNorth < MAP_SIZE) {
        runningHues += hues[yNorth];
        runningSat += sats[yNorth];
        runningLight += light[yNorth];
        runningMultiplier += mul[yNorth];
        runningNumber += num[yNorth];
      }

      const ySouth = yi - BLEND_RADIUS;
      if (ySouth >= 0 && ySouth < MAP_SIZE) {
        runningHues -= hues[ySouth];
        runningSat -= sats[ySouth];
        runningLight -= light[ySouth];
        runningMultiplier -= mul[ySouth];
        runningNumber -= num[ySouth];
      }

      if (yi < 0 || yi >= MAP_SIZE) {
        continue;
      }

      const underlayId = mapData.tileUnderlays[level][xi][yi];
      if (underlayId > 0 && runningNumber > 0 && runningMultiplier > 0) {
        const avgHue = ((runningHues * 256) / runningMultiplier) | 0;
        const avgSat = (runningSat / runningNumber) | 0;
        const avgLight = (runningLight / runningNumber) | 0;
        colors[xi][yi] = packHsl(avgHue, avgSat, avgLight);
      }
    }
  }

  return colors;
}

export function computeTileLights(mapData: MapSquareData, level: number): Int32Array[] {
  const lights: Int32Array[] = new Array(MAP_SIZE);
  for (let i = 0; i < MAP_SIZE; i++) {
    lights[i] = new Int32Array(MAP_SIZE).fill(LIGHT_INTENSITY_BASE);
  }

  const lightMagnitude =
    Math.sqrt(LIGHT_DIR_X * LIGHT_DIR_X + LIGHT_DIR_Y * LIGHT_DIR_Y + LIGHT_DIR_Z * LIGHT_DIR_Z) | 0;
  const lightIntensity = (lightMagnitude * LIGHT_INTENSITY_FACTOR) >> 8;

  const heights = mapData.tileHeights[level];
  const occlusions = mapData.tileLightOcclusions[level];

  for (let x = 1; x < MAP_SIZE - 1; x++) {
    for (let y = 1; y < MAP_SIZE - 1; y++) {
      const heightDeltaX = heights[x + 1][y] - heights[x - 1][y];
      const heightDeltaY = heights[x][y + 1] - heights[x][y - 1];

      const tileNormalLength = Math.sqrt(heightDeltaY * heightDeltaY + heightDeltaX * heightDeltaX + HEIGHT_SCALE) | 0;

      const normalizedTileNormalX = ((heightDeltaX << 8) / tileNormalLength) | 0;
      const normalizedTileNormalY = (HEIGHT_SCALE / tileNormalLength) | 0;
      const normalizedTileNormalZ = ((heightDeltaY << 8) / tileNormalLength) | 0;

      const dot =
        normalizedTileNormalX * LIGHT_DIR_X + normalizedTileNormalY * LIGHT_DIR_Y + normalizedTileNormalZ * LIGHT_DIR_Z;
      const sunLight = (dot / lightIntensity + LIGHT_INTENSITY_BASE) | 0;

      const lightOcclusion =
        (occlusions[x - 1][y] >> 2) +
        (occlusions[x][y - 1] >> 2) +
        (occlusions[x + 1][y] >> 3) +
        (occlusions[x][y + 1] >> 3) +
        (occlusions[x][y] >> 1);

      lights[x][y] = sunLight - lightOcclusion;
    }
  }

  for (let x = 1; x < MAP_SIZE - 1; x++) {
    lights[x][0] = lights[x][1];
    lights[x][MAP_SIZE - 1] = lights[x][MAP_SIZE - 2];
  }
  for (let y = 0; y < MAP_SIZE; y++) {
    lights[0][y] = lights[1][y];
    lights[MAP_SIZE - 1][y] = lights[MAP_SIZE - 2][y];
  }

  return lights;
}

/**
 * Each overlay id's (1-based, as map squares store them) minimap HSL: a texture's average where the
 * texture loader has it, else its color, its secondary color winning; -1 where it draws nothing.
 */
export function buildOverlayMinimapHsls(
  overlayLoader: OverlayTypeLoader,
  textureLoader: TextureLoader | null | undefined,
): Map<number, number> {
  const hsls = new Map<number, number>();
  const count = overlayLoader.getCount();
  for (let i = 0; i < count; i++) {
    const type = overlayLoader.load(i);

    let overlayMinimapHsl: number;

    if (type.texture !== -1 && textureLoader && textureLoader.isSd(type.texture)) {
      overlayMinimapHsl = textureLoader.getAverageHsl(type.texture);
    } else if (type.texture !== -1 && !textureLoader) {
      hsls.set(i + 1, -1);
      continue;
    } else if (type.color === 0xff00ff) {
      hsls.set(i + 1, -1);
      continue;
    } else {
      overlayMinimapHsl = packHsl(type.hue, type.saturation, type.lightness);
    }

    if (type.secondaryColor !== -1) {
      overlayMinimapHsl = packHsl(type.secondaryHue, type.secondarySaturation, type.secondaryLightness);
    }

    hsls.set(i + 1, overlayMinimapHsl);
  }
  return hsls;
}

export interface MapSquareTerrainTarget {
  /** ABGR pixels (`ImageData` order), `width * height`. */
  readonly pixels: Uint32Array;
  readonly width: number;
  readonly height: number;
  /** Pixels per tile. */
  readonly tileScale: number;
  /** The pixel column of the square's west edge (tile x 0). */
  readonly originX: number;
  /** The pixel row of the square's north edge (the top of tile y 63). */
  readonly originY: number;
}

/**
 * Draws a map square's terrain on `level` into `target`, north up: tile (x, y) covers columns
 * `originX + x * tileScale` and rows `originY + (63 - y) * tileScale`, each `tileScale` wide, clipped
 * to the target. `blendedUnderlays` and `tileLights` are {@link blendUnderlays} and
 * {@link computeTileLights} of the same square and level (null: no underlays, flat light).
 */
export function drawMapSquareTerrain(
  target: MapSquareTerrainTarget,
  mapData: MapSquareData,
  blendedUnderlayHsl: Int32Array[] | null,
  tileLights: Int32Array[] | null,
  overlayHslMap: ReadonlyMap<number, number>,
  level = 0,
): void {
  const { pixels, width, height, tileScale, originX, originY } = target;
  for (let tileX = 0; tileX < MAP_SIZE; tileX++) {
    for (let tileY = 0; tileY < MAP_SIZE; tileY++) {
      const overlay = mapData.tileOverlays[level][tileX][tileY];
      const underlay = mapData.tileUnderlays[level][tileX][tileY];
      const rawShape = mapData.tileShapes[level][tileX][tileY];
      const shape = overlay > 0 ? rawShape + 1 : 0;
      const rotation = mapData.tileRotations[level][tileX][tileY] & 3;

      const eastX = tileX < MAP_SIZE - 1 ? tileX + 1 : tileX;
      const northY = tileY < MAP_SIZE - 1 ? tileY + 1 : tileY;

      const lightSw = tileLights ? tileLights[tileX][tileY] : LIGHT_INTENSITY_BASE;
      const lightSe = tileLights ? tileLights[eastX][tileY] : LIGHT_INTENSITY_BASE;
      const lightNe = tileLights ? tileLights[eastX][northY] : LIGHT_INTENSITY_BASE;
      const lightNw = tileLights ? tileLights[tileX][northY] : LIGHT_INTENSITY_BASE;

      const blendUnderlayHslSw = underlay > 0 && blendedUnderlayHsl ? blendedUnderlayHsl[tileX][tileY] : -1;
      const overlayMinimapHsl = overlay > 0 ? (overlayHslMap.get(overlay) ?? -1) : -1;

      const faces = buildTileFaces(
        tileScale,
        shape,
        rotation,
        lightSw,
        lightSe,
        lightNe,
        lightNw,
        blendUnderlayHslSw,
        overlayMinimapHsl,
      );
      if (faces.length === 0) {
        continue;
      }

      const canvasX = originX + tileX * tileScale;
      const canvasY = originY + (MAP_SIZE - 1 - tileY) * tileScale;

      for (const face of faces) {
        rasterGouraud(
          pixels,
          width,
          width,
          height,
          canvasY + face.localScreenY[0],
          canvasY + face.localScreenY[1],
          canvasY + face.localScreenY[2],
          canvasX + face.localScreenX[0],
          canvasX + face.localScreenX[1],
          canvasX + face.localScreenX[2],
          face.hsl[0],
          face.hsl[1],
          face.hsl[2],
        );
      }
    }
  }
}
