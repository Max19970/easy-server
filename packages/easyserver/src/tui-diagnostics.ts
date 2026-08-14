import { spawnSync } from "node:child_process";
import {
  collectDiagnostics,
  type DiagnosticsReport,
} from "./diagnostics.js";
import {
  resolveHostRuntimePaths,
  type HostRuntimePaths,
} from "./host-runtime.js";

export interface TuiDiagnosticsOperations {
  load(): Promise<DiagnosticsReport>;
  copy(text: string): Promise<void>;
}

export function serializeTuiDiagnostics(report: DiagnosticsReport): string {
  return JSON.stringify(report, null, 2);
}

export function createDefaultTuiDiagnosticsOperations(
  paths: HostRuntimePaths = resolveHostRuntimePaths(),
): TuiDiagnosticsOperations {
  return {
    load: () => collectDiagnostics({
      stateFile: paths.stateFile,
      daemonFile: paths.daemonFile,
    }),
    async copy(text) {
      copyTextToClipboard(text);
    },
  };
}

export function copyTextToClipboard(
  text: string,
  platform: NodeJS.Platform = process.platform,
  run: typeof spawnSync = spawnSync,
): void {
  const candidates: readonly (readonly [string, readonly string[]])[] =
    platform === "win32"
      ? [["clip.exe", []]]
      : platform === "darwin"
        ? [["pbcopy", []]]
        : platform === "linux"
          ? [
              ["wl-copy", []],
              ["xclip", ["-selection", "clipboard"]],
              ["xsel", ["--clipboard", "--input"]],
            ]
          : [];

  for (const [command, args] of candidates) {
    const result = run(command, [...args], {
      input: text,
      encoding: "utf8",
      windowsHide: true,
      timeout: 2_000,
    });
    if (result.error === undefined && result.status === 0) {
      return;
    }
  }

  throw new Error("System clipboard integration is unavailable");
}
