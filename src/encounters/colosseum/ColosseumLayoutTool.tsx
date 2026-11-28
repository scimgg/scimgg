import { useState } from 'react';
import { flushSync } from 'react-dom';
import type { MechanicsConfig } from '../../types/simulation';
import type { EncounterToolProps } from '../practiceChrome';
import {
  COLOSSEUM_SPAWN_LAYOUT_KEY,
  COLOSSEUM_START_TILE_KEY,
  COLOSSEUM_START_WAVE_KEY,
  resolveColosseumStartWave,
} from '../solHeredit/controls';
import { ColosseumSetup } from './ColosseumSetup';
import { ColosseumSpawnSetup } from './ColosseumSpawnSetup';

/** The setup this tool owns: the rest of Practice's settings follow the saved config. */
const LAYOUT_KEYS = [COLOSSEUM_START_WAVE_KEY, COLOSSEUM_SPAWN_LAYOUT_KEY, COLOSSEUM_START_TILE_KEY] as const;

/**
 * The Fortis Colosseum's Edit layout tool, under the same rules as the Inferno's (`InfernoLayoutTool`):
 * it opens on a copy of the wave being fought (`colosseumCurrentSetup`), random spawns included, so
 * Start repeats them; opening and closing save nothing, every edit saves, and Start saves the copy
 * and restarts the fight from its wave.
 */
export function ColosseumLayoutTool(props: EncounterToolProps) {
  // The host retains closed tools. A newly spawned wave replaces the old draft; closing and reopening
  // on the same wave keeps the player's local edits.
  return <ColosseumLayoutDraft key={JSON.stringify(props.run?.currentSetup)} {...props} />;
}

function ColosseumLayoutDraft({ config, onChange, run, onClose }: EncounterToolProps) {
  const [draft, setDraft] = useState<Partial<MechanicsConfig>>(() => run?.currentSetup ?? {});
  const edited = { ...config, ...draft };
  const startWave = resolveColosseumStartWave(edited);
  const change = (next: MechanicsConfig) => {
    setDraft(Object.fromEntries(LAYOUT_KEYS.map((key) => [key, next[key]])));
    onChange(next);
  };
  return (
    <div className="spawn-layout-tool colosseum-layout-tool">
      <div className="spawn-layout-tool__setup">
        <ColosseumSetup config={edited} onChange={change} surface="tool" />
      </div>
      <ColosseumSpawnSetup
        config={edited}
        onChange={change}
        surface="tool"
        onStart={
          run
            ? () => {
                // Commit the initially unsaved copy before the restart reads the setup.
                flushSync(() => onChange(edited));
                run.execute({ encounter: 'sol_heredit', type: 'go-to-wave', wave: startWave });
                onClose();
              }
            : undefined
        }
      />
    </div>
  );
}
