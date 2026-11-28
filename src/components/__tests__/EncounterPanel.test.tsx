// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EncounterModifierSelection } from '../../core/encounters/encounterFactory';
import type { EncounterSetupNoteRule } from '../../core/encounters/setupNotes';
import { exportInventorySetup } from '../../data/inventorySetupIO';
import { EQUIPMENT_PRESETS } from '../../data/playerPresets';
import { buildInfernoControls } from '../../encounters/inferno/controls';
import { SOL_HEREDIT_MODIFIERS } from '../../encounters/solHeredit/modifiers';
import { YAMA_CONTRACTS } from '../../encounters/yamaP3/contracts';
import { buildYamaControls } from '../../encounters/yamaP3/controls';
import { loadUnifiedKeybindStore } from '../../hooks/keybindStore';
import { createEmptyCombatSupplies, type EncounterLoadout } from '../../types/encounterLoadout';
import { DEFAULT_PLAYER_CONFIG } from '../../types/player';
import { createStatsFromBaseLevels, type PlayerStats } from '../../types/playerState';
import { deleteSetting } from '../../util/storage';
import { EncounterPanel } from '../EncounterPanel';

function statsAt(level: number): PlayerStats {
  return createStatsFromBaseLevels({
    attack: level,
    strength: level,
    defence: level,
    ranged: level,
    magic: level,
    prayer: level,
    hitpoints: level,
    agility: 99,
  });
}

type PanelProps = Parameters<typeof EncounterPanel>[0];

function panelProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    encounterKind: 'yama_p3',
    displayName: 'Yama',
    description: 'The final phase of the Yama fight',
    isAvailable: true,
    playerConfig: DEFAULT_PLAYER_CONFIG,
    encounterEquipment: {},
    onEquipmentChange: vi.fn(),
    onInventoryChange: vi.fn(),
    onStatsChange: vi.fn(),
    mechanicsConfig: { infiniteHealth: false },
    onMechanicsConfigChange: vi.fn(),
    mechanicsToggles: [],
    onStart: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function currentLabel(): HTMLElement {
  // The loadout bar's heading value; the preset tiles themselves are always visible.
  const el = document.querySelector<HTMLElement>('.loadout-bar-value');
  if (!el) {
    throw new Error('loadout readout not found');
  }
  return el;
}

function headerBadges(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.encounter-panel-header-badges');
  if (!el) {
    throw new Error('header badge row not found');
  }
  return el;
}

describe('EncounterPanel', () => {
  it('retains phase and selected contract in the compact identity', () => {
    const { rerender } = render(<EncounterPanel {...panelProps()} />);
    expect(document.querySelector('.configurer-compact-context')).toHaveTextContent('Phase 3');
    rerender(
      <EncounterPanel
        {...panelProps({
          encounterKind: 'yama_p3_bloodied',
          baseEncounterKind: 'yama_p3',
          variants: YAMA_CONTRACTS,
        })}
      />,
    );
    expect(document.querySelector('.configurer-compact-context')).toHaveTextContent('Phase 3 · Bloodied Blows');
  });

  afterEach(() => {
    deleteSetting('osrs-unified-keybinds');
    deleteSetting('osrs-custom-equipment-presets');
    deleteSetting('inferno-rail-shortcuts-expanded');
  });

  it('configures Zuk timer shortcuts before starting while the timer is on', () => {
    const props = panelProps({
      encounterKind: 'inferno',
      mechanicsToggles: buildInfernoControls().mechanicsToggles,
      mechanicsConfig: { infiniteHealth: false, zukSetTimer: true },
    });
    render(<EncounterPanel {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Rebind Zuk Set Timer: Advance timer' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Record shortcut' }), { key: 'j' });

    expect(loadUnifiedKeybindStore().plugins.zukSetTimerAdvance).toBe('J');
    expect(props.onMechanicsConfigChange).not.toHaveBeenCalled();
    expect(props.onStart).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('keeps the timer shortcuts folded away until the timer is switched on', () => {
    render(
      <EncounterPanel
        {...panelProps({
          encounterKind: 'inferno',
          mechanicsToggles: buildInfernoControls().mechanicsToggles,
          mechanicsConfig: { infiniteHealth: false, zukSetTimer: false },
        })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Rebind Zuk Set Timer: Advance timer' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Set Timer' })).toBeInTheDocument();
  });

  it('passes replay read-only state to preflight shortcuts', () => {
    render(
      <EncounterPanel
        {...panelProps({
          encounterKind: 'inferno',
          mechanicsToggles: buildInfernoControls().mechanicsToggles,
          mechanicsConfig: { infiniteHealth: false, zukSetTimer: true },
          keybindingsReadOnly: true,
        })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Rebind Zuk Set Timer: Advance timer' })).toBeDisabled();
  });

  it('keeps setup, mechanics and assists visible without a disclosure', () => {
    render(
      <EncounterPanel
        {...panelProps({
          encounterKind: 'zuk',
          mechanicsToggles: [
            { key: 'zukAttacks', label: 'Zuk Attacks' },
            { key: 'zukShieldSafeTiles', label: 'Shield Safe Tiles', group: 'aid' },
            { key: 'infiniteHealth', label: 'Infinite Health', group: 'aid' },
            { key: 'infiniteSpecialAttack', label: 'Infinite Special Attack', group: 'aid' },
            { key: 'zukSetTimer', label: 'Set Timer', group: 'aid', setup: true },
          ],
        })}
      />,
    );

    const rail = document.querySelector('.encounter-panel-rail');
    expect(screen.getByRole('heading', { name: 'Preparation' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Mechanics' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Auto-Prepot' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Set Timer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Practice aids/ })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Zuk Attacks' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Shield Safe Tiles' })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Infinite Health' })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Infinite Special Attack' })).toBeVisible();
    expect(rail?.textContent).not.toContain('Customize Practice');
  });

  it('edits visible assists without duplicating setup or changing other settings', () => {
    const props = panelProps({
      mechanicsToggles: [
        { key: 'zukAttacks', label: 'Zuk Attacks' },
        { key: 'zukShieldSafeTiles', label: 'Shield Safe Tiles', group: 'aid' },
        { key: 'infiniteHealth', label: 'Infinite Health', group: 'aid' },
        { key: 'infiniteSpecialAttack', label: 'Infinite Special Attack', group: 'aid' },
        { key: 'zukSetTimer', label: 'Set Timer', group: 'aid', setup: true },
      ],
    });
    render(<EncounterPanel {...props} />);
    expect(props.onMechanicsConfigChange).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: 'Zuk Attacks' })).toBeInTheDocument();
    const assists = within(screen.getByRole('group', { name: 'Practice aids' }));
    expect(assists.getByRole('checkbox', { name: 'Shield Safe Tiles' })).toBeInTheDocument();
    expect(assists.getByRole('checkbox', { name: 'Infinite Health' })).toBeInTheDocument();
    fireEvent.click(assists.getByRole('checkbox', { name: 'Infinite Special Attack' }));
    expect(props.onMechanicsConfigChange).toHaveBeenCalledExactlyOnceWith({
      infiniteHealth: false,
      infiniteSpecialAttack: true,
    });
    expect(screen.getAllByRole('checkbox', { name: 'Set Timer' })).toHaveLength(1);
    expect(screen.getAllByRole('checkbox', { name: 'Auto-Prepot' })).toHaveLength(1);

    expect(screen.getByRole('checkbox', { name: 'Zuk Attacks' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Infinite Special Attack' })).toBeVisible();
  });

  it('omits the Assists group when the encounter has no optional assists', () => {
    render(<EncounterPanel {...panelProps()} />);
    expect(screen.queryByRole('group', { name: 'Practice aids' })).toBeNull();
  });

  it('offers the Yama fireball pickers in setup even when fireballs are off from a prior session', () => {
    const props = panelProps({
      encounterKind: 'yama_p3',
      mechanicsToggles: buildYamaControls().mechanicsToggles,
      mechanicsConfig: { infiniteHealth: false, fireballs: false, duoSide: 'player1', fireballStart: 'random' },
    });
    render(<EncounterPanel {...props} />);

    const picker = screen.getByRole('radiogroup', { name: 'Practice As' });
    const player2 = within(picker).getByRole('radio', { name: 'Player 2' });
    expect(player2).toBeEnabled();
    fireEvent.click(player2);
    // Preselecting writes only the choice: the persisted fireballs: false is untouched.
    expect(props.onMechanicsConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({ duoSide: 'player2', fireballs: false }),
    );
  });

  it('shows a startable WIP encounter and conditionally renders the stats editor', () => {
    const onStart = vi.fn();
    const { rerender } = render(
      <EncounterPanel
        {...panelProps({
          isWorkInProgress: true,
          onStart,
          encounterEquipment: EQUIPMENT_PRESETS.yama_p3['max-mage'].equipment,
          inventory: EQUIPMENT_PRESETS.yama_p3['max-mage'].inventory,
          supplies: EQUIPMENT_PRESETS.yama_p3['max-mage'].supplies,
        })}
      />,
    );

    // Status belongs to the encounter identity, not the configuration fields.
    expect(screen.getByText('Beta').closest('.encounter-panel-header')).not.toBeNull();

    const startButton = screen.getByRole('button', { name: 'Start Encounter' });
    expect(startButton).toBeEnabled();

    fireEvent.click(startButton);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Attack')).toBeInTheDocument();

    rerender(<EncounterPanel {...panelProps({ onStatsChange: undefined })} />);
    expect(screen.queryByLabelText('Attack')).not.toBeInTheDocument();
  });

  it('shows blocked preset requirements and does not apply blocked presets', () => {
    const onEquipmentChange = vi.fn();
    const lowStats = { ...DEFAULT_PLAYER_CONFIG, stats: statsAt(70) };
    const { rerender } = render(<EncounterPanel {...panelProps({ onEquipmentChange, playerConfig: lowStats })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    const blocked = screen.getByRole('option', { name: /^Locked Melee Attack/ });
    expect(blocked).toHaveAttribute('aria-disabled', 'true');
    const strengthRequirement = within(blocked).getByRole('img', { name: 'Strength' }).closest('.loadout-req-chip');
    expect(strengthRequirement).toHaveTextContent('80');
    expect(within(blocked).getByRole('img', { name: 'Locked' })).toBeInTheDocument();

    rerender(
      <EncounterPanel {...panelProps({ encounterKind: 'yama_p3', onEquipmentChange, playerConfig: lowStats })} />,
    );

    fireEvent.click(screen.getByRole('option', { name: /Max Mage/ }));

    expect(onEquipmentChange).not.toHaveBeenCalled();
  });

  it('applies a compatible preset when its option is selected from the picker', () => {
    const onEquipmentChange = vi.fn();
    render(<EncounterPanel {...panelProps({ encounterKind: 'yama_p3', onEquipmentChange })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));

    fireEvent.click(screen.getByRole('option', { name: /Max Mage/ }));

    expect(onEquipmentChange).toHaveBeenCalledWith(EQUIPMENT_PRESETS.yama_p3['max-mage'].equipment);
  });

  it('auto-switches to the first compatible preset when the equipped one falls below the stats', () => {
    const melee = EQUIPMENT_PRESETS.yama_p3.melee;
    const naked = EQUIPMENT_PRESETS.yama_p3.naked;
    const onEquipmentChange = vi.fn();

    const Harness = () => {
      const [loadout, setLoadout] = useState<EncounterLoadout>({
        equipment: melee.equipment,
        inventory: melee.inventory,
        supplies: melee.supplies ?? createEmptyCombatSupplies(),
      });
      return (
        <EncounterPanel
          {...panelProps({
            encounterKind: 'yama_p3',
            encounterEquipment: loadout.equipment,
            inventory: loadout.inventory,
            supplies: loadout.supplies,
            playerConfig: { ...DEFAULT_PLAYER_CONFIG, stats: statsAt(70) },
            onLoadoutChange: (next) => {
              onEquipmentChange(next.equipment);
              setLoadout(next);
            },
          })}
        />
      );
    };

    render(<Harness />);

    expect(onEquipmentChange).toHaveBeenCalledWith(naked.equipment);
    expect(currentLabel()).toHaveTextContent('No Equipment (fallback)');
    const note = screen.getByText(/All equipment sets need higher combat levels/);
    expect(note.querySelectorAll('.loadout-req-chip').length).toBeGreaterThan(0);
  });

  // The header does not announce that a tutorial exists: the footer action appears under
  // exactly the same rule and is the thing that acts on it, so a chip would make the same
  // promise twice, in the row that also carries the encounter's name.
  it('offers the tutorial action for an encounter that has tutorials and nothing for one that does not', () => {
    const onTutorialMode = vi.fn();
    const { rerender } = render(<EncounterPanel {...panelProps({ encounterKind: 'yama_p3', onTutorialMode })} />);
    expect(screen.getByRole('button', { name: 'Start Tutorial' })).toBeInTheDocument();
    expect(within(headerBadges()).queryByText(/Tutorial/)).toBeNull();

    rerender(<EncounterPanel {...panelProps({ encounterKind: 'lobby', onTutorialMode })} />);
    expect(screen.queryByRole('button', { name: 'Start Tutorial' })).toBeNull();
  });

  // The action is a promise the Training flow has to keep. Yama's tutorials teach the
  // base fight and nothing about a contract's modifiers, so selecting a contract that
  // ships no tutorial must drop the action rather than inherit the boss's.
  it('resolves the tutorial action from the selected contract variant, not the base kind', () => {
    const props = panelProps({
      encounterKind: 'yama_p3_forfeit_breath',
      baseEncounterKind: 'yama_p3',
      onTutorialMode: vi.fn(),
    });
    render(<EncounterPanel {...props} />);
    expect(screen.queryByRole('button', { name: 'Start Tutorial' })).toBeNull();
  });

  // The header badge announces a tutorial; this button is what acts on it. Its
  // render gate is three-way (`hasTutorial && onTutorialMode && isAvailable`), and
  // the isAvailable term is the load-bearing one: a coming-soon encounter must not
  // offer to start a tutorial it cannot run.
  it('offers Start Tutorial only when the encounter has tutorials, is available, and has a handler', () => {
    const tutorialBtn = () => screen.queryByRole('button', { name: 'Start Tutorial' });

    const { rerender } = render(
      <EncounterPanel {...panelProps({ encounterKind: 'yama_p3', onTutorialMode: vi.fn() })} />,
    );
    expect(tutorialBtn()).toBeInTheDocument();

    // No handler wired -> nothing to offer.
    rerender(<EncounterPanel {...panelProps({ encounterKind: 'yama_p3' })} />);
    expect(tutorialBtn()).toBeNull();

    // Encounter not yet playable -> the tutorial cannot run either.
    rerender(
      <EncounterPanel {...panelProps({ encounterKind: 'yama_p3', onTutorialMode: vi.fn(), isAvailable: false })} />,
    );
    expect(tutorialBtn()).toBeNull();

    // Encounter ships no tutorials.
    rerender(<EncounterPanel {...panelProps({ encounterKind: 'lobby', onTutorialMode: vi.fn() })} />);
    expect(tutorialBtn()).toBeNull();
  });

  it('starts the tutorial for the selected encounter kind', () => {
    const onTutorialMode = vi.fn();
    render(
      <EncounterPanel {...panelProps({ encounterKind: 'yama_p3', baseEncounterKind: 'yama_p3', onTutorialMode })} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start Tutorial' }));
    expect(onTutorialMode).toHaveBeenCalledWith('yama_p3');
  });

  // Badge and button share one gate, so a contract with no tutorial offers no action either.
  it('withholds Start Tutorial on a contract variant that ships no tutorial', () => {
    render(
      <EncounterPanel
        {...panelProps({
          encounterKind: 'yama_p3_forfeit_breath',
          baseEncounterKind: 'yama_p3',
          onTutorialMode: vi.fn(),
        })}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Start Tutorial' })).toBeNull();
  });

  it.each([false, true])('starts with edits without saving a preset (editing saved preset: %s)', (editingSaved) => {
    const maxMage = EQUIPMENT_PRESETS.yama_p3['max-mage'];
    const onStart = vi.fn();
    if (editingSaved) {
      window.localStorage.setItem(
        'osrs-custom-equipment-presets',
        JSON.stringify({ yama_p3: [{ id: 'mine', name: 'My mage', loadout: maxMage }] }),
      );
    }
    const storedPresets = window.localStorage.getItem('osrs-custom-equipment-presets');

    const Harness = () => {
      const [loadout, setLoadout] = useState<EncounterLoadout>({
        equipment: editingSaved ? maxMage.equipment : { ...maxMage.equipment, weapon: 999999 },
        inventory: maxMage.inventory,
        supplies: maxMage.supplies ?? createEmptyCombatSupplies(),
      });
      return (
        <EncounterPanel
          {...panelProps({
            encounterKind: 'yama_p3',
            encounterEquipment: loadout.equipment,
            inventory: loadout.inventory,
            supplies: loadout.supplies,
            onLoadoutChange: setLoadout,
            onStart,
          })}
        />
      );
    };

    render(<Harness />);
    if (editingSaved) fireEvent.click(screen.getByRole('radio', { name: 'Ancient' }));

    // The edits are not saved to a preset. This is still the encounter's loadout and what the
    // fight will run, so the fight is not held: `enterEncounter` reads the same stored loadout
    // the panel has been writing to on every slot edit. Starting does not save a named preset.
    expect(currentLabel()).toHaveTextContent(editingSaved ? 'My mage' : 'Custom loadout');
    expect(document.querySelector('.loadout-phone-unsaved')).toHaveTextContent(
      'This loadout is not saved as a preset. Starting the encounter will not save it.',
    );
    expect(document.querySelector('.loadout-phone-unsaved')).toBeVisible();
    const start = screen.getByRole('button', { name: 'Start Encounter' });
    expect(start).toBeEnabled();
    expect(start).not.toHaveAttribute('aria-disabled');
    const summary = document.querySelector('.configurer-start-summary');
    expect(summary?.querySelector('span')).toHaveTextContent(/^Not saved as a preset$/);
    expect(summary).not.toHaveTextContent(
      'This loadout is not saved as a preset. Starting the encounter will not save it.',
    );
    expect(
      screen.getAllByText('This loadout is not saved as a preset. Starting the encounter will not save it.'),
    ).toHaveLength(1);

    fireEvent.click(start);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('osrs-custom-equipment-presets')).toBe(storedPresets);

    // Taking a set removes the warning and updates the footer's loadout name.
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('option', { name: /Max Mage/ }));
    expect(summary?.querySelector('span')).toHaveTextContent(maxMage.name);
    expect(summary).not.toHaveTextContent('Not saved as a preset');
    expect(document.querySelector('.configurer-start-summary')).not.toHaveTextContent(
      'This loadout is not saved as a preset. Starting the encounter will not save it.',
    );
  });

  // One Save in the panel, in the one place that can label it correctly.
  it('keeps one Save, owned by the loadout column, and runs its two-press flow', () => {
    const maxMage = EQUIPMENT_PRESETS.yama_p3['max-mage'];

    const Harness = () => {
      const [loadout, setLoadout] = useState<EncounterLoadout>({
        equipment: { ...maxMage.equipment, weapon: 999999 },
        inventory: maxMage.inventory,
        supplies: maxMage.supplies ?? createEmptyCombatSupplies(),
      });
      return (
        <EncounterPanel
          {...panelProps({
            encounterKind: 'yama_p3',
            encounterEquipment: loadout.equipment,
            inventory: loadout.inventory,
            supplies: loadout.supplies,
            onLoadoutChange: setLoadout,
          })}
        />
      );
    };
    render(<Harness />);

    // The footer states the consequence and stops there. Saving belongs to the loadout column,
    // which is the only place that can name the action correctly: a modified saved set is
    // updated in place, and a footer copy of this would have worn the same label while always
    // writing a new preset.
    const saves = screen.getAllByRole('button', { name: /^(Save preset|Update preset)$/ });
    expect(saves).toHaveLength(1);
    expect(document.querySelector('.loadout-bar')).toContainElement(saves[0]);
    expect(document.querySelector('.encounter-panel-footer')).not.toContainElement(saves[0]);

    // And it is the whole two-press flow: the field opens with the caret in it, then commits.
    expect(screen.queryByLabelText('Preset name')).toBeNull();
    fireEvent.click(saves[0]);
    const field = screen.getByLabelText('Preset name');
    expect(field).toBeVisible();
    expect(document.activeElement).toBe(field);
    expect(document.querySelector('.loadout-phone-unsaved')).toHaveTextContent(
      'This loadout is not saved as a preset. Starting the encounter will not save it.',
    );
    expect(document.querySelector('.loadout-phone-unsaved')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Save preset' }));
    expect(screen.getByText(/^Saved preset:/)).toBeVisible();
  });

  // The other refusal, and the reason `disabled` is still the right tool for it: an encounter
  // that does not exist yet has nothing the player can do, so the button stays fully inert
  // rather than pressable-but-refusing.
  describe('Reset to defaults', () => {
    const head = () => {
      const el = document.querySelector<HTMLElement>('.configurer-rail-head');
      if (!el) throw new Error('rail heading row not found');
      return within(el);
    };

    it('sits beside the column heading only while there is something to reset, and never in a tutorial', () => {
      const onReset = vi.fn(() => vi.fn());
      const { rerender } = render(
        <EncounterPanel {...panelProps({ setupContext: { mode: 'saved', isDefault: true, onReset } })} />,
      );
      expect(head().getByRole('heading', { name: 'Fight setup' })).toBeInTheDocument();
      expect(head().queryByRole('button')).toBeNull();
      rerender(<EncounterPanel {...panelProps({ setupContext: { mode: 'saved', isDefault: false, onReset } })} />);
      expect(head().getByRole('button', { name: 'Reset to defaults' })).toBeInTheDocument();
      rerender(<EncounterPanel {...panelProps({ setupContext: { mode: 'tutorial', isDefault: false } })} />);
      expect(head().queryByRole('button')).toBeNull();
      rerender(<EncounterPanel {...panelProps()} />);
      expect(head().queryByRole('button')).toBeNull();
    });

    it('turns into Defaults restored with an Undo that puts the options back', () => {
      const undo = vi.fn();
      // The owner's real shape: the reset and its result land in the same press.
      function Host() {
        const [isDefault, setIsDefault] = useState(false);
        return (
          <EncounterPanel
            {...panelProps({
              setupContext: {
                mode: 'saved',
                isDefault,
                onReset: () => {
                  setIsDefault(true);
                  return () => {
                    undo();
                    setIsDefault(false);
                  };
                },
              },
            })}
          />
        );
      }
      render(<Host />);
      fireEvent.click(head().getByRole('button', { name: 'Reset to defaults' }));
      expect(head().getByText('Defaults restored')).toBeInTheDocument();
      expect(head().queryByRole('button', { name: 'Reset to defaults' })).toBeNull();
      fireEvent.click(head().getByRole('button', { name: 'Undo' }));
      expect(undo).toHaveBeenCalledOnce();
      expect(head().queryByText('Defaults restored')).toBeNull();
      expect(head().getByRole('button', { name: 'Reset to defaults' })).toBeInTheDocument();
    });

    it('ends the Undo at the next change away from the defaults, or on another contract', () => {
      const undo = vi.fn();
      const context = (isDefault: boolean) => ({ mode: 'saved' as const, isDefault, onReset: () => undo });
      const { rerender } = render(<EncounterPanel {...panelProps({ setupContext: context(false) })} />);
      fireEvent.click(head().getByRole('button', { name: 'Reset to defaults' }));
      // A reset whose result arrives a render late still gets its Undo.
      expect(head().queryByText('Defaults restored')).toBeNull();
      rerender(<EncounterPanel {...panelProps({ setupContext: context(true) })} />);
      expect(head().getByText('Defaults restored')).toBeInTheDocument();
      // Changing an option ends it; coming back to the defaults does not revive it.
      rerender(<EncounterPanel {...panelProps({ setupContext: context(false) })} />);
      expect(head().getByRole('button', { name: 'Reset to defaults' })).toBeInTheDocument();
      rerender(<EncounterPanel {...panelProps({ setupContext: context(true) })} />);
      expect(head().queryByRole('button')).toBeNull();
      expect(head().queryByText('Defaults restored')).toBeNull();

      rerender(<EncounterPanel {...panelProps({ setupContext: context(false) })} />);
      fireEvent.click(head().getByRole('button', { name: 'Reset to defaults' }));
      rerender(<EncounterPanel {...panelProps({ setupContext: context(true) })} />);
      expect(head().getByText('Defaults restored')).toBeInTheDocument();
      rerender(
        <EncounterPanel
          {...panelProps({
            encounterKind: 'yama_p3_bloodied',
            baseEncounterKind: 'yama_p3',
            variants: YAMA_CONTRACTS,
            setupContext: context(true),
          })}
        />,
      );
      expect(head().queryByText('Defaults restored')).toBeNull();
      expect(undo).not.toHaveBeenCalled();
    });
  });

  it('leaves an unavailable encounter truly disabled, with nothing to press', () => {
    render(<EncounterPanel {...panelProps({ encounterKind: 'yama_p3', isAvailable: false })} />);

    const button = screen.getByRole('button', { name: 'Unavailable' });
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByText(/Save this loadout/)).toBeNull();
  });

  it('reveals chosen contract consequences but respects collapse through ordinary interaction', () => {
    function ContractHarness({ description = 'Yama' }: { description?: string }) {
      const [kind, setKind] = useState('yama_p3');
      return (
        <EncounterPanel
          {...panelProps({
            encounterKind: kind,
            description,
            baseEncounterKind: 'yama_p3',
            variants: YAMA_CONTRACTS,
            onVariantChange: setKind,
          })}
        />
      );
    }
    const { rerender } = render(<ContractHarness />);
    const terms = document.querySelector<HTMLDetailsElement>('.configurer-contract-terms')!;
    expect(terms.open).toBe(false);
    expect(screen.queryByRole('button', { name: 'Forfeit Breath' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Change contract: No Contract' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forfeit Breath' }));
    expect(screen.getByRole('button', { name: 'Change contract: Forfeit Breath' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByRole('button', { name: 'Bloodied Blows' })).toBeNull();
    expect(terms.open).toBe(true);
    const contract = YAMA_CONTRACTS.find((variant) => variant.encounterKind === 'yama_p3_forfeit_breath')!;
    for (const term of contract.terms!) expect(terms).toHaveTextContent(term);
    expect(terms).toHaveTextContent(contract.reward!);

    terms.open = false;
    fireEvent(terms, new Event('toggle'));
    rerender(<ContractHarness description="Unrelated setup rerender" />);
    expect(terms.open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Change contract: Forfeit Breath' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forfeit Breath' }));
    expect(terms.open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Change contract: Forfeit Breath' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bloodied Blows' }));
    expect(document.querySelector('.configurer-contract-terms')).toBe(terms);
    expect(terms.open).toBe(true);
    expect(terms).toHaveTextContent('Wretched Strength');
  });

  it('closes contract browsing without changing the selected contract or its terms', () => {
    const onVariantChange = vi.fn();
    render(
      <EncounterPanel {...panelProps({ baseEncounterKind: 'yama_p3', variants: YAMA_CONTRACTS, onVariantChange })} />,
    );
    const chooser = screen.getByRole('button', { name: 'Change contract: No Contract' });
    fireEvent.click(chooser);
    expect(chooser).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Glyphic Attenuation' })).toBeVisible();
    fireEvent.click(chooser);
    expect(chooser).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Glyphic Attenuation' })).toBeNull();
    expect(onVariantChange).not.toHaveBeenCalled();
    expect(document.querySelector('.configurer-contract-terms')).not.toHaveAttribute('open');
  });

  it('opens an initially selected contract and keeps terms expanded while comparing contracts', () => {
    const props = panelProps({
      encounterKind: 'yama_p3_forfeit_breath',
      baseEncounterKind: 'yama_p3',
      variants: YAMA_CONTRACTS,
      onVariantChange: vi.fn(),
    });
    const { rerender } = render(<EncounterPanel {...props} />);
    const terms = document.querySelector<HTMLDetailsElement>('.configurer-contract-terms')!;
    expect(terms.open).toBe(true);
    rerender(<EncounterPanel {...props} encounterKind="yama_p3_bloodied" />);
    expect(document.querySelector('.configurer-contract-terms')).toBe(terms);
    expect(terms.open).toBe(true);
    expect(terms).toHaveTextContent('Wretched Strength');
  });

  it('returns from the loadout editor without dismissing or discarding a named draft', () => {
    const onClose = vi.fn();
    const preset = EQUIPMENT_PRESETS.yama_p3['max-mage'];
    render(
      <EncounterPanel
        {...panelProps({
          onClose,
          onTutorialMode: vi.fn(),
          encounterEquipment: { ...preset.equipment, weapon: 999999 },
          inventory: preset.inventory,
          supplies: preset.supplies,
          onLoadoutChange: vi.fn(),
        })}
      />,
    );
    const footer = document.querySelector('.encounter-panel-footer') as HTMLElement;
    expect(within(footer).getByRole('button', { name: 'Close' })).toBeVisible();
    const editor = document.querySelector('.loadout-section');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('heading', { name: 'Edit loadout' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Return to setup' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Back to setup' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start Tutorial' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Start Encounter' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save preset' }));
    const name = screen.getByRole('textbox', { name: 'Preset name' });
    fireEvent.change(name, { target: { value: 'Keep this draft' } });
    fireEvent.click(within(footer).getByRole('button', { name: 'Return to setup' }));
    expect(document.querySelector('.loadout-section')).toBe(editor);
    expect(document.querySelector('.encounter-panel-card')).not.toHaveClass('encounter-panel-card--loadout');
    expect(name).toHaveValue('Keep this draft');
    expect(screen.getByRole('button', { name: 'Start Tutorial' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start Encounter' })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(footer).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('links each subject to its own wiki page', () => {
    // The panel is opened from the picker's Configure, which passes the CONTRACT's name as
    // displayName. The encounter link must still name the encounter: labeled with the
    // contract's name it would be indistinguishable from the contract's own link, which sits
    // one row below it pointing somewhere else.
    render(
      <EncounterPanel
        {...panelProps({
          encounterKind: 'yama_p3_forfeit_breath',
          displayName: 'Forfeit Breath',
          baseEncounterKind: 'yama_p3',
          variants: YAMA_CONTRACTS,
          variantLabel: 'Contract',
          onVariantChange: vi.fn(),
        })}
      />,
    );

    const encounterLink = screen.getByRole('link', { name: 'Yama on the OSRS Wiki' });
    expect(encounterLink).toHaveAttribute('href', 'https://oldschool.runescape.wiki/w/Yama/Strategies');
    expect(encounterLink).toHaveAttribute('target', '_blank');
    expect(encounterLink).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('renders no wiki link for an encounter that declares no page', () => {
    render(<EncounterPanel {...panelProps({ encounterKind: 'lobby', displayName: 'Lobby' })} />);
    expect(screen.queryByRole('link', { name: /on the OSRS Wiki/ })).toBeNull();
  });

  it('groups the Starting Hitpoints field with the setup pickers under PREPARATION', () => {
    render(
      <EncounterPanel
        {...panelProps({
          encounterKind: 'yama_p3_bloodied',
          startingHitpoints: 10,
          onStartingHitpointsChange: vi.fn(),
          mechanicsToggles: buildYamaControls().mechanicsToggles,
        })}
      />,
    );

    const preparation = screen.getByRole('heading', { name: 'Preparation' }).closest<HTMLElement>('.rail-section');
    if (!preparation) throw new Error('PREPARATION section did not render');
    const input = within(preparation).getByLabelText('Starting Hitpoints');
    expect(input).toHaveValue(10);
    expect(within(preparation).getByRole('button', { name: 'About Starting Hitpoints' })).toBeInTheDocument();
    // The field is one row of the section, not a second section inside it.
    expect(preparation.querySelector('.rail-section')).toBeNull();

    // Grouped with the pickers: the field shares their SettingRow inset, the aid toggles
    // lead the section, and the zone seam falls between the last aid and the field group.
    const rows = [...preparation.querySelectorAll('.setting-row')];
    const fieldRow = input.closest('.setting-row');
    const prepotRow = rows.find((row) => row.textContent?.includes('Auto-Prepot'));
    const glyphRow = rows.find((row) => row.textContent?.includes('Show Glyphs at Start'));
    const orientationRow = rows.find((row) => row.querySelector('[aria-label="Fireball Orientation"]'));
    if (!fieldRow || !prepotRow || !glyphRow || !orientationRow) throw new Error('preparation rows did not render');
    expect(rows.indexOf(prepotRow)).toBeLessThan(rows.indexOf(glyphRow));
    expect(rows.indexOf(glyphRow)).toBeLessThan(rows.indexOf(fieldRow));
    expect(rows.indexOf(fieldRow)).toBeLessThan(rows.indexOf(orientationRow));
    expect(glyphRow.nextElementSibling?.classList.contains('mechanics-group-rule')).toBe(true);
  });

  it("gives an encounter's own setup control a rail section before Preparation, and no second copy", () => {
    render(
      <EncounterPanel
        {...panelProps({
          encounterKind: 'inferno',
          displayName: 'The Inferno',
          // An ordinary wave, which has a layout to edit (the default start, 69, has none).
          mechanicsConfig: { infiniteHealth: false, infernoStartWave: '1' },
          mechanicsToggles: buildInfernoControls().mechanicsToggles,
        })}
      />,
    );

    expect(document.querySelector('.configurer-compact-context')).toHaveTextContent('Waves 1–69');
    // Named for assistive technology; the control's own label is the visible one.
    const wave = screen.getByRole('region', { name: 'Wave & arena' });
    expect(within(wave).getByLabelText('Start wave')).toBeInTheDocument();
    fireEvent.click(within(wave).getByRole('button', { name: 'Wave shortcuts' }));
    expect(within(wave).getByRole('button', { name: 'Mager, wave 35' })).toBeInTheDocument();
    fireEvent.click(within(wave).getByRole('button', { name: 'Wave shortcuts' }));
    expect(within(wave).queryByRole('checkbox', { name: 'West' })).toBeNull();
    expect(within(wave).queryByTestId('arena-map')).toBeNull();
    // The Arena row discloses the editor inline, beneath it in the same section; the host offers no
    // column replacement, and the rest of the rail stays.
    fireEvent.click(within(wave).getByRole('button', { name: /^Edit layout / }));
    const editor = within(wave).getByRole('region', { name: /^Wave \d+ layout$/ });
    expect(within(editor).getByTestId('arena-map')).toBeInTheDocument();
    expect(within(editor).getByRole('button', { name: 'West pillar' })).toBeInTheDocument();
    expect(within(editor).queryByRole('button', { name: 'Copy link' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Preparation' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: /^Wave \d+ arena$/ })).toBeNull();
    // The same row collapses it.
    fireEvent.click(within(wave).getByRole('button', { name: /^Edit layout /, expanded: true }));
    expect(within(wave).queryByRole('region', { name: /^Wave \d+ layout$/ })).toBeNull();

    const preparation = screen.getByRole('heading', { name: 'Preparation' }).closest<HTMLElement>('.rail-section');
    if (!preparation) throw new Error('PREPARATION section did not render');
    expect(wave.compareDocumentPosition(preparation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The keys the control owns lose their generic rows everywhere on the card.
    expect(screen.getAllByLabelText('Start wave')).toHaveLength(1);
    expect(screen.queryByRole('radiogroup', { name: 'Start Wave' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'West Pillar Destroyed' })).toBeNull();
  });

  it('keeps immediate copy and gear (on by default) in the footer without an import or share surface', () => {
    render(
      <EncounterPanel
        {...panelProps({
          encounterKind: 'inferno',
          displayName: 'The Inferno',
          mechanicsToggles: buildInfernoControls().mechanicsToggles,
          inventory: Array(28).fill(null),
        })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Open wave link' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy link' }).closest('.encounter-panel-footer')).not.toBeNull();
    expect(document.querySelector('.configurer-setup-panel')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Include gear' }).closest('.encounter-panel-footer')).not.toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Include gear' })).toHaveAttribute('aria-checked', 'true');
  });

  it('saves a partial layout as the layout and starts on it, the rest random', () => {
    const props = panelProps({
      encounterKind: 'inferno',
      displayName: 'The Inferno',
      mechanicsConfig: { infiniteHealth: false, infernoStartWave: '52' },
      mechanicsToggles: buildInfernoControls().mechanicsToggles,
    });
    const { rerender } = render(<EncounterPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /^Edit layout / }));
    fireEvent.click(screen.getByRole('button', { name: 'North-west: empty spawn' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mager' }));
    const saved = vi.mocked(props.onMechanicsConfigChange).mock.calls.at(-1)?.[0];
    expect(saved).toMatchObject({ infernoStartWave: '52', infernoSpawnLayout: expect.stringMatching(/^52:/) });
    rerender(<EncounterPanel {...props} mechanicsConfig={{ ...props.mechanicsConfig, ...saved }} />);
    const arenaRow = screen.getByRole('button', { name: /^Edit layout /, expanded: true });
    expect(arenaRow).toHaveTextContent('Custom, rest random');
    fireEvent.click(arenaRow);
    const start = screen.getByRole('button', { name: 'Start Encounter' });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(props.onStart).toHaveBeenCalledOnce();
  });

  it('lists a named section of toggles after Mechanics, saying their shared deferral once at its head', () => {
    const { rerender } = render(
      <EncounterPanel
        {...panelProps({
          encounterKind: 'inferno',
          displayName: 'The Inferno',
          // A start before wave 69 (the default), so Zuk's controls are deferred.
          mechanicsConfig: { infiniteHealth: false, infernoStartWave: '1' },
          mechanicsToggles: buildInfernoControls().mechanicsToggles,
        })}
      />,
    );
    const zuk = screen.getByRole('heading', { name: 'TzKal-Zuk' }).closest<HTMLElement>('.encounter-fight-controls');
    if (!zuk) throw new Error('the TzKal-Zuk section did not render');
    for (const name of ['Zuk Attacks', 'Mager/Ranger Sets', 'Set Timer', 'Shield Safe Tiles']) {
      expect(within(zuk).getByRole('checkbox', { name })).toBeInTheDocument();
    }
    expect(within(zuk).getByRole('radiogroup', { name: 'Starting Shield Direction' })).toBeInTheDocument();
    // Once, at the head, rather than on each of the five rows.
    expect(within(zuk).getAllByText('From wave 69')).toHaveLength(1);
    // Out of Preparation and Practice aids: offered once, under his name.
    expect(screen.getAllByRole('checkbox', { name: 'Set Timer' })).toHaveLength(1);
    expect(screen.getAllByRole('checkbox', { name: 'Shield Safe Tiles' })).toHaveLength(1);
    // Its only aid moved with it, so no empty Practice aids group is left behind.
    expect(screen.queryByText('Practice aids')).toBeNull();
    expect(screen.getByText('Wave 1', { selector: '.configurer-start-summary strong' })).toBeInTheDocument();

    // Choosing Zuk's own wave clears the note and moves nothing.
    rerender(
      <EncounterPanel
        {...panelProps({
          encounterKind: 'inferno',
          displayName: 'The Inferno',
          mechanicsToggles: buildInfernoControls().mechanicsToggles,
          mechanicsConfig: { infiniteHealth: false, infernoStartWave: '69' },
        })}
      />,
    );
    expect(screen.queryByText('From wave 69')).toBeNull();
    expect(screen.getByRole('heading', { name: 'TzKal-Zuk' })).toBeInTheDocument();
    expect(
      screen.getByText('Wave 69 · TzKal-Zuk', { selector: '.configurer-start-summary strong' }),
    ).toBeInTheDocument();

    // So does an untouched setup, which starts at the default, wave 69.
    rerender(
      <EncounterPanel
        {...panelProps({
          encounterKind: 'inferno',
          displayName: 'The Inferno',
          mechanicsToggles: buildInfernoControls().mechanicsToggles,
          mechanicsConfig: { infiniteHealth: false },
        })}
      />,
    );
    expect(screen.queryByText('From wave 69')).toBeNull();
    expect(
      screen.getByText('Wave 69 · TzKal-Zuk', { selector: '.configurer-start-summary strong' }),
    ).toBeInTheDocument();
  });
});

describe('EncounterPanel setup notes', () => {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  afterEach(() => {
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });
  const NOXIOUS_HALBERD = 29796;
  const halberdWithoutMyopia: EncounterSetupNoteRule = {
    id: 'halberd-without-myopia',
    message: 'Your loadout has a noxious halberd, but Myopia is off.',
    applies: ({ equipment, modifiers }) => equipment.weapon === NOXIOUS_HALBERD && modifiers.myopia === undefined,
  };
  const emptyInventory: EncounterSetupNoteRule = {
    id: 'empty-inventory',
    message: 'Your inventory is empty.',
    applies: ({ inventory }) => !inventory?.some((slot) => slot !== null),
  };

  function solProps(overrides: Partial<PanelProps> = {}): PanelProps {
    return panelProps({
      encounterKind: 'sol_heredit',
      displayName: 'Sol Heredit',
      modifiers: SOL_HEREDIT_MODIFIERS,
      modifierSelection: {},
      onModifierSelectionChange: vi.fn(),
      encounterEquipment: { weapon: NOXIOUS_HALBERD },
      setupNotes: [halberdWithoutMyopia],
      ...overrides,
    });
  }

  const modifiersHeader = () => screen.getByRole('button', { name: 'Details & edit' });
  const notesBand = () => screen.getByRole('status', { name: 'Setup notes' });

  it.each([0, 1, 3, 7, 10])('reviews %i selections without duplicating the modifier editor', (count) => {
    const modifiers = count === 7 ? SOL_HEREDIT_MODIFIERS.slice(1, 8) : SOL_HEREDIT_MODIFIERS.slice(0, count);
    const modifierSelection = Object.fromEntries(modifiers.map((modifier) => [modifier.id, modifier.tiers.length]));
    render(<EncounterPanel {...solProps({ modifierSelection })} />);
    const overview = screen.queryByRole('list', { name: 'Selected modifiers' });
    if (count === 0) {
      expect(overview).toBeNull();
      expect(screen.getByText('No modifiers selected.')).toBeVisible();
    } else {
      const rows = within(overview!).getAllByRole('listitem');
      expect(rows.map((row) => row.textContent)).toEqual(
        modifiers.map((modifier) => `${modifier.name} ${'I'.repeat(modifier.tiers.length)}`),
      );
      rows.forEach((row, index) => {
        // Keep each name and tier together, with the same artwork as the full editor.
        const label = row.querySelector('.configurer-modifier-label');
        expect(label).toHaveTextContent(`${modifiers[index].name} ${'I'.repeat(modifiers[index].tiers.length)}`);
        const icon = row.querySelector('canvas[data-src]');
        expect(icon).toHaveAttribute('data-src', modifiers[index].icon);
        expect(icon?.parentElement).toHaveAttribute('aria-hidden', 'true');
        // Text paints before the accelerated sprite; CSS places the icon at the leading edge.
        expect(row.firstElementChild).toBe(label);
        expect(row.querySelector('button, a, img')).toBeNull();
      });
      expect(screen.getByRole('heading', { name: `Modifiers going into wave 12 (${count})` })).toBeVisible();
    }
    expect(document.querySelector('.modifier-tiers')).toBeNull();
    expect(document.querySelector('.modifier-effect')).toBeNull();
    expect(modifiersHeader()).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Preparation' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start Encounter' })).toBeEnabled();
  });

  it('keeps long names and one-tier state in the overview, with canonical details in the editor', () => {
    const quartet = SOL_HEREDIT_MODIFIERS.find((modifier) => modifier.id === 'quartet')!;
    const name = 'A deliberately long modifier name for wrapping';
    render(<EncounterPanel {...solProps({ modifiers: [{ ...quartet, name }], modifierSelection: { quartet: 1 } })} />);
    expect(screen.getByRole('list', { name: 'Selected modifiers' })).toHaveTextContent(`${name} I`);
    fireEvent.click(modifiersHeader());
    const fullEditor = document.querySelector('.configurer-modifier-editor') as HTMLElement;
    expect(within(fullEditor).getByText(quartet.tiers[0])).toBeVisible();
    const tiers = within(fullEditor).getByRole('group', { name: `${name} tier` });
    expect(
      within(tiers)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Off', 'I']);
  });

  it('shows the all-off empty state after immediate edits and offers every modifier on reopening', () => {
    function Harness() {
      const [selection, setSelection] = useState<EncounterModifierSelection>({ blasphemy: 3, quartet: 1 });
      return (
        <EncounterPanel {...solProps({ modifierSelection: selection, onModifierSelectionChange: setSelection })} />
      );
    }
    render(<Harness />);
    fireEvent.click(modifiersHeader());
    fireEvent.click(screen.getByRole('button', { name: 'Blasphemy off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quartet off' }));
    expect(screen.getByText('No modifiers selected')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Return to setup' }));
    expect(screen.queryByRole('list', { name: 'Selected modifiers' })).toBeNull();
    expect(screen.getByText('No modifiers selected.')).toBeVisible();
    fireEvent.click(modifiersHeader());
    expect(document.querySelectorAll('.configurer-modifier-editor .modifier-row')).toHaveLength(
      SOL_HEREDIT_MODIFIERS.length,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Quartet tier I' }));
    fireEvent.click(screen.getByRole('button', { name: 'Return to setup' }));
    expect(screen.getByRole('list', { name: 'Selected modifiers' })).toHaveTextContent('Quartet I');
    expect(screen.getByRole('button', { name: 'Start Encounter' })).toBeEnabled();
  });

  it('keeps setup notes visible once in setup and the in-frame modifier editor', () => {
    render(<EncounterPanel {...solProps({ modifierSelection: { doom: 2 } })} />);
    expect(screen.queryByRole('button', { name: 'Back to setup' })).toBeNull();
    expect(within(notesBand()).getByText(halberdWithoutMyopia.message)).toBeVisible();
    // The header keeps saying what you will fight; the band says the rest.
    expect(modifiersHeader()).not.toHaveTextContent(/note/i);

    // Opening the field adds nothing: the band is the one place to look.
    fireEvent.click(modifiersHeader());
    expect(screen.getAllByText(halberdWithoutMyopia.message)).toHaveLength(1);
    expect(document.querySelector('.configurer-modifier-editor')?.contains(notesBand())).toBe(false);
    expect(screen.getByRole('button', { name: 'Return to setup' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Start Encounter' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to setup' })).toBeNull();
  });

  it('follows the saved loadout and modifiers', () => {
    const { rerender } = render(<EncounterPanel {...solProps()} />);
    expect(within(notesBand()).getByText(halberdWithoutMyopia.message)).toBeInTheDocument();

    rerender(<EncounterPanel {...solProps({ modifierSelection: { myopia: 1 } })} />);
    expect(screen.queryByText(halberdWithoutMyopia.message)).toBeNull();

    rerender(<EncounterPanel {...solProps({ encounterEquipment: {} })} />);
    expect(screen.queryByText(halberdWithoutMyopia.message)).toBeNull();
    // The region stays mounted, so the next note to appear is announced.
    expect(notesBand()).toBeEmptyDOMElement();
  });

  it('keeps the loadout editor mounted and returns to setup on Escape', () => {
    const onClose = vi.fn();
    render(<EncounterPanel {...solProps({ onClose })} />);
    const editor = document.querySelector('.loadout-section');
    fireEvent.click(modifiersHeader());
    expect(document.querySelector('.loadout-section')).toBe(editor);
    expect(editor?.closest('.encounter-panel-body')).toHaveAttribute('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(editor?.closest('.encounter-panel-body')).not.toHaveAttribute('hidden');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('returns from modifiers before starting, keeping immediate edits and the imported draft mounted', async () => {
    const onClose = vi.fn();
    const preset = Object.values(EQUIPMENT_PRESETS.sol_heredit)[0];
    const initialLoadout: EncounterLoadout = {
      equipment: preset.equipment,
      inventory: preset.inventory,
      supplies: preset.supplies ?? createEmptyCombatSupplies(),
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: vi
          .fn()
          .mockResolvedValue(
            exportInventorySetup('Imported draft', { ...initialLoadout, equipment: { weapon: NOXIOUS_HALBERD } }),
          ),
      },
    });
    const Harness = () => {
      const [selection, setSelection] = useState({});
      const [loadout, setLoadout] = useState(initialLoadout);
      return (
        <EncounterPanel
          {...solProps({
            onClose,
            modifierSelection: selection,
            onModifierSelectionChange: setSelection,
            encounterEquipment: loadout.equipment,
            inventory: loadout.inventory,
            supplies: loadout.supplies,
            onLoadoutChange: setLoadout,
          })}
        />
      );
    };
    render(<Harness />);
    const editor = document.querySelector('.loadout-section');
    const footer = document.querySelector('.encounter-panel-footer') as HTMLElement;
    fireEvent.click(screen.getByRole('button', { name: 'Import Inventory Setup from the clipboard' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save preset' })).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'Save preset' }));
    const name = screen.getByRole('textbox', { name: 'Preset name' });
    expect(name).toHaveValue('Imported draft');
    fireEvent.click(modifiersHeader());
    const fullEditor = document.querySelector('.configurer-modifier-editor') as HTMLElement;
    fireEvent.click(within(fullEditor).getByRole('button', { name: 'Myopia tier I' }));
    expect(within(footer).queryByRole('button', { name: 'Start Encounter' })).toBeNull();
    fireEvent.click(within(footer).getByRole('button', { name: 'Return to setup' }));
    expect(document.querySelector('.configurer-modifier-editor')).toBeNull();
    expect(document.querySelector('.loadout-section')).toBe(editor);
    expect(name).toHaveValue('Imported draft');
    expect(screen.getByRole('list', { name: 'Selected modifiers' })).toHaveTextContent('Myopia I');
    expect(onClose).not.toHaveBeenCalled();
    expect(within(footer).getByRole('button', { name: 'Close' })).toBeVisible();
    expect(within(footer).getByRole('button', { name: 'Start Encounter' })).toBeEnabled();
  });

  it('never holds Start', () => {
    const preset = Object.values(EQUIPMENT_PRESETS.sol_heredit)[0];
    const onStart = vi.fn();
    render(
      <EncounterPanel
        {...solProps({
          onStart,
          encounterEquipment: preset.equipment,
          inventory: preset.inventory,
          supplies: preset.supplies,
          setupNotes: [{ ...halberdWithoutMyopia, applies: () => true }],
        })}
      />,
    );
    expect(within(notesBand()).getByText(halberdWithoutMyopia.message)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start Encounter' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('shows notes that name no modifier in the same place, in rule order', () => {
    render(
      <EncounterPanel {...solProps({ setupNotes: [halberdWithoutMyopia, emptyInventory], inventory: undefined })} />,
    );
    expect([...notesBand().querySelectorAll('.setup-note')].map((note) => note.textContent)).toEqual([
      halberdWithoutMyopia.message,
      'Your inventory is empty.',
    ]);
  });

  it('shows the band on an encounter without modifiers', () => {
    render(
      <EncounterPanel {...solProps({ modifiers: undefined, setupNotes: [emptyInventory], inventory: undefined })} />,
    );
    expect(within(notesBand()).getByText('Your inventory is empty.')).toBeInTheDocument();
  });

  it('renders no notes for an encounter that declares none', () => {
    render(<EncounterPanel {...solProps({ setupNotes: undefined })} />);
    expect(document.querySelector('.setup-notes')).toBeNull();
    expect(document.querySelector('.setup-note')).toBeNull();
  });
});

describe('EncounterPanel contract details', () => {
  function yamaProps(encounterKind: string): PanelProps {
    return panelProps({
      encounterKind,
      displayName: 'Yama (Phase 3)',
      baseEncounterKind: 'yama_p3',
      variants: YAMA_CONTRACTS,
      variantLabel: 'Contract',
      onVariantChange: vi.fn(),
    });
  }

  function openContractSection(): void {
    const details = document.querySelector('details.configurer-contract-terms');
    details?.setAttribute('open', '');
  }

  it("lists the selected contract's terms, its reward, and a link to its own page", () => {
    render(<EncounterPanel {...yamaProps('yama_p3_divine')} />);
    openContractSection();

    const divine = YAMA_CONTRACTS.find((v) => v.id === 'divine_severance');
    if (!divine?.terms || !divine.wikiUrl) throw new Error('divine severance lost its terms or page');

    const terms = document.querySelectorAll('.variant-detail-terms li');
    expect(terms).toHaveLength(divine.terms.length);
    expect(terms[0]).toHaveTextContent(divine.terms[0]);
    expect(screen.getByText('Purifying sigil (right)')).toBeInTheDocument();

    // Both links are live at once and must not resolve to the same accessible name.
    const contractLink = screen.getByRole('link', { name: 'Divine Severance on the OSRS Wiki' });
    expect(contractLink).toHaveAttribute('href', divine.wikiUrl);
    expect(screen.getByRole('link', { name: 'Yama on the OSRS Wiki' })).toBeInTheDocument();
  });

  it('falls back to the subtitle for a contract with no terms', () => {
    render(<EncounterPanel {...yamaProps('yama_p3')} />);
    openContractSection();

    // The base fight carries no terms and no page of its own.
    expect(document.querySelector('.variant-detail-terms')).toBeNull();
    expect(document.querySelector('.variant-detail-subtitle')).toHaveTextContent('The standard Yama encounter.');
    expect(document.querySelector('.variant-detail-foot')).toBeNull();
    expect(screen.queryByRole('link', { name: 'No Contract on the OSRS Wiki' })).toBeNull();
  });

  it('marks a playable but thinly-evidenced contract Beta, in the list and beside its name', () => {
    // Stubbed rather than pointed at whichever contract is currently Beta: no shipped contract is,
    // and pinning this to one turns every promotion out of Beta into an unrelated test failure.
    const variants = YAMA_CONTRACTS.map((variant) =>
      variant.id === 'sensory_clouding' ? { ...variant, isWorkInProgress: true } : variant,
    );
    render(<EncounterPanel {...yamaProps('yama_p3_sensory')} variants={variants} />);
    openContractSection();

    // The caveat rides the terms summary, not a heading inside the panel: a heading would
    // repeat the contract's name directly under the lit chip that already carries it, and the
    // full mark would only be readable once the panel had been opened.
    const head = document.querySelector('.configurer-contract-terms > summary');
    expect(head).not.toBeNull();
    expect(within(head as HTMLElement).getByText('Beta')).toBeInTheDocument();
    expect(document.querySelectorAll('.variant-item-badge .status-badge')).toHaveLength(1);
    // The dense list drops the frame; the mark beside open space keeps it.
    expect(document.querySelector('.variant-item-badge .status-badge--compact')).not.toBeNull();
    expect((head as HTMLElement).querySelector('.status-badge--compact')).toBeNull();
    // ...and it is a caveat, not an availability claim.
    expect(screen.queryByText('Not yet implemented')).toBeNull();
  });
});
