import type React from 'react';
import { useState } from 'react';
import { SOULREAPER_MAX_STACKS } from '../core/combat/player/soulreaper';
import { VENOM_THRESHOLD } from '../core/poison';
import type { ReplayClickType } from '../core/ReplayRecorder';
import { MINIMAP, MOBILE } from '../resourcePack';
import {
  type CompactOrbId,
  type CompactOrbsLayout,
  DEFAULT_COMPACT_ORBS_ORDER,
  isCompactOrbsOrder,
} from '../types/compactOrbs';
import type { ContextMenuContextType } from './ContextMenu';
import {
  buildPrayerOrbContextMenu,
  buildRunOrbContextMenu,
  buildSpecialOrbContextMenu,
  useContextMenu,
} from './ContextMenu';
import {
  COMPACT_ORBS_GEOMETRY,
  DESKTOP_ORB_FRAME,
  FIXED_ORBS_GEOMETRY,
  MOBILE_ORB_FRAME,
  MOBILE_ORBS_GEOMETRY,
  ORB_CIRCLE_SIZE,
  ORB_FRAME_HEIGHT,
  type OrbFrameMetrics,
} from './minimapOrbGeometry';
import { pressOrb, specialAttackShownActive } from './orbActions';
import { PixelSprite } from './PixelSprite';
import { PrayerOrbFlickSweep } from './PrayerOrbFlickSweep';
import { isPrayerFlickOrbVisible } from './prayerFlickOrb';
import { buildSpecialAttackTooltip, buildToggleRunTooltip, useTooltip } from './Tooltip';
import type { TooltipAPIContextType } from './Tooltip/tooltipTypes';

/**
 * - `arc`: the vanilla resizable layout — four orbs on an arc hugging the
 *   minimap, which has no stone beside it to sit on.
 * - `fixed`: the vanilla fixed layout — four orbs in one vertical line down the
 *   minimap block's left stone band, under the compass.
 * - `mobile`: the mobile client's own orbs (group 897), on its wider frames.
 * - anything else: a Compact Orbs layout — the minimap is hidden and the four
 *   orbs sit in the compact block described by COMPACT_ORBS_GEOMETRY.
 */
type MinimapOrbsLayout = 'arc' | 'fixed' | 'mobile' | CompactOrbsLayout;

export interface MinimapOrbsProps {
  centerX: number;
  centerY: number;
  radius: number;
  layout?: MinimapOrbsLayout;
  orbOrder?: readonly CompactOrbId[];
  currentHP: number;
  maxHP: number;
  poisonVarp?: number;
  currentPrayer: number;
  isQuickPrayerActive?: boolean;
  /**
   * Whether any prayer is burning as the CLIENT predicts it, queued clicks
   * included. Drives the orb's activated icon the same way `isRunEnabled` drives
   * the run orb's, so a prayer switched on from the prayer book reads on the orb
   * too — not just quick prayers, and on the click rather than a tick later.
   */
  hasPredictedPrayer?: boolean;
  /**
   * Whether any prayer is burning as the ENGINE has committed it — the state at
   * the last tick boundary, with queued clicks excluded. Only the flick sweep
   * reads it, and only so a flick (off then on inside one tick) cannot blink the
   * sweep out between the two clicks; see `isPrayerFlickOrbVisible`.
   */
  hasCommittedPrayer?: boolean;
  prayerEnabled?: boolean;
  prayerFlickOrbEnabled?: boolean;
  prayerFlickAlwaysOn?: boolean;
  runEnergy: number;
  specialAttack: number;
  /**
   * Soul stacks while the Soulreaper axe is worn, else undefined. The client then shows the stacks
   * out of five on the special orb, with orb_icon,16, in place of the energy; energy still
   * regenerates unseen.
   */
  soulreaperStacks?: number;
  isRunEnabled: boolean;
  isSpecialAttackActive: boolean;
  pendingSpecialAttackToggles: number;
  hasSpecialAttack: boolean;
  onRunToggle: () => void;
  onQuickPrayerToggle?: () => void;
  onQuickPrayerSetup?: () => void;
  onSpecialAttackToggle: () => void;
  onReplayCursorClick?: (clientX: number, clientY: number, type: ReplayClickType, nowMs?: number) => void;
}

interface OrbProps {
  alt: string;
  /** Which frame art the orb sits in; see `OrbFrameMetrics`. */
  mobileFrame?: boolean;
  cx: number;
  cy: number;
  current?: number;
  max?: number;
  fillSprite?: string;
  iconSprite?: string;
  iconActiveSprite?: string;
  iconSize?: number;
  fillSize?: number;
  isActive?: boolean;
  disabled?: boolean;
  /**
   * Swap to the hovered frame while the orb has an action for the pointer.
   */
  hoverable?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  overlayIcon?: string;
  overlaySize?: number;
  flickSweep?: boolean;
  contextMenuProps?: ReturnType<ContextMenuContextType['bindContextMenu']>;
  tooltipProps?: ReturnType<TooltipAPIContextType['bindTooltip']>;
  'data-tutorial'?: string;
}

const ORB_NUMBER_FONT_SIZE = ORB_CIRCLE_SIZE - 10;

const ORB_ARC_ANGLES = [283, 261, 239, 217];

function orbPosition(angleDeg: number, distance: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: distance * Math.sin(rad),
    y: -distance * Math.cos(rad),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getOrbNumberColor(current: number, max: number): string {
  if (max <= 0) {
    return 'rgb(255, 0, 0)';
  }

  const boundedCurrent = clamp(current, 0, max);
  const half = max / 2;

  if (boundedCurrent > half) {
    const red = Math.round(255 - (255 * (boundedCurrent - half)) / half);
    return `rgb(${clamp(red, 0, 255)}, 255, 0)`;
  }

  const green = Math.round((boundedCurrent * 255) / half);
  return `rgb(255, ${clamp(green, 0, 255)}, 0)`;
}

const Orb: React.FC<OrbProps> = ({
  alt,
  mobileFrame = false,
  cx,
  cy,
  current,
  max,
  fillSprite,
  iconSprite,
  iconActiveSprite,
  iconSize = 26,
  fillSize = 26,
  isActive = false,
  disabled = false,
  hoverable = false,
  onClick,
  overlayIcon,
  overlaySize = ORB_CIRCLE_SIZE - 6,
  flickSweep = false,
  contextMenuProps,
  tooltipProps,
  'data-tutorial': dataTutorial,
}) => {
  const [hovered, setHovered] = useState(false);
  const frame: OrbFrameMetrics = mobileFrame ? MOBILE_ORB_FRAME : DESKTOP_ORB_FRAME;
  const circleLeft = frame.circleLeft;
  const circleTop = frame.circleTop;
  const hasValue = current !== undefined && max !== undefined;
  const displayCurrent = hasValue ? current : 0;
  const boundedCurrent = hasValue ? clamp(current, 0, max) : 0;
  const overlayHeight = hasValue
    ? Math.floor((ORB_CIRCLE_SIZE * Math.max(0, max - boundedCurrent)) / max)
    : ORB_CIRCLE_SIZE;
  const iconLeft = circleLeft;
  const iconTop = circleTop;
  const overlayLeft = circleLeft + Math.round((ORB_CIRCLE_SIZE - overlaySize) / 2);
  const overlayTop = circleTop + Math.round((ORB_CIRCLE_SIZE - overlaySize) / 2);

  const displayedIcon = isActive && iconActiveSprite ? iconActiveSprite : iconSprite;
  const frameSprite = mobileFrame
    ? hoverable && hovered
      ? MOBILE.orbFrameHovered
      : MOBILE.orbFrame
    : hoverable && hovered
      ? MINIMAP.orbFrameHovered
      : MINIMAP.orbFrame;

  return (
    <div
      style={{
        position: 'absolute',
        left: cx - (circleLeft + ORB_CIRCLE_SIZE / 2),
        top: cy - (circleTop + ORB_CIRCLE_SIZE / 2),
        width: frame.width,
        height: frame.height,
        pointerEvents: 'none',
      }}
      data-tutorial={dataTutorial}
    >
      {hasValue && (
        <span
          style={{
            position: 'absolute',
            left: 0,
            width: circleLeft,
            top: frame.textCentreY,
            transform: 'translateY(-50%)',
            zIndex: 3,
            fontFamily: '"RuneScape Small", sans-serif',
            fontSize: ORB_NUMBER_FONT_SIZE,
            lineHeight: `${ORB_NUMBER_FONT_SIZE}px`,
            whiteSpace: 'nowrap',
            textAlign: 'center',
            overflow: 'hidden',
            color: getOrbNumberColor(boundedCurrent, max),
            textShadow: '1px 1px 0 #000',
            WebkitFontSmoothing: 'none',
          }}
        >
          {Math.floor(displayCurrent)}
        </span>
      )}

      <PixelSprite
        src={frameSprite}
        alt=""
        aria-hidden
        width={frame.width}
        height={frame.height}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          imageRendering: 'pixelated',
          opacity: disabled ? 0.45 : 1,
        }}
      />

      {(fillSprite || displayedIcon || overlayIcon) && (
        <div
          style={{
            position: 'absolute',
            left: circleLeft,
            top: circleTop,
            width: ORB_CIRCLE_SIZE,
            height: ORB_CIRCLE_SIZE,
            overflow: 'hidden',
            pointerEvents: 'none',
          }}
        >
          {fillSprite && hasValue && (
            <PixelSprite
              src={fillSprite}
              alt=""
              aria-hidden
              width={fillSize}
              height={fillSize}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                imageRendering: 'pixelated',
                opacity: disabled ? 0.45 : 1,
              }}
            />
          )}

          {overlayHeight > 0 && (
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: ORB_CIRCLE_SIZE,
                height: overlayHeight,
                overflow: 'hidden',
              }}
            >
              <PixelSprite
                src={MINIMAP.orbEmpty}
                alt=""
                aria-hidden
                width={ORB_CIRCLE_SIZE}
                height={ORB_CIRCLE_SIZE}
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  imageRendering: 'pixelated',
                }}
              />
            </div>
          )}
        </div>
      )}

      {displayedIcon && (
        <PixelSprite
          src={displayedIcon}
          alt={alt}
          width={iconSize}
          height={iconSize}
          style={{
            position: 'absolute',
            left: iconLeft,
            top: iconTop,
            imageRendering: 'pixelated',
            pointerEvents: 'none',
            opacity: disabled ? 0.45 : 1,
          }}
        />
      )}

      {overlayIcon && (
        <PixelSprite
          src={overlayIcon}
          alt=""
          aria-hidden
          width={overlaySize}
          height={overlaySize}
          style={{
            position: 'absolute',
            left: overlayLeft,
            top: overlayTop,
            imageRendering: 'pixelated',
            pointerEvents: 'none',
            opacity: disabled ? 0.45 : 1,
          }}
        />
      )}

      {flickSweep && <PrayerOrbFlickSweep />}

      <button
        type="button"
        onMouseDown={
          disabled
            ? contextMenuProps?.onMouseDown
            : (e) => {
                contextMenuProps?.onMouseDown?.(e);
                if (e.button === 0) {
                  onClick?.(e);
                }
              }
        }
        onContextMenu={contextMenuProps?.onContextMenu}
        onPointerDownCapture={contextMenuProps?.onPointerDownCapture}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: frame.width,
          height: frame.height,
          border: 'none',
          background: 'transparent',
          padding: 0,
          margin: 0,
          outline: 'none',
          cursor: 'default',
          pointerEvents: 'auto',
          // The orb frame art's top/bottom 4px strips and rightmost 4px column are transparent.
          // clip-path also clips hit-testing, so clicks on those strips fall through.
          clipPath: `inset(${circleTop}px ${frame.width - (circleLeft + ORB_CIRCLE_SIZE)}px ${frame.height - (circleTop + ORB_CIRCLE_SIZE)}px 0)`,
        }}
        {...tooltipProps}
        onMouseEnter={(e) => {
          tooltipProps?.onMouseEnter?.(e);
          if (hoverable) setHovered(true);
        }}
        onMouseLeave={() => {
          tooltipProps?.onMouseLeave?.();
          setHovered(false);
        }}
      />
    </div>
  );
};

export const MinimapOrbs: React.FC<MinimapOrbsProps> = ({
  centerX,
  centerY,
  radius,
  layout = 'arc',
  orbOrder = DEFAULT_COMPACT_ORBS_ORDER,
  currentHP,
  maxHP,
  poisonVarp,
  currentPrayer,
  isQuickPrayerActive,
  hasPredictedPrayer = false,
  hasCommittedPrayer = false,
  prayerEnabled = false,
  prayerFlickOrbEnabled = false,
  prayerFlickAlwaysOn = false,
  runEnergy,
  specialAttack,
  soulreaperStacks,
  isRunEnabled,
  isSpecialAttackActive,
  pendingSpecialAttackToggles,
  hasSpecialAttack,
  onRunToggle,
  onQuickPrayerToggle,
  onQuickPrayerSetup,
  onSpecialAttackToggle,
  onReplayCursorClick,
}) => {
  const { bindTooltip } = useTooltip();
  const { bindContextMenu } = useContextMenu();

  const specVisuallyActive = specialAttackShownActive(isSpecialAttackActive, pendingSpecialAttackToggles);

  const showPrayerFlickSweep = isPrayerFlickOrbVisible({
    prayerPluginEnabled: prayerEnabled,
    orbEnabled: prayerFlickOrbEnabled,
    prayersCommitted: hasCommittedPrayer,
    prayersPredicted: hasPredictedPrayer,
    alwaysOn: prayerFlickAlwaysOn,
  });

  const positions =
    layout === 'arc'
      ? ORB_ARC_ANGLES.map((angle) => {
          const pos = orbPosition(angle, radius + ORB_FRAME_HEIGHT / 2 - 8);
          return { x: centerX + pos.x, y: centerY + pos.y };
        })
      : layout === 'fixed'
        ? FIXED_ORBS_GEOMETRY.centers
        : layout === 'mobile'
          ? MOBILE_ORBS_GEOMETRY.centers
          : COMPACT_ORBS_GEOMETRY[layout].centers;

  // The arc and fixed layouts are the vanilla OSRS arrangements, so they always
  // use the canonical order; only the compact layouts are re-orderable. A
  // malformed order would index past the four slots, so reject it wholesale
  // rather than repairing individual lookups into a silent orb pile-up.
  const reorderable = layout !== 'arc' && layout !== 'fixed' && layout !== 'mobile';
  const mobileFrame = layout === 'mobile';
  const slots = reorderable && isCompactOrbsOrder(orbOrder) ? orbOrder : DEFAULT_COMPACT_ORBS_ORDER;
  const positionOf = (orb: CompactOrbId) => positions[slots.indexOf(orb)];

  const prayerOrbContextMenu = bindContextMenu(() =>
    buildPrayerOrbContextMenu(!!isQuickPrayerActive, {
      onToggle: () => onQuickPrayerToggle?.(),
      onSetup: () => onQuickPrayerSetup?.(),
    }),
  );

  const prayerTooltip = bindTooltip(() => ({
    lines: [
      {
        spans: [
          { text: `${isQuickPrayerActive ? 'Deactivate' : 'Activate'} `, color: '#ffffff' },
          { text: 'Quick-prayers', color: '#f5c080' },
        ],
      },
    ],
  }));

  const isPoisoned = poisonVarp !== undefined && poisonVarp > 0;
  const isVenomed = poisonVarp !== undefined && poisonVarp >= VENOM_THRESHOLD;

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 30, pointerEvents: 'none', overflow: 'visible' }}>
      <Orb
        mobileFrame={mobileFrame}
        alt="Hitpoints"
        current={currentHP}
        max={maxHP}
        fillSprite={
          isVenomed ? MINIMAP.orbHitpointsVenom : isPoisoned ? MINIMAP.orbHitpointsPoison : MINIMAP.orbHitpoints
        }
        iconSprite={currentHP <= 19 ? MINIMAP.orbHitpointsLowLifeIcon : MINIMAP.orbHitpointsIcon}
        hoverable={isPoisoned}
        cx={positionOf('hitpoints').x}
        cy={positionOf('hitpoints').y}
      />

      <Orb
        mobileFrame={mobileFrame}
        alt="Prayer"
        current={currentPrayer}
        max={99}
        fillSprite={isQuickPrayerActive ? MINIMAP.orbPrayerActivated : MINIMAP.orbPrayer}
        iconSprite={MINIMAP.orbPrayerIcon}
        iconActiveSprite={MINIMAP.orbPrayerIconActivated}
        hoverable
        isActive={hasPredictedPrayer}
        flickSweep={showPrayerFlickSweep}
        cx={positionOf('prayer').x}
        cy={positionOf('prayer').y}
        onClick={(event) => pressOrb(onQuickPrayerToggle, onReplayCursorClick, event)}
        contextMenuProps={prayerOrbContextMenu}
        tooltipProps={prayerTooltip}
      />

      <Orb
        mobileFrame={mobileFrame}
        alt="Run Energy"
        current={runEnergy}
        max={100}
        fillSprite={isRunEnabled ? MINIMAP.orbRunActivated : MINIMAP.orbRun}
        iconSprite={MINIMAP.orbRunIcon}
        iconActiveSprite={MINIMAP.orbRunIconActivated}
        hoverable
        isActive={isRunEnabled}
        cx={positionOf('run').x}
        cy={positionOf('run').y}
        onClick={(event) => pressOrb(onRunToggle, onReplayCursorClick, event)}
        contextMenuProps={bindContextMenu(() => buildRunOrbContextMenu(isRunEnabled, onRunToggle))}
        tooltipProps={bindTooltip(buildToggleRunTooltip)}
      />

      <Orb
        mobileFrame={mobileFrame}
        alt="Special Attack"
        current={soulreaperStacks ?? specialAttack}
        max={soulreaperStacks === undefined ? 100 : SOULREAPER_MAX_STACKS}
        fillSprite={specVisuallyActive ? MINIMAP.orbSpecialActivated : MINIMAP.orbSpecial}
        iconSprite={soulreaperStacks === undefined ? MINIMAP.orbSpecialIcon : MINIMAP.orbSoulreaperAxeIcon}
        isActive={specVisuallyActive}
        disabled={!hasSpecialAttack}
        hoverable={hasSpecialAttack}
        cx={positionOf('special').x}
        cy={positionOf('special').y}
        onClick={(event) => pressOrb(onSpecialAttackToggle, onReplayCursorClick, event)}
        contextMenuProps={
          hasSpecialAttack
            ? bindContextMenu(() => buildSpecialOrbContextMenu(specVisuallyActive, onSpecialAttackToggle))
            : undefined
        }
        tooltipProps={hasSpecialAttack ? bindTooltip(buildSpecialAttackTooltip) : undefined}
      />
    </div>
  );
};
