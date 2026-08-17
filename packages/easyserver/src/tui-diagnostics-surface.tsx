import React from "react";
import { Box, Text } from "ink";
import type { DiagnosticsReport } from "./diagnostics.js";
import {
  tuiAppearance,
  tuiResourceColor,
} from "./tui-appearance.js";

export interface TuiDiagnosticsSummary {
  readonly version: string;
  readonly stateStatus: DiagnosticsReport["state"]["status"];
  readonly configuredPlugins: number;
  readonly failedPlugins: number;
  readonly daemonStatus: DiagnosticsReport["daemon"]["status"];
  readonly ssh: DiagnosticsReport["access"]["ssh"];
  readonly sshKeyscan: DiagnosticsReport["access"]["sshKeyscan"];
}

export type TuiDiagnosticsView =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly text: string;
      readonly summary: TuiDiagnosticsSummary;
    };

export interface DiagnosticsSurfaceProps {
  readonly diagnostics: TuiDiagnosticsView;
  readonly reportOpen: boolean;
  readonly scroll: number;
  readonly canCopy: boolean;
  readonly screenReader: boolean;
  readonly height: number;
  readonly width: number;
  readonly colorEnabled: boolean;
}

export function DiagnosticsSurface({
  diagnostics,
  reportOpen,
  scroll,
  canCopy,
  screenReader,
  height,
  width,
  colorEnabled,
}: DiagnosticsSurfaceProps): React.ReactElement {
  const appearance = tuiAppearance(colorEnabled);
  const muted = appearance.muted;
  if (diagnostics.status === "idle") {
    return (
      <Box flexDirection="column">
        <Text>Diagnostics have not been collected yet.</Text>
        <Text>Press Enter for Actions, then choose Refresh diagnostics.</Text>
      </Box>
    );
  }
  if (diagnostics.status === "loading") {
    return <Text>Collecting privacy-safe Diagnostics…</Text>;
  }
  if (diagnostics.status === "failed") {
    return (
      <Box flexDirection="column">
        <Text>{diagnostics.message}</Text>
        <Text>Use Actions to retry. Do not substitute raw logs that may contain sensitive data.</Text>
      </Box>
    );
  }

  if (reportOpen) {
    if (screenReader) {
      return (
        <Box flexDirection="column">
          <Text bold>Full privacy-safe diagnostics report</Text>
          <Text>{diagnostics.text}</Text>
          <Text>
            {canCopy ? "Enter — copy this exact report · Esc — back to summary" : "Esc — back to summary"}
          </Text>
        </Box>
      );
    }

    const lines = wrapDiagnosticsText(diagnostics.text, width);
    const visibleRows = Math.max(1, height - 3);
    const maxStart = Math.max(0, lines.length - visibleRows);
    const start = Math.min(Math.max(0, scroll), maxStart);
    const end = Math.min(lines.length, start + visibleRows);
    return (
      <Box flexDirection="column" height={height} overflowY="hidden">
        <Text bold wrap="truncate">Privacy-safe diagnostics report</Text>
        <Text color={muted} wrap="truncate">
          Lines {lines.length === 0 ? 0 : start + 1}–{end} of {lines.length}
        </Text>
        {lines.slice(start, end).map((line, index) => (
          <Text key={`${start + index}:${line}`} wrap="truncate">{line.length === 0 ? " " : line}</Text>
        ))}
        <Text color={muted} wrap="truncate">
          {canCopy ? "↑/↓ scroll · Enter Copy report · Esc Back" : "↑/↓ scroll · Esc Back"}
        </Text>
      </Box>
    );
  }

  const summary = diagnostics.summary;
  return (
    <Box flexDirection="column">
      <Text bold>Support summary</Text>
      <Text>EasyServer: v{summary.version}</Text>
      <Text color={tuiResourceColor(appearance, summary.stateStatus === "ok" ? "ready" : summary.stateStatus === "empty" ? "stopped" : "error")}>
        Local state: {diagnosticsStateLabel(summary.stateStatus)}
      </Text>
      <Text>
        Providers: {summary.configuredPlugins} configured{summary.failedPlugins > 0 ? ` · ${summary.failedPlugins} need attention` : " · no reported failures"}
      </Text>
      <Text color={tuiResourceColor(appearance, summary.daemonStatus)}>
        Connection service: {diagnosticsDaemonLabel(summary.daemonStatus)}
      </Text>
      <Text>SSH tools: client {summary.ssh} · key scan {summary.sshKeyscan}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          The detailed report is privacy-safe by contract: raw secrets, Secret References, daemon tokens, private keys and resource identifiers are excluded.
        </Text>
        <Text>
          {canCopy
            ? "Use Actions to View report before sharing it, or Copy report to copy that exact same sanitized payload."
            : "Use Actions to View report before sharing it. Clipboard integration is unavailable in this TUI session."}
        </Text>
        <Text>Raw logs are separate and may contain sensitive data.</Text>
      </Box>
    </Box>
  );
}

function diagnosticsStateLabel(status: DiagnosticsReport["state"]["status"]): string {
  return status === "ok" ? "ready" : status === "empty" ? "empty" : "needs attention";
}

function diagnosticsDaemonLabel(status: DiagnosticsReport["daemon"]["status"]): string {
  return status === "running"
    ? "running"
    : status === "stopped"
      ? "stopped"
      : status === "unreachable"
        ? "unreachable"
        : "invalid state";
}

export function diagnosticsSummary(report: DiagnosticsReport): TuiDiagnosticsSummary {
  return {
    version: report.easyserver.version,
    stateStatus: report.state.status,
    configuredPlugins: report.state.configuredPlugins,
    failedPlugins: report.plugins.filter((plugin) => plugin.state === "failed").length,
    daemonStatus: report.daemon.status,
    ssh: report.access.ssh,
    sshKeyscan: report.access.sshKeyscan,
  };
}

export function wrapDiagnosticsText(text: string, width: number): readonly string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  for (const logicalLine of text.split("\n")) {
    const characters = Array.from(logicalLine);
    if (characters.length === 0) {
      lines.push("");
      continue;
    }
    for (let offset = 0; offset < characters.length; offset += safeWidth) {
      lines.push(characters.slice(offset, offset + safeWidth).join(""));
    }
  }
  return lines;
}
