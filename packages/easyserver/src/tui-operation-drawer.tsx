import React from "react";
import { Box, Text } from "ink";
import {
  assertTuiOperationPresentation,
  type TuiOperationPresentation,
} from "./tui-operation-model.js";

export interface TuiOperationDrawerProps {
  readonly operation: TuiOperationPresentation;
  readonly colorEnabled?: boolean;
  readonly selectedActionIndex?: number;
}

export function TuiOperationDrawer({
  operation,
  colorEnabled = true,
  selectedActionIndex = 0,
}: TuiOperationDrawerProps): React.ReactElement {
  assertTuiOperationPresentation(operation);

  const toneColor = colorEnabled
    ? operation.tone === "success"
      ? "green"
      : operation.tone === "warning"
        ? "yellow"
        : operation.tone === "danger"
          ? "red"
          : "cyan"
    : undefined;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={toneColor} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={toneColor}>{operation.title}</Text>
        <Text>{phaseLabel(operation)}</Text>
      </Box>

      {operation.detail === undefined ? null : <Text wrap="wrap">{operation.detail}</Text>}

      {operation.interaction?.kind === "mutation-confirmation" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>Action: {operation.interaction.summary}</Text>
          <Text>Target: {operation.interaction.target}</Text>
          <Text>Risk: {operation.interaction.risks.join(", ")}</Text>
          <Text>Consequence: {operation.interaction.consequence}</Text>
          <Text>
            Affected EasyServer resources:{" "}
            {operation.interaction.affectedResources.length === 0
              ? "none"
              : operation.interaction.affectedResources.join(", ")}
          </Text>
        </Box>
      ) : null}

      {operation.interaction?.kind === "host-trust" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>Host: {operation.interaction.host}:{operation.interaction.port}</Text>
          <Text>Key type: {operation.interaction.keyType}</Text>
          <Text>Fingerprint: {operation.interaction.fingerprint}</Text>
        </Box>
      ) : null}

      {operation.instanceResults === undefined || operation.instanceResults.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Instance results</Text>
          {operation.instanceResults.map((item) => (
            <Text key={item.instanceId} wrap="wrap">
              {item.instanceId} · {item.status}
              {item.error === undefined
                ? ""
                : ` · ${item.error.code} · ${item.error.message}`}
              {item.observedState === undefined
                ? ""
                : ` · observed=${item.observedState}`}
              {item.observationError === undefined
                ? ""
                : ` · observation=${item.observationError.code} · ${item.observationError.message}`}
            </Text>
          ))}
        </Box>
      )}

      {operation.providerOutput === undefined || operation.providerOutput.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Provider output</Text>
          {operation.providerOutput.map((line, index) => (
            <Text key={`${index}:${line.stream}`}>
              {line.stream === "error" ? "! " : "  "}{line.text}
            </Text>
          ))}
        </Box>
      )}

      {operation.phase === "failed" ||
      operation.phase === "outcome-unknown" ||
      operation.phase === "reconciliation-failed" ? (
        <Box marginTop={1}>
          <Text>Support: after closing this result, open Diagnostics before sharing raw logs.</Text>
        </Box>
      ) : null}

      {operation.actions.length === 0 ? null : (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Actions</Text>
          {operation.actions.map((action, index) => (
            <Text key={action.kind} bold={index === selectedActionIndex}>
              {index === selectedActionIndex ? "> " : "  "}{action.label}
            </Text>
          ))}
          <Text>↑/↓ choose · Enter run{operation.actions.some((action) => action.kind === "decline") ? " · Esc decline" : ""}</Text>
        </Box>
      )}
    </Box>
  );
}

function phaseLabel(operation: TuiOperationPresentation): string {
  const { phase } = operation;
  if (phase === "working" && operation.activity !== undefined) {
    if (operation.activity === "loading") {
      return "loading";
    }
    if (operation.activity === "waiting-provider") {
      return "waiting for provider";
    }
    if (operation.activity === "requested") {
      return "requested";
    }
    if (operation.activity === "dispatching") {
      return "dispatching";
    }
    if (operation.activity === "observing") {
      return "observing";
    }
    return "verifying state";
  }
  if (phase === "awaiting-confirmation") {
    return "awaiting confirmation";
  }
  if (phase === "outcome-unknown") {
    return "outcome unknown";
  }
  if (phase === "reconciliation-pending") {
    return "reconciliation pending";
  }
  if (phase === "reconciliation-failed") {
    return "reconciliation failed";
  }
  return phase;
}
