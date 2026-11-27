import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectSetupToggles } from '../../components/EncounterPanel.helpers';
import { resolveEncounterMapFootprint } from '../../core/encounters/mapFootprint';
import { SimulationEngine } from '../../core/SimulationEngine';
import { HEALING_TOTEM_NPC_ID } from '../../npcs/colosseum/constants';
import { ZUK_HEALER_NPC_ID, ZUK_SEQS } from '../../npcs/inferno/constants';
import { getEncounterRenderConfig } from '../../render/scene/encounterRenderConfig';
import { sceneBuilderRegistry } from '../../render/scene/sceneBuilderFactory';
import { BOOLEAN_MECHANICS_KEY_SET, type MechanicsConfig, mergeMechanicsConfig } from '../../types/simulation';
import {
  baseEncounterKind,
  canonicalEncounterKind,
  ENCOUNTER_CATALOG,
  REGISTERED_CATALOG_KINDS,
  RETIRED_ENCOUNTER_KINDS,
} from '../catalog';
import { LOBBY_BOSS_NPCS, LOBBY_NPC_ENCOUNTERS, LOBBY_PORTALS } from '../lobby/metadata';
import {
  ENCOUNTER_CORE_MODULES,
  encounterControlsForKind,
  encounterEnablesIntro,
  encounterKindsOf,
  resolveEncounterEntry,
} from '../modules';
import {
  DEFAULT_ORBIT_PITCH,
  ENCOUNTER_PRESENTATION_MODULES,
  encounterAudioLayers,
  encounterDefaultCamera,
  encounterPresentationModuleForKind,
  FALLBACK_ENCOUNTER_CAMERA,
  orbitYawToward,
} from '../presentationModules';
import { encounterRegistry } from '../registry';
import { collectDeclaredNpcSeqIds, ENCOUNTER_RENDER_CONFIGS } from '../renderConfigs';
import { RETIRED_SLUG_TO_KIND, SLUG_TO_KIND } from '../slugs';
import { YAMA_CONTRACTS } from '../yamaP3/contracts';

/**
 * Registration invariants, asserted against the registries rather than the manifest so a
 * manifest refactor cannot make them vacuous.
 */

const YAMA_BASE_KIND = 'yama_p3';
const YAMA_VARIANT_KINDS = [
  'yama_p3_divine',
  'yama_p3_forfeit_breath',
  'yama_p3_sensory',
  'yama_p3_bloodied',
  'yama_p3_glyphic',
] as const;

/** Every kind that owns a descriptor, i.e. is selectable in the picker in its own right. */
const BASE_KINDS = ['yama_p3', 'lobby', 'sol_heredit', 'inferno'] as const;
const BETA_ENCOUNTERS = [{ kind: 'sol_heredit', displayName: 'Sol Heredit', actorId: 'lobby-npc-2' }] as const;

describe('encounter registration invariants', () => {
  it('registers exactly the expected kinds, with no duplicates', () => {
    const kinds = encounterRegistry.getRegisteredKinds();
    expect(kinds).toEqual([...new Set(kinds)]);
    expect([...kinds].sort()).toEqual([...BASE_KINDS, ...YAMA_VARIANT_KINDS].sort());
  });

  it('retires Zuk into the Inferno: entering it starts wave 69, and its commands reach the Inferno', () => {
    expect(ENCOUNTER_CATALOG.find((entry) => entry.kind === 'zuk')).toBeUndefined();
    expect(ENCOUNTER_CATALOG.find((entry) => entry.kind === 'inferno')?.retiredKinds).toEqual([
      { kind: 'zuk', slug: 'zuk' },
    ]);
    expect(encounterRegistry.hasKind('zuk')).toBe(false);
    expect(canonicalEncounterKind('zuk')).toBe('inferno');
    expect(baseEncounterKind('zuk')).toBe('inferno');
    expect(resolveEncounterEntry('zuk')).toEqual({ kind: 'inferno', mechanics: { infernoStartWave: '69' } });
    expect(resolveEncounterEntry('inferno')).toEqual({ kind: 'inferno', mechanics: {} });
    expect(resolveEncounterEntry('nothing')).toBeUndefined();
    expect(RETIRED_SLUG_TO_KIND).toEqual(new Map([['zuk', 'zuk']]));
    // Every retired kind has somewhere to enter.
    for (const { retired, kind } of RETIRED_ENCOUNTER_KINDS) {
      expect(
        ENCOUNTER_CORE_MODULES.find((module) => module.kind === kind)?.retiredEntries?.[retired.kind],
      ).toBeDefined();
    }
    expect(
      encounterControlsForKind('inferno')
        ?.debugActions.filter(({ command }) => command.encounter === 'zuk')
        .map(({ command, label }) => ({ command, label })),
    ).toEqual([
      { command: { encounter: 'zuk', type: 'spawn-set' }, label: 'Spawn set' },
      { command: { encounter: 'zuk', type: 'spawn-jad' }, label: 'Spawn Jad' },
      { command: { encounter: 'zuk', type: 'spawn-healers' }, label: 'Spawn healers' },
      { command: { encounter: 'zuk', type: 'respawn-glyph' }, label: 'Reset shield' },
      { command: { encounter: 'zuk', type: 'clear-spawns' }, label: 'Clear minions' },
    ]);
    // The Zuk statue still stands in the lobby, and its card enters the Inferno at wave 69.
    expect(LOBBY_NPC_ENCOUNTERS['lobby-npc-0']).toMatchObject({ encounterKind: 'zuk', displayName: 'The Inferno' });
  });

  it('registers the Inferno as a beta encounter routed at /inferno', () => {
    expect(ENCOUNTER_CATALOG.find((entry) => entry.kind === 'inferno')).toMatchObject({
      registered: true,
      slug: 'inferno',
    });
    expect(encounterRegistry.getDescriptor('inferno')).toMatchObject({
      displayName: 'The Inferno',
      isWorkInProgress: true,
      loadsMapLocs: true,
      playerStart: [30, 32],
      collision: { mode: 'auto', seed: [30, 32] },
      victory: { narrative: 'TZKAL-ZUK DEFEATED' },
    });
    expect(encounterRegistry.getDescriptor('inferno')?.collision?.excludedStaticLocIds).toEqual(new Set([30338]));
    expect(encounterRegistry.getDescriptor('inferno')?.collision?.dynamicLocs?.map((loc) => loc.locId)).toEqual([
      30353, 30354, 30355,
    ]);
    expect(SLUG_TO_KIND.get('inferno')).toBe('inferno');
    // No lobby statue: the picker and the route are its entry points.
    const presentation = encounterPresentationModuleForKind('inferno')?.presentation;
    for (const copy of [
      encounterRegistry.getDescriptor('inferno')?.description,
      presentation?.blurb,
      presentation?.tagline,
    ]) {
      expect(copy, String(copy)).toBeTruthy();
      expect(copy, String(copy)).not.toMatch(/evidence|incomplete|capture|packet|provisional|bug/i);
    }
  });

  it.each(BETA_ENCOUNTERS)('marks $displayName with the Beta badge', ({ kind, displayName, actorId }) => {
    // The badge is what marks the fight as not final; dropping it presents it as finished.
    expect(encounterRegistry.getDescriptor(kind)?.isWorkInProgress).toBe(true);
    expect(LOBBY_NPC_ENCOUNTERS[actorId]).toMatchObject({ encounterKind: kind, displayName });
    expect(LOBBY_BOSS_NPCS.find((npc) => npc.actorId === actorId)).toMatchObject({
      actorId,
      available: true,
    });
  });

  it.each(BETA_ENCOUNTERS)('keeps internal build-status prose out of every player-facing $displayName string', ({
    kind,
    actorId,
  }) => {
    // The Beta badge carries maturity in product vocabulary. Evidence and capture talk is
    // development provenance: it belongs in docs/, not in the picker, panel or lobby card.
    const presentation = encounterPresentationModuleForKind(kind)?.presentation;
    const playerCopy = [
      encounterRegistry.getDescriptor(kind)?.description,
      presentation?.blurb,
      presentation?.tagline,
      LOBBY_NPC_ENCOUNTERS[actorId].description,
    ];
    for (const copy of playerCopy) {
      expect(copy, String(copy)).toBeTruthy();
      expect(copy, String(copy)).not.toMatch(/evidence|incomplete|capture|packet|provisional|bug/i);
    }
  });

  it('offers a lobby encounter card only for statues whose encounter is registered', () => {
    // The card is what the statue click opens, so a card naming an unregistered kind is a
    // dead end: re-listing one here without also re-registering its kind puts a portal to
    // nothing back in the lobby.
    for (const [actorId, card] of Object.entries(LOBBY_NPC_ENCOUNTERS)) {
      // A retired kind (the Zuk statue) counts by the encounter it enters.
      const entry = resolveEncounterEntry(card.encounterKind);
      expect(entry && encounterRegistry.hasKind(entry.kind), `'${actorId}' cards an unregistered kind`).toBe(true);
    }

    for (const npc of LOBBY_BOSS_NPCS) {
      expect(Boolean(LOBBY_NPC_ENCOUNTERS[npc.actorId]), `'${npc.actorId}' availability disagrees with its card`).toBe(
        npc.available,
      );
    }
  });

  it('sends every lobby portal to a registered encounter', () => {
    for (const portal of LOBBY_PORTALS) {
      expect(encounterRegistry.hasKind(portal.encounterKind), `portal '${portal.displayName}'`).toBe(true);
    }
  });

  it('builds an encounter whose kind matches its registration key', () => {
    for (const kind of encounterRegistry.getRegisteredKinds()) {
      // Yama contract variants intentionally report their own contract kind.
      expect(encounterRegistry.create(kind).kind, `kind mismatch for '${kind}'`).toBe(kind);
    }
  });

  it('gives every base kind a descriptor whose kind agrees with its key', () => {
    for (const kind of BASE_KINDS) {
      const descriptor = encounterRegistry.getDescriptor(kind);
      expect(descriptor, `missing descriptor for '${kind}'`).toBeDefined();
      expect(descriptor?.kind).toBe(kind);
    }
  });

  it('declares each map footprint with one origin entry, no repeated square, and the arena from the origin', () => {
    for (const kind of BASE_KINDS) {
      const descriptor = encounterRegistry.getDescriptor(kind);
      const offsets = descriptor?.mapSquareOffsets ?? [{ dx: 0, dy: 0 }];
      const keys = offsets.map(({ dx, dy }) => `${dx},${dy}`);
      expect(
        keys.filter((key) => key === '0,0'),
        `${kind}: origin entries`,
      ).toHaveLength(1);
      expect(keys, `${kind}: repeated map squares`).toEqual([...new Set(keys)]);
      if (!descriptor) continue;
      // Resolving checks the arena: one square at least, its south-west square the origin.
      const { arenaOffsets } = resolveEncounterMapFootprint(descriptor);
      expect(Math.min(...arenaOffsets.map(({ dx }) => dx)), `${kind}: arena west edge`).toBe(0);
      expect(Math.min(...arenaOffsets.map(({ dy }) => dy)), `${kind}: arena south edge`).toBe(0);
    }
  });

  it("keeps the Inferno's playable arena in its origin square, its four neighbors scenery only", () => {
    const descriptor = encounterRegistry.getDescriptor('inferno');
    if (!descriptor) throw new Error('no Inferno descriptor');
    const footprint = resolveEncounterMapFootprint(descriptor);
    expect(footprint.origin).toEqual({ x: 35, y: 83 });
    // Terrain, locs, the cache trim and the bake still read all five squares.
    expect(footprint.sceneOffsets).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 1, dy: 0 },
      { dx: 0, dy: -1 },
      { dx: -1, dy: 0 },
    ]);
    expect(footprint.arenaOffsets).toEqual([{ dx: 0, dy: 0 }]);
    expect(footprint.arenaTileExtent).toEqual({ width: 64, height: 64 });
    // The render config follows the descriptor: all five drawn, the origin alone composed for actors.
    expect(getEncounterRenderConfig('inferno')).toMatchObject({
      terrainMapSquare: { x: 35, y: 83 },
      mapSquareOffsets: footprint.sceneOffsets,
      arenaMapSquareOffsets: [{ dx: 0, dy: 0 }],
    });
  });

  it("takes every render config's map squares from its descriptor, never the presentation module", () => {
    for (const kind of encounterRegistry.getRegisteredKinds()) {
      const descriptor = encounterRegistry.getDescriptorForKind(kind);
      const config = getEncounterRenderConfig(kind);
      if (!descriptor || !config) continue;
      const footprint = resolveEncounterMapFootprint(descriptor);
      expect(config.terrainMapSquare, kind).toBe(footprint.origin);
      expect(config.mapSquareOffsets, kind).toBe(footprint.sceneOffsets);
      expect(config.arenaMapSquareOffsets, kind).toBe(footprint.arenaOffsets);
    }
  });

  it('gives Yama variants a factory but NO descriptor of their own', () => {
    for (const kind of YAMA_VARIANT_KINDS) {
      expect(encounterRegistry.hasKind(kind), `missing factory for '${kind}'`).toBe(true);
      expect(encounterRegistry.getDescriptor(kind), `unexpected descriptor for '${kind}'`).toBeUndefined();
      expect(encounterRegistry.getDescriptorForKind(kind)?.kind).toBe(YAMA_BASE_KIND);
    }
  });

  it('declares every Yama variant kind in the base descriptor variant list', () => {
    const variants = encounterRegistry.getDescriptor(YAMA_BASE_KIND)?.variants ?? [];
    const declared = variants.map((variant) => variant.encounterKind);
    for (const kind of YAMA_VARIANT_KINDS) {
      expect(declared, `variant '${kind}' not declared on the Yama descriptor`).toContain(kind);
    }
  });

  it('gives every registered encounter kind scene-builder coverage', () => {
    for (const kind of encounterRegistry.getRegisteredKinds()) {
      expect(sceneBuilderRegistry.hasKind(kind), `no scene builder registered for '${kind}'`).toBe(true);
    }
  });

  it('derives the registry from the manifest, with no duplicate kinds', () => {
    const manifestKinds = ENCOUNTER_CORE_MODULES.flatMap(encounterKindsOf);
    expect(manifestKinds).toEqual([...new Set(manifestKinds)]);
    expect([...manifestKinds].sort()).toEqual([...encounterRegistry.getRegisteredKinds()].sort());
  });

  it('gives every manifest kind a render config, except the lobby which needs none', () => {
    for (const kind of encounterRegistry.getRegisteredKinds()) {
      if (kind === 'lobby') continue;
      expect(getEncounterRenderConfig(kind), `no render config for '${kind}'`).toBeDefined();
    }
  });

  it('keeps only registered encounter audio layers (core is appended by the player)', () => {
    // Only the displayed encounter's layer dispatches (`eventAudioLayersFor`), so this order is install
    // and preload order, not precedence between encounters.
    expect(encounterAudioLayers().map((layer) => layer.name)).toEqual(['yama', 'solHeredit', 'inferno']);
  });

  it("gives Yama variants the base encounter's camera, intro and scene builder", () => {
    const yamaVariants = Object.keys(
      ENCOUNTER_CORE_MODULES.find((module) => module.kind === 'yama_p3')?.variantFactories ?? {},
    );
    expect(yamaVariants.length).toBe(5);
    for (const kind of yamaVariants) {
      expect(encounterDefaultCamera(kind)).toEqual(encounterDefaultCamera('yama_p3'));
      expect(encounterEnablesIntro(kind), `variant '${kind}' lost the intro`).toBe(true);
      expect(getEncounterRenderConfig(kind)).toEqual(getEncounterRenderConfig('yama_p3'));
    }
  });

  it('turns an orbit yaw toward a point by the camera’s own convention (0 north, 90 west, 180 south)', () => {
    expect(orbitYawToward([30, 30], [30, 40])).toBe(0);
    expect(orbitYawToward([30, 30], [20, 30])).toBe(90);
    expect(orbitYawToward([30, 30], [30, 20])).toBe(180);
    expect(orbitYawToward([30, 30], [40, 30])).toBe(270);
    // Wave 67: from the default start tile (34,44) to the Jad's center (SW 25,35, size 5: 27,37).
    expect(orbitYawToward([34, 44], [27, 37])).toBe(135);
  });

  it("preserves each encounter's opening camera", () => {
    // Pinned so a manifest edit cannot silently reframe an encounter's entry shot.
    expect(encounterDefaultCamera('lobby')).toEqual({ yaw: 0, pitch: -26.5, zoom: 200 });
    // The Inferno's ordinary waves open facing south, looking down at -50, somewhat zoomed out; wave 1 looks south from the
    // landing tile zoomed well out, wave 67 turns toward its Jad, wave 68 looks south further out over
    // all three, and wave 69 faces Zuk, north of its start tile, as TzKal-Zuk's own entry did.
    const waves = { yaw: 180, pitch: -50, zoom: 300 };
    expect(encounterDefaultCamera('inferno')).toEqual(waves);
    for (const wave of ['2', '30', '66'])
      expect(encounterDefaultCamera('inferno', { infernoStartWave: wave })).toEqual(waves);
    expect(encounterDefaultCamera('inferno', { infernoStartWave: '67' })).toEqual({ ...waves, yaw: 135 });
    expect(encounterDefaultCamera('inferno', { infernoStartWave: '68' })).toEqual({ ...waves, zoom: 220 });
    expect(encounterDefaultCamera('inferno', { infernoStartWave: '1' })).toEqual({
      yaw: 180,
      pitch: DEFAULT_ORBIT_PITCH,
      zoom: 160,
    });
    expect(encounterDefaultCamera('inferno', { infernoStartWave: '69', zukShieldStart: 'left' })).toEqual({
      yaw: 0,
      pitch: -55,
      zoom: 185,
    });
    // A setup camera is the encounter's own: the same mechanics elsewhere change nothing.
    expect(encounterDefaultCamera('yama_p3', { infernoStartWave: '69' })).toEqual(encounterDefaultCamera('yama_p3'));
    expect(encounterDefaultCamera('yama_p3')).toEqual({ yaw: 180, pitch: -62, zoom: 220 });
    // Sol's arena entry runs cam_forceangle(181, 0): north at 181 JAU, zoom left to the player.
    expect(encounterDefaultCamera('sol_heredit')).toEqual({ yaw: 0, pitch: (-181 * 360) / 2048 });
    expect(encounterDefaultCamera('unknown_encounter')).toEqual(FALLBACK_ENCOUNTER_CAMERA);
  });

  it('opens a real run started on wave 69 facing Zuk, from the snapshot Grid reads at scene entry', () => {
    const run = (mechanics: Partial<MechanicsConfig>) =>
      new SimulationEngine({ encounter: encounterRegistry.create('inferno'), mechanics }).getState();
    const atZuk = run({ infernoStartWave: '69' });
    expect(encounterDefaultCamera(atZuk.encounter.kind, atZuk.mechanicsConfig)).toEqual({
      yaw: 0,
      pitch: -55,
      zoom: 185,
    });
    // The default start is wave 69, so a run with no setup opens on Zuk's view too.
    const untouched = run({});
    expect(encounterDefaultCamera(untouched.encounter.kind, untouched.mechanicsConfig)).toEqual({
      yaw: 0,
      pitch: -55,
      zoom: 185,
    });
    const waveOne = run({ infernoStartWave: '1' });
    expect(encounterDefaultCamera(waveOne.encounter.kind, waveOne.mechanicsConfig)).toEqual({
      yaw: 180,
      pitch: DEFAULT_ORBIT_PITCH,
      zoom: 160,
    });
    const waves = run({ infernoStartWave: '30' });
    expect(encounterDefaultCamera(waves.encounter.kind, waves.mechanicsConfig)).toEqual({
      yaw: 180,
      pitch: -50,
      zoom: 300,
    });
    const jads = run({ infernoStartWave: '68' });
    expect(encounterDefaultCamera(jads.encounter.kind, jads.mechanicsConfig)).toMatchObject({ yaw: 180, zoom: 220 });
  });

  it('offers every playable encounter a wiki page, and every stated contract its terms', () => {
    // A missing wikiUrl is silent: the panel simply renders no link, so the invariant is
    // asserted here rather than discovered when a player looks for the page and finds nothing.
    for (const kind of ['yama_p3', 'inferno']) {
      const url = encounterPresentationModuleForKind(kind)?.presentation?.wikiUrl;
      expect(url, `encounter '${kind}' has no wiki page`).toMatch(/^https:\/\/oldschool\.runescape\.wiki\/w\//);
    }

    for (const variant of YAMA_CONTRACTS) {
      if (!variant.terms) continue;
      expect(variant.terms.length, `contract '${variant.id}' states no terms`).toBeGreaterThan(0);
      // A contract that states its terms is quoting a page, so it has to link the page it quotes
      // and name what signing it pays out — the two things the detail pane pins outside the scroll.
      expect(variant.wikiUrl, `contract '${variant.id}' quotes terms with no page`).toMatch(
        /^https:\/\/oldschool\.runescape\.wiki\/w\/Contract_of_/,
      );
      expect(variant.reward, `contract '${variant.id}' states terms but no reward`).toBeTruthy();
    }
  });
});

describe('encounter catalog invariants', () => {
  it('keeps catalog kinds unique across bases and variants', () => {
    const kinds = ENCOUNTER_CATALOG.flatMap((entry) => [entry.kind, ...entry.variantKinds]);
    expect(kinds).toEqual([...new Set(kinds)]);
  });

  it('registers exactly the catalog-registered kinds', () => {
    expect([...encounterRegistry.getRegisteredKinds()].sort()).toEqual([...REGISTERED_CATALOG_KINDS].sort());
  });

  it('withholds every unregistered catalog entry from all product surfaces', () => {
    const unregistered = ENCOUNTER_CATALOG.filter((entry) => !entry.registered);
    for (const entry of unregistered) {
      for (const kind of [entry.kind, ...entry.variantKinds]) {
        expect(encounterRegistry.hasKind(kind), `withheld '${kind}' has a factory`).toBe(false);
        expect(encounterPresentationModuleForKind(kind), `withheld '${kind}' has presentation`).toBeUndefined();
        expect([...SLUG_TO_KIND.values()], `withheld '${kind}' is publicly routed`).not.toContain(kind);
        expect(
          LOBBY_PORTALS.some((portal) => portal.encounterKind === kind),
          `withheld '${kind}' has a lobby portal`,
        ).toBe(false);
        expect(
          Object.values(LOBBY_NPC_ENCOUNTERS).some((card) => card.encounterKind === kind),
          `withheld '${kind}' has a lobby card`,
        ).toBe(false);
      }
    }
  });

  it("matches the yama entry to YAMA_CONTRACTS' declared kinds exactly", () => {
    const entry = ENCOUNTER_CATALOG.find((candidate) => candidate.kind === 'yama_p3');
    const catalogKinds = [entry?.kind, ...(entry?.variantKinds ?? [])].sort();
    const contractKinds = [...new Set(YAMA_CONTRACTS.map((contract) => contract.encounterKind))].sort();
    expect(catalogKinds).toEqual(contractKinds);
  });

  it('derives the public slug table from registered catalog entries', () => {
    expect(SLUG_TO_KIND).toEqual(
      new Map([
        ['yama', 'yama_p3'],
        ['sol-heredit', 'sol_heredit'],
        ['inferno', 'inferno'],
      ]),
    );
  });

  it('agrees between manifest controls defaults and each live encounter', () => {
    for (const kind of encounterRegistry.getRegisteredKinds()) {
      expect(encounterControlsForKind(kind)?.defaultMechanicsConfig, `no controls for '${kind}'`).toEqual(
        encounterRegistry.create(kind).getDefaultMechanicsConfig(),
      );
    }
  });

  it('classifies every checkbox mechanic as boolean while leaving choices string-valued', () => {
    for (const module of ENCOUNTER_CORE_MODULES) {
      const controls = [module.controls, ...Object.values(module.variantControls ?? {})];
      for (const control of controls) {
        for (const toggle of control.mechanicsToggles) {
          expect(
            BOOLEAN_MECHANICS_KEY_SET.has(toggle.key),
            `mechanic '${toggle.key}' has the wrong persisted value kind`,
          ).toBe(toggle.choices === undefined);
        }
      }
    }
  });

  it('scopes every manifest debug command to its owning base encounter', () => {
    for (const module of ENCOUNTER_CORE_MODULES) {
      for (const kind of encounterKindsOf(module)) {
        const controls = encounterControlsForKind(kind);
        expect(controls, `no controls for '${kind}'`).toBeDefined();
        for (const action of controls?.debugActions ?? []) {
          // Zuk's commands keep their `zuk` namespace, which resolves to the Inferno.
          expect(baseEncounterKind(action.command.encounter), `command scope drift for '${kind}'`).toBe(
            baseEncounterKind(kind),
          );
        }
      }
    }
  });

  it('resolves every kind to its owning base kind', () => {
    for (const entry of ENCOUNTER_CATALOG) {
      expect(baseEncounterKind(entry.kind)).toBe(entry.kind);
      for (const variantKind of entry.variantKinds) {
        expect(baseEncounterKind(variantKind)).toBe(entry.kind);
      }
    }
    expect(baseEncounterKind('unknown_kind')).toBe('unknown_kind');
  });

  it('projects both manifests from registered catalog entries exactly', () => {
    const registeredBases = ENCOUNTER_CATALOG.filter((entry) => entry.registered);
    expect(ENCOUNTER_CORE_MODULES.map((module) => module.kind).sort()).toEqual(
      registeredBases.map((entry) => entry.kind).sort(),
    );
    for (const entry of registeredBases) {
      const module = ENCOUNTER_CORE_MODULES.find((candidate) => candidate.kind === entry.kind);
      expect(Object.keys(module?.variantFactories ?? {}).sort(), `variant drift for '${entry.kind}'`).toEqual(
        [...entry.variantKinds].sort(),
      );
    }
    for (const presentation of ENCOUNTER_PRESENTATION_MODULES) {
      expect(
        registeredBases.some((entry) => entry.kind === presentation.kind),
        `presentation entry for unknown or withheld kind '${presentation.kind}'`,
      ).toBe(true);
    }
  });

  it("resolves every registered kind's render config from the one its presentation entry's kind registers", () => {
    // A config registered under any other key would never be drawn.
    for (const kind of ENCOUNTER_RENDER_CONFIGS.keys()) {
      expect(encounterPresentationModuleForKind(kind)?.kind, `render config for unpresented kind '${kind}'`).toBe(kind);
    }
    for (const kind of encounterRegistry.getRegisteredKinds()) {
      const presentedKind = encounterPresentationModuleForKind(kind)?.kind;
      const authored = presentedKind === undefined ? undefined : ENCOUNTER_RENDER_CONFIGS.get(presentedKind);
      const resolved = getEncounterRenderConfig(kind);
      if (!authored) {
        expect(resolved, kind).toBeUndefined();
        continue;
      }
      for (const [field, value] of Object.entries(authored)) {
        expect(resolved?.[field as keyof typeof authored], `${kind} ${field}`).toBe(value);
      }
    }
  });

  it("draws each boss portrait from an npc and stand clip the encounter's render config keeps in the cache", () => {
    const declaredSeqIds = collectDeclaredNpcSeqIds();
    const portrayed: string[] = [];
    for (const module of ENCOUNTER_PRESENTATION_MODULES) {
      const portrait = module.presentation?.portrait;
      if (!portrait) continue;
      portrayed.push(module.kind);
      expect(Number.isInteger(portrait.npcTypeId) && portrait.npcTypeId >= 0, module.kind).toBe(true);
      // Only the render config's npcs are trimmed into the shipped cache.
      const config = ENCOUNTER_RENDER_CONFIGS.get(module.kind);
      const loadedNpcIds = [config?.primaryNpc?.npcTypeId, ...(config?.preloadNpcTypes ?? []).map((n) => n.npcTypeId)];
      expect(loadedNpcIds, module.kind).toContain(portrait.npcTypeId);
      if (portrait.idleSeqId !== undefined) expect(declaredSeqIds.has(portrait.idleSeqId), module.kind).toBe(true);
      const { yaw, pitch, focusHeight, span } = portrait.framing;
      expect([yaw, pitch, focusHeight, span].every(Number.isFinite), module.kind).toBe(true);
      expect(pitch, module.kind).toBeLessThanOrEqual(0);
      expect(span, module.kind).toBeGreaterThan(0);
    }
    expect(portrayed.sort()).toEqual(['inferno', 'sol_heredit', 'yama_p3']);
  });

  it('collects every npc clip a render config declares', () => {
    const ids = collectDeclaredNpcSeqIds(
      new Map([
        [
          'test',
          {
            primaryNpc: { actorId: 'boss', npcTypeId: 1, basePosition: [0, 0], size: 1, deathSeqId: 10 },
            preloadNpcTypes: [
              // -1 drops the walk clip rather than naming one.
              { npcTypeId: 1, walkSeqId: -1, attackClips: { swing: 11, unused: -1 } },
              { npcTypeId: 2, idleSeqId: 20, walkSeqId: 23, spawnSeqId: 21, deathSeqId: 22 },
            ],
          },
        ],
      ]),
    );
    expect([...ids.keys()].sort((a, b) => a - b)).toEqual([10, 11, 20, 21, 22, 23]);
    expect(ids.get(21)).toBe('test npc 2 spawn');
    expect(ids.get(23)).toBe('test npc 2 walk');
  });

  it('opts only Sol healing totems into a relative transparent depth tolerance', () => {
    const configured = [...ENCOUNTER_RENDER_CONFIGS].flatMap(([kind, config]) =>
      (config.preloadNpcTypes ?? [])
        .filter((type) => type.transparentDepthBiasOffset !== undefined)
        .map((type) => ({
          kind,
          npcTypeId: type.npcTypeId,
          offset: type.transparentDepthBiasOffset,
          base: type.depthBias,
        })),
    );
    expect(configured).toEqual([
      {
        kind: 'sol_heredit',
        npcTypeId: HEALING_TOTEM_NPC_ID,
        offset: (8 * 2) / (2 ** 24 - 1),
        base: undefined,
      },
    ]);
  });

  it('plays the Jal-MejJak spawn clip from the render config spawn tick, not an attack cue', () => {
    const healer = ENCOUNTER_RENDER_CONFIGS.get('inferno')?.preloadNpcTypes?.find(
      (type) => type.npcTypeId === ZUK_HEALER_NPC_ID,
    );
    expect(healer?.spawnSeqId).toBe(ZUK_SEQS.jalMejJak.spawn);
    expect(Object.values(healer?.attackClips ?? {})).not.toContain(ZUK_SEQS.jalMejJak.spawn);
  });

  it('keeps reserved slugs unique across the whole catalog', () => {
    const slugs = ENCOUNTER_CATALOG.flatMap((entry) => (entry.slug === null ? [] : [entry.slug]));
    expect(slugs).toEqual([...new Set(slugs)]);
  });
});

describe('infinite cheat aids', () => {
  const INFINITE_HEALTH_TOGGLE = { key: 'infiniteHealth', label: 'Infinite Health', group: 'aid' };
  const INFINITE_SPECIAL_ATTACK_TOGGLE = {
    key: 'infiniteSpecialAttack',
    label: 'Infinite Special Attack',
    group: 'aid',
  };

  it('gives every registered kind exactly one of each infinite cheat in the HUD list', () => {
    for (const kind of encounterRegistry.getRegisteredKinds()) {
      const toggles = encounterControlsForKind(kind)?.mechanicsToggles ?? [];
      expect(
        toggles.filter((toggle) => toggle.key === 'infiniteHealth'),
        `'${kind}' HUD toggle list`,
      ).toEqual([INFINITE_HEALTH_TOGGLE]);
      expect(
        toggles.filter((toggle) => toggle.key === 'infiniteSpecialAttack'),
        `'${kind}' HUD toggle list`,
      ).toEqual([INFINITE_SPECIAL_ATTACK_TOGGLE]);
    }
  });

  it('keeps both infinite cheats out of the pre-fight setup rail', () => {
    for (const kind of encounterRegistry.getRegisteredKinds()) {
      const toggles = encounterControlsForKind(kind)?.mechanicsToggles ?? [];
      const setupKeys = selectSetupToggles(toggles).map((toggle) => toggle.key);
      expect(setupKeys, `'${kind}' setup rail`).not.toContain('infiniteHealth');
      expect(setupKeys, `'${kind}' setup rail`).not.toContain('infiniteSpecialAttack');
    }
  });

  it('leaves both infinite cheats off by default for every registered kind', () => {
    for (const kind of encounterRegistry.getRegisteredKinds()) {
      const defaults = encounterControlsForKind(kind)?.defaultMechanicsConfig;
      const merged = mergeMechanicsConfig(defaults);
      expect(merged.infiniteHealth, `'${kind}' starts invulnerable`).toBe(false);
      expect(merged.infiniteSpecialAttack, `'${kind}' starts with infinite special attack`).toBe(false);
    }
  });

  it('returns the same controls object on every lookup, and none for an unknown kind', () => {
    for (const kind of encounterRegistry.getRegisteredKinds()) {
      expect(encounterControlsForKind(kind), `'${kind}' controls identity`).toBe(encounterControlsForKind(kind));
    }
    expect(encounterControlsForKind('unknown_kind')).toBeUndefined();
  });
});

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

const FORBIDDEN_UI_SEGMENTS = ['/src/render/', '/src/components/', '/src/hooks/', '/src/contexts/'];

function importSpecifiers(content: string, includeTypes = false): string[] {
  const specifiers: string[] = [];
  // Comments are stripped first: a docblock merely CONTAINING the word `import` otherwise
  // starts a match whose body bridges into real code.
  // The `//` strip is line-anchored so a `https://` inside a string survives.
  const code = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  // Statement-shaped — the body may not cross a semicolon or a quote — so a side-effect
  // `import './x';` cannot make the non-greedy body jump to a later statement's `from`.
  for (const match of code.matchAll(/(?:import|export)\s+(type\s+)?[^;'"]*?from\s*(['"])([^'"]+)\2/g)) {
    if (includeTypes || match[1] === undefined) specifiers.push(match[3]);
  }
  for (const match of content.matchAll(/import\s*(['"])([^'"]+)\1/g)) {
    specifiers.push(match[2]);
  }
  for (const match of content.matchAll(/import\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    specifiers.push(match[2]);
  }
  return specifiers;
}

describe('core import boundary', () => {
  // happy-dom rewrites `import.meta.url` to an http scheme, so anchor on the vitest cwd.
  const srcDir = resolve(process.cwd(), 'src');

  it('keeps src/core free of runtime imports from encounter implementations, render, and UI', () => {
    const coreDir = join(srcDir, 'core');
    const offenders: string[] = [];

    const visit = (dir: string): void => {
      for (const dirent of readdirSync(dir, { withFileTypes: true })) {
        if (dirent.name === '__tests__') continue;
        const filePath = join(dir, dirent.name);
        if (dirent.isDirectory()) {
          visit(filePath);
          continue;
        }
        if (!SOURCE_EXTENSIONS.some((extension) => dirent.name.endsWith(extension))) continue;
        const coreRelative = relative(coreDir, filePath);
        for (const specifier of importSpecifiers(readFileSync(filePath, 'utf8'))) {
          if (!specifier.startsWith('.')) continue;
          const resolved = resolve(dirname(filePath), specifier);
          // The catalog is pure identity data — the one src/encounters module core may use.
          const isEncounterImport =
            resolved.includes('/src/encounters/') && !resolved.endsWith('/src/encounters/catalog');
          if (
            isEncounterImport ||
            resolved.includes('/src/npcs/') ||
            FORBIDDEN_UI_SEGMENTS.some((segment) => resolved.includes(segment))
          ) {
            offenders.push(`${coreRelative} -> ${specifier}`);
          }
        }
      }
    };
    visit(coreDir);

    expect(offenders).toEqual([]);
  });

  it('keeps the catalog itself free of runtime imports', () => {
    const content = readFileSync(join(srcDir, 'encounters', 'catalog.ts'), 'utf8');
    expect(importSpecifiers(content)).toEqual([]);
  });

  it.each([
    { directory: 'core/actors', forbidden: '/src/npcs/' },
    { directory: 'npcs', forbidden: '/src/encounters/' },
  ])('keeps $directory independent of concrete implementation dependencies, including types', ({
    directory,
    forbidden,
  }) => {
    const offenders: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__') continue;
        const filePath = join(dir, entry.name);
        if (entry.isDirectory()) visit(filePath);
        else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
          for (const specifier of importSpecifiers(readFileSync(filePath, 'utf8'), true)) {
            if (specifier.startsWith('.') && resolve(dirname(filePath), specifier).includes(forbidden)) {
              offenders.push(`${relative(srcDir, filePath)} -> ${specifier}`);
            }
          }
        }
      }
    };

    visit(join(srcDir, directory));

    expect(offenders).toEqual([]);
  });
});

describe('encounter command architecture ratchet', () => {
  const rootDir = process.cwd();
  const forbidden = [
    /\bsetOption\s*[?(]/,
    /\btriggerDebugAction\b/,
    /\bsetFirstRangeMageType\b/,
    /type\s*:\s*['"]debugAction['"]/,
    /['"]trigger-debug-action['"]/,
    /['"]set-yama-first-attack['"]/,
  ];

  it('keeps removed string mutation paths out of runtime source', () => {
    const offenders: string[] = [];
    const visit = (dir: string): void => {
      for (const dirent of readdirSync(dir, { withFileTypes: true })) {
        if (dirent.name === '__tests__' || dirent.name === 'test') continue;
        const filePath = join(dir, dirent.name);
        if (dirent.isDirectory()) {
          visit(filePath);
          continue;
        }
        if (!SOURCE_EXTENSIONS.some((extension) => dirent.name.endsWith(extension))) continue;
        const content = readFileSync(filePath, 'utf8');
        if (forbidden.some((pattern) => pattern.test(content))) offenders.push(relative(rootDir, filePath));
      }
    };

    visit(join(rootDir, 'src'));
    expect(offenders).toEqual([]);
  });
});
