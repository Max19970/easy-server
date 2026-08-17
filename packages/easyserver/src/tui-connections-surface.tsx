import React from "react";
import { Box, Text } from "ink";
import {
  isNormalizedError,
  normalizedError,
} from "@easyai101/easyserver-plugin-sdk";
import type { AccessMethodDescriptor } from "./connection-gateway.js";
import {
  connectionFailureDetails,
  type ConnectionFailureCause,
} from "./connection-failure.js";
import { escapeTerminalText } from "./terminal-text.js";
import {
  tuiAppearance,
  tuiFocusColor,
  tuiResourceColor,
  type TuiAppearance,
} from "./tui-appearance.js";
import { tuiFocusWindowWithinRows } from "./tui-focus.js";
import type {
  TuiEndpointIntentReadItem,
  TuiPersistentSessionReadItem,
  TuiReadSnapshot,
} from "./tui-read-model.js";
import type {
  TuiForegroundConnection,
  TuiForegroundConnectionRequest,
} from "./tui-foreground-connections.js";
import {
  serverDisplayName,
  serverListLabel,
} from "./tui-servers-surface.js";

export type TuiConnectionTarget =
  | { readonly kind: "foreground"; readonly id: string }
  | { readonly kind: "intent"; readonly id: string }
  | { readonly kind: "persistent"; readonly id: string };

export type ForegroundConnectionStep =
  | "instance"
  | "remote-host"
  | "remote-port"
  | "access-method"
  | "local-port"
  | "review";

export interface ForegroundConnectionFlow {
  readonly mode: "foreground" | "persistent";
  readonly advanced: boolean;
  readonly serverScoped: boolean;
  readonly step: ForegroundConnectionStep;
  readonly instanceId: string;
  readonly remoteHost: string;
  readonly remotePort: string;
  readonly accessMethods: readonly AccessMethodDescriptor[];
  readonly accessMethodId?: string;
  readonly localPort: string;
  readonly idempotencyKey?: string;
}

export interface ConnectionsSurfaceProps {
  readonly snapshot: TuiReadSnapshot;
  readonly height: number;
  readonly screenReader: boolean;
  readonly flow?: ForegroundConnectionFlow;
  readonly busy: boolean;
  readonly connections: readonly TuiForegroundConnection[];
  readonly selectedConnectionId?: string;
  readonly selectedPersistentSessionId?: string;
  readonly selectedEndpointIntentName?: string;
  readonly selectedConnectionTarget?: TuiConnectionTarget;
  readonly showDetails: boolean;
  readonly colorEnabled: boolean;
}

export function ConnectionsSurface({
  snapshot,
  height,
  screenReader,
  flow,
  busy,
  connections,
  selectedConnectionId,
  selectedPersistentSessionId,
  selectedEndpointIntentName,
  selectedConnectionTarget,
  showDetails,
  colorEnabled,
}: ConnectionsSurfaceProps): React.ReactElement {
  const appearance = tuiAppearance(colorEnabled);
  if (flow !== undefined) {
    const instances =
      snapshot.instances.status === "ready" ? snapshot.instances.items : [];
    const selectedInstanceIndex = Math.max(
      0,
      instances.findIndex((instance) => instance.id === flow.instanceId),
    );
    const instanceWindow = tuiFocusWindowWithinRows(
      selectedInstanceIndex,
      instances.length,
      Math.max(1, height - (busy ? 5 : 4)),
    );
    const selectedMethod = flow.accessMethods.find(
      (method) => method.id === flow.accessMethodId,
    );
    return (
      <Box flexDirection="column">
        <Text bold>
          {flow.mode === "persistent" ? "Advanced background connection" : "Connect to server"}
        </Text>
        {flow.step === "instance" ? null : (
          <Text>
            {flow.mode === "persistent"
              ? "Keeps a local port available after this TUI closes. Esc returns to the previous step."
              : "Expose a TCP service from a server on this computer. Esc returns to the previous step."}
          </Text>
        )}
        {busy ? <Text>Working… input is temporarily paused.</Text> : null}
        <Box marginTop={flow.step === "instance" ? 0 : 1} flexDirection="column">
          {flow.step === "instance" ? (
            <>
              <Text bold>Choose server</Text>
              {instances.length === 0 ? (
                <Text>No servers are currently available.</Text>
              ) : (
                <>
                  {instanceWindow.showBefore ? (
                    <Text>↑ {instanceWindow.hiddenBefore} more servers</Text>
                  ) : null}
                  {instances.slice(instanceWindow.start, instanceWindow.end).map((instance, visibleIndex) => (
                    <Text
                      key={instance.id}
                      bold={instance.id === flow.instanceId}
                      color={instance.id === flow.instanceId
                        ? tuiFocusColor(appearance, true)
                        : tuiResourceColor(appearance, instance.freshness === "fresh" ? instance.state : instance.freshness)}
                      wrap="truncate"
                    >
                      {instance.id === flow.instanceId ? "> " : "  "}
                      {serverListLabel(instance, instanceWindow.start + visibleIndex, instances)} · {instance.state ?? "status unavailable"}
                    </Text>
                  ))}
                  {instanceWindow.showAfter ? (
                    <Text>↓ {instanceWindow.hiddenAfter} more servers</Text>
                  ) : null}
                </>
              )}
            </>
          ) : flow.step === "remote-host" ? (
            <>
              <Text bold>Advanced remote host</Text>
              <Text>Host: {escapeTerminalText(flow.remoteHost)}</Text>
              <Text>Default: 127.0.0.1 · Enter continue · Backspace edit · Esc back</Text>
            </>
          ) : flow.step === "remote-port" ? (
            <>
              <Text bold>App/service port on the server</Text>
              <Text>Port: {flow.remotePort}</Text>
              <Text>Use the app/service port (for example 8188 for ComfyUI), not the SSH port.</Text>
              <Text>Enter continue · Backspace edit · Esc back</Text>
            </>
          ) : flow.step === "access-method" ? (
            <>
              <Text bold>Advanced connection method</Text>
              <Text>
                EasyServer normally chooses this automatically. Advanced mode lets you select the exact provider-declared method.
              </Text>
              {flow.accessMethods.length === 0 ? (
                <Text>
                  No supported connection methods are currently available. Esc back and choose another server or refresh provider state.
                </Text>
              ) : (
                flow.accessMethods.map((method, index) => (
                  <Text
                    key={method.id}
                    bold={method.id === flow.accessMethodId}
                    color={tuiFocusColor(appearance, method.id === flow.accessMethodId)}
                  >
                    {method.id === flow.accessMethodId ? "> " : "  "}
                    {escapeTerminalText(method.id)} · {escapeTerminalText(method.kind)} · {method.mode}
                    {index === 0 ? " · default" : ""}
                  </Text>
                ))
              )}
              <Text>↑/↓ choose · Enter continue · Esc back</Text>
            </>
          ) : flow.step === "local-port" ? (
            <>
              <Text bold>Local port on this computer</Text>
              <Text>
                Local address: 127.0.0.1:{flow.localPort.length === 0 ? "automatic" : flow.localPort}
              </Text>
              <Text>Leave blank for an automatic port, or enter 1-65535 for a stable local address.</Text>
              <Text>Enter continue · Backspace edit · Esc back</Text>
            </>
          ) : (
            <>
              <Text bold>
                Review {flow.mode === "persistent" ? "background connection" : "local connection"}
              </Text>
              <Text>Server: {serverDisplayName(snapshot, flow.instanceId)}</Text>
              <Text>App/service port: {flow.remotePort}</Text>
              <Text>
                Local address: 127.0.0.1:{flow.localPort.length === 0 ? "automatic" : flow.localPort}
              </Text>
              <Text>
                Lifetime: {flow.mode === "persistent" ? "kept available in the background after TUI exit" : "available while this TUI is open"}.
              </Text>
              {flow.advanced ? (
                <Text>
                  Technical route: {escapeTerminalText(flow.remoteHost)} · method={selectedMethod === undefined ? "unavailable" : escapeTerminalText(selectedMethod.id)}
                </Text>
              ) : null}
              <Text>Enter {flow.mode === "persistent" ? "create" : "open"} · Esc back</Text>
            </>
          )}
        </Box>
      </Box>
    );
  }

  const selected =
    selectedConnectionTarget === undefined
      ? connections.find((connection) => connection.id === selectedConnectionId)
      : selectedConnectionTarget.kind === "foreground"
        ? connections.find((connection) => connection.id === selectedConnectionTarget.id)
        : undefined;
  const persistentSessions =
    snapshot.daemon.status === "running" && snapshot.daemon.sessions.status === "ready"
      ? snapshot.daemon.sessions.items ?? []
      : [];
  const selectedPersistent =
    selectedConnectionTarget === undefined
      ? persistentSessions.find((session) => session.id === selectedPersistentSessionId)
      : selectedConnectionTarget.kind === "persistent"
        ? persistentSessions.find((session) => session.id === selectedConnectionTarget.id)
        : undefined;
  const endpointIntents =
    snapshot.daemon.status === "running" &&
    snapshot.daemon.endpointIntents.status === "ready"
      ? snapshot.daemon.endpointIntents.items ?? []
      : [];
  const selectedIntent =
    selectedConnectionTarget === undefined
      ? endpointIntents.find((intent) => intent.operationName === selectedEndpointIntentName)
      : selectedConnectionTarget.kind === "intent"
        ? endpointIntents.find((intent) => intent.operationName === selectedConnectionTarget.id)
        : undefined;
  if (showDetails && !screenReader && height < 12) {
    return (
      <Box flexDirection="column">
        <Text bold>Technical details</Text>
        <Text>Background service: {snapshot.daemon.status}</Text>
        {selected !== undefined ? (
          <>
            <Text bold>Selected local connection</Text>
            <Text wrap="truncate">
              {serverDisplayName(snapshot, selected.instanceId)} · {escapeTerminalText(selected.remoteHost)}:{selected.remotePort}
            </Text>
            <Text wrap="truncate">
              Method: {escapeTerminalText(selected.accessMethod.id)} · {escapeTerminalText(selected.accessMethod.kind)}
            </Text>
          </>
        ) : selectedPersistent !== undefined ? (
          <>
            <Text bold>Selected background connection</Text>
            <Text wrap="truncate">
              {serverDisplayName(snapshot, selectedPersistent.instanceId)} · {escapeTerminalText(selectedPersistent.remoteHost)}:{selectedPersistent.remotePort}
            </Text>
            <Text wrap="truncate">State: {selectedPersistent.state}</Text>
          </>
        ) : selectedIntent !== undefined ? (
          <>
            <Text bold>Saved connection: {selectedIntent.name}</Text>
            <Text wrap="truncate">
              {selectedIntent.enabled ? "enabled" : "disabled"} · {selectedIntent.state} · target {selectedIntent.remoteHost}:{selectedIntent.remotePort}
            </Text>
            {selectedIntent.failure === undefined ? null : (
              <Text wrap="truncate">
                Error: {selectedIntent.failure.code} · {selectedIntent.failure.message}
              </Text>
            )}
            {selectedIntent.failure?.hostTrust === undefined ? null : (
              <Text wrap="truncate">
                SSH fingerprint: {selectedIntent.failure.hostTrust.key.type} · {selectedIntent.failure.hostTrust.key.fingerprint}
              </Text>
            )}
            <Text>Use Actions for recovery.</Text>
          </>
        ) : (
          <Text>Use ↑/↓ to select a connection or saved definition.</Text>
        )}
      </Box>
    );
  }
  const localConnectionRows = [
    ...connections.map((connection) => ({
      kind: "foreground" as const,
      id: connection.id,
      instanceId: connection.instanceId,
      remotePort: connection.remotePort,
      endpoint: connection.endpoint,
      state: connection.state,
    })),
    ...persistentSessions.map((session) => ({
      kind: "persistent" as const,
      id: session.id,
      instanceId: session.instanceId,
      remotePort: session.remotePort,
      endpoint: session.endpoint,
      state: session.state,
    })),
  ];
  const selectedLocalIndex = Math.max(
    0,
    selectedConnectionTarget === undefined
      ? -1
      : localConnectionRows.findIndex(
          (row) => row.kind === selectedConnectionTarget.kind && row.id === selectedConnectionTarget.id,
        ),
  );
  const connectionWindow = tuiFocusWindowWithinRows(
    selectedLocalIndex,
    localConnectionRows.length,
    Math.max(1, height - 4),
  );
  return (
    <Box flexDirection="column">
      <Text>
        Local connections make a service on a server available at 127.0.0.1 on this computer.
      </Text>
      <Box flexDirection="column">
        <Text bold>Local connections</Text>
        {localConnectionRows.length === 0 ? (
          <Text>
            None open. {snapshot.instances.status === "ready" && snapshot.instances.items.length === 0
              ? "Use Actions to rent a server first."
              : "Choose a server and use Connect, or open Actions here to create one."}
          </Text>
        ) : (
          <>
            {connectionWindow.showBefore ? <Text>↑ {connectionWindow.hiddenBefore} more connections</Text> : null}
            {localConnectionRows.slice(connectionWindow.start, connectionWindow.end).map((connection) => {
              const selectedRow =
                selectedConnectionTarget?.kind === connection.kind &&
                selectedConnectionTarget.id === connection.id;
              return (
                <Text
                  key={`${connection.kind}:${connection.id}`}
                  bold={selectedRow}
                  color={selectedRow ? tuiFocusColor(appearance, true) : tuiResourceColor(appearance, connection.state)}
                  wrap="truncate"
                >
                  {selectedRow ? "> " : "  "}
                  {connection.endpoint === undefined
                    ? "Local port unavailable"
                    : `${connection.endpoint.host}:${connection.endpoint.port}`}
                  {` → ${serverDisplayName(snapshot, connection.instanceId)}:${connection.remotePort}`}
                  {connection.kind === "persistent" ? " · background" : ""}
                  {connection.state === "live" ? "" : ` · ${connection.state}`}
                </Text>
              );
            })}
            {connectionWindow.showAfter ? <Text>↓ {connectionWindow.hiddenAfter} more connections</Text> : null}
          </>
        )}
      </Box>
      {snapshot.daemon.status === "unreachable" || snapshot.daemon.status === "stale" ? (
        <Text>Some background connections need attention; ordinary local connections remain usable.</Text>
      ) : snapshot.daemon.status === "running" && snapshot.daemon.sessions.status === "unavailable" ? (
        <Text>Some background connection status is temporarily unavailable.</Text>
      ) : null}
      {showDetails ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Technical details</Text>
          <Text>Background service: {snapshot.daemon.status}</Text>
          {selected === undefined ? null : (
            <Box flexDirection="column">
              <Text>Connection ID: {selected.id}</Text>
              <Text>Server ID: {selected.instanceId}</Text>
              <Text>Remote target: {escapeTerminalText(selected.remoteHost)}:{selected.remotePort}</Text>
              <Text>Access Method: {escapeTerminalText(selected.accessMethod.id)} · {escapeTerminalText(selected.accessMethod.kind)}</Text>
            </Box>
          )}
          {selectedPersistent === undefined ? null : (
            <PersistentSessionDetail session={selectedPersistent} appearance={appearance} />
          )}
          <Box marginTop={1} flexDirection="column">
            <Text bold>Saved background connection definitions</Text>
            {snapshot.daemon.status !== "running" ? (
              <Text>Background service must be running to inspect current realization state.</Text>
            ) : snapshot.daemon.endpointIntents.status === "unavailable" ? (
              <Text>Saved definitions exist independently, but current realization state is unavailable.</Text>
            ) : endpointIntents.length === 0 ? (
              <Text>No saved background connection definitions.</Text>
            ) : (
              <>
                {endpointIntents.map((intent) => (
                  <EndpointIntentLine
                    key={intent.operationName}
                    intent={intent}
                    selected={intent.operationName === selectedIntent?.operationName}
                    appearance={appearance}
                  />
                ))}
                {selectedIntent === undefined ? null : (
                  <EndpointIntentDetail intent={selectedIntent} />
                )}
              </>
            )}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

function PersistentSessionDetail({
  session,
  appearance,
}: {
  readonly session: TuiPersistentSessionReadItem;
  readonly appearance: TuiAppearance;
}): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>Persistent Session detail</Text>
      <Text>Session ID: {session.id}</Text>
      <Text color={tuiResourceColor(appearance, session.state)}>State: {session.state}</Text>
      <Text>Instance: {session.instanceId}</Text>
      <Text>Remote target: {session.remoteHost}:{session.remotePort}</Text>
      <Text>Requested local port: {session.requestedLocalPort ?? "dynamic"}</Text>
      <Text>Access Method: {session.accessMethod.id} · {session.accessMethod.kind}</Text>
      {session.endpoint === undefined ? null : (
        <Text>Local Endpoint: {session.endpoint.host}:{session.endpoint.port}</Text>
      )}
      {session.state === "failed" ? (
        <Text>Cleanup failure: {session.failure?.code}: {session.failure?.message}</Text>
      ) : null}
    </Box>
  );
}

function EndpointIntentLine({
  intent,
  selected,
  appearance,
}: {
  readonly intent: TuiEndpointIntentReadItem;
  readonly selected: boolean;
  readonly appearance: TuiAppearance;
}): React.ReactElement {
  const realization =
    intent.state === "live" && intent.endpoint !== undefined
      ? `live endpoint=${intent.endpoint.host}:${intent.endpoint.port}`
      : intent.state;
  return (
    <Text
      bold={selected}
      color={selected ? tuiFocusColor(appearance, true) : tuiResourceColor(appearance, intent.state)}
    >
      {selected ? "> " : "  "}{intent.name} · {intent.enabled ? "enabled" : "disabled"} · {realization}
      {intent.state === "error" ? ` · ${intent.failure?.code ?? "failure"}` : ""}
    </Text>
  );
}

function EndpointIntentDetail({
  intent,
}: {
  readonly intent: TuiEndpointIntentReadItem;
}): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>Persisted Endpoint intent detail</Text>
      <Text>Name: {intent.name}</Text>
      <Text>Desired state: {intent.enabled ? "enabled" : "disabled"}</Text>
      <Text>Realization state: {intent.state}</Text>
      <Text>Instance: {intent.instanceId}</Text>
      <Text>Remote target: {intent.remoteHost}:{intent.remotePort}</Text>
      <Text>Requested local port: {intent.requestedLocalPort ?? "dynamic"}</Text>
      <Text>Requested Access Method: {intent.requestedAccessMethodId ?? "default"}</Text>
      {intent.endpoint === undefined ? null : (
        <Text>
          Current live Endpoint: {intent.endpoint.host}:{intent.endpoint.port}
        </Text>
      )}
      {intent.accessMethod === undefined ? null : (
        <Text>Current Access Method: {intent.accessMethod.id} · {intent.accessMethod.kind}</Text>
      )}
      {intent.state === "starting" ? (
        <Text>Recovery: daemon is realizing desired state; refresh to observe the resulting live Endpoint or Error.</Text>
      ) : intent.state === "error" ? (
        <>
          <Text>Error: {intent.failure?.code}: {intent.failure?.message}</Text>
          {intent.failure?.hostTrust === undefined ? null : (
            <Text>
              SSH fingerprint awaiting review: {intent.failure.hostTrust.key.type} · {intent.failure.hostTrust.key.fingerprint}
            </Text>
          )}
          <Text>Remediation: {endpointIntentRemediation(intent)}</Text>
        </>
      ) : intent.state === "disabled" ? (
        <Text>Recovery: desired state is disabled; use Actions to enable and realize it again.</Text>
      ) : (
        <Text>Recovery: current transport is live. On daemon restart it will be recreated from this persisted definition.</Text>
      )}
    </Box>
  );
}

function endpointIntentRemediation(intent: TuiEndpointIntentReadItem): string {
  const failure = intent.failure;
  if (failure?.code === "host-trust-required") {
    return failure.hostTrust === undefined
      ? "refresh the saved connection to obtain structured SSH trust evidence, then review the fingerprint before retrying"
      : "use Actions to review this exact SSH fingerprint; after approval EasyServer retries the same saved connection";
  }
  switch (failure?.connectionCause) {
    case "ssh-public-key-rejected":
      return "make the matching SSH private key available on this computer or authorize its public key on the server, then retry";
    case "ssh-authentication-rejected":
      return "check the SSH login or key expected by the server, then retry";
    case "ssh-host-identity-mismatch":
      return "verify whether the server was replaced or reinstalled; changed trusted host identity remains blocked until you deliberately correct EasyServer host trust";
    case "ssh-host-identity-changed-before-confirmation":
      return "retry to review the current SSH fingerprint; no changed key was trusted automatically";
    case "ssh-fingerprint-unavailable":
      return "EasyServer could not safely obtain a fingerprint yet; retry, and check local SSH tools in Diagnostics if direct SSH works repeatedly";
    case "ssh-not-ready":
      return "wait for SSH readiness or restore SSH reachability, then retry the saved connection";
    case "remote-service-unavailable":
      return "SSH works; start the app/service or correct its configured port, then retry the saved connection";
    case "tcp-forwarding-forbidden":
      return "use a server or SSH route that permits TCP forwarding, or choose another compatible connection method";
    case "ssh-transport-closed":
      return "retry the saved connection; if SSH remains usable while forwarding closes, inspect Diagnostics or choose another connection method";
    case "local-openssh-unavailable":
      return "install or enable OpenSSH Client on this computer, then retry";
    case "unexpected-ssh-transport":
      return "retry the saved connection and inspect Diagnostics if the SSH transport keeps ending unexpectedly";
    case "local-bind-conflict":
      return "the requested fixed local port is unavailable; free it, or remove and recreate the intent with another fixed or dynamic port, then retry";
  }
  if (failure?.code === "authentication") {
    return "configure or rotate the required provider credential in Providers, then use Actions to retry";
  }
  if (failure?.code === "provider-unavailable") {
    return "restore provider or instance availability, refresh state, then use Actions to retry";
  }
  if (failure?.code === "unsupported-operation") {
    return "restore a compatible provider Access Method, then use Actions to retry";
  }
  return "resolve the reported cause without deleting the desired intent, then use Actions to retry realization";
}

export function previousForegroundConnectionStep(
  flow: ForegroundConnectionFlow,
): ForegroundConnectionStep | undefined {
  if (flow.step === "instance") {
    return undefined;
  }
  if (flow.step === "remote-host") {
    return flow.serverScoped ? undefined : "instance";
  }
  if (flow.step === "remote-port") {
    if (flow.advanced) {
      return "remote-host";
    }
    return flow.serverScoped ? undefined : "instance";
  }
  if (flow.step === "access-method") {
    return "remote-port";
  }
  if (flow.step === "local-port") {
    return flow.advanced ? "access-method" : "remote-port";
  }
  return "local-port";
}

export function humanizeTuiServerError(
  error: unknown,
  {
    instanceId,
    serverLabel,
    accessMethodId,
    connectionVocabulary = false,
  }: {
    readonly instanceId: string;
    readonly serverLabel: string;
    readonly accessMethodId?: string;
    readonly connectionVocabulary?: boolean;
  },
): unknown {
  if (!isNormalizedError(error) || error.code === "host-trust-required") {
    return error;
  }
  if (connectionVocabulary) {
    const failureCause = connectionFailureDetails(error)?.cause;
    const connectionMessage = connectionFailurePresentation(failureCause, serverLabel);
    if (connectionMessage !== undefined) {
      return normalizedError(error.code, connectionMessage);
    }
    if (error.code === "provider-unavailable") {
      return normalizedError(
        error.code,
        `Could not prepare a connection to ${serverLabel}. If the server just started, wait a moment and retry; otherwise refresh Servers or open Diagnostics.`,
      );
    }
    if (error.code === "authentication") {
      return normalizedError(
        error.code,
        `Connection authentication for ${serverLabel} was rejected. Check the login or key expected by the server and retry; this does not necessarily mean the provider API credential is wrong.`,
      );
    }
    if (error.code === "unsupported-operation") {
      return normalizedError(
        error.code,
        `No supported connection method is currently available for ${serverLabel}.`,
      );
    }
  }
  if (error.code === "provider-unavailable") {
    return normalizedError(
      error.code,
      `Could not reach ${serverLabel}. Refresh Servers; use Providers or Diagnostics if the problem continues.`,
    );
  }
  if (error.code === "authentication") {
    return normalizedError(
      error.code,
      `Credentials need attention before ${serverLabel} can be used. Open Providers to review them.`,
    );
  }
  if (error.code === "plugin-failure" || error.code === "unknown-provider-error") {
    return normalizedError(
      error.code,
      `EasyServer could not complete this operation for ${serverLabel}. Open Diagnostics to check current EasyServer and provider readiness.`,
    );
  }
  if (error.code === "not-found") {
    return normalizedError(
      error.code,
      `${serverLabel} is no longer available. Refresh Servers and try again.`,
    );
  }
  let message = error.message
    .replaceAll(instanceId, serverLabel)
    .replaceAll("Compute Instance", "Server")
    .replaceAll("compute instance", "server");
  if (accessMethodId !== undefined) {
    message = message.replaceAll(accessMethodId, "the selected connection method");
  }
  if (connectionVocabulary) {
    message = message
      .replaceAll("Local Endpoint", "Local connection")
      .replaceAll("Connection Session", "background connection")
      .replaceAll("Access Method", "connection method")
      .replaceAll("Endpoint", "connection");
  }
  return message === error.message ? error : normalizedError(error.code, message);
}

function connectionFailurePresentation(
  cause: ConnectionFailureCause | undefined,
  serverLabel: string,
): string | undefined {
  switch (cause) {
    case "ssh-fingerprint-unavailable":
      return `EasyServer could not obtain an SSH host fingerprint for ${serverLabel}, so it cannot safely ask you to trust a key yet. Retry connection; if direct SSH works but this keeps failing, check the local SSH tools in Diagnostics.`;
    case "remote-service-unavailable":
      return `SSH to ${serverLabel} works, but the requested app/service port could not be reached. Start or wait for that service, or edit the service port, then retry.`;
    case "ssh-transport-closed":
      return `The SSH route to ${serverLabel} closed before app/service forwarding was established. Retry the connection; if direct SSH keeps working while forwarding fails, check Diagnostics or try another available connection method.`;
    case "ssh-not-ready":
      return `SSH for ${serverLabel} is not ready or reachable yet. If the server just started, wait a moment and retry; otherwise check Diagnostics.`;
    case "ssh-host-identity-changed-before-confirmation":
      return `The SSH fingerprint for ${serverLabel} changed since you reviewed it. Nothing was trusted. Retry connection to review the current fingerprint before continuing.`;
    case "ssh-host-identity-mismatch":
      return `SSH host identity for ${serverLabel} changed. EasyServer blocked the connection. Verify the server was replaced or reinstalled before trusting a new host key; if the change is expected, remove the stale EasyServer host key and retry.`;
    case "ssh-public-key-rejected":
      return `SSH public-key authentication to ${serverLabel} was rejected. Make sure the matching SSH private key is available to EasyServer/OpenSSH and its public key is authorized on the server, then retry.`;
    case "ssh-authentication-rejected":
      return `Connection authentication for ${serverLabel} was rejected. Check the login or key expected by the server and retry; this does not necessarily mean the provider API credential is wrong.`;
    case "tcp-forwarding-forbidden":
      return `SSH to ${serverLabel} works, but this SSH route does not allow TCP forwarding. Choose another connection method if one is available, or use a server/SSH route that permits forwarding.`;
    case "local-openssh-unavailable":
      return "This computer could not start OpenSSH. Install or enable OpenSSH Client, make sure ssh is available, then retry. Open Diagnostics to check local SSH tools.";
    case "unexpected-ssh-transport":
      return `The SSH transport to ${serverLabel} ended unexpectedly. Retry connection. Diagnostics can check local SSH and provider readiness, but raw SSH output is intentionally not retained.`;
    case "local-bind-conflict":
      return "The requested local port on this computer is already in use. Choose another local port or leave it blank for an automatic port.";
    default:
      return undefined;
  }
}

export function parseConnectionPort(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) {
    return undefined;
  }
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? port
    : undefined;
}

export function foregroundConnectionNeedsServicePortEdit(
  connection: TuiForegroundConnection,
): boolean {
  return (
    connection.state === "failed" &&
    connection.failure?.connectionCause === "remote-service-unavailable"
  );
}

export function foregroundConnectionCanRetry(
  connection: TuiForegroundConnection,
): boolean {
  if (connection.state !== "failed" || connection.failure === undefined) {
    return false;
  }
  return (
    connection.failure.code !== "unsupported-operation" &&
    connection.failure.connectionCause !== "ssh-host-identity-mismatch"
  );
}

export function foregroundConnectionFlowFromFailedConnection(
  connection: TuiForegroundConnection,
  step: ForegroundConnectionStep,
): ForegroundConnectionFlow {
  return {
    mode: "foreground",
    advanced: false,
    serverScoped: true,
    step,
    instanceId: connection.instanceId,
    remoteHost: connection.remoteHost,
    remotePort: String(connection.remotePort),
    accessMethods: [connection.accessMethod],
    accessMethodId: connection.accessMethod.id,
    localPort:
      connection.requestedLocalPort === undefined
        ? ""
        : String(connection.requestedLocalPort),
  };
}

export function foregroundConnectionRequest(
  flow: ForegroundConnectionFlow,
): TuiForegroundConnectionRequest | undefined {
  const remotePort = parseConnectionPort(flow.remotePort);
  const localPort =
    flow.localPort.length === 0
      ? undefined
      : parseConnectionPort(flow.localPort);
  if (
    remotePort === undefined ||
    (flow.localPort.length > 0 && localPort === undefined) ||
    flow.remoteHost.trim().length === 0 ||
    flow.accessMethodId === undefined
  ) {
    return undefined;
  }
  return {
    instanceId: flow.instanceId,
    remoteHost: flow.remoteHost.trim(),
    remotePort,
    ...(localPort === undefined ? {} : { localPort }),
    accessMethodId: flow.accessMethodId,
  };
}
