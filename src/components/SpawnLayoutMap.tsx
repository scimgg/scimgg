import type React from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeLayer } from '../hooks/useEscapeLayer';
import type { Coordinate } from '../types/simulation';
import { fitSpawnMapTileSize, type SpawnMapBounds, type SpawnMapBox, spawnMapTileBox } from './spawnMapGeometry';
import './SpawnLayoutMap.css';

export type { SpawnMapBounds } from './spawnMapGeometry';

/** A footprint's box on the plane, from its southwest tile. */
export type SpawnMapTileBox = (position: Readonly<Coordinate>, size: number, height?: number) => SpawnMapBox;

/** Drawn boxes win over expanded targets. In overlapping touch margins, choose the nearest box. */
export function nearestMapTarget(
  x: number,
  y: number,
  targets: readonly { left: number; top: number; width: number; height: number }[],
): number | null {
  let best: { index: number; distance: number; centre: number } | null = null;
  for (const [index, rect] of targets.entries()) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (Math.abs(x - cx) > Math.max(44, rect.width) / 2 || Math.abs(y - cy) > Math.max(44, rect.height) / 2) continue;
    const dx = Math.max(rect.left - x, 0, x - rect.left - rect.width);
    const dy = Math.max(rect.top - y, 0, y - rect.top - rect.height);
    const distance = dx * dx + dy * dy;
    const centre = (x - cx) ** 2 + (y - cy) ** 2;
    if (!best || distance < best.distance || (distance === best.distance && centre < best.centre))
      best = { index, distance, centre };
  }
  return best?.index ?? null;
}

/** A spawn point: its name in pickers and labels, and its southwest tile. */
export interface SpawnMapSpot {
  readonly name: string;
  readonly position: Readonly<Coordinate>;
}

/** A pillar or other block on the floor. Pressable where the map has `onObstacleToggle`. */
export interface SpawnMapObstacle {
  readonly key: string;
  readonly position: Readonly<Coordinate>;
  readonly size: number;
  readonly ariaLabel: string;
  readonly label?: string;
  readonly down?: boolean;
}

export interface SpawnLayoutMapProps<K extends string> {
  /** The plane's tiles: the arena and any margin drawn around it. */
  readonly bounds: SpawnMapBounds;
  /** Drawn first on the plane, under everything else: the floor and its grid. */
  readonly terrain: (tileBox: SpawnMapTileBox) => React.ReactNode;
  readonly spots: readonly SpawnMapSpot[];
  /** Each spot's square side, which holds the largest kind; a smaller kind sits in its SW corner. */
  readonly spotSize: number;
  /** The monsters to place, one entry each. */
  readonly kinds: readonly K[];
  /** Indexed as `spots`. */
  readonly slots: readonly (K | null)[];
  readonly kindLabel: (kind: K) => string;
  readonly kindSize: (kind: K) => number;
  readonly obstacles?: readonly SpawnMapObstacle[];
  readonly onObstacleToggle?: (key: string) => void;
  readonly playerTile: Readonly<Coordinate>;
  /** Whether a tap on bare floor moves the start (`onStartChange`); otherwise it is fixed. */
  readonly startMovable: boolean;
  readonly onSlotsChange: (slots: (K | null)[]) => void;
  readonly onStartChange: (tile: Coordinate) => void;
  /** Spots to mark with a warning, by index, each with the words it adds to the spot's name. */
  readonly flaggedSpots?: ReadonlyMap<number, string>;
  readonly actions?: React.ReactNode;
  readonly caption?: React.ReactNode;
}

/**
 * One pointer surface for placing an encounter's monsters on its spawn spots: spots
 * place/replace/remove (`kinds`, armed from the progress chips or picked per spot), pressable
 * obstacles toggle, and bare floor sets the start. The encounter supplies the plane, spots,
 * obstacles and terrain; the map owns the interaction.
 */
export function SpawnLayoutMap<K extends string>({
  bounds,
  terrain,
  spots,
  spotSize,
  kinds,
  slots,
  kindLabel,
  kindSize,
  obstacles = [],
  onObstacleToggle,
  playerTile,
  startMovable,
  onSlotsChange,
  onStartChange,
  flaggedSpots,
  actions,
  caption,
}: SpawnLayoutMapProps<K>) {
  const mapWidth = bounds.maxX - bounds.minX + 1;
  const mapHeight = bounds.maxY - bounds.minY + 1;
  const [picker, setPicker] = useState<{ index: number; left: number; top: number } | null>(null);
  const [armedKind, setArmedKind] = useState<K | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  const [plane, setPlane] = useState({ tileSize: 8, left: 0, top: 0 });
  const { minX, maxX, minY, maxY } = bounds;
  useLayoutEffect(() => {
    const map = mapRef.current!;
    const fit = { minX, maxX, minY, maxY };
    const measure = () => {
      if (!map.clientWidth || !map.clientHeight) return;
      const tileSize = fitSpawnMapTileSize(fit, map.clientWidth, map.clientHeight);
      const rect = map.getBoundingClientRect();
      // Bias toward the leading edge: a half-pixel centered host must not gain a
      // trailing overflow pixel when the integer plane exactly fills its width.
      const left = Math.floor(rect.left + (map.clientWidth - (maxX - minX + 1) * tileSize) / 2) - rect.left;
      const top = Math.floor(rect.top + (map.clientHeight - (maxY - minY + 1) * tileSize) / 2) - rect.top;
      setPlane((old) =>
        old.tileSize === tileSize && old.left === left && old.top === top ? old : { tileSize, left, top },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(map);
    return () => observer.disconnect();
  }, [minX, maxX, minY, maxY]);
  const tileBox: SpawnMapTileBox = (position, size, height = size) =>
    spawnMapTileBox(bounds, position, size, plane.tileSize, height);
  useEscapeLayer(1400, picker !== null, () => setPicker(null));
  useEffect(() => {
    if (!picker) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && pickerRef.current?.contains(event.target)) return;
      setPicker(null);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [picker]);

  const remaining = [...kinds];
  for (const kind of slots) {
    if (kind === null) continue;
    const index = remaining.indexOf(kind);
    if (index >= 0) remaining.splice(index, 1);
  }
  const armedAvailable = armedKind !== null && remaining.includes(armedKind);
  useEffect(() => {
    if (!armedAvailable) setArmedKind(null);
  }, [armedAvailable]);
  const choices = [...new Set(remaining)].filter((kind) => picker === null || kind !== slots[picker.index]);
  const swaps =
    picker !== null && slots[picker.index]
      ? slots.flatMap((kind, index) => (kind && kind !== slots[picker.index] ? [{ kind, index }] : []))
      : [];
  const place = (kind: K | null) => {
    if (!picker) return;
    const next = [...slots];
    next[picker.index] = kind;
    onSlotsChange(next);
    setPicker(null);
  };
  const selectSlot = (index: number, rect: DOMRect) => {
    const kind = slots[index];
    if (!kind && remaining.length === 0) return;
    if (!kind && armedAvailable && armedKind) {
      const next = [...slots];
      next[index] = armedKind;
      onSlotsChange(next);
      setPicker(null);
      return;
    }
    const swapCount = kind ? slots.filter((other) => other && other !== kind).length : 0;
    const height = Math.min(320, (new Set(remaining).size + (kind ? 1 : 0)) * 44 + swapCount * 52 + 40);
    setPicker({
      index,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 188)),
      top: Math.max(8, rect.bottom + height + 8 <= window.innerHeight ? rect.bottom + 4 : rect.top - height - 4),
    });
  };
  return (
    <>
      <fieldset className="spawn-progress" aria-label="Wave monsters">
        {[...new Set(kinds)].map((kind) => {
          const total = kinds.filter((entry) => entry === kind).length;
          const placed = slots.filter((entry) => entry === kind).length;
          const done = placed === total;
          return (
            <button
              key={kind}
              type="button"
              tabIndex={-1}
              className={`spawn-progress__chip spawn-kind--${kind}${done ? ' is-complete' : ''}`}
              disabled={done}
              aria-pressed={armedAvailable && armedKind === kind}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setPicker(null);
                setArmedKind(armedKind === kind ? null : kind);
              }}
            >
              <span className="spawn-progress__swatch" aria-hidden="true" />
              {kindLabel(kind)} {placed}/{total}
            </button>
          );
        })}
      </fieldset>
      <div className="spawn-map-frame">
        <div className="spawn-map__tools">{actions}</div>
        {caption}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer/touch map; game hotkeys must not become keyboard navigation. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: project keyboard policy, floor picking uses pointer/touch only. */}
        <div
          ref={mapRef}
          className="spawn-map"
          style={{ aspectRatio: `${mapWidth} / ${mapHeight}` }}
          data-testid="arena-map"
          onClick={(event) => {
            const box = planeRef.current!.getBoundingClientRect();
            const inside =
              event.clientX >= box.left &&
              event.clientX < box.right &&
              event.clientY >= box.top &&
              event.clientY < box.bottom;
            const targets = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-spawn-slot], button[data-pillar]'),
            ].filter((button) => !button.disabled);
            const nearest = inside
              ? nearestMapTarget(
                  event.clientX,
                  event.clientY,
                  targets.map((button) => (button.closest('.spawn-map__spot') ?? button).getBoundingClientRect()),
                )
              : null;
            // Programmatic button activation still uses its explicit target; pointer selection
            // arbitrates the expanded areas rather than depending on DOM stacking order.
            const target =
              nearest === null ? (event.target as Element).closest<HTMLButtonElement>('button') : targets[nearest];
            if (target?.dataset.spawnSlot !== undefined) {
              selectSlot(Number(target.dataset.spawnSlot), target.getBoundingClientRect());
              return;
            }
            if (target?.dataset.pillar) {
              onObstacleToggle?.(target.dataset.pillar);
              return;
            }
            if (!inside || !startMovable) return;
            onStartChange([
              minX + Math.floor(((event.clientX - box.left) / box.width) * mapWidth),
              maxY - Math.floor(((event.clientY - box.top) / box.height) * mapHeight),
            ]);
          }}
        >
          <div
            ref={planeRef}
            className="spawn-map__plane"
            data-compact={plane.tileSize <= 9}
            data-tile-size={plane.tileSize}
            style={{
              left: plane.left,
              top: plane.top,
              width: mapWidth * plane.tileSize,
              height: mapHeight * plane.tileSize,
            }}
          >
            {terrain(tileBox)}
            {kinds.length > 0 &&
              spots.map(({ name, position }, index) => {
                const kind = slots[index];
                const size = kind ? kindSize(kind) : spotSize;
                const note = flaggedSpots?.get(index);
                return (
                  <span
                    key={name}
                    className={`spawn-map__spot${size < spotSize ? ' has-small-npc' : ''}${note ? ' is-flagged' : ''}`}
                    data-spawn-hit={index}
                    style={tileBox(position, spotSize)}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      data-spawn-slot={index}
                      className={`spawn-map__slot${kind ? ` is-filled spawn-kind--${kind}` : ''}${size < spotSize ? ' is-small' : ''}`}
                      style={{ left: 0, bottom: 0, width: size * plane.tileSize, height: size * plane.tileSize }}
                      aria-label={`${name}: ${kind ? kindLabel(kind) : 'empty spawn'}${note ? `, ${note}` : ''}`}
                      aria-expanded={picker?.index === index}
                      onMouseDown={(event) => event.preventDefault()}
                    >
                      {kind && <span className="spawn-map__npc-label">{kindLabel(kind)}</span>}
                    </button>
                  </span>
                );
              })}
            {obstacles.map((obstacle) =>
              onObstacleToggle ? (
                <button
                  key={obstacle.key}
                  type="button"
                  tabIndex={-1}
                  className={`spawn-map__pillar${obstacle.down ? ' is-down' : ''}`}
                  data-pillar={obstacle.key}
                  style={tileBox(obstacle.position, obstacle.size)}
                  aria-label={obstacle.ariaLabel}
                  aria-pressed={obstacle.down === true}
                  onMouseDown={(event) => event.preventDefault()}
                >
                  {obstacle.label && <span className="spawn-map__pillar-label">{obstacle.label}</span>}
                </button>
              ) : (
                <span
                  key={obstacle.key}
                  className="spawn-map__pillar is-fixed"
                  data-pillar={obstacle.key}
                  style={tileBox(obstacle.position, obstacle.size)}
                  role="img"
                  aria-label={obstacle.ariaLabel}
                >
                  {obstacle.label && <span className="spawn-map__pillar-label">{obstacle.label}</span>}
                </span>
              ),
            )}
            <span
              className="spawn-map__player"
              style={tileBox(playerTile, 1)}
              role="img"
              aria-label={`Your start: ${playerTile[0]}, ${playerTile[1]}${startMovable ? '. Tap floor to move.' : ' (fixed)'}`}
            >
              <span className={`spawn-map__player-label${playerTile[1] >= maxY - 3 ? ' is-below' : ''}`}>You</span>
            </span>
          </div>
        </div>
        {picker &&
          createPortal(
            <div
              ref={pickerRef}
              className="spawn-picker"
              style={{ left: picker.left, top: picker.top }}
              role="dialog"
              aria-label={`Monster at ${spots[picker.index]!.name}`}
            >
              <p className="spawn-picker__heading">{spots[picker.index]!.name} spot</p>
              {choices.map((kind) => (
                <button
                  type="button"
                  tabIndex={-1}
                  key={kind}
                  className={`spawn-picker__choice spawn-kind--${kind}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => place(kind)}
                >
                  <span aria-hidden="true" />
                  {kindLabel(kind)}
                </button>
              ))}
              {swaps.map(({ kind, index }) => (
                <button
                  type="button"
                  tabIndex={-1}
                  key={index}
                  className={`spawn-picker__choice spawn-kind--${kind}`}
                  aria-label={`Swap with ${spots[index]!.name} ${kindLabel(kind)}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    const next = [...slots];
                    [next[index], next[picker.index]] = [next[picker.index]!, next[index]!];
                    onSlotsChange(next);
                    setPicker(null);
                  }}
                >
                  <span aria-hidden="true" />
                  <span className="spawn-picker__swap">
                    Swap {kindLabel(kind)}
                    <small>{spots[index]!.name}</small>
                  </span>
                </button>
              ))}
              {slots[picker.index] && (
                <button
                  type="button"
                  tabIndex={-1}
                  className="spawn-picker__remove"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => place(null)}
                >
                  Remove
                </button>
              )}
            </div>,
            document.body,
          )}
      </div>
    </>
  );
}
