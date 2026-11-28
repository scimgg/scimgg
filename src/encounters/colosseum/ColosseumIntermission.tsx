import type React from 'react';
import { useId, useState } from 'react';
import type { PlayInterfaceSound } from '../../audio/interfaceSounds';
import { PixelSprite } from '../../components/PixelSprite';
import { DisclosureChevron } from '../../components/ui/DisclosureChevron';
import { OsrsButton } from '../../components/ui/OsrsButton';
import type { EncounterCommand } from '../../core/encounters/commands';
import { ESC_PRIORITY, useEscapeLayer } from '../../hooks/useEscapeLayer';
import type { IntermissionScenePlacement, IntermissionSheetPlacement } from './intermissionPlacement';
import type { ColosseumModifierId } from './modifiers/definitions';
import {
  type ColosseumOwnedModifier,
  colosseumModifierDefinition,
  colosseumModifierLabel,
  colosseumModifierParts,
  colosseumOwnedModifiers,
  colosseumOwnedSourceText,
  colosseumTierText,
} from './runChrome';
import type { ColosseumRunPublicState } from './waves/snapshot';
import { SOL_WAVE } from './waves/waveTable';
import './ColosseumIntermission.css';

/** Every modifier icon fits 38x38, so the option slot shows each one 1:1 (ModifierSelector's box). */
const OPTION_ICON_BOX = { maxWidth: 38, maxHeight: 38 } as const;
const TILE_ICON_BOX = { maxWidth: 32, maxHeight: 32 } as const;
const OWNED_ICON_BOX = { maxWidth: 20, maxHeight: 20 } as const;
const CHIP_ICON_BOX = { maxWidth: 18, maxHeight: 18 } as const;
/** Under the Practice and Actions panes (SIDE_PANEL), which close first, and over a replay. */
const ESC_INTERMISSION = ESC_PRIORITY.SIDE_PANEL - 5;

export interface ColosseumIntermissionProps {
  /** The run with an open offer (`run.offer` non-null). */
  readonly run: ColosseumRunPublicState;
  /**
   * The live run's identity, which a restart changes. The prompt's own state (the selection, what
   * is inspected, hidden, the pending send) belongs to one attempt's one offer: a restart on the
   * same wave can draw a different offer, and must not inherit a choice made for another.
   */
  readonly attempt: number;
  readonly currentTick: number;
  /**
   * The app's encounter-command route. A `false` return is a command the engine refused to queue,
   * which leaves Continue available again.
   */
  readonly execute: (command: EncounterCommand) => boolean | undefined;
  /** The Mobile layout: a compact sheet along the top instead of the centered panel. */
  readonly mobileLayout?: boolean;
  /** Mobile's sheet clear of the native chrome (`intermissionSheetPlacement`); else top center. */
  readonly sheetPlacement?: IntermissionSheetPlacement;
  /** A desktop's panel and bar centered on the visible scene (`intermissionScenePlacement`); else the window. */
  readonly scenePlacement?: IntermissionScenePlacement;
  /** The client's own interface sounds: a click on an option, and a mouse entering one. */
  readonly playSound?: PlayInterfaceSound;
}

/** The name in the row's ink and the tier beside it in accent ink, as the configurer lists modifiers. */
const ModifierName: React.FC<{
  readonly id: ColosseumModifierId;
  readonly tier: number;
  readonly className: string;
  readonly children?: React.ReactNode;
}> = ({ id, tier, className, children }) => {
  const { name, numeral } = colosseumModifierParts(id, tier);
  return (
    <span className={className}>
      {name}
      {numeral && <span className="colosseum-modifier-tier"> {numeral}</span>}
      {children}
    </span>
  );
};

const ModifierIcon: React.FC<{ readonly id: ColosseumModifierId; readonly box: React.CSSProperties }> = ({
  id,
  box,
}) => {
  const icon = colosseumModifierDefinition(id)?.icon;
  return icon ? <PixelSprite src={icon} alt="" style={box} /> : null;
};

/** A pressed control keeps no focus, so the keys go on reaching the game (Keyboard and focus policy). */
const keepFocusOff = (event: React.MouseEvent) => event.preventDefault();

/** Scrolls a just-mounted region into its scroller's view; never moves focus. */
const revealInScroller = (element: HTMLElement | null) => {
  element?.scrollIntoView?.({ block: 'nearest' });
};

const HideGlyph: React.FC = () => (
  <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
    <path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" />
  </svg>
);

/** "Blasphemy III, from setup" / "Doom I, picked for wave 7": an owned chip's name and detail line. */
function ownedDescription({ id, tier, source }: ColosseumOwnedModifier): string {
  const label = colosseumModifierLabel(id, tier);
  return source.origin === 'set' ? `${label}, from setup` : `${label}, picked for wave ${source.wave}`;
}

/** The prompt's own state for one offer of one attempt (`key`). */
interface IntermissionDraft {
  readonly key: string;
  readonly choice: ColosseumModifierId | null;
  /** Mobile's detail line can describe an owned chip instead of the chosen option. */
  readonly inspected: ColosseumModifierId | null;
  readonly hidden: boolean;
  /** "Choose another" is open: the rest of the eligible picks are shown beside the three. */
  readonly others: boolean;
  /** The tick Continue sent the choice on, while the run has not taken it yet. */
  readonly sentTick: number | null;
}

const emptyDraft = (key: string): IntermissionDraft => ({
  key,
  choice: null,
  inspected: null,
  hidden: false,
  others: false,
  sentTick: null,
});

/**
 * The choice between waves: the three modifiers on offer, each at the tier taking it would give,
 * what the player already owns and where each tier came from, and Continue. Choosing only marks an
 * option, and choosing it again clears the mark, as in the game; Continue sends the one
 * `confirm-modifier` the run records, after which the run closes the offer.
 *
 * "Choose another" is the practice way past the draw: it opens the rest of the picks the run
 * accepts here (`offer.eligible`), and one chosen there stands in for the three, exactly as an
 * offered one would. Closing it again drops a choice made there, so the choice is always in view.
 *
 * On a desktop it sits in the middle of the game view, where the game puts its own interface; on
 * Mobile it is a compact sheet along the top. Either hides to a one-line bar at the top, so the
 * player can move into position before the next wave. Hiding and showing it again changes
 * nothing: the offer is the run's, read from its snapshot, never drawn again here.
 */
export const ColosseumIntermission: React.FC<ColosseumIntermissionProps> = ({
  run,
  attempt,
  currentTick,
  execute,
  mobileLayout = false,
  sheetPlacement,
  scenePlacement,
  playSound,
}) => {
  const offer = run.offer;
  const key = offer === null ? null : `${attempt}:${offer.wave}`;
  const [stored, setDraft] = useState<IntermissionDraft | null>(null);
  const othersId = useId();
  // Another attempt's or another offer's draft is no draft at all.
  const draft = key !== null && stored?.key === key ? stored : null;
  const update = (patch: Partial<Omit<IntermissionDraft, 'key'>>) => {
    if (key === null) return;
    setDraft((previous) => ({ ...(previous?.key === key ? previous : emptyDraft(key)), ...patch }));
  };
  const hidden = draft?.hidden === true;
  useEscapeLayer(ESC_INTERMISSION, offer !== null && !hidden, () => update({ hidden: true }));
  if (offer === null) return null;

  // Only a pick this offer accepts can be the choice, whatever the draft holds: one of the three,
  // or another eligible pick while "Choose another" is open.
  const others = offer.eligible.filter(({ id }) => !offer.options.some((option) => option.id === id));
  const othersOpen = draft?.others === true && others.length > 0;
  const choosable = othersOpen ? [...offer.options, ...others] : offer.options;
  const selectedChoice = choosable.find((choice) => choice.id === draft?.choice) ?? null;
  const selected = selectedChoice?.id ?? null;
  const selectedTier = selectedChoice?.tier ?? 1;
  const selectedOther = others.some((choice) => choice.id === selected);
  // Sent and not yet taken: the command lands on the next tick, which closes the offer. If a tick
  // passes and the offer is still open, the run refused it, so Continue is offered again.
  const pending = draft?.sentTick === currentTick;
  const nextWave = offer.wave;
  const label = `Choose a modifier for wave ${nextWave}`;
  const variant = mobileLayout ? 'colosseum-intermission--mobile' : 'colosseum-intermission--center';
  const sheetPlaced = mobileLayout && sheetPlacement !== undefined;
  const scenePlaced = !mobileLayout && scenePlacement !== undefined;
  const placed = sheetPlaced
    ? ' colosseum-intermission--placed'
    : scenePlaced
      ? ' colosseum-intermission--in-scene'
      : '';
  const placement = sheetPlaced
    ? ({
        '--sheet-top': `${sheetPlacement.top}px`,
        '--sheet-left': `${sheetPlacement.left}px`,
        '--sheet-width': `${sheetPlacement.width}px`,
      } as React.CSSProperties)
    : scenePlaced
      ? ({
          '--scene-top': `${scenePlacement.top}px`,
          '--scene-bottom': `${scenePlacement.bottom}px`,
          '--scene-left': `${scenePlacement.left}px`,
          '--scene-right': `${scenePlacement.right}px`,
          '--panel-left': `${scenePlacement.panelLeft}px`,
          '--panel-width': `${scenePlacement.panelWidth}px`,
        } as React.CSSProperties)
      : undefined;

  if (hidden) {
    return (
      <button
        type="button"
        tabIndex={-1}
        className={`colosseum-intermission colosseum-intermission--bar${mobileLayout ? ' colosseum-intermission--bar-mobile' : ''}${placed}`}
        style={placement}
        onMouseDown={keepFocusOff}
        onClick={() => update({ hidden: false })}
      >
        {`Wave ${nextWave}: choose a modifier`}
      </button>
    );
  }

  const owned = colosseumOwnedModifiers(run.picks);
  const ownedTier = (id: ColosseumModifierId) => owned.find((modifier) => modifier.id === id)?.tier ?? 0;
  // The run's first choice comes before any wave is fought.
  const title = nextWave === run.startWave ? `Before wave ${nextWave}` : `Wave ${nextWave - 1} complete`;
  const choose = (id: ColosseumModifierId) => {
    if (pending) return;
    playSound?.('select');
    update({ inspected: null, choice: selected === id ? null : id });
  };
  const hover = (event: React.PointerEvent) => {
    if (event.pointerType === 'mouse' && !pending) playSound?.('colosseumOptionHover');
  };
  // Closing drops a choice made among the others, so what Continue sends is always on screen.
  const toggleOthers = () =>
    update({ inspected: null, others: !othersOpen, ...(othersOpen && selectedOther ? { choice: null } : {}) });
  const confirm = () => {
    if (selected === null || pending) return;
    const queued = execute({
      encounter: 'sol_heredit',
      type: 'confirm-modifier',
      wave: offer.wave,
      modifierId: selected,
    });
    if (queued !== false) update({ sentTick: currentTick });
  };
  const hideButton = (
    <button
      type="button"
      tabIndex={-1}
      className="colosseum-intermission__hide"
      aria-label="Hide the modifier choice"
      onClick={() => update({ hidden: true })}
    >
      <HideGlyph />
    </button>
  );
  const continueButton = (
    <OsrsButton
      variant="primary"
      className="colosseum-intermission__continue"
      disabled={selected === null || pending}
      onClick={confirm}
    >
      Continue
    </OsrsButton>
  );

  if (mobileLayout) {
    const inspectedOwned = owned.find((modifier) => modifier.id === draft?.inspected);
    const upgradeFrom = selected !== null ? ownedTier(selected) : 0;
    return (
      <section
        className={`colosseum-intermission ${variant}${placed}`}
        style={placement}
        aria-label={label}
        onMouseDown={keepFocusOff}
      >
        <header className="colosseum-intermission__head">
          <h2>
            {title} · {nextWave === run.startWave ? 'choose a modifier' : `choose for wave ${nextWave}`}
          </h2>
          {hideButton}
        </header>
        {/* The tiles and the other picks scroll together when the sheet runs out of height (a short
            landscape phone with the list open), so the header, the detail line naming the choice and
            Continue stay in view. */}
        <div className="colosseum-intermission__scroll">
          <div className={`colosseum-intermission__offer${others.length > 0 ? ' has-others' : ''}`}>
            {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the row; the group only names the options. */}
            <div className="colosseum-intermission__tiles" role="group" aria-label="Modifiers on offer">
              {offer.options.map(({ id, tier }) => (
                <button
                  key={id}
                  type="button"
                  tabIndex={-1}
                  className={`colosseum-tile${selected === id ? ' is-selected' : ''}`}
                  aria-pressed={selected === id}
                  aria-label={colosseumModifierLabel(id, tier)}
                  disabled={pending}
                  onPointerEnter={hover}
                  onClick={() => choose(id)}
                >
                  <span className="colosseum-tile__icon" aria-hidden="true">
                    <ModifierIcon id={id} box={TILE_ICON_BOX} />
                  </span>
                  <ModifierName id={id} tier={tier} className="colosseum-tile__name" />
                </button>
              ))}
            </div>
            {others.length > 0 && (
              <button
                type="button"
                tabIndex={-1}
                className="colosseum-tile colosseum-tile--others"
                aria-label="Choose another modifier"
                aria-expanded={othersOpen}
                aria-controls={othersId}
                disabled={pending}
                onClick={toggleOthers}
              >
                <span className="colosseum-tile__count">+{others.length}</span>
                <span className="colosseum-tile__more">more</span>
              </button>
            )}
          </div>
          {othersOpen && (
            // biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the row; the group only names the picks.
            <div
              id={othersId}
              ref={revealInScroller}
              className="colosseum-intermission__others"
              role="group"
              aria-label="Other modifiers"
            >
              {others.map(({ id, tier }) => {
                const { numeral } = colosseumModifierParts(id, tier);
                return (
                  <button
                    key={id}
                    type="button"
                    tabIndex={-1}
                    className={`colosseum-tile colosseum-other-chip${selected === id ? ' is-selected' : ''}`}
                    aria-pressed={selected === id}
                    aria-label={colosseumModifierLabel(id, tier)}
                    disabled={pending}
                    onPointerEnter={hover}
                    onClick={() => choose(id)}
                  >
                    <span className="colosseum-chip__icon" aria-hidden="true">
                      <ModifierIcon id={id} box={CHIP_ICON_BOX} />
                    </span>
                    {numeral && <span aria-hidden="true">{numeral}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <p className="colosseum-intermission__detail" aria-live="polite">
          {inspectedOwned ? (
            `${ownedDescription(inspectedOwned)}.`
          ) : selected === null ? (
            <span className="colosseum-intermission__prompt">Tap a modifier to see what it does.</span>
          ) : (
            <>
              {/* An other pick is an icon alone, so the line names it. */}
              {selectedOther && (
                <ModifierName id={selected} tier={selectedTier} className="colosseum-intermission__detail-name">
                  {' '}
                </ModifierName>
              )}
              {colosseumTierText(selected, selectedTier)}
              {upgradeFrom > 0 && (
                <span className="colosseum-intermission__from">
                  {' '}
                  Up from {colosseumModifierLabel(selected, upgradeFrom)}.
                </span>
              )}
            </>
          )}
        </p>
        <footer className="colosseum-intermission__foot">
          {owned.length > 0 ? (
            <ul className="colosseum-intermission__chips" aria-label="Owned modifiers">
              {owned.map((modifier) => {
                const { numeral } = colosseumModifierParts(modifier.id, modifier.tier);
                return (
                  <li key={modifier.id}>
                    <button
                      type="button"
                      tabIndex={-1}
                      className={`colosseum-chip colosseum-chip--${modifier.source.origin}${
                        inspectedOwned?.id === modifier.id ? ' is-inspected' : ''
                      }`}
                      aria-label={ownedDescription(modifier)}
                      onClick={() => update({ inspected: inspectedOwned?.id === modifier.id ? null : modifier.id })}
                    >
                      <span className="colosseum-chip__icon" aria-hidden="true">
                        <ModifierIcon id={modifier.id} box={CHIP_ICON_BOX} />
                      </span>
                      {numeral && <span aria-hidden="true">{numeral}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="colosseum-intermission__chips colosseum-intermission__none">No modifiers yet</p>
          )}
          {continueButton}
        </footer>
      </section>
    );
  }

  return (
    <section
      className={`colosseum-intermission ${variant}${placed}`}
      style={placement}
      aria-label={label}
      onMouseDown={keepFocusOff}
    >
      <header className="colosseum-intermission__head">
        <div className="colosseum-intermission__heading">
          <h2>{title}</h2>
          <p>
            {label}.{nextWave === SOL_WAVE && ' Sol Heredit is next.'}
          </p>
        </div>
        {hideButton}
      </header>

      {/* The options and what is owned scroll together, so a long owned list never squeezes the options. */}
      <div className="colosseum-intermission__body">
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the list; the group only names the options. */}
        <div className="colosseum-intermission__options" role="group" aria-label="Modifiers on offer">
          {offer.options.map(({ id, tier }) => {
            const from = ownedTier(id);
            return (
              <button
                key={id}
                type="button"
                tabIndex={-1}
                className={`colosseum-option${selected === id ? ' is-selected' : ''}`}
                aria-pressed={selected === id}
                disabled={pending}
                onPointerEnter={hover}
                onClick={() => choose(id)}
              >
                <span className="colosseum-option__slot" aria-hidden="true">
                  <ModifierIcon id={id} box={OPTION_ICON_BOX} />
                </span>
                <ModifierName id={id} tier={tier} className="colosseum-option__name">
                  {from > 0 && (
                    <span className="colosseum-option__from"> from {colosseumModifierParts(id, from).numeral}</span>
                  )}
                </ModifierName>
                <span className="colosseum-option__effect">{colosseumTierText(id, tier)}</span>
              </button>
            );
          })}
        </div>

        {others.length > 0 && (
          <div className="colosseum-intermission__more">
            <button
              type="button"
              tabIndex={-1}
              className="colosseum-others-toggle"
              aria-expanded={othersOpen}
              aria-controls={othersId}
              disabled={pending}
              onClick={toggleOthers}
            >
              <DisclosureChevron open={othersOpen} />
              Choose another
              <span className="colosseum-others-toggle__count">{others.length} more</span>
            </button>
            {othersOpen && (
              // Opened below the fold of a short scene (the Fixed client's), it scrolls into view.
              <div id={othersId} ref={revealInScroller}>
                {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the grid; the group only names the picks. */}
                <div className="colosseum-intermission__others" role="group" aria-label="Other modifiers">
                  {others.map(({ id, tier }) => (
                    <button
                      key={id}
                      type="button"
                      tabIndex={-1}
                      className={`colosseum-other${selected === id ? ' is-selected' : ''}`}
                      aria-pressed={selected === id}
                      disabled={pending}
                      onPointerEnter={hover}
                      onClick={() => choose(id)}
                    >
                      <span className="colosseum-other__icon" aria-hidden="true">
                        <ModifierIcon id={id} box={OWNED_ICON_BOX} />
                      </span>
                      <ModifierName id={id} tier={tier} className="colosseum-other__name" />
                    </button>
                  ))}
                </div>
                <p className="colosseum-intermission__other-effect" aria-live="polite">
                  {selectedOther && selected !== null ? (
                    <>
                      {colosseumTierText(selected, selectedTier)}
                      {ownedTier(selected) > 0 && (
                        <span className="colosseum-intermission__from">
                          {' '}
                          Up from {colosseumModifierLabel(selected, ownedTier(selected))}.
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="colosseum-intermission__prompt">Pick one instead of the three above.</span>
                  )}
                </p>
              </div>
            )}
          </div>
        )}

        {owned.length > 0 && (
          <div className="colosseum-intermission__owned">
            <h3>Owned</h3>
            <ul aria-label="Owned modifiers">
              {owned.map((modifier) => (
                <li key={modifier.id}>
                  <span className="colosseum-owned__icon" aria-hidden="true">
                    <ModifierIcon id={modifier.id} box={OWNED_ICON_BOX} />
                  </span>
                  <ModifierName id={modifier.id} tier={modifier.tier} className="colosseum-owned__name" />
                  <span className={`colosseum-owned__source colosseum-owned__source--${modifier.source.origin}`}>
                    {colosseumOwnedSourceText(modifier.source)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <footer className="colosseum-intermission__foot">{continueButton}</footer>
    </section>
  );
};
