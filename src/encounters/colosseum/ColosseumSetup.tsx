import type React from 'react';
import { useId, useRef } from 'react';
import { InfoHint } from '../../components/ui/InfoHint';
import { OsrsNumberInput } from '../../components/ui/OsrsNumberInput';
import type { EncounterModifierSelection } from '../../core/encounters/encounterFactory';
import type { MechanicsConfig } from '../../types/simulation';
import type { EncounterSetupControlsProps } from '../practiceChrome';
import {
  COLOSSEUM_START_WAVE_KEY,
  colosseumRunSetupKey,
  resolveColosseumRunSetup,
  resolveColosseumStartWave,
} from '../solHeredit/controls';
import { ColosseumSpawnSetup } from './ColosseumSpawnSetup';
import { colosseumWaveText } from './runChrome';
import { FIRST_COLOSSEUM_WAVE, SOL_WAVE } from './waves/waveTable';
import './ColosseumSetup.css';

/** The mechanics keys this control draws, so the generic list does not draw a row for them too. */
export const COLOSSEUM_SETUP_KEYS: readonly string[] = [COLOSSEUM_START_WAVE_KEY];

const START_WAVE_INFO = {
  rail: `The wave the run starts on. Each cleared wave offers three modifiers to choose from, then continues into the next, through Sol Heredit on wave ${SOL_WAVE}. You start with the modifiers below; until you change them they follow the start wave.`,
  practice: 'The saved start wave. It applies when you restart the fight.',
  tool: 'The wave this layout is for. Changing it saves the start wave. Start wave restarts the fight with your setup; unplaced monsters spawn at random.',
} as const;

/**
 * The footer's line beside Start Encounter: the waves the run covers, a custom layout where the run
 * will use one (as the Inferno's), and how many modifiers it starts with.
 */
export function colosseumSetupSummary(config: MechanicsConfig, modifiers: EncounterModifierSelection): string {
  const { startWave, spawnLayout } = resolveColosseumRunSetup(config);
  const count = Object.keys(modifiers).length;
  const owned = count === 0 ? 'No modifiers' : `${count} modifier${count === 1 ? '' : 's'}`;
  if (startWave === SOL_WAVE) return `Sol Heredit · ${owned}`;
  return [`Waves ${startWave}–${SOL_WAVE}`, ...(spawnLayout ? ['Custom layout'] : []), owned].join(' · ');
}

export interface ColosseumSetupProps extends Omit<EncounterSetupControlsProps, 'surface'> {
  /** `tool` is the start-wave head of the layout tool (`ColosseumLayoutTool`), which draws the map itself. */
  readonly surface: EncounterSetupControlsProps['surface'] | 'tool';
}

/**
 * The Fortis Colosseum's start wave: a number field, as the Inferno's, since twelve buttons would
 * not fit the Practice pane and the player arrives knowing the number. Wave 12 is the direct Sol
 * Heredit fight; any earlier wave plays on from there, and the line under the field says what that
 * wave spawns. The modifier set follows it in the rail, since its default depends on the wave. For
 * waves 1-11 the rail also edits that wave's spawn layout and start tile (`ColosseumSpawnSetup`);
 * in a fight, the top chrome's Edit layout tool does (`ColosseumLayoutTool`), as in the Inferno.
 *
 * Changing it never restarts anything: it is saved, and the next attempt starts there.
 */
export const ColosseumSetup: React.FC<ColosseumSetupProps> = ({ config, onChange, surface, run }) => {
  const startWave = resolveColosseumStartWave(config);
  const fieldId = useId();
  const labelRef = useRef<HTMLDivElement>(null);
  const setWave = (wave: number) => {
    const next = Math.min(SOL_WAVE, Math.max(FIRST_COLOSSEUM_WAVE, Math.round(wave)));
    onChange({ ...config, [COLOSSEUM_START_WAVE_KEY]: String(next) });
  };
  // The saved setup against the one the run started with (wave, layout and start tile), derived
  // rather than held, so it survives the pane closing.
  const pending = run !== undefined && colosseumRunSetupKey(resolveColosseumRunSetup(config)) !== run.startedWith;

  return (
    <div className={`colosseum-setup colosseum-setup--${surface}`}>
      <div className="colosseum-setup__head">
        <div ref={labelRef} className="colosseum-setup__title info-hint-region">
          <label htmlFor={fieldId}>Start wave</label>
          <InfoHint label="Start wave" text={START_WAVE_INFO[surface]} hoverRegionRef={labelRef} />
        </div>
        <OsrsNumberInput
          id={fieldId}
          className="colosseum-setup__input"
          value={String(startWave)}
          min={FIRST_COLOSSEUM_WAVE}
          max={SOL_WAVE}
          fieldWidth={24}
          suffix={`/ ${SOL_WAVE}`}
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            if (Number.isInteger(parsed)) setWave(parsed);
          }}
        />
      </div>
      {surface !== 'practice' && (
        <p className="colosseum-setup__wave">
          <span>{startWave === SOL_WAVE ? 'Sol Heredit.' : colosseumWaveText(startWave)}</span>
          {surface === 'rail' && (
            <span className="colosseum-setup__continues">
              {startWave === SOL_WAVE
                ? 'The final wave of the Fortis Colosseum.'
                : `Starts with the modifiers below and offers another before each wave, through to Sol Heredit at wave ${SOL_WAVE}.`}
            </span>
          )}
        </p>
      )}
      {surface === 'rail' && <ColosseumSpawnSetup config={config} onChange={onChange} surface="rail" />}
      {surface === 'practice' && pending && (
        <p className="colosseum-setup__pending" role="status">
          Setup saved. Restart the fight to start wave {startWave} with it.
        </p>
      )}
    </div>
  );
};
