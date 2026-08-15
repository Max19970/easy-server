import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

export interface InstalledProviderPluginCandidate {
  readonly source: string;
  readonly displayName: string;
  readonly description?: string;
}

interface EasyServerPackageMetadata {
  readonly kind?: unknown;
  readonly displayName?: unknown;
}

interface PackageMetadata {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly easyserver?: EasyServerPackageMetadata;
}

const moduleRequire = createRequire(import.meta.url);

export async function discoverInstalledProviderPlugins(
  searchPaths: readonly string[] = defaultModuleSearchPaths(),
): Promise<readonly InstalledProviderPluginCandidate[]> {
  const candidates = new Map<string, InstalledProviderPluginCandidate>();

  for (const root of unique(searchPaths)) {
    for (const packageSlot of await packageDirectories(root)) {
      const metadata = await readPackageMetadata(packageSlot.path);
      const candidate = providerCandidate(metadata, packageSlot.source);
      if (candidate !== undefined && !candidates.has(candidate.source)) {
        candidates.set(candidate.source, candidate);
      }
    }
  }

  return [...candidates.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

function defaultModuleSearchPaths(): readonly string[] {
  return moduleRequire.resolve.paths("easyserver-provider-discovery") ?? [];
}

interface PackageSlot {
  readonly path: string;
  readonly source: string;
}

async function packageDirectories(root: string): Promise<readonly PackageSlot[]> {
  const entries = await safeReadDirectory(root);
  const directories: PackageSlot[] = [];

  for (const entry of entries) {
    if (!isDirectoryLike(entry)) {
      continue;
    }
    const path = join(root, entry.name);
    if (!entry.name.startsWith("@")) {
      directories.push({ path, source: entry.name });
      continue;
    }
    for (const scoped of await safeReadDirectory(path)) {
      if (isDirectoryLike(scoped)) {
        directories.push({
          path: join(path, scoped.name),
          source: `${entry.name}/${scoped.name}`,
        });
      }
    }
  }

  return directories;
}

async function safeReadDirectory(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readPackageMetadata(
  packageDirectory: string,
): Promise<PackageMetadata | undefined> {
  try {
    return JSON.parse(
      await readFile(join(packageDirectory, "package.json"), "utf8"),
    ) as PackageMetadata;
  } catch {
    return undefined;
  }
}

function providerCandidate(
  metadata: PackageMetadata | undefined,
  source: string,
): InstalledProviderPluginCandidate | undefined {
  if (
    metadata?.easyserver?.kind !== "provider-plugin" ||
    metadata.name !== source ||
    typeof metadata.easyserver.displayName !== "string" ||
    metadata.easyserver.displayName.trim().length === 0
  ) {
    return undefined;
  }

  return {
    source,
    displayName: metadata.easyserver.displayName.trim(),
    ...(typeof metadata.description === "string" && metadata.description.trim().length > 0
      ? { description: metadata.description.trim() }
      : {}),
  };
}

function isDirectoryLike(entry: { isDirectory(): boolean; isSymbolicLink(): boolean }): boolean {
  return entry.isDirectory() || entry.isSymbolicLink();
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
