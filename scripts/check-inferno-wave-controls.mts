/**
 * Rendered-geometry and real-pointer checks for the Inferno setup, in bounded UI-harness scenarios:
 * each loads one page from saved settings and takes a few actions. No cache, camera, fight
 * progression or world arrangement; the editor's state transitions are covered by
 * `src/encounters/inferno/__tests__/InfernoSetup.test.tsx`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import sharp from 'sharp';
import { INFERNO_ARENA_MAP_IMAGE } from '../src/encounters/inferno/arenaMapImage';
import { INFERNO_SPAWN_SLOTS } from '../src/encounters/inferno/constants';
import { INFERNO_PILLARS } from '../src/encounters/inferno/pillars';
import { infernoIdentity } from '../src/npcs/inferno/actors';

const base = process.argv[2];
const output = process.argv[3];
if (!base || !output) throw new Error('Usage: check-inferno-wave-controls.mts <dev-url> <screenshot-directory>');
// Only your own dev server: http(s) on a loopback host. `URL.hostname` keeps an IPv6 literal's brackets.
const baseUrl = URL.canParse(base) ? new URL(base) : null;
if (
  !baseUrl ||
  !['http:', 'https:'].includes(baseUrl.protocol) ||
  !['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname)
)
  throw new Error(`<dev-url> must be http(s) on localhost, 127.0.0.1 or [::1]; got ${base}`);
await mkdir(output, { recursive: true });
const failures: string[] = [];
const footerAnchors = new WeakMap<Page, { x: number; y: number }>();
const footerEvidence: unknown[] = [];

type Scenario = 'setup' | 'partial' | 'wave62' | 'placed' | 'waves' | 'practice';
interface Case {
  name: string;
  width: number;
  height: number;
  layout: 'modern' | 'fixed' | 'mobile';
  /** The lobby configurer's rail; otherwise Practice and its standalone workbench (tick 12). */
  rail: boolean;
  touch: boolean;
  run: readonly Scenario[];
}
/** Each state runs only at the viewports where its geometry is at risk, not at every one. */
const cases: readonly Case[] = [
  {
    name: 'desktop',
    width: 1440,
    height: 900,
    layout: 'modern',
    rail: true,
    touch: false,
    run: ['setup', 'partial', 'waves'],
  },
  {
    name: 'phone',
    width: 390,
    height: 844,
    layout: 'modern',
    rail: true,
    touch: true,
    run: ['setup', 'partial', 'wave62', 'placed'],
  },
  {
    name: 'fixed-1x',
    width: 765,
    height: 503,
    layout: 'fixed',
    rail: false,
    touch: false,
    run: ['practice', 'wave62'],
  },
  { name: 'wide-practice', width: 1440, height: 900, layout: 'modern', rail: false, touch: false, run: ['practice'] },
  {
    name: 'mobile',
    width: 844,
    height: 390,
    layout: 'mobile',
    rail: false,
    touch: true,
    run: ['practice', 'wave62', 'placed'],
  },
];

/**
 * Opening the configurer resets the saved Inferno setup, so the rail sets its wave by typing and
 * places a partial layout by real clicks; Practice keeps saved settings and spawns them at tick 12.
 */
const PARTIAL_52 = [
  ['Mager', 0],
  ['Ranger', 1],
  ['Bat', 2],
] as const;
/** Wave 62 with five of its six monsters placed, the bat in the south spot. */
const PARTIAL_62 = [
  ['Mager', 0],
  ['Ranger', 1],
  ['Meleer', 2],
  ['Blob', 3],
  ['Bat', 4],
] as const;
/** Practice's populated wave 62: every kind placed, all pillars down and a moved start. */
const PLACED_62_SETUP = {
  infernoStartWave: '62',
  infernoSpawnLayout: '62:grmlbb---',
  infernoWestPillarDestroyed: true,
  infernoSouthPillarDestroyed: true,
  infernoNorthEastPillarDestroyed: true,
  infernoStartTile: '25,39',
};
const MOVED_START = [25, 39] as const;
/** The rail's longest Arena summary: partial placement, every pillar down, a moved start. */
const LONGEST_SUMMARY = 'Custom, rest random · All pillars down · Moved start';

async function capture(page: Page, name: string) {
  await page.mouse.move(1, 1);
  await page
    .locator('.spawn-map__terrain')
    .evaluateAll((images) => Promise.all(images.map((image) => (image as HTMLImageElement).decode())));
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  const footer = await page.evaluate(() => {
    const share = [...document.querySelectorAll<HTMLElement>('.inferno-copy')].find(
      (el) => el.getBoundingClientRect().width > 0,
    );
    if (!share) return null;
    const root = share.closest('footer')!;
    const copy = share.querySelector('.inferno-copy-link')!.getBoundingClientRect();
    const primary = root.querySelector('.osrs-btn--primary')?.getBoundingClientRect();
    return {
      rail: root.classList.contains('encounter-panel-footer'),
      share: share.getBoundingClientRect().toJSON(),
      copy: copy.toJSON(),
      primary: primary?.toJSON(),
    };
  });
  if (footer) {
    footerEvidence.push({ name, ...footer });
    if (footer.primary && footer.copy.width > footer.primary.width + 0.5)
      failures.push(`${name}: Copy wider than primary`);
    if (footer.rail) {
      const anchor = footerAnchors.get(page);
      if (anchor && (Math.abs(anchor.x - footer.share.x) > 0.5 || Math.abs(anchor.y - footer.share.y) > 0.5))
        failures.push(`${name}: sharing group shifted with summary`);
      footerAnchors.set(page, footer.share);
    }
  }
  await page.screenshot({ path: resolve(output, `${name}.png`) });
  if (name.endsWith('-wave62') || name.endsWith('-wave62-placed')) {
    const mapImage = await page.locator('.spawn-map').screenshot();
    const metadata = await sharp(mapImage).metadata();
    await sharp(mapImage)
      .resize(metadata.width! * 3, metadata.height! * 3, { kernel: 'nearest' })
      .toFile(resolve(output, `${name}-zoom3x.png`));
  }
}

/** Include gear on -> off must not move any footer box. */
async function checkSharing(page: Page, name: string, rail: boolean) {
  const footer = page.locator(rail ? '.encounter-panel-footer' : '.spawn-layout-tool__footer');
  const checkbox = footer.getByRole('checkbox', { name: 'Include gear', exact: true });
  if ((await checkbox.getAttribute('aria-checked')) !== 'true') failures.push(`${name}: gear not enabled by default`);
  const geometry = () =>
    footer.evaluate((root) => {
      const nodes = [
        root,
        ...root.querySelectorAll('.inferno-copy,.inferno-copy__option,.inferno-copy-link,.osrs-btn--primary'),
      ];
      return nodes.map((node) => node.getBoundingClientRect().toJSON() as Record<string, number>);
    });
  const before = await geometry();
  const fits = await footer.evaluate((root) => {
    const group = root.querySelector('.inferno-copy')!.getBoundingClientRect();
    const option = root.querySelector('.inferno-copy__option')!.getBoundingClientRect();
    const hint = root.querySelector('.inferno-copy__consequence')!.getBoundingClientRect();
    const copy = root.querySelector('.inferno-copy-link')!.getBoundingClientRect();
    const bounds = root.getBoundingClientRect();
    return (
      option.height >= 44 &&
      group.left >= bounds.left &&
      group.right <= bounds.right &&
      hint.left >= option.left &&
      hint.right <= option.right &&
      hint.bottom <= option.bottom &&
      option.right <= copy.left
    );
  });
  if (!fits) failures.push(`${name}: sharing controls overflow or miss touch target`);
  await capture(page, `${name}-sharing-with-gear`);
  await checkbox.click();
  await footer.getByText('Link opens setup', { exact: true }).waitFor();
  const after = await geometry();
  if (
    after.some((rect, index) =>
      ['x', 'y', 'width', 'height'].some((key) => Math.abs(rect[key] - before[index][key]) > 0.5),
    )
  )
    failures.push(`${name}: toggling gear shifts footer`);
  await capture(page, `${name}-sharing-without-gear`);
  await checkbox.click();
}

async function measureMap(page: Page, name: string) {
  const evidence = await page.locator('.spawn-map').evaluate(
    (map, expected) => {
      const box = map.getBoundingClientRect();
      const plane = map.querySelector<HTMLElement>('.spawn-map__plane')!;
      const projection = plane.getBoundingClientRect();
      const tile = Number(plane.dataset.tileSize);
      const issues: string[] = [];
      if (
        !Number.isInteger(tile) ||
        Math.abs(projection.width - 33 * tile) > 0.5 ||
        Math.abs(projection.height - 34 * tile) > 0.5
      )
        issues.push('projection does not use one integer tile scale');
      if (
        Math.abs(projection.left - Math.round(projection.left)) > 0.01 ||
        Math.abs(projection.top - Math.round(projection.top)) > 0.01
      )
        issues.push('projection origin is not pixel aligned');
      const checkFootprint = (el: Element, position: readonly number[], size: number, label: string) => {
        const r = el.getBoundingClientRect();
        const wanted = [
          projection.left + (position[0] - expected.bounds.minX) * tile,
          projection.top + (expected.bounds.maxY + 1 - position[1] - size) * tile,
          size * tile,
          size * tile,
        ];
        if ([r.left, r.top, r.width, r.height].some((value, index) => Math.abs(value - wanted[index]) > 0.5))
          issues.push(`${label}: footprint differs from tile transform`);
      };
      const terrain = map.querySelector<HTMLImageElement>('.spawn-map__terrain');
      if (!terrain || !terrain.complete || terrain.naturalWidth !== 264 || terrain.naturalHeight !== 272)
        issues.push('terrain underlay missing or wrong bounds');
      if (terrain) {
        const image = terrain.getBoundingClientRect();
        if (
          Math.abs(image.left - projection.left) > 0.5 ||
          Math.abs(image.width - projection.width) > 0.5 ||
          Math.abs(image.top - projection.top) > 0.5 ||
          Math.abs(image.height - projection.height) > 0.5
        )
          issues.push('terrain underlay not aligned to diagram');
      }
      const grid = map.querySelector<SVGSVGElement>('.spawn-map__grid');
      if (!grid) issues.push('floor grid missing');
      else {
        // Use the tile scale, not clientWidth/Height: those round away fractional phone/landscape sizes.
        const g = grid.getBoundingClientRect();
        if (
          Math.abs(g.left - projection.left - tile * 2) > 0.1 ||
          Math.abs(g.top - projection.top - tile * 2) > 0.1 ||
          Math.abs(g.width - tile * 29) > 0.1 ||
          Math.abs(g.height - tile * 30) > 0.1
        )
          issues.push('grid not aligned to playable tile bounds');
        if (
          grid.getAttribute('shape-rendering') !== 'crispEdges' ||
          grid.querySelector('path')?.getAttribute('vector-effect') !== 'non-scaling-stroke' ||
          getComputedStyle(grid).pointerEvents !== 'none'
        )
          issues.push('grid lost crisp non-interactive rendering');
      }
      if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight)
        issues.push('map outside viewport');
      const caption = map.closest('.inferno-arena')?.querySelector('.inferno-arena__caption')?.getBoundingClientRect();
      if (caption && caption.height > 36.5) issues.push('caption exceeds its reserved two lines');
      const player = map.querySelector<HTMLElement>('.spawn-map__player')!;
      const playerBox = player.getBoundingClientRect();
      const playerTile = player.getAttribute('aria-label')!.match(/Your start: (\d+), (\d+)/)!;
      checkFootprint(player, [Number(playerTile[1]), Number(playerTile[2])], 1, 'You');
      for (const pillar of map.querySelectorAll<HTMLElement>('.spawn-map__pillar')) {
        const p = pillar.getBoundingClientRect();
        const style = getComputedStyle(pillar);
        const down = pillar.classList.contains('is-down');
        checkFootprint(
          pillar,
          expected.pillars.find((p) => p.key === pillar.dataset.pillar)!.position,
          3,
          `pillar ${pillar.dataset.pillar}`,
        );
        if (
          pillar.querySelector('svg') ||
          style.borderRadius !== '0px' ||
          style.borderTopStyle !== (down ? 'dotted' : 'solid') ||
          (down ? style.backgroundColor !== 'rgba(0, 0, 0, 0)' : style.backgroundColor === 'rgba(0, 0, 0, 0)')
        )
          issues.push('pillar is not a solid square / unfilled dashed down state');
        const label = pillar.querySelector<HTMLElement>('.spawn-map__pillar-label')!.getBoundingClientRect();
        if (Math.abs(p.width / playerBox.width - 3) > 0.05 || Math.abs(p.height / playerBox.height - 3) > 0.05)
          issues.push('terrain scale differs from 3×3 / 1×1');
        if (label.left < projection.left || label.right > p.right + 1 || label.top < p.top || label.bottom > p.bottom)
          issues.push('pillar label crosses map/east footprint edge');
        if (p.left - box.left < playerBox.width * 1.9 || box.right - p.right < playerBox.width * 1.9)
          issues.push('pillar touches map frame');
      }
      for (const target of map.querySelectorAll<HTMLElement>('[data-spawn-slot]')) {
        const b = target.getBoundingClientRect();
        const kind = Object.keys(expected.sizes).find((kind) => target.classList.contains(`spawn-kind--${kind}`));
        const size = kind ? expected.sizes[kind] : 4;
        checkFootprint(
          target,
          expected.slots[Number(target.dataset.spawnSlot)],
          size,
          `spot ${target.dataset.spawnSlot}`,
        );
        const hit = target.closest<HTMLElement>('[data-spawn-hit]')!;
        checkFootprint(
          hit,
          expected.slots[Number(target.dataset.spawnSlot)],
          4,
          `spot target ${target.dataset.spawnSlot}`,
        );
        if (size < 4 && getComputedStyle(hit).outlineStyle !== 'dashed')
          issues.push('small NPC lost the maximum spot outline');
        for (const pillar of map.querySelectorAll<HTMLElement>('.spawn-map__pillar:not(.is-down)')) {
          const p = pillar.getBoundingClientRect();
          if (
            Math.min(p.right, b.right) - Math.max(p.left, b.left) > 0.5 &&
            Math.min(p.bottom, b.bottom) - Math.max(p.top, b.top) > 0.5
          )
            issues.push(`spot ${target.dataset.spawnSlot} overlaps standing pillar ${pillar.dataset.pillar}`);
        }
        if (target.dataset.spawnSlot === '3') {
          const south = map.querySelector('[data-pillar="south"]')!.getBoundingClientRect();
          if (Math.abs(south.left - b.right - (5 - size) * tile) > 0.5)
            issues.push('south gap differs from tile anchors');
        }
      }
      for (const button of map.querySelectorAll<HTMLElement>('[data-spawn-hit], [data-pillar]')) {
        const area = getComputedStyle(button, '::after');
        if (parseFloat(area.width) < 44 || parseFloat(area.height) < 44) issues.push('invisible hit target below 44px');
      }
      return {
        issues,
        map: box.toJSON(),
        projection: projection.toJSON(),
        tile,
        player: playerBox.toJSON(),
        playerBorder: getComputedStyle(player).borderWidth,
      };
    },
    {
      bounds: INFERNO_ARENA_MAP_IMAGE.bounds,
      slots: INFERNO_SPAWN_SLOTS,
      pillars: INFERNO_PILLARS,
      sizes: Object.fromEntries(
        (['mager', 'ranger', 'meleer', 'blob', 'bat'] as const).map((kind) => [kind, infernoIdentity(kind).size]),
      ) as Record<string, number>,
    },
  );
  failures.push(...evidence.issues.map((issue) => `${name}: ${issue}`));
  await writeFile(resolve(output, `${name}.json`), JSON.stringify(evidence, null, 2));
}

type EditorGeometry = Awaited<ReturnType<typeof editorGeometry>>;

async function editorGeometry(page: Page) {
  return page.evaluate(() => {
    const selectors = [
      '.spawn-map,.spawn-map-space',
      '.spawn-progress',
      '.inferno-arena-summary',
      '.configurer-encounter-setup + .rail-section',
      '.spawn-layout-tool__footer',
    ];
    const positions = selectors.map((selector) => {
      const el = [...document.querySelectorAll<HTMLElement>(selector)].find(
        (node) => node.getBoundingClientRect().width > 0,
      );
      return el?.getBoundingClientRect().toJSON() ?? null;
    });
    const root =
      document.querySelector<HTMLElement>('.inferno-setup--rail') ??
      document.querySelector<HTMLElement>('.inferno-layout-tool')!;
    const card = document.querySelector('.encounter-panel-card') ?? document.querySelector('.encounter-workbench')!;
    const b = root.getBoundingClientRect();
    const overflowing = [...root.querySelectorAll<HTMLElement>('*')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.left < b.left - 1 || r.right > b.right + 1);
      })
      .map((el) => el.className)
      .filter((name) => typeof name === 'string');
    return { positions, width: b.width, cardWidth: card.getBoundingClientRect().width, overflowing };
  });
}

/**
 * One representative transition: the column and card keep `widthOf`'s widths, nothing overflows,
 * and (given `topsOf`) no surface moves vertically.
 */
function checkStable(
  name: string,
  action: string,
  next: EditorGeometry,
  { widthOf, topsOf }: { widthOf: EditorGeometry; topsOf?: EditorGeometry },
) {
  next.positions.forEach((rect, index) => {
    const before = topsOf?.positions[index];
    if (rect && before && Math.abs(rect.top - before.top) > 0.5)
      failures.push(`${name}: ${action} shifted surface ${index}`);
  });
  if (Math.abs(next.width - widthOf.width) > 0.5 || Math.abs(next.cardWidth - widthOf.cardWidth) > 0.5)
    failures.push(`${name}: ${action} widened column/card`);
  if (next.overflowing.length) failures.push(`${name}: ${action} overflows: ${next.overflowing.join(', ')}`);
}

/** The editor and its listed children fit inside the rail editor or workbench frame. */
async function checkContainer(page: Page, name: string, rail: boolean) {
  const windowFits = await page.locator(rail ? '.inferno-layout-editor' : '.encounter-workbench').evaluate((el) => {
    const b = el.getBoundingClientRect();
    const children = [
      ...el.querySelectorAll('.spawn-map,.spawn-progress,.spawn-layout-tool__footer,.inferno-arena__caption'),
    ];
    const fits =
      b.left >= 0 &&
      b.top >= 0 &&
      b.right <= innerWidth &&
      b.bottom <= innerHeight &&
      el.scrollWidth <= el.clientWidth &&
      children.every((child) => {
        const r = child.getBoundingClientRect();
        return r.left >= b.left && r.right <= b.right && r.top >= b.top && r.bottom <= b.bottom;
      });
    return {
      fits,
      box: b.toJSON(),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      children: children.map((child) => ({ name: child.className, box: child.getBoundingClientRect().toJSON() })),
    };
  });
  await writeFile(resolve(output, `${name}-container.json`), JSON.stringify(windowFits, null, 2));
  if (!windowFits.fits) failures.push(`${name}: arena window does not fit`);
}

/** The rail's chips and map share the content column's left edge and width. */
async function checkEditorEdge(page: Page, name: string) {
  const aligned = await page.locator('.inferno-layout-editor').evaluate((editor) => {
    const map = editor.querySelector('.spawn-map')!.getBoundingClientRect();
    const chips = editor.querySelector('.spawn-progress')!.getBoundingClientRect();
    const parent = editor.parentElement!.getBoundingClientRect();
    return (
      Math.abs(chips.width - map.width) <= 1 &&
      Math.abs(chips.left - map.left) <= 1 &&
      Math.abs(map.left - parent.left) <= 0.5
    );
  });
  if (!aligned) failures.push(`${name}: chips/map not flush with rail content`);
}

async function checkFiveKindRow(page: Page, name: string) {
  const oneLine = await page.locator('.spawn-progress:visible').evaluate((row) => {
    const chips = [...row.querySelectorAll('button')];
    return (
      chips.length === 5 &&
      chips.every((chip) => Math.abs(chip.getBoundingClientRect().top - chips[0].getBoundingClientRect().top) < 1)
    );
  });
  if (!oneLine) failures.push(`${name}: five-kind row wraps`);
}

/** Real pointer clicks where the west slot's drawn edge meets the west pillar's 44px hit area. */
async function checkAdjacentTargets(page: Page, name: string) {
  const west = page.locator('[data-spawn-slot="1"]');
  const pillar = page.locator('[data-pillar="west"]');
  const slotBox = (await west.boundingBox())!;
  const pillarBox = (await pillar.boundingBox())!;
  const wasDown = await pillar.getAttribute('aria-pressed');
  await page.locator('.spawn-progress .spawn-kind--mager').click();
  // Inside the slot's drawn west edge, but also inside the pillar's expanded hit area.
  await page.mouse.click(slotBox.x + 2, Math.max(slotBox.y, pillarBox.y) + 2);
  if (!(await west.textContent())?.includes('Mager') || (await pillar.getAttribute('aria-pressed')) !== wasDown)
    failures.push(`${name}: touching west slot/pillar chose the wrong target`);
  await page.getByRole('button', { name: 'Clear spawns', exact: true }).click();
  await page.mouse.click(pillarBox.x + pillarBox.width / 2, pillarBox.y + pillarBox.height / 2);
  if ((await pillar.getAttribute('aria-pressed')) === wasDown)
    failures.push(`${name}: pillar center did not toggle pillar`);
  await page.mouse.click(pillarBox.x + pillarBox.width / 2, pillarBox.y + pillarBox.height / 2);
}

/** A real click in the empty NE corner of the bat's maximum spot opens its picker without moving You. */
async function checkBatSpot(page: Page, name: string) {
  const batTarget = (await page.locator('[data-spawn-hit="4"]').boundingBox())!;
  const playerBefore = await page.locator('.spawn-map__player').getAttribute('aria-label');
  await page.mouse.click(batTarget.x + batTarget.width - 2, batTarget.y + 2);
  if (
    !(await page.getByRole('dialog', { name: 'Monster at South', exact: true }).isVisible()) ||
    (await page.locator('.spawn-map__player').getAttribute('aria-label')) !== playerBefore
  )
    failures.push(`${name}: bat spot NE corner moved You instead of selecting the spot`);
  await capture(page, `${name}-bat-spot-picker`);
  await page.keyboard.press('Escape');
}

/** The tool's draft matches the spawned wave's placements, and opening it saved nothing. */
async function checkSeeded(page: Page, name: string, savedWave: string) {
  const seeded = await page.evaluate(() => {
    const state = (
      window as unknown as {
        uiHarness: { getState: () => { encounter: { state: { wave: number; waveSpawnLayout: string } } } };
      }
    ).uiHarness.getState().encounter.state;
    const serialized = state.waveSpawnLayout;
    const chars: Record<string, string> = { b: 'bat', l: 'blob', m: 'meleer', r: 'ranger', g: 'mager' };
    const slots = [...serialized.split(':')[1]];
    const input = document.querySelector<HTMLInputElement>('.encounter-workbench input[type="number"]')!;
    return {
      wave: state.wave,
      serialized,
      input: input.value,
      savedWave: JSON.parse(localStorage.getItem('ui-harness:osrs-yama-settings')!).mechanicsConfigPerEncounter.inferno
        .infernoStartWave,
      matches: slots.every((char, index) => {
        const el = document.querySelector(`[data-spawn-slot="${index}"]`)!;
        return char === '-' ? !el.classList.contains('is-filled') : el.classList.contains(`spawn-kind--${chars[char]}`);
      }),
    };
  });
  if (seeded.input !== String(seeded.wave) || !seeded.matches || seeded.savedWave !== savedWave)
    failures.push(`${name}: tool did not seed the spawned wave`);
  await writeFile(resolve(output, `${name}-seeded.json`), JSON.stringify(seeded, null, 2));
}

async function scrollRailToTop(page: Page) {
  await page.locator('.encounter-panel-body,.encounter-panel-rail').evaluateAll((nodes) => {
    for (const node of nodes) node.scrollTop = 0;
  });
}

const summaryState = (page: Page) => page.locator('.inferno-arena-summary__state');

/** A real pointer click on the center of one map tile. */
async function clickTile(page: Page, [x, y]: readonly [number, number]) {
  const point = await page.locator('.spawn-map__plane').evaluate(
    (plane, { x, y, bounds }) => {
      const r = plane.getBoundingClientRect();
      const tile = Number((plane as HTMLElement).dataset.tileSize);
      return { x: r.left + (x - bounds.minX + 0.5) * tile, y: r.top + (bounds.maxY - y + 0.5) * tile };
    },
    { x, y, bounds: INFERNO_ARENA_MAP_IMAGE.bounds },
  );
  await page.mouse.click(point.x, point.y);
}

/** Rail: expand the Arena row and bring its inline editor into view. Practice: open the workbench. */
async function openEditor(page: Page, c: Case, wave: number) {
  if (c.rail) {
    const summary = page.locator('.inferno-arena-summary');
    if ((await summary.getAttribute('aria-expanded')) !== 'true') await summary.click();
    await summary.evaluate((row) => row.parentElement?.scrollIntoView({ block: 'nearest' }));
    await page.getByRole('region', { name: `Wave ${wave} layout`, exact: true }).waitFor();
    return;
  }
  const entry =
    c.layout === 'mobile'
      ? page.locator('.osm-tools__groups').getByRole('button', { name: 'Edit layout', exact: true })
      : page.locator('nav.launcher-row').getByRole('button', { name: 'Edit layout', exact: true });
  await entry.click();
  await page.getByRole('dialog', { name: 'Edit layout', exact: true }).waitFor();
}

/** The rail's Start wave field, or the open workbench's. */
async function setWave(page: Page, c: Case, wave: string) {
  const input = c.rail
    ? page.getByLabel('Start wave', { exact: true })
    : page.locator('.encounter-workbench').getByLabel('Start wave', { exact: true });
  await input.fill(wave);
  await input.blur();
}

/** Wave 52 random, collapsed then expanded: row alignment, disclosure geometry, caption, sharing. */
async function railSetup(page: Page, c: Case) {
  const name = `${c.name}-setup`;
  await setWave(page, c, '52');
  const summary = page.locator('.inferno-arena-summary');
  await capture(page, `${name}-collapsed`);
  const form = await page.locator('.inferno-setup').evaluate((el) => {
    const value = el.querySelector('.inferno-setup__command')!.getBoundingClientRect();
    const state = el.querySelector('.inferno-arena-summary__state')!.getBoundingClientRect();
    const label = el.querySelector('.inferno-setup__title')!.getBoundingClientRect();
    const arena = el.querySelector('.inferno-arena-summary__label')!.getBoundingClientRect();
    const shortcuts = el.querySelector('.inferno-setup__shortcuts-toggle')!.getBoundingClientRect();
    const composition = el.querySelector('.inferno-setup__spawns')!.getBoundingClientRect();
    return (
      Math.abs(value.left - state.left) < 1 &&
      Math.abs(label.left - arena.left) < 1 &&
      Math.abs(shortcuts.left - label.left) < 1 &&
      Math.abs(shortcuts.height - 44) < 0.5 &&
      Math.abs(el.querySelector('.inferno-arena-summary')!.getBoundingClientRect().height - 44) < 0.5 &&
      Math.abs(composition.left - label.left) < 1
    );
  });
  if (!form) failures.push(`${name}: wave, Arena, shortcuts or composition alignment differs`);
  const beforeOpen = await summary.boundingBox();
  await summary.click();
  const afterOpen = await summary.boundingBox();
  if (beforeOpen && afterOpen && Math.abs(beforeOpen.y - afterOpen.y) > 0.5)
    failures.push(`${name}: opening moved Arena row`);
  if (c.name === 'desktop') {
    const captionVisible = await page.locator('.inferno-arena__caption').evaluate((el) => {
      const r = el.getBoundingClientRect();
      const rail = el.closest('.encounter-panel-rail')!.getBoundingClientRect();
      return r.top >= rail.top && r.bottom <= rail.bottom;
    });
    if (!captionVisible) failures.push(`${name}: initial rail caption below fold`);
  }
  await capture(page, `${name}-expanded-top`);
  await openEditor(page, c, 52);
  await checkEditorEdge(page, name);
  await capture(page, name);
  await measureMap(page, name);
  await checkSharing(page, name, true);
  await checkContainer(page, name, true);
}

/**
 * Arm each kind's chip (none placed yet) and place one on its spot, as a player does, leaving no chip
 * armed (a kind with more to place stays armed until pressed again).
 */
async function placeFirstOfEach(page: Page, placements: readonly (readonly [string, number])[]) {
  for (const [kind, index] of placements) {
    await page.getByRole('button', { name: new RegExp(`^${kind} 0/\\d$`) }).click();
    await page.locator(`[data-spawn-slot="${index}"]`).click();
    const chip = page.getByRole('button', { name: new RegExp(`^${kind} 1/\\d$`) });
    if ((await chip.getAttribute('aria-pressed')) === 'true') await chip.click();
  }
  await summaryState(page)
    .getByText(/^Custom, rest random/)
    .waitFor();
}

/** A partial layout: one more real placement completes it without moving the rail or its footer. */
async function railPartial(page: Page, c: Case) {
  const name = `${c.name}-partial`;
  await setWave(page, c, '52');
  const collapsed = await editorGeometry(page);
  await openEditor(page, c, 52);
  await placeFirstOfEach(page, PARTIAL_52);
  await capture(page, name);
  await measureMap(page, name);
  const partial = await editorGeometry(page);
  await page.getByRole('button', { name: 'Bat 1/2', exact: true }).click();
  await page.locator('[data-spawn-slot="8"]').click();
  await summaryState(page).getByText('Custom', { exact: true }).waitFor();
  checkStable(name, 'partial→complete', await editorGeometry(page), { widthOf: collapsed, topsOf: partial });
  await capture(page, `${c.name}-custom`);
  await measureMap(page, `${c.name}-custom`);
  await checkContainer(page, `${c.name}-custom`, true);
  await page.locator('.inferno-arena-summary').click();
  await capture(page, `${c.name}-custom-collapsed`);
}

/** Empty wave 62 (all five kinds): chip row, real adjacent-target arbitration, a pillar down. */
async function checkWave62(page: Page, c: Case) {
  const name = `${c.name}-wave62`;
  if (c.rail) {
    await setWave(page, c, '62');
    await openEditor(page, c, 62);
  } else {
    // The workbench opens on the spawned wave 52; typing 62 gives an empty draft.
    await openEditor(page, c, 52);
    const seeded = await editorGeometry(page);
    await setWave(page, c, '62');
    checkStable(name, 'wave 62', await editorGeometry(page), { widthOf: seeded, topsOf: seeded });
  }
  await checkFiveKindRow(page, name);
  await capture(page, name);
  await measureMap(page, name);
  await checkAdjacentTargets(page, name);
  await page.getByRole('button', { name: 'West pillar', exact: true }).click();
  await capture(page, `${c.name}-pillar-down`);
  await measureMap(page, `${c.name}-pillar-down`);
}

/**
 * Populated wave 62: the rail's longest summary (pillars and start set by real clicks) or
 * Practice's workbench seeded with the spawned placements; then the bat spot's full hit target.
 */
async function checkPlaced(page: Page, c: Case) {
  const name = `${c.name}-wave62-placed`;
  if (c.rail) {
    await setWave(page, c, '62');
    const collapsed = await editorGeometry(page);
    await openEditor(page, c, 62);
    const opened = await editorGeometry(page);
    await placeFirstOfEach(page, PARTIAL_62);
    for (const pillar of ['West', 'South', 'North-east'])
      await page.getByRole('button', { name: `${pillar} pillar`, exact: true }).click();
    await clickTile(page, MOVED_START);
    if ((await summaryState(page).textContent())?.trim() !== LONGEST_SUMMARY)
      failures.push(`${name}: worst-case summary missing`);
    checkStable(name, 'longest summary', await editorGeometry(page), { widthOf: collapsed, topsOf: opened });
    const row = await page.locator('.inferno-arena-summary').boundingBox();
    if (!row || Math.abs(row.height - 44) > 0.5) failures.push(`${name}: longest summary wraps its 44px row`);
  } else {
    await openEditor(page, c, 62);
    await checkSeeded(page, name, '62');
    const tool = await editorGeometry(page);
    if (tool.overflowing.length) failures.push(`${name}: overflows: ${tool.overflowing.join(', ')}`);
  }
  await checkFiveKindRow(page, name);
  await capture(page, name);
  await measureMap(page, name);
  await checkContainer(page, name, c.rail);
  await checkBatSpot(page, name);
  if (c.rail) {
    await scrollRailToTop(page);
    await capture(page, `${name}-top`);
  }
}

/** Rail wave changes from wave 1's one content-sized chip, to Jad's former-pillar floor, to Zuk. */
async function railWaves(page: Page, c: Case) {
  await setWave(page, c, '1');
  await openEditor(page, c, 1);
  const contentSized = await page
    .locator('.spawn-progress')
    .evaluate(
      (row) => row.querySelector('button')!.getBoundingClientRect().width < row.getBoundingClientRect().width / 2,
    );
  if (!contentSized) failures.push(`${c.name}-wave1: single chip stretched`);
  await capture(page, `${c.name}-wave1`);

  await setWave(page, c, '67');
  await page.locator('.spawn-map').scrollIntoViewIfNeeded();
  // The west pillar's center tile: only floor on the Jad waves, where pillars are gone.
  const tile = [INFERNO_PILLARS[0].position[0] + 1, INFERNO_PILLARS[0].position[1] + 1] as const;
  await clickTile(page, tile);
  const label = await page.locator('.spawn-map__player').getAttribute('aria-label');
  if (!label?.startsWith(`Your start: ${tile[0]}, ${tile[1]}.`))
    failures.push(`${c.name}-wave67: former pillar floor did not move You (${label})`);
  await capture(page, `${c.name}-wave67-floor`);
  await measureMap(page, `${c.name}-wave67-floor`);

  await setWave(page, c, '69');
  const entry = page.locator('.inferno-arena-summary');
  if (!(await entry.isDisabled()) && (await entry.getAttribute('aria-disabled')) !== 'true')
    failures.push(`${c.name}: Zuk Layout still editable`);
  if (await page.locator('.spawn-map:visible').count()) failures.push(`${c.name}: Zuk still shows an editor`);
  await summaryState(page).getByText('Fixed', { exact: true }).waitFor();
  await scrollRailToTop(page);
  await capture(page, `${c.name}-zuk-disabled`);
}

/** Practice's wave command fits its pane; the workbench seeds from the spawned wave and fits. */
async function practice(page: Page, c: Case) {
  if (c.layout === 'mobile') await page.getByRole('button', { name: 'Start wave', exact: true }).click();
  await page.getByLabel('Start wave', { exact: true }).fill('35');
  await page.getByLabel('Start wave', { exact: true }).blur();
  // Touch gets 44px targets; a mouse gets the pane's own 28px row, never the touch size.
  const command = await page.locator('.inferno-setup__command').evaluate((el, touch) => {
    const problems: string[] = [];
    for (const node of el.querySelectorAll<HTMLElement>(
      touch ? '.num-input__field,.inferno-setup__go' : '.num-input,.inferno-setup__go',
    )) {
      const b = node.getBoundingClientRect();
      if (touch && (b.width < 44 || b.height < 44)) problems.push('small wave/Go touch target');
      if (!touch && Math.abs(b.height - 28) > 0.5) problems.push(`wave/Go ${b.height}px tall, not the pane's 28px row`);
      if (!node.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)))
        problems.push('wave/Go obscured');
    }
    // The compact pair leaves Fixed 1×'s 138px column room for the mouse steppers.
    const arrows = el.querySelector('.num-input__arrows')?.getBoundingClientRect();
    if (!touch && !arrows?.width) problems.push('mouse steppers hidden');
    return { width: el.getBoundingClientRect().width, problems };
  }, c.touch);
  failures.push(...command.problems.map((p) => `${c.name}: ${p}`));
  await capture(page, `${c.name}-practice`);
  if (c.layout === 'mobile') {
    await page.getByRole('button', { name: 'Back to Practice', exact: true }).click();
    await capture(page, `${c.name}-tools-entry`);
  }
  await openEditor(page, c, 52);
  await checkSeeded(page, c.name, '35');
  await capture(page, `${c.name}-arena`);
  await measureMap(page, `${c.name}-arena`);
  await checkSharing(page, c.name, false);
  await checkContainer(page, `${c.name}-arena`, false);
}

const SCENARIOS: Record<
  Scenario,
  {
    /**
     * Practice only, saved over the base setup. The configurer opens on the saved setup, so rail
     * scenarios keep the bare base (no layout, pillars standing) and type the wave they need.
     */
    inferno?: Record<string, string | boolean>;
    check: (page: Page, c: Case) => Promise<void>;
  }
> = {
  setup: { check: railSetup },
  partial: { check: railPartial },
  wave62: { check: checkWave62 },
  placed: { inferno: PLACED_62_SETUP, check: checkPlaced },
  waves: { check: railWaves },
  practice: { check: practice },
};

/** One page load: state is saved before navigation; nothing is arranged or advanced afterwards. */
async function runScenario(browser: Browser, c: Case, scenario: Scenario) {
  const { inferno, check } = SCENARIOS[scenario];
  // An explicit start wave on every load: never the setup's default or anything a run remembered.
  const settings = { infernoStartWave: '52', infiniteHealth: true, ...(c.rail ? {} : inferno) };
  const context = await browser.newContext({ viewport: { width: c.width, height: c.height }, hasTouch: c.touch });
  try {
    // tsx preserves helper names in evaluate callbacks; the browser does not load its wrapper.
    await context.addInitScript('globalThis.__name = (fn) => fn;');
    await context.addInitScript(
      ({ layout, settings }) => {
        localStorage.setItem(
          'ui-harness:osrs-yama-settings',
          JSON.stringify({
            clientLayoutMode: layout,
            fixedLayoutScale: 1,
            hideMobileWarning: true,
            mechanicsConfigPerEncounter: { inferno: settings },
          }),
        );
      },
      { layout: c.layout, settings },
    );
    const page = await context.newPage();
    await page.goto(
      `${base}/ui-harness.html?encounter=${c.rail ? 'lobby' : 'inferno'}&ticks=${c.rail ? 0 : 12}&chrome=0&open=${c.rail ? 'encounter-panel:inferno' : c.layout === 'mobile' ? 'mobile' : 'practice'}`,
    );
    await page.waitForFunction(() => document.body.dataset.harnessReady === 'true');
    const portraitInvite = page.getByRole('button', { name: 'Look around', exact: true });
    if (await portraitInvite.isVisible()) await portraitInvite.click();
    if (c.layout === 'mobile') {
      const dismiss = page.getByRole('button', { name: 'Not now', exact: true });
      if (await dismiss.isVisible()) await dismiss.click();
      await page.getByRole('button', { name: 'Open tools', exact: true }).click();
      const back = page.getByRole('button', { name: 'Back to Practice', exact: true });
      if (await back.isVisible()) await back.click();
    }
    await check(page, c);
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      failures.push(`${c.name}-${scenario}: page overflows horizontally`);
  } finally {
    await context.close();
  }
}

// Playwright adds --no-sandbox unless told otherwise; keep Chrome's sandbox on.
const browser = await chromium.launch({ headless: true, chromiumSandbox: true }).catch((error: unknown) => {
  throw new Error(
    `Could not launch Playwright's Chromium with its sandbox on (this check never disables it): ${error instanceof Error ? error.message : String(error)}\n` +
      'Install it with `npx playwright install chromium`. If the sandbox is the problem, do not run as root, and on ' +
      'Ubuntu 23.10+ allow unprivileged user namespaces for it with an AppArmor profile.',
  );
});
try {
  for (const c of cases) for (const scenario of c.run) await runScenario(browser, c, scenario);
} finally {
  await browser.close();
}
await writeFile(resolve(output, 'failures.json'), JSON.stringify(failures, null, 2));
await writeFile(resolve(output, 'footer-geometry.json'), JSON.stringify(footerEvidence, null, 2));
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `PASS: ${cases.map((c) => `${c.name} (${c.run.join(', ')})`).join('; ')}. Map/tile geometry, containment, footer stability, chips, real-pointer targets.`,
  );
