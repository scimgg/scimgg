/**
 * Facts extracted from private gameplay captures (A = colosseum-waves-1-12-damage-trials-solarflare3-volatility3-bees1-totemic-doom1-death-packet-data.txt,
 * B = colosseum-waves-bees-death(no-sol)-packet-data-1.txt, C = colosseum-no-sol-packet-data.txt).
 * One record per intermission: the tick `colosseum_intermission_2_init` (clientscript 4931) first
 * opened, its completed-wave argument, its three offers in button order (cache enum 5312 keys, named),
 * the tiers owned then (owned mask plus the stack varbits), and the confirmed pick. Reopens with
 * identical arguments are omitted, as is K:3978 (colosseum-sol-heredit-packet-data.txt), which
 * repeats C:3723 in the same run; C:3723's pick is confirmed there (K:3987).
 */
import type { ColosseumModifierId } from '../../definitions';

export interface CapturedModifierOffer {
  readonly capture: 'A' | 'B' | 'C';
  readonly tick: number;
  readonly completedWave: number;
  readonly offers: readonly ColosseumModifierId[];
  readonly owned: Readonly<Partial<Record<ColosseumModifierId, number>>>;
  /** Absent where the capture ends before the choice. */
  readonly picked?: ColosseumModifierId;
}

// biome-ignore format: one extracted record per line keeps the fixture reviewable
export const CAPTURED_MODIFIER_OFFERS: readonly CapturedModifierOffer[] = [
  { capture: 'A', tick: 1107, completedWave: 3, offers: ['blasphemy', 'reentry', 'mantimayhem'], owned: { blasphemy: 2, totemic: 1 }, picked: 'blasphemy' },
  { capture: 'A', tick: 1295, completedWave: 4, offers: ['relentless', 'solarflare', 'quartet'], owned: { blasphemy: 3, totemic: 1 }, picked: 'solarflare' },
  { capture: 'A', tick: 1730, completedWave: 5, offers: ['solarflare', 'quartet', 'volatility'], owned: { blasphemy: 3, totemic: 1, solarflare: 1 }, picked: 'solarflare' },
  { capture: 'A', tick: 2135, completedWave: 6, offers: ['solarflare', 'quartet', 'mantimayhem'], owned: { blasphemy: 3, totemic: 1, solarflare: 2 }, picked: 'solarflare' },
  { capture: 'A', tick: 2521, completedWave: 7, offers: ['frailty', 'redFlag', 'volatility'], owned: { blasphemy: 3, totemic: 1, solarflare: 3 }, picked: 'volatility' },
  { capture: 'A', tick: 3054, completedWave: 8, offers: ['doom', 'redFlag', 'frailty'], owned: { volatility: 1, blasphemy: 3, totemic: 1, solarflare: 3 }, picked: 'doom' },
  { capture: 'A', tick: 3547, completedWave: 9, offers: ['volatility', 'doom', 'relentless'], owned: { volatility: 1, blasphemy: 3, totemic: 1, doom: 1, solarflare: 3 }, picked: 'volatility' },
  { capture: 'A', tick: 4184, completedWave: 10, offers: ['volatility', 'doom', 'frailty'], owned: { volatility: 2, blasphemy: 3, totemic: 1, doom: 1, solarflare: 3 }, picked: 'volatility' },
  { capture: 'A', tick: 4871, completedWave: 11, offers: ['doom', 'frailty', 'bees'], owned: { volatility: 3, blasphemy: 3, totemic: 1, doom: 1, solarflare: 3 }, picked: 'bees' },
  { capture: 'B', tick: 1854, completedWave: 0, offers: ['blasphemy', 'relentless', 'frailty'], owned: {}, picked: 'relentless' },
  { capture: 'B', tick: 1916, completedWave: 1, offers: ['relentless', 'frailty', 'quartet'], owned: { relentless: 1 }, picked: 'relentless' },
  { capture: 'B', tick: 2029, completedWave: 2, offers: ['relentless', 'quartet', 'mantimayhem'], owned: { relentless: 2 }, picked: 'relentless' },
  { capture: 'B', tick: 2181, completedWave: 3, offers: ['quartet', 'frailty', 'reentry'], owned: { relentless: 3 }, picked: 'quartet' },
  { capture: 'B', tick: 2336, completedWave: 4, offers: ['bees', 'doom', 'blasphemy'], owned: { relentless: 3, quartet: 1 }, picked: 'bees' },
  { capture: 'B', tick: 2567, completedWave: 5, offers: ['bees', 'volatility', 'myopia'], owned: { bees: 1, relentless: 3, quartet: 1 }, picked: 'bees' },
  { capture: 'B', tick: 2925, completedWave: 6, offers: ['dynamicDuo', 'frailty', 'redFlag'], owned: { bees: 2, relentless: 3, quartet: 1 }, picked: 'frailty' },
  { capture: 'B', tick: 3302, completedWave: 7, offers: ['bees', 'mantimayhem', 'volatility'], owned: { bees: 2, relentless: 3, quartet: 1, frailty: 1 }, picked: 'bees' },
  { capture: 'C', tick: 1444, completedWave: 0, offers: ['blasphemy', 'relentless', 'frailty'], owned: {}, picked: 'blasphemy' },
  { capture: 'C', tick: 1482, completedWave: 1, offers: ['frailty', 'mantimayhem', 'doom'], owned: { blasphemy: 1 }, picked: 'doom' },
  { capture: 'C', tick: 1633, completedWave: 2, offers: ['blasphemy', 'mantimayhem', 'doom'], owned: { blasphemy: 1, doom: 1 }, picked: 'blasphemy' },
  { capture: 'C', tick: 1778, completedWave: 3, offers: ['doom', 'totemic', 'relentless'], owned: { blasphemy: 2, doom: 1 }, picked: 'relentless' },
  { capture: 'C', tick: 1933, completedWave: 4, offers: ['relentless', 'doom', 'quartet'], owned: { blasphemy: 2, relentless: 1, doom: 1 }, picked: 'doom' },
  { capture: 'C', tick: 2117, completedWave: 5, offers: ['blasphemy', 'volatility', 'bees'], owned: { blasphemy: 2, relentless: 1, doom: 2 }, picked: 'blasphemy' },
  { capture: 'C', tick: 2395, completedWave: 6, offers: ['relentless', 'doom', 'redFlag'], owned: { blasphemy: 3, relentless: 1, doom: 2 }, picked: 'relentless' },
  { capture: 'C', tick: 2617, completedWave: 7, offers: ['relentless', 'volatility', 'solarflare'], owned: { blasphemy: 3, relentless: 2, doom: 2 }, picked: 'relentless' },
  { capture: 'C', tick: 2832, completedWave: 8, offers: ['doom', 'volatility', 'redFlag'], owned: { blasphemy: 3, relentless: 3, doom: 2 }, picked: 'doom' },
  { capture: 'C', tick: 3054, completedWave: 9, offers: ['quartet', 'frailty', 'solarflare'], owned: { blasphemy: 3, relentless: 3, doom: 3 }, picked: 'frailty' },
  { capture: 'C', tick: 3434, completedWave: 10, offers: ['frailty', 'reentry', 'myopia'], owned: { blasphemy: 3, relentless: 3, doom: 3, frailty: 1 }, picked: 'myopia' },
  { capture: 'C', tick: 3723, completedWave: 11, offers: ['frailty', 'quartet', 'solarflare'], owned: { blasphemy: 3, relentless: 3, doom: 3, myopia: 1, frailty: 1 }, picked: 'frailty' },
];
