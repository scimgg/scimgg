import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReplayClickType } from '../../core/ReplayRecorder';
import type { PrayerFilterOptions } from '../../hooks/usePanelFilters';
import { useRafDrag } from '../../hooks/useRafDrag';
import { PRAYER } from '../../resourcePack';
import { THEME } from '../../theme';
import type { PrayerState } from '../../types/simulation';
import { PRAYER_CATEGORIES, type PrayerType } from '../../types/simulation';
import { unstretchedClientPoint } from '../../util/viewportBounds';
import { buildPrayerContextMenu, buildPrayerReorderContextMenu, useContextMenu } from '../ContextMenu';
import { NineSliceBg } from '../NineSliceBg';
import { PixelSprite } from '../PixelSprite';
import { type LayerSprite, PixelSpriteLayer } from '../PixelSpriteLayer';
import { usePanelContentScale } from '../panelContentScale';
import { buildPrayerTooltip, useTooltip } from '../Tooltip';
import { FilterMenu, type FilterMenuRow } from './FilterMenu';
import {
  filterPrayerGrid,
  PRAYER_GRID,
  type PrayerAvailability,
  type ResolvedPrayerSlot,
  resolvePrayerSlots,
  sortPrayerGrid,
} from './prayerFilterUtils';

interface PrayerContentProps {
  activePrayer: PrayerType | null;
  boostPrayers?: readonly PrayerType[];
  independentPrayers?: readonly PrayerType[];
  prayerVisualOverrides?: Readonly<Partial<Record<PrayerType, boolean>>>;
  onPrayerChange: (prayer: PrayerType | null) => void;
  onBoostPrayerChange?: (prayer: PrayerType | null) => void;
  onIndependentPrayerChange?: (prayer: PrayerType) => void;
  prayerState?: PrayerState;
  reorderMode: boolean;
  filteringEnabled: boolean;
  /** Playback owns the whole arrangement, so the controls that would edit it are withheld. */
  replayControlled?: boolean;
  /**
   * Whether the filter screen is up. Owned by `GamePanel` rather than here so a replay
   * can restore it: the screen REPLACES the grid, and a cursor recorded over an icon
   * otherwise lands on a filter row.
   */
  filterViewOpen: boolean;
  onFilterViewOpenChange: (open: boolean) => void;
  filterSettings: { hidden: string[]; order: string[] | null; filterOptions: PrayerFilterOptions };
  /**
   * Base Prayer, Defence, Attack and Strength, which the level and requirement filter rows read.
   * Omitted where no stats are configured, which gates nothing.
   */
  availability?: PrayerAvailability;
  upgradedPrayers?: boolean;
  zealPrayer?: boolean;
  onToggleHidden: (icon: string) => void;
  onReorder: (order: string[] | null) => void;
  onToggleFilterOption: (key: keyof PrayerFilterOptions) => void;
  onReplayCursorClick?: (clientX: number, clientY: number, type: ReplayClickType, nowMs?: number) => void;
  antiDragEnabled?: boolean;
  dragOnShiftOnly?: boolean;
  antiDragDelay?: number;
  antiDragCtrlToDrag?: boolean;
}

interface DragState {
  sourceIndex: number;
  startX: number;
  startY: number;
  startTime: number;
  currentX: number;
  currentY: number;
  isDragging: boolean;
  canDrag: boolean;
  dragThresholdMs: number;
}

/**
 * Prayer grid geometry, as the live client lays it out.
 *
 * The button is 34x34 — interface group 541 components 9-38, all `wh=(34,34)` —
 * and the client derives the 37 pitch from the container it parents them to. That
 * container is component 3: `wh=(8,9)` in minus mode against the 190x261 root,
 * i.e. 182x252, centered on x and bottom-aligned, so it sits at (4, 9).
 *
 * The Scim panel is 204x275, a 7px chrome inset around that 190x261 box, so the
 * first button's origin is (7+4, 7+9). Sizing the button to the 37 pitch and
 * centering the 34x34 icon in it puts every icon on a half-pixel, blurring the
 * pixel art.
 */
const COLS = 5;
const PITCH = 37;
const BUTTON = 34;
const PANEL_INSET = 7;
const START_X = PANEL_INSET + 4;
const START_Y = PANEL_INSET + 9;
/**
 * Reorder drag targets are the full pitch cells so a drop in the gutter still
 * lands on the nearest prayer. Snapped to whole pixels around each button.
 */
const GRID_X = START_X - Math.floor((PITCH - BUTTON) / 2);
const GRID_Y = START_Y - Math.floor((PITCH - BUTTON) / 2);

const DRAG_TIME_THRESHOLD_MS = 100;
const DRAG_PIXEL_THRESHOLD = 5;

const OSRS_COLORS = {
  get orange() {
    return THEME.colors.native.orange;
  },
  yellow: '#FFD700',
  white: '#ffffff',
  buttonBg: '#463a2a',
  buttonBorderLight: '#6d5a3b',
  buttonBorderDark: '#2a1f15',
};

const StoneButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }> = ({
  children,
  active,
  style,
  ...props
}) => (
  <button
    type="button"
    style={{
      position: 'relative',
      fontFamily: '"RuneScape Bold 12", sans-serif',
      fontSize: '16px',
      color: active ? OSRS_COLORS.white : OSRS_COLORS.orange,
      textShadow: '1px 1px 0 #000',
      background: 'transparent',
      border: 'none',
      borderRadius: 0,
      padding: '3px 0',
      margin: 0,
      cursor: 'default',
      outline: 'none',
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      ...style,
    }}
    {...props}
  >
    <NineSliceBg selected={active} />
    <span style={{ position: 'relative', zIndex: 1 }}>{children}</span>
  </button>
);

/** Matches the client's `<col=ffffff>` runs inside a filter label. */
const LabelHighlight: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ color: OSRS_COLORS.white }}>{children}</span>
);

export function prayerSlotOrigin(index: number): { x: number; y: number } {
  return { x: START_X + (index % COLS) * PITCH, y: START_Y + Math.floor(index / COLS) * PITCH };
}

export function getSlotIndexFromPoint(
  clientX: number,
  clientY: number,
  containerRect: DOMRect,
  scale: number,
  slotCount: number,
): number | null {
  const relX = (clientX - containerRect.left) / scale - GRID_X;
  const relY = (clientY - containerRect.top) / scale - GRID_Y;
  const col = Math.floor(relX / PITCH);
  const row = Math.floor(relY / PITCH);

  if (col < 0 || col >= COLS || row < 0) return null;

  const index = row * COLS + col;
  return index >= 0 && index < slotCount ? index : null;
}

export function isPrayerHighlighted(
  prayer: PrayerType,
  activePrayer: PrayerType | null,
  boostPrayers: readonly PrayerType[],
  visualOverrides: Readonly<Partial<Record<PrayerType, boolean>>> | undefined,
  independentPrayers: readonly PrayerType[] = [],
): boolean {
  const visualOverride = visualOverrides?.[prayer];
  if (visualOverride !== undefined) return visualOverride;
  const category = PRAYER_CATEGORIES[prayer];
  if (category === 'protection') return activePrayer === prayer;
  if (category === 'boost') return boostPrayers.includes(prayer);
  if (category === 'independent') return independentPrayers.includes(prayer);
  return false;
}

const NO_PRAYERS: readonly PrayerType[] = [];

export const PrayerContent: React.FC<PrayerContentProps> = ({
  activePrayer,
  boostPrayers = NO_PRAYERS,
  independentPrayers,
  prayerVisualOverrides,
  onPrayerChange,
  onBoostPrayerChange,
  onIndependentPrayerChange,
  prayerState,
  reorderMode,
  filteringEnabled,
  replayControlled = false,
  filterViewOpen,
  onFilterViewOpenChange,
  filterSettings,
  availability,
  upgradedPrayers,
  zealPrayer,
  onToggleHidden,
  onReorder,
  onToggleFilterOption,
  onReplayCursorClick,
  antiDragEnabled,
  dragOnShiftOnly,
  antiDragDelay,
  antiDragCtrlToDrag,
}) => {
  const { bindTooltip } = useTooltip();
  const uiScale = usePanelContentScale();
  const { bindContextMenu } = useContextMenu();
  const [dragState, setDragState] = useState<DragState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  const hoverOverlayRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(uiScale);
  const committedDragRef = useRef(false);
  scaleRef.current = uiScale;

  const hiddenSet = useMemo(() => new Set(filterSettings.hidden), [filterSettings.hidden]);
  const filterOptions = filterSettings.filterOptions;

  const sortedGrid = useMemo(() => sortPrayerGrid(filterSettings.order, PRAYER_GRID), [filterSettings.order]);
  /**
   * Every prayer keeps its cell in the (possibly reordered) book even while hidden or
   * filtered out, leaving a gap rather than letting later prayers slide up. RuneLite's
   * `PrayerReorder.rebuildPrayers` advances the slot index past hidden prayers and
   * repositions every prayer after the client's compacting redraw (RuneLite `runelite-client/.../plugins/prayer/PrayerReorder.java`). The spellbook compacts.
   */
  const slotIndexByIcon = useMemo(() => new Map(sortedGrid.map((slot, index) => [slot.icon, index])), [sortedGrid]);

  const resolvedGrid = useMemo(
    () => resolvePrayerSlots(sortedGrid, availability, { upgradedPrayers, zealPrayer }),
    [sortedGrid, availability, upgradedPrayers, zealPrayer],
  );
  const displayGrid = useMemo(
    () => filterPrayerGrid(resolvedGrid, hiddenSet, filterOptions, filteringEnabled, reorderMode, availability),
    [hiddenSet, filterOptions, filteringEnabled, reorderMode, resolvedGrid, availability],
  );
  const displayGridDragResetKey = useMemo(() => displayGrid.map((slot) => slot.icon).join('|'), [displayGrid]);
  const displayGridRef = useRef(displayGrid);
  displayGridRef.current = displayGrid;
  const previousDisplayGridDragResetKeyRef = useRef(displayGridDragResetKey);
  const handleClickRef = useRef<(slot: ResolvedPrayerSlot) => void>(() => {});
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  useEffect(() => {
    if (previousDisplayGridDragResetKeyRef.current === displayGridDragResetKey) return;
    previousDisplayGridDragResetKeyRef.current = displayGridDragResetKey;
    if (dragRef.current) {
      dragRef.current = null;
      setDragState(null);
    }
  }, [displayGridDragResetKey]);

  const getPosition = prayerSlotOrigin;

  const isActive = useCallback(
    (prayer: PrayerType): boolean =>
      isPrayerHighlighted(prayer, activePrayer, boostPrayers, prayerVisualOverrides, independentPrayers),
    [activePrayer, boostPrayers, prayerVisualOverrides, independentPrayers],
  );

  const handleClick = useCallback(
    (slot: ResolvedPrayerSlot) => {
      if (!slot.prayer || !slot.available) return;

      const category = PRAYER_CATEGORIES[slot.prayer];
      if (category === 'protection') {
        onPrayerChange(slot.prayer);
      } else if (category === 'boost') {
        onBoostPrayerChange?.(slot.prayer);
      } else if (category === 'independent') {
        onIndependentPrayerChange?.(slot.prayer);
      }
    },
    [onBoostPrayerChange, onIndependentPrayerChange, onPrayerChange],
  );

  handleClickRef.current = handleClick;

  const { startDrag: startRafDrag } = useRafDrag({
    onMove: (clientX, clientY, eventTime) => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.currentX = clientX;
      drag.currentY = clientY;

      if (!drag.isDragging) {
        if (!drag.canDrag) return;
        const dx = clientX - drag.startX;
        const dy = clientY - drag.startY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const elapsed = Math.max(0, eventTime - drag.startTime);
        if (elapsed >= drag.dragThresholdMs && distance >= DRAG_PIXEL_THRESHOLD) {
          drag.isDragging = true;
        }
      }

      if (drag.isDragging && !committedDragRef.current) {
        committedDragRef.current = true;
        setDragState({ ...drag });
      }

      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const point = unstretchedClientPoint(containerRef.current, rect, clientX, clientY);

        if (floatRef.current) {
          const x = (point.clientX - rect.left) / scaleRef.current - BUTTON / 2;
          const y = (point.clientY - rect.top) / scaleRef.current - BUTTON / 2;
          floatRef.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        }

        if (hoverOverlayRef.current && drag.isDragging) {
          const slotIndex = getSlotIndexFromPoint(
            point.clientX,
            point.clientY,
            rect,
            scaleRef.current,
            displayGridRef.current.length,
          );
          const nextHover = slotIndex !== drag.sourceIndex ? slotIndex : null;
          if (nextHover !== null) {
            const hx = GRID_X + (nextHover % COLS) * PITCH;
            const hy = GRID_Y + Math.floor(nextHover / COLS) * PITCH;
            hoverOverlayRef.current.style.display = '';
            hoverOverlayRef.current.style.transform = `translate3d(${hx}px, ${hy}px, 0)`;
          } else {
            hoverOverlayRef.current.style.display = 'none';
          }
        }
      }
    },
    onEnd: (clientX, clientY) => {
      const drag = dragRef.current;
      if (!drag) return;

      if (drag.isDragging && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const point = unstretchedClientPoint(containerRef.current, rect, clientX, clientY);
        const targetIndex = getSlotIndexFromPoint(
          point.clientX,
          point.clientY,
          rect,
          scaleRef.current,
          displayGridRef.current.length,
        );
        if (targetIndex !== null && targetIndex !== drag.sourceIndex) {
          const nextOrder = displayGridRef.current.map((slot) => slot.icon);
          const temp = nextOrder[drag.sourceIndex];
          nextOrder[drag.sourceIndex] = nextOrder[targetIndex];
          nextOrder[targetIndex] = temp;
          onReorderRef.current(nextOrder);
        }
      } else {
        const clickedSlot = displayGridRef.current[drag.sourceIndex];
        if (clickedSlot) {
          handleClickRef.current(clickedSlot);
        }
      }

      dragRef.current = null;
      committedDragRef.current = false;
      setDragState(null);
    },
  });

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, index: number) => {
      if (!reorderMode || e.button !== 0 || e.altKey) return;

      const ctrlBypass = antiDragCtrlToDrag && e.ctrlKey;
      const canDrag = ctrlBypass || !(antiDragEnabled && dragOnShiftOnly && !e.shiftKey);
      const dragThresholdMs = ctrlBypass
        ? 0
        : antiDragEnabled && !dragOnShiftOnly
          ? (antiDragDelay ?? DRAG_TIME_THRESHOLD_MS)
          : DRAG_TIME_THRESHOLD_MS;

      const state: DragState = {
        sourceIndex: index,
        startX: e.clientX,
        startY: e.clientY,
        startTime: e.timeStamp,
        currentX: e.clientX,
        currentY: e.clientY,
        isDragging: false,
        canDrag,
        dragThresholdMs,
      };
      dragRef.current = state;
      committedDragRef.current = false;
      setDragState(state);
      e.preventDefault();
      startRafDrag(e);
    },
    [antiDragCtrlToDrag, antiDragDelay, antiDragEnabled, dragOnShiftOnly, reorderMode, startRafDrag],
  );

  // Every grid icon paints into ONE canvas behind the transparent slot buttons. See
  // PixelSpriteLayer for why a canvas per sprite hitched on every tab switch.
  const gridSprites: LayerSprite[] = [];
  if (!filterViewOpen || !filteringEnabled) {
    displayGrid.forEach((slot, index) => {
      const pos = getPosition(slotIndexByIcon.get(slot.icon) ?? index);
      const box = { x: pos.x, y: pos.y, w: BUTTON, h: BUTTON };
      const supported = slot.prayer !== undefined && slot.available;
      const slotAlpha =
        dragState?.isDragging && dragState.sourceIndex === index
          ? 0.3
          : dragState !== null && !dragState.isDragging && dragState.sourceIndex === index
            ? 0.5
            : 1;
      // Activated background fills the button, under the icon.
      if (slot.prayer && isActive(slot.prayer)) {
        gridSprites.push({
          ...box,
          src: PRAYER.activatedBackground,
          width: BUTTON,
          height: BUTTON,
          opacity: slotAlpha,
        });
      }
      const iconAlpha = hiddenSet.has(slot.icon) ? 0.3 : supported ? 1 : 0.4;
      gridSprites.push({
        ...box,
        src: supported ? PRAYER.icon(slot.displayIcon) : PRAYER.iconDisabled(slot.displayIcon),
        opacity: slotAlpha * iconAlpha,
      });
    });
  }

  /**
   * The client's five filter rows, in its order and with its labels verbatim.
   */
  const filterRows: FilterMenuRow[] = [
    {
      key: 'showLowerTiers',
      label: 'Show lower tiers of tiered prayers',
      checked: filterOptions.showLowerTiers,
      onToggle: () => onToggleFilterOption('showLowerTiers'),
    },
    {
      key: 'showTieredOverMultiskill',
      label: 'Show tiered prayers even if multi-skill prayers are available',
      checked: filterOptions.showTieredOverMultiskill,
      height: 36,
      // Nothing to decide while every lower tier is already shown, which is when the
      // client grays this row out.
      disabled: filterOptions.showLowerTiers,
      onToggle: () => onToggleFilterOption('showTieredOverMultiskill'),
    },
    {
      key: 'showRapidHealing',
      label: (
        <>
          Show <LabelHighlight>Rapid Healing</LabelHighlight> prayers
        </>
      ),
      checked: filterOptions.showRapidHealing,
      onToggle: () => onToggleFilterOption('showRapidHealing'),
    },
    {
      key: 'showLackLevel',
      label: 'Show prayers you lack the Prayer level to activate',
      checked: filterOptions.showLackLevel,
      onToggle: () => onToggleFilterOption('showLackLevel'),
    },
    {
      key: 'showLackRequirements',
      label: 'Show prayers you lack the requirements to activate',
      checked: filterOptions.showLackRequirements,
      onToggle: () => onToggleFilterOption('showLackRequirements'),
    },
  ];

  return (
    <div ref={containerRef} style={{ width: 204, height: 275, position: 'relative' }}>
      <PixelSpriteLayer width={204} height={275} sprites={gridSprites} />
      {filterViewOpen && filteringEnabled ? (
        <FilterMenu rows={filterRows} />
      ) : (
        displayGrid.map((slot, index) => {
          const pos = getPosition(slotIndexByIcon.get(slot.icon) ?? index);
          const hidden = hiddenSet.has(slot.icon);

          const contextMenuProps = bindContextMenu(() => {
            if (!slot.prayer || !slot.available) {
              return reorderMode
                ? buildPrayerReorderContextMenu(slot.label, false, hidden, {
                    onToggleHidden: () => onToggleHidden(slot.icon),
                  })
                : buildPrayerContextMenu(slot.label, false, {});
            }
            const prayerActive = isActive(slot.prayer);
            return reorderMode
              ? buildPrayerReorderContextMenu(slot.label, prayerActive, hidden, {
                  onToggle: () => handleClick(slot),
                  onToggleHidden: () => onToggleHidden(slot.icon),
                })
              : buildPrayerContextMenu(slot.label, prayerActive, {
                  onToggle: () => handleClick(slot),
                });
          });

          return (
            <button
              key={slot.icon}
              type="button"
              data-prayer={slot.prayer}
              data-prayer-icon={slot.icon}
              aria-label={slot.label}
              // Never the native `disabled` attribute: a disabled button receives no mouse
              // events at all, and the slot still has to hand the tooltip below its hover.
              aria-disabled={slot.prayer !== undefined && !slot.available && !reorderMode}
              onMouseDown={(e) => {
                contextMenuProps.onMouseDown(e);
                if (e.button === 0) {
                  handleMouseDown(e, index);
                  if (!reorderMode) {
                    handleClick(slot);
                    if (slot.prayer && slot.available) {
                      const category = PRAYER_CATEGORIES[slot.prayer];
                      const handled =
                        category === 'protection' ||
                        (category === 'boost' && onBoostPrayerChange !== undefined) ||
                        (category === 'independent' && onIndependentPrayerChange !== undefined);
                      if (handled) {
                        onReplayCursorClick?.(e.clientX, e.clientY, 'yellow', e.timeStamp);
                      }
                    }
                  }
                }
              }}
              onContextMenu={contextMenuProps.onContextMenu}
              onPointerDownCapture={contextMenuProps.onPointerDownCapture}
              {...(dragState?.isDragging
                ? {}
                : bindTooltip(() => {
                    if (slot.prayer && slot.available) {
                      return buildPrayerTooltip(slot.label, isActive(slot.prayer));
                    }
                    return { lines: [{ spans: [{ text: slot.label, color: OSRS_COLORS.white }] }] };
                  }))}
              style={{
                position: 'absolute',
                left: pos.x,
                top: pos.y,
                width: BUTTON,
                height: BUTTON,
                background: 'transparent',
                border: 'none',
                borderRadius: 0,
                cursor: 'default',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                outline: 'none',
              }}
            />
          );
        })
      )}

      {dragState?.isDragging &&
        containerRef.current &&
        (() => {
          const sourceSlot = displayGrid[dragState.sourceIndex];
          if (!sourceSlot) return null;
          const drag = dragRef.current;
          const rect = containerRef.current.getBoundingClientRect();
          const point = drag ? unstretchedClientPoint(containerRef.current, rect, drag.currentX, drag.currentY) : null;
          const floatX = point ? (point.clientX - rect.left) / uiScale - BUTTON / 2 : 0;
          const floatY = point ? (point.clientY - rect.top) / uiScale - BUTTON / 2 : 0;
          const hidden = hiddenSet.has(sourceSlot.icon);
          const active = sourceSlot.prayer ? isActive(sourceSlot.prayer) : false;

          return (
            <div
              ref={floatRef}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                transform: `translate3d(${floatX}px, ${floatY}px, 0)`,
                width: BUTTON,
                height: BUTTON,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
                zIndex: 100,
              }}
            >
              <PixelSprite
                src={PRAYER.icon(sourceSlot.displayIcon)}
                alt={sourceSlot.label}
                style={{
                  opacity: hidden ? 0.3 : 1,
                  filter: active ? 'brightness(1.3) drop-shadow(0 0 2px rgba(255, 255, 200, 0.6))' : 'none',
                  pointerEvents: 'none',
                  imageRendering: 'pixelated',
                }}
              />
            </div>
          );
        })()}

      {dragState?.isDragging && (
        <div
          ref={hoverOverlayRef}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: PITCH,
            height: PITCH,
            background: 'rgba(255, 255, 255, 0.1)',
            borderRadius: '50%',
            pointerEvents: 'none',
            display: 'none',
            zIndex: 50,
          }}
        />
      )}

      {reorderMode && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            background: 'rgba(255, 0, 0, 0.08)',
            pointerEvents: 'none',
            zIndex: 1,
          }}
        />
      )}

      {/*
        Bottom bar: prayer points, and the Filters button that toggles the menu. Both stay
        put while the menu is open — the client hides only the grid and its glow, and the
        button has to survive because it is what closes the menu again.
      */}
      {prayerState && (
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            left: 0,
            right: 0,
            height: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            zIndex: 2,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              fontFamily: '"RuneScape Plain 11", sans-serif',
              fontSize: '16px',
              color: '#ffffff',
              textShadow: '1px 1px 0 #000',
            }}
          >
            <PixelSprite src={PRAYER.iconSmall} alt="" style={{ width: 17, height: 18, imageRendering: 'pixelated' }} />
            {prayerState.points} / {prayerState.maxPoints}
          </div>

          {filteringEnabled && !reorderMode && !replayControlled && (
            <StoneButton
              onClick={() => onFilterViewOpenChange(!filterViewOpen)}
              style={{ width: 56, height: 18, fontSize: '14px', padding: '1px 0' }}
              active={filterViewOpen}
            >
              Filters
            </StoneButton>
          )}
        </div>
      )}
    </div>
  );
};
