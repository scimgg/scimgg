import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findLockfileProblems, LOCKFILE_VERSION, registryTarballUrl } from '../lockfileSources.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const readJson = (name: string) => JSON.parse(readFileSync(resolve(ROOT, name), 'utf8'));

const INTEGRITY = `sha512-${'A'.repeat(86)}==`;

const registryEntry = (name: string, version: string) => ({
  version,
  resolved: registryTarballUrl(name, version),
  integrity: INTEGRITY,
});

/** A minimal valid lockfile, with `entries` merged over its packages. */
function lockfileWith(entries: Record<string, unknown> = {}, root: Record<string, unknown> = {}) {
  return {
    name: 'demo',
    lockfileVersion: LOCKFILE_VERSION,
    requires: true,
    packages: {
      '': { name: 'demo', version: '1.0.0', dependencies: { 'left-pad': '^1.3.0' }, ...root },
      'node_modules/left-pad': registryEntry('left-pad', '1.3.0'),
      'node_modules/@scope/tool': registryEntry('@scope/tool', '2.0.0-beta.1'),
      'node_modules/@scope/tool/node_modules/left-pad': registryEntry('left-pad', '1.1.0'),
      ...entries,
    },
  };
}

const problemsOf = (lockfile: unknown) => findLockfileProblems(lockfile, { name: 'demo' });

describe('findLockfileProblems', () => {
  it('passes the repository lockfile', () => {
    expect(findLockfileProblems(readJson('package-lock.json'), readJson('package.json'))).toEqual([]);
  });

  it('passes registry entries, scoped and nested ones included', () => {
    expect(problemsOf(lockfileWith())).toEqual([]);
  });

  it('passes an npm: alias that a package declares', () => {
    const lockfile = lockfileWith(
      { 'node_modules/pad-cjs': { name: 'left-pad', ...registryEntry('left-pad', '1.0.0') } },
      { dependencies: { 'pad-cjs': 'npm:left-pad@^1.0.0' } },
    );
    expect(problemsOf(lockfile)).toEqual([]);
  });

  it.each([
    ['another host', { resolved: 'https://registry.example.com/evil/-/evil-1.0.0.tgz' }, 'not the npm registry'],
    [
      'a host that merely starts like the registry',
      { resolved: 'https://registry.npmjs.org.example.com/evil.tgz' },
      'not the npm registry',
    ],
    ['plain http', { resolved: 'http://registry.npmjs.org/evil/-/evil-1.0.0.tgz' }, 'not the npm registry'],
    ['git+https', { resolved: 'git+https://github.com/example/evil.git#0123456789abcdef' }, 'not the npm registry'],
    ['git+ssh', { resolved: 'git+ssh://git@github.com/example/evil.git#0123456789abcdef' }, 'not the npm registry'],
    ['file:', { resolved: 'file:../evil-1.0.0.tgz' }, 'not the npm registry'],
    ['link:', { resolved: 'link:../evil' }, 'not the npm registry'],
    ['no resolved', { resolved: undefined }, 'has no "resolved" URL'],
    ['no integrity', { integrity: undefined }, 'has no "integrity" hash'],
    ['a sha1 integrity', { integrity: 'sha1-2jmIkzUeufy1l2E+2stcyfgaLkU=' }, 'not a single sha512 hash'],
    [
      'a sha512 hash alongside a sha1 one',
      { integrity: `${INTEGRITY} sha1-2jmIkzUeufy1l2E+2stcyfgaLkU=` },
      'not a single sha512 hash',
    ],
    ['another package tarball', { resolved: registryTarballUrl('evil', '1.0.0') }, 'left-pad@1.3.0 is published at'],
    [
      'another version tarball',
      { resolved: registryTarballUrl('left-pad', '1.0.0') },
      'left-pad@1.3.0 is published at',
    ],
    ['a version that walks the registry path', { version: '1.3.0/../../evil' }, 'not a published registry version'],
    ['a git version', { version: 'git+https://github.com/example/evil.git' }, 'not a published registry version'],
    ['an alias name that walks the registry path', { name: '../evil' }, 'has an invalid package name'],
    ['an undeclared alias', { name: 'evil', resolved: registryTarballUrl('evil', '1.3.0') }, 'no package declares'],
  ])('rejects %s', (_label, override, reason) => {
    const lockfile = lockfileWith({
      'node_modules/left-pad': { ...registryEntry('left-pad', '1.3.0'), ...override },
    });
    const problems = problemsOf(lockfile);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^node_modules\/left-pad: /);
    expect(problems[0]).toContain(reason);
  });

  it('rejects a scoped package pointed at another scope', () => {
    const problems = problemsOf(
      lockfileWith({
        'node_modules/@scope/tool': {
          ...registryEntry('@scope/tool', '2.0.0-beta.1'),
          resolved: registryTarballUrl('@other/tool', '2.0.0-beta.1'),
        },
      }),
    );
    expect(problems).toEqual([expect.stringMatching(/^node_modules\/@scope\/tool: .*@scope\/tool@2\.0\.0-beta\.1/)]);
  });

  it('rejects linked, workspace and local-folder entries', () => {
    const problems = problemsOf(
      lockfileWith({
        'node_modules/local-lib': { resolved: 'packages/local-lib', link: true },
        'packages/local-lib': { name: 'local-lib', version: '1.0.0' },
      }),
    );
    expect(problems).toEqual([
      expect.stringMatching(/^node_modules\/local-lib: is a link to a local folder/),
      expect.stringMatching(/^packages\/local-lib: is not an installed package under node_modules/),
    ]);
  });

  it('names every offending entry', () => {
    const problems = problemsOf(
      lockfileWith({
        'node_modules/left-pad': { ...registryEntry('left-pad', '1.3.0'), integrity: undefined },
        'node_modules/@scope/tool/node_modules/left-pad': { version: '1.1.0', resolved: 'file:vendor/left-pad' },
      }),
    );
    expect(problems).toEqual([
      expect.stringMatching(/^node_modules\/left-pad: has no "integrity"/),
      expect.stringMatching(/^node_modules\/@scope\/tool\/node_modules\/left-pad: resolves to "file:/),
      expect.stringMatching(/^node_modules\/@scope\/tool\/node_modules\/left-pad: has no "integrity"/),
    ]);
  });

  it('rejects another lockfileVersion', () => {
    expect(problemsOf({ ...lockfileWith(), lockfileVersion: 2 })).toEqual([
      `lockfileVersion is 2; this repository uses ${LOCKFILE_VERSION}`,
    ]);
  });

  it('rejects a root entry named differently from package.json', () => {
    expect(findLockfileProblems(lockfileWith(), { name: 'other' })).toEqual([
      'root entry: is named "demo", but package.json is named "other"',
    ]);
  });
});
