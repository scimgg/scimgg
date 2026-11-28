import { describe, expect, it } from 'vitest';
import { OSM_INTERFACE_SCALING_DEFAULT, osmChromeLayout, osmChromeScale } from '../../../layout/osmClientLayout';
import { osmCssRect, osmFrame, osmLeftColumnRight } from '../../../layout/osmFrame';
import { FIXED_FRAME, FIXED_MINIMAP, FIXED_VIEWPORT } from '../../../layout/osrsClientLayout';
import { intermissionScenePlacement, intermissionSheetPlacement } from '../intermissionPlacement';

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

function frameFor(width: number, height: number) {
  const viewport = { width, height };
  const scale = osmChromeScale({
    interfaceScaling: OSM_INTERFACE_SCALING_DEFAULT,
    devicePixelRatio: 1,
    viewport,
    safeAreaInsets: NO_INSETS,
  });
  return osmFrame(viewport, NO_INSETS, scale);
}

describe('intermissionSheetPlacement', () => {
  it('sits along the top between the left column and the minimap in landscape', () => {
    const frame = frameFor(844, 390);
    const map = osmCssRect(frame, osmChromeLayout(frame.size, false).mapContainer);
    const sheet = intermissionSheetPlacement(frame);
    expect(sheet.top).toBe(6);
    expect(sheet.width).toBe(380);
    expect(sheet.left).toBeGreaterThan(osmLeftColumnRight(frame));
    expect(sheet.left + sheet.width).toBeLessThan(map.x);
  });

  it('drops below the minimap and spans the frame in portrait, where the top band is too narrow', () => {
    const frame = frameFor(390, 844);
    const map = osmCssRect(frame, osmChromeLayout(frame.size, false).mapContainer);
    const sheet = intermissionSheetPlacement(frame);
    expect(sheet.top).toBeGreaterThan(map.y + map.height);
    expect(sheet.width).toBe(378);
    expect(sheet.left).toBe(6);
  });
});

describe('intermissionScenePlacement', () => {
  it("centers on the Fixed client's scene, not the window, clear of its side column", () => {
    // The 765x503 Fixed frame at the window's origin: its scene is 512x334 at (4, 4).
    const placement = intermissionScenePlacement(FIXED_VIEWPORT);
    expect(placement).toEqual({ top: 4, bottom: 338, left: 4, right: 516, panelLeft: 60, panelWidth: 400 });
    expect(placement.panelLeft + placement.panelWidth / 2).toBe(260);
    expect(placement.panelLeft + placement.panelWidth / 2).not.toBe(FIXED_FRAME.width / 2);
    expect(placement.panelLeft + placement.panelWidth).toBeLessThanOrEqual(FIXED_MINIMAP.x);
  });

  it('follows the frame where the window places it, on whole pixels, and narrows to a small scene', () => {
    // A centered frame, as a wide window draws it, with a fractional offset.
    const placement = intermissionScenePlacement({ x: 300.5, y: 100.25, width: 512, height: 334 });
    expect(placement.panelLeft).toBe(357);
    expect(placement.top).toBe(100);
    const narrow = intermissionScenePlacement({ x: 0, y: 0, width: 300, height: 200 });
    expect(narrow.panelWidth).toBe(284);
    expect(narrow.panelLeft).toBe(8);
  });
});
