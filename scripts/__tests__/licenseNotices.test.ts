import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLicenseNotices,
  collectPackageNotices,
  IncompleteLicenseTextError,
  MissingLicenseError,
  NOTICES_FILE_NAME,
  renderLicenseNotices,
} from '../licenseNotices';
import { RestrictiveLicenseError } from '../licensePolicy';
import { VENDORED_NOTICES } from '../vendoredNotices';

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'scimgg-license-notices-'));
  temporaryDirectories.push(directory);
  return directory;
}

interface FixturePackage {
  readonly name: string;
  readonly version?: string;
  readonly license?: string;
  readonly licenseText?: string;
  readonly dependencies?: Record<string, string>;
}

function createFixtureTree(root: FixturePackage & { readonly devDependencies?: Record<string, string> }): string {
  const directory = createTemporaryDirectory();
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: root.name,
      version: root.version ?? '1.0.0',
      dependencies: root.dependencies ?? {},
      devDependencies: root.devDependencies ?? {},
    }),
  );
  return directory;
}

function addFixturePackage(rootDirectory: string, pkg: FixturePackage): void {
  const directory = join(rootDirectory, 'node_modules', pkg.name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: pkg.name,
      version: pkg.version ?? '1.0.0',
      ...(pkg.license === undefined ? {} : { license: pkg.license }),
      dependencies: pkg.dependencies ?? {},
    }),
  );
  if (pkg.licenseText !== undefined) writeFileSync(join(directory, 'LICENSE'), pkg.licenseText);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('collectPackageNotices', () => {
  it('reproduces each dependency license file verbatim', () => {
    const root = createFixtureTree({ name: 'app', dependencies: { alpha: '^1.0.0' } });
    addFixturePackage(root, { name: 'alpha', license: 'MIT', licenseText: 'MIT License\n\nCopyright (c) Alpha' });

    const [notice] = collectPackageNotices(root);

    expect(notice).toMatchObject({ name: 'alpha', version: '1.0.0', license: 'MIT' });
    expect(notice?.text).toBe('MIT License\n\nCopyright (c) Alpha');
  });

  it('follows transitive dependencies, which carry the same obligations', () => {
    const root = createFixtureTree({ name: 'app', dependencies: { alpha: '^1.0.0' } });
    addFixturePackage(root, { name: 'alpha', license: 'MIT', licenseText: 'a', dependencies: { beta: '^1.0.0' } });
    addFixturePackage(root, { name: 'beta', license: 'ISC', licenseText: 'b' });

    expect(collectPackageNotices(root).map((notice) => notice.name)).toEqual(['alpha', 'beta']);
  });

  it('omits devDependencies, which are never redistributed', () => {
    const root = createFixtureTree({ name: 'app', dependencies: {}, devDependencies: { tooling: '^1.0.0' } });
    addFixturePackage(root, { name: 'tooling', license: 'GPL-3.0-only', licenseText: 'gpl' });

    expect(collectPackageNotices(root)).toEqual([]);
  });

  it('records which half of a dual license we elected', () => {
    const root = createFixtureTree({ name: 'app', dependencies: { jszip: '^3.0.0' } });
    addFixturePackage(root, { name: 'jszip', license: '(MIT OR GPL-3.0-or-later)', licenseText: 'dual' });

    expect(collectPackageNotices(root)[0]?.license).toBe('MIT (elected from "(MIT OR GPL-3.0-or-later)")');
  });

  it('reports a declared license that ships no file rather than inventing one', () => {
    const root = createFixtureTree({ name: 'app', dependencies: { alpha: '^1.0.0' } });
    addFixturePackage(root, { name: 'alpha', license: 'MIT' });

    const rendered = renderLicenseNotices(collectPackageNotices(root), []);

    expect(rendered).toContain('distributes no license file');
    expect(rendered).not.toContain('Permission is hereby granted');
  });

  it('fails the build on a dependency with no license at all', () => {
    const root = createFixtureTree({ name: 'app', dependencies: { mystery: '^1.0.0' } });
    addFixturePackage(root, { name: 'mystery' });

    expect(() => collectPackageNotices(root)).toThrow(MissingLicenseError);
    expect(() => collectPackageNotices(root)).toThrow('mystery@1.0.0');
  });

  it('halts when an AND compound reproduces only one of its licenses', () => {
    const root = createFixtureTree({ name: 'app', dependencies: { half: '^1.0.0' } });
    addFixturePackage(root, {
      name: 'half',
      license: '(MIT AND Zlib)',
      licenseText: 'Permission is hereby granted, free of charge, to any person obtaining a copy',
    });

    expect(() => collectPackageNotices(root)).toThrow(IncompleteLicenseTextError);
    expect(() => collectPackageNotices(root)).toThrow('ships no Zlib text');
  });

  it('accepts an AND compound that reproduces every license', () => {
    const root = createFixtureTree({ name: 'app', dependencies: { whole: '^1.0.0' } });
    addFixturePackage(root, {
      name: 'whole',
      license: '(MIT AND Zlib)',
      licenseText:
        'Permission is hereby granted, free of charge, to any person obtaining a copy\n\n' +
        'Permission is granted to anyone to use this software for any purpose',
    });

    expect(() => collectPackageNotices(root)).not.toThrow();
  });

  it('does not report missing text for an AND conjunct it has no way to verify', () => {
    const root = createFixtureTree({ name: 'app', dependencies: { exotic: '^1.0.0' } });
    addFixturePackage(root, {
      name: 'exotic',
      license: '(MIT AND 0BSD)',
      licenseText: 'Permission is hereby granted, free of charge, to any person obtaining a copy',
    });

    expect(() => collectPackageNotices(root)).not.toThrow();
  });

  it('halts on a declared license the policy does not recognize', () => {
    const root = createFixtureTree({ name: 'app', dependencies: { exotic: '^1.0.0' } });
    addFixturePackage(root, { name: 'exotic', license: 'APSL-2.0', licenseText: 'Apple Public Source License' });

    expect(() => collectPackageNotices(root)).toThrow(RestrictiveLicenseError);
    expect(() => collectPackageNotices(root)).toThrow('exotic is "APSL-2.0" [review]');
  });

  // Exercised through pako because EXTRA_LICENSE_FILES is keyed by package name.
  it('halts when a package stops shipping the supplementary license file', () => {
    const root = createFixtureTree({ name: 'app', dependencies: { pako: '^2.0.0' } });
    addFixturePackage(root, { name: 'pako', license: '(MIT AND Zlib)', licenseText: 'mit only' });

    expect(() => collectPackageNotices(root)).toThrow('no longer ships "lib/zlib/README"');
  });

  it('reproduces both halves of pako, whose root LICENSE holds only the MIT one', () => {
    const pako = collectPackageNotices(process.cwd()).find((notice) => notice.name === 'pako');

    expect(pako?.license).toBe('(MIT AND Zlib)');
    expect(pako?.text).toMatch(/Permission is hereby granted, free of charge/);
    expect(pako?.text).toMatch(/Jean-loup Gailly and Mark Adler/);
  });

  it('halts on a package whose only license evidence is GPL text', () => {
    const root = createFixtureTree({ name: 'app', dependencies: { silent: '^1.0.0' } });
    addFixturePackage(root, {
      name: 'silent',
      licenseText: 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007',
    });

    expect(() => collectPackageNotices(root)).toThrow(RestrictiveLicenseError);
  });

  // Only restrictive licenses are inferred from text, so an undeclared package whose text the gate
  // cannot classify goes to review instead of passing unread.
  it('sends a package with no declaration and unrecognized license text to review', () => {
    const root = createFixtureTree({ name: 'app', dependencies: { quiet: '^1.0.0' } });
    addFixturePackage(root, { name: 'quiet', licenseText: 'You may use this however the author feels like.' });

    expect(() => collectPackageNotices(root)).toThrow(RestrictiveLicenseError);
    expect(() => collectPackageNotices(root)).toThrow('quiet is "NOASSERTION" [review]');
  });

  it('sends a package with no declaration but a README license section to review', () => {
    const root = createFixtureTree({ name: 'app', dependencies: { quiet: '^1.0.0' } });
    addFixturePackage(root, { name: 'quiet' });
    writeFileSync(
      join(root, 'node_modules', 'quiet', 'README.md'),
      '# quiet\n\n## License\n\nCopyright (c) 2020 Someone\n\nPermission is hereby granted, free of charge.\n',
    );

    expect(() => collectPackageNotices(root)).toThrow('quiet is "NOASSERTION" [review]');
  });

  // Exercised through jszip because LICENSE_ELECTIONS is keyed by package name.
  it('reads every license file a multi-licensed package ships', () => {
    const root = createFixtureTree({ name: 'app', dependencies: { jszip: '^3.0.0' } });
    addFixturePackage(root, { name: 'jszip', license: '(MIT OR GPL-3.0-or-later)' });
    for (const [file, text] of [
      ['LICENSE.GPL', 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007'],
      ['LICENSE.MIT', 'MIT License'],
    ]) {
      writeFileSync(join(root, 'node_modules', 'jszip', file), text);
    }
    const jszip = collectPackageNotices(root).find((notice) => notice.name === 'jszip');

    expect(jszip?.text).toMatch(/LICENSE\.GPL:/);
    expect(jszip?.text).toMatch(/LICENSE\.MIT:/);
  });

  it('halts on a choice of licenses with no recorded election', () => {
    const root = createFixtureTree({ name: 'app', dependencies: { rc: '^1.0.0' } });
    addFixturePackage(root, { name: 'rc', license: '(BSD-2-Clause OR MIT OR Apache-2.0)', licenseText: 'bsd' });

    expect(() => collectPackageNotices(root)).toThrow(RestrictiveLicenseError);
    expect(() => collectPackageNotices(root)).toThrow('LICENSE_ELECTIONS');
  });

  it("falls back to the README's license section when a package ships no license file", () => {
    const root = createFixtureTree({ name: 'app', dependencies: { tiny: '^1.0.0' } });
    addFixturePackage(root, { name: 'tiny', license: 'MIT' });
    writeFileSync(
      join(root, 'node_modules', 'tiny', 'README.md'),
      '# tiny\n\nUsage.\n\n## License\n\n(MIT)\n\nCopyright (c) 2013 Someone &lt;a@b.c&gt;\n\nPermission is hereby granted.\n\n## Other\n\nNot this.\n',
    );
    const tiny = collectPackageNotices(root).find((notice) => notice.name === 'tiny');

    expect(tiny?.text).toBe(
      'From README.md, "License":\n\n(MIT)\n\nCopyright (c) 2013 Someone <a@b.c>\n\nPermission is hereby granted.',
    );
  });

  it('ignores a README license section that names no copyright holder', () => {
    const root = createFixtureTree({ name: 'app', dependencies: { tiny: '^1.0.0' } });
    addFixturePackage(root, { name: 'tiny', license: 'MIT' });
    writeFileSync(join(root, 'node_modules', 'tiny', 'README.md'), '# tiny\n\n## License\n\nMIT\n');

    expect(collectPackageNotices(root)[0]?.text).toBeUndefined();
  });

  // isarray keeps its MIT notice only in its README, and links a git:// repository.
  it("reproduces isarray's README notice and links its repository over https", () => {
    const rendered = buildLicenseNotices(process.cwd());
    const isarray = rendered.slice(
      rendered.indexOf('isarray@'),
      rendered.indexOf('-'.repeat(80), rendered.indexOf('isarray@')),
    );

    expect(isarray).toContain('Copyright (c) 2013 Julian Gruber <julian@juliangruber.com>');
    expect(isarray).toContain('Source:  https://github.com/juliangruber/isarray');
    expect(isarray).not.toContain('distributes no license file');
  });

  it('halts on a copyleft production dependency', () => {
    const root = createFixtureTree({ name: 'app', dependencies: { viral: '^1.0.0' } });
    addFixturePackage(root, { name: 'viral', license: 'GPL-3.0-only', licenseText: 'gpl' });

    expect(() => collectPackageNotices(root)).toThrow(RestrictiveLicenseError);
  });

  it('halts on a copyleft package pulled in transitively', () => {
    const root = createFixtureTree({ name: 'app', dependencies: { alpha: '^1.0.0' } });
    addFixturePackage(root, { name: 'alpha', license: 'MIT', licenseText: 'a', dependencies: { viral: '^1.0.0' } });
    addFixturePackage(root, { name: 'viral', license: 'AGPL-3.0', licenseText: 'agpl' });

    expect(() => collectPackageNotices(root)).toThrow('AGPL');
  });

  it('has no unlicensed or restrictively licensed dependency in this repository', () => {
    expect(() => collectPackageNotices(process.cwd())).not.toThrow();
  });
});

describe('renderLicenseNotices', () => {
  it('halts on a copyleft hand-port, which no dependency walk would catch', () => {
    expect(() =>
      renderLicenseNotices(
        [],
        [{ component: 'some-gpl-port', source: 'https://example.com', license: 'GPL-3.0', applies: [], text: 'gpl' }],
      ),
    ).toThrow(RestrictiveLicenseError);
  });

  it('reproduces every vendored license verbatim', () => {
    const rendered = renderLicenseNotices([], VENDORED_NOTICES);

    for (const notice of VENDORED_NOTICES) {
      expect(rendered).toContain(notice.text);
      expect(rendered).toContain(notice.component);
    }
  });

  it('attributes the hand-ported upstreams that no manifest records', () => {
    const rendered = buildLicenseNotices(process.cwd());

    expect(rendered).toContain('Copyright (c) 2025 RS Mod');
    expect(rendered).toContain('Copyright (c) 2022-2023, dennisdev');
    expect(rendered).toContain('Copyright (c) 2016-2017, Adam <Adam@sigterm.info>');
    expect(rendered).toContain('Copyright (c) 2021, geheur');
    expect(rendered).toContain('Copyright (c) 2021, Matsyir');
    expect(rendered).toContain('Copyright (c) 2022, TrevorMDev');
    expect(rendered).toContain('Copyright (c) 2024 Jamie Young');
    // Compact Orbs: its source files' header, then its repository LICENSE, which name the holder differently.
    expect(rendered).toContain('Copyright (c) 2025, cue <https://github.com/its-cue>\nAll rights reserved.');
    expect(rendered).toContain('BSD 2-Clause License\n\nCopyright (c) 2025, its-cue\n');
    expect(rendered).toContain('copyright (C) 1996-2010 Julian R Seward');
  });

  // The committed bzip2.wasm and its loader carry more than libbzip2: Foxglove's wrapper, the
  // Emscripten runtime and the musl and LLVM libraries it links.
  it('attributes everything compiled into the committed bzip2 binaries', () => {
    const rendered = renderLicenseNotices([], VENDORED_NOTICES);

    expect(rendered).toContain('Copyright (c) Foxglove Technologies Inc');
    expect(rendered).toContain('Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.');
    expect(rendered).toContain('License: MIT (elected from "MIT OR NCSA")');
    expect(rendered).toContain('Copyright © 2005-2020 Rich Felker, et al.');
    expect(rendered).toContain('---- LLVM Exceptions to the Apache 2.0 License ----');
    expect(rendered).toContain('Copyright (c) 2009-2019 by the contributors listed in CREDITS.TXT');
  });

  // That attribution is for @foxglove/wasm-bz2 0.3.0's build, so the version is locked and the
  // committed binaries must stay its wasm/module.wasm and wasm/module.js. Changing either is
  // deliberate: update the version, the lockfile, the binaries and these hashes together.
  it('ships bzip2 binaries identical to the locked @foxglove/wasm-bz2 0.3.0', () => {
    const root = process.cwd();
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    const lockfile = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf-8'));
    const installedManifestPath = createRequire(import.meta.url).resolve('@foxglove/wasm-bz2/package.json');
    const installed = JSON.parse(readFileSync(installedManifestPath, 'utf-8'));
    const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

    expect(manifest.dependencies['@foxglove/wasm-bz2']).toBe('0.3.0');
    expect(lockfile.packages['node_modules/@foxglove/wasm-bz2']).toMatchObject({
      version: '0.3.0',
      resolved: 'https://registry.npmjs.org/@foxglove/wasm-bz2/-/wasm-bz2-0.3.0.tgz',
      integrity: 'sha512-MP18X3TbeoGT3Kfke7KrYin+5zESfcPnsdD2gaVviN1xzteoDDfVTZbVmbdfGrIV/qAAhBhBVbRcrN25rWSNOQ==',
    });
    expect(installed.version).toBe('0.3.0');

    for (const [committed, built, expected] of [
      ['bzip2.wasm', 'module.wasm', 'a8a96ffc1118ed9c2adc93a8ddd4e8069c617320cd6dc141bd1029b9104265d7'],
      ['bzip2-module.js', 'module.js', '05243622b34a0fa405576c7ac686a45a86d99ca1d8d6b5d7506c08b3857d5723'],
    ]) {
      const committedBytes = readFileSync(join(root, 'public', committed));
      const builtBytes = readFileSync(join(dirname(installedManifestPath), 'wasm', built));

      expect(sha256(committedBytes), `sha256 of public/${committed}`).toBe(expected);
      expect(sha256(builtBytes), `sha256 of @foxglove/wasm-bz2/wasm/${built}`).toBe(expected);
      expect(committedBytes.equals(builtBytes), `public/${committed} equals wasm/${built}`).toBe(true);
    }
  });

  it('records the Mulberry32 public-domain dedications', () => {
    const rendered = renderLicenseNotices([], VENDORED_NOTICES);

    expect(rendered).toContain('bryc/code/blob/88c1317ea6f9b25c153afa9c369c365fed11b482/jshash/PRNGs.md');
    expect(rendered).toContain('Written in 2017 by Tommy Ettinger');
  });

  it("states Jagex's ownership of the game content and its trademarks", () => {
    const rendered = renderLicenseNotices([], VENDORED_NOTICES);

    expect(rendered).toContain('RuneScape and Old School RuneScape are trademarks of Jagex Ltd.');
    expect(rendered).toContain('art, names and text in this build belong to Jagex Ltd.');
  });

  // RuneLite's files carry their own headers, whose holders the repository LICENSE (Adam alone)
  // does not name; each ported file is attributed with its header as read at the pinned revision.
  it.each([
    ['WorldArea.java and CollisionDataFlag.java', 'Copyright (c) 2018, Woox <https://github.com/wooxsolo>'],
    ['Perspective.java and PrayerFlickOverlay.java', 'Copyright (c) 2017, Adam <Adam@sigterm.info>'],
    [
      'FacePrioritySorter.java, GpuPlugin.java, SceneUploader.java and the shaders',
      'Copyright (c) 2018, Adam <Adam@sigterm.info>',
    ],
    ['IntProjection.java', 'Copyright (c) 2024, Adam <Adam@sigterm.info>'],
    ['PrayerPlugin.java and PrayerConfig.java', 'Copyright (c) 2018, Raqes <j.raqes@gmail.com>'],
    ['CameraPlugin.java and CameraConfig.java', 'Copyright (c) 2018 Abex'],
    ['CameraPlugin.java', 'Copyright (c) 2019, Wynadorn <https://github.com/Wynadorn>'],
    ['Viewport.java (Status Bars)', 'Copyright (c) 2018, Jos <Malevolentdev@gmail.com>'],
    ['StatusBarsConfig.java', 'Copyright (c) 2019, Jos <Malevolentdev@gmail.com>'],
    [
      'StatusBarsOverlay.java and BarRenderer.java',
      'Copyright (c) 2019, Jos <Malevolentdev@gmail.com>\nCopyright (c) 2019, Rheon <https://github.com/Rheon-D>',
    ],
  ])('attributes the RuneLite file header of %s', (_files, holder) => {
    expect(buildLicenseNotices(process.cwd())).toContain(`${holder}\nAll rights reserved.`);
  });

  it('lists both holders of PrayerPlugin.java together, as its header does', () => {
    expect(buildLicenseNotices(process.cwd())).toContain(
      'Copyright (c) 2017, Adam <Adam@sigterm.info>\nCopyright (c) 2018, Raqes <j.raqes@gmail.com>\nAll rights reserved.',
    );
  });

  // A fork that distributes only the build has no other copy of the MIT notice.
  it("leads with this project's own LICENSE, verbatim", () => {
    const rendered = buildLicenseNotices(process.cwd());
    const projectLicense = readFileSync(join(process.cwd(), 'LICENSE'), 'utf-8').trim();

    expect(projectLicense).toContain('Copyright (c) 2026 Scim.GG contributors');
    expect(rendered).toContain(projectLicense);
    expect(rendered.indexOf(projectLicense)).toBeLessThan(rendered.indexOf('PORTED AND VENDORED MATERIAL'));
  });

  it('fails the build when the project has no LICENSE to ship', () => {
    const root = createFixtureTree({ name: 'app', dependencies: {} });

    expect(() => buildLicenseNotices(root)).toThrow('No LICENSE');

    writeFileSync(join(root, 'LICENSE'), 'MIT License\n\nCopyright (c) Fixture');
    expect(buildLicenseNotices(root)).toContain('Copyright (c) Fixture');
  });

  it('discloses none of our own paths, which no license asks a redistributor to identify', () => {
    // Upstream license texts name upstream's own trees (Emscripten's and musl's `src/`), so only what
    // this project wrote around them is checked.
    const ours = VENDORED_NOTICES.reduce(
      (rendered, notice) => rendered.replace(notice.text, ''),
      renderLicenseNotices([], VENDORED_NOTICES),
    );

    expect(ours).not.toContain('src/');
    expect(ours).not.toContain('public/');
  });

  it('identifies the wiki-derived datasets, which CC BY-NC-SA 3.0 §4(c) requires', () => {
    const rendered = renderLicenseNotices([], VENDORED_NOTICES);

    expect(rendered).toContain('Old School RuneScape Wiki datasets');
    expect(rendered).toContain('reproduced with modifications');
  });

  it('reproduces the licenses of packages that ship in the browser bundle', () => {
    const rendered = buildLicenseNotices(process.cwd());

    for (const name of ['react@', 'picogl@', 'gl-matrix@', 'pako@', 'zod@']) {
      expect(rendered).toContain(name);
    }
  });

  it('is deterministic, so a rebuild produces no spurious diff', () => {
    expect(buildLicenseNotices(process.cwd())).toBe(buildLicenseNotices(process.cwd()));
  });
});

describe('NOTICES_FILE_NAME', () => {
  it('is not a .js file, which the build would reject for containing comments', () => {
    expect(NOTICES_FILE_NAME.endsWith('.js')).toBe(false);
  });
});
