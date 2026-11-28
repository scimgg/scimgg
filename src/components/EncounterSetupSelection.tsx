import { useId, useState } from 'react';
import type { EncounterModifierDefinition, EncounterModifierSelection } from '../core/encounters/encounterFactory';
import type { EncounterVariant } from '../core/encounters/types';
import { PixelSprite } from './PixelSprite';
import { DisclosureChevron } from './ui/DisclosureChevron';
import { OsrsButton } from './ui/OsrsButton';
import { BetaBadge } from './ui/StatusBadge';
import { WikiLink } from './WikiLink';

const OVERVIEW_ICON_BOX = { maxWidth: 20, maxHeight: 20 } as const;

/** Primary encounter choices, before preparation. Metadata owns the differences, never boss names. */
export function EncounterSetupSelection({
  variants,
  selectedKind,
  baseKind,
  onVariantChange,
  modifiers,
  value,
  onEdit,
  heading = 'Modifiers',
}: {
  variants?: readonly EncounterVariant[];
  selectedKind: string;
  baseKind?: string;
  onVariantChange?: (kind: string) => void;
  modifiers?: readonly EncounterModifierDefinition[];
  value: EncounterModifierSelection;
  onEdit?: () => void;
  /** The modifier section's name, where an encounter qualifies it ("Modifiers going into wave 8"). */
  heading?: string;
}) {
  const [contractsOpen, setContractsOpen] = useState(false);
  const contractsId = useId();
  const [termsOpen, setTermsOpen] = useState(() => baseKind !== undefined && selectedKind !== baseKind);
  const selected = variants?.find((v) => v.encounterKind === selectedKind);
  const shown = modifiers?.filter((m) => value[m.id] !== undefined) ?? [];
  return (
    <>
      {variants && variants.length > 1 && onVariantChange && (
        <section className="configurer-contracts">
          <h3>Contract</h3>
          <button
            type="button"
            tabIndex={-1}
            className="configurer-contract-current"
            aria-label={`Change contract: ${selected?.name ?? 'Choose a contract'}`}
            aria-expanded={contractsOpen}
            aria-controls={contractsId}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setContractsOpen((open) => !open)}
          >
            <span>{selected?.name ?? 'Choose a contract'}</span>
            <span className="configurer-contract-action">{contractsOpen ? 'Done' : 'Change'}</span>
          </button>
          <div className="configurer-contract-options" id={contractsId} hidden={!contractsOpen}>
            {variants.map((v) => (
              <button
                type="button"
                tabIndex={-1}
                key={v.id}
                aria-pressed={v.encounterKind === selectedKind}
                aria-description={!v.available ? 'Not yet implemented' : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setContractsOpen(false);
                  if (v.encounterKind === selectedKind) return;
                  // Choosing different terms reveals their consequence. A reader's
                  // explicit collapse survives every other interaction and rerender.
                  if (baseKind !== undefined && v.encounterKind !== baseKind) setTermsOpen(true);
                  onVariantChange(v.encounterKind);
                }}
              >
                {v.name}
                {v.isWorkInProgress && (
                  <span className="variant-item-badge">
                    <BetaBadge compact />
                  </span>
                )}
              </button>
            ))}
          </div>
          {selected && (
            /* Keep the disclosure mounted across variants. Opening a different contract
               reveals its terms, while ordinary setup edits leave the reader's choice alone. */
            <details
              className="configurer-contract-terms"
              open={termsOpen}
              onToggle={(event) => setTermsOpen(event.currentTarget.open)}
            >
              {/* The Beta caveat rides the summary rather than a heading inside the panel, so
                  it is readable without opening anything. The dense list keeps its compact
                  mark; this is the one in open space. */}
              <summary tabIndex={-1}>
                <DisclosureChevron />
                <span>Contract terms</span>
                {selected.isWorkInProgress && <BetaBadge />}
              </summary>
              {selected.terms?.length ? (
                <ul className="variant-detail-terms">
                  {selected.terms.map((term) => (
                    <li key={term}>{term}</li>
                  ))}
                </ul>
              ) : (
                <p className="variant-detail-subtitle">{selected.subtitle}</p>
              )}
              {selected.reward && (
                <p className="variant-detail-reward">
                  <span className="variant-detail-reward-label">Reward</span>
                  {selected.reward}
                </p>
              )}
              {selected.wikiUrl && <WikiLink href={selected.wikiUrl} subject={selected.name} />}
              {!selected.available && <p>Not yet implemented</p>}
            </details>
          )}
        </section>
      )}
      {modifiers?.length && onEdit ? (
        <section className="configurer-modifiers">
          <div className="configurer-section-head">
            <h3>
              {heading}
              {/* A count, not part of the name. Zero is already said in full below. */}
              {shown.length > 0 && <span> ({shown.length})</span>}
            </h3>
            {/* A resting frame, not a ghost: touch has no hover to reveal one with, and this
                is the only way into the full modifier list. */}
            <OsrsButton onClick={onEdit}>Details &amp; edit</OsrsButton>
          </div>
          {shown.length ? (
            <ul className="configurer-modifier-overview" aria-label="Selected modifiers">
              {shown.map((modifier) => (
                <li key={modifier.id}>
                  <span className="configurer-modifier-label">
                    <span className="configurer-modifier-name">{modifier.name}</span>{' '}
                    <span className="configurer-modifier-tier">{'I'.repeat(value[modifier.id])}</span>
                  </span>
                  {/* Text paints before the canvas; the grid puts the familiar artwork first. */}
                  <span className="configurer-modifier-icon" aria-hidden="true">
                    {modifier.icon && <PixelSprite src={modifier.icon} style={OVERVIEW_ICON_BOX} />}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="configurer-modifier-empty">No modifiers selected.</p>
          )}
        </section>
      ) : null}
    </>
  );
}
