import { describe, expect, it } from 'vitest';
import { PrayerType } from '../../types/simulation';
import { resolveFightStartCountdownForDisplay, resolveInputPresentationForDisplay } from '../GridProviders';

const LIVE_PRESENTATION = {
  armedSpell: 'Ice Barrage',
  inputPresentation: {
    runEnabled: false,
    specialAttackActive: true,
    selectedAttackStyleIndex: 2,
    selectedSpell: 'Wind Strike',
    getTargetTile: () => [32, 37] as [number, number],
    getStartPositionPreparation: () => null,
  },
  prayerPresentation: {
    protection: PrayerType.ProtectMagic,
    boost: [],
    independent: [],
    visualOverrides: { [PrayerType.ProtectMelee]: true },
    anyLit: true,
  },
  quickPrayersActive: true,
  targetTile: [32, 37] as [number, number],
};

describe('resolveInputPresentationForDisplay', () => {
  it('preserves live input presentation during live play', () => {
    expect(resolveInputPresentationForDisplay(false, false, LIVE_PRESENTATION)).toBe(LIVE_PRESENTATION);
  });

  it('isolates replay and demo frames from live input presentation', () => {
    expect(resolveInputPresentationForDisplay(true, false, LIVE_PRESENTATION)).toEqual({
      armedSpell: null,
      inputPresentation: undefined,
      prayerPresentation: undefined,
      quickPrayersActive: false,
      targetTile: null,
    });
  });
});

describe('resolveFightStartCountdownForDisplay', () => {
  it('passes the live countdown through during live play', () => {
    expect(resolveFightStartCountdownForDisplay(false, 'holding')).toBe('holding');
    expect(resolveFightStartCountdownForDisplay(false, 'released')).toBe('released');
    expect(resolveFightStartCountdownForDisplay(false, null)).toBeUndefined();
  });

  it('withholds it from replay and demo frames', () => {
    expect(resolveFightStartCountdownForDisplay(true, 'holding')).toBeUndefined();
    expect(resolveFightStartCountdownForDisplay(true, 'released')).toBeUndefined();
  });
});
