import React from "react";
import { Box, Text } from "ink";
import { escapeTerminalText } from "./terminal-text.js";
import { tuiFocusWindowWithinRows } from "./tui-focus.js";
import type {
  TuiProviderCandidateReadItem,
  TuiProviderWorkflowReadItem,
  TuiReadSnapshot,
} from "./tui-read-model.js";

export type ProviderCredentialFlow =
  | {
      readonly kind: "picker";
      readonly providerSource: string;
      readonly selectedName: string;
    }
  | {
      readonly kind: "actions";
      readonly providerSource: string;
      readonly credentialName: string;
      readonly cursor: number;
    }
  | {
      readonly kind: "secret";
      readonly providerSource: string;
      readonly credentialName: string;
      readonly secret: string;
    };

export interface ProviderCandidatePickerView {
  readonly items: readonly TuiProviderCandidateReadItem[];
  readonly cursor: number;
}

export type ProviderCredentialFlowView =
  | Extract<ProviderCredentialFlow, { readonly kind: "picker" }>
  | Extract<ProviderCredentialFlow, { readonly kind: "actions" }>
  | {
      readonly kind: "secret";
      readonly providerSource: string;
      readonly credentialName: string;
      readonly hasSecret: boolean;
    };

export function NewInstanceSurface({
  snapshot,
  selectedWorkflowKey,
}: {
  readonly snapshot: TuiReadSnapshot;
  readonly selectedWorkflowKey?: string;
}): React.ReactElement {
  if (snapshot.providerWorkflows.status === "failed") {
    return (
      <Box flexDirection="column">
        <Text>Provider workflows unavailable: {snapshot.providerWorkflows.message}</Text>
        <Text>Use Actions to refresh. Provider CLI commands remain available.</Text>
      </Box>
    );
  }

  const workflows = snapshot.providerWorkflows.items.filter(
    (workflow) => workflow.operation === "mutation",
  );
  if (workflows.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>No provider acquisition workflows are available.</Text>
        <Text>Open Providers from Actions to configure or enable a provider, then refresh acquisition options.</Text>
        <Text>Providers without a guided rental flow remain available under Advanced provider tools.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>Choose a provider workflow with ↑/↓ and press Enter to start.</Text>
      {workflows.map((workflow) => {
        const key = workflowKey(workflow);
        const selected = key === selectedWorkflowKey;
        return (
          <Box key={key} flexDirection="column" marginTop={1}>
            <Text bold={selected}>
              {selected ? "> " : "  "}
              {workflow.providerId} · {workflow.featureDisplayName} · {workflow.commandName}
              {workflow.presentation.kind === "interactive-flow" ? " · interactive" : " · CLI only"}
            </Text>
            <Text>    {workflow.description}</Text>
            {workflow.presentation.kind === "cli-fallback" ? (
              <Text>
                {`    easyserver provider ${workflow.providerId} ${workflow.featureId} ${workflow.commandName}`}
              </Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

export function ProvidersSurface({
  snapshot,
  height,
  candidatePicker,
  sourceInput,
  credentialFlow,
  selectedSource,
  showDetails,
  canRegister,
  canAddInstalled,
}: {
  readonly snapshot: TuiReadSnapshot;
  readonly height: number;
  readonly candidatePicker?: ProviderCandidatePickerView;
  readonly sourceInput?: string;
  readonly credentialFlow?: ProviderCredentialFlowView;
  readonly selectedSource?: string;
  readonly showDetails: boolean;
  readonly canRegister: boolean;
  readonly canAddInstalled: boolean;
}): React.ReactElement {
  if (candidatePicker !== undefined) {
    const focusedCandidate = candidatePicker.items[candidatePicker.cursor];
    const fixedRows = 2 + (focusedCandidate?.description === undefined ? 0 : 1);
    const window = tuiFocusWindowWithinRows(
      candidatePicker.cursor,
      candidatePicker.items.length,
      Math.max(1, height - fixedRows),
    );
    return (
      <Box flexDirection="column" height={height} overflowY="hidden">
        <Text bold wrap="truncate">Add an installed provider</Text>
        {candidatePicker.items.length === 0 ? (
          <Text wrap="truncate">No discoverable installed Provider Plugins are available.</Text>
        ) : (
          <>
            {window.showBefore ? <Text>↑ {window.hiddenBefore} more</Text> : null}
            {candidatePicker.items.slice(window.start, window.end).map((candidate, visibleIndex) => {
              const index = window.start + visibleIndex;
              return (
                <Text key={candidate.source} bold={index === candidatePicker.cursor} wrap="truncate">
                  {index === candidatePicker.cursor ? "> " : "  "}{candidate.displayName}
                </Text>
              );
            })}
            {window.showAfter ? <Text>↓ {window.hiddenAfter} more</Text> : null}
          </>
        )}
        {focusedCandidate?.description === undefined ? null : (
          <Text wrap="truncate">{focusedCandidate.description}</Text>
        )}
        <Text wrap="truncate">↑/↓ choose · Enter add · Esc back</Text>
      </Box>
    );
  }

  if (sourceInput !== undefined) {
    return (
      <Box flexDirection="column">
        <Text bold>Advanced provider registration</Text>
        <Text>Module or path: {escapeTerminalText(sourceInput)}</Text>
        <Text>Enter add · Esc cancel</Text>
        <Text>Use this only for a package or local path that is not discoverable in the installed-provider picker.</Text>
      </Box>
    );
  }

  if (credentialFlow !== undefined && snapshot.providers.status === "ready") {
    const provider = snapshot.providers.items.find(
      (item) => item.source === credentialFlow.providerSource,
    );
    if (provider !== undefined) {
      const providerLabel =
        provider.displayName ??
        provider.pluginId ??
        provider.providerId ??
        provider.source;
      if (credentialFlow.kind === "secret") {
        return (
          <Box flexDirection="column">
            <Text bold>Configure credential {credentialFlow.credentialName}</Text>
            <Text>Provider: {providerLabel}</Text>
            <Text>Secret: {credentialFlow.hasSecret ? "********" : ""}</Text>
            <Text>Input status: {credentialFlow.hasSecret ? "value entered" : "empty"}</Text>
            <Text>Enter save · Backspace edit · Esc cancel</Text>
            <Text>The secret value is masked and is never read back by the TUI.</Text>
          </Box>
        );
      }

      if (credentialFlow.kind === "actions") {
        const selectedCredential = provider.credentials.items.find(
          (credential) => credential.name === credentialFlow.credentialName,
        );
        return (
          <Box flexDirection="column">
            <Text bold>{credentialFlow.credentialName}</Text>
            {selectedCredential?.description === undefined ? null : (
              <Text>{selectedCredential.description}</Text>
            )}
            <Box marginTop={1} flexDirection="column">
              <Text bold>Actions</Text>
              <Text bold={credentialFlow.cursor === 0}>
                {credentialFlow.cursor === 0 ? "> " : "  "}Set or rotate
              </Text>
              {selectedCredential?.configured ? (
                <Text bold={credentialFlow.cursor === 1}>
                  {credentialFlow.cursor === 1 ? "> " : "  "}Remove credential
                </Text>
              ) : null}
            </Box>
            <Box marginTop={1}>
              <Text>↑/↓ choose · Enter run · Esc back</Text>
            </Box>
          </Box>
        );
      }

      return (
        <Box flexDirection="column">
          <Text bold>Credentials for {providerLabel}</Text>
          <Text>↑/↓ choose credential · Enter actions · Esc back</Text>
          {provider.credentials.items.map((credential) => (
            <Box key={credential.name} flexDirection="column" marginTop={1}>
              <Text bold={credential.name === credentialFlow.selectedName}>
                {credential.name === credentialFlow.selectedName ? "> " : "  "}
                {credential.name} · {credential.required ? "required" : "optional"} · {credential.configured ? "configured" : "missing"}
              </Text>
              {credential.description === undefined ? null : (
                <Text>{credential.description}</Text>
              )}
            </Box>
          ))}
        </Box>
      );
    }
  }

  if (snapshot.providers.status === "failed") {
    return (
      <Box flexDirection="column">
        <Text>Provider configuration unavailable: {snapshot.providers.message}</Text>
        <Text>Use Actions to refresh. Instance inventory may still be available.</Text>
      </Box>
    );
  }

  if (snapshot.providers.items.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>No providers added yet.</Text>
        {canAddInstalled ? (
          <Text>Open Actions and choose Add installed provider.</Text>
        ) : !canRegister ? (
          <Text>Provider setup is unavailable in this TUI session.</Text>
        ) : snapshot.providerCandidates?.status === "ready" ? (
          <Text>No installed provider packages were discovered. Install one outside EasyServer, then use Refresh providers; Advanced module/path registration is also available.</Text>
        ) : (
          <Text>Installed provider discovery is unavailable. Use Refresh providers, or Advanced module/path registration if you already know the provider source.</Text>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>Choose a provider, then press Enter for actions.</Text>
      </Box>
      {snapshot.providers.items.map((provider) => {
        const selected = provider.source === selectedSource;
        return (
          <Box key={`${provider.source}:${provider.pluginId ?? "unloaded"}`} flexDirection="column" marginBottom={1}>
            <Text bold={selected}>
              {selected ? "> " : "  "}{provider.displayName ?? provider.pluginId ?? provider.providerId ?? provider.source}
              {` · ${provider.state === "loaded" ? provider.readiness : provider.state}`}
            </Text>
            {!selected || !showDetails ? null : (
              <Box flexDirection="column" marginLeft={2}>
                <Text>Source: {provider.source}</Text>
                {provider.providerId === undefined ? null : (
                  <Text>Provider ID: {provider.providerId}</Text>
                )}
                {provider.version === undefined ? null : <Text>Version: {provider.version}</Text>}
                {provider.state === "disabled" ? (
                  <Text>Credential metadata unavailable while disabled.</Text>
                ) : provider.state === "failed" ? (
                  <Text>Failure: {provider.failure}</Text>
                ) : provider.credentials.declared === 0 ? (
                  <Text>Credentials: none declared</Text>
                ) : (
                  <Text>
                    Credentials: {provider.credentials.configured}/{provider.credentials.declared} configured
                    {provider.credentials.missingRequired === 0
                      ? ""
                      : ` · ${provider.credentials.missingRequired} required missing`}
                  </Text>
                )}
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

export function workflowKey(workflow: TuiProviderWorkflowReadItem): string {
  return `${workflow.providerId}\u0000${workflow.featureId}\u0000${workflow.commandName}`;
}

export function firstWorkflowKey(
  snapshot: TuiReadSnapshot | undefined,
): string | undefined {
  if (snapshot?.providerWorkflows.status !== "ready") {
    return undefined;
  }
  const first = snapshot.providerWorkflows.items.find(
    (workflow) => workflow.operation === "mutation",
  );
  return first === undefined ? undefined : workflowKey(first);
}

export function firstProviderSource(
  snapshot: TuiReadSnapshot | undefined,
): string | undefined {
  return snapshot?.providers.status === "ready"
    ? snapshot.providers.items[0]?.source
    : undefined;
}
