import type React from 'react';
import { useEffect, useState } from 'react';
import { RESET_BUTTON } from '../resourcePack';
import type { SetupContextControls } from '../types/setupContext';
import { PixelSprite } from './PixelSprite';
import { HoverHintButton } from './ui/HoverHintControl';
import './ResetToDefaults.css';

const RESET_HINT = 'Puts these options back to their defaults. Gear is not changed.';

export type ResetToDefaultsState = 'hidden' | 'available' | 'restored';

export interface ResetToDefaults {
  readonly state: ResetToDefaultsState;
  readonly reset: () => void;
  readonly undo: () => void;
}

/**
 * "Reset to defaults", then "Defaults restored" with its Undo, for one encounter or variant
 * (`scope`). Hidden where there is no reset to offer (a tutorial, a replay) or nothing to reset.
 *
 * The Undo lasts while the options stay at their defaults: the first change away from them (on this
 * surface or another) ends it, as does a different `scope`; unmounting the surface drops it. It
 * waits for the defaults to be seen before watching for that change, so a reset whose result
 * arrives a render late cannot end its own Undo.
 */
export function useResetToDefaults(context: SetupContextControls | undefined, scope: string): ResetToDefaults {
  const [pending, setPending] = useState<{
    readonly undo: () => void;
    readonly scope: string;
    readonly seenDefault: boolean;
  } | null>(null);
  const onReset = context?.onReset;
  const isDefault = context?.isDefault ?? true;
  useEffect(() => {
    if (!pending) return;
    if (pending.scope !== scope || !onReset) setPending(null);
    else if (isDefault && !pending.seenDefault) setPending({ ...pending, seenDefault: true });
    else if (!isDefault && pending.seenDefault) setPending(null);
  }, [pending, scope, onReset, isDefault]);

  const restored = pending !== null && pending.scope === scope && onReset !== undefined && isDefault;
  return {
    state: !onReset ? 'hidden' : restored ? 'restored' : isDefault ? 'hidden' : 'available',
    reset: () => {
      if (!onReset) return;
      setPending({ undo: onReset(), scope, seenDefault: false });
    },
    undo: () => {
      if (!pending) return;
      setPending(null);
      pending.undo();
    },
  };
}

/** A quiet text action: the configurer's and Practice's Undo, and the Inferno link notice's. */
export const UndoButton: React.FC<{
  readonly onClick: () => void;
  readonly hint: string;
  readonly className?: string;
}> = ({ onClick, hint, className = '' }) => (
  <HoverHintButton
    type="button"
    tabIndex={-1}
    className={`undo-action ${className}`.trim()}
    aria-label="Undo"
    hint={hint}
    onMouseDown={(event) => event.preventDefault()}
    onClick={onClick}
  >
    Undo
  </HoverHintButton>
);

/**
 * The reset as a ghost action with the pack's reset glyph, or, once pressed, the restored status and
 * its Undo in the same place. Nothing when hidden. `variant` picks the face: the configurer's rail
 * heading row, or the end of Practice's settings.
 */
export const ResetToDefaultsControl: React.FC<{
  readonly control: ResetToDefaults;
  readonly variant: 'rail' | 'practice';
}> = ({ control, variant }) => {
  if (control.state === 'hidden') return null;
  return (
    <div className={`reset-defaults reset-defaults--${variant}`}>
      {control.state === 'restored' ? (
        <>
          <span className="reset-defaults__status" role="status">
            Defaults restored
          </span>
          <UndoButton onClick={control.undo} hint="Puts back the options you had before the reset." />
        </>
      ) : (
        <HoverHintButton
          type="button"
          tabIndex={-1}
          className="reset-defaults__action"
          aria-label="Reset to defaults"
          hint={RESET_HINT}
          onMouseDown={(event) => event.preventDefault()}
          onClick={control.reset}
        >
          <PixelSprite src={RESET_BUTTON.enabled} width={15} height={14} alt="" aria-hidden="true" />
          Reset to defaults
        </HoverHintButton>
      )}
    </div>
  );
};

/**
 * Back to the modifiers the setup suggests (a Colosseum start wave's), in the modifier editor's
 * heading: the Reset to defaults recipe, with the glyph before a label naming those defaults.
 */
export function ModifierDefaultsReset({ label, reset }: { readonly label: string; readonly reset: () => void }) {
  return (
    <div className="reset-defaults configurer-modifier-reset">
      <button
        type="button"
        tabIndex={-1}
        className="reset-defaults__action"
        onMouseDown={(event) => event.preventDefault()}
        onClick={reset}
      >
        <PixelSprite src={RESET_BUTTON.enabled} width={15} height={14} alt="" aria-hidden="true" />
        {label}
      </button>
    </div>
  );
}
