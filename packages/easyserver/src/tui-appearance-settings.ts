import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { TUI_ACCENTS, type TuiAccent } from "./tui-appearance.js";
import { TUI_DENSITIES, type TuiDensity } from "./tui-layout.js";

export interface TuiAppearancePreferences {
  readonly accent: TuiAccent;
  readonly density: TuiDensity;
}

export const DEFAULT_TUI_APPEARANCE: TuiAppearancePreferences = {
  accent: "cyan",
  density: "comfortable",
};

export interface TuiAppearanceStore {
  read(): Promise<TuiAppearancePreferences>;
  write(preferences: TuiAppearancePreferences): Promise<void>;
  reset(): Promise<void>;
}

export class JsonTuiAppearanceStore implements TuiAppearanceStore {
  constructor(readonly path: string) {}

  async read(): Promise<TuiAppearancePreferences> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return DEFAULT_TUI_APPEARANCE;
      }
      return DEFAULT_TUI_APPEARANCE;
    }

    try {
      return parseTuiAppearancePreferences(JSON.parse(text));
    } catch {
      return DEFAULT_TUI_APPEARANCE;
    }
  }

  async write(preferences: TuiAppearancePreferences): Promise<void> {
    const parsed = parseTuiAppearancePreferences({ version: 1, ...preferences });
    const directory = dirname(this.path);
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ version: 1, ...parsed }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async reset(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

export function resolveTuiAppearancePath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  if (env.EASYSERVER_APPEARANCE_FILE !== undefined) {
    return env.EASYSERVER_APPEARANCE_FILE;
  }
  if (env.EASYSERVER_STATE_FILE !== undefined) {
    return `${env.EASYSERVER_STATE_FILE}.appearance.json`;
  }
  return join(homeDirectory, ".easyserver", "appearance.json");
}

export function parseTuiAppearancePreferences(value: unknown): TuiAppearancePreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return DEFAULT_TUI_APPEARANCE;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.accent !== "string" ||
    !TUI_ACCENTS.includes(candidate.accent as TuiAccent) ||
    typeof candidate.density !== "string" ||
    !TUI_DENSITIES.includes(candidate.density as TuiDensity)
  ) {
    return DEFAULT_TUI_APPEARANCE;
  }
  return {
    accent: candidate.accent as TuiAccent,
    density: candidate.density as TuiDensity,
  };
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
