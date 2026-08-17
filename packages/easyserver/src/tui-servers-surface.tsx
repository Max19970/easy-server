import React from "react";
import { Box, Text } from "ink";
import {
  isNormalizedError,
  normalizedError,
  PROVIDER_CAPABILITIES,
  type AvailableAction,
} from "@easyai101/easyserver-plugin-sdk";
import { tuiFocusWindowWithinRows } from "./tui-focus.js";
import type {
  TuiInstanceReadItem,
  TuiReadSnapshot,
} from "./tui-read-model.js";
import type {
  TuiBulkInstanceMutation,
  TuiBulkInstanceMutationResult,
  TuiInstanceMutation,
} from "./tui-instance-operations.js";
import type {
  BulkInstanceDestroyConfirmationDetails,
  InstanceDestroyConfirmationDetails,
} from "./instance-operations.js";
import type { TuiOperationPresentation } from "./tui-operation-model.js";

export interface InstancesSurfaceProps {
  readonly snapshot: TuiReadSnapshot;
  readonly height: number;
  readonly selectedInstanceId?: string;
  readonly showDetails: boolean;
  readonly bulkSelectedInstanceIds: readonly string[];
  readonly canMutate: boolean;
  readonly canBulkMutate: boolean;
}

export function InstancesSurface({
  snapshot,
  height,
  selectedInstanceId,
  showDetails,
  bulkSelectedInstanceIds,
  canMutate,
  canBulkMutate,
}: InstancesSurfaceProps): React.ReactElement {
  if (snapshot.instances.status === "failed") {
    return (
      <Box flexDirection="column">
        <Text>Instance inventory unavailable: {snapshot.instances.message}</Text>
        <Text>Use Actions to refresh. Other TUI sections remain available.</Text>
      </Box>
    );
  }

  const items = snapshot.instances.items;
  const failedProviderOutcomes = snapshot.instances.providerOutcomes.filter(
    (provider) => provider.status === "failed",
  );
  if (items.length === 0) {
    return (
      <Box flexDirection="column">
        {snapshot.instances.complete ? null : (
          <PartialInventoryNotice failedProviders={failedProviderOutcomes} />
        )}
        <Text>{instanceEmptyGuidance(snapshot)}</Text>
      </Box>
    );
  }

  const selected =
    selectedInstanceId === undefined
      ? items[0]
      : items.find((instance) => instance.id === selectedInstanceId);
  const selectionMissing = selectedInstanceId !== undefined && selected === undefined;
  const marked = new Set(bulkSelectedInstanceIds);
  const markedInstances = items.filter((instance) => marked.has(instance.id));
  const missingMarkedIds = bulkSelectedInstanceIds.filter(
    (instanceId) => !items.some((instance) => instance.id === instanceId),
  );
  const selectedIndex = Math.max(0, items.findIndex((instance) => instance.id === selected?.id));
  const partialNoticeRows = snapshot.instances.complete ? 0 : 3;
  const bulkSelectionRows =
    bulkSelectedInstanceIds.length === 0
      ? 0
      : 2 +
        Math.min(2, bulkSelectedInstanceIds.length) +
        (bulkSelectedInstanceIds.length > 2 ? 1 : 0) +
        (missingMarkedIds.length > 0 ? 1 : 0);
  const serverWindow = tuiFocusWindowWithinRows(
    selectedIndex,
    items.length,
    Math.max(1, height - 2 - partialNoticeRows - bulkSelectionRows),
  );

  return (
    <Box flexDirection="column">
      {snapshot.instances.complete ? null : (
        <PartialInventoryNotice failedProviders={failedProviderOutcomes} />
      )}
      <Text>Choose a server. Enter opens its actions.</Text>
      {showDetails ? null : (
        <Box flexDirection="column">
          {serverWindow.showBefore ? <Text>↑ {serverWindow.hiddenBefore} more servers</Text> : null}
          {items.slice(serverWindow.start, serverWindow.end).map((instance, visibleIndex) => (
            <Text key={instance.id} bold={instance.id === selected?.id} wrap="truncate">
              {instance.id === selected?.id ? "> " : "  "}
              {canBulkMutate ? (marked.has(instance.id) ? "[x] " : "[ ] ") : ""}
              {serverListLabel(instance, serverWindow.start + visibleIndex, items)} · {instance.state ?? "status unavailable"}
              {instance.freshness === "fresh" ? "" : " · needs refresh"}
            </Text>
          ))}
          {serverWindow.showAfter ? <Text>↓ {serverWindow.hiddenAfter} more servers</Text> : null}
        </Box>
      )}
      {bulkSelectedInstanceIds.length === 0 ? null : (
        <BulkInstanceSelection
          instanceIds={bulkSelectedInstanceIds}
          instances={items}
          missingInstanceIds={missingMarkedIds}
        />
      )}
      {selectionMissing ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Selected server is no longer visible.</Text>
          <Text>
            The previously selected server disappeared from the refreshed inventory. No action target was changed; use ↑/↓ to choose a current server.
          </Text>
        </Box>
      ) : selected === undefined || !showDetails ? null : (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Technical server details</Text>
          <Text>Server: {selected.name ?? selected.id}</Text>
          <Text>EasyServer ID: {selected.id}</Text>
          <Text>Provider: {selected.providerId}</Text>
          <Text>Provider ID: {selected.providerExternalId}</Text>
          <Text>Normalized state: {selected.state ?? "unobserved"}</Text>
          {selected.rawState === undefined ? null : (
            <Text>Provider state: {String(selected.rawState)}</Text>
          )}
          <Text>Freshness: {selected.freshness}</Text>
          {selected.observedAt === undefined ? null : (
            <Text>Last observed: {selected.observedAt}</Text>
          )}
          {selected.freshness === "stale" ? (
            <Text>Observation: retained last-known state; the current provider refresh failed.</Text>
          ) : selected.freshness === "unobserved" ? (
            <Text>Observation: identity is known, but no current provider state is available.</Text>
          ) : null}
          <Text>Management: {selected.management}</Text>
          <Text>Available lifecycle actions: {formatActions(availableInstanceActions(selected).map(instanceActionLabel))}</Text>
          {bulkSelectedInstanceIds.length > 0 && canBulkMutate ? (
            <BulkInstanceActionGuidance
              instances={markedInstances}
              missingInstanceIds={missingMarkedIds}
            />
          ) : canMutate ? (
            <InstanceActionGuidance instance={selected} />
          ) : null}
        </Box>
      )}
    </Box>
  );
}

export function serverListLabel(
  server: TuiInstanceReadItem,
  index: number,
  servers: readonly TuiInstanceReadItem[],
): string {
  if (server.name !== undefined) {
    return server.name;
  }
  const unnamed = servers.filter((candidate) => candidate.name === undefined);
  if (unnamed.length <= 1) {
    return "Server";
  }
  const ordinal = servers
    .slice(0, index + 1)
    .filter((candidate) => candidate.name === undefined).length;
  return `Server #${ordinal}`;
}

export function serverDisplayName(snapshot: TuiReadSnapshot, instanceId: string): string {
  if (snapshot.instances.status !== "ready") {
    return "server";
  }
  const index = snapshot.instances.items.findIndex((instance) => instance.id === instanceId);
  const server = index < 0 ? undefined : snapshot.instances.items[index];
  return server === undefined ? "server" : serverListLabel(server, index, snapshot.instances.items);
}

export function bulkServerDisplayName(
  snapshot: TuiReadSnapshot | undefined,
  instanceId: string,
  targetIndex: number,
): string {
  if (snapshot?.instances.status !== "ready") {
    return `Selected server #${targetIndex + 1}`;
  }
  const index = snapshot.instances.items.findIndex((instance) => instance.id === instanceId);
  const server = index < 0 ? undefined : snapshot.instances.items[index];
  return server === undefined
    ? `Selected server #${targetIndex + 1}`
    : serverListLabel(server, index, snapshot.instances.items);
}

export function humanizeBulkInstanceMessage(
  message: string,
  snapshot: TuiReadSnapshot | undefined,
  instanceId: string,
  serverLabel: string,
): string {
  let human = message
    .replaceAll(instanceId, serverLabel)
    .replaceAll("Compute Instance", "Server")
    .replaceAll("compute instance", "server");
  if (snapshot?.instances.status === "ready") {
    const server = snapshot.instances.items.find((instance) => instance.id === instanceId);
    if (server !== undefined) {
      human = human
        .replaceAll(server.providerId, "provider")
        .replaceAll(server.providerExternalId, "remote server");
    }
  }
  return human;
}

export function humanizeBulkMutationError(
  error: unknown,
  snapshot: TuiReadSnapshot | undefined,
  instanceIds: readonly string[],
): unknown {
  if (!isNormalizedError(error)) {
    return normalizedError(
      "plugin-failure",
      "EasyServer could not complete the operation for the selected servers. Open Diagnostics for details.",
    );
  }
  if (error.code === "provider-unavailable") {
    return normalizedError(
      error.code,
      "Could not reach one or more selected servers. Refresh Servers; use Providers or Diagnostics if the problem continues.",
    );
  }
  if (error.code === "authentication") {
    return normalizedError(
      error.code,
      "Credentials need attention before the selected servers can be managed. Open Providers to review them.",
    );
  }
  if (error.code === "plugin-failure" || error.code === "unknown-provider-error") {
    return normalizedError(
      error.code,
      "EasyServer could not complete the operation for the selected servers. Open Diagnostics for details.",
    );
  }
  const message = instanceIds.reduce(
    (current, instanceId, targetIndex) =>
      humanizeBulkInstanceMessage(
        current,
        snapshot,
        instanceId,
        bulkServerDisplayName(snapshot, instanceId, targetIndex),
      ),
    error.message,
  );
  return message === error.message ? error : normalizedError(error.code, message);
}

export function humanizeBulkInstanceResult(
  snapshot: TuiReadSnapshot | undefined,
  result: TuiBulkInstanceMutationResult,
): TuiBulkInstanceMutationResult {
  return {
    ...result,
    results: result.results.map((item, targetIndex) => {
      const serverLabel = bulkServerDisplayName(snapshot, item.instanceId, targetIndex);
      if (item.status === "completed") {
        return {
          ...item,
          instanceId: serverLabel,
          ...(item.observationError === undefined
            ? {}
            : {
                observationError: {
                  ...item.observationError,
                  message: humanizeBulkInstanceMessage(
                    item.observationError.message,
                    snapshot,
                    item.instanceId,
                    serverLabel,
                  ),
                },
              }),
        };
      }
      return {
        ...item,
        instanceId: serverLabel,
        error: {
          ...item.error,
          message: humanizeBulkInstanceMessage(
            item.error.message,
            snapshot,
            item.instanceId,
            serverLabel,
          ),
        },
      };
    }),
  };
}

function PartialInventoryNotice({
  failedProviders,
}: {
  readonly failedProviders: readonly Extract<
    TuiReadSnapshot["instances"],
    { readonly status: "ready" }
  >["providerOutcomes"][number][];
}): React.ReactElement {
  const firstFailure = failedProviders.find((provider) => provider.status === "failed");
  const hiddenFailures = Math.max(0, failedProviders.length - (firstFailure === undefined ? 0 : 1));
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        Some providers are unavailable. Available provider results remain usable.
      </Text>
      <Text wrap="truncate">
        {firstFailure === undefined
          ? ""
          : `${firstFailure.providerId} · ${firstFailure.error.code}${hiddenFailures === 0 ? "" : ` · +${hiddenFailures} more`} · `}
        Open Providers or Diagnostics, then refresh.
      </Text>
    </Box>
  );
}

function instanceEmptyGuidance(snapshot: TuiReadSnapshot): string {
  if (snapshot.providers.status === "failed") {
    return "No servers are visible. Provider configuration could not be inspected; resolve provider setup and refresh from Actions.";
  }
  if (snapshot.providers.items.length === 0) {
    return "No servers yet. Configure a provider first, then rent a server.";
  }
  if (
    snapshot.instances.status === "ready" &&
    !snapshot.instances.complete &&
    snapshot.instances.providerOutcomes.some((provider) => provider.status === "failed")
  ) {
    return "No servers were reported by available providers. Unavailable providers may have additional servers that are not visible right now.";
  }
  return "No servers yet. Providers are configured; use Rent a server.";
}

export function availableInstanceActions(
  instance: TuiInstanceReadItem,
): TuiInstanceReadItem["availableActions"] {
  if (instance.freshness !== "fresh") {
    return [];
  }
  return instance.availableActions.filter(
    (action) => action !== "instance.destroy" || instance.management === "managed",
  );
}

export function bulkAvailableInstanceActions(
  instances: readonly TuiInstanceReadItem[],
): readonly AvailableAction[] {
  return PROVIDER_CAPABILITIES.filter((action) =>
    instances.some((instance) => availableInstanceActions(instance).includes(action)),
  );
}

function bulkActionSupportCount(
  instances: readonly TuiInstanceReadItem[],
  action: AvailableAction,
): number {
  return instances.filter((instance) =>
    availableInstanceActions(instance).includes(action),
  ).length;
}

export function instanceMutationStatus(mutation: TuiInstanceMutation): string {
  return mutation.kind === "adopt"
    ? "Server adoption requested."
    : `${instanceActionLabel(mutation.action)} requested.`;
}

export function bulkInstanceMutationStatus(mutation: TuiBulkInstanceMutation): string {
  return `${instanceActionLabel(mutation.action)} requested for ${mutation.instanceIds.length} selected ${mutation.instanceIds.length === 1 ? "server" : "servers"}.`;
}

export function instanceMutationTitle(mutation: TuiInstanceMutation): string {
  return mutation.kind === "adopt" ? "Adopt server" : instanceActionLabel(mutation.action);
}

export function bulkInstanceMutationTitle(mutation: TuiBulkInstanceMutation): string {
  const verb = mutation.action.slice("instance.".length);
  return `${verb[0]?.toUpperCase() ?? ""}${verb.slice(1)} selected servers`;
}

export function bulkInstanceConfirmationResources(
  snapshot: TuiReadSnapshot | undefined,
  details: BulkInstanceDestroyConfirmationDetails,
): readonly string[] {
  return details.targets.map((target, index) => {
    if (snapshot?.instances.status !== "ready") {
      return `Selected server #${index + 1}`;
    }
    const serverIndex = snapshot.instances.items.findIndex(
      (server) => server.id === target.instanceId,
    );
    const server = serverIndex < 0 ? undefined : snapshot.instances.items[serverIndex];
    return server === undefined
      ? `Selected server #${index + 1}`
      : serverListLabel(server, serverIndex, snapshot.instances.items);
  });
}

export function destroyAffectedResources(
  details: InstanceDestroyConfirmationDetails,
): readonly string[] {
  const resources: string[] = [];
  if (details.impact.sessionIds.length > 0) {
    resources.push(
      `${details.impact.sessionIds.length} background ${details.impact.sessionIds.length === 1 ? "connection" : "connections"}`,
    );
  }
  if (details.impact.endpointIntentNames.length > 0) {
    resources.push(
      `${details.impact.endpointIntentNames.length} saved background connection ${details.impact.endpointIntentNames.length === 1 ? "definition" : "definitions"}`,
    );
  }
  if (details.impact.pendingCleanupCount > 0) {
    resources.push(
      `${details.impact.pendingCleanupCount} pending connection ${details.impact.pendingCleanupCount === 1 ? "cleanup" : "cleanups"}`,
    );
  }
  return resources;
}

export function destroyServerConsequence(details: InstanceDestroyConfirmationDetails): string {
  const affected = destroyAffectedResources(details);
  return affected.length === 0
    ? "This permanently destroys the selected server."
    : `This permanently destroys the selected server and closes or removes ${affected.join(", ")}.`;
}

function BulkInstanceSelection({
  instanceIds,
  instances,
  missingInstanceIds,
}: {
  readonly instanceIds: readonly string[];
  readonly instances: readonly TuiInstanceReadItem[];
  readonly missingInstanceIds: readonly string[];
}): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>Selected servers ({instanceIds.length})</Text>
      {instanceIds.slice(0, 2).map((instanceId, targetIndex) => {
        const instanceIndex = instances.findIndex((item) => item.id === instanceId);
        const instance = instanceIndex < 0 ? undefined : instances[instanceIndex];
        return instance === undefined ? (
          <Text key={instanceId}>Selected server #{targetIndex + 1} · no longer visible</Text>
        ) : (
          <Text key={instanceId} wrap="truncate">
            {serverListLabel(instance, instanceIndex, instances)} · {instance.state ?? "status unavailable"}
            {instance.freshness === "fresh" ? "" : " · needs refresh"}
          </Text>
        );
      })}
      {instanceIds.length <= 2 ? null : (
        <Text wrap="truncate">+{instanceIds.length - 2} more selected · scroll checked server rows to review.</Text>
      )}
      {missingInstanceIds.length === 0 ? null : (
        <Text wrap="truncate">Some selected servers are missing; bulk actions are blocked.</Text>
      )}
    </Box>
  );
}

function BulkInstanceActionGuidance({
  instances,
  missingInstanceIds,
}: {
  readonly instances: readonly TuiInstanceReadItem[];
  readonly missingInstanceIds: readonly string[];
}): React.ReactElement {
  if (missingInstanceIds.length > 0) {
    return <Text>Bulk actions are blocked because part of the exact target set is no longer visible.</Text>;
  }
  if (instances.some((instance) => instance.freshness !== "fresh")) {
    return <Text>Refresh before bulk mutation; stale or unobserved targets are read-only.</Text>;
  }
  const actions = bulkAvailableInstanceActions(instances);
  if (actions.length === 0) {
    return <Text>No normalized lifecycle action is currently advertised by the marked targets.</Text>;
  }
  return (
    <Box flexDirection="column">
      <Text>
        Available bulk actions: {actions.map((action) => `${action.slice("instance.".length)} (${bulkActionSupportCount(instances, action)}/${instances.length} advertise)`).join(" · ")}
      </Text>
      <Text>Unsupported, failed and outcome-unknown targets stay visible independently; no target is retried blindly.</Text>
    </Box>
  );
}

function InstanceActionGuidance({
  instance,
}: {
  readonly instance: TuiInstanceReadItem;
}): React.ReactElement {
  if (instance.freshness !== "fresh") {
    return <Text>Refresh before managing this instance; stale or unobserved state is read-only.</Text>;
  }

  const actions = availableInstanceActions(instance);
  return (
    <Box flexDirection="column">
      {instance.management === "discovered" ? (
        <Text>Adopt for EasyServer management is available from Actions.</Text>
      ) : null}
      {instance.management === "discovered" &&
      instance.availableActions.includes("instance.destroy") ? (
        <Text>Destroy is unavailable until this resource is explicitly adopted.</Text>
      ) : null}
      {actions.length === 0 ? (
        <Text>No lifecycle actions are currently available.</Text>
      ) : (
        <Text>
          Available lifecycle actions: {actions.map((action) => action.slice("instance.".length)).join(" · ")}
        </Text>
      )}
    </Box>
  );
}

export function instanceActionLabel(action: AvailableAction): string {
  const verb = action.slice("instance.".length);
  return `${verb[0]?.toUpperCase() ?? ""}${verb.slice(1)} server`;
}

function formatActions(actions: readonly string[]): string {
  return actions.length === 0 ? "none" : actions.join(", ");
}

export function firstInstanceId(snapshot: TuiReadSnapshot | undefined): string | undefined {
  return snapshot?.instances.status === "ready"
    ? snapshot.instances.items[0]?.id
    : undefined;
}

export function canStartInstanceMutation(
  operation: TuiOperationPresentation | undefined,
): boolean {
  if (operation?.instanceResults !== undefined) {
    return false;
  }
  return (
    operation === undefined ||
    operation.phase === "completed" ||
    operation.phase === "failed" ||
    operation.phase === "cancelled"
  );
}
