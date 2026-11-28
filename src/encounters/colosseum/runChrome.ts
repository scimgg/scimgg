/**
 * What the app's chrome shows of a Fortis Colosseum run: the wave, the modifiers owned and offered,
 * and the words for them.
 *
 * Pure reads of the Sol Heredit snapshot's `run` (`colosseumRunState`), so the chrome can never
 * disagree with the fight about which wave it is or what the player owns.
 */
import type { InfoBoxData } from '../../components/InfoBox/infoboxTypes';
import type { EncounterSnapshot } from '../../core/encounters/snapshot';
import { isSolHereditSnapshot } from '../../core/encounters/snapshot';
import { getItemSpriteUrl } from '../../services/ItemSpriteService';
import type { MechanicsConfig } from '../../types/simulation';
import { colosseumRunSetupKey, colosseumSetupMechanics } from '../solHeredit/controls';
import {
  COLOSSEUM_MODIFIERS,
  type ColosseumModifierDefinition,
  type ColosseumModifierId,
} from './modifiers/definitions';
import { type ColosseumPick, colosseumRunState } from './waves/snapshot';
import { parseColosseumSpawnLayout, resolveColosseumStartTile } from './waves/spawnLayout';
import { type ColosseumWaveSpecies, colosseumWave, SOL_WAVE } from './waves/waveTable';

/** The Colosseum's own reward, so the wave tile reads as this fight rather than another counter. */
const WAVE_TILE_SPRITE = getItemSpriteUrl(28951); // Dizana's quiver

const NUMERALS = ['', 'I', 'II', 'III'] as const;

export function colosseumModifierDefinition(id: ColosseumModifierId): ColosseumModifierDefinition | undefined {
  return COLOSSEUM_MODIFIERS.find((definition) => definition.id === id);
}

/** The name and its Roman tier, which a modifier with one tier ("Quartet") does not show. */
export function colosseumModifierParts(
  id: ColosseumModifierId,
  tier: number,
): { readonly name: string; readonly numeral: string } {
  const definition = colosseumModifierDefinition(id);
  const name = definition?.name ?? id;
  if (!definition || definition.tiers.length === 1) return { name, numeral: '' };
  return { name, numeral: NUMERALS[tier] ?? String(tier) };
}

/** "Doom II", or the bare name for a modifier with one tier ("Quartet"), as the configurer names them. */
export function colosseumModifierLabel(id: ColosseumModifierId, tier: number): string {
  const { name, numeral } = colosseumModifierParts(id, tier);
  return numeral ? `${name} ${numeral}` : name;
}

/** What the modifier does at `tier`: the definition's own text for that tier. */
export function colosseumTierText(id: ColosseumModifierId, tier: number): string {
  const definition = colosseumModifierDefinition(id);
  if (!definition) return '';
  return definition.tiers[tier - 1] ?? definition.summary;
}

export interface ColosseumOwnedModifier {
  readonly id: ColosseumModifierId;
  readonly tier: number;
  /**
   * Where the tier now held came from: the run's configured set, or the wave whose intermission it
   * was picked going into (the `origin` of the pick that gave it).
   */
  readonly source: { readonly origin: 'set' } | { readonly origin: 'live'; readonly wave: number };
}

/**
 * The modifiers the picks add up to, each at its highest tier, in the order first picked. A pick
 * records the tier it gave, so the highest one of an id is the tier owned and names its source.
 */
export function colosseumOwnedModifiers(picks: readonly ColosseumPick[]): ColosseumOwnedModifier[] {
  const owned = new Map<ColosseumModifierId, ColosseumOwnedModifier>();
  for (const pick of picks) {
    const previous = owned.get(pick.id);
    if (previous && previous.tier >= pick.tier) continue;
    const source = pick.origin === 'set' ? { origin: 'set' as const } : { origin: 'live' as const, wave: pick.wave };
    owned.set(pick.id, { id: pick.id, tier: pick.tier, source });
  }
  return [...owned.values()];
}

/** The owned tier's source in a few words: "Setup", or "Wave 7" for a pick made going into wave 7. */
export function colosseumOwnedSourceText(source: ColosseumOwnedModifier['source']): string {
  return source.origin === 'set' ? 'Setup' : `Wave ${source.wave}`;
}

const SPECIES_NAMES: Readonly<Record<ColosseumWaveSpecies, { readonly one: string; readonly many: string }>> = {
  serpentShaman: { one: 'serpent shaman', many: 'serpent shamans' },
  javelinColossus: { one: 'javelin colossus', many: 'javelin colossi' },
  manticore: { one: 'manticore', many: 'manticores' },
  shockwaveColossus: { one: 'shockwave colossus', many: 'shockwave colossi' },
  jaguarWarrior: { one: 'jaguar warrior', many: 'jaguar warriors' },
  minotaur: { one: 'minotaur', many: 'minotaurs' },
};

function speciesList(species: readonly ColosseumWaveSpecies[]): string {
  const counts = new Map<ColosseumWaveSpecies, number>();
  for (const kind of species) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts]
    .map(([kind, count]) => (count === 1 ? `1 ${SPECIES_NAMES[kind].one}` : `${count} ${SPECIES_NAMES[kind].many}`))
    .join(', ');
}

/**
 * What a wave spawns: the Fremennik warband that opens every one, its own starting monsters, and the
 * reinforcements that join a wave still going. Read from the wave table, never typed in here.
 */
export function colosseumWaveText(wave: number): string {
  if (wave >= SOL_WAVE) return 'Sol Heredit';
  const { initial, reinforcements } = colosseumWave(wave);
  return `Fremennik warband, ${speciesList(initial)}. Reinforced by ${speciesList(reinforcements)}.`;
}

/**
 * The setup this run was started with, as the key the setup control compares its saved choice against
 * (`colosseumRunSetupKey`). Read from the run, as the Inferno's `infernoRunStartedWith`, so closing and
 * reopening Practice cannot lose a change not yet applied. '' outside a Colosseum run.
 */
export function colosseumRunStartedWith(snapshot: EncounterSnapshot): string {
  if (!isSolHereditSnapshot(snapshot)) return '';
  const { runSetup } = snapshot.state;
  return colosseumRunSetupKey({
    startWave: colosseumRunState(snapshot.state).startWave,
    spawnLayout: parseColosseumSpawnLayout(runSetup?.startSpawnLayout),
    // Already resolved by the run; absent (a direct start) is the default.
    startTile: resolveColosseumStartTile(runSetup?.startPlayerTile),
  });
}

/**
 * A faithful copy of the wave being fought, as the Inferno's `infernoCurrentSetup`: its number as the
 * start wave, the points it spawned on as the layout, and the tile its points were drawn from as the
 * start, so the layout tool can repeat a random wave. Undefined before the wave spawns.
 */
export function colosseumCurrentSetup(snapshot: EncounterSnapshot): Partial<MechanicsConfig> | undefined {
  if (!isSolHereditSnapshot(snapshot)) return undefined;
  const { runSetup } = snapshot.state;
  const layout = parseColosseumSpawnLayout(runSetup?.waveSpawnLayout);
  const tile = runSetup?.waveStartPlayerTile;
  if (!layout || !tile || layout.wave !== colosseumRunState(snapshot.state).wave) return undefined;
  return colosseumSetupMechanics({ startWave: layout.wave, spawnLayout: layout, startTile: tile });
}

/**
 * The run's wave as an infobox tile, for runs started before Sol: the one readout up in both
 * layouts without opening anything, and where the modifiers a later start picked are listed. A
 * direct Sol start publishes none, as before the waves existed.
 */
export function colosseumWaveInfobox(snapshot: EncounterSnapshot): InfoBoxData | null {
  if (!isSolHereditSnapshot(snapshot)) return null;
  const run = colosseumRunState(snapshot.state);
  if (run.startWave >= SOL_WAVE) return null;
  // The tiers in force (`state.modifiers`), which a choice joins only at its wave's start, in the
  // order they were picked.
  const inForce = snapshot.state.modifiers;
  const owned = colosseumOwnedModifiers(run.picks).flatMap(({ id }) => {
    const tier = inForce[id];
    return tier === undefined ? [] : [{ id, tier }];
  });
  const wave =
    run.wave >= SOL_WAVE ? `Wave ${SOL_WAVE} of ${SOL_WAVE}, Sol Heredit.` : `Wave ${run.wave} of ${SOL_WAVE}.`;
  const modifiers =
    owned.length > 0
      ? ` Modifiers: ${owned.map(({ id, tier }) => colosseumModifierLabel(id, tier)).join(', ')}.`
      : ' No modifiers yet.';
  return {
    id: 'colosseum-wave',
    spriteUrl: WAVE_TILE_SPRITE,
    // A count, not a countdown: `ticksRemaining` stays unset so the tile shows this text.
    text: String(run.wave),
    tooltipTitle: 'Fortis Colosseum',
    tooltipDetail: `${wave}${modifiers}`,
  };
}
