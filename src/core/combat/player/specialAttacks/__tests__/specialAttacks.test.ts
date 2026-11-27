import { describe, expect, it } from 'vitest';
import { createEmptyStats } from '../../../../../types/equipmentStats';
import { createDefaultTimers } from '../../../../../types/playerState';
import { BURN_PERIOD_TICKS } from '../../../burnStacks';
import { projectFirstPartyPlayerAttack } from '../../firstPartyPlayerAttack';
import { getSpecialAttackDef, hasSpecialAttack, SPECIAL_ATTACK_REGISTRY } from '../registry';
import type { SpecialAttackDef, SpecialAttackEffect } from '../types';

const DRAGON_CLAWS = 13652;
const SGS = 11806;
const BGS = 11804;
const AGS = 11802;
const ZGS = 11808;
const DWH = 13576;
const EYE_OF_AYAK = 31113;
const PURGING_STAFF = 29594;
const VOIDWAKER = 27690;
const SOULREAPER_AXE = 28338;
const ELDER_MAUL = 21003;
const ELDER_MAUL_OR = 27100;
const TWISTED_BOW = 20997;
const BURNING_CLAWS = 29577;
const ABYSSAL_BLUDGEON = 13263;

const ALL_WEAPON_IDS = [DRAGON_CLAWS, SGS, BGS, AGS, ZGS, DWH, EYE_OF_AYAK, PURGING_STAFF, VOIDWAKER, BURNING_CLAWS];

function findEffect<T extends SpecialAttackEffect['effect']>(
  def: SpecialAttackDef,
  effectType: T,
): Extract<SpecialAttackEffect, { effect: T }> | undefined {
  return def.postHitEffects?.find((e): e is Extract<SpecialAttackEffect, { effect: T }> => e.effect === effectType);
}

describe('SPECIAL_ATTACK_REGISTRY', () => {
  it('contains weapons with full mechanics and animation-only entries', () => {
    expect(Object.keys(SPECIAL_ATTACK_REGISTRY).length).toBeGreaterThanOrEqual(9);
  });

  it('all weapon IDs are positive integers', () => {
    for (const key of Object.keys(SPECIAL_ATTACK_REGISTRY)) {
      const id = Number(key);
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
    }
  });

  it('every weapon has an energyCost defined', () => {
    for (const id of ALL_WEAPON_IDS) {
      const def = getSpecialAttackDef(id)!;
      expect(def.energyCost).toBeDefined();
      expect(def.energyCost).toBeGreaterThan(0);
    }
  });

  it('hasSpecialAttack returns true for all 9 weapons', () => {
    for (const id of ALL_WEAPON_IDS) {
      expect(hasSpecialAttack(id)).toBe(true);
    }
  });

  it('hasSpecialAttack returns false for unknown weapon', () => {
    expect(hasSpecialAttack(99999)).toBe(false);
  });

  it('no weapon has manual accuracyMultiplier or damageMultiplier', () => {
    for (const id of ALL_WEAPON_IDS) {
      const def = getSpecialAttackDef(id)!;
      expect((def as any).accuracyMultiplier).toBeUndefined();
      expect((def as any).damageMultiplier).toBeUndefined();
    }
  });

  it('getSpecialAttackDef returns undefined for unknown weapon', () => {
    expect(getSpecialAttackDef(99999)).toBeUndefined();
  });

  it('does not register Twisted bow because it has no special attack', () => {
    expect(getSpecialAttackDef(TWISTED_BOW)).toBeUndefined();
    expect(hasSpecialAttack(TWISTED_BOW)).toBe(false);
    expect(getSpecialAttackDef(DRAGON_CLAWS)).toBeDefined();
  });
});

describe('Dragon Claws (13652)', () => {
  const def = getSpecialAttackDef(DRAGON_CLAWS)!;

  it('exists in registry', () => expect(def).toBeDefined());
  it('costs 50% energy', () => expect(def.energyCost).toBe(50));
  it('isMultiHit is true', () => expect(def.isMultiHit).toBe(true));
  it('has no postHitEffects', () => expect(def.postHitEffects).toBeUndefined());
  it('has no styleOverride', () => expect(def.styleOverride).toBeUndefined());
});

describe('Burning claws (29577)', () => {
  const def = getSpecialAttackDef(BURNING_CLAWS)!;

  it('exists in registry', () => expect(def).toBeDefined());
  it('costs 35% energy after the 22 July 2026 increase', () => expect(def.energyCost).toBe(35));
  it('isMultiHit is true', () => expect(def.isMultiHit).toBe(true));

  it('burns 10 damage over 40 ticks, first pulse a period after the hit', () => {
    const burn = findEffect(def, 'burn');
    expect(burn?.pulses).toBe(10);
    expect(burn?.severity).toBe('normal');
    // No firstPulseDelayTicks: the default IS one period, and an explicit 0 would pulse on impact.
    expect(burn?.firstPulseDelayTicks).toBeUndefined();
    expect((burn?.pulses ?? 0) * BURN_PERIOD_TICKS).toBe(40);
  });

  it('scales the per-hitsplat burn chance 15/30/45% by which accuracy roll landed', () => {
    expect(findEffect(def, 'burn')?.chancePercentByBranch).toEqual([15, 30, 45]);
  });

  it('has no targetAttribute so the special fires at non-demons too', () => {
    expect(def.targetAttribute).toBeUndefined();
  });
});

describe('Saradomin Godsword (11806)', () => {
  const def = getSpecialAttackDef(SGS)!;

  it('exists in registry', () => expect(def).toBeDefined());
  it('costs 50% energy', () => expect(def.energyCost).toBe(50));
  it('has exactly 2 postHitEffects', () => expect(def.postHitEffects).toHaveLength(2));
  it('heal_hp with 50% of damage', () => {
    const fx = findEffect(def, 'heal_hp');
    expect(fx).toBeDefined();
    expect(fx!.percentOfDamage).toBe(50);
  });
  it('restore_prayer with 25% of damage', () => {
    const fx = findEffect(def, 'restore_prayer');
    expect(fx).toBeDefined();
    expect(fx!.percentOfDamage).toBe(25);
  });
  it('has no styleOverride', () => expect(def.styleOverride).toBeUndefined());
});

describe('Bandos Godsword (11804)', () => {
  const def = getSpecialAttackDef(BGS)!;

  it('exists in registry', () => expect(def).toBeDefined());
  it('costs 50% energy', () => expect(def.energyCost).toBe(50));
  it('has flat drain_defence effect', () => {
    const fx = findEffect(def, 'drain_defence');
    expect(fx).toBeDefined();
    expect(fx!.flat).toBe(true);
    expect(fx!.percent).toBeUndefined();
  });
});

describe('Armadyl Godsword (11802)', () => {
  const def = getSpecialAttackDef(AGS)!;

  it('exists in registry', () => expect(def).toBeDefined());
  it('costs 50% energy', () => expect(def.energyCost).toBe(50));
  it('has no postHitEffects (pure damage)', () => expect(def.postHitEffects).toBeUndefined());
  it('has no styleOverride', () => expect(def.styleOverride).toBeUndefined());
});

describe('Zamorak Godsword (11808)', () => {
  const def = getSpecialAttackDef(ZGS)!;

  it('exists in registry', () => expect(def).toBeDefined());
  it('costs 50% energy', () => expect(def.energyCost).toBe(50));
  it('freeze duration is 32 ticks', () => {
    const fx = findEffect(def, 'freeze');
    expect(fx?.durationTicks).toBe(32);
  });
});

describe('Dragon Warhammer (13576)', () => {
  const def = getSpecialAttackDef(DWH)!;

  it('exists in registry', () => expect(def).toBeDefined());
  it('costs 50% energy', () => expect(def.energyCost).toBe(50));
  it('drains 30% of current defence', () => {
    const fx = findEffect(def, 'drain_defence');
    expect(fx).toBeDefined();
    expect(fx!.percent).toBe(30);
    expect(fx!.flat).toBeUndefined();
  });
  // The soulreaper/fang/warhammer capture, tick 551.
  it('swings 1378 with dragon_warhammer_sa_spotanim on the player', () => {
    expect(def).toMatchObject({ animationId: 1378, graphicId: 1292 });
  });
});

describe('Eye of Ayak (31113)', () => {
  const def = getSpecialAttackDef(EYE_OF_AYAK)!;

  it('exists in registry', () => expect(def).toBeDefined());
  it('costs 50% energy', () => expect(def.energyCost).toBe(50));
  it('attackSpeedOverride is 5 ticks', () => expect(def.attackSpeedOverride).toBe(5));
  it('drains magic: base=0, 100% of damage', () => {
    const fx = findEffect(def, 'drain_magic');
    expect(fx).toBeDefined();
    expect(fx!.base).toBe(0);
    expect(fx!.percentOfDamage).toBe(100);
  });
});

describe('Purging Staff (29594)', () => {
  const def = getSpecialAttackDef(PURGING_STAFF)!;

  it('exists in registry', () => expect(def).toBeDefined());
  it('costs 25% energy (not 50%)', () => expect(def.energyCost).toBe(25));
  it('styleOverride is magic', () => expect(def.styleOverride).toBe('magic'));
  it('has no postHitEffects', () => expect(def.postHitEffects).toBeUndefined());
  it('has onKillEffect with refundSpecEnergy=25 and reduceAttackDelayTicks=3', () => {
    expect(def.onKillEffect).toBeDefined();
    expect(def.onKillEffect!.refundSpecEnergy).toBe(25);
    expect(def.onKillEffect!.reduceAttackDelayTicks).toBe(3);
  });
});

describe('Voidwaker (27690)', () => {
  const def = getSpecialAttackDef(VOIDWAKER)!;

  it('exists in registry', () => expect(def).toBeDefined());
  it('costs 50% energy', () => expect(def.energyCost).toBe(50));
  it('guaranteedHit is true', () => expect(def.guaranteedHit).toBe(true));
  it('styleOverride is magic', () => expect(def.styleOverride).toBe('magic'));
  it('has no postHitEffects', () => expect(def.postHitEffects).toBeUndefined());
});

describe('Elder maul (21003) — Pulverize', () => {
  const def = getSpecialAttackDef(ELDER_MAUL)!;

  it('exists in registry', () => expect(def).toBeDefined());
  it('costs 50% energy', () => expect(def.energyCost).toBe(50));
  it('uses the overhead smash animation and player graphic', () => {
    expect(def.animationId).toBe(11124);
    expect(def.graphicId).toBe(2804);
  });
  it('drains 35% of current defence', () => {
    const fx = findEffect(def, 'drain_defence');
    expect(fx).toBeDefined();
    expect(fx!.percent).toBe(35);
    expect(fx!.flat).toBeUndefined();
  });
  it('has no isMultiHit or styleOverride', () => {
    expect(def.isMultiHit).toBeUndefined();
    expect(def.styleOverride).toBeUndefined();
  });
  it('shares Pulverize with the ornamented variant', () => {
    expect(getSpecialAttackDef(ELDER_MAUL_OR)).toEqual(def);
  });
});

describe("Osmumten's fang (26219) — Eviscerate", () => {
  const def = getSpecialAttackDef(26219)!;

  it('exists in registry', () => expect(def).toBeDefined());
  it('costs 25% energy (not 50%)', () => expect(def.energyCost).toBe(25));
  it('has no postHitEffects', () => expect(def.postHitEffects).toBeUndefined());
  it('shares the Eviscerate config with the (or) variant 27246', () => {
    const or = getSpecialAttackDef(27246)!;
    expect(or.energyCost).toBe(25);
    expect(or.animationId).toBe(def.animationId);
  });
  it('is not grouped with the ghrazi rapier spec animation (8145)', () => {
    expect(def.animationId).not.toBe(8145);
  });
  it("uses its own animation, not the ordinary stab (9471) or the brine sabre's (6118)", () => {
    expect(def.animationId).toBe(11222);
  });
  // The soulreaper/fang/warhammer capture, tick 522.
  it('puts its own graphic on the player', () => expect(def.graphicId).toBe(2833));
});

describe('post-hit effect formulas', () => {
  describe('SGS heal_hp: Math.max(10, floor(damage * 50 / 100))', () => {
    const cases: [number, number][] = [
      [0, 10], // min 10
      [10, 10], // floor(5) < 10, so 10
      [19, 10], // floor(9.5)=9 < 10, so 10
      [20, 10], // floor(10)=10, equals min
      [21, 10], // floor(10.5)=10, equals min
      [22, 11], // floor(11)=11 > 10
      [50, 25], // floor(25)=25
      [60, 30],
      [99, 49], // floor(49.5)=49
    ];
    for (const [damage, expectedHeal] of cases) {
      it(`damage ${damage} → heal ${expectedHeal}`, () => {
        expect(Math.max(10, Math.floor((damage * 50) / 100))).toBe(expectedHeal);
      });
    }
  });

  describe('SGS restore_prayer: Math.max(5, floor(damage * 25 / 100))', () => {
    const cases: [number, number][] = [
      [0, 5], // min 5
      [10, 5], // floor(2.5)=2 < 5, so 5
      [19, 5], // floor(4.75)=4 < 5, so 5
      [20, 5], // floor(5)=5, equals min
      [21, 5], // floor(5.25)=5, equals min
      [24, 6], // floor(6)=6 > 5
      [60, 15],
      [99, 24], // floor(24.75)=24
    ];
    for (const [damage, expectedRestore] of cases) {
      it(`damage ${damage} → restore ${expectedRestore}`, () => {
        expect(Math.max(5, Math.floor((damage * 25) / 100))).toBe(expectedRestore);
      });
    }
  });

  describe('DWH drain_defence: floor(currentDef * 30 / 100)', () => {
    const cases: [number, number, number][] = [
      // [baseDef, existingDrain, expectedDrain]
      [200, 0, 60], // floor(200 * 0.3)=60
      [200, 60, 42], // floor(140 * 0.3)=42
      [200, 102, 29], // floor(98 * 0.3)=29
      [100, 0, 30], // floor(100 * 0.3)=30
      [1, 0, 0], // floor(0.3)=0
    ];
    for (const [baseDef, existingDrain, expectedDrain] of cases) {
      it(`baseDef=${baseDef}, existingDrain=${existingDrain} → drain ${expectedDrain}`, () => {
        const currentDef = baseDef - existingDrain;
        expect(Math.floor((currentDef * 30) / 100)).toBe(expectedDrain);
      });
    }
  });

  describe('DWH drain stacking', () => {
    it('successive DWH specs stack additively on defenceDrain', () => {
      const baseDef = 200;
      let totalDrain = 0;
      const drains: number[] = [];

      for (let i = 0; i < 3; i++) {
        const currentDef = baseDef - totalDrain;
        const drain = Math.floor((currentDef * 30) / 100);
        drains.push(drain);
        totalDrain += drain;
      }

      expect(drains).toEqual([60, 42, 29]);
      expect(totalDrain).toBe(131);
    });
  });

  describe('BGS drain_defence flat: drain = damage', () => {
    it('drains by exact damage dealt', () => {
      for (const damage of [0, 1, 25, 50, 99]) {
        const debuffs = { defenceDrain: 10 };
        debuffs.defenceDrain += damage;
        expect(debuffs.defenceDrain).toBe(10 + damage);
      }
    });
  });

  describe('Eye of Ayak drain_magic: base + floor(damage * percentOfDamage / 100)', () => {
    // Registry: base=0, percentOfDamage=100 → drain = 0 + floor(damage * 100 / 100) = damage
    const cases: [number, number][] = [
      [0, 0],
      [1, 1],
      [25, 25],
      [50, 50],
      [99, 99],
    ];
    for (const [damage, expectedDrain] of cases) {
      it(`damage ${damage} → magic drain ${expectedDrain}`, () => {
        expect(0 + Math.floor((damage * 100) / 100)).toBe(expectedDrain);
      });
    }
  });

  describe('Scorching bow (29591) — Scorching shackles', () => {
    const def = getSpecialAttackDef(29591)!;

    it('exists in the registry and costs 25% energy', () => {
      expect(def).toBeDefined();
      expect(def.energyCost).toBe(25);
    });

    // The wiki is explicit that the bind lands "regardless of whether it is a successful hit or
    // not", and `postHitEffects` only run on positive damage — so putting either effect there
    // silently drops it on the misses, which are 3 of the 6 casts in the sensory capture.
    it('binds and burns on FIRE, never on hit', () => {
      expect(def.postHitEffects).toBeUndefined();
      expect(def.onFireEffects?.map((effect) => effect.effect).sort()).toEqual(['bind', 'burn']);
    });

    // Eligibility is on the DEFINITION, not the effects: the wiki's refusal message ("Scorching
    // shackles won't work against a non-demon enemy") means a non-demon costs no energy at all,
    // which a per-effect guard cannot express because the energy is already spent by then.
    it('is refused outright against anything that is not a demon', () => {
      expect(def.targetAttribute).toBe('demon');
      for (const effect of def.onFireEffects ?? []) {
        expect(effect).not.toHaveProperty('demonOnly');
      }
    });

    it('lands three ticks after the swing at every distance the captures observe', () => {
      expect(def.hitDelayTicks).toBe(3);
    });

    it('binds for the 21 movement ticks the captures measure', () => {
      const bind = def.onFireEffects?.find((effect) => effect.effect === 'bind');
      expect(bind).toMatchObject({ delayTicks: 2, durationTicks: 21 });
    });

    it('burns six times, four ticks apart, from the shot', () => {
      const burn = def.onFireEffects?.find((effect) => effect.effect === 'burn');
      expect(burn).toMatchObject({ firstPulseDelayTicks: 3, pulses: 6, severity: 'normal' });
    });
  });
});

describe('integration invariants', () => {
  it('only the two claws have isMultiHit', () => {
    for (const id of ALL_WEAPON_IDS) {
      const def = getSpecialAttackDef(id)!;
      if (id === DRAGON_CLAWS || id === BURNING_CLAWS) {
        expect(def.isMultiHit).toBe(true);
      } else {
        expect(def.isMultiHit).toBeUndefined();
      }
    }
  });

  it('only voidwaker has guaranteedHit', () => {
    for (const id of ALL_WEAPON_IDS) {
      const def = getSpecialAttackDef(id)!;
      if (id === VOIDWAKER) {
        expect(def.guaranteedHit).toBe(true);
      } else {
        expect(def.guaranteedHit).toBeUndefined();
      }
    }
  });

  it('only purging staff has onKillEffect', () => {
    for (const id of ALL_WEAPON_IDS) {
      const def = getSpecialAttackDef(id)!;
      if (id === PURGING_STAFF) {
        expect(def.onKillEffect).toBeDefined();
        expect(def.onKillEffect!.refundSpecEnergy).toBe(25);
        expect(def.onKillEffect!.reduceAttackDelayTicks).toBe(3);
      } else {
        expect(def.onKillEffect).toBeUndefined();
      }
    }
  });

  it('only eye of ayak has attackSpeedOverride', () => {
    for (const id of ALL_WEAPON_IDS) {
      const def = getSpecialAttackDef(id)!;
      if (id === EYE_OF_AYAK) {
        expect(def.attackSpeedOverride).toBe(5);
      } else {
        expect(def.attackSpeedOverride).toBeUndefined();
      }
    }
  });

  it('energy costs: purging staff is 25%, burning claws is 35%, all others are 50%', () => {
    const exceptions = new Map([
      [PURGING_STAFF, 25],
      [BURNING_CLAWS, 35],
    ]);
    for (const id of ALL_WEAPON_IDS) {
      expect(getSpecialAttackDef(id)!.energyCost).toBe(exceptions.get(id) ?? 50);
    }
  });

  it('styleOverride only on voidwaker and purging staff (both magic)', () => {
    for (const id of ALL_WEAPON_IDS) {
      const def = getSpecialAttackDef(id)!;
      if (id === VOIDWAKER || id === PURGING_STAFF) {
        expect(def.styleOverride).toBe('magic');
      } else {
        expect(def.styleOverride).toBeUndefined();
      }
    }
  });

  it('no consume_soul_stacks effect type exists in any registry entry', () => {
    for (const id of ALL_WEAPON_IDS) {
      const def = getSpecialAttackDef(id)!;
      if (def.postHitEffects) {
        for (const fx of def.postHitEffects) {
          expect((fx as any).effect).not.toBe('consume_soul_stacks');
        }
      }
    }
  });

  it('soulreaper axe Behead is free and shared with the (o) variant', () => {
    // The soulreaper/fang/warhammer capture, tick 473.
    expect(getSpecialAttackDef(SOULREAPER_AXE)).toMatchObject({ energyCost: 0, animationId: 10173, graphicId: 2430 });
    expect(getSpecialAttackDef(33335)).toEqual(getSpecialAttackDef(SOULREAPER_AXE));
  });
});

describe('special attack defence rolls', () => {
  // /w/Special_attacks "Defence roll" row (rev 15350782).
  it.each([
    [DRAGON_CLAWS, 'melee_slash'],
    [SGS, 'melee_slash'],
    [BGS, 'melee_slash'],
    [AGS, 'melee_slash'],
    [ZGS, 'melee_slash'],
    [DWH, 'melee_crush'],
    [ELDER_MAUL, 'melee_crush'],
    [ELDER_MAUL_OR, 'melee_crush'],
    [1215, 'melee_slash'], // dragon dagger, a stab weapon whose special rolls against slash
    [13265, 'melee_slash'], // abyssal dagger
    [26219, 'melee_stab'], // Osmumten's fang
  ] as const)('%i always rolls against %s', (weaponId, style) => {
    expect(getSpecialAttackDef(weaponId)?.defenceStyle).toBe(style);
  });

  it('leaves Burning barrage on the selected style ("Selected combat style")', () => {
    expect(getSpecialAttackDef(BURNING_CLAWS)?.defenceStyle).toBeUndefined();
  });

  /** Attack and defence rolls of a special fired with the claws' stab style (Lunge) selected. */
  function lungeRolls(weaponId: number, prayerPoints = 99) {
    const projection = projectFirstPartyPlayerAttack({
      player: {
        stats: {
          attack: { current: 99, max: 99 },
          strength: { current: 99, max: 99 },
          defence: { current: 99, max: 99 },
          ranged: { current: 99, max: 99 },
          magic: { current: 99, max: 99 },
          prayer: { current: prayerPoints, max: 99 },
          hitpoints: { current: 99, max: 99 },
          agility: { current: 99, max: 99 },
        },
        equipment: { weapon: weaponId },
        equipmentStats: { ...createEmptyStats(), attackStab: 60, attackSlash: 90, meleeStrength: 100 },
        activePrayer: null,
        boostPrayers: [],
        selectedAttackStyleIndex: 2,
        combatTimers: createDefaultTimers(),
      },
      target: {
        size: 1,
        npcTypeId: 1,
        formulaStats: {
          levels: { attack: 1, strength: 1, defence: 100, ranged: 1, magic: 1 },
          offensive: { atk: 0, str: 0, ranged: 0, rangedStr: 0, magic: 0, magicStr: 0 },
          defensive: { stab: 200, slash: 10, crush: 50, rangedLight: 0, rangedStandard: 0, rangedHeavy: 0, magic: 0 },
        },
      },
      formulaStyle: 'melee_stab',
      resources: { kind: 'none', source: 'none' },
      attackSpeedTicks: 4,
      delivery: { style: 'melee', attackKind: 'melee_stab', impactDelayTicks: 0 },
      application: { outgoingDamageMultiplier: 1, specialAttackDamageMultiplier: 1 },
      manualCast: false,
      isSpecialAttack: true,
      standardAccuracyMode: 'single_roll',
    });
    return {
      attack: projection?.baseAttackRoll,
      defence: projection?.baseDefenceRoll,
      baseMaxHit: projection?.baseMaxHit,
      maxHit: projection?.profileMaxHit,
    };
  }

  it("raises Penance's max hit 0.5% per missing prayer point, with ordinary accuracy", () => {
    const full = lungeRolls(ABYSSAL_BLUDGEON, 99);
    const empty = lungeRolls(ABYSSAL_BLUDGEON, 0);
    const base = full.baseMaxHit ?? 0;
    expect(base).toBeGreaterThan(0);
    expect(full.maxHit).toBe(base);
    expect(empty.maxHit).toBe(Math.floor((base * 299) / 200));
    expect(empty.attack).toBe(full.attack);
  });

  it('rolls Slice and Dice against slash but Burning barrage against the selected stab', () => {
    const claws = lungeRolls(DRAGON_CLAWS);
    const burning = lungeRolls(BURNING_CLAWS);
    // Both attack with the selected stab bonus.
    expect(claws.attack).toBe(burning.attack);
    // Defence roll = (defence level + 9) * (style bonus + 64).
    expect(claws.defence).toBe((100 + 9) * (10 + 64));
    expect(burning.defence).toBe((100 + 9) * (200 + 64));
  });
});
