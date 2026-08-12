import React from "react";
import { Box, Text } from "ink";
import {
  assertTuiOperationPresentation,
  type TuiOperationActionKind,
  type TuiOperationPresentation,
} from "./tui-operation-model.js";

export interface TuiOperationDrawerProps {
  readonly operation: TuiOperationPresentation;
  readonly colorEnabled?: boolean;
}

export function TuiOperationDrawer({
  operation,
  colorEnabled = true,
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

      {operation.actions.length === 0 ? null : (
        <Box marginTop={1}>
          <Text>Actions: {operation.actions.map(actionLabel).join(" · ")}</Text>
        </Box>
      )}
    </Box>
  );
}

function phaseLabel(operation: TuiOperationPresentation): string {
  const { phase } = operation;
  if (phase === "working" && operation.activity !== undefined) {
    return operation.activity === "loading"
      ? "loading"
      : operation.activity === "waiting-provider"
        ? "waiting for provider"
        : "verifying state";
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

function actionLabel(action: { readonly kind: TuiOperationActionKind; readonly label: string }): string {
  const key =
    action.kind === "confirm" || action.kind === "trust"
      ? "Enter"
      : action.kind === "decline"
        ? "Esc"
        : action.kind === "cancel"
          ? "c"
          : action.kind === "dismiss"
            ? "x"
            : action.kind === "observe"
              ? "o"
              : "R";
  return `${key} ${action.label}`;
}
