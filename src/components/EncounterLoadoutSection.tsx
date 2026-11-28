import type React from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { isQuiverStorableAmmo } from '../core/combat/ammoCompatibility';
import {
  type CustomizableGearSlot,
  findMatchingCustomEquipmentPreset,
  getAmmoCatalog,
  getGearCatalog,
  type ImportedPresetVerificationIssue,
  isTwoHandedWeapon,
} from '../data/customEquipmentPresets';
import { isDizanasQuiver } from '../data/dizanasQuiver';
import { describeWeaponVerificationGaps } from '../data/equipmentSupport';
import { findInventoryItem, getInventoryCatalog } from '../data/inventoryItemCatalog';
import { exportInventorySetup, importInventorySetup } from '../data/inventorySetupIO';
import { EQUIPMENT_PRESETS } from '../data/playerPresets';
import { isRunePouchItem, syncRunePouchWithInventory } from '../data/runePouch';
import { getSpellCastInfo } from '../data/spellCatalog';
import { useCustomEquipmentPresets } from '../hooks/useCustomEquipmentPresets';
import { EQUIPMENT_SLOTS } from '../resourcePack';
import type { ObjTypeLoader } from '../rs/config/objtype/ObjTypeLoader';
import type { PlayerAppearance, PlayerEquipment } from '../rs/model/PlayerModelLoader';
import { getItemSpriteUrl } from '../services/ItemSpriteService';
import {
  type CombatSupplies,
  createEmptyCombatSupplies,
  type EncounterLoadout,
  type SupplyItem,
  withRunePouchSlot,
} from '../types/encounterLoadout';
import type { Inventory } from '../types/inventory';
import { createEmptyInventory, getFiniteStackQuantity } from '../types/inventory';
import type { EncounterPreset, PlayerConfig, PresetRequirements } from '../types/player';
import { PLAYER_STAT_DISPLAY_NAMES, PLAYER_STAT_KEYS, type PlayerStats } from '../types/playerState';
import { SPELLBOOK_DISPLAY_NAMES, type SpellbookType } from '../types/spellbook';
import { loadoutsEqual } from '../util/loadoutUtils';
import { copyToClipboard, readFromClipboard } from '../util/tilePackIO';
import {
  CUSTOM_PRESET_KEY,
  computePresetGating,
  fallbackLoadoutMessage,
  isPresetBlocked,
  presetSwitchedMessage,
  resolveAutoPresetKey,
  resolveSelectedPresetKey,
} from './EncounterPanel.helpers';
import {
  EQUIPMENT_GRID_COLUMNS,
  EquipmentSettings,
  type EquipmentSlotId,
  equipmentSlotCells,
} from './EquipmentSettings';
import { SELECTABLE_SPELLBOOKS } from './GamePanel/spellbookFilterUtils';
import { InventoryStackCount } from './InventoryStackCount';
import { useInventorySlotDrag } from './inventorySlotDrag';
import {
  type BlockedLoadoutOption,
  type LoadoutOption,
  LoadoutPicker,
  type LoadoutStatus,
  type RequirementChip,
  RequirementChipList,
} from './LoadoutPicker';
import { LoadoutUnverifiedBadge, LoadoutUnverifiedTooltipTrigger, verifiedItemNotes } from './LoadoutUnverifiedBadge';
import { type GridCell, useGridRovingFocus } from './loadoutGridNavigation';
import { PackImage } from './PackImage';
import { PixelSprite } from './PixelSprite';
import { PlayerSettings } from './PlayerSettings';
import { RunePouchRow } from './RunePouchRow';
import { SlotPickerPopover } from './SlotPickerPopover';
import { DisclosureChevron } from './ui/DisclosureChevron';
import { useHoverCard } from './ui/HoverCard';

const INVENTORY_SLOT_KEYS = Array.from({ length: 28 }, (_, i) => `slot-${i}`);
const INVENTORY_COLUMNS = 4;
const INVENTORY_SPRITE_BOX = { maxWidth: 32, maxHeight: 32 } as const;
const LOADOUT_STATUS_LIFETIME_MS = 4_200;
/**
 * The inventory's side of one coordinate space: the cross in columns 1-3, the inventory in the
 * columns after it. Left and right cross between them because they share a row; up and down
 * do not, because each names its own section. Built once: the roving group keeps its tab
 * stop by cell identity, so these must be the same objects on every render.
 */
const INVENTORY_GRID_CELLS: readonly GridCell[] = INVENTORY_SLOT_KEYS.map((_, index) => ({
  row: Math.floor(index / INVENTORY_COLUMNS) + 1,
  col: (index % INVENTORY_COLUMNS) + EQUIPMENT_GRID_COLUMNS + 1,
  section: 'inventory',
}));

/** Only what a quiver can hold: the worn slot also takes blessings and atlatl darts, the quiver never does. */
const QUIVER_AMMO_CATALOG = getAmmoCatalog().filter((item) => isQuiverStorableAmmo(item.id));

/** Slot names for the picker's copy. The diagram keeps its own, because it also draws ammo. */
const GEAR_SLOT_LABELS: Record<CustomizableGearSlot, string> = {
  head: 'Head',
  cape: 'Cape',
  amulet: 'Amulet',
  weapon: 'Weapon',
  body: 'Body',
  shield: 'Shield',
  legs: 'Legs',
  hands: 'Hands',
  boots: 'Boots',
  ring: 'Ring',
};

type SlotTarget =
  | { readonly kind: 'gear'; readonly slot: CustomizableGearSlot }
  /** Their own kinds, not gear slots: both stacks are committed to supplies, never to equipment. */
  | { readonly kind: 'ammo' }
  | { readonly kind: 'quiverAmmo' }
  | { readonly kind: 'inventory'; readonly index: number };

/**
 * The slot in hand. The anchor travels with it because the picker opens ON the cell:
 * position is what says which slot is being edited, and it is also where focus goes
 * back to when the slot is put down.
 */
interface SlotSelection {
  readonly target: SlotTarget;
  readonly anchor: HTMLElement;
}

/**
 * One of the two halves of the Inventory Setup round trip. The label is on the face, so what
 * the control does never depends on a card that exists only while the pointer is on it, and
 * the confirmation is that same label repainted rather than a second element arriving.
 */
const LoadoutIoButton: React.FC<{
  /**
   * Every word this button can show, rather than the one it is showing: the label box is
   * width-locked against all of them so a confirmation never widens the control under the
   * pointer, and taking the finished string instead would leave that lock guessing at the set.
   */
  idleLabel: string;
  doneLabel: string;
  /**
   * Reports in the same three places the confirmation does — word, glyph, tone — so that neither
   * outcome costs the column height. The one thing a word cannot carry, WHICH refusal it was,
   * belongs on the card and never back in a row.
   */
  outcome: IoOutcome | null;
  className: string;
  icon: React.ReactNode;
  disabled?: boolean;
  ariaLabel: string;
  /**
   * Native tooltip, and the ONLY one left in this panel. It is reserved for the one thing no
   * other channel carries: why a control the pointer can still reach will not act. Everything
   * a control's own label already says belongs on `ariaLabel` alone — a `title` repeating it
   * buys an OS-drawn box, in the system font, on the browser's own half-second delay.
   */
  title?: string;
  /**
   * The hover card that explains this button, portalled by the caller's own useHoverCard. It
   * rides beside the button rather than in its label: a superscript mark would be ornament, and
   * the card is the whole explanation.
   */
  card?: React.ReactNode;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
  onPress: () => void;
  /** Answers a press the `disabled` state refuses, so refusing is never silent. */
  onRefused?: () => void;
}> = ({
  idleLabel,
  doneLabel,
  outcome,
  className,
  icon,
  disabled = false,
  ariaLabel,
  title,
  card,
  buttonRef,
  onPress,
  onRefused,
}) => {
  const failed = outcome?.failed === true;
  const confirmed = outcome?.failed === false;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`${className}${confirmed ? ' loadout-io-btn--confirmed' : ''}${
          failed ? ' loadout-io-btn--failed' : ''
        }`}
        aria-disabled={disabled || undefined}
        aria-label={ariaLabel}
        title={title}
        onClick={() => {
          if (disabled) {
            onRefused?.();
            return;
          }
          onPress();
        }}
      >
        <svg className="loadout-io-icon" aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
          {/* The confirmation's own stroke language, turned back on itself: the tick draws its two
            strokes forward, this crosses them. Same 12x12 box, same weight, so the two outcomes
            read as one channel answering rather than two marks. */}
          {failed ? <path d="M3.5 3.5L8.5 8.5M8.5 3.5L3.5 8.5" /> : confirmed ? <path d="M2 6L5 9L10 3" /> : icon}
        </svg>
        <span className="loadout-io-label">
          <span className="loadout-io-label-face">{failed ? IO_FAILED_LABEL : confirmed ? doneLabel : idleLabel}</span>
          {/* The lock, stacked in the same grid cell so the box measures the WIDEST of the three
            words as the face rasterizes them. A hard-coded string here instead is a second place
            to edit whenever a label changes, and it silently stops locking the moment one of them
            renders wider than whatever that string was. */}
          {[idleLabel, doneLabel, IO_FAILED_LABEL].map((locked) => (
            <span key={locked} className="loadout-io-label-lock" aria-hidden="true">
              {locked}
            </span>
          ))}
        </span>
      </button>
      {card}
    </>
  );
};

interface IoOutcome {
  readonly button: 'import' | 'export';
  readonly failed: boolean;
  /**
   * What the button's own word cannot say: which of the four refusals this was, or what a
   * success could not show. Null when the press already says itself — a clean import repaints
   * every slot in the frame, and a copy that worked has nothing left to report.
   */
  readonly note: string | null;
  readonly seq: number;
}

/** Long enough to read a refusal and its recovery; a confirmation only has to be caught. */
const IO_OUTCOME_MS = { confirmed: 1_800, failed: 6_000 } as const;

const IO_FAILED_LABEL = 'Failed';

interface ImportedDraft {
  readonly suggestedName: string;
  readonly verificationIssues: readonly ImportedPresetVerificationIssue[];
}

function slotKey(target: SlotTarget): string {
  switch (target.kind) {
    case 'gear':
      return `gear:${target.slot}`;
    case 'inventory':
      return `inventory:${target.index}`;
    case 'ammo':
    case 'quiverAmmo':
      return target.kind;
  }
}

function isSameSlot(left: SlotTarget, right: SlotTarget): boolean {
  return slotKey(left) === slotKey(right);
}

function equipmentSlotTarget(slot: EquipmentSlotId): SlotTarget {
  switch (slot) {
    case 'ammo':
      return { kind: 'ammo' };
    case 'quiverAmmo':
      return { kind: 'quiverAmmo' };
    default:
      return { kind: 'gear', slot };
  }
}

/** The diagram cell a slot in hand lights up; an inventory slot lights up none of them. */
function selectedEquipmentSlot(target: SlotTarget | undefined): EquipmentSlotId | null {
  if (target === undefined) return null;
  switch (target.kind) {
    case 'gear':
      return target.slot;
    case 'ammo':
    case 'quiverAmmo':
      return target.kind;
    case 'inventory':
      return null;
  }
}

function supplyItem(itemId: number | undefined): SupplyItem | null {
  return itemId === undefined ? null : { id: itemId };
}

function toRequirementChips(unmet: PresetRequirements): RequirementChip[] {
  const chips: RequirementChip[] = [];
  for (const stat of PLAYER_STAT_KEYS) {
    const level = unmet[stat];
    if (level !== undefined) {
      chips.push({ stat, level, label: PLAYER_STAT_DISPLAY_NAMES[stat] });
    }
  }
  return chips;
}

/**
 * First free name in the `base`, `base 2`, `base 3` series, matching the accent-insensitive
 * comparison the save itself uses. The name field opens on a name its own save will accept,
 * so the duplicate-name refusal is reserved for names the player typed.
 */
function uniqueLoadoutName(base: string, taken: readonly string[]): string {
  const isTaken = (candidate: string) =>
    taken.some((name) => name.localeCompare(candidate, undefined, { sensitivity: 'accent' }) === 0);
  if (!isTaken(base)) {
    return base;
  }
  // Only `taken.length` names can collide, so one of the first that many suffixes is free.
  for (let suffix = 2; suffix <= taken.length + 1; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!isTaken(candidate)) {
      return candidate;
    }
  }
  return `${base} ${taken.length + 2}`;
}

const SETUP_SPELLBOOK_LABELS = { ...SPELLBOOK_DISPLAY_NAMES, ancient: 'Ancient' };

/**
 * The book lives on the loadout (so it travels with a preset)
 * rather than being a global setting, because which book you are on is a property of
 * the kit you brought — an Ancients Zuk setup and an Arceuus Yama setup want
 * different books.
 *
 * Rendered as one inline row rather than a tile grid: it is a secondary, two-option
 * property of the kit, and the panel body is height-capped and scrolls. Names are
 * self-identifying, so unlike the preset tiles this needs no sprite to be read at a
 * glance — and the 33x36 tab sprites would scale non-integer at row height.
 */
const SpellbookSelector: React.FC<{
  spellbook: SpellbookType;
  onSelect: (spellbook: SpellbookType) => void;
}> = ({ spellbook, onSelect }) => (
  <div className="spellbook-row">
    <span className="section-label" id="spellbook-group-label">
      Spellbook
    </span>
    {/* Native radios: the browser supplies the group semantics, roving tab stop and
        arrow-key selection, so this needs no keyboard code of its own. */}
    <div className="spellbook-options" role="radiogroup" aria-labelledby="spellbook-group-label">
      {SELECTABLE_SPELLBOOKS.map((book) => {
        const isSelected = book === spellbook;
        return (
          <label key={book} className={`spellbook-option${isSelected ? ' spellbook-option--selected' : ''}`}>
            <input
              type="radio"
              name="encounter-spellbook"
              value={book}
              checked={isSelected}
              onChange={() => onSelect(book)}
            />
            {SETUP_SPELLBOOK_LABELS[book]}
          </label>
        );
      })}
    </div>
  </div>
);

interface EncounterLoadoutSectionProps {
  onSummaryChange?: (summary: string) => void;
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  encounterKind: string;
  presetsKey: string;
  appearance: PlayerAppearance;
  stats: PlayerStats;
  encounterEquipment: PlayerEquipment;
  inventory?: Inventory;
  /** Stored combat supplies for this loadout. Required to show the spellbook selector. */
  supplies?: CombatSupplies;
  onEquipmentChange: (equipment: PlayerEquipment) => void;
  onInventoryChange: (inventory: Inventory) => void;
  /**
   * Persist a complete preset loadout (equipment + inventory + supplies) atomically.
   * When provided, preset selection and auto-switch route through it so supplies stay
   * in lockstep with equipment/inventory. Falls back to the equipment/inventory callbacks.
   */
  onLoadoutChange?: (loadout: EncounterLoadout) => void;
  /** Account-level unlock toggles, rendered inside the Player field beneath the levels. */
  accountUnlocks?: React.ReactNode;
  /** Persist edited base combat stats. When omitted, the Player editor is hidden. */
  onStatsChange?: (stats: PlayerStats) => void;
  /**
   * Report whether the live loadout matches no named set. Starting is still allowed;
   * the panel uses this only to describe what will start.
   */
  onDraftChange?: (isDraft: boolean) => void;
  /** Tells the setup export which items are stacks. Null until the cache loads. */
  objTypeLoader?: ObjTypeLoader | null;
}

export const EncounterLoadoutSection: React.FC<EncounterLoadoutSectionProps> = ({
  presetsKey,
  appearance,
  stats,
  encounterEquipment,
  inventory,
  supplies,
  onEquipmentChange,
  onInventoryChange,
  onLoadoutChange,
  onStatsChange,
  accountUnlocks,
  onDraftChange,
  onSummaryChange,
  editing = false,
  onEditingChange,
  objTypeLoader,
}) => {
  const [presetsOpen, setPresetsOpen] = useState(false);
  const shownInventory = inventory ?? createEmptyInventory();
  const showQuiverAmmo =
    isDizanasQuiver(encounterEquipment.cape) || shownInventory.some((slot) => isDizanasQuiver(slot?.id));
  const equipmentCells = equipmentSlotCells(showQuiverAmmo);
  const inventoryCellOffset = equipmentCells.length;
  const loadoutGrid = useGridRovingFocus([...equipmentCells, ...INVENTORY_GRID_CELLS]);
  const { deletePreset, getPresets, savePreset, updatePreset } = useCustomEquipmentPresets();
  const customPresets = getPresets(presetsKey);
  const [customPresetName, setCustomPresetName] = useState('');
  const [loadoutStatus, setLoadoutStatus] = useState<LoadoutStatus | null>(null);
  const [importedDraft, setImportedDraft] = useState<ImportedDraft | null>(null);
  /**
   * What the last transfer press did, on the button that made it — the ONE channel every
   * import/export outcome reports through, refusals included.
   *
   * Not the status row below the bar: that row animates 19.5px of text and an 8px margin in and
   * out again over 4.2s, so an answer there would shove the gear frame, the tiles and the whole
   * column down and back up. This carries no height at all: the word is inside a button whose
   * width is already locked, and the reason rides that button's own portalled card.
   *
   * One value rather than a flag each, because two flags make "Imported" and "Copied"
   * confirming at once a state the component can reach — it did, whenever the second press
   * landed inside the first's dwell. `seq` is what makes a repeat press restart that dwell
   * rather than ride out the first one, and it must survive any simplification: setting the
   * same value twice is a React bail-out, and the timer below would never re-arm.
   */
  const [transfer, setTransfer] = useState<IoOutcome | null>(null);
  const reportTransfer = (button: IoOutcome['button'], failed: boolean, note: string | null) =>
    setTransfer((current) => ({ button, failed, note, seq: (current?.seq ?? 0) + 1 }));
  const [settleSeq, setSettleSeq] = useState(0);
  const [namingSave, setNamingSave] = useState(false);
  const [slotSelection, setSlotSelection] = useState<SlotSelection | null>(null);
  /**
   * Which pouch slot's rune tray is open. Held apart from `slotSelection` because the two are
   * different kinds of thing: a gear slot's picker is a portalled layer anchored to a cell, and
   * this is a disclosure inside the row, which needs no anchor and takes its own space.
   */
  const [openRuneSlot, setOpenRuneSlot] = useState<number | null>(null);
  /**
   * One card per button rather than one for the pair: the pair has no label of its own to hang
   * an explanation on, and a shared card would answer for whichever button the pointer left.
   * The button's own box is the hover region, so the card needs no mark to announce it.
   *
   * `above`, because everything these two act on — the sets, the frame, the whole column — is
   * below them, and a card beside them lands on the encounter rail.
   */
  const importRef = useRef<HTMLButtonElement>(null);
  const exportRef = useRef<HTMLButtonElement>(null);
  const importRequestSeq = useRef(0);
  const invalidatePendingImport = useCallback(() => {
    importRequestSeq.current += 1;
  }, []);
  const ioCardId = useId();
  const [switchInfo, setSwitchInfo] = useState<{ note: string; desiredKey: string } | null>(null);

  useEffect(() => {
    const slotCount = supplies?.runePouch?.slots.length ?? 0;
    if (openRuneSlot !== null && openRuneSlot >= slotCount) {
      setOpenRuneSlot(null);
    }
  }, [openRuneSlot, supplies?.runePouch]);

  /**
   * Going back to the gear ends the naming the bar was holding open: the name belongs
   * to the press that saves.
   */
  const selectSlot = (target: SlotTarget, anchor: HTMLElement) => {
    setNamingSave(false);
    setSlotSelection((current) => (current && isSameSlot(current.target, target) ? null : { target, anchor }));
  };

  /**
   * Put the slot down. The keyboard asks for its focus back (Escape leaves nothing to
   * look at otherwise); a press somewhere else is already on its way to that something
   * else, so it just closes.
   */
  const dismissSlot = (restoreFocus: boolean) => {
    if (restoreFocus) {
      slotSelection?.anchor.focus();
    }
    setSlotSelection(null);
  };

  // The quiver's cell leaves with the last quiver, and a picker anchored to a cell that is no
  // longer there would open on nothing.
  if (slotSelection?.target.kind === 'quiverAmmo' && !showQuiverAmmo) {
    setSlotSelection(null);
  }

  const selectEquipmentSlot = (slot: EquipmentSlotId, anchor: HTMLElement) => {
    selectSlot(equipmentSlotTarget(slot), anchor);
  };

  /**
   * Switch spellbooks. A selected spell that belongs to the old book is cleared,
   * since the autocast picker only offers spells from the active book.
   */
  /**
   * The player moved on. Both feedback channels describe the press BEFORE this one, so both
   * retire together — a held-open refusal card left standing over a panel being edited is the
   * loudest thing on screen, and it is about an action two edits ago.
   */
  const clearFeedback = () => {
    setLoadoutStatus(null);
    setTransfer(null);
  };

  const applySpellbook = (nextSpellbook: SpellbookType) => {
    if (!onLoadoutChange || !supplies || supplies.spellbook === nextSpellbook) return;
    invalidatePendingImport();
    clearFeedback();
    const selectedSpellBook = supplies.selectedSpell ? getSpellCastInfo(supplies.selectedSpell)?.spellbook : undefined;
    onLoadoutChange({
      equipment: encounterEquipment,
      inventory: shownInventory,
      supplies: {
        ...supplies,
        spellbook: nextSpellbook,
        selectedSpell: selectedSpellBook === nextSpellbook ? supplies.selectedSpell : null,
      },
    });
  };
  const applyLoadout = useCallback(
    (loadout: EncounterLoadout) => {
      invalidatePendingImport();
      if (onLoadoutChange) {
        onLoadoutChange(loadout);
        return;
      }
      onEquipmentChange(loadout.equipment);
      onInventoryChange(loadout.inventory);
    },
    [invalidatePendingImport, onEquipmentChange, onInventoryChange, onLoadoutChange],
  );
  /**
   * A whole set lands. The slot in hand is put down with it: the picker edits the cell it is
   * anchored to, and the set has just replaced what was in that cell.
   */
  const applySetLoadout = useCallback(
    (loadout: EncounterLoadout) => {
      setSlotSelection(null);
      setOpenRuneSlot(null);
      applyLoadout(loadout);
      // Counts sets landing, so the frame's settle restarts for each one. A whole set arriving
      // repaints every slot at once; without the settle it would do so between two frames with
      // nothing to catch, and the only readable part of an import would be the two buttons
      // appearing in the bar.
      setSettleSeq((seq) => seq + 1);
    },
    [applyLoadout],
  );
  const applyPresetLoadout = useCallback(
    (preset: EncounterPreset) => {
      applySetLoadout({
        equipment: preset.equipment,
        inventory: preset.inventory,
        supplies: preset.supplies ?? createEmptyCombatSupplies(),
      });
    },
    [applySetLoadout],
  );
  const presetEntries = useMemo(() => Object.entries(EQUIPMENT_PRESETS[presetsKey] ?? {}), [presetsKey]);

  // Real (non-fallback) presets in declaration order. No Equipment is a fallback-only set:
  // it is never offered as a selectable or locked picker row when real sets exist.
  const realPresetEntries = useMemo(() => presetEntries.filter(([, preset]) => !preset.isFallback), [presetEntries]);
  const fallbackEntry = useMemo(() => presetEntries.find(([, preset]) => preset.isFallback), [presetEntries]);
  const hasRealPresets = realPresetEntries.length > 0;
  // Rows the picker may render: reals only when any exist, else the raw table (e.g. the
  // lobby's single No Equipment set) so the picker is never empty.
  const pickerEntries = hasRealPresets ? realPresetEntries : presetEntries;

  const encounterConfig = useMemo<PlayerConfig>(
    () => ({ appearance, equipment: encounterEquipment, stats }),
    [appearance, encounterEquipment, stats],
  );

  const currentLoadout = useMemo<EncounterLoadout>(
    () => ({
      equipment: encounterEquipment,
      inventory: shownInventory,
      supplies: supplies ?? createEmptyCombatSupplies(),
    }),
    [encounterEquipment, shownInventory, supplies],
  );
  const selectedPresetKey = useMemo(
    () => resolveSelectedPresetKey(presetEntries, currentLoadout),
    [presetEntries, currentLoadout],
  );
  // A saved set remains the subject of its edits, even if those edits happen to match
  // another set. Only choosing a tile, reverting, importing or saving changes that subject.
  const [lastMatched, setLastMatched] = useState<{ presetsKey: string; key: string } | null>(null);
  const originCustomPreset =
    lastMatched?.presetsKey === presetsKey && lastMatched.key.startsWith('custom:')
      ? customPresets.find((preset) => preset.id === lastMatched.key.slice('custom:'.length))
      : undefined;
  const originMatches = originCustomPreset !== undefined && loadoutsEqual(originCustomPreset.loadout, currentLoadout);
  const stockSelectionMatches =
    lastMatched?.presetsKey === presetsKey &&
    lastMatched.key === selectedPresetKey &&
    selectedPresetKey !== CUSTOM_PRESET_KEY;
  const selectedCustomPreset = originMatches
    ? originCustomPreset
    : stockSelectionMatches
      ? undefined
      : findMatchingCustomEquipmentPreset(customPresets, currentLoadout);
  const activeSelectedPresetKey = selectedCustomPreset ? `custom:${selectedCustomPreset.id}` : selectedPresetKey;
  /**
   * The live loadout matches no set at all — not one that ships, not one the player saved.
   * That is the draft state, and it is the whole of it: there is nothing to enter and
   * nothing to leave, so the panel just says so and offers the two answers.
   */
  const modifiedCustomPreset = importedDraft === null && !originMatches ? originCustomPreset : undefined;
  const isDraft =
    importedDraft !== null || modifiedCustomPreset !== undefined || activeSelectedPresetKey === CUSTOM_PRESET_KEY;
  const displayedSelectedPresetKey = isDraft ? CUSTOM_PRESET_KEY : activeSelectedPresetKey;

  // `useCustomEquipmentPresets` holds its state per caller, so a second copy of this rule in
  // the footer would go stale the moment a save lands here. One derivation, reported up.
  useEffect(() => {
    onDraftChange?.(isDraft);
  }, [isDraft, onDraftChange]);

  /**
   * The last selected/matched set, scoped to its encounter. Saved-set edits keep this
   * identity for Update and Revert; built-in drafts continue to resolve by matching.
   */
  if (
    !isDraft &&
    (lastMatched === null || lastMatched.key !== activeSelectedPresetKey || lastMatched.presetsKey !== presetsKey)
  ) {
    setLastMatched({ presetsKey, key: activeSelectedPresetKey });
  }

  const { unmetByKey, selectedUnmet } = useMemo(
    () => computePresetGating(presetEntries, stats, selectedPresetKey),
    [presetEntries, stats, selectedPresetKey],
  );

  const { options, blockedOptions } = useMemo(() => {
    const compatible: LoadoutOption[] = [];
    const blocked: BlockedLoadoutOption[] = [];
    for (const [key, preset] of pickerEntries) {
      const unmet = unmetByKey.get(key);
      // The set's defining gear: weapon and body. Two sprites identify a kit without crowding the tile.
      const iconItemIds = [preset.equipment.weapon, preset.equipment.body]
        .filter((id): id is number => id !== undefined)
        .slice(0, 2);
      const { section } = preset;
      if (isPresetBlocked(unmet)) {
        blocked.push({ key, name: preset.name, iconItemIds, section, requirements: toRequirementChips(unmet ?? {}) });
      } else {
        compatible.push({ key, name: preset.name, iconItemIds, section });
      }
    }
    for (const preset of customPresets) {
      const iconItemIds = [preset.loadout.equipment.weapon, preset.loadout.equipment.body]
        .filter((id): id is number => id !== undefined)
        .slice(0, 2);
      compatible.push({ key: `custom:${preset.id}`, name: preset.name, iconItemIds, isCustom: true });
    }
    return { options: compatible, blockedOptions: blocked };
  }, [customPresets, pickerEntries, unmetByKey]);

  const selectedPreset = EQUIPMENT_PRESETS[presetsKey]?.[selectedPresetKey];
  // Only treat the fallback as a "temporary fallback" when real sets exist; in a
  // fallback-only group (lobby) No Equipment is the legitimate, primary selection.
  const inFallbackState = hasRealPresets && selectedPreset?.isFallback === true;
  const selectedLabel =
    importedDraft !== null
      ? 'Custom loadout'
      : modifiedCustomPreset
        ? modifiedCustomPreset.name
        : selectedCustomPreset
          ? selectedCustomPreset.name
          : selectedPresetKey === CUSTOM_PRESET_KEY
            ? 'Custom loadout'
            : inFallbackState
              ? `${selectedPreset?.name ?? 'No Equipment'} (fallback)`
              : (selectedPreset?.name ?? 'Custom');

  const findCustomPreset = (presetKey: string) =>
    presetKey.startsWith('custom:')
      ? customPresets.find((preset) => preset.id === presetKey.slice('custom:'.length))
      : undefined;

  /**
   * The set Revert names. A set the player has since deleted, or one the stats have locked
   * since it was worn, resolves to nothing — and then the control is left out rather than
   * offering a way back that is not there.
   */
  const revertKey = lastMatched !== null && lastMatched.presetsKey === presetsKey ? lastMatched.key : null;
  const revertName =
    revertKey === null || isPresetBlocked(unmetByKey.get(revertKey))
      ? null
      : (findCustomPreset(revertKey)?.name ?? EQUIPMENT_PRESETS[presetsKey]?.[revertKey]?.name ?? null);

  const applyPreset = (presetKey: string) => {
    const preset = EQUIPMENT_PRESETS[presetsKey]?.[presetKey];
    if (!preset || isPresetBlocked(unmetByKey.get(presetKey))) {
      return;
    }
    applyPresetLoadout(preset);
    setSwitchInfo(null);
  };

  /** Take a set: it becomes the loadout, and whatever draft it replaces is over. */
  const selectPreset = (presetKey: string) => {
    // Match the inline-preview layout in EncounterConfigurer.css. Read at the press,
    // so resizing an open chooser needs no second responsive state owner. Desktop
    // keeps alternatives beside the preview; compact selection returns to the kit.
    if (!window.matchMedia('(min-width: 721px) and (min-height: 541px)').matches) setPresetsOpen(false);
    setLastMatched({ presetsKey, key: presetKey });
    setNamingSave(false);
    clearFeedback();
    setImportedDraft(null);
    const customPreset = findCustomPreset(presetKey);
    if (customPreset) {
      applySetLoadout(customPreset.loadout);
      setSwitchInfo(null);
      return;
    }
    applyPreset(presetKey);
  };

  /** Put the draft back on the last set it matched. Offered only while there is one. */
  const revertToMatched = () => {
    if (revertKey !== null) {
      selectPreset(revertKey);
    }
  };

  const saveCustomPreset = () => {
    const id = crypto.randomUUID();
    const result = savePreset(
      presetsKey,
      id,
      customPresetName,
      currentLoadout,
      importedDraft?.verificationIssues ?? modifiedCustomPreset?.verificationIssues,
      // The shipped sets own their names too. Without this a saved "Max Mage" sits beside the
      // shipped one, and the only thing telling them apart is which group they are drawn in.
      presetEntries.map(([, preset]) => preset.name),
    );
    switch (result.kind) {
      case 'saved':
        setLastMatched({ presetsKey, key: `custom:${id}` });
        // The edited loadout stays live, so the set just created is the one the picker
        // immediately shows as selected — and the draft state ends by being answered.
        setNamingSave(false);
        setImportedDraft(null);
        setLoadoutStatus({
          kind: 'success',
          message: `Saved preset: ${result.presets[presetsKey]?.at(-1)?.name ?? 'the preset'}.`,
        });
        return;
      case 'duplicate-name':
        setLoadoutStatus({
          kind: 'error',
          message: `A preset named ${result.name} already exists. Choose a different name.`,
        });
        return;
      case 'empty-name':
        setLoadoutStatus({ kind: 'error', message: 'Enter a preset name.' });
        return;
    }
  };

  const updateCustomPreset = () => {
    if (!modifiedCustomPreset) return;
    if (!updatePreset(presetsKey, modifiedCustomPreset.id, currentLoadout)) {
      setLoadoutStatus({
        kind: 'error',
        message: 'This preset is no longer available. Save a new preset.',
      });
      return;
    }
    setNamingSave(false);
    clearFeedback();
    setLoadoutStatus({ kind: 'success', message: `Updated preset: ${modifiedCustomPreset.name}.` });
  };

  /**
   * The save is two presses: the first asks for the name, the second keeps the draft under
   * it. Nothing holds that field open in between, and a refusal keeps it open so the
   * recovery is the control the player is already standing in.
   */
  const pressSave = () => {
    if (!namingSave) {
      setLoadoutStatus(null);
      setCustomPresetName(
        uniqueLoadoutName(
          importedDraft?.suggestedName ?? (revertName === null ? 'Custom loadout' : `${revertName} (custom)`),
          // The shipped names too, and for the same reason `saveCustomPreset` passes them: a name
          // this generates has to be one that Save will then accept.
          [...customPresets.map((preset) => preset.name), ...presetEntries.map(([, preset]) => preset.name)],
        ),
      );
      setNamingSave(true);
      return;
    }
    saveCustomPreset();
  };

  const deleteCustomPreset = (presetKey: string) => {
    if (!presetKey.startsWith('custom:')) return;
    const id = presetKey.slice('custom:'.length);
    const deleted = customPresets.find((preset) => preset.id === id);
    deletePreset(presetsKey, id);
    setLoadoutStatus({
      kind: 'success',
      message: deleted ? `Deleted preset: ${deleted.name}.` : 'Deleted the preset.',
    });
  };

  const applyImportedSetup = (
    name: string,
    loadout: EncounterLoadout,
    verificationIssues: readonly ImportedPresetVerificationIssue[],
  ): string | null => {
    setNamingSave(false);
    applySetLoadout(loadout);

    /**
     * A setup identical to a set that already exists is that set, so it is selected rather than
     * drafted. Drafting it would offer Save on something already saved, and taking that offer
     * would leave two entries for one loadout; `activeSelectedPresetKey` resolves the custom one
     * first, so the shipped tile would then report itself as coming from SAVED.
     */
    const matchedPresetKey = resolveSelectedPresetKey(presetEntries, loadout);
    // Custom before shipped, the order `activeSelectedPresetKey` resolves in, so the name
    // reported here is the one the bar is about to read back.
    const matchedName =
      findMatchingCustomEquipmentPreset(customPresets, loadout)?.name ??
      (matchedPresetKey === CUSTOM_PRESET_KEY ? undefined : EQUIPMENT_PRESETS[presetsKey]?.[matchedPresetKey]?.name);
    // Import is a new setup, never an implicit replacement for the saved set worn before it.
    const matchedCustom = findMatchingCustomEquipmentPreset(customPresets, loadout);
    if (matchedName !== undefined) {
      setLastMatched({ presetsKey, key: matchedCustom ? `custom:${matchedCustom.id}` : matchedPresetKey });
    }
    setImportedDraft(matchedName === undefined ? { suggestedName: name, verificationIssues } : null);

    const omittedCount = verificationIssues.filter((issue) => issue.omitted).length;
    const omitted =
      omittedCount === 0
        ? ''
        : ` ${omittedCount} unsupported ${omittedCount === 1 ? 'item was' : 'items were'} left out.`;
    // Landing on a set that already exists is the one import with nothing to see: no draft
    // opens, and when it is the set already selected the frame repaints to what it was already
    // showing, leaving the mark's tick confirming an import that looks like it did nothing.
    if (matchedName !== undefined) {
      return `This setup matches ${matchedName}, now selected.${omitted}`;
    }
    // A clean import says itself: the readout turns to Custom (unsaved), the Import button
    // gives way to Save and Revert, the frame's border goes dashed and every slot repaints
    // with what landed. A line repeating that costs the column 14px to add nothing. What was
    // left out is the one thing none of those can show, so that is the only thing reported.
    if (omittedCount === 0) {
      return null;
    }
    return `Imported ${name}.${omitted}`;
  };

  /**
   * What the frame is currently showing, under the name the bar reads back. The live loadout
   * rather than the selected set's stored copy: `resolveSelectedPresetKey` compares equipment
   * and inventory only, so a shipped set stays selected across a spellbook change, and the
   * stored copy would export a setup on a book the frame is not showing.
   */
  const exportName =
    importedDraft?.suggestedName ?? selectedCustomPreset?.name ?? selectedPreset?.name ?? 'Custom loadout';
  const importOutcome = transfer?.button === 'import' ? transfer : null;
  const exportOutcome = transfer?.button === 'export' ? transfer : null;
  /**
   * The same card, carrying whichever of the two things is worth reading. Idle it explains the
   * button; after a press with something to report it holds that instead.
   *
   * Only a REFUSAL opens it unasked. A refusal blocks the player and its recovery is the next
   * thing they need, so a reason nobody hovers for is a reason nobody reads. A partial success
   * does not block anything — the frame has already repainted with what landed — so it waits to
   * be asked, and forcing it open would put a second self-opening surface in a panel whose
   * whole discipline is that attention is spent rarely.
   */
  const importCard = useHoverCard({
    content: importOutcome?.note ?? 'Import Inventory Setup string from clipboard.',
    anchorRef: importRef,
    regionRef: importRef,
    placement: 'above',
    dwellMs: 90,
    cardId: `${ioCardId}-import`,
    forceOpen: importOutcome?.failed === true,
    cardClassName:
      importOutcome?.note == null
        ? undefined
        : `hover-card--outcome${importOutcome.failed ? ' hover-card--outcome-failed' : ''}`,
    // `forceOpen` without this is a card Escape cannot close: the prop reopens it on the very
    // next render. Retiring the outcome is what closes it.
    onDismiss: () => setTransfer(null),
  });
  const exportCard = useHoverCard({
    content: exportOutcome?.note ?? 'Export Inventory Setup string to clipboard.',
    anchorRef: exportRef,
    regionRef: exportRef,
    placement: 'above',
    dwellMs: 90,
    cardId: `${ioCardId}-export`,
    forceOpen: exportOutcome?.failed === true,
    cardClassName:
      exportOutcome?.note == null
        ? undefined
        : `hover-card--outcome${exportOutcome.failed ? ' hover-card--outcome-failed' : ''}`,
    onDismiss: () => setTransfer(null),
  });
  /**
   * A refusal is announced by its reason; a success by the sentence the label's swap cannot
   * speak. Never both, and never nothing: this region is the only path a reader has to either,
   * so an outcome that resolved to an empty string would be an outcome they never heard.
   */
  const transferAnnouncement = !transfer
    ? ''
    : (transfer.note ??
      (transfer.button === 'export'
        ? `Copied ${exportName} as an Inventory Setup.`
        : 'Imported Inventory Setup from the clipboard.'));
  /**
   * A draft matches no set, so `exportName` would fall back to "Custom loadout" and write a
   * RuneLite setup under that name. Export requires a named preset; starting does not.
   */
  const exportDisabled = isDraft;

  /**
   * What a copy produces is invisible, so the press itself has to carry the answer — and a
   * refusal is the answer that needs carrying most. Both land in the same place now: the word in
   * the button, and the reason in that button's own card.
   */
  const exportSetupToClipboard = async () => {
    const copied = await copyToClipboard(exportInventorySetup(exportName, currentLoadout, objTypeLoader));
    reportTransfer('export', !copied, copied ? null : 'Your browser refused clipboard access. Allow it and try again.');
  };

  const importSetupFromClipboard = async () => {
    const requestSeq = importRequestSeq.current + 1;
    importRequestSeq.current = requestSeq;
    const text = await readFromClipboard();
    if (importRequestSeq.current !== requestSeq) return;
    if (!text) {
      reportTransfer('import', true, 'Nothing readable in the clipboard. Copy a setup, then try again.');
      return;
    }
    const result = importInventorySetup(text);
    if (result.kind === 'error') {
      reportTransfer('import', true, result.message);
      return;
    }
    reportTransfer('import', false, applyImportedSetup(result.name, result.loadout, result.verificationIssues));
  };

  useEffect(() => {
    return invalidatePendingImport;
  }, [invalidatePendingImport]);

  useEffect(() => {
    if (loadoutStatus === null) {
      return;
    }
    const timeout = window.setTimeout(() => setLoadoutStatus(null), LOADOUT_STATUS_LIFETIME_MS);
    return () => window.clearTimeout(timeout);
  }, [loadoutStatus]);

  useEffect(() => {
    if (transfer === null) {
      return;
    }
    const lifetime = transfer.failed ? IO_OUTCOME_MS.failed : IO_OUTCOME_MS.confirmed;
    const timeout = window.setTimeout(() => setTransfer(null), lifetime);
    return () => window.clearTimeout(timeout);
  }, [transfer]);

  const noteContextRef = useRef(presetsKey);
  useEffect(() => {
    if (noteContextRef.current !== presetsKey) {
      noteContextRef.current = presetsKey;
      invalidatePendingImport();
      setSwitchInfo(null);
      setLoadoutStatus(null);
      setImportedDraft(null);
      setNamingSave(false);
    }
  }, [invalidatePendingImport, presetsKey]);

  // A draft matches no preset at all, so `resolveAutoPresetKey` returns null for it and an
  // in-progress edit is never rewritten.
  useEffect(() => {
    if (isDraft || selectedCustomPreset) return;
    const targetKey = resolveAutoPresetKey({
      realPresetEntries,
      fallbackEntry,
      unmetByKey,
      selectedPresetKey,
      selectedPreset,
    });
    if (targetKey === null) {
      return;
    }
    const targetPreset = EQUIPMENT_PRESETS[presetsKey]?.[targetKey];
    if (!targetPreset) {
      return;
    }
    const switchedRealToReal = selectedPreset?.isFallback !== true && targetPreset.isFallback !== true;
    applyPresetLoadout(targetPreset);
    setSwitchInfo(
      switchedRealToReal
        ? {
            note: presetSwitchedMessage(selectedPreset?.name ?? 'Your loadout', targetPreset.name),
            desiredKey: selectedPresetKey,
          }
        : null,
    );
  }, [
    isDraft,
    selectedCustomPreset,
    realPresetEntries,
    fallbackEntry,
    unmetByKey,
    selectedPreset,
    selectedPresetKey,
    presetsKey,
    applyPresetLoadout,
  ]);

  // Once the stats meet the set the user was pushed off of, retire the note + limiting marks.
  useEffect(() => {
    if (switchInfo && !isPresetBlocked(unmetByKey.get(switchInfo.desiredKey))) {
      setSwitchInfo(null);
    }
  }, [switchInfo, unmetByKey]);

  const desiredUnmet = switchInfo ? (unmetByKey.get(switchInfo.desiredKey) ?? {}) : {};
  // In the fallback state, guide the player toward the highest-priority real set by
  // surfacing its unmet levels (it is first in declaration order).
  const firstRealEntry = realPresetEntries[0];
  const firstRealUnmet = firstRealEntry ? (unmetByKey.get(firstRealEntry[0]) ?? {}) : {};
  const limitingRequirements =
    Object.keys(desiredUnmet).length > 0 ? desiredUnmet : inFallbackState ? firstRealUnmet : selectedUnmet;

  const applyGear = (slot: CustomizableGearSlot, itemId: number | undefined) => {
    const equipment: PlayerEquipment = { ...encounterEquipment };
    if (itemId === undefined) {
      delete equipment[slot];
    } else {
      equipment[slot] = itemId;
    }
    if (slot === 'weapon' && isTwoHandedWeapon(equipment.weapon)) {
      delete equipment.shield;
    }
    if (slot === 'shield' && equipment.shield !== undefined && isTwoHandedWeapon(equipment.weapon)) {
      delete equipment.weapon;
    }
    clearFeedback();
    applyLoadout({ ...currentLoadout, equipment });
  };

  /** Set or clear an inventory slot. Newly selected finite stacks start with one item. */
  const applyInventoryItem = (index: number, itemId: number | undefined) => {
    const next = [...shownInventory];
    const replaced = next[index]?.id;
    if (itemId !== replaced) next[index] = itemId === undefined ? null : { id: itemId };
    clearFeedback();
    // An imported setup can carry `rp` contents with no pouch item in the inventory at all,
    // so syncing on every edit would silently delete those runes on the next unrelated swap.
    const touchesPouch = isRunePouchItem(replaced) || isRunePouchItem(itemId);
    if (touchesPouch) {
      setOpenRuneSlot(null);
    }
    applyLoadout({
      ...currentLoadout,
      inventory: next,
      supplies: touchesPouch
        ? { ...currentLoadout.supplies, runePouch: syncRunePouchWithInventory(next, currentLoadout.supplies.runePouch) }
        : currentLoadout.supplies,
    });
  };

  /**
   * Trade two inventory slots, which is the drag's only commit. It goes through the same
   * `applyLoadout` every other slot edit does, so a rearranged kit persists, matches and
   * exports exactly like one edited a slot at a time.
   *
   * No rune-pouch sync, unlike {@link applyInventoryItem}: moving cells around cannot add or
   * remove a pouch, and the contents belong to the pouch rather than to the square it sits in.
   */
  const swapInventorySlots = (from: number, to: number) => {
    if (from === to) return;
    const next = [...shownInventory];
    const carried = next[from] ?? null;
    next[from] = next[to] ?? null;
    next[to] = carried;
    clearFeedback();
    applyLoadout({ ...currentLoadout, inventory: next });
  };

  const inventoryDrag = useInventorySlotDrag({
    canLift: (index) => shownInventory[index] != null,
    // By value: the app hands over a fresh copy of the same inventory on unrelated renders.
    contentsKey: shownInventory.map((slot) => (slot ? `${slot.id}x${slot.quantity ?? ''}` : '')).join(),
    onSwap: swapInventorySlots,
    // A picker is the other answer to "what goes in this slot", and it is a layer over the
    // panel: left open it would sit on top of the grid the item is being carried across.
    onLift: () => setSlotSelection(null),
  });
  /** What the pointer is holding, for the sprite that follows it. */
  const carriedItem = inventoryDrag.carrying === null ? null : (shownInventory[inventoryDrag.carrying] ?? null);

  const applyRunePouchSlot = (slotIndex: number, itemId: number | undefined) => {
    const runePouch = currentLoadout.supplies.runePouch;
    if (!runePouch) return;
    clearFeedback();
    applyLoadout({
      ...currentLoadout,
      supplies: {
        ...currentLoadout.supplies,
        runePouch: withRunePouchSlot(runePouch, slotIndex, itemId === undefined ? null : { id: itemId }),
      },
    });
  };

  /**
   * Ammunition is committed to supplies, which is why it cannot ride `applyGear`:
   * PlayerEquipment has no ammo key to write. The worn slot and the quiver hold two
   * separate stacks, and each picker edits only its own.
   */
  const applyAmmo = (itemId: number | undefined) => {
    applyLoadout({ ...currentLoadout, supplies: { ...currentLoadout.supplies, equippedAmmo: supplyItem(itemId) } });
  };
  const applyQuiverAmmo = (itemId: number | undefined) => {
    applyLoadout({ ...currentLoadout, supplies: { ...currentLoadout.supplies, quiverAmmo: supplyItem(itemId) } });
  };

  const inventoryItemName = (itemId: number | undefined): string =>
    itemId === undefined ? 'empty' : (findInventoryItem(itemId)?.name ?? 'unsupported item');

  /**
   * The same fact cased for a heading rather than for the middle of the slot's aria sentence,
   * which is where {@link inventoryItemName} is read and why its fallback is lowercase. Only the
   * fallback differs — a catalog name arrives already cased.
   */
  const inventoryItemTitle = (itemId: number | undefined): string =>
    (itemId === undefined ? undefined : findInventoryItem(itemId)?.name) ?? 'Unsupported item';

  /**
   * The picker for the slot in hand, in a layer above the panel. Keyed by the slot so
   * moving to another one replays the entrance from its cell: the change of subject is
   * the feedback.
   */
  const renderSlotPicker = () => {
    if (!slotSelection) {
      return null;
    }
    const { target, anchor } = slotSelection;
    switch (target.kind) {
      case 'gear': {
        const label = GEAR_SLOT_LABELS[target.slot];
        return (
          <SlotPickerPopover
            key={slotKey(target)}
            anchor={anchor}
            dialogLabel={`Edit ${label.toLowerCase()} slot`}
            searchLabel={`Search supported ${label.toLowerCase()} gear`}
            listLabel={`${label} gear`}
            catalogNoun={`${label.toLowerCase()} gear`}
            catalog={getGearCatalog(target.slot)}
            currentItemId={encounterEquipment[target.slot]}
            emptyIcon={<PackImage className="slot-picker__silhouette" src={EQUIPMENT_SLOTS[target.slot]} alt="" />}
            onChoose={(itemId) => applyGear(target.slot, itemId)}
            onDismiss={dismissSlot}
          />
        );
      }
      case 'ammo':
        return (
          <SlotPickerPopover
            key={slotKey(target)}
            anchor={anchor}
            dialogLabel="Edit ammunition slot"
            searchLabel="Search supported ammunition"
            listLabel="Ammunition"
            catalogNoun="ammunition"
            catalog={getAmmoCatalog()}
            currentItemId={supplies?.equippedAmmo?.id}
            emptyIcon={<PackImage className="slot-picker__silhouette" src={EQUIPMENT_SLOTS.ammo} alt="" />}
            onChoose={applyAmmo}
            onDismiss={dismissSlot}
          />
        );
      case 'quiverAmmo':
        return (
          <SlotPickerPopover
            key={slotKey(target)}
            anchor={anchor}
            dialogLabel="Edit quiver ammunition"
            searchLabel="Search supported quiver ammunition"
            listLabel="Quiver ammunition"
            catalogNoun="ammunition"
            catalog={QUIVER_AMMO_CATALOG}
            currentItemId={supplies?.quiverAmmo?.id}
            emptyIcon={<PackImage className="slot-picker__silhouette" src={EQUIPMENT_SLOTS.ammo} alt="" />}
            onChoose={applyQuiverAmmo}
            onDismiss={dismissSlot}
          />
        );
      case 'inventory':
        return (
          <SlotPickerPopover
            key={slotKey(target)}
            anchor={anchor}
            dialogLabel={`Edit inventory slot ${target.index + 1}`}
            searchLabel="Search supported inventory items"
            listLabel="Inventory items"
            // Singular: the noun is the subject of "No supported ___ matches", and the gear side
            // hands it a mass noun ("weapon gear"). A plural here made the sentence disagree.
            catalogNoun="inventory item"
            catalog={getInventoryCatalog()}
            currentItemId={shownInventory[target.index]?.id}
            onChoose={(itemId) => applyInventoryItem(target.index, itemId)}
            onDismiss={dismissSlot}
          />
        );
    }
  };

  useEffect(() => onSummaryChange?.(selectedLabel), [selectedLabel, onSummaryChange]);

  return (
    <section
      className={`loadout-section${isDraft ? ' loadout-section--drafting' : ''}${presetsOpen ? ' loadout-section--presets-open' : ''}${editing ? ' loadout-section--editing' : ''}`}
    >
      <div className="loadout-phone-summary">
        <span className="loadout-summary-icon" aria-hidden="true">
          {encounterEquipment.weapon != null && encounterEquipment.weapon >= 0 && (
            <PixelSprite src={getItemSpriteUrl(encounterEquipment.weapon)} alt="" style={INVENTORY_SPRITE_BOX} />
          )}
        </span>
        <div>
          <span className="section-label">Loadout</span>
          <strong>{selectedLabel}</strong>
          {/* The compact layout hides the footer's start summary, so the state rides the
              loadout's own identity line here instead, distinguishing edits from preset saves. */}
          <span className={isDraft ? 'loadout-phone-unsaved' : undefined}>
            {isDraft
              ? 'This loadout is not saved as a preset. Starting the encounter will not save it.'
              : `${SETUP_SPELLBOOK_LABELS[supplies?.spellbook ?? 'standard']} spellbook`}
          </span>
        </div>
        <button
          type="button"
          tabIndex={-1}
          aria-expanded={presetsOpen}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setPresetsOpen((open) => !open)}
        >
          {presetsOpen ? 'Done' : 'Change'}
        </button>
        <button
          type="button"
          className="loadout-summary-edit"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onEditingChange?.(true)}
        >
          Edit
        </button>
      </div>
      <LoadoutPicker
        label="Loadout"
        presetsExpanded={presetsOpen}
        selectedKey={displayedSelectedPresetKey}
        selectedLabel={selectedLabel}
        labelActions={
          <span className="loadout-io">
            <LoadoutIoButton
              idleLabel="Import"
              doneLabel="Imported"
              outcome={importOutcome}
              className="loadout-io-btn"
              icon={<path d="M6 2V8M3 5L6 8L9 5M2 9V11H10V9" />}
              ariaLabel={
                importOutcome?.failed
                  ? 'Import Inventory Setup from the clipboard, last attempt failed'
                  : importOutcome
                    ? 'Imported Inventory Setup from the clipboard'
                    : 'Import Inventory Setup from the clipboard'
              }
              buttonRef={importRef}
              card={importCard.card}
              onPress={() => void importSetupFromClipboard()}
            />
            <LoadoutIoButton
              idleLabel="Export"
              doneLabel="Copied"
              outcome={exportOutcome}
              className="loadout-io-btn loadout-io-btn--export"
              icon={<path d="M6 8V2M3 5L6 2L9 5M2 9V11H10V9" />}
              // aria-disabled, not disabled: a disabled button takes no pointer events, so the
              // one thing the player needs here, why it is off and how to turn it on, could not
              // live on it. Same choice the locked preset rows make.
              disabled={exportDisabled}
              ariaLabel={
                exportDisabled
                  ? 'Export Inventory Setup, save a preset first'
                  : exportOutcome?.failed
                    ? `Export ${exportName} as an Inventory Setup, last attempt failed`
                    : exportOutcome
                      ? `Copied ${exportName} as an Inventory Setup`
                      : `Export ${exportName} as an Inventory Setup`
              }
              title={exportDisabled ? 'Save a preset to export this loadout' : undefined}
              buttonRef={exportRef}
              card={exportCard.card}
              onPress={() => void exportSetupToClipboard()}
              // A refused press answers through the same channel every other refusal uses. A
              // `title` would not do: a touch device never shows it, and a pointer only reveals it
              // after half a second of hovering the control that just ignored it.
              onRefused={() =>
                reportTransfer('export', true, 'Save a preset or select an existing preset to export this loadout.')
              }
            />
            {/* Swapping the label is a silent repaint to a screen reader. This region stands
                empty rather than mounting with its text, because a live region inserted
                alongside its content is announced unreliably. `aria-live` without
                `role="status"`: the visible status row owns that role, and two would collide.

                It carries the refusals too, and that is what lets this path drop the status row
                without losing anything: the card the reason is drawn in is `pointer-events: none`
                and unreachable, so this is the only place a reader gets it. */}
            <span className="loadout-io-sr-status" aria-live="polite" aria-atomic="true">
              {transferAnnouncement}
            </span>
          </span>
        }
        options={options}
        blockedOptions={blockedOptions}
        status={loadoutStatus}
        draft={
          isDraft
            ? {
                naming: namingSave,
                name: customPresetName,
                revertName,
                onNameChange: setCustomPresetName,
                onSave: pressSave,
                onCancelNaming: () => setNamingSave(false),
                onRevert: revertToMatched,
                onUpdate: modifiedCustomPreset ? updateCustomPreset : undefined,
              }
            : undefined
        }
        onSelect={selectPreset}
        onDeleteCustom={deleteCustomPreset}
      />

      {inFallbackState ? (
        <p className="loadout-note loadout-note--warn" role="status">
          {fallbackLoadoutMessage()}
          {Object.keys(limitingRequirements).length > 0 && (
            <>
              {' '}
              <RequirementChipList requirements={toRequirementChips(limitingRequirements)} />
            </>
          )}
        </p>
      ) : (
        switchInfo?.note && (
          <p className="loadout-note loadout-note--switch" role="status">
            {switchInfo.note} <RequirementChipList requirements={toRequirementChips(limitingRequirements)} />
          </p>
        )
      )}

      <div className="loadout-editor">
        {/* Keyed so each arriving set restarts the trace. Only this span is keyed: keying the
            frame would rebuild every gear and inventory image inside it on each set change. */}
        {settleSeq > 0 && <span className="loadout-editor-settle" key={settleSeq} aria-hidden="true" />}
        {/* This frame must never be keyed: a key rebuilds the whole diagram — every gear and
            inventory image in it — on each set change, where React otherwise updates it in place. */}
        {/* The ref spans both grids because they are one roving group; the key handler sits on
            each of them, where there is a role to hang it on. */}
        <div className="loadout-frame" ref={loadoutGrid.containerRef}>
          <div className="loadout-equipment-column">
            <h3 className="section-label loadout-grid-heading">Equipment</h3>
            <EquipmentSettings
              playerConfig={encounterConfig}
              ammo={{
                worn: supplies?.equippedAmmo?.id,
                quiver: showQuiverAmmo ? { stored: supplies?.quiverAmmo?.id } : undefined,
              }}
              selectedSlot={selectedEquipmentSlot(slotSelection?.target)}
              onEquipmentSlotClick={selectEquipmentSlot}
              cellProps={loadoutGrid.cellProps}
              onKeyDown={loadoutGrid.onKeyDown}
            />
          </div>

          {inventory && (
            <div className="loadout-inventory-column">
              <h3 className="section-label loadout-grid-heading">Inventory</h3>
              {
                // A fieldset groups form controls; this is a 4x7 grid of cells.
                // biome-ignore lint/a11y/useSemanticElements: see above; a fieldset's UA box fights the layout.
                <div
                  className={`inventory-grid${inventoryDrag.carrying !== null ? ' inventory-grid--carrying' : ''}`}
                  role="group"
                  aria-label="Inventory"
                  ref={inventoryDrag.gridRef}
                  onKeyDown={loadoutGrid.onKeyDown}
                >
                  {INVENTORY_SLOT_KEYS.map((slotKey, i) => {
                    const item = shownInventory[i];
                    const isSelected = slotSelection?.target.kind === 'inventory' && slotSelection.target.index === i;
                    const catalogVerified = item === null ? undefined : findInventoryItem(item.id)?.verified;
                    const isUnverified = item !== null && catalogVerified !== true;
                    const notes = item && !isUnverified ? verifiedItemNotes(item.id) : undefined;
                    const notice = isUnverified ? 'unverified' : notes ? 'note' : undefined;
                    const isCarried = inventoryDrag.carrying === i;
                    const isDropTarget = inventoryDrag.carrying !== null && inventoryDrag.over === i && !isCarried;
                    const className = [
                      'inventory-slot',
                      item ? 'inventory-slot--filled' : '',
                      isSelected ? 'inventory-slot--selected' : '',
                      isUnverified ? 'inventory-slot--unverified' : '',
                      isCarried ? 'inventory-slot--carried' : '',
                      isDropTarget ? 'inventory-slot--drop' : '',
                    ]
                      .filter(Boolean)
                      .join(' ');
                    const quantity = getFiniteStackQuantity(item);
                    const sprite = item && (
                      <>
                        <PixelSprite src={getItemSpriteUrl(item.id)} alt="" style={INVENTORY_SPRITE_BOX} />
                        {quantity !== undefined && <InventoryStackCount quantity={quantity} />}
                      </>
                    );

                    const itemName = inventoryItemName(item?.id);
                    const label = `Inventory slot ${i + 1}: ${itemName}${quantity === undefined ? '' : ` ×${quantity}`}${
                      isUnverified ? ', unverified and may not work correctly' : ''
                    }${notes ? `. ${notes.join(' ')}` : ''}`;
                    return (
                      <LoadoutUnverifiedTooltipTrigger
                        key={slotKey}
                        active={notice !== undefined}
                        itemName={inventoryItemTitle(item?.id)}
                        notice={notice}
                        // Only a catalog weapon has reasons; an item the catalog cannot list is
                        // unverified simply by being unknown.
                        reasons={item && catalogVerified === false ? describeWeaponVerificationGaps(item.id) : notes}
                      >
                        <button
                          type="button"
                          className={className}
                          {...loadoutGrid.cellProps(inventoryCellOffset + i)}
                          {...inventoryDrag.slotProps(i)}
                          aria-pressed={isSelected}
                          aria-haspopup="dialog"
                          aria-label={label}
                          onClick={(event) => selectSlot({ kind: 'inventory', index: i }, event.currentTarget)}
                        >
                          {notice ? <LoadoutUnverifiedBadge notice={notice}>{sprite}</LoadoutUnverifiedBadge> : sprite}
                        </button>
                      </LoadoutUnverifiedTooltipTrigger>
                    );
                  })}
                </div>
              }
              {/* The item in hand, drawn out of flow at the pointer. A canvas sprite like the
                  cells', because it is the same icon at the same size and `imageRendering` on an
                  <img> would resample it differently from the grid it left. */}
              {carriedItem && (
                <div className="inventory-drag-ghost" ref={inventoryDrag.ghostRef} aria-hidden="true">
                  <PixelSprite src={getItemSpriteUrl(carriedItem.id)} alt="" style={INVENTORY_SPRITE_BOX} />
                </div>
              )}
            </div>
          )}
          {/* The frame's one instruction. The second sentence is only true where there is an
              inventory to rearrange: the equipment cells are a diagram of what is worn, and
              nothing in it can be carried to another cell. */}
          <p className="loadout-editor-guidance">
            Select a slot to change it.{inventory ? ' Drag an item to another slot to swap them.' : ''}
          </p>
        </div>

        {/* Keep supply controls outside the equipment/inventory roving group. */}
        {supplies && onLoadoutChange && (
          <div className="loadout-supplies">
            <SpellbookSelector spellbook={supplies.spellbook} onSelect={applySpellbook} />
            {supplies.runePouch && (
              <RunePouchRow
                runePouch={supplies.runePouch}
                openSlotIndex={openRuneSlot}
                onSelectSlot={(index) => {
                  // A rune tray and a gear picker are two answers to the same question, so opening
                  // one puts the other down: the picker is a layer over the panel and would sit on
                  // top of the tray it has nothing to do with.
                  setSlotSelection(null);
                  setOpenRuneSlot(index);
                }}
                onChooseRune={(index, itemId) => {
                  applyRunePouchSlot(index, itemId);
                  setOpenRuneSlot(null);
                }}
              />
            )}
          </div>
        )}
      </div>

      {/* Not part of the column: the picker is portalled into a layer above the panel,
          so opening a slot never spends the height the diagram it edits is standing in. */}
      {renderSlotPicker()}

      {onStatsChange && (
        <details className="loadout-stats-disclosure">
          <summary tabIndex={-1}>
            <DisclosureChevron />
            Combat stats{' '}
            <span>{Object.values(stats).every((stat) => stat.max === 99) ? 'All 99' : 'Custom stats'}</span>
          </summary>
          <PlayerSettings stats={stats} onStatsChange={onStatsChange} requirements={limitingRequirements} />
        </details>
      )}
      {accountUnlocks && (
        <details className="loadout-unlocks-disclosure">
          <summary tabIndex={-1}>
            <DisclosureChevron />
            Account unlocks
          </summary>
          {accountUnlocks}
        </details>
      )}
    </section>
  );
};
