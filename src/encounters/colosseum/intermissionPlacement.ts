/**
 * Where the modifier choice sits. A desktop centers its panel on the visible scene, which in the
 * Fixed client is not the window's middle (the side panel and the chatbox take the rest).
 *
 * The Mobile layout's sheet sits along the top of the scene, clear of the native chrome pinned
 * there (the left column, and the minimap with its orbs at the top right). In landscape the band
 * between the column and the minimap is wide enough, so the sheet sits at the top of it. In
 * portrait it is not, so the sheet drops below the minimap and spans the frame.
 */

import { osmChromeLayout } from '../../layout/osmClientLayout';
import { type OsmFrame, osmCssRect, osmLeftColumnRight } from '../../layout/osmFrame';
import type { Rect } from '../../layout/osrsClientLayout';

/** The desktop panel's place, in window CSS pixels, whole. */
export interface IntermissionScenePlacement {
  /**
   * The visible scene's edges. The panel centers vertically between `top` and `bottom` (its CSS
   * keeps it below the launcher row too), and the hidden bar horizontally between `left` and `right`.
   */
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  /** The expanded panel's own left edge and width, centered on the scene. */
  readonly panelLeft: number;
  readonly panelWidth: number;
}

const PANEL_WIDTH = 400;
/** Kept clear of the scene's edges on either side. */
const PANEL_MARGIN = 8;

export function intermissionScenePlacement(scene: Rect): IntermissionScenePlacement {
  const left = Math.round(scene.x);
  const right = Math.round(scene.x + scene.width);
  const panelWidth = Math.max(0, Math.min(PANEL_WIDTH, right - left - 2 * PANEL_MARGIN));
  return {
    top: Math.round(scene.y),
    bottom: Math.round(scene.y + scene.height),
    left,
    right,
    // Placed here rather than by auto margins, so an odd remainder cannot leave its text on a half pixel.
    panelLeft: left + Math.floor((right - left - panelWidth) / 2),
    panelWidth,
  };
}

export interface IntermissionSheetPlacement {
  /** Viewport CSS pixels, whole. */
  readonly top: number;
  readonly left: number;
  readonly width: number;
}

const SHEET_WIDTH = 380;
/** Narrower than this between the column and the minimap, the sheet goes below the minimap. */
const MIN_TOP_BAND = 320;
const GAP = 6;

export function intermissionSheetPlacement(frame: OsmFrame): IntermissionSheetPlacement {
  const map = osmCssRect(frame, osmChromeLayout(frame.size, false).mapContainer);
  const frameLeft = frame.origin.x;
  const frameRight = frame.origin.x + Math.round(frame.size.width * frame.scale);
  const besideLeft = osmLeftColumnRight(frame) + GAP;
  const besideRight = map.x - GAP;
  const beside = besideRight - besideLeft >= MIN_TOP_BAND;
  const bandLeft = beside ? besideLeft : frameLeft + GAP;
  const bandRight = beside ? besideRight : frameRight - GAP;
  const width = Math.max(0, Math.min(SHEET_WIDTH, bandRight - bandLeft));
  return {
    top: beside ? frame.origin.y + GAP : Math.round(map.y + map.height + GAP),
    left: Math.round(bandLeft + (bandRight - bandLeft - width) / 2),
    width,
  };
}
