// Checks that every package in package-lock.json comes from the npm registry, as the exact tarball
// its entry names, with a sha512 integrity hash.
//
// Plain JavaScript with no dependencies, so CI can run it with bare `node` before `npm ci`
// installs anything. The types are in lockfileSources.d.mts.

export const LOCKFILE_VERSION = 3;
export const REGISTRY = 'https://registry.npmjs.org/';

// Package names as the registry accepts them, legacy upper case included. A segment cannot start
// with a dot, so a name can never be `..` and walk out of its registry path.
const SEGMENT = '[A-Za-z0-9~-][A-Za-z0-9._~-]*';
const PACKAGE_NAME = `(?:@${SEGMENT}/)?${SEGMENT}`;
const PACKAGE_NAME_PATTERN = new RegExp(`^${PACKAGE_NAME}$`);
// Installed entries only. Workspace and local-folder entries (keys outside node_modules) do not match.
const INSTALL_PATH_PATTERN = new RegExp(`^node_modules/(?:${PACKAGE_NAME}/node_modules/)*(${PACKAGE_NAME})$`);
// Versions go into the expected tarball URL, so they must not carry slashes or dots that a URL
// parser would resolve.
const VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
// A single SHA-512 digest is 64 bytes, which is 86 base64 characters and two padding characters.
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** The registry tarball for a published version, e.g. `@scope/name/-/name-1.0.0.tgz`. */
export function registryTarballUrl(name, version) {
  const baseName = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
  return `${REGISTRY}${name}/-/${baseName}-${version}.tgz`;
}

/**
 * Whether any entry declares `installedName` as an `npm:` alias of `packageName`. The root entry's
 * declarations are the ones `npm ci` keeps in sync with package.json.
 */
function declaresAlias(packages, installedName, packageName) {
  return Object.values(packages).some((entry) =>
    DEPENDENCY_FIELDS.some((field) => {
      const spec = entry?.[field]?.[installedName];
      return typeof spec === 'string' && (spec === `npm:${packageName}` || spec.startsWith(`npm:${packageName}@`));
    }),
  );
}

function findEntryProblems(path, entry, packages) {
  const match = INSTALL_PATH_PATTERN.exec(path);
  if (match === null) {
    return [`${path}: is not an installed package under node_modules (workspaces and local folders are not accepted)`];
  }
  const installedName = match[1];
  if (entry === null || typeof entry !== 'object') return [`${path}: is not a package entry`];
  if (entry.link === true) return [`${path}: is a link to a local folder, not a registry package`];

  const problems = [];
  const { resolved, integrity, version } = entry;

  // An entry's own `name` is written only for an `npm:` alias: it installs `name` under the folder
  // name. It must be declared as one, or a familiar folder name could install any package.
  const packageName = entry.name ?? installedName;
  if (typeof packageName !== 'string' || !PACKAGE_NAME_PATTERN.test(packageName)) {
    problems.push(`${path}: has an invalid package name ${JSON.stringify(entry.name)}`);
  } else if (packageName !== installedName && !declaresAlias(packages, installedName, packageName)) {
    problems.push(
      `${path}: installs "${packageName}" under the name "${installedName}", but no package declares ` +
        `"${installedName}" as an alias ("npm:${packageName}@<version>")`,
    );
  }

  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    problems.push(`${path}: has version ${JSON.stringify(version)}, not a published registry version`);
  }

  if (typeof resolved !== 'string') {
    problems.push(`${path}: has no "resolved" URL, so its source cannot be checked`);
  } else if (!resolved.startsWith(REGISTRY)) {
    problems.push(`${path}: resolves to "${resolved}", not the npm registry (${REGISTRY})`);
  } else if (problems.length === 0) {
    const expected = registryTarballUrl(packageName, version);
    if (resolved !== expected) {
      problems.push(`${path}: resolves to "${resolved}", but ${packageName}@${version} is published at "${expected}"`);
    }
  }

  if (typeof integrity !== 'string') {
    problems.push(`${path}: has no "integrity" hash`);
  } else if (!SHA512_INTEGRITY_PATTERN.test(integrity)) {
    problems.push(`${path}: has integrity "${integrity}", not a single sha512 hash`);
  }

  return problems;
}

/**
 * Returns one message per problem, each naming the lockfile entry; an empty array means the
 * lockfile passes.
 */
export function findLockfileProblems(lockfile, packageJson) {
  if (lockfile?.lockfileVersion !== LOCKFILE_VERSION) {
    return [
      `lockfileVersion is ${JSON.stringify(lockfile?.lockfileVersion)}; this repository uses ${LOCKFILE_VERSION}`,
    ];
  }
  const packages = lockfile.packages;
  if (packages === null || typeof packages !== 'object') return ['the lockfile has no "packages" section'];

  const problems = [];
  // The root entry is the project itself, so it is the one entry with nothing to resolve.
  const root = packages[''];
  if (root?.name !== packageJson?.name) {
    problems.push(
      `root entry: is named ${JSON.stringify(root?.name)}, but package.json is named ${JSON.stringify(packageJson?.name)}`,
    );
  }

  for (const [path, entry] of Object.entries(packages)) {
    if (path !== '') problems.push(...findEntryProblems(path, entry, packages));
  }
  return problems;
}
