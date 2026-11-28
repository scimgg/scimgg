import { useState } from 'react';
import { flushSync } from 'react-dom';
import type { MechanicsConfig } from '../../types/simulation';
import type { EncounterToolProps } from '../practiceChrome';
import {
  INFERNO_DESTROYED_PILLAR_KEYS,
  INFERNO_SPAWN_LAYOUT_KEY,
  INFERNO_START_TILE_KEY,
  INFERNO_START_WAVE_KEY,
  resolveInfernoRunSetup,
} from './controls';
import { InfernoSetup } from './InfernoSetup';
import { InfernoSpawnSetup } from './InfernoSpawnSetup';

export function InfernoLayoutTool(props: EncounterToolProps) {
  // The host retains closed tools. A new spawned setup replaces the old draft;
  // closing/reopening on the same wave keeps the user's local edits.
  return <InfernoLayoutDraft key={JSON.stringify(props.run?.currentSetup)} {...props} />;
}

function InfernoLayoutDraft({ config, onChange, run, onClose, exportGear }: EncounterToolProps) {
  const [draft, setDraft] = useState<Partial<MechanicsConfig>>(() => run?.currentSetup ?? {});
  const edited = { ...config, ...draft };
  const { startWave } = resolveInfernoRunSetup(edited);
  const change = (next: MechanicsConfig) => {
    // Own only layout fields: other Practice settings still follow the saved config.
    setDraft(
      Object.fromEntries(
        [
          INFERNO_START_WAVE_KEY,
          INFERNO_SPAWN_LAYOUT_KEY,
          INFERNO_START_TILE_KEY,
          ...Object.values(INFERNO_DESTROYED_PILLAR_KEYS),
        ].map((key) => [key, next[key]]),
      ),
    );
    onChange(next);
  };
  return (
    <div className="spawn-layout-tool inferno-layout-tool">
      <div className="spawn-layout-tool__setup">
        <InfernoSetup config={edited} onChange={change} surface="tool" />
      </div>
      <InfernoSpawnSetup
        config={edited}
        onChange={change}
        surface="tool"
        exportGear={exportGear}
        onStart={
          run
            ? () => {
                // Commit the initially unsaved seed before the command reads mechanics.
                flushSync(() => onChange(edited));
                run.execute({ encounter: 'inferno', type: 'go-to-wave', wave: startWave });
                onClose();
              }
            : undefined
        }
      />
    </div>
  );
}
