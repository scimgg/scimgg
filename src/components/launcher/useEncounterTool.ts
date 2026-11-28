import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EncounterCommand } from '../../core/encounters/commands';
import {
  type EncounterSetupRun,
  encounterCurrentSetup,
  encounterSetupStage,
  encounterSetupStartedWith,
  encounterToolFor,
} from '../../encounters/practiceChrome';
import type { MechanicsConfig, SimulationState } from '../../types/simulation';

/** Shared desktop/mobile lifecycle. Closing retains the editor; leaving the encounter discards it. */
export function useEncounterTool(
  props: {
    simulationState: SimulationState;
    mechanicsConfig: MechanicsConfig;
    onMechanicsConfigChange: (config: MechanicsConfig) => void;
    onExecuteEncounterCommand: (command: EncounterCommand) => void;
    /** The running encounter's selected loadout as a portable setup (`EncounterToolProps.exportGear`). */
    exportEncounterGear?: () => string;
    /**
     * Told when the tool opens (true) and when it closes or unmounts (false), so the app can hold the
     * live fight under it, as it does under a modal.
     */
    onEncounterToolOpenChange?: (open: boolean) => void;
  },
  replaying = false,
) {
  const encounter = props.simulationState.encounter;
  const definition = encounterToolFor(encounter);
  const stage = encounterSetupStage(encounter);
  const startedWith = encounterSetupStartedWith(encounter);
  const currentKey = JSON.stringify(encounterCurrentSetup(encounter));
  const run = useMemo<EncounterSetupRun | undefined>(
    () =>
      stage === null
        ? undefined
        : {
            stage,
            startedWith,
            execute: props.onExecuteEncounterCommand,
            currentSetup: currentKey ? JSON.parse(currentKey) : undefined,
          },
    [stage, startedWith, props.onExecuteEncounterCommand, currentKey],
  );
  const disabledReason = replaying
    ? `${definition?.label ?? 'Editing'} is off during replay.`
    : definition?.disabledReason(run);
  const [state, setState] = useState<{ id: string; open: boolean } | null>(null);
  const open = state?.id === encounter.kind && state.open && !!definition && !disabledReason;
  const close = useCallback(() => setState((current) => current && { ...current, open: false }), []);
  useEffect(() => {
    setState((current) => (current?.id === encounter.kind ? current : null));
  }, [encounter.kind]);
  useEffect(() => {
    if (disabledReason || !definition) close();
  }, [disabledReason, definition, close]);
  const { onEncounterToolOpenChange } = props;
  useEffect(() => {
    if (!open || !onEncounterToolOpenChange) return;
    onEncounterToolOpenChange(true);
    return () => onEncounterToolOpenChange(false);
  }, [open, onEncounterToolOpenChange]);
  const content = useMemo(
    () =>
      definition?.render({
        config: props.mechanicsConfig,
        onChange: props.onMechanicsConfigChange,
        run,
        onClose: close,
        exportGear: props.exportEncounterGear,
      }),
    [definition, props.mechanicsConfig, props.onMechanicsConfigChange, run, close, props.exportEncounterGear],
  );
  return {
    definition,
    disabledReason,
    open,
    close,
    mounted: state?.id === encounter.kind && !!definition,
    content,
    toggle: () => {
      if (!disabledReason && definition)
        setState((current) => ({ id: encounter.kind, open: current?.id !== encounter.kind || !current.open }));
    },
  };
}
