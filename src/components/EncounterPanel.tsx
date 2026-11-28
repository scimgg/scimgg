import type React from 'react';
import { useMemo, useRef, useState } from 'react';
import type { EncounterModifierDefinition, EncounterModifierSelection } from '../core/encounters/encounterFactory';
import { type EncounterSetupNoteRule, resolveSetupNotes } from '../core/encounters/setupNotes';
import type { EncounterVariant, MechanicsToggleInfo } from '../core/encounters/types';
import { resolveEncounterPresetsKey } from '../core/encounters/variantTypes';
import { exportInventorySetup } from '../data/inventorySetupIO';
import { encounterSetupControlsForKind } from '../encounters/practiceChrome';
import { encounterPresentationModuleForKind } from '../encounters/presentationModules';
import { ESC_PRIORITY, useEscapeLayer } from '../hooks/useEscapeLayer';
import { useIsMobile } from '../hooks/useIsMobile';
import { useIsMobileDevice } from '../hooks/useIsMobileDevice';
import type { AnimationSystem } from '../render/core/animation';
import type { ObjTypeLoader } from '../rs/config/objtype/ObjTypeLoader';
import type { NpcModelLoader } from '../rs/model/NpcModelLoader';
import type { PlayerEquipment } from '../rs/model/PlayerModelLoader';
import { THEME } from '../theme';
import { hasTutorialsForEncounter } from '../tutorial/content';
import type { CombatSupplies, EncounterLoadout } from '../types/encounterLoadout';
import { createEmptyCombatSupplies } from '../types/encounterLoadout';
import type { Inventory } from '../types/inventory';
import type { PlayerConfig } from '../types/player';
import type { PlayerStats } from '../types/playerState';
import type { SetupContextControls } from '../types/setupContext';
import { BossPortrait } from './BossPortrait';
import { EncounterLoadoutSection } from './EncounterLoadoutSection';
import { selectPlayerToggles, selectSetupToggles } from './EncounterPanel.helpers';
import { EncounterSetupNotes } from './EncounterSetupNotes';
import { EncounterSetupSelection } from './EncounterSetupSelection';
import {
  type MechanicsConfig,
  MechanicsSettings,
  partitionPracticeToggles,
  partitionToggleSections,
  sharedSectionNote,
} from './MechanicsSettings';
import { ModifierGrid } from './ModifierSelector';
import { ModifierDefaultsReset, ResetToDefaultsControl, useResetToDefaults } from './ResetToDefaults';
import { StartingHitpointsField } from './StartingHitpointsField';
import { OsrsButton } from './ui/OsrsButton';
import { WikiLink } from './WikiLink';
import './EncounterPanel.css';
import { CloseButton } from './ui/CloseButton';
import { sheet } from './ui/mobileSheet';
import { useCenteredModalSnap } from './ui/useCenteredModalSnap';
import './EncounterConfigurer.css';

interface EncounterPanelProps {
  mobile?: boolean;
  npcModelLoader?: NpcModelLoader | null;
  animationSystem?: AnimationSystem | null;
  encounterKind: string;
  displayName: string;
  description: string;
  isAvailable: boolean;
  isWorkInProgress?: boolean;
  playerConfig: PlayerConfig;
  encounterEquipment: PlayerEquipment;
  onEquipmentChange: (equipment: PlayerEquipment) => void;
  onInventoryChange: (inventory: Inventory) => void;
  /** Persist a complete preset loadout (equipment + inventory + supplies) atomically. */
  onLoadoutChange?: (loadout: EncounterLoadout) => void;
  mechanicsConfig: MechanicsConfig;
  onMechanicsConfigChange: (config: MechanicsConfig) => void;
  keybindingsReadOnly?: boolean;
  mechanicsToggles: readonly MechanicsToggleInfo[];
  onStart: () => void;
  /**
   * Enter Tutorial Mode for this encounter. When provided and the encounter has
   * tutorials, the footer offers it alongside Start Encounter.
   */
  onTutorialMode?: (kind: string) => void;
  onClose: () => void;
  inventory?: Inventory;
  /** Stored combat supplies for this encounter's loadout (drives the spellbook selector). */
  supplies?: CombatSupplies;
  variants?: EncounterVariant[];
  variantLabel?: string;
  onVariantChange?: (encounterKind: string) => void;
  /** The registered base encounter kind (e.g. 'yama_p3'), used to distinguish contract variants. */
  baseEncounterKind?: string;
  /** Optional run modifiers this encounter offers. Omitted encounters render no selector. */
  modifiers?: readonly EncounterModifierDefinition[];
  modifierSelection?: EncounterModifierSelection;
  /** Every edit saves the selection as the player's own, kept as made (see `onModifierSelectionReset`). */
  onModifierSelectionChange?: (next: EncounterModifierSelection) => void;
  /**
   * Drops the saved selection for the setup's default. Present while there is a saved selection to
   * drop, one equal to the default included: it is still the player's, and would not follow the setup.
   */
  onModifierSelectionReset?: () => void;
  /**
   * Advisory notes on the saved loadout and modifier selection (the setup Start runs), shown in one
   * band under the selectors whether or not they name a modifier. Never blocks Start.
   */
  setupNotes?: readonly EncounterSetupNoteRule[];
  /**
   * Resolved starting hitpoints for the selected variant, when it declares
   * `EncounterVariant.startingHitpoints`. Absent on every other variant, which is what
   * keeps the field off the base fight and off the other contracts.
   */
  startingHitpoints?: number;
  onStartingHitpointsChange?: (hitpoints: number) => void;
  /** Persist edited base combat stats. When omitted, the Combat Stats editor is hidden. */
  onStatsChange?: (stats: PlayerStats) => void;
  /** Tells the setup export which items are stacks. Null until the cache loads. */
  objTypeLoader?: ObjTypeLoader | null;
  /**
   * The saved setup's reset to defaults and whether there is anything to reset (`SetupContextControls`).
   * Every field the card shows and edits above (`mechanicsConfig`, `modifierSelection`,
   * `startingHitpoints`) is already the saved setup. Omitted: no reset is offered.
   */
  setupContext?: SetupContextControls;
}

export const EncounterPanel: React.FC<EncounterPanelProps> = ({
  mobile = false,
  npcModelLoader = null,
  animationSystem = null,
  encounterKind,
  displayName,
  description,
  isAvailable,
  isWorkInProgress = false,
  playerConfig,
  encounterEquipment,
  onEquipmentChange,
  onInventoryChange,
  onLoadoutChange,
  mechanicsConfig,
  onMechanicsConfigChange,
  keybindingsReadOnly,
  mechanicsToggles,
  onStart,
  onTutorialMode,
  onClose,
  inventory,
  supplies,
  variants,
  onVariantChange,
  baseEncounterKind,
  modifiers,
  modifierSelection,
  onModifierSelectionChange,
  onModifierSelectionReset,
  setupNotes,
  startingHitpoints,
  onStartingHitpointsChange,
  onStatsChange,
  objTypeLoader,
  setupContext,
}) => {
  const cardRef = useRef<HTMLElement>(null);
  useCenteredModalSnap(cardRef);
  const narrow = useIsMobile();
  const mobileDevice = useIsMobileDevice();
  const compactPortrait = mobile || narrow || mobileDevice;
  const [view, setView] = useState<'setup' | 'modifiers' | 'loadout'>('setup');
  // Above App's setup layer, below the encounter picker and Ctrl+K; slot editors consume Escape first.
  useEscapeLayer(ESC_PRIORITY.ENCOUNTER_PICKER - 1, view !== 'setup', () => setView('setup'));
  const [interacting, setInteracting] = useState(false);
  const [loadoutSummary, setLoadoutSummary] = useState('');
  // The canvas is opaque, so it has to paint the color the header paints: the portrait's own
  // background matches the header and its bottom edge is painted into that header.
  const portraitBackground = {
    r: Number.parseInt(THEME.colors.bgElevated.slice(1, 3), 16) / 255,
    g: Number.parseInt(THEME.colors.bgElevated.slice(3, 5), 16) / 255,
    b: Number.parseInt(THEME.colors.bgElevated.slice(5, 7), 16) / 255,
    a: 1,
  };
  const activeVariant = variants?.find((v) => v.encounterKind === encounterKind);
  const isContractActive = !!(activeVariant && baseEncounterKind && activeVariant.encounterKind !== baseEncounterKind);
  const presetsKey = resolveEncounterPresetsKey(encounterKind, variants);
  // Scoped to the kind actually selected, contract included. Yama's tutorials teach the base
  // fight, so a contract that has none must not advertise one — the badge and the action below
  // it both answer "is there a tutorial for THIS", not "for this boss".
  const hasTutorial = hasTutorialsForEncounter(encounterKind);
  // The encounter's own name, not `displayName`: entering from the picker's Configure sets that to
  // the CONTRACT's name, which would label this link "Forfeit Breath on the OSRS Wiki" while it
  // points at Yama's page — the same name the contract's own link carries, on a different page.
  const encounterPresentation = encounterPresentationModuleForKind(encounterKind)?.presentation;
  const encounterWikiUrl = encounterPresentation?.wikiUrl;
  const encounterWikiSubject = encounterPresentation?.title ?? displayName;

  const activeSetupNotes = useMemo(
    () =>
      resolveSetupNotes(setupNotes, {
        equipment: encounterEquipment,
        inventory,
        modifiers: modifierSelection ?? {},
      }),
    [setupNotes, encounterEquipment, inventory, modifierSelection],
  );

  // The encounter's own setup control, drawn as a rail section of its own before Preparation. The
  // keys it owns leave every generic list here, so no choice is offered twice on the card.
  const setupControls = encounterSetupControlsForKind(encounterKind);
  const panelToggles = useMemo(
    () =>
      setupControls ? mechanicsToggles.filter((toggle) => !setupControls.keys.includes(toggle.key)) : mechanicsToggles,
    [mechanicsToggles, setupControls],
  );
  // A named section takes its members out of Preparation, Mechanics and Practice aids alike.
  const { unsectioned, sections } = useMemo(() => partitionToggleSections(panelToggles), [panelToggles]);
  const setupToggles = useMemo(() => selectSetupToggles(unsectioned), [unsectioned]);
  const { mechanics, assists } = useMemo(() => {
    const optional = unsectioned.filter((toggle) => toggle.setup !== true && toggle.group !== 'player');
    return partitionPracticeToggles(optional);
  }, [unsectioned]);
  const playerToggles = useMemo(() => selectPlayerToggles(unsectioned), [unsectioned]);
  const accountUnlocks =
    playerToggles.length > 0 ? (
      <MechanicsSettings
        config={mechanicsConfig}
        onConfigChange={onMechanicsConfigChange}
        mechanicsToggles={playerToggles}
        debugActions={[]}
      />
    ) : undefined;

  /**
   * Reported by the loadout column, which owns the rule: the live loadout matches no named set,
   * shipped or saved.
   *
   * It does not hold the fight. The edited gear IS this encounter's loadout already, and is
   * already stored: every slot edit travels `applyLoadout` -> `onLoadoutChange` -> App's
   * `setEncounterLoadout`, and `useEncounterEquipment` writes the whole map to local storage on
   * every change, so it survives starting, restarting, reopening this panel and a reload.
   * `enterEncounter` reads that same stored loadout, so the fight runs what is on screen.
   *
   * "Unsaved" is therefore narrower than it sounds, and the footer says only what is true: the
   * loadout is not in the preset list, which is why it cannot be exported and why the next
   * preset press replaces it.
   */
  const [loadoutIsDraft, setLoadoutIsDraft] = useState(false);
  const [setupFooter, setSetupFooter] = useState<HTMLDivElement | null>(null);
  // Scoped to the kind on screen: choosing another contract ends the previous one's Undo.
  const resetToDefaults = useResetToDefaults(setupContext, encounterKind);

  /**
   * Beside the name: the phase or wave this encounter is, plus the contract when one is on.
   * "No Contract" is left out here — the header says which fight this is, and the plain fight
   * says that by naming nothing. Metadata only; nothing switches on a boss name.
   */
  const headerContext = [encounterPresentation?.setupContext, isContractActive ? activeVariant.name : undefined]
    .filter(Boolean)
    .join(' · ');
  const modifierCount = Object.keys(modifierSelection ?? {}).length;
  // An encounter whose default modifiers follow its setup (a Colosseum start wave) names them for it.
  const modifierLabels = setupControls?.modifierLabels;
  const modifierHeading = modifierLabels?.heading(mechanicsConfig) ?? 'Modifiers';
  // A reset, not an edit back to the default: only it lets the set follow the setup again.
  const modifierReset = onModifierSelectionReset
    ? { label: modifierLabels?.resetLabel(mechanicsConfig) ?? 'Reset to default', reset: onModifierSelectionReset }
    : undefined;
  // Modifiers that follow the setup (a start wave) come after the control that sets it, as their
  // heading names it; otherwise the encounter's selection leads the rail.
  const modifiersFollowSetup = modifierLabels !== undefined;
  const setupSelection = (
    <EncounterSetupSelection
      key={baseEncounterKind ?? encounterKind}
      variants={variants}
      selectedKind={encounterKind}
      baseKind={baseEncounterKind}
      onVariantChange={onVariantChange}
      modifiers={modifiers}
      value={modifierSelection ?? {}}
      onEdit={onModifierSelectionChange ? () => setView('modifiers') : undefined}
      heading={modifierHeading}
    />
  );
  /**
   * The footer's confirmation line: the choices about to be committed, in the terms they were
   * made in. An encounter's own summary leads where it has one (it is handed the modifiers too);
   * otherwise modifiers lead where they are the variable part, then the phase and contract
   * do, and here "No Contract" is worth saying, because choosing it was a decision. The title
   * is the last resort — it is already the largest thing on the card, so repeating it
   * confirmed nothing.
   */
  const startHeadline =
    setupControls?.summary?.(mechanicsConfig, modifierSelection ?? {}) ||
    (modifiers !== undefined && modifiers.length > 0 && modifierCount > 0
      ? `${modifierCount} modifier${modifierCount === 1 ? '' : 's'} selected`
      : undefined) ||
    [encounterPresentation?.setupContext, variants && variants.length > 1 ? activeVariant?.name : undefined]
      .filter(Boolean)
      .join(' · ') ||
    (encounterPresentation?.title ?? displayName);

  return (
    <div
      className="encounter-panel-overlay"
      {...sheet.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={displayName}
    >
      <button type="button" className="encounter-panel-backdrop" aria-label="Close encounter panel" onClick={onClose} />
      <section
        ref={cardRef}
        className={`encounter-panel-card centered-modal-snap${view === 'loadout' ? ' encounter-panel-card--loadout' : ''}`}
        {...sheet.card}
        onPointerDownCapture={() => setInteracting(true)}
        onPointerUpCapture={() => setInteracting(document.activeElement instanceof HTMLInputElement)}
        onPointerCancelCapture={() => setInteracting(false)}
        onFocusCapture={() => setInteracting(true)}
        onBlurCapture={() => setInteracting(false)}
      >
        <header className="encounter-panel-header" {...sheet.head}>
          {encounterPresentation && (
            <BossPortrait
              presentation={encounterPresentation}
              npcModelLoader={npcModelLoader}
              animationSystem={animationSystem}
              paused={interacting || view !== 'setup'}
              still={compactPortrait}
              background={portraitBackground}
              className="configurer-portrait"
            />
          )}
          <div className="encounter-panel-header-info">
            <div className="encounter-panel-title-row">
              <h2>{encounterPresentation?.title ?? displayName}</h2>
              {/* Which phase or wave, and which contract, beside the name they qualify. It used
                  to be a phone-only line and a chip only on desktop saying half of it each, which
                  left the desktop header naming a boss that has three different fights. */}
              {headerContext && <span className="configurer-compact-context">{headerContext}</span>}
              {/* Status rides the end of the name's own line. On its own row it cost the header
                  a third line to carry one chip, and the chip outweighed the line above it.
                  Availability of a tutorial is not status: the footer's Start Tutorial button
                  appears under exactly the same rule and is the thing that acts on it. */}
              <span className="encounter-panel-header-badges">
                {isWorkInProgress && <span className="encounter-badge encounter-badge--beta">Beta</span>}
                {!isAvailable && <span className="encounter-badge encounter-badge--locked">Unavailable</span>}
              </span>
              {encounterWikiUrl && <WikiLink href={encounterWikiUrl} subject={encounterWikiSubject} />}
            </div>
            <p className="encounter-description">{description}</p>
          </div>
          <CloseButton {...sheet.close} onClick={onClose} aria-label="Close" />
        </header>

        {/* Outside the folding fields and the scrolling body, so a note is read without opening
            anything, between the modifiers and the loadout it is usually about. */}
        <EncounterSetupNotes notes={activeSetupNotes} />

        {view === 'modifiers' && modifiers && onModifierSelectionChange && (
          <>
            <div className="configurer-subhead configurer-subhead--modifiers">
              <h3>{modifierHeading}</h3>
              <p className="configurer-subhead-note">Changes apply immediately.</p>
              {modifierReset && <ModifierDefaultsReset {...modifierReset} />}
            </div>
            <div className="configurer-modifier-editor" {...sheet.body}>
              <ModifierGrid
                modifiers={modifiers}
                value={modifierSelection ?? {}}
                onChange={onModifierSelectionChange}
              />
            </div>
          </>
        )}
        {view === 'loadout' && (
          <div className="configurer-subhead">
            <h3>Edit loadout</h3>
          </div>
        )}
        {/* Keep the editor mounted while choosing modifiers: its unsaved draft and import state belong to this panel. */}
        <div className="encounter-panel-body" hidden={view === 'modifiers'} {...sheet.body}>
          <div className="encounter-panel-main">
            <EncounterLoadoutSection
              encounterKind={encounterKind}
              presetsKey={presetsKey}
              appearance={playerConfig.appearance}
              stats={playerConfig.stats}
              encounterEquipment={encounterEquipment}
              inventory={inventory}
              supplies={supplies}
              onEquipmentChange={onEquipmentChange}
              onInventoryChange={onInventoryChange}
              onLoadoutChange={onLoadoutChange}
              onStatsChange={onStatsChange}
              objTypeLoader={objTypeLoader}
              accountUnlocks={accountUnlocks}
              onDraftChange={setLoadoutIsDraft}
              onSummaryChange={setLoadoutSummary}
              editing={view === 'loadout'}
              onEditingChange={(editing) => setView(editing ? 'loadout' : 'setup')}
            />
          </div>

          <aside className="encounter-panel-rail">
            {/* The column's name, with the one action that covers the whole column at its far end. The
                kit beside it is visibly outside what Reset to defaults touches. */}
            <div className="configurer-rail-head">
              <h3 className="section-label configurer-rail-heading">{setupControls?.railSection ?? 'Fight setup'}</h3>
              <ResetToDefaultsControl control={resetToDefaults} variant="rail" />
            </div>
            {!modifiersFollowSetup && setupSelection}
            {/* Named rather than headed: the encounter's primary control carries the section's
                visible label itself, on the same row as the value it sets. */}
            {setupControls && (
              <section className="rail-section configurer-encounter-setup" aria-label={setupControls.railSection}>
                {setupControls.render({
                  config: mechanicsConfig,
                  onChange: onMechanicsConfigChange,
                  surface: 'rail',
                  actionFooter: setupFooter,
                  exportGear: inventory
                    ? () =>
                        exportInventorySetup(
                          displayName,
                          {
                            equipment: encounterEquipment,
                            inventory,
                            supplies: supplies ?? createEmptyCombatSupplies(),
                          },
                          objTypeLoader,
                        )
                    : undefined,
                })}
              </section>
            )}
            {modifiersFollowSetup && setupSelection}
            <section className="rail-section">
              <h3 className="section-label">Preparation</h3>
              <MechanicsSettings
                config={mechanicsConfig}
                onConfigChange={onMechanicsConfigChange}
                mechanicsToggles={setupToggles}
                debugActions={[]}
                showKeybindings
                keybindingsReadOnly={keybindingsReadOnly}
                setupField={
                  startingHitpoints !== undefined && onStartingHitpointsChange ? (
                    <StartingHitpointsField
                      value={Math.min(startingHitpoints, playerConfig.stats.hitpoints.max)}
                      max={playerConfig.stats.hitpoints.max}
                      onChange={onStartingHitpointsChange}
                    />
                  ) : undefined
                }
              />
              {mechanics.length > 0 && (
                <div className="encounter-fight-controls">
                  <h3 className="section-label">Mechanics</h3>
                  <MechanicsSettings
                    config={mechanicsConfig}
                    onConfigChange={onMechanicsConfigChange}
                    mechanicsToggles={mechanics}
                    debugActions={[]}
                  />
                </div>
              )}
              {sections.map((section) => {
                const note = sharedSectionNote(section.toggles, { config: mechanicsConfig });
                return (
                  <div className="encounter-fight-controls" key={section.title}>
                    <div className="configurer-section-head">
                      <h3 className="section-label">{section.title}</h3>
                      {note && <span className="mechanics-row-note">{note}</span>}
                    </div>
                    <MechanicsSettings
                      config={mechanicsConfig}
                      onConfigChange={onMechanicsConfigChange}
                      mechanicsToggles={section.toggles}
                      debugActions={[]}
                      showKeybindings
                      keybindingsReadOnly={keybindingsReadOnly}
                      headNote={note}
                    />
                  </div>
                );
              })}
              {assists.length > 0 && (
                <fieldset className="encounter-assists">
                  <legend className="section-label">Practice aids</legend>
                  <MechanicsSettings
                    config={mechanicsConfig}
                    onConfigChange={onMechanicsConfigChange}
                    mechanicsToggles={assists}
                    debugActions={[]}
                  />
                </fieldset>
              )}
            </section>
          </aside>
        </div>

        <footer className="encounter-panel-footer" {...sheet.foot}>
          {view === 'modifiers' ? (
            <>
              <p className="configurer-modifier-count">
                {modifierCount === 0
                  ? 'No modifiers selected'
                  : `${modifierCount} modifier${modifierCount === 1 ? '' : 's'} selected`}
              </p>
              <OsrsButton variant="primary" className="configurer-return-btn" onClick={() => setView('setup')}>
                Return to setup
              </OsrsButton>
            </>
          ) : (
            <>
              {/* Back returns one level; Close dismisses setup without rolling back immediate edits. */}
              <OsrsButton
                variant="ghost"
                className="encounter-back-btn"
                onClick={view === 'setup' ? onClose : () => setView('setup')}
              >
                {view === 'setup' ? 'Close' : 'Return to setup'}
              </OsrsButton>
              {setupControls?.hasFooterActions && (
                <div ref={setSetupFooter} className="configurer-setup-footer-action" hidden={view !== 'setup'} />
              )}
              {/* Leaving and learning both keep the left; the summary and the one action that
              commits keep the right, so the summary sits against the button it describes. */}
              {view === 'setup' && hasTutorial && onTutorialMode && isAvailable && (
                <OsrsButton className="encounter-tutorial-btn" onClick={() => onTutorialMode(encounterKind)}>
                  Start Tutorial
                </OsrsButton>
              )}
              {/* The loadout column explains saving; the footer keeps the draft status near Start. */}
              <div className={`configurer-start-summary${loadoutIsDraft ? ' configurer-start-summary--draft' : ''}`}>
                <strong>{startHeadline}</strong>
                <span>{loadoutIsDraft ? 'Not saved as a preset' : loadoutSummary}</span>
              </div>
              {/* Save actions stay in the loadout column, which distinguishes updating a preset
              from saving a new one. */}
              {/* Unavailable is the only refusal left here, and it has no answer the player can
              give, so it stays truly disabled and inert. An unsaved loadout starts: it is this
              encounter's stored loadout already. */}
              <OsrsButton variant="primary" className="encounter-start-btn" onClick={onStart} disabled={!isAvailable}>
                {isAvailable ? 'Start Encounter' : 'Unavailable'}
              </OsrsButton>
            </>
          )}
        </footer>
      </section>
    </div>
  );
};
