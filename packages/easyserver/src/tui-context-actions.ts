import type { AvailableAction } from "@easyai101/easyserver-plugin-sdk";
import type {
  TuiEndpointIntentReadItem,
  TuiInstanceReadItem,
  TuiProviderReadItem,
} from "./tui-read-model.js";
import type { TuiForegroundConnection } from "./tui-foreground-connections.js";
import {
  availableInstanceActions,
  bulkAvailableInstanceActions,
  instanceActionLabel,
} from "./tui-servers-surface.js";
import {
  foregroundConnectionCanRetry,
  foregroundConnectionNeedsServicePortEdit,
  type TuiConnectionTarget,
} from "./tui-connections-surface.js";
import type { TuiDiagnosticsView } from "./tui-diagnostics-surface.js";

export type TuiContextActionId =
  | "refresh"
  | "new-instance"
  | "providers"
  | "connections"
  | "instance-details"
  | "instance-connect"
  | "instance-adopt"
  | "instance-mark"
  | "bulk-clear"
  | "provider-details"
  | "provider-add-installed"
  | "provider-add-advanced"
  | "provider-credentials"
  | "provider-toggle"
  | "connection-details"
  | "connection-new-foreground"
  | "connection-new-persistent"
  | "daemon-toggle"
  | "connection-retry-foreground"
  | "connection-edit-service-port"
  | "connection-close-foreground"
  | "connection-close-persistent"
  | "intent-toggle"
  | "intent-host-trust"
  | "intent-retry"
  | "intent-remove"
  | "diagnostics-view"
  | "diagnostics-copy"
  | `instance-action:${AvailableAction}`
  | `bulk-action:${AvailableAction}`;

export interface TuiContextAction {
  readonly id: TuiContextActionId;
  readonly label: string;
}

export function serverContextActions({
  selectedInstance,
  detailsOpen,
  canConnect,
  canMutate,
  canBulkMutate,
  bulkSelectedInstanceIds,
  bulkSelectedInstances,
  missingBulkSelectedInstanceIds,
}: {
  readonly selectedInstance?: TuiInstanceReadItem;
  readonly detailsOpen: boolean;
  readonly canConnect: boolean;
  readonly canMutate: boolean;
  readonly canBulkMutate: boolean;
  readonly bulkSelectedInstanceIds: readonly string[];
  readonly bulkSelectedInstances: readonly TuiInstanceReadItem[];
  readonly missingBulkSelectedInstanceIds: readonly string[];
}): readonly TuiContextAction[] {
  const actions: TuiContextAction[] = [
    { id: "new-instance", label: "Rent a server" },
    { id: "refresh", label: "Refresh servers" },
  ];
  if (selectedInstance !== undefined) {
    actions.unshift({
      id: "instance-details",
      label: detailsOpen ? "Hide technical details" : "Show technical details",
    });
    if (selectedInstance.freshness === "fresh" && canConnect) {
      actions.unshift({ id: "instance-connect", label: "Connect" });
    }
    if (
      selectedInstance.freshness === "fresh" &&
      selectedInstance.management === "discovered" &&
      canMutate
    ) {
      actions.push({ id: "instance-adopt", label: "Adopt for EasyServer management" });
    }
    if (canMutate) {
      for (const action of availableInstanceActions(selectedInstance)) {
        actions.push({
          id: `instance-action:${action}`,
          label: instanceActionLabel(action),
        });
      }
    }
    if (canBulkMutate && selectedInstance.freshness === "fresh") {
      actions.push({
        id: "instance-mark",
        label: bulkSelectedInstanceIds.includes(selectedInstance.id)
          ? "Remove from bulk selection"
          : "Add to bulk selection",
      });
    }
  }
  if (bulkSelectedInstanceIds.length > 0 && canBulkMutate) {
    actions.push({ id: "bulk-clear", label: "Clear bulk selection" });
    if (missingBulkSelectedInstanceIds.length === 0) {
      for (const action of bulkAvailableInstanceActions(bulkSelectedInstances)) {
        actions.push({
          id: `bulk-action:${action}`,
          label: `${action.slice("instance.".length)} ${bulkSelectedInstanceIds.length} selected server${bulkSelectedInstanceIds.length === 1 ? "" : "s"}`,
        });
      }
    }
  }
  return actions;
}

export function providerContextActions({
  selectedProvider,
  detailsOpen,
  canRegister,
  canAddInstalled,
  canMutate,
}: {
  readonly selectedProvider?: TuiProviderReadItem;
  readonly detailsOpen: boolean;
  readonly canRegister: boolean;
  readonly canAddInstalled: boolean;
  readonly canMutate: boolean;
}): readonly TuiContextAction[] {
  const actions: TuiContextAction[] = [{ id: "refresh", label: "Refresh providers" }];
  if (canRegister) {
    actions.unshift({
      id: "provider-add-advanced",
      label: "Advanced: add module or path",
    });
    if (canAddInstalled) {
      actions.unshift({
        id: "provider-add-installed",
        label: "Add installed provider",
      });
    }
  }
  if (selectedProvider !== undefined) {
    actions.unshift({
      id: "provider-details",
      label: detailsOpen ? "Hide provider details" : "Show provider details",
    });
    if (
      canMutate &&
      selectedProvider.state !== "disabled" &&
      selectedProvider.state !== "failed" &&
      (selectedProvider.credentials.items?.length ?? 0) > 0
    ) {
      actions.push({ id: "provider-credentials", label: "Manage credentials" });
    }
    if (canMutate) {
      actions.push({
        id: "provider-toggle",
        label: selectedProvider.state === "disabled" ? "Enable provider" : "Disable provider",
      });
    }
  }
  return actions;
}

export function rentContextActions(hasWorkflow: boolean): readonly TuiContextAction[] {
  const actions: TuiContextAction[] = [
    { id: "refresh", label: "Refresh acquisition options" },
  ];
  if (!hasWorkflow) {
    actions.unshift({ id: "providers", label: "Open Providers" });
  }
  return actions;
}

export function connectionContextActions({
  detailsOpen,
  canStartForeground,
  hasNoServers,
  selectedTarget,
  selectedForeground,
  selectedIntent,
  canRetryForeground,
  canCloseForeground,
  canClosePersistent,
  canCreatePersistent,
  canManageDaemon,
  daemonRunning,
  canSetIntentEnabled,
  canReviewIntentHostTrust,
  canRetryIntent,
  canRemoveIntent,
}: {
  readonly detailsOpen: boolean;
  readonly canStartForeground: boolean;
  readonly hasNoServers: boolean;
  readonly selectedTarget?: TuiConnectionTarget;
  readonly selectedForeground?: TuiForegroundConnection;
  readonly selectedIntent?: TuiEndpointIntentReadItem;
  readonly canRetryForeground: boolean;
  readonly canCloseForeground: boolean;
  readonly canClosePersistent: boolean;
  readonly canCreatePersistent: boolean;
  readonly canManageDaemon: boolean;
  readonly daemonRunning: boolean;
  readonly canSetIntentEnabled: boolean;
  readonly canReviewIntentHostTrust: boolean;
  readonly canRetryIntent: boolean;
  readonly canRemoveIntent: boolean;
}): readonly TuiContextAction[] {
  const actions: TuiContextAction[] = [
    { id: "connection-details", label: detailsOpen ? "Hide technical details" : "Show technical details" },
    { id: "refresh", label: "Refresh connections" },
  ];
  if (canStartForeground) {
    actions.unshift({ id: "connection-new-foreground", label: "New local connection" });
  } else if (hasNoServers) {
    actions.unshift({ id: "new-instance", label: "Rent a server" });
  }
  if (selectedTarget?.kind === "foreground" && selectedForeground?.state === "failed") {
    if (foregroundConnectionCanRetry(selectedForeground) && canRetryForeground) {
      actions.push({ id: "connection-retry-foreground", label: "Retry connection" });
    }
    if (foregroundConnectionNeedsServicePortEdit(selectedForeground) && canCloseForeground) {
      actions.push({ id: "connection-edit-service-port", label: "Edit service port" });
    }
    if (canCloseForeground) {
      actions.push({ id: "connection-close-foreground", label: "Dismiss failed connection" });
    }
  } else if (selectedTarget?.kind === "foreground" && canCloseForeground) {
    actions.push({ id: "connection-close-foreground", label: "Close local connection" });
  } else if (selectedTarget?.kind === "persistent" && canClosePersistent) {
    actions.push({ id: "connection-close-persistent", label: "Close local connection" });
  }
  if (detailsOpen) {
    if (canCreatePersistent) {
      actions.push({ id: "connection-new-persistent", label: "Advanced: new background connection" });
    }
    if (canManageDaemon) {
      actions.push({
        id: "daemon-toggle",
        label: daemonRunning
          ? "Advanced: stop background connection service"
          : "Advanced: start background connection service",
      });
    }
    if (selectedIntent !== undefined && canSetIntentEnabled) {
      actions.push({
        id: "intent-toggle",
        label: selectedIntent.enabled ? "Disable selected saved connection" : "Enable selected saved connection",
      });
      if (
        selectedIntent.state === "error" &&
        selectedIntent.failure?.hostTrust !== undefined &&
        canReviewIntentHostTrust
      ) {
        actions.push({ id: "intent-host-trust", label: "Review SSH fingerprint" });
      }
      if (selectedIntent.state === "error" && canRetryIntent) {
        actions.push({ id: "intent-retry", label: "Retry selected saved connection" });
      }
      if (canRemoveIntent) {
        actions.push({ id: "intent-remove", label: "Remove selected saved connection" });
      }
    }
  }
  return actions;
}

export function diagnosticsContextActions(
  diagnostics: TuiDiagnosticsView,
  canCopy: boolean,
): readonly TuiContextAction[] {
  const actions: TuiContextAction[] = [{ id: "refresh", label: "Refresh diagnostics" }];
  if (diagnostics.status === "ready") {
    actions.unshift({ id: "diagnostics-view", label: "View report" });
    if (canCopy) {
      actions.push({ id: "diagnostics-copy", label: "Copy report" });
    }
  }
  actions.push(
    { id: "providers", label: "Open Providers" },
    { id: "connections", label: "Open Connections" },
  );
  return actions;
}
