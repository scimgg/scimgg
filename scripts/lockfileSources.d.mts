export declare const LOCKFILE_VERSION: number;
export declare const REGISTRY: string;
export declare function registryTarballUrl(name: string, version: string): string;
export declare function findLockfileProblems(lockfile: unknown, packageJson: unknown): string[];
