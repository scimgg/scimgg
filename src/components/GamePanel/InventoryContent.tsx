import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReplayClickType } from '../../core/ReplayRecorder';
import { isEquipInventoryAction } from '../../data/equipInventoryActions';
import { resolveDefaultInventoryAction } from '../../data/equipmentCatalog';
import { ITEM_ACTIONS, type ItemActionOption } from '../../data/itemEffects';
import { useRafDrag } from '../../hooks/useRafDrag';
import { useModifiers } from '../../input/keyState';
import type { ObjTypeLoader } from '../../rs/config/objtype/ObjTypeLoader';
import { getItemSpriteUrl } from '../../services/ItemSpriteService';
import type { Inventory, InventoryItem } from '../../types/inventory';
import { getFiniteStackQuantity, INVENTORY_SIZE, isStackableItem } from '../../types/inventory';
import { unstretchedClientPoint } from '../../util/viewportBounds';
import { buildInventoryContextMenu, useContextMenu } from '../ContextMenu';
import type { InventoryTagMenuContext } from '../ContextMenu/contextMenuBuilders';
import { InventoryStackCount } from '../InventoryStackCount';
import { PixelSprite } from '../PixelSprite';
import { type LayerSprite, PixelSpriteLayer } from '../PixelSpriteLayer';
import { usePanelContentScale } from '../panelContentScale';
import { buildInventoryTooltip, useTooltip } from '../Tooltip';
import { UnlimitedMark } from './UnlimitedMark';

interface InventoryContentProps {
  inventory?: Inventory;
  currentTick?: number;
  previewResetToken?: number;
  onEquipFromInventory?: (inventoryIndex: number) => Inventory | null | undefined;
  onUseItem?: (inventoryIndex: number, option?: ItemActionOption) => void;
  onDropItem?: (inventoryIndex: number) => void;
  onReplayCursorClick?: (clientX: number, clientY: number, type: ReplayClickType, nowMs?: number) => void;
  onSwapSlots?: (fromIndex: number, toIndex: number) => void;
  objTypeLoader?: ObjTypeLoader;
  inventoryTags?: Record<string, string>;
  showInventoryTags?: boolean;
  antiDragEnabled?: boolean;
  dragOnShiftOnly?: boolean;
  antiDragDelay?: number;
  antiDragCtrlToDrag?: boolean;
  onUntagItem?: (itemId: number) => void;
  onPickInventoryTagColor?: (itemId: number, initialColor?: string) => void;
}

/**
 * Item grid geometry, as the live client lays it out. Its container is interface group 149
 * component 0 at 190x261 — the same content box every panel tab is authored in.
 * The Scim panel is 204x275, exactly a 7px chrome inset around that box, so each
 * origin gains 7 on both axes (see skillsPanelLayout for the same derivation).
 *
 * The item component itself is 36x32, NOT the 42x36 pitch cell. Sizing the slot
 * to the pitch and centering a 36-wide sprite in it lands every icon 5px left and
 * 1px high of the client.
 */
const COLS = 4;
const SLOT_WIDTH = 42;
const SLOT_HEIGHT = 36;
const ITEM_W = 36;
const ITEM_H = 32;
const PANEL_INSET = 7;
const START_X = PANEL_INSET + 16;
const START_Y = PANEL_INSET + 8;
/**
 * Drag-drop targets are the full pitch cells, so a drop anywhere in the gutter
 * still lands on the nearest slot. Centered on the item boxes, hence the offset.
 */
const GRID_X = START_X - (SLOT_WIDTH - ITEM_W) / 2;
const GRID_Y = START_Y - (SLOT_HEIGHT - ITEM_H) / 2;

const DRAG_TIME_THRESHOLD_MS = 100;
const DRAG_PIXEL_THRESHOLD = 5;

interface DragState {
  sourceIndex: number;
  startX: number;
  startY: number;
  startTime: number;
  currentX: number;
  currentY: number;
  isDragging: boolean;
  canDrag: boolean;
  /** Shift was down on mouse-down and nothing else claimed it, so this click drops. */
  shiftDrop: boolean;
  dragThresholdMs: number;
}

export function inventorySlotOrigin(index: number): { x: number; y: number } {
  return { x: START_X + (index % COLS) * SLOT_WIDTH, y: START_Y + Math.floor(index / COLS) * SLOT_HEIGHT };
}

export function getSlotIndexFromPoint(
  clientX: number,
  clientY: number,
  containerRect: DOMRect,
  scale: number,
): number | null {
  // containerRect is in screen space (already scaled by CSS transform).
  const relX = (clientX - containerRect.left) / scale - GRID_X;
  const relY = (clientY - containerRect.top) / scale - GRID_Y;

  const col = Math.floor(relX / SLOT_WIDTH);
  const row = Math.floor(relY / SLOT_HEIGHT);

  if (col < 0 || col >= COLS || row < 0 || row >= Math.ceil(INVENTORY_SIZE / COLS)) {
    return null;
  }

  const index = row * COLS + col;
  return index < INVENTORY_SIZE ? index : null;
}

export const InventoryContent: React.FC<InventoryContentProps> = ({
  inventory,
  currentTick,
  previewResetToken,
  onEquipFromInventory,
  onUseItem,
  onDropItem,
  onReplayCursorClick,
  onSwapSlots,
  objTypeLoader,
  inventoryTags,
  showInventoryTags,
  antiDragEnabled,
  dragOnShiftOnly,
  antiDragDelay,
  antiDragCtrlToDrag,
  onUntagItem,
  onPickInventoryTagColor,
}) => {
  const { bindTooltip, updateTooltip } = useTooltip();
  const uiScale = usePanelContentScale();
  const { bindContextMenu } = useContextMenu();
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [optimisticInventory, setOptimisticInventory] = useState<Inventory | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  const hoverOverlayRef = useRef<HTMLDivElement>(null);
  const lastAuthoritativeStateRef = useRef({ inventory, currentTick, previewResetToken });
  const scaleRef = useRef(uiScale);
  const committedDragRef = useRef(false);
  scaleRef.current = uiScale;
  const displayInventory = optimisticInventory ?? inventory;

  useEffect(() => {
    const last = lastAuthoritativeStateRef.current;
    if (
      last.inventory === inventory &&
      last.currentTick === currentTick &&
      last.previewResetToken === previewResetToken
    ) {
      return;
    }
    lastAuthoritativeStateRef.current = { inventory, currentTick, previewResetToken };
    setOptimisticInventory(null);
  }, [inventory, currentTick, previewResetToken]);

  // Subscribed here rather than threaded down from App. Passing these as props puts
  // them on the simulation context object, where every Shift press invalidates it and
  // re-renders App -> GridProviders -> Grid and the whole panel tree for two booleans
  // this is the only component to read.
  const { shift: shiftHeld, ctrl: ctrlHeld } = useModifiers();

  // Anti-drag's opt-in "Require Shift to drag" claims shift for dragging; while it is
  // on, shift neither drops nor advertises Drop in the tooltip.
  const shiftMeansDrop = shiftHeld && !(antiDragEnabled && dragOnShiftOnly);

  // The tooltip factory only runs on mouse-enter, so pressing shift while already
  // hovering a slot would otherwise leave stale text on screen.
  const hoveredSlotRef = useRef<{ el: HTMLElement; itemId: number } | null>(null);
  useEffect(() => {
    const hovered = hoveredSlotRef.current;
    if (!hovered || !objTypeLoader) return;
    const content = buildInventoryTooltip(hovered.itemId, objTypeLoader, shiftMeansDrop);
    if (content) updateTooltip(hovered.el, content);
  }, [shiftMeansDrop, objTypeLoader, updateTooltip]);

  const handleItemClick = useCallback(
    (index: number, mouseDownEvent: Pick<React.MouseEvent, 'clientX' | 'clientY' | 'timeStamp'>, shiftDrop = false) => {
      if (!displayInventory || !displayInventory[index]) return;
      const item = displayInventory[index];
      if (!item) return;

      // OSRS "Shift click to drop": shift + left-click runs the item's Drop op instead
      // of its default one, and never its Use/Wield one. Every inventory item can be
      // dropped, so this is not gated on the cache.
      if (shiftDrop) {
        setOptimisticInventory(null);
        onDropItem?.(index);
        onReplayCursorClick?.(mouseDownEvent.clientX, mouseDownEvent.clientY, 'yellow', mouseDownEvent.timeStamp);
        return;
      }

      if (ITEM_ACTIONS[item.id]) {
        setOptimisticInventory(null);
        onUseItem?.(index);
        onReplayCursorClick?.(mouseDownEvent.clientX, mouseDownEvent.clientY, 'yellow', mouseDownEvent.timeStamp);
        return;
      }

      if (objTypeLoader) {
        try {
          const objType = objTypeLoader.load(item.id);
          const defaultAction = resolveDefaultInventoryAction(item.id, objType.inventoryActions);
          const action = defaultAction?.trim().toLowerCase();

          if (isEquipInventoryAction(defaultAction)) {
            const preview = onEquipFromInventory?.(index);
            if (preview) setOptimisticInventory(preview);
          } else if (action === 'eat' || action === 'drink' || action === 'invigorate' || action === 'use') {
            setOptimisticInventory(null);
            onUseItem?.(index);
            onReplayCursorClick?.(mouseDownEvent.clientX, mouseDownEvent.clientY, 'yellow', mouseDownEvent.timeStamp);
          }
        } catch {
          // Item not in registry
        }
      } else {
        const preview = onEquipFromInventory?.(index);
        if (preview) setOptimisticInventory(preview);
      }
    },
    [displayInventory, objTypeLoader, onDropItem, onEquipFromInventory, onReplayCursorClick, onUseItem],
  );

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
          const x = (point.clientX - rect.left) / scaleRef.current - ITEM_W / 2;
          const y = (point.clientY - rect.top) / scaleRef.current - ITEM_H / 2;
          floatRef.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        }

        if (hoverOverlayRef.current && drag.isDragging) {
          const slot = getSlotIndexFromPoint(point.clientX, point.clientY, rect, scaleRef.current);
          const nextHover = slot !== drag.sourceIndex ? slot : null;
          if (nextHover !== null) {
            const hx = GRID_X + (nextHover % COLS) * SLOT_WIDTH;
            const hy = GRID_Y + Math.floor(nextHover / COLS) * SLOT_HEIGHT;
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
        const targetIndex = getSlotIndexFromPoint(point.clientX, point.clientY, rect, scaleRef.current);
        if (targetIndex !== null && targetIndex !== drag.sourceIndex) {
          setOptimisticInventory(null);
          onSwapSlots?.(drag.sourceIndex, targetIndex);
        }
      } else {
        handleItemClick(
          drag.sourceIndex,
          { clientX: drag.startX, clientY: drag.startY, timeStamp: drag.startTime },
          drag.shiftDrop,
        );
      }

      dragRef.current = null;
      committedDragRef.current = false;
      setDragState(null);
    },
    // A touch drag the browser took over (or the window lost focus under) dropped nothing,
    // so the order stays as it was.
    onCancel: () => {
      dragRef.current = null;
      committedDragRef.current = false;
      setDragState(null);
    },
    // Switching tabs with an item held runs that item's action in OSRS, so a press the
    // panel unmounts under is committed rather than lost — but only while it is still a
    // press. Once it has become a drag the game abandons it, which is also the only
    // honest outcome here: the drop target was the slot under a cursor that is still
    // moving, and the grid it would have landed in no longer exists.
    //
    // No setState: this runs while the component is unmounting. The writes that matter
    // are the parent's callbacks inside handleItemClick.
    onUnmount: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      committedDragRef.current = false;
      if (!drag || drag.isDragging) return;
      handleItemClick(
        drag.sourceIndex,
        { clientX: drag.startX, clientY: drag.startY, timeStamp: drag.startTime },
        drag.shiftDrop,
      );
    },
  });

  /**
   * What a press with these modifiers may do. Read from the press's own event so stale
   * global key state cannot bypass anti-drag during rapid clicks or after focus changes.
   */
  const pressRules = useCallback(
    (press: Pick<MouseEvent, 'shiftKey' | 'ctrlKey'>) => {
      const ctrlBypass = antiDragCtrlToDrag && press.ctrlKey;
      const shiftDrop = press.shiftKey && !ctrlBypass && !(antiDragEnabled && dragOnShiftOnly);
      const canDrag = !shiftDrop && (ctrlBypass || !(antiDragEnabled && dragOnShiftOnly && !press.shiftKey));
      const dragThresholdMs = ctrlBypass
        ? 0
        : antiDragEnabled && !dragOnShiftOnly
          ? (antiDragDelay ?? DRAG_TIME_THRESHOLD_MS)
          : DRAG_TIME_THRESHOLD_MS;
      return { shiftDrop, canDrag, dragThresholdMs };
    },
    [antiDragCtrlToDrag, antiDragDelay, antiDragEnabled, dragOnShiftOnly],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, index: number) => {
      if (e.button !== 0) return;
      if (e.altKey) return;
      if (!displayInventory || !displayInventory[index]) return;

      const { shiftDrop, canDrag, dragThresholdMs } = pressRules(e);

      const state: DragState = {
        sourceIndex: index,
        startX: e.clientX,
        startY: e.clientY,
        startTime: e.timeStamp,
        currentX: e.clientX,
        currentY: e.clientY,
        isDragging: false,
        canDrag,
        shiftDrop,
        dragThresholdMs,
      };
      dragRef.current = state;
      committedDragRef.current = false;
      setDragState(state);

      e.preventDefault();
      startRafDrag(e);
    },
    [displayInventory, pressRules, startRafDrag],
  );

  /**
   * A touch pointer (see `isTouchPointer`): a press that travels past the tap slop before its long-press
   * deadline picks the item up (see `bindContextMenu`'s `onTouchDrag`). Traveling is the
   * whole threshold, so the mouse's drag delay does not apply; a press the mouse could not
   * drag (shift-to-drag without shift) is still not a drag. Nothing is clicked on the way: the
   * drag starts from here, never from a synthesized mousedown that could use the item.
   */
  const handleTouchDrag = useCallback(
    (index: number, down: PointerEvent, move: PointerEvent) => {
      if (!displayInventory?.[index] || !pressRules(down).canDrag) return;
      const state: DragState = {
        sourceIndex: index,
        startX: down.clientX,
        startY: down.clientY,
        startTime: down.timeStamp,
        currentX: move.clientX,
        currentY: move.clientY,
        isDragging: true,
        canDrag: true,
        shiftDrop: false,
        dragThresholdMs: 0,
      };
      dragRef.current = state;
      committedDragRef.current = true;
      setDragState(state);
      startRafDrag(move, down.pointerId);
    },
    [displayInventory, pressRules, startRafDrag],
  );

  const getSlotPosition = inventorySlotOrigin;

  // Negative margin compensates for the oversized layout box when rendering at display resolution
  const tagMarginX = (-ITEM_W * (uiScale - 1)) / 2;
  const tagMarginY = (-ITEM_H * (uiScale - 1)) / 2;

  const renderStackMark = (slot: InventoryItem) => {
    const quantity = getFiniteStackQuantity(slot);
    if (quantity !== undefined) return <InventoryStackCount quantity={quantity} />;
    return isStackableItem(slot.id, slot.quantity, objTypeLoader) ? <UnlimitedMark top={0} left={0} /> : null;
  };

  // A slot's own sprite, for the two cases the shared layer cannot paint: a tagged item
  // (its outline is four CSS drop-shadows) and the drag ghost (it moves every frame).
  const renderItemContent = (slot: InventoryItem, tagColor?: string) => (
    <>
      <PixelSprite
        src={getItemSpriteUrl(slot.id)}
        alt={`Item ${slot.id}`}
        style={{
          pointerEvents: 'none',
          // When tagged: render at display resolution so drop-shadow filter
          // operates at screen pixels, then scale back down to fit the slot.
          // This avoids the misaligned-outline issue from filtering a low-res
          // image that later gets magnified by the parent's CSS transform.
          ...(tagColor
            ? {
                width: ITEM_W * uiScale,
                height: ITEM_H * uiScale,
                maxWidth: ITEM_W * uiScale,
                maxHeight: ITEM_H * uiScale,
                objectFit: 'contain' as const,
                transform: `scale(${1 / uiScale})`,
                transformOrigin: 'center',
                margin: `${tagMarginY}px ${tagMarginX}px`,
                imageRendering: 'pixelated' as const,
                filter: [
                  `drop-shadow(1px 0 0.5px ${tagColor})`,
                  `drop-shadow(-1px 0 0.5px ${tagColor})`,
                  `drop-shadow(0 1px 0.5px ${tagColor})`,
                  `drop-shadow(0 -1px 0.5px ${tagColor})`,
                ].join(' '),
              }
            : {
                maxWidth: ITEM_W,
                maxHeight: ITEM_H,
                imageRendering: 'pixelated' as const,
              }),
        }}
        // The tagged branch inflates the layout box by `uiScale` and scales it
        // straight back down, so the sprite's real device footprint is one
        // panel scale — not two.
        scale={tagColor ? 1 : undefined}
      />
      {renderStackMark(slot)}
    </>
  );

  const isBeingDragged = (index: number) => dragState?.isDragging && dragState.sourceIndex === index;

  // Every item icon paints into ONE canvas behind the transparent slot buttons. See
  // PixelSpriteLayer for why a canvas per sprite hitched on every tab switch.
  const gridSprites: LayerSprite[] = [];
  for (let index = 0; index < INVENTORY_SIZE; index++) {
    const slot = displayInventory?.[index];
    if (!slot) continue;
    // Tagged items keep their own PixelSprite, so leave their slot empty here.
    if (showInventoryTags && inventoryTags?.[slot.id.toString()]) continue;
    const pos = getSlotPosition(index);
    gridSprites.push({
      src: getItemSpriteUrl(slot.id),
      x: pos.x,
      y: pos.y,
      w: ITEM_W,
      h: ITEM_H,
      opacity:
        dragState?.isDragging && dragState.sourceIndex === index
          ? 0.3
          : dragState !== null && !dragState.isDragging && dragState.sourceIndex === index
            ? 0.5
            : 1,
    });
  }

  return (
    <div ref={containerRef} style={{ width: 204, height: 275, position: 'relative' }}>
      <PixelSpriteLayer width={204} height={275} sprites={gridSprites} />
      {Array.from({ length: INVENTORY_SIZE }, (_, index) => {
        const slot = displayInventory?.[index] ?? null;
        const pos = getSlotPosition(index);
        const dragged = isBeingDragged(index);
        const pressed = dragState !== null && !dragState.isDragging && dragState.sourceIndex === index;

        const tooltipBinding =
          slot && objTypeLoader && !dragState?.isDragging
            ? bindTooltip(() => buildInventoryTooltip(slot.id, objTypeLoader, shiftMeansDrop))
            : ({} as Partial<ReturnType<typeof bindTooltip>>);

        const contextMenuHandlers =
          slot && objTypeLoader && !dragState?.isDragging
            ? bindContextMenu(
                () =>
                  buildInventoryContextMenu(
                    slot.id,
                    index,
                    objTypeLoader,
                    {
                      onUseItem: (slotIndex, option) => {
                        setOptimisticInventory(null);
                        onUseItem?.(slotIndex, option);
                      },
                      onEquipFromInventory: (slotIndex) => {
                        const preview = onEquipFromInventory?.(slotIndex);
                        if (preview) setOptimisticInventory(preview);
                      },
                      onDropItem: (slotIndex) => {
                        setOptimisticInventory(null);
                        onDropItem?.(slotIndex);
                      },
                    },
                    {
                      // Ctrl acts as an alternate to Shift: Firefox hijacks Shift+right-click
                      // (no contextmenu event fires), but Ctrl+right-click behaves normally.
                      shiftKey: shiftHeld || ctrlHeld,
                      getTag: (itemId: number) => inventoryTags?.[itemId.toString()],
                      onRemoveTag: (itemId: number) => onUntagItem?.(itemId),
                      onPickColor: (itemId: number, initialColor?: string) =>
                        onPickInventoryTagColor?.(itemId, initialColor),
                    } satisfies InventoryTagMenuContext,
                  ),
                { onTouchDrag: (down, move) => handleTouchDrag(index, down, move) },
              )
            : null;

        return (
          <button
            key={`slot-${pos.x}-${pos.y}`}
            type="button"
            aria-label={slot ? `Item ${slot.id}` : undefined}
            onMouseDown={(e) => {
              contextMenuHandlers?.onMouseDown(e);
              if (slot) handleMouseDown(e, index);
            }}
            onContextMenu={contextMenuHandlers?.onContextMenu}
            onPointerDownCapture={contextMenuHandlers?.onPointerDownCapture}
            {...tooltipBinding}
            onMouseEnter={(e) => {
              hoveredSlotRef.current = slot ? { el: e.currentTarget, itemId: slot.id } : null;
              tooltipBinding.onMouseEnter?.(e);
            }}
            onMouseLeave={() => {
              hoveredSlotRef.current = null;
              tooltipBinding.onMouseLeave?.();
            }}
            style={{
              position: 'absolute',
              left: pos.x,
              top: pos.y,
              width: ITEM_W,
              height: ITEM_H,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'default',
              border: 'none',
              background: 'transparent',
              padding: 0,
              opacity: dragged ? 0.3 : pressed ? 0.5 : 1,
              borderRadius: 2,
            }}
          >
            {slot &&
              (() => {
                const tagColor = showInventoryTags ? inventoryTags?.[slot.id.toString()] : undefined;
                return tagColor ? renderItemContent(slot, tagColor) : renderStackMark(slot);
              })()}
          </button>
        );
      })}

      {dragState?.isDragging &&
        displayInventory?.[dragState.sourceIndex] &&
        containerRef.current &&
        (() => {
          const slot = displayInventory[dragState.sourceIndex]!;
          const drag = dragRef.current;
          const rect = containerRef.current!.getBoundingClientRect();
          const point = drag ? unstretchedClientPoint(containerRef.current!, rect, drag.currentX, drag.currentY) : null;
          const floatX = point ? (point.clientX - rect.left) / uiScale - ITEM_W / 2 : 0;
          const floatY = point ? (point.clientY - rect.top) / uiScale - ITEM_H / 2 : 0;

          return (
            <div
              ref={floatRef}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                transform: `translate3d(${floatX}px, ${floatY}px, 0)`,
                width: ITEM_W,
                height: ITEM_H,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
                zIndex: 100,
              }}
            >
              {renderItemContent(slot)}
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
            width: SLOT_WIDTH,
            height: SLOT_HEIGHT,
            background: 'rgba(255, 255, 255, 0.12)',
            borderRadius: 2,
            pointerEvents: 'none',
            display: 'none',
            zIndex: 50,
          }}
        />
      )}
    </div>
  );
};
