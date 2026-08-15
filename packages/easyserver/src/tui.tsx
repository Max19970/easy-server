import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Text,
  render,
  type Instance as InkInstance,
  useApp,
  useInput,
  useWindowSize,
} from "ink";
import { TuiOperationDrawer } from "./tui-operation-drawer.js";
import { ProviderInteractiveSurface } from "./tui-provider-interactive.js";
import {
  isTuiOperationPresentation,
  presentBulkInstanceResult,
  presentCompletedOperation,
  presentHostTrustRequest,
  presentMutationConfirmation,
  presentOperationError,
  presentProviderExecution,
  presentRetryableCleanupFailure,
  presentWorkingOperation,
  type TuiOperationActionKind,
  type TuiOperationPresentation,
} from "./tui-operation-model.js";
import {
  loadDefaultTuiReadSnapshot,
  type TuiEndpointIntentReadItem,
  type TuiInstanceReadItem,
  type TuiPersistentSessionReadItem,
  type TuiProviderCandidateReadItem,
  type TuiProviderWorkflowReadItem,
  type TuiReadSnapshot,
} from "./tui-read-model.js";
import {
  createDefaultTuiProviderFlowOpener,
  type TuiProviderFlowOpener,
} from "./tui-provider-flow-operations.js";
import type {
  ProviderFeatureInteraction,
  ProviderInteractiveSessionHandle,
} from "./provider-feature-operations.js";
import {
  createDefaultTuiProviderMutationRunner,
  type TuiProviderMutation,
  type TuiProviderMutationRunner,
} from "./tui-provider-operations.js";
import {
  createDefaultTuiBulkInstanceMutationRunner,
  createDefaultTuiInstanceMutationRunner,
  type TuiBulkInstanceMutation,
  type TuiBulkInstanceMutationRunner,
  type TuiInstanceMutation,
  type TuiInstanceMutationRunner,
} from "./tui-instance-operations.js";
import type {
  BulkInstanceDestroyConfirmationDetails,
  InstanceDestroyConfirmationDetails,
} from "./instance-operations.js";
import type { AccessMethodDescriptor } from "./connection-gateway.js";
import {
  createDefaultTuiForegroundConnectionOperations,
  type TuiForegroundConnection,
  type TuiForegroundConnectionOperations,
  type TuiForegroundConnectionRequest,
} from "./tui-foreground-connections.js";
import {
  createDefaultTuiDaemonOperations,
  newTuiPersistentSessionIdempotencyKey,
  type TuiDaemonOperations,
  type TuiPersistentSessionRequest,
} from "./tui-daemon-operations.js";
import {
  createDefaultTuiDiagnosticsOperations,
  serializeTuiDiagnostics,
  type TuiDiagnosticsOperations,
} from "./tui-diagnostics.js";
import {
  isNormalizedError,
  normalizedError,
  PROVIDER_CAPABILITIES,
  type AvailableAction,
  type OperationContext,
  type ProviderInteractiveEvent,
  type ProviderInteractiveScreen,
} from "@easyai101/easyserver-plugin-sdk";
import { moveTuiFocus, tuiFocusWindow } from "./tui-focus.js";
import { escapeTerminalText } from "./terminal-text.js";
import { EASYSERVER_VERSION } from "./version.js";

type TuiDiagnosticsView =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly text: string;
    };

type TuiRouteId =
  | "overview"
  | "instances"
  | "sessions"
  | "settings"
  | "providers"
  | "new-instance"
  | "diagnostics";

interface TuiRoute {
  readonly id: TuiRouteId;
  readonly label: string;
  readonly description: string;
  readonly body: string;
}

interface TuiContextAction {
  readonly id: string;
  readonly label: string;
}

type TuiConnectionTarget =
  | { readonly kind: "foreground"; readonly id: string }
  | { readonly kind: "intent"; readonly id: string }
  | { readonly kind: "persistent"; readonly id: string };

const routes: readonly TuiRoute[] = [
  {
    id: "overview",
    label: "Home",
    description: "Start with what you want to do",
    body: "Choose a task. EasyServer keeps provider and control-plane details out of the way until you need them.",
  },
  {
    id: "instances",
    label: "Servers",
    description: "Your rented and discovered compute",
    body: "Server inventory and lifecycle actions appear here.",
  },
  {
    id: "sessions",
    label: "Connections",
    description: "Local access to services on your servers",
    body: "Open and manage local connections to remote services here.",
  },
  {
    id: "settings",
    label: "Settings & Support",
    description: "Providers, credentials and support tools",
    body: "Configure providers or inspect privacy-safe support information.",
  },
  {
    id: "providers",
    label: "Providers",
    description: "Provider setup and credentials",
    body: "Configure installed providers and their credentials here.",
  },
  {
    id: "new-instance",
    label: "Rent server",
    description: "Find and rent compute from a configured provider",
    body: "Choose a configured provider and follow its guided rental flow.",
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    description: "Privacy-safe health and support information",
    body: "Review support information without exposing secrets.",
  },
];

const homeDestinations = [
  { routeId: "new-instance" as const, label: "Rent a server", description: "Find compute and create a new server" },
  { routeId: "instances" as const, label: "My servers", description: "View, start, stop or manage rented servers" },
  { routeId: "sessions" as const, label: "Connections", description: "Expose a remote service on this computer" },
  { routeId: "settings" as const, label: "Settings & Support", description: "Providers, credentials and diagnostics" },
] as const;

const settingsDestinations = [
  { routeId: "providers" as const, label: "Providers", description: "Configure installed providers and credentials" },
  { routeId: "diagnostics" as const, label: "Diagnostics", description: "Check health and review a safe support report" },
] as const;

function parentRoute(routeId: TuiRouteId): TuiRouteId {
  if (routeId === "new-instance") {
    return "instances";
  }
  if (routeId === "providers" || routeId === "diagnostics") {
    return "settings";
  }
  return "overview";
}

function routeBreadcrumb(routeId: TuiRouteId): string {
  switch (routeId) {
    case "overview":
      return "Home";
    case "instances":
      return "Home › Servers";
    case "new-instance":
      return "Home › Servers › Rent server";
    case "sessions":
      return "Home › Connections";
    case "settings":
      return "Home › Settings & Support";
    case "providers":
      return "Home › Settings & Support › Providers";
    case "diagnostics":
      return "Home › Settings & Support › Diagnostics";
  }
}

export type TuiReadStatus = "idle" | "loading" | "ready" | "stale" | "failed";

type ProviderCredentialFlow =
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

interface ProviderCandidatePickerView {
  readonly items: readonly TuiProviderCandidateReadItem[];
  readonly cursor: number;
}

type ProviderCredentialFlowView =
  | Extract<ProviderCredentialFlow, { readonly kind: "picker" }>
  | Extract<ProviderCredentialFlow, { readonly kind: "actions" }>
  | {
      readonly kind: "secret";
      readonly providerSource: string;
      readonly credentialName: string;
      readonly hasSecret: boolean;
    };

interface PendingProviderFlowConfirmation {
  readonly resolve: (accepted: boolean) => void;
  readonly workingTitle: string;
}

interface PendingInstanceConfirmation {
  readonly resolve: (accepted: boolean) => void;
  readonly workingTitle: string;
  readonly bulkTargetIds?: readonly string[];
}

interface PendingHostTrustConfirmation {
  readonly resolve: (accepted: boolean) => void;
}

interface PendingDaemonStopConfirmation {
  readonly resolve: (stopped: boolean) => void;
}

interface PendingEndpointIntentRemoval {
  readonly intent: TuiEndpointIntentReadItem;
}

interface PendingEndpointIntentRemovalRetry {
  readonly intent: TuiEndpointIntentReadItem;
}

type ForegroundConnectionStep =
  | "instance"
  | "remote-host"
  | "remote-port"
  | "access-method"
  | "local-port"
  | "review";

interface ForegroundConnectionFlow {
  readonly mode: "foreground" | "persistent";
  readonly step: ForegroundConnectionStep;
  readonly instanceId: string;
  readonly remoteHost: string;
  readonly remotePort: string;
  readonly accessMethods: readonly AccessMethodDescriptor[];
  readonly accessMethodId?: string;
  readonly localPort: string;
  readonly idempotencyKey?: string;
}

export interface TuiShellProps {
  readonly width?: number;
  readonly height?: number;
  readonly colorEnabled?: boolean;
  readonly screenReader?: boolean;
  readonly operation?: TuiOperationPresentation;
  readonly onOperationAction?: (action: TuiOperationActionKind) => void;
  readonly readSnapshot?: TuiReadSnapshot;
  readonly readStatus?: TuiReadStatus;
  readonly diagnostics?: TuiDiagnosticsView;
  readonly onRefresh?: (routeId: TuiRouteId) => void;
  readonly onCopyDiagnostics?: () => Promise<boolean>;
  readonly onInstanceMutation?: (mutation: TuiInstanceMutation) => void;
  readonly onBulkInstanceMutation?: (mutation: TuiBulkInstanceMutation) => void;
  readonly foregroundConnections?: readonly TuiForegroundConnection[];
  readonly onListForegroundAccessMethods?: (
    instanceId: string,
  ) => Promise<readonly AccessMethodDescriptor[] | undefined>;
  readonly onOpenForegroundConnection?: (
    request: TuiForegroundConnectionRequest,
  ) => Promise<TuiForegroundConnection | undefined>;
  readonly onCloseForegroundConnection?: (id: string) => Promise<boolean>;
  readonly onQuitWithForegroundConnections?: () => Promise<boolean>;
  readonly onStartDaemon?: () => Promise<boolean>;
  readonly onStopDaemon?: () => Promise<boolean>;
  readonly onCreatePersistentSession?: (
    request: TuiPersistentSessionRequest,
  ) => Promise<boolean>;
  readonly onClosePersistentSession?: (id: string) => Promise<boolean>;
  readonly onSetEndpointIntentEnabled?: (name: string, enabled: boolean) => Promise<boolean>;
  readonly onRetryEndpointIntent?: (name: string) => Promise<boolean>;
  readonly onRemoveEndpointIntent?: (intent: TuiEndpointIntentReadItem) => void;
  readonly onProviderMutation?: (mutation: TuiProviderMutation) => void;
  readonly providerInteractiveScreen?: ProviderInteractiveScreen;
  readonly providerInteractiveDisabled?: boolean;
  readonly onOpenProviderWorkflow?: (workflow: TuiProviderWorkflowReadItem) => void;
  readonly onProviderInteractiveEvent?: (event: ProviderInteractiveEvent) => void;
  readonly onProviderInteractiveClose?: () => void;
  readonly navigateToInstanceId?: string;
  readonly onInstanceNavigationHandled?: () => void;
}

export function TuiShell({
  width,
  height,
  colorEnabled = true,
  screenReader = false,
  operation,
  onOperationAction,
  readSnapshot,
  readStatus = "idle",
  diagnostics = { status: "idle" },
  onRefresh,
  onCopyDiagnostics,
  onInstanceMutation,
  onBulkInstanceMutation,
  foregroundConnections = [],
  onListForegroundAccessMethods,
  onOpenForegroundConnection,
  onCloseForegroundConnection,
  onQuitWithForegroundConnections,
  onStartDaemon,
  onStopDaemon,
  onCreatePersistentSession,
  onClosePersistentSession,
  onSetEndpointIntentEnabled,
  onRetryEndpointIntent,
  onRemoveEndpointIntent,
  onProviderMutation,
  providerInteractiveScreen,
  providerInteractiveDisabled = false,
  onOpenProviderWorkflow,
  onProviderInteractiveEvent,
  onProviderInteractiveClose,
  navigateToInstanceId,
  onInstanceNavigationHandled,
}: TuiShellProps): React.ReactElement {
  if (operation !== undefined && !isTuiOperationPresentation(operation)) {
    throw new TypeError("TUI operation presentation must come from the presentation model");
  }

  const { exit } = useApp();
  const windowSize = useWindowSize();
  const columns = width ?? windowSize.columns ?? 80;
  const rows = height ?? windowSize.rows ?? 24;
  const narrow = columns < 72;
  const routeContentRows = Math.max(6, rows - 7);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [settingsCursor, setSettingsCursor] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [contentFocused, setContentFocused] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [actionCursor, setActionCursor] = useState(0);
  const [operationActionFocus, setOperationActionFocus] = useState(() => ({
    operation,
    cursor: defaultOperationActionIndex(operation),
  }));
  const operationActionCursor =
    operationActionFocus.operation === operation
      ? operationActionFocus.cursor
      : defaultOperationActionIndex(operation);
  const setOperationActionCursor = (
    update: React.SetStateAction<number>,
  ): void => {
    setOperationActionFocus((current) => {
      const currentCursor =
        current.operation === operation
          ? current.cursor
          : defaultOperationActionIndex(operation);
      return {
        operation,
        cursor:
          typeof update === "function" ? update(currentCursor) : update,
      };
    });
  };
  const [instanceDetailsOpen, setInstanceDetailsOpen] = useState(false);
  const [providerDetailsOpen, setProviderDetailsOpen] = useState(false);
  const [connectionDetailsOpen, setConnectionDetailsOpen] = useState(false);
  const [connectionCursor, setConnectionCursor] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [status, setStatus] = useState("Ready.");
  const [providerSourceInput, setProviderSourceInput] = useState<string | undefined>();
  const [providerCandidatePickerOpen, setProviderCandidatePickerOpen] = useState(false);
  const [providerCandidateCursor, setProviderCandidateCursor] = useState(0);
  const [providerCredentialFlow, setProviderCredentialFlow] =
    useState<ProviderCredentialFlow | undefined>();
  const [selectedProviderSource, setSelectedProviderSource] = useState<string | undefined>(
    () => firstProviderSource(readSnapshot),
  );
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | undefined>(
    () => firstInstanceId(readSnapshot),
  );
  const [bulkSelectedInstanceIds, setBulkSelectedInstanceIds] = useState<readonly string[]>([]);
  const [selectedWorkflowKey, setSelectedWorkflowKey] = useState<string | undefined>(
    () => firstWorkflowKey(readSnapshot),
  );
  const [foregroundConnectionFlow, setForegroundConnectionFlow] =
    useState<ForegroundConnectionFlow | undefined>();
  const [selectedForegroundConnectionId, setSelectedForegroundConnectionId] =
    useState<string | undefined>(() => foregroundConnections[0]?.id);
  const [foregroundConnectionBusy, setForegroundConnectionBusy] = useState(false);
  const [selectedPersistentSessionId, setSelectedPersistentSessionId] =
    useState<string | undefined>();
  const [selectedEndpointIntentName, setSelectedEndpointIntentName] =
    useState<string | undefined>();
  const [quitArmed, setQuitArmed] = useState(false);
  const activeRoute = routes[activeIndex] ?? routes[0];
  const operationInteractionOpen = operation?.interaction !== undefined;
  const providerItems =
    readSnapshot?.providers.status === "ready"
      ? readSnapshot.providers.items
      : [];
  const providerCandidateItems =
    readSnapshot?.providerCandidates?.status === "ready"
      ? readSnapshot.providerCandidates.items
      : [];
  const providerCandidatePickerView: ProviderCandidatePickerView | undefined =
    providerCandidatePickerOpen
      ? {
          items: providerCandidateItems,
          cursor: Math.min(
            providerCandidateCursor,
            Math.max(0, providerCandidateItems.length - 1),
          ),
        }
      : undefined;
  const effectiveSelectedProviderSource =
    selectedProviderSource !== undefined &&
    providerItems.some((provider) => provider.source === selectedProviderSource)
      ? selectedProviderSource
      : providerItems[0]?.source;
  const credentialFlowProvider = providerItems.find(
    (provider) => provider.source === providerCredentialFlow?.providerSource,
  );
  const credentialFlowItems = credentialFlowProvider?.credentials.items ?? [];
  const providerCredentialFlowView: ProviderCredentialFlowView | undefined =
    providerCredentialFlow === undefined
      ? undefined
      : providerCredentialFlow.kind === "secret"
        ? {
            kind: "secret",
            providerSource: providerCredentialFlow.providerSource,
            credentialName: providerCredentialFlow.credentialName,
            hasSecret: providerCredentialFlow.secret.length > 0,
          }
        : providerCredentialFlow;
  const workflowItems =
    readSnapshot?.providerWorkflows.status === "ready"
      ? readSnapshot.providerWorkflows.items.filter(
          (workflow) => workflow.operation === "mutation",
        )
      : [];
  const effectiveSelectedWorkflowKey =
    selectedWorkflowKey !== undefined &&
    workflowItems.some((workflow) => workflowKey(workflow) === selectedWorkflowKey)
      ? selectedWorkflowKey
      : workflowItems[0] === undefined
        ? undefined
        : workflowKey(workflowItems[0]);
  const inventoryItems =
    readSnapshot?.instances.status === "ready"
      ? readSnapshot.instances.items
      : [];
  const effectiveSelectedInstanceId =
    selectedInstanceId !== undefined &&
    inventoryItems.some((instance) => instance.id === selectedInstanceId)
      ? selectedInstanceId
      : undefined;
  const bulkSelectedInstances = inventoryItems.filter((instance) =>
    bulkSelectedInstanceIds.includes(instance.id),
  );
  const missingBulkSelectedInstanceIds = bulkSelectedInstanceIds.filter(
    (instanceId) => !inventoryItems.some((instance) => instance.id === instanceId),
  );
  const effectiveSelectedForegroundConnectionId =
    selectedForegroundConnectionId !== undefined &&
    foregroundConnections.some(
      (connection) => connection.id === selectedForegroundConnectionId,
    )
      ? selectedForegroundConnectionId
      : undefined;
  const persistentSessions =
    readSnapshot?.daemon.status === "running" &&
    readSnapshot.daemon.sessions.status === "ready"
      ? readSnapshot.daemon.sessions.items ?? []
      : [];
  const effectiveSelectedPersistentSessionId =
    selectedPersistentSessionId !== undefined &&
    persistentSessions.some((session) => session.id === selectedPersistentSessionId)
      ? selectedPersistentSessionId
      : undefined;
  const endpointIntents =
    readSnapshot?.daemon.status === "running" &&
    readSnapshot.daemon.endpointIntents.status === "ready"
      ? readSnapshot.daemon.endpointIntents.items ?? []
      : [];
  const effectiveSelectedEndpointIntentName =
    selectedEndpointIntentName !== undefined &&
    endpointIntents.some((intent) => intent.operationName === selectedEndpointIntentName)
      ? selectedEndpointIntentName
      : endpointIntents[0]?.operationName;
  const connectionTargets: readonly TuiConnectionTarget[] = [
    ...foregroundConnections.map((connection) => ({
      kind: "foreground" as const,
      id: connection.id,
    })),
    ...endpointIntents.map((intent) => ({
      kind: "intent" as const,
      id: intent.operationName,
    })),
    ...persistentSessions.map((session) => ({
      kind: "persistent" as const,
      id: session.id,
    })),
  ];
  const effectiveConnectionCursor =
    connectionTargets.length === 0
      ? 0
      : Math.min(connectionCursor, connectionTargets.length - 1);
  const selectedConnectionTarget = connectionTargets[effectiveConnectionCursor];

  useEffect(() => {
    setSelectedProviderSource((current) =>
      current !== undefined &&
      providerItems.some((provider) => provider.source === current)
        ? current
        : providerItems[0]?.source,
    );
    setSelectedInstanceId((current) =>
      current === undefined ? inventoryItems[0]?.id : current,
    );
    setSelectedWorkflowKey((current) =>
      current !== undefined &&
      workflowItems.some((workflow) => workflowKey(workflow) === current)
        ? current
        : workflowItems[0] === undefined
          ? undefined
          : workflowKey(workflowItems[0]),
    );
  }, [readSnapshot]);

  useEffect(() => {
    setSelectedForegroundConnectionId((current) =>
      current === undefined ? foregroundConnections[0]?.id : current,
    );
  }, [foregroundConnections]);

  useEffect(() => {
    setSelectedPersistentSessionId((current) =>
      current === undefined ? persistentSessions[0]?.id : current,
    );
    setSelectedEndpointIntentName((current) =>
      current !== undefined && endpointIntents.some((intent) => intent.operationName === current)
        ? current
        : endpointIntents[0]?.operationName,
    );
  }, [readSnapshot]);

  useEffect(() => {
    setConnectionCursor((current) =>
      connectionTargets.length === 0
        ? 0
        : Math.min(current, connectionTargets.length - 1),
    );
  }, [connectionTargets.length]);

  useEffect(() => {
    setInstanceDetailsOpen(false);
    setActionMenuOpen(false);
    setActionCursor(0);
  }, [effectiveSelectedInstanceId]);

  useEffect(() => {
    setProviderDetailsOpen(false);
    setActionMenuOpen(false);
    setActionCursor(0);
  }, [effectiveSelectedProviderSource]);

  useEffect(() => {
    if (navigateToInstanceId === undefined) {
      return;
    }
    if (!inventoryItems.some((instance) => instance.id === navigateToInstanceId)) {
      setStatus(
        `Instance ${navigateToInstanceId} is not visible in the refreshed inventory.`,
      );
      onInstanceNavigationHandled?.();
      return;
    }
    const instancesIndex = routes.findIndex((route) => route.id === "instances");
    const homeIndex = homeDestinations.findIndex((destination) => destination.routeId === "instances");
    setSelectedInstanceId(navigateToInstanceId);
    setActiveIndex(instancesIndex);
    setFocusedIndex(Math.max(0, homeIndex));
    setContentFocused(true);
    setStatus(`Opened ${navigateToInstanceId}.`);
    onInstanceNavigationHandled?.();
  }, [navigateToInstanceId, readSnapshot, onInstanceNavigationHandled]);

  const openRoute = (routeId: TuiRouteId, message?: string): void => {
    const index = routes.findIndex((route) => route.id === routeId);
    if (index < 0) {
      return;
    }
    setActiveIndex(index);
    const homeIndex = homeDestinations.findIndex((destination) => destination.routeId === routeId);
    if (homeIndex >= 0) {
      setFocusedIndex(homeIndex);
    }
    setContentFocused(routeId !== "overview");
    setActionMenuOpen(false);
    setActionCursor(0);
    setStatus(message ?? `Opened ${routes[index]?.label ?? "Home"}.`);
    if (routeId === "diagnostics") {
      onRefresh?.("diagnostics");
    }
  };

  const requestExit = (): void => {
    const count = foregroundConnections.length;
    if (count === 0) {
      exit();
      return;
    }
    if (!quitArmed) {
      setQuitArmed(true);
      setStatus(
        `${count} TUI-owned ${count === 1 ? "Endpoint is" : "Endpoints are"} live. Press q or Ctrl+C again to close ${count === 1 ? "it" : "them"} and quit.`,
      );
      return;
    }
    if (onQuitWithForegroundConnections === undefined) {
      setStatus("Cannot quit safely while TUI-owned Endpoints are still live.");
      return;
    }
    setStatus(`Closing ${count} TUI-owned ${count === 1 ? "Endpoint" : "Endpoints"} before exit.`);
    void onQuitWithForegroundConnections().then((closed) => {
      if (closed) {
        exit();
      } else {
        setQuitArmed(false);
      }
    });
  };

  const beginConnectionFlow = (mode: "foreground" | "persistent"): void => {
    const firstInstance =
      inventoryItems.find((instance) => instance.id === effectiveSelectedInstanceId) ??
      inventoryItems[0];
    if (mode === "persistent" && readSnapshot?.daemon.status !== "running") {
      setStatus("Start the EasyServer daemon before creating a persistent Endpoint.");
      return;
    }
    if (firstInstance === undefined) {
      setStatus(`No compute instance is available for a ${mode} connection.`);
      return;
    }
    if (
      onListForegroundAccessMethods === undefined ||
      (mode === "foreground"
        ? onOpenForegroundConnection === undefined
        : onCreatePersistentSession === undefined)
    ) {
      setStatus(`${mode === "foreground" ? "Foreground" : "Persistent"} connection creation is unavailable in this TUI session.`);
      return;
    }
    setForegroundConnectionFlow({
      mode,
      step: "instance",
      instanceId: firstInstance.id,
      remoteHost: "127.0.0.1",
      remotePort: "",
      accessMethods: [],
      accessMethodId: undefined,
      localPort: "",
      ...(mode === "persistent"
        ? { idempotencyKey: newTuiPersistentSessionIdempotencyKey() }
        : {}),
    });
    setStatus(`Choose the instance for this ${mode === "foreground" ? "TUI-owned" : "daemon-owned"} Endpoint.`);
  };

  const moveConnectionSelection = (direction: -1 | 1): void => {
    if (connectionTargets.length === 0) {
      return;
    }
    const nextIndex =
      (effectiveConnectionCursor + direction + connectionTargets.length) %
      connectionTargets.length;
    setConnectionCursor(nextIndex);
    setConnectionDetailsOpen(false);
    const target = connectionTargets[nextIndex];
    if (target?.kind === "foreground") {
      setSelectedForegroundConnectionId(target.id);
      setStatus("Selected foreground Endpoint.");
    } else if (target?.kind === "persistent") {
      setSelectedPersistentSessionId(target.id);
      setStatus("Selected persistent Session.");
    } else if (target?.kind === "intent") {
      setSelectedEndpointIntentName(target.id);
      setStatus("Selected persisted Endpoint intent.");
    }
  };

  const selectedInstance = inventoryItems.find(
    (instance) => instance.id === effectiveSelectedInstanceId,
  );
  const selectedProvider = providerItems.find(
    (provider) => provider.source === effectiveSelectedProviderSource,
  );
  const selectedTargetIntent =
    selectedConnectionTarget?.kind === "intent"
      ? endpointIntents.find((intent) => intent.operationName === selectedConnectionTarget.id)
      : undefined;

  const contextActions: readonly TuiContextAction[] = (() => {
    if (activeRoute.id === "overview" || activeRoute.id === "settings") {
      return [];
    }
    if (activeRoute.id === "instances") {
      const actions: TuiContextAction[] = [
        { id: "new-instance", label: "Rent a server" },
        { id: "refresh", label: "Refresh servers" },
      ];
      if (selectedInstance !== undefined) {
        actions.unshift({
          id: "instance-details",
          label: instanceDetailsOpen ? "Hide instance details" : "Show instance details",
        });
        if (
          selectedInstance.freshness === "fresh" &&
          selectedInstance.management === "discovered" &&
          onInstanceMutation !== undefined
        ) {
          actions.push({ id: "instance-adopt", label: "Adopt for EasyServer management" });
        }
        if (onInstanceMutation !== undefined) {
          for (const action of availableInstanceActions(selectedInstance)) {
            actions.push({
              id: `instance-action:${action}`,
              label: `${action.slice("instance.".length)} instance`,
            });
          }
        }
        if (onBulkInstanceMutation !== undefined && selectedInstance.freshness === "fresh") {
          actions.push({
            id: "instance-mark",
            label: bulkSelectedInstanceIds.includes(selectedInstance.id)
              ? "Remove from bulk selection"
              : "Add to bulk selection",
          });
        }
      }
      if (bulkSelectedInstanceIds.length > 0 && onBulkInstanceMutation !== undefined) {
        actions.push({ id: "bulk-clear", label: "Clear bulk selection" });
        if (missingBulkSelectedInstanceIds.length === 0) {
          for (const action of bulkAvailableInstanceActions(bulkSelectedInstances)) {
            actions.push({
              id: `bulk-action:${action}`,
              label: `${action.slice("instance.".length)} ${bulkSelectedInstanceIds.length} selected instance${bulkSelectedInstanceIds.length === 1 ? "" : "s"}`,
            });
          }
        }
      }
      return actions;
    }
    if (activeRoute.id === "providers") {
      const actions: TuiContextAction[] = [{ id: "refresh", label: "Refresh providers" }];
      if (onProviderMutation !== undefined) {
        actions.unshift({
          id: "provider-add-advanced",
          label: "Advanced: add module or path",
        });
        if (providerCandidateItems.length > 0) {
          actions.unshift({
            id: "provider-add-installed",
            label: "Add installed provider",
          });
        }
      }
      if (selectedProvider !== undefined) {
        actions.unshift({
          id: "provider-details",
          label: providerDetailsOpen ? "Hide provider details" : "Show provider details",
        });
        if (
          onProviderMutation !== undefined &&
          selectedProvider.state !== "disabled" &&
          selectedProvider.state !== "failed" &&
          (selectedProvider.credentials.items?.length ?? 0) > 0
        ) {
          actions.push({ id: "provider-credentials", label: "Manage credentials" });
        }
        if (onProviderMutation !== undefined) {
          actions.push({
            id: "provider-toggle",
            label: selectedProvider.state === "disabled" ? "Enable provider" : "Disable provider",
          });
        }
      }
      return actions;
    }
    if (activeRoute.id === "new-instance") {
      return [{ id: "refresh", label: "Refresh acquisition options" }];
    }
    if (activeRoute.id === "sessions") {
      const actions: TuiContextAction[] = [{ id: "refresh", label: "Refresh connections" }];
      if (selectedConnectionTarget !== undefined) {
        actions.unshift({
          id: "connection-details",
          label: connectionDetailsOpen ? "Hide connection details" : "Show connection details",
        });
      }
      if (onOpenForegroundConnection !== undefined && onListForegroundAccessMethods !== undefined) {
        actions.unshift({ id: "connection-new-foreground", label: "New foreground Endpoint" });
      }
      if (
        onCreatePersistentSession !== undefined &&
        onListForegroundAccessMethods !== undefined
      ) {
        actions.push({ id: "connection-new-persistent", label: "New persistent Endpoint" });
      }
      if (onStartDaemon !== undefined && onStopDaemon !== undefined) {
        actions.push({
          id: "daemon-toggle",
          label: readSnapshot?.daemon.status === "running" ? "Stop daemon" : "Start daemon",
        });
      }
      if (
        selectedConnectionTarget?.kind === "foreground" &&
        onCloseForegroundConnection !== undefined
      ) {
        actions.push({ id: "connection-close-foreground", label: "Close selected foreground Endpoint" });
      } else if (
        selectedConnectionTarget?.kind === "persistent" &&
        onClosePersistentSession !== undefined
      ) {
        actions.push({ id: "connection-close-persistent", label: "Close selected persistent Session" });
      } else if (selectedTargetIntent !== undefined && onSetEndpointIntentEnabled !== undefined) {
        actions.push({
          id: "intent-toggle",
          label: selectedTargetIntent.enabled ? "Disable selected saved Endpoint" : "Enable selected saved Endpoint",
        });
        if (selectedTargetIntent.state === "error" && onRetryEndpointIntent !== undefined) {
          actions.push({ id: "intent-retry", label: "Retry selected saved Endpoint" });
        }
        if (onRemoveEndpointIntent !== undefined) {
          actions.push({ id: "intent-remove", label: "Remove selected saved Endpoint" });
        }
      }
      return actions;
    }
    const actions: TuiContextAction[] = [{ id: "refresh", label: "Refresh diagnostics" }];
    if (diagnostics.status === "ready" && onCopyDiagnostics !== undefined) {
      actions.push({ id: "diagnostics-copy", label: "Copy reviewed diagnostics" });
    }
    actions.push(
      { id: "providers", label: "Open Providers" },
      { id: "connections", label: "Open Connections" },
    );
    return actions;
  })();

  const runContextAction = (id: string): void => {
    setActionMenuOpen(false);
    setActionCursor(0);
    if (id === "refresh") {
      setStatus(`Refresh requested for ${activeRoute.label}.`);
      onRefresh?.(activeRoute.id);
      return;
    }
    if (id === "new-instance") {
      openRoute("new-instance");
      return;
    }
    if (id === "providers") {
      openRoute("providers");
      return;
    }
    if (id === "connections") {
      openRoute("sessions");
      return;
    }
    if (id === "instance-details") {
      setInstanceDetailsOpen((open) => !open);
      return;
    }
    if (id === "instance-adopt" && selectedInstance !== undefined) {
      const mutation = { kind: "adopt", instanceId: selectedInstance.id } satisfies TuiInstanceMutation;
      onInstanceMutation?.(mutation);
      setStatus(instanceMutationStatus(mutation));
      return;
    }
    if (id.startsWith("instance-action:") && selectedInstance !== undefined) {
      const action = id.slice("instance-action:".length) as AvailableAction;
      const mutation = { kind: "action", instanceId: selectedInstance.id, action } satisfies TuiInstanceMutation;
      onInstanceMutation?.(mutation);
      setStatus(instanceMutationStatus(mutation));
      return;
    }
    if (id === "instance-mark" && selectedInstance !== undefined) {
      setBulkSelectedInstanceIds((current) =>
        current.includes(selectedInstance.id)
          ? current.filter((instanceId) => instanceId !== selectedInstance.id)
          : [...current, selectedInstance.id],
      );
      setStatus("Updated bulk selection.");
      return;
    }
    if (id === "bulk-clear") {
      setBulkSelectedInstanceIds([]);
      setStatus("Cleared bulk instance targets.");
      return;
    }
    if (id.startsWith("bulk-action:")) {
      const action = id.slice("bulk-action:".length) as AvailableAction;
      const mutation = {
        instanceIds: [...bulkSelectedInstanceIds],
        action,
      } satisfies TuiBulkInstanceMutation;
      onBulkInstanceMutation?.(mutation);
      setStatus(bulkInstanceMutationStatus(mutation));
      return;
    }
    if (id === "provider-details") {
      setProviderDetailsOpen((open) => !open);
      return;
    }
    if (id === "provider-add-installed") {
      setProviderCandidateCursor(0);
      setProviderCandidatePickerOpen(true);
      setStatus("Choose an installed provider to add.");
      return;
    }
    if (id === "provider-add-advanced") {
      setProviderSourceInput("");
      setStatus("Advanced provider registration: enter a module or path.");
      return;
    }
    if (id === "provider-credentials" && selectedProvider !== undefined) {
      const firstCredential = selectedProvider.credentials.items?.[0];
      if (firstCredential !== undefined) {
        setProviderCredentialFlow({
          kind: "picker",
          providerSource: selectedProvider.source,
          selectedName: firstCredential.name,
        });
        setStatus(`Managing credentials for ${selectedProvider.source}.`);
      }
      return;
    }
    if (id === "provider-toggle" && selectedProvider !== undefined) {
      onProviderMutation?.({
        kind: "set-enabled",
        source: selectedProvider.source,
        enabled: selectedProvider.state === "disabled",
      });
      setStatus(`${selectedProvider.state === "disabled" ? "Enabling" : "Disabling"} provider ${selectedProvider.source}.`);
      return;
    }
    if (id === "connection-details") {
      setConnectionDetailsOpen((open) => !open);
      return;
    }
    if (id === "connection-new-foreground") {
      beginConnectionFlow("foreground");
      return;
    }
    if (id === "connection-new-persistent") {
      beginConnectionFlow("persistent");
      return;
    }
    if (id === "daemon-toggle") {
      const action = readSnapshot?.daemon.status === "running" ? onStopDaemon : onStartDaemon;
      if (action !== undefined) {
        setForegroundConnectionBusy(true);
        void action().then(() => setForegroundConnectionBusy(false));
      }
      return;
    }
    if (
      id === "connection-close-foreground" &&
      selectedConnectionTarget?.kind === "foreground" &&
      onCloseForegroundConnection !== undefined
    ) {
      const connectionId = selectedConnectionTarget.id;
      setForegroundConnectionBusy(true);
      void onCloseForegroundConnection(connectionId).then((closed) => {
        setForegroundConnectionBusy(false);
        if (closed) {
          setSelectedForegroundConnectionId(undefined);
          setStatus("Foreground Endpoint closed.");
        }
      });
      return;
    }
    if (
      id === "connection-close-persistent" &&
      selectedConnectionTarget?.kind === "persistent" &&
      onClosePersistentSession !== undefined
    ) {
      const sessionId = selectedConnectionTarget.id;
      setForegroundConnectionBusy(true);
      void onClosePersistentSession(sessionId).then((closed) => {
        setForegroundConnectionBusy(false);
        if (closed) {
          setSelectedPersistentSessionId(undefined);
          setStatus("Persistent Session closed.");
        }
      });
      return;
    }
    if (id === "intent-toggle" && selectedTargetIntent !== undefined) {
      setForegroundConnectionBusy(true);
      void onSetEndpointIntentEnabled?.(
        selectedTargetIntent.operationName,
        !selectedTargetIntent.enabled,
      ).then(() => setForegroundConnectionBusy(false));
      return;
    }
    if (id === "intent-retry" && selectedTargetIntent !== undefined) {
      setForegroundConnectionBusy(true);
      void onRetryEndpointIntent?.(selectedTargetIntent.operationName).then(() =>
        setForegroundConnectionBusy(false),
      );
      return;
    }
    if (id === "intent-remove" && selectedTargetIntent !== undefined) {
      onRemoveEndpointIntent?.(selectedTargetIntent);
      return;
    }
    if (id === "diagnostics-copy" && diagnostics.status === "ready") {
      void onCopyDiagnostics?.().then((copied) =>
        setStatus(copied ? "Copied reviewed diagnostics." : "Diagnostics could not be copied."),
      );
    }
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      requestExit();
      return;
    }

    if (operation !== undefined) {
      if (operation.actions.length > 0) {
        if (key.downArrow) {
          setOperationActionCursor((current) =>
            moveTuiFocus(current, operation.actions.length, 1),
          );
          return;
        }
        if (key.upArrow) {
          setOperationActionCursor((current) =>
            moveTuiFocus(current, operation.actions.length, -1),
          );
          return;
        }
        if (key.return) {
          const action =
            operation.actions[
              Math.min(operationActionCursor, operation.actions.length - 1)
            ];
          if (action !== undefined) {
            onOperationAction?.(action.kind);
          }
          return;
        }
        if (key.escape) {
          const backAction =
            operation.actions.find((action) => action.kind === "decline") ??
            operation.actions.find((action) => action.kind === "dismiss");
          if (backAction !== undefined) {
            onOperationAction?.(backAction.kind);
            return;
          }
        }
      }
      const accelerator = operationActionForInput(operation, input, key);
      if (accelerator !== undefined) {
        onOperationAction?.(accelerator);
        return;
      }
      if (operationInteractionOpen) {
        return;
      }
    }

    if (providerInteractiveScreen !== undefined) {
      return;
    }

    if (providerCandidatePickerOpen) {
      if (input === "q") {
        requestExit();
        return;
      }
      if (key.escape) {
        setProviderCandidatePickerOpen(false);
        setStatus("Installed provider picker closed.");
        return;
      }
      if (key.downArrow && providerCandidateItems.length > 0) {
        setProviderCandidateCursor((current) =>
          moveTuiFocus(current, providerCandidateItems.length, 1),
        );
        return;
      }
      if (key.upArrow && providerCandidateItems.length > 0) {
        setProviderCandidateCursor((current) =>
          moveTuiFocus(current, providerCandidateItems.length, -1),
        );
        return;
      }
      if (key.return) {
        const candidate =
          providerCandidateItems[
            Math.min(providerCandidateCursor, providerCandidateItems.length - 1)
          ];
        if (candidate !== undefined) {
          onProviderMutation?.({ kind: "add-plugin", source: candidate.source });
          setProviderCandidatePickerOpen(false);
          setStatus(`Adding ${candidate.displayName}.`);
        }
      }
      return;
    }

    if (providerSourceInput !== undefined) {
      if (key.escape) {
        setProviderSourceInput(undefined);
        setStatus("Provider registration cancelled.");
        return;
      }
      if (key.return) {
        const source = providerSourceInput.trim();
        if (source.length > 0) {
          onProviderMutation?.({ kind: "add-plugin", source });
          setProviderSourceInput(undefined);
          setStatus(`Registering provider ${source}.`);
        }
        return;
      }
      if (key.backspace || key.delete) {
        setProviderSourceInput((current) => current?.slice(0, -1) ?? "");
        return;
      }
      if (!key.ctrl && !key.tab && input.length > 0) {
        setProviderSourceInput((current) => `${current ?? ""}${input}`);
      }
      return;
    }

    if (providerCredentialFlow !== undefined) {
      if (input === "q" && providerCredentialFlow.kind !== "secret") {
        requestExit();
        return;
      }

      if (providerCredentialFlow.kind === "picker") {
        if (key.escape) {
          setProviderCredentialFlow(undefined);
          setStatus("Credential setup closed.");
          return;
        }
        const currentIndex = Math.max(
          0,
          credentialFlowItems.findIndex(
            (credential) => credential.name === providerCredentialFlow.selectedName,
          ),
        );
        if ((key.downArrow || key.upArrow) && credentialFlowItems.length > 0) {
          const nextIndex = moveTuiFocus(
            currentIndex,
            credentialFlowItems.length,
            key.downArrow ? 1 : -1,
          );
          const next = credentialFlowItems[nextIndex];
          if (next !== undefined) {
            setProviderCredentialFlow({
              ...providerCredentialFlow,
              selectedName: next.name,
            });
          }
          return;
        }
        if (key.return) {
          const selected = credentialFlowItems.find(
            (credential) => credential.name === providerCredentialFlow.selectedName,
          );
          if (selected !== undefined) {
            setProviderCredentialFlow({
              kind: "actions",
              providerSource: providerCredentialFlow.providerSource,
              credentialName: selected.name,
              cursor: 0,
            });
            setStatus(`Choose what to do with credential ${selected.name}.`);
          }
        }
        return;
      }

      if (providerCredentialFlow.kind === "actions") {
        const selected = credentialFlowItems.find(
          (credential) => credential.name === providerCredentialFlow.credentialName,
        );
        const actionCount = selected?.configured ? 2 : 1;
        if (key.escape) {
          setProviderCredentialFlow({
            kind: "picker",
            providerSource: providerCredentialFlow.providerSource,
            selectedName: providerCredentialFlow.credentialName,
          });
          setStatus("Returned to credential selection.");
          return;
        }
        if (key.downArrow || key.upArrow) {
          setProviderCredentialFlow({
            ...providerCredentialFlow,
            cursor: moveTuiFocus(
              providerCredentialFlow.cursor,
              actionCount,
              key.downArrow ? 1 : -1,
            ),
          });
          return;
        }
        if (key.return && selected !== undefined) {
          if (providerCredentialFlow.cursor === 1 && selected.configured) {
            onProviderMutation?.({
              kind: "remove-credential",
              source: providerCredentialFlow.providerSource,
              name: selected.name,
            });
            setProviderCredentialFlow(undefined);
            setStatus(`Removing credential ${selected.name}.`);
            return;
          }
          setProviderCredentialFlow({
            kind: "secret",
            providerSource: providerCredentialFlow.providerSource,
            credentialName: selected.name,
            secret: "",
          });
          setStatus(`Enter a new value for credential ${selected.name}.`);
        }
        return;
      }

      if (key.escape) {
        setProviderCredentialFlow({
          kind: "actions",
          providerSource: providerCredentialFlow.providerSource,
          credentialName: providerCredentialFlow.credentialName,
          cursor: 0,
        });
        setStatus("Credential value entry cancelled.");
        return;
      }
      if (key.return) {
        if (providerCredentialFlow.secret.length > 0) {
          onProviderMutation?.({
            kind: "set-credential",
            source: providerCredentialFlow.providerSource,
            name: providerCredentialFlow.credentialName,
            secret: providerCredentialFlow.secret,
          });
          setProviderCredentialFlow(undefined);
          setStatus(`Configuring credential ${providerCredentialFlow.credentialName}.`);
        }
        return;
      }
      if (key.backspace || key.delete) {
        setProviderCredentialFlow((current) =>
          current?.kind === "secret"
            ? { ...current, secret: current.secret.slice(0, -1) }
            : current,
        );
        return;
      }
      if (!key.ctrl && !key.tab && input.length > 0) {
        setProviderCredentialFlow((current) =>
          current?.kind === "secret"
            ? { ...current, secret: `${current.secret}${input}` }
            : current,
        );
      }
      return;
    }

    if (
      foregroundConnectionFlow !== undefined &&
      input === "g" &&
      (operation?.phase === "failed" ||
        operation?.phase === "outcome-unknown" ||
        operation?.phase === "reconciliation-failed")
    ) {
      openRoute("diagnostics", "Opened privacy-safe Diagnostics from the connection failure.");
      return;
    }

    if (foregroundConnectionFlow !== undefined && activeRoute.id === "sessions") {
      if (foregroundConnectionBusy) {
        return;
      }
      if (key.escape) {
        const previousStep = previousForegroundConnectionStep(
          foregroundConnectionFlow.step,
        );
        if (previousStep === undefined) {
          setForegroundConnectionFlow(undefined);
          setStatus(
            foregroundConnectionFlow.mode === "persistent"
              ? "Persistent session setup cancelled."
              : "Foreground connection setup cancelled.",
          );
        } else {
          setForegroundConnectionFlow({
            ...foregroundConnectionFlow,
            step: previousStep,
          });
          setStatus("Returned to the previous connection step.");
        }
        return;
      }

      if (foregroundConnectionFlow.step === "instance") {
        if (
          (input === "j" || input === "k" || key.downArrow || key.upArrow) &&
          inventoryItems.length > 0
        ) {
          const forwards = input === "j" || key.downArrow;
          const currentIndex = Math.max(
            0,
            inventoryItems.findIndex(
              (instance) => instance.id === foregroundConnectionFlow.instanceId,
            ),
          );
          const nextIndex = forwards
            ? (currentIndex + 1) % inventoryItems.length
            : (currentIndex - 1 + inventoryItems.length) % inventoryItems.length;
          const next = inventoryItems[nextIndex];
          if (next !== undefined) {
            setForegroundConnectionFlow({
              ...foregroundConnectionFlow,
              instanceId: next.id,
              accessMethods: [],
              accessMethodId: undefined,
            });
          }
          return;
        }
        if (key.return && foregroundConnectionFlow.instanceId.length > 0) {
          setForegroundConnectionFlow({
            ...foregroundConnectionFlow,
            step: "remote-host",
          });
          setStatus("Enter the remote host. 127.0.0.1 is the ordinary default.");
        }
        return;
      }

      if (foregroundConnectionFlow.step === "remote-host") {
        if (key.backspace || key.delete) {
          setForegroundConnectionFlow({
            ...foregroundConnectionFlow,
            remoteHost: foregroundConnectionFlow.remoteHost.slice(0, -1),
          });
          return;
        }
        if (key.return) {
          if (foregroundConnectionFlow.remoteHost.trim().length === 0) {
            setStatus("Remote host cannot be empty.");
            return;
          }
          setForegroundConnectionFlow({
            ...foregroundConnectionFlow,
            remoteHost: foregroundConnectionFlow.remoteHost.trim(),
            step: "remote-port",
          });
          setStatus("Enter the remote TCP port.");
          return;
        }
        if (!key.ctrl && !key.tab && input.length > 0) {
          setForegroundConnectionFlow({
            ...foregroundConnectionFlow,
            remoteHost: `${foregroundConnectionFlow.remoteHost}${input}`,
          });
        }
        return;
      }

      if (foregroundConnectionFlow.step === "remote-port") {
        if (key.backspace || key.delete) {
          setForegroundConnectionFlow({
            ...foregroundConnectionFlow,
            remotePort: foregroundConnectionFlow.remotePort.slice(0, -1),
          });
          return;
        }
        if (key.return) {
          const remotePort = parseConnectionPort(
            foregroundConnectionFlow.remotePort,
          );
          if (remotePort === undefined) {
            setStatus("Remote port must be an integer between 1 and 65535.");
            return;
          }
          if (onListForegroundAccessMethods === undefined) {
            setStatus("Access Method discovery is unavailable in this TUI session.");
            return;
          }
          setForegroundConnectionBusy(true);
          setStatus("Discovering Access Methods for the selected instance.");
          void onListForegroundAccessMethods(foregroundConnectionFlow.instanceId).then(
            (methods) => {
              setForegroundConnectionBusy(false);
              if (methods === undefined) {
                return;
              }
              setForegroundConnectionFlow((current) =>
                current === undefined
                  ? current
                  : {
                      ...current,
                      step: "access-method",
                      accessMethods: methods,
                      accessMethodId: methods[0]?.id,
                    },
              );
              setStatus(
                methods.length === 0
                  ? "No TCP-forward Access Methods are currently available."
                  : `Selected deterministic default Access Method ${methods[0]?.id}.`,
              );
            },
          );
          return;
        }
        if (/^[0-9]$/.test(input)) {
          setForegroundConnectionFlow({
            ...foregroundConnectionFlow,
            remotePort: `${foregroundConnectionFlow.remotePort}${input}`,
          });
        }
        return;
      }

      if (foregroundConnectionFlow.step === "access-method") {
        if (
          (input === "j" || input === "k" || key.downArrow || key.upArrow) &&
          foregroundConnectionFlow.accessMethods.length > 0
        ) {
          const forwards = input === "j" || key.downArrow;
          const currentIndex = Math.max(
            0,
            foregroundConnectionFlow.accessMethods.findIndex(
              (method) => method.id === foregroundConnectionFlow.accessMethodId,
            ),
          );
          const nextIndex = forwards
            ? (currentIndex + 1) % foregroundConnectionFlow.accessMethods.length
            : (currentIndex - 1 + foregroundConnectionFlow.accessMethods.length) %
              foregroundConnectionFlow.accessMethods.length;
          const next = foregroundConnectionFlow.accessMethods[nextIndex];
          if (next !== undefined) {
            setForegroundConnectionFlow({
              ...foregroundConnectionFlow,
              accessMethodId: next.id,
            });
          }
          return;
        }
        if (key.return) {
          if (foregroundConnectionFlow.accessMethodId === undefined) {
            setStatus(
              "No TCP-forward Access Method is available. Choose another instance or refresh provider state.",
            );
            return;
          }
          setForegroundConnectionFlow({
            ...foregroundConnectionFlow,
            step: "local-port",
          });
          setStatus("Enter a stable local port, or leave it blank for a dynamic port.");
        }
        return;
      }

      if (foregroundConnectionFlow.step === "local-port") {
        if (key.backspace || key.delete) {
          setForegroundConnectionFlow({
            ...foregroundConnectionFlow,
            localPort: foregroundConnectionFlow.localPort.slice(0, -1),
          });
          return;
        }
        if (key.return) {
          if (
            foregroundConnectionFlow.localPort.length > 0 &&
            parseConnectionPort(foregroundConnectionFlow.localPort) === undefined
          ) {
            setStatus("Local port must be blank or an integer between 1 and 65535.");
            return;
          }
          setForegroundConnectionFlow({
            ...foregroundConnectionFlow,
            step: "review",
          });
          setStatus(
            foregroundConnectionFlow.mode === "persistent"
              ? "Review the persistent Endpoint and press Enter to create it."
              : "Review the foreground Endpoint and press Enter to open it.",
          );
          return;
        }
        if (/^[0-9]$/.test(input)) {
          setForegroundConnectionFlow({
            ...foregroundConnectionFlow,
            localPort: `${foregroundConnectionFlow.localPort}${input}`,
          });
        }
        return;
      }

      if (foregroundConnectionFlow.step === "review" && key.return) {
        const request = foregroundConnectionRequest(foregroundConnectionFlow);
        if (request === undefined) {
          setStatus("The connection request is incomplete.");
          return;
        }
        if (foregroundConnectionFlow.mode === "persistent") {
          if (
            onCreatePersistentSession === undefined ||
            foregroundConnectionFlow.idempotencyKey === undefined
          ) {
            setStatus("Persistent session creation is unavailable in this TUI session.");
            return;
          }
          setForegroundConnectionBusy(true);
          void onCreatePersistentSession({
            ...request,
            idempotencyKey: foregroundConnectionFlow.idempotencyKey,
          }).then((created) => {
            setForegroundConnectionBusy(false);
            if (!created) {
              setStatus(
                "Persistent Endpoint was not created. Values and idempotency key are preserved for retry.",
              );
              return;
            }
            setForegroundConnectionFlow(undefined);
            setStatus("Created daemon-owned persistent Endpoint.");
          });
          return;
        }
        if (onOpenForegroundConnection === undefined) {
          setStatus("Foreground connection creation is unavailable in this TUI session.");
          return;
        }
        setForegroundConnectionBusy(true);
        void onOpenForegroundConnection(request).then((connection) => {
          setForegroundConnectionBusy(false);
          if (connection === undefined) {
            setStatus(
              "Foreground Endpoint was not opened. Your entered values are preserved for editing.",
            );
            return;
          }
          setForegroundConnectionFlow(undefined);
          setSelectedForegroundConnectionId(connection.id);
          setStatus(
            `Opened TUI-owned Endpoint ${connection.endpoint.host}:${connection.endpoint.port}.`,
          );
        });
      }
      return;
    }

    if (actionMenuOpen) {
      if (key.escape) {
        setActionMenuOpen(false);
        setActionCursor(0);
        setStatus("Closed actions.");
        return;
      }
      if (contextActions.length === 0) {
        setActionMenuOpen(false);
        return;
      }
      if (key.downArrow) {
        setActionCursor((current) => moveTuiFocus(current, contextActions.length, 1));
        return;
      }
      if (key.upArrow) {
        setActionCursor((current) => moveTuiFocus(current, contextActions.length, -1));
        return;
      }
      if (key.return) {
        const action = contextActions[Math.min(actionCursor, contextActions.length - 1)];
        if (action !== undefined) {
          runContextAction(action.id);
        }
        return;
      }
      return;
    }

    if (contentFocused && key.escape) {
      const parent = parentRoute(activeRoute.id);
      openRoute(parent, `Back to ${routes.find((route) => route.id === parent)?.label ?? "Home"}.`);
      return;
    }

    if (contentFocused && (key.downArrow || key.upArrow)) {
      const forwards = key.downArrow;
      if (activeRoute.id === "settings") {
        setSettingsCursor((current) =>
          moveTuiFocus(current, settingsDestinations.length, forwards ? 1 : -1),
        );
        return;
      }
      if (activeRoute.id === "instances" && inventoryItems.length > 0) {
        const currentIndex = Math.max(
          0,
          inventoryItems.findIndex(
            (instance) => instance.id === effectiveSelectedInstanceId,
          ),
        );
        const nextIndex = forwards
          ? (currentIndex + 1) % inventoryItems.length
          : (currentIndex - 1 + inventoryItems.length) % inventoryItems.length;
        const next = inventoryItems[nextIndex];
        if (next !== undefined) {
          setSelectedInstanceId(next.id);
          setStatus(`Selected ${next.name ?? next.id}.`);
        }
        return;
      }
      if (activeRoute.id === "providers" && providerItems.length > 0) {
        const currentIndex = Math.max(
          0,
          providerItems.findIndex(
            (provider) => provider.source === effectiveSelectedProviderSource,
          ),
        );
        const nextIndex = forwards
          ? (currentIndex + 1) % providerItems.length
          : (currentIndex - 1 + providerItems.length) % providerItems.length;
        const next = providerItems[nextIndex];
        if (next !== undefined) {
          setSelectedProviderSource(next.source);
          setStatus(`Selected ${next.displayName ?? next.providerId ?? next.source}.`);
        }
        return;
      }
      if (activeRoute.id === "new-instance" && workflowItems.length > 0) {
        const currentIndex = Math.max(
          0,
          workflowItems.findIndex(
            (workflow) => workflowKey(workflow) === effectiveSelectedWorkflowKey,
          ),
        );
        const nextIndex = forwards
          ? (currentIndex + 1) % workflowItems.length
          : (currentIndex - 1 + workflowItems.length) % workflowItems.length;
        const next = workflowItems[nextIndex];
        if (next !== undefined) {
          setSelectedWorkflowKey(workflowKey(next));
          setStatus(`Selected ${next.providerId} acquisition flow.`);
        }
        return;
      }
      if (activeRoute.id === "sessions") {
        moveConnectionSelection(forwards ? 1 : -1);
        return;
      }
      return;
    }

    if (contentFocused && key.return) {
      if (activeRoute.id === "settings") {
        const destination = settingsDestinations[Math.min(settingsCursor, settingsDestinations.length - 1)];
        if (destination !== undefined) {
          openRoute(destination.routeId);
        }
        return;
      }
      if (
        activeRoute.id === "new-instance" &&
        effectiveSelectedWorkflowKey !== undefined
      ) {
        const selected = workflowItems.find(
          (workflow) => workflowKey(workflow) === effectiveSelectedWorkflowKey,
        );
        if (selected?.presentation.kind === "interactive-flow") {
          onOpenProviderWorkflow?.(selected);
          setStatus(`Opening ${selected.providerId}/${selected.commandName}.`);
        } else if (selected !== undefined) {
          setStatus(
            `${selected.providerId} does not expose a guided TUI flow for this operation. Open Advanced provider tools for manual operations.`,
          );
        }
        return;
      }
      if (contextActions.length > 0) {
        setActionMenuOpen(true);
        setActionCursor(0);
        setStatus(`Choose an action for ${activeRoute.label}.`);
      }
      return;
    }

    if (input === "q") {
      requestExit();
      return;
    }

    if (input === "?") {
      setHelpOpen((open) => !open);
      return;
    }

    if (key.escape) {
      if (helpOpen) {
        setHelpOpen(false);
      } else if (activeRoute.id !== "overview") {
        openRoute(parentRoute(activeRoute.id));
      }
      return;
    }

    if (helpOpen) {
      return;
    }

    if (input === "g") {
      openRoute("diagnostics", "Opened privacy-safe Diagnostics.");
      return;
    }

    if (activeRoute.id === "diagnostics") {
      if (input === "P") {
        openRoute("providers", "Opened Providers for remediation.");
        return;
      }
      if (input === "C") {
        openRoute("sessions", "Opened Connections for remediation.");
        return;
      }
      if (input === "c" && diagnostics.status === "ready" && onCopyDiagnostics !== undefined) {
        void onCopyDiagnostics().then((copied) => {
          setStatus(
            copied
              ? "Copied the reviewed privacy-safe Diagnostics payload."
              : "Diagnostics could not be copied; the reviewed payload is unchanged.",
          );
        });
        return;
      }
    }

    if (activeRoute.id === "sessions" && input === "n") {
      const firstInstance =
        inventoryItems.find((instance) => instance.id === effectiveSelectedInstanceId) ??
        inventoryItems[0];
      if (firstInstance === undefined) {
        setStatus("No compute instance is available for a foreground connection.");
        return;
      }
      if (
        onListForegroundAccessMethods === undefined ||
        onOpenForegroundConnection === undefined
      ) {
        setStatus("Foreground connection creation is unavailable in this TUI session.");
        return;
      }
      setForegroundConnectionFlow({
        mode: "foreground",
        step: "instance",
        instanceId: firstInstance.id,
        remoteHost: "127.0.0.1",
        remotePort: "",
        accessMethods: [],
        accessMethodId: undefined,
        localPort: "",
      });
      setStatus("Choose the instance for this TUI-owned foreground Endpoint.");
      return;
    }

    if (activeRoute.id === "sessions" && input === "p") {
      const firstInstance =
        inventoryItems.find((instance) => instance.id === effectiveSelectedInstanceId) ??
        inventoryItems[0];
      if (readSnapshot?.daemon.status !== "running") {
        setStatus("Start the EasyServer daemon before creating a persistent session.");
        return;
      }
      if (firstInstance === undefined) {
        setStatus("No compute instance is available for a persistent connection.");
        return;
      }
      if (
        onListForegroundAccessMethods === undefined ||
        onCreatePersistentSession === undefined
      ) {
        setStatus("Persistent session creation is unavailable in this TUI session.");
        return;
      }
      setForegroundConnectionFlow({
        mode: "persistent",
        step: "instance",
        instanceId: firstInstance.id,
        remoteHost: "127.0.0.1",
        remotePort: "",
        accessMethods: [],
        accessMethodId: undefined,
        localPort: "",
        idempotencyKey: newTuiPersistentSessionIdempotencyKey(),
      });
      setStatus("Choose the instance for this daemon-owned persistent Endpoint.");
      return;
    }

    if (activeRoute.id === "sessions" && input === "d") {
      setForegroundConnectionBusy(true);
      const action =
        readSnapshot?.daemon.status === "running" ? onStopDaemon : onStartDaemon;
      if (action === undefined) {
        setForegroundConnectionBusy(false);
        setStatus("Daemon lifecycle management is unavailable in this TUI session.");
        return;
      }
      void action().then(() => setForegroundConnectionBusy(false));
      return;
    }

    if (
      activeRoute.id === "sessions" &&
      persistentSessions.length > 0 &&
      (input === "J" || input === "K")
    ) {
      const currentIndex = persistentSessions.findIndex(
        (session) => session.id === effectiveSelectedPersistentSessionId,
      );
      const nextIndex =
        currentIndex < 0
          ? input === "J"
            ? 0
            : persistentSessions.length - 1
          : input === "J"
            ? (currentIndex + 1) % persistentSessions.length
            : (currentIndex - 1 + persistentSessions.length) %
              persistentSessions.length;
      const next = persistentSessions[nextIndex];
      if (next !== undefined) {
        setSelectedPersistentSessionId(next.id);
        setStatus(`Selected persistent Session ${next.id}.`);
      }
      return;
    }

    if (
      activeRoute.id === "sessions" &&
      input === "c" &&
      effectiveSelectedPersistentSessionId !== undefined &&
      onClosePersistentSession !== undefined
    ) {
      const sessionId = effectiveSelectedPersistentSessionId;
      setForegroundConnectionBusy(true);
      void onClosePersistentSession(sessionId).then((closed) => {
        setForegroundConnectionBusy(false);
        if (closed) {
          setSelectedPersistentSessionId(undefined);
          setStatus(`Closed persistent Session ${sessionId}.`);
        }
      });
      return;
    }

    if (
      activeRoute.id === "sessions" &&
      endpointIntents.length > 0 &&
      (input === "[" || input === "]")
    ) {
      const currentIndex = endpointIntents.findIndex(
        (intent) => intent.operationName === effectiveSelectedEndpointIntentName,
      );
      const nextIndex =
        currentIndex < 0
          ? input === "]"
            ? 0
            : endpointIntents.length - 1
          : input === "]"
            ? (currentIndex + 1) % endpointIntents.length
            : (currentIndex - 1 + endpointIntents.length) % endpointIntents.length;
      const next = endpointIntents[nextIndex];
      if (next !== undefined) {
        setSelectedEndpointIntentName(next.operationName);
        setStatus(`Selected persisted Endpoint intent ${next.name}.`);
      }
      return;
    }

    if (
      activeRoute.id === "sessions" &&
      input === "e" &&
      effectiveSelectedEndpointIntentName !== undefined &&
      onSetEndpointIntentEnabled !== undefined
    ) {
      const selected = endpointIntents.find(
        (intent) => intent.operationName === effectiveSelectedEndpointIntentName,
      );
      if (selected === undefined) {
        return;
      }
      setForegroundConnectionBusy(true);
      const enabled = !selected.enabled;
      void onSetEndpointIntentEnabled(selected.operationName, enabled).then((changed) => {
        setForegroundConnectionBusy(false);
        if (changed) {
          setStatus(`${enabled ? "Enabled" : "Disabled"} Endpoint intent ${selected.name}.`);
        }
      });
      return;
    }

    if (
      activeRoute.id === "sessions" &&
      input === "t" &&
      effectiveSelectedEndpointIntentName !== undefined &&
      onRetryEndpointIntent !== undefined
    ) {
      const selected = endpointIntents.find(
        (intent) => intent.operationName === effectiveSelectedEndpointIntentName,
      );
      if (selected?.state !== "error") {
        setStatus("Retry is available only for a persisted Endpoint intent in Error state.");
        return;
      }
      setForegroundConnectionBusy(true);
      void onRetryEndpointIntent(selected.operationName).then((retried) => {
        setForegroundConnectionBusy(false);
        if (retried) {
          setStatus(`Retry requested for Endpoint intent ${selected.name}.`);
        }
      });
      return;
    }

    if (
      activeRoute.id === "sessions" &&
      input === "X" &&
      effectiveSelectedEndpointIntentName !== undefined &&
      onRemoveEndpointIntent !== undefined
    ) {
      const selected = endpointIntents.find(
        (intent) => intent.operationName === effectiveSelectedEndpointIntentName,
      );
      if (selected !== undefined) {
        onRemoveEndpointIntent(selected);
      }
      return;
    }

    if (
      activeRoute.id === "sessions" &&
      foregroundConnections.length > 0 &&
      (input === "j" || input === "k")
    ) {
      const currentIndex = foregroundConnections.findIndex(
        (connection) => connection.id === effectiveSelectedForegroundConnectionId,
      );
      const nextIndex =
        currentIndex < 0
          ? input === "j"
            ? 0
            : foregroundConnections.length - 1
          : input === "j"
            ? (currentIndex + 1) % foregroundConnections.length
            : (currentIndex - 1 + foregroundConnections.length) %
              foregroundConnections.length;
      const next = foregroundConnections[nextIndex];
      if (next !== undefined) {
        setSelectedForegroundConnectionId(next.id);
        setStatus(
          `Selected foreground Endpoint ${next.endpoint.host}:${next.endpoint.port}.`,
        );
      }
      return;
    }

    if (
      activeRoute.id === "sessions" &&
      input === "x" &&
      effectiveSelectedForegroundConnectionId !== undefined &&
      onCloseForegroundConnection !== undefined
    ) {
      const connectionId = effectiveSelectedForegroundConnectionId;
      setForegroundConnectionBusy(true);
      void onCloseForegroundConnection(connectionId).then((closed) => {
        setForegroundConnectionBusy(false);
        if (closed) {
          setSelectedForegroundConnectionId(undefined);
          setStatus("Foreground Endpoint closed.");
        }
      });
      return;
    }

    if (
      activeRoute.id === "new-instance" &&
      workflowItems.length > 0 &&
      (input === "j" || input === "k")
    ) {
      const currentIndex = Math.max(
        0,
        workflowItems.findIndex(
          (workflow) => workflowKey(workflow) === effectiveSelectedWorkflowKey,
        ),
      );
      const nextIndex =
        input === "j"
          ? (currentIndex + 1) % workflowItems.length
          : (currentIndex - 1 + workflowItems.length) % workflowItems.length;
      const next = workflowItems[nextIndex];
      if (next !== undefined) {
        setSelectedWorkflowKey(workflowKey(next));
        setStatus(`Selected ${next.providerId}/${next.commandName}.`);
      }
      return;
    }

    if (
      activeRoute.id === "new-instance" &&
      key.return &&
      effectiveSelectedWorkflowKey !== undefined
    ) {
      const selected = workflowItems.find(
        (workflow) => workflowKey(workflow) === effectiveSelectedWorkflowKey,
      );
      if (selected !== undefined) {
        if (selected.presentation.kind === "interactive-flow") {
          onOpenProviderWorkflow?.(selected);
          setStatus(`Opening ${selected.providerId}/${selected.commandName}.`);
        } else {
          setStatus(
            `${selected.providerId} does not expose a guided TUI flow for this operation. Open Advanced provider tools for manual operations.`,
          );
        }
      }
      return;
    }

    if (
      activeRoute.id === "instances" &&
      inventoryItems.length > 0 &&
      (input === "j" || input === "k")
    ) {
      const currentIndex = inventoryItems.findIndex(
        (instance) => instance.id === effectiveSelectedInstanceId,
      );
      const nextIndex =
        currentIndex < 0
          ? input === "j"
            ? 0
            : inventoryItems.length - 1
          : input === "j"
            ? (currentIndex + 1) % inventoryItems.length
            : (currentIndex - 1 + inventoryItems.length) % inventoryItems.length;
      const next = inventoryItems[nextIndex];
      if (next !== undefined) {
        setSelectedInstanceId(next.id);
        setStatus(`Selected ${next.id}.`);
      }
      return;
    }

    if (
      activeRoute.id === "instances" &&
      input === "0" &&
      bulkSelectedInstanceIds.length > 0
    ) {
      setBulkSelectedInstanceIds([]);
      setStatus("Cleared bulk instance targets.");
      return;
    }

    if (
      activeRoute.id === "instances" &&
      input === " " &&
      effectiveSelectedInstanceId !== undefined &&
      onBulkInstanceMutation !== undefined
    ) {
      const selected = inventoryItems.find(
        (instance) => instance.id === effectiveSelectedInstanceId,
      );
      if (selected === undefined) {
        return;
      }
      if (selected.freshness !== "fresh") {
        setStatus(`Cannot mark ${selected.id}; refresh stale or unobserved state first.`);
        return;
      }
      setBulkSelectedInstanceIds((current) =>
        current.includes(selected.id)
          ? current.filter((instanceId) => instanceId !== selected.id)
          : [...current, selected.id],
      );
      setStatus(
        bulkSelectedInstanceIds.includes(selected.id)
          ? `Removed ${selected.id} from bulk targets.`
          : `Added ${selected.id} to bulk targets.`,
      );
      return;
    }

    if (
      activeRoute.id === "instances" &&
      bulkSelectedInstanceIds.length > 0 &&
      /^[1-9]$/.test(input)
    ) {
      if (onBulkInstanceMutation === undefined) {
        return;
      }
      if (missingBulkSelectedInstanceIds.length > 0) {
        setStatus(
          `Bulk targets changed during refresh; clear or reselect ${missingBulkSelectedInstanceIds.join(", ")}.`,
        );
        return;
      }
      if (bulkSelectedInstances.some((instance) => instance.freshness !== "fresh")) {
        setStatus("Bulk targets include stale state; refresh before dispatching a mutation.");
        return;
      }
      const action = bulkAvailableInstanceActions(bulkSelectedInstances)[Number(input) - 1];
      if (action !== undefined) {
        const mutation = {
          instanceIds: [...bulkSelectedInstanceIds],
          action,
        } satisfies TuiBulkInstanceMutation;
        onBulkInstanceMutation(mutation);
        setStatus(bulkInstanceMutationStatus(mutation));
      }
      return;
    }

    if (
      activeRoute.id === "instances" &&
      effectiveSelectedInstanceId !== undefined &&
      onInstanceMutation !== undefined
    ) {
      const selected = inventoryItems.find(
        (instance) => instance.id === effectiveSelectedInstanceId,
      );
      const mutation =
        selected === undefined ? undefined : instanceMutationForInput(selected, input);
      if (mutation !== undefined) {
        onInstanceMutation(mutation);
        setStatus(instanceMutationStatus(mutation));
        return;
      }
    }

    if (input === "r") {
      setStatus(`Refresh requested for ${activeRoute.label}.`);
      onRefresh?.(activeRoute.id);
      return;
    }

    if (key.return) {
      const destination = homeDestinations[Math.min(focusedIndex, homeDestinations.length - 1)];
      if (destination !== undefined) {
        openRoute(destination.routeId);
      }
      return;
    }

    if (key.upArrow) {
      setFocusedIndex((current) => moveTuiFocus(current, homeDestinations.length, -1));
      return;
    }
    if (key.downArrow) {
      setFocusedIndex((current) => moveTuiFocus(current, homeDestinations.length, 1));
    }
  });

  const accent = colorEnabled ? "cyan" : undefined;
  const muted = colorEnabled ? "gray" : undefined;

  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={accent} aria-label={`EasyServer ${EASYSERVER_VERSION}`}>
          EasyServer
        </Text>
        <Text color={muted}>v{EASYSERVER_VERSION}</Text>
      </Box>
      {activeRoute.id === "overview" && !operationInteractionOpen ? (
        <Text color={muted}>Remote compute, without the provider control panel.</Text>
      ) : null}

      {operationInteractionOpen && operation !== undefined ? (
        <Box flexGrow={1} minHeight={0} overflowY="hidden" justifyContent="center">
          <TuiOperationDrawer
            operation={operation}
            colorEnabled={colorEnabled}
            selectedActionIndex={Math.min(
              operationActionCursor,
              Math.max(0, operation.actions.length - 1),
            )}
          />
        </Box>
      ) : helpOpen ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={muted}>{routeBreadcrumb(activeRoute.id)}</Text>
          <HelpPanel colorEnabled={colorEnabled} />
        </Box>
      ) : activeRoute.id === "overview" ? (
        <HomeSurface cursor={Math.min(focusedIndex, homeDestinations.length - 1)} colorEnabled={colorEnabled} />
      ) : (
        <Box marginTop={1} flexDirection="column" flexGrow={1} minHeight={0}>
          <Text color={muted}>{routeBreadcrumb(activeRoute.id)}</Text>
          <Text bold>{activeRoute.label}</Text>
          <Text color={muted}>{activeRoute.description}</Text>
          <Box marginTop={1} flexDirection="column" flexGrow={1} minHeight={0}>
            {readSnapshot !== undefined && readStatus === "stale" ? (
              <Box flexDirection="column" marginBottom={1}>
                <Text bold>Some information could not be refreshed.</Text>
                <Text>Showing the previous snapshot; open Actions to try again.</Text>
              </Box>
            ) : null}
            <RouteSurface
              route={activeRoute}
              snapshot={readSnapshot}
              readStatus={readStatus}
              diagnostics={diagnostics}
              canCopyDiagnostics={onCopyDiagnostics !== undefined}
              narrow={narrow}
              height={routeContentRows}
              colorEnabled={colorEnabled}
              settingsCursor={settingsCursor}
              selectedInstanceId={selectedInstanceId}
              showInstanceDetails={instanceDetailsOpen}
              bulkSelectedInstanceIds={bulkSelectedInstanceIds}
              canMutateInstances={onInstanceMutation !== undefined}
              canBulkMutateInstances={onBulkInstanceMutation !== undefined}
              foregroundConnectionFlow={foregroundConnectionFlow}
              foregroundConnectionBusy={foregroundConnectionBusy}
              foregroundConnections={foregroundConnections}
              selectedForegroundConnectionId={selectedForegroundConnectionId}
              selectedPersistentSessionId={selectedPersistentSessionId}
              selectedEndpointIntentName={effectiveSelectedEndpointIntentName}
              selectedConnectionTarget={selectedConnectionTarget}
              showConnectionDetails={connectionDetailsOpen}
              canManageForegroundConnections={
                onOpenForegroundConnection !== undefined &&
                onCloseForegroundConnection !== undefined
              }
              canManagePersistentSessions={
                onCreatePersistentSession !== undefined &&
                onClosePersistentSession !== undefined
              }
              canManageEndpointIntents={
                onSetEndpointIntentEnabled !== undefined &&
                onRetryEndpointIntent !== undefined &&
                onRemoveEndpointIntent !== undefined
              }
              canManageDaemon={
                onStartDaemon !== undefined && onStopDaemon !== undefined
              }
              providerCandidatePicker={providerCandidatePickerView}
              providerSourceInput={providerSourceInput}
              providerCredentialFlow={providerCredentialFlowView}
              selectedProviderSource={effectiveSelectedProviderSource}
              showProviderDetails={providerDetailsOpen}
              canRegisterProvider={onProviderMutation !== undefined}
              selectedWorkflowKey={effectiveSelectedWorkflowKey}
              providerInteractiveScreen={providerInteractiveScreen}
              providerInteractiveDisabled={providerInteractiveDisabled}
              onProviderInteractiveEvent={onProviderInteractiveEvent}
              onProviderInteractiveClose={onProviderInteractiveClose}
            />
            {actionMenuOpen ? (
              <ContextActionMenu
                actions={contextActions}
                cursor={Math.min(actionCursor, Math.max(0, contextActions.length - 1))}
                colorEnabled={colorEnabled}
                maxRows={Math.max(4, routeContentRows - 2)}
              />
            ) : contentFocused && providerInteractiveScreen === undefined ? (
              <Box marginTop={1}>
                <Text color={muted}>Enter actions · Esc back</Text>
              </Box>
            ) : null}
          </Box>
        </Box>
      )}

      {operation === undefined || operationInteractionOpen ? null : (
        <Box marginTop={1}>
          <TuiOperationDrawer
            operation={operation}
            colorEnabled={colorEnabled}
            selectedActionIndex={Math.min(
              operationActionCursor,
              Math.max(0, operation.actions.length - 1),
            )}
          />
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        {status === "Ready." ? null : (
          <Text color={muted} aria-label={`Status: ${status}`}>{status}</Text>
        )}
        {screenReader ? (
          <Text>Commands: Up and Down move; Enter selects; Escape goes back; question mark opens help; Ctrl+C quits.</Text>
        ) : (
          <Text color={muted}>↑/↓ move · Enter select · Esc back · ? help · Ctrl+C quit</Text>
        )}

      </Box>
    </Box>
  );
}

function HomeSurface({ cursor, colorEnabled }: { readonly cursor: number; readonly colorEnabled: boolean }): React.ReactElement {
  const muted = colorEnabled ? "gray" : undefined;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>What do you want to do?</Text>
      <Box flexDirection="column" marginTop={1}>
        {homeDestinations.map((destination, index) => (
          <Box key={destination.routeId} flexDirection="column" marginBottom={index === homeDestinations.length - 1 ? 0 : 1}>
            <Text bold={index === cursor}>
              {index === cursor ? "> " : "  "}{destination.label}
            </Text>
            <Text color={muted}>  {destination.description}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function SettingsSurface({ cursor, colorEnabled }: { readonly cursor: number; readonly colorEnabled: boolean }): React.ReactElement {
  const muted = colorEnabled ? "gray" : undefined;
  return (
    <Box flexDirection="column">
      <Text>Choose what you want to configure or inspect.</Text>
      <Box flexDirection="column" marginTop={1}>
        {settingsDestinations.map((destination, index) => (
          <Box key={destination.routeId} flexDirection="column" marginBottom={index === settingsDestinations.length - 1 ? 0 : 1}>
            <Text bold={index === cursor}>
              {index === cursor ? "> " : "  "}{destination.label}
            </Text>
            <Text color={muted}>  {destination.description}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function ContextActionMenu({
  actions,
  cursor,
  colorEnabled,
  maxRows = 6,
}: {
  readonly actions: readonly TuiContextAction[];
  readonly cursor: number;
  readonly colorEnabled: boolean;
  readonly maxRows?: number;
}): React.ReactElement {
  const accent = colorEnabled ? "cyan" : undefined;
  const muted = colorEnabled ? "gray" : undefined;
  const window = tuiFocusWindow(cursor, actions.length, Math.max(1, maxRows - 2));
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>Actions</Text>
      {window.hiddenBefore > 0 ? <Text color={muted}>↑ {window.hiddenBefore} more</Text> : null}
      {actions.slice(window.start, window.end).map((action, visibleIndex) => {
        const index = window.start + visibleIndex;
        return (
          <Text
            key={action.id}
            bold={index === cursor}
            color={index === cursor ? accent : undefined}
          >
            {index === cursor ? "> " : "  "}{action.label}
          </Text>
        );
      })}
      {window.hiddenAfter > 0 ? <Text color={muted}>↓ {window.hiddenAfter} more</Text> : null}
      <Text>↑/↓ choose · Enter run · Esc close</Text>
    </Box>
  );
}

interface RouteSurfaceProps {
  readonly route: TuiRoute;
  readonly snapshot?: TuiReadSnapshot;
  readonly readStatus: TuiReadStatus;
  readonly diagnostics: TuiDiagnosticsView;
  readonly canCopyDiagnostics: boolean;
  readonly narrow: boolean;
  readonly height: number;
  readonly colorEnabled: boolean;
  readonly settingsCursor: number;
  readonly selectedInstanceId?: string;
  readonly showInstanceDetails: boolean;
  readonly bulkSelectedInstanceIds: readonly string[];
  readonly canMutateInstances: boolean;
  readonly canBulkMutateInstances: boolean;
  readonly foregroundConnectionFlow?: ForegroundConnectionFlow;
  readonly foregroundConnectionBusy: boolean;
  readonly foregroundConnections: readonly TuiForegroundConnection[];
  readonly selectedForegroundConnectionId?: string;
  readonly selectedPersistentSessionId?: string;
  readonly selectedEndpointIntentName?: string;
  readonly selectedConnectionTarget?: TuiConnectionTarget;
  readonly showConnectionDetails: boolean;
  readonly canManageForegroundConnections: boolean;
  readonly canManagePersistentSessions: boolean;
  readonly canManageEndpointIntents: boolean;
  readonly canManageDaemon: boolean;
  readonly providerCandidatePicker?: ProviderCandidatePickerView;
  readonly providerSourceInput?: string;
  readonly providerCredentialFlow?: ProviderCredentialFlowView;
  readonly selectedProviderSource?: string;
  readonly showProviderDetails: boolean;
  readonly canRegisterProvider: boolean;
  readonly selectedWorkflowKey?: string;
  readonly providerInteractiveScreen?: ProviderInteractiveScreen;
  readonly providerInteractiveDisabled: boolean;
  readonly onProviderInteractiveEvent?: (event: ProviderInteractiveEvent) => void;
  readonly onProviderInteractiveClose?: () => void;
}

function RouteSurface({
  route,
  snapshot,
  readStatus,
  diagnostics,
  canCopyDiagnostics,
  narrow,
  height,
  colorEnabled,
  settingsCursor,
  selectedInstanceId,
  showInstanceDetails,
  bulkSelectedInstanceIds,
  canMutateInstances,
  canBulkMutateInstances,
  foregroundConnectionFlow,
  foregroundConnectionBusy,
  foregroundConnections,
  selectedForegroundConnectionId,
  selectedPersistentSessionId,
  selectedEndpointIntentName,
  selectedConnectionTarget,
  showConnectionDetails,
  canManageForegroundConnections,
  canManagePersistentSessions,
  canManageEndpointIntents,
  canManageDaemon,
  providerCandidatePicker,
  providerSourceInput,
  providerCredentialFlow,
  selectedProviderSource,
  showProviderDetails,
  canRegisterProvider,
  selectedWorkflowKey,
  providerInteractiveScreen,
  providerInteractiveDisabled,
  onProviderInteractiveEvent,
  onProviderInteractiveClose,
}: RouteSurfaceProps): React.ReactElement {
  if (
    route.id !== "overview" &&
    route.id !== "instances" &&
    route.id !== "providers" &&
    route.id !== "new-instance" &&
    route.id !== "sessions" &&
    route.id !== "settings" &&
    route.id !== "diagnostics"
  ) {
    return <Text wrap="wrap">{route.body}</Text>;
  }

  if (route.id === "diagnostics") {
    return (
      <DiagnosticsSurface
        diagnostics={diagnostics}
        canCopy={canCopyDiagnostics}
      />
    );
  }

  if (route.id === "settings") {
    return <SettingsSurface cursor={settingsCursor} colorEnabled={colorEnabled} />;
  }

  if (snapshot === undefined) {
    if (readStatus === "loading") {
      return <Text>Loading EasyServer status…</Text>;
    }
    if (readStatus === "failed") {
      return <Text>Status snapshot unavailable. Use Retry in the operation drawer.</Text>;
    }
    return <Text wrap="wrap">{route.body}</Text>;
  }

  if (route.id === "overview") {
    return <OverviewSurface snapshot={snapshot} />;
  }
  if (route.id === "new-instance") {
    if (providerInteractiveScreen !== undefined) {
      return (
        <ProviderInteractiveSurface
          screen={providerInteractiveScreen}
          colorEnabled={false}
          disabled={providerInteractiveDisabled}
          height={height}
          onEvent={onProviderInteractiveEvent ?? (() => undefined)}
          onClose={onProviderInteractiveClose ?? (() => undefined)}
        />
      );
    }
    return (
      <NewInstanceSurface
        snapshot={snapshot}
        selectedWorkflowKey={selectedWorkflowKey}
      />
    );
  }
  if (route.id === "instances") {
    return (
      <InstancesSurface
        snapshot={snapshot}
        narrow={narrow}
        selectedInstanceId={selectedInstanceId}
        showDetails={showInstanceDetails}
        bulkSelectedInstanceIds={bulkSelectedInstanceIds}
        canMutate={canMutateInstances}
        canBulkMutate={canBulkMutateInstances}
      />
    );
  }
  if (route.id === "sessions") {
    return (
      <ConnectionsSurface
        snapshot={snapshot}
        flow={foregroundConnectionFlow}
        busy={foregroundConnectionBusy}
        connections={foregroundConnections}
        selectedConnectionId={selectedForegroundConnectionId}
        selectedPersistentSessionId={selectedPersistentSessionId}
        selectedEndpointIntentName={selectedEndpointIntentName}
        selectedConnectionTarget={selectedConnectionTarget}
        showDetails={showConnectionDetails}
        canManage={canManageForegroundConnections}
        canManagePersistent={canManagePersistentSessions}
        canManageIntents={canManageEndpointIntents}
        canManageDaemon={canManageDaemon}
      />
    );
  }
  return (
    <ProvidersSurface
      snapshot={snapshot}
      candidatePicker={providerCandidatePicker}
      sourceInput={providerSourceInput}
      credentialFlow={providerCredentialFlow}
      selectedSource={selectedProviderSource}
      showDetails={showProviderDetails}
      canRegister={canRegisterProvider}
    />
  );
}

function OverviewSurface({ snapshot }: { readonly snapshot: TuiReadSnapshot }): React.ReactElement {
  const providers = snapshot.providers;
  const instances = snapshot.instances;
  const providerItems = providers.status === "ready" ? providers.items : [];
  const instanceItems = instances.status === "ready" ? instances.items : [];
  const failedProviderOutcomes =
    instances.status === "ready"
      ? instances.providerOutcomes.filter((provider) => provider.status === "failed")
      : [];
  const readyProviders = providerItems.filter((provider) => provider.readiness === "ready").length;
  const missingCredentials = providerItems.filter(
    (provider) => provider.readiness === "credentials-missing",
  ).length;
  const failedPlugins = providerItems.filter((provider) => provider.state === "failed").length;
  const disabledPlugins = providerItems.filter((provider) => provider.state === "disabled").length;
  const runningInstances = instanceItems.filter((instance) => instance.state === "running").length;
  const staleInstances = instanceItems.filter((instance) => instance.freshness === "stale").length;
  const unobservedInstances = instanceItems.filter(
    (instance) => instance.freshness === "unobserved",
  ).length;

  return (
    <Box flexDirection="column">
      <Text bold>Ready to use</Text>
      {providers.status === "failed" ? (
        <Text>Providers unavailable: {providers.message}</Text>
      ) : providerItems.length === 0 ? (
        <Text>No provider plugins configured. Open Providers for the next setup step.</Text>
      ) : (
        <Text>
          Providers: {providerItems.length} configured · {readyProviders} ready{missingCredentials > 0 ? ` · ${missingCredentials} need setup` : ""}{disabledPlugins + failedPlugins > 0 ? ` · ${disabledPlugins + failedPlugins} unavailable` : ""}
        </Text>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text bold>Instances</Text>
        {instances.status === "failed" ? (
          <Text>Instance inventory unavailable: {instances.message}</Text>
        ) : instanceItems.length === 0 ? (
          <Text>{instanceEmptyGuidance(snapshot)}</Text>
        ) : (
          <Text>
            Instances: {instanceItems.length} total · {runningInstances} running{staleInstances + unobservedInstances > 0 ? ` · ${staleInstances + unobservedInstances} need refresh` : ""}
          </Text>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Connections</Text>
        <Text>
          Daemon: {snapshot.daemon.status}{snapshot.daemon.status === "running" && snapshot.daemon.sessions.status === "ready" ? ` · ${snapshot.daemon.sessions.live} live persistent` : ""}
        </Text>
      </Box>

      {failedProviderOutcomes.length === 0 ? null : (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Provider issues</Text>
          {failedProviderOutcomes.map((provider) => (
            <Text key={provider.providerId}>
              {provider.providerId} · {provider.error.code} · {provider.error.message}
            </Text>
          ))}
          <Text>Healthy providers and instances above remain usable.</Text>
        </Box>
      )}


    </Box>
  );
}

function DiagnosticsSurface({
  diagnostics,
  canCopy,
}: {
  readonly diagnostics: TuiDiagnosticsView;
  readonly canCopy: boolean;
}): React.ReactElement {
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

  return (
    <Box flexDirection="column">
      <Text bold>User-safe Diagnostics payload</Text>
      <Text>
        This payload comes from EasyServer&apos;s shared sanitized diagnostics model. It excludes raw secrets, Secret References, daemon tokens, private keys and resource identifiers by contract.
      </Text>
      <Text>
        {canCopy
          ? "Use Actions to copy exactly the JSON shown below; nothing else is added."
          : "Clipboard integration is unavailable in this TUI session; the exact safe payload is still shown below."}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>{diagnostics.text}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Support guidance</Text>
        <Text>Raw logs are not the same as this sanitized payload. Review raw logs separately and never share credentials, tokens or private keys.</Text>
        <Text>Providers and Connections are available from Settings & Support or the Home task list.</Text>
      </Box>
    </Box>
  );
}

interface InstancesSurfaceProps {
  readonly snapshot: TuiReadSnapshot;
  readonly narrow: boolean;
  readonly selectedInstanceId?: string;
  readonly showDetails: boolean;
  readonly bulkSelectedInstanceIds: readonly string[];
  readonly canMutate: boolean;
  readonly canBulkMutate: boolean;
}

function InstancesSurface({
  snapshot,
  narrow,
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

  return (
    <Box flexDirection="column">
      {snapshot.instances.complete ? null : (
        <PartialInventoryNotice failedProviders={failedProviderOutcomes} />
      )}
      <Text>Choose an instance, then press Enter for its actions.</Text>
      <Box marginTop={1} flexDirection="column">
        {items.map((instance) => (
          <Text key={instance.id} bold={instance.id === selected?.id}>
            {instance.id === selected?.id ? "> " : "  "}
            {canBulkMutate ? (marked.has(instance.id) ? "[x] " : "[ ] ") : ""}
            {instance.name ?? instance.id} · {instance.providerId} · {instance.state ?? "unobserved"}
            {instance.freshness === "fresh" ? "" : ` · ${instance.freshness}`}
          </Text>
        ))}
      </Box>
      {bulkSelectedInstanceIds.length === 0 ? null : (
        <BulkInstanceSelection
          instanceIds={bulkSelectedInstanceIds}
          instances={markedInstances}
          missingInstanceIds={missingMarkedIds}
        />
      )}
      {selectionMissing ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Selected instance is no longer visible.</Text>
          <Text>
            {selectedInstanceId} disappeared from the refreshed inventory. No action target has been changed; use ↑/↓ to choose a current instance.
          </Text>
        </Box>
      ) : selected === undefined || !showDetails ? null : (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Instance detail</Text>
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
          <Text>Available actions: {formatActions(availableInstanceActions(selected))}</Text>
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

function ConnectionsSurface({
  snapshot,
  flow,
  busy,
  connections,
  selectedConnectionId,
  selectedPersistentSessionId,
  selectedEndpointIntentName,
  selectedConnectionTarget,
  showDetails,
  canManage,
  canManagePersistent,
  canManageIntents,
  canManageDaemon,
}: {
  readonly snapshot: TuiReadSnapshot;
  readonly flow?: ForegroundConnectionFlow;
  readonly busy: boolean;
  readonly connections: readonly TuiForegroundConnection[];
  readonly selectedConnectionId?: string;
  readonly selectedPersistentSessionId?: string;
  readonly selectedEndpointIntentName?: string;
  readonly selectedConnectionTarget?: TuiConnectionTarget;
  readonly showDetails: boolean;
  readonly canManage: boolean;
  readonly canManagePersistent: boolean;
  readonly canManageIntents: boolean;
  readonly canManageDaemon: boolean;
}): React.ReactElement {
  if (flow !== undefined) {
    const instances =
      snapshot.instances.status === "ready" ? snapshot.instances.items : [];
    const selectedInstance = instances.find(
      (instance) => instance.id === flow.instanceId,
    );
    const selectedMethod = flow.accessMethods.find(
      (method) => method.id === flow.accessMethodId,
    );
    return (
      <Box flexDirection="column">
        <Text bold>
          {flow.mode === "persistent" ? "New daemon-owned persistent Endpoint" : "New TUI-owned foreground Endpoint"}
        </Text>
        <Text>
          {flow.mode === "persistent"
            ? "This Endpoint survives TUI exit and is owned by the EasyServer daemon. Esc returns to the previous step."
            : "This Endpoint exists only while this TUI process is running. Esc returns to the previous step."}
        </Text>
        {busy ? <Text>Working… input is temporarily paused.</Text> : null}
        <Box marginTop={1} flexDirection="column">
          {flow.step === "instance" ? (
            <>
              <Text bold>Choose instance</Text>
              <Text>↑/↓ choose · Enter continue · Esc cancel</Text>
              {instances.length === 0 ? (
                <Text>No compute instances are currently available.</Text>
              ) : (
                instances.map((instance) => (
                  <Text key={instance.id} bold={instance.id === flow.instanceId}>
                    {instance.id === flow.instanceId ? "> " : "  "}
                    {instance.name ?? instance.id} · {instance.providerId} · {instance.state ?? "unobserved"}
                  </Text>
                ))
              )}
            </>
          ) : flow.step === "remote-host" ? (
            <>
              <Text bold>Remote host</Text>
              <Text>Host: {escapeTerminalText(flow.remoteHost)}</Text>
              <Text>Default: 127.0.0.1 · Enter continue · Backspace edit · Esc back</Text>
            </>
          ) : flow.step === "remote-port" ? (
            <>
              <Text bold>Remote TCP port</Text>
              <Text>Port: {flow.remotePort}</Text>
              <Text>Enter discovers Access Methods · Backspace edit · Esc back</Text>
            </>
          ) : flow.step === "access-method" ? (
            <>
              <Text bold>Access Method</Text>
              <Text>
                The first supported method is the deterministic default; the selected ID is passed explicitly when opening.
              </Text>
              {flow.accessMethods.length === 0 ? (
                <Text>
                  No TCP-forward Access Methods are currently available. Esc back and choose another instance or refresh provider state.
                </Text>
              ) : (
                flow.accessMethods.map((method, index) => (
                  <Text key={method.id} bold={method.id === flow.accessMethodId}>
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
              <Text bold>Local loopback port</Text>
              <Text>
                Local Endpoint: 127.0.0.1:{flow.localPort.length === 0 ? "dynamic" : flow.localPort}
              </Text>
              <Text>Leave blank for a dynamic port, or enter 1-65535 for a stable requested port.</Text>
              <Text>Enter continue · Backspace edit · Esc back</Text>
            </>
          ) : (
            <>
              <Text bold>
                Review {flow.mode === "persistent" ? "persistent" : "foreground"} Endpoint
              </Text>
              <Text>Instance: {selectedInstance?.name ?? flow.instanceId}</Text>
              <Text>
                Remote target: {escapeTerminalText(flow.remoteHost)}:{flow.remotePort}
              </Text>
              <Text>
                Access Method: {selectedMethod === undefined ? "unavailable" : escapeTerminalText(selectedMethod.id)}
              </Text>
              <Text>
                Local binding: 127.0.0.1:{flow.localPort.length === 0 ? "dynamic" : flow.localPort}
              </Text>
              <Text>
                Lifetime: {flow.mode === "persistent" ? "daemon-owned; survives TUI exit" : "closes when this TUI exits"}.
              </Text>
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
  return (
    <Box flexDirection="column">
      <Text>
        Foreground Endpoints belong to this TUI; persistent Endpoints belong to the daemon and survive TUI exit.
      </Text>
      <Text>
        Use ↑/↓ to move across existing connections and saved Endpoints. Press Enter for create, close, daemon and recovery actions.
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>TUI-owned foreground Endpoints</Text>
        {connections.length === 0 ? (
          <Text>
            None open. {snapshot.instances.status === "ready" && snapshot.instances.items.length === 0 ? "Create or discover an instance first." : "Press Enter for Actions to create one."}
          </Text>
        ) : (
          <>
            {connections.map((connection) => (
              <Text key={connection.id} bold={connection.id === selected?.id}>
                {connection.id === selected?.id ? "> " : "  "}
                {connection.endpoint.host}:{connection.endpoint.port} · {connection.state} · {connection.instanceId}
              </Text>
            ))}
            {selected === undefined || !showDetails ? null : (
              <Box marginTop={1} flexDirection="column">
                <Text bold>Foreground Endpoint details</Text>
                <Text>Instance: {selected.instanceId}</Text>
                <Text>Remote target: {escapeTerminalText(selected.remoteHost)}:{selected.remotePort}</Text>
                <Text>Access Method: {escapeTerminalText(selected.accessMethod.id)} · {escapeTerminalText(selected.accessMethod.kind)}</Text>
              </Box>
            )}
          </>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Persisted Endpoint intents (desired state)</Text>
        <Text>
          These definitions survive daemon restart. Live transport is shown separately and is recreated; an old dead transport is never treated as live.
        </Text>
        {snapshot.daemon.status !== "running" ? (
          <Text>Daemon must be running to inspect current intent realization state.</Text>
        ) : snapshot.daemon.endpointIntents.status === "unavailable" ? (
          <Text>Persisted intents exist independently, but current daemon intent status is temporarily unavailable.</Text>
        ) : endpointIntents.length === 0 ? (
          <Text>No persisted Endpoint intents configured.</Text>
        ) : (
          <>
            {endpointIntents.map((intent) => (
              <EndpointIntentLine
                key={intent.operationName}
                intent={intent}
                selected={intent.operationName === selectedIntent?.operationName}
              />
            ))}
            {selectedIntent === undefined || !showDetails ? null : (
              <EndpointIntentDetail intent={selectedIntent} />
            )}
          </>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Daemon-owned Connection Sessions (runtime state)</Text>
        <Text>Daemon: {snapshot.daemon.status}</Text>
        {snapshot.daemon.status === "stale" ? (
          <Text>Daemon state is stale because its descriptor is invalid. Start will reconcile the managed daemon state.</Text>
        ) : snapshot.daemon.status === "unreachable" ? (
          <Text>Daemon descriptor exists, but authenticated health failed. No session mutation is attempted.</Text>
        ) : snapshot.daemon.status === "stopped" ? (
          <Text>Daemon is stopped. Press Enter for actions to start it.</Text>
        ) : "sessions" in snapshot.daemon && snapshot.daemon.sessions.status === "unavailable" ? (
          <Text>Daemon is healthy, but Connection Session details are temporarily unavailable.</Text>
        ) : persistentSessions.length === 0 ? (
          <Text>No persistent sessions. Press Enter for actions to create one.</Text>
        ) : (
          <>
            {persistentSessions.map((session) => (
              <PersistentSessionLine
                key={session.id}
                session={session}
                selected={session.id === selectedPersistent?.id}
              />
            ))}
            {selectedPersistent === undefined || !showDetails ? null : (
              <PersistentSessionDetail session={selectedPersistent} />
            )}
          </>
        )}
      </Box>
    </Box>
  );
}

function PersistentSessionLine({
  session,
  selected,
}: {
  readonly session: TuiPersistentSessionReadItem;
  readonly selected: boolean;
}): React.ReactElement {
  const endpoint = session.endpoint === undefined
    ? "no local endpoint"
    : `${session.endpoint.host}:${session.endpoint.port}`;
  return (
    <Text bold={selected}>
      {selected ? "> " : "  "}{session.id} · {session.state} · {endpoint}
      {session.state === "failed" ? ` · ${session.failure?.code ?? "failure"}` : ""}
    </Text>
  );
}

function PersistentSessionDetail({
  session,
}: {
  readonly session: TuiPersistentSessionReadItem;
}): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>Persistent Session detail</Text>
      <Text>Session ID: {session.id}</Text>
      <Text>State: {session.state}</Text>
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
}: {
  readonly intent: TuiEndpointIntentReadItem;
  readonly selected: boolean;
}): React.ReactElement {
  const realization =
    intent.state === "live" && intent.endpoint !== undefined
      ? `live endpoint=${intent.endpoint.host}:${intent.endpoint.port}`
      : intent.state;
  return (
    <Text bold={selected}>
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
  const code = intent.failure?.code;
  const message = intent.failure?.message ?? "";
  if (code === "host-trust-required") {
    return "review and enroll the exact SSH host fingerprint through a normal TUI connection flow, then use Actions to retry this intent";
  }
  if (code === "authentication") {
    return "configure or rotate the required provider credential in Providers, then use Actions to retry";
  }
  if (code === "provider-unavailable") {
    return "restore provider or instance availability, refresh state, then use Actions to retry";
  }
  if (code === "conflict" && /port/i.test(message)) {
    return "the requested fixed local port is unavailable; free it, or remove and recreate the intent with another fixed or dynamic port, then retry";
  }
  if (code === "unsupported-operation") {
    return "restore a compatible provider Access Method, then use Actions to retry";
  }
  return "resolve the reported cause without deleting the desired intent, then use Actions to retry realization";
}

function NewInstanceSurface({
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
        <Text>Configure a provider first. Providers without a guided rental flow remain available under Advanced provider tools.</Text>
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

function ProvidersSurface({
  snapshot,
  candidatePicker,
  sourceInput,
  credentialFlow,
  selectedSource,
  showDetails,
  canRegister,
}: {
  readonly snapshot: TuiReadSnapshot;
  readonly candidatePicker?: ProviderCandidatePickerView;
  readonly sourceInput?: string;
  readonly credentialFlow?: ProviderCredentialFlowView;
  readonly selectedSource?: string;
  readonly showDetails: boolean;
  readonly canRegister: boolean;
}): React.ReactElement {
  if (candidatePicker !== undefined) {
    return (
      <Box flexDirection="column">
        <Text bold>Add an installed provider</Text>
        {candidatePicker.items.length === 0 ? (
          <Text>No discoverable installed Provider Plugins are available.</Text>
        ) : (
          candidatePicker.items.map((candidate, index) => (
            <Box key={candidate.source} flexDirection="column" marginTop={index === 0 ? 1 : 0}>
              <Text bold={index === candidatePicker.cursor}>
                {index === candidatePicker.cursor ? "> " : "  "}{candidate.displayName}
              </Text>
              {index !== candidatePicker.cursor || candidate.description === undefined ? null : (
                <Text>    {candidate.description}</Text>
              )}
            </Box>
          ))
        )}
        <Box marginTop={1}>
          <Text>↑/↓ choose · Enter add · Esc back</Text>
        </Box>
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
        {canRegister ? (
          <Text>Press Enter for Actions, then choose Add installed provider.</Text>
        ) : (
          <Text>Provider setup is unavailable in this TUI session.</Text>
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

function PartialInventoryNotice({
  failedProviders,
}: {
  readonly failedProviders: readonly Extract<
    TuiReadSnapshot["instances"],
    { readonly status: "ready" }
  >["providerOutcomes"][number][];
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>Some providers are unavailable.</Text>
      <Text>Available provider results remain usable.</Text>
      {failedProviders.map((provider) =>
        provider.status === "failed" ? (
          <Text key={provider.providerId}>
            {provider.providerId} · {provider.error.code} · {provider.error.message}
          </Text>
        ) : null,
      )}
      <Text>Open Providers or Diagnostics if you need to fix an unavailable provider, then refresh.</Text>
    </Box>
  );
}

function instanceEmptyGuidance(snapshot: TuiReadSnapshot): string {
  if (snapshot.providers.status === "failed") {
    return "No compute instances are visible. Provider configuration could not be inspected; resolve provider setup and refresh from Actions.";
  }
  if (snapshot.providers.items.length === 0) {
    return "No compute instances yet. Configure a provider first, then acquisition can create one.";
  }
  if (
    snapshot.instances.status === "ready" &&
    !snapshot.instances.complete &&
    snapshot.instances.providerOutcomes.some((provider) => provider.status === "failed")
  ) {
    return "No instances reported by available providers. Unavailable providers may have additional instances that are not visible right now.";
  }
  return "No compute instances yet. Providers are configured; use New instance when acquisition is enabled.";
}

function previousForegroundConnectionStep(
  step: ForegroundConnectionStep,
): ForegroundConnectionStep | undefined {
  if (step === "instance") {
    return undefined;
  }
  if (step === "remote-host") {
    return "instance";
  }
  if (step === "remote-port") {
    return "remote-host";
  }
  if (step === "access-method") {
    return "remote-port";
  }
  if (step === "local-port") {
    return "access-method";
  }
  return "local-port";
}

function parseConnectionPort(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) {
    return undefined;
  }
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? port
    : undefined;
}

function foregroundConnectionRequest(
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

function availableInstanceActions(
  instance: TuiInstanceReadItem,
): TuiInstanceReadItem["availableActions"] {
  if (instance.freshness !== "fresh") {
    return [];
  }
  return instance.availableActions.filter(
    (action) => action !== "instance.destroy" || instance.management === "managed",
  );
}

function bulkAvailableInstanceActions(
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

function instanceMutationForInput(
  instance: TuiInstanceReadItem,
  input: string,
): TuiInstanceMutation | undefined {
  if (
    input === "a" &&
    instance.freshness === "fresh" &&
    instance.management === "discovered"
  ) {
    return { kind: "adopt", instanceId: instance.id };
  }
  if (!/^[1-9]$/.test(input)) {
    return undefined;
  }
  const action = availableInstanceActions(instance)[Number(input) - 1];
  return action === undefined
    ? undefined
    : { kind: "action", instanceId: instance.id, action };
}

function instanceMutationStatus(mutation: TuiInstanceMutation): string {
  return mutation.kind === "adopt"
    ? `Adoption requested for ${mutation.instanceId}.`
    : `Requested ${mutation.action} for ${mutation.instanceId}.`;
}

function bulkInstanceMutationStatus(mutation: TuiBulkInstanceMutation): string {
  return `Requested ${mutation.action} for ${mutation.instanceIds.length} marked ${mutation.instanceIds.length === 1 ? "instance" : "instances"}.`;
}

function instanceMutationTitle(mutation: TuiInstanceMutation): string {
  if (mutation.kind === "adopt") {
    return "Adopt instance";
  }
  const action = mutation.action.slice("instance.".length);
  return `${action[0]?.toUpperCase() ?? ""}${action.slice(1)} instance`;
}

function instanceConfirmationTarget(
  details: InstanceDestroyConfirmationDetails,
): string {
  return `${escapeTerminalText(details.instanceId)} · provider=${escapeTerminalText(details.providerId)} · management=${details.management}`;
}

function bulkInstanceMutationTitle(mutation: TuiBulkInstanceMutation): string {
  const action = mutation.action.slice("instance.".length);
  return `${action[0]?.toUpperCase() ?? ""}${action.slice(1)} selected instances`;
}

function bulkInstanceConfirmationResources(
  details: BulkInstanceDestroyConfirmationDetails,
): readonly string[] {
  return details.targets.map((target) => {
    const provider =
      target.providerId === undefined
        ? "provider=unknown"
        : `provider=${escapeTerminalText(target.providerId)}`;
    const management =
      target.management === undefined
        ? "management=unknown"
        : `management=${target.management}`;
    return `${escapeTerminalText(target.instanceId)} · ${provider} · ${management}`;
  });
}

function destroyAffectedResources(
  details: InstanceDestroyConfirmationDetails,
): readonly string[] {
  return [
    ...details.impact.sessionIds.map(
      (sessionId) => `Session ${escapeTerminalText(sessionId)}`,
    ),
    ...details.impact.endpointIntentNames.map(
      (name) => `Endpoint intent ${escapeTerminalText(name)}`,
    ),
    ...(details.impact.pendingCleanupCount === 0
      ? []
      : [`${details.impact.pendingCleanupCount} pending connection cleanup(s)`]),
  ];
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
      <Text bold>
        Bulk targets ({instanceIds.length})
      </Text>
      {instanceIds.map((instanceId) => {
        const instance = instances.find((item) => item.id === instanceId);
        return instance === undefined ? (
          <Text key={instanceId}>{instanceId} · no longer visible</Text>
        ) : (
          <Text key={instanceId}>
            {instance.id} · provider={instance.providerId} · freshness={instance.freshness} · management={instance.management}
          </Text>
        );
      })}
      {missingInstanceIds.length === 0 ? null : (
        <Text>Bulk mutation is blocked until missing targets are cleared or visible again.</Text>
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

function formatActions(actions: readonly string[]): string {
  return actions.length === 0 ? "none" : actions.join(", ");
}

function workflowKey(workflow: TuiProviderWorkflowReadItem): string {
  return `${workflow.providerId}\u0000${workflow.featureId}\u0000${workflow.commandName}`;
}

function firstWorkflowKey(
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

function firstProviderSource(
  snapshot: TuiReadSnapshot | undefined,
): string | undefined {
  return snapshot?.providers.status === "ready"
    ? snapshot.providers.items[0]?.source
    : undefined;
}

function firstInstanceId(snapshot: TuiReadSnapshot | undefined): string | undefined {
  return snapshot?.instances.status === "ready"
    ? snapshot.instances.items[0]?.id
    : undefined;
}

function canStartInstanceMutation(
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

function defaultOperationActionIndex(
  operation: TuiOperationPresentation | undefined,
): number {
  if (operation?.interaction === undefined || operation.actions.length === 0) {
    return 0;
  }
  const safeIndex = operation.actions.findIndex(
    (action) => action.kind === "decline" || action.kind === "cancel",
  );
  return safeIndex >= 0 ? safeIndex : 0;
}

function operationActionForInput(
  operation: TuiOperationPresentation,
  input: string,
  key: { readonly escape: boolean; readonly return: boolean },
): TuiOperationActionKind | undefined {
  const available = new Set(operation.actions.map((action) => action.kind));

  if (key.return) {
    if (available.has("confirm")) {
      return "confirm";
    }
    if (available.has("trust")) {
      return "trust";
    }
    return undefined;
  }

  if (key.escape && available.has("decline")) {
    return "decline";
  }

  if (input === "c" && available.has("cancel")) {
    return "cancel";
  }
  if (input === "x" && available.has("dismiss")) {
    return "dismiss";
  }
  if (input === "o" && available.has("observe")) {
    return "observe";
  }
  if (input === "R" && available.has("refresh")) {
    return "refresh";
  }
  if (input === "R" && available.has("retry")) {
    return "retry";
  }
  return undefined;
}

function HelpPanel({ colorEnabled }: { readonly colorEnabled: boolean }): React.ReactElement {
  const accent = colorEnabled ? "cyan" : undefined;
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={accent}
      paddingX={1}
      aria-role="menu"
    >
      <Text bold>Keyboard help</Text>
      <Text>Arrow keys — move through visible choices, items and actions</Text>
      <Text>Enter — open, select, edit or run the focused action</Text>
      <Text>Esc — go back one level or close help</Text>
      <Text>Ctrl+C — quit safely</Text>
      <Text>? — toggle this help</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>Actions are shown in context after Enter; you do not need to memorize letter or number shortcuts.</Text>
        <Text>Live foreground Endpoints still require safe cleanup before exit; persistent Sessions survive TUI exit.</Text>
      </Box>
    </Box>
  );
}

export type TuiReadLoader = (
  context: OperationContext,
) => Promise<TuiReadSnapshot>;

export interface TuiAppProps {
  readonly colorEnabled?: boolean;
  readonly screenReader?: boolean;
  readonly readLoader?: TuiReadLoader;
  readonly instanceMutationRunner?: TuiInstanceMutationRunner;
  readonly bulkInstanceMutationRunner?: TuiBulkInstanceMutationRunner;
  readonly foregroundConnectionOperations?: TuiForegroundConnectionOperations;
  readonly daemonOperations?: TuiDaemonOperations;
  readonly diagnosticsOperations?: TuiDiagnosticsOperations;
  readonly providerMutationRunner?: TuiProviderMutationRunner;
  readonly providerFlowOpener?: TuiProviderFlowOpener;
}

export function TuiApp({
  colorEnabled = true,
  screenReader = false,
  readLoader,
  instanceMutationRunner,
  bulkInstanceMutationRunner,
  foregroundConnectionOperations,
  daemonOperations,
  diagnosticsOperations,
  providerMutationRunner,
  providerFlowOpener,
}: TuiAppProps): React.ReactElement {
  const [snapshot, setSnapshot] = useState<TuiReadSnapshot | undefined>();
  const [diagnostics, setDiagnostics] = useState<TuiDiagnosticsView>({ status: "idle" });
  const [operation, setOperation] = useState<TuiOperationPresentation | undefined>();
  const [foregroundConnections, setForegroundConnections] = useState<
    readonly TuiForegroundConnection[]
  >(() => foregroundConnectionOperations?.list() ?? []);
  const [pendingHostTrustConfirmation, setPendingHostTrustConfirmation] =
    useState<PendingHostTrustConfirmation | undefined>();
  const [pendingDaemonStopConfirmation, setPendingDaemonStopConfirmation] =
    useState<PendingDaemonStopConfirmation | undefined>();
  const [pendingEndpointIntentRemoval, setPendingEndpointIntentRemoval] =
    useState<PendingEndpointIntentRemoval | undefined>();
  const [pendingEndpointIntentRemovalRetry, setPendingEndpointIntentRemovalRetry] =
    useState<PendingEndpointIntentRemovalRetry | undefined>();
  const [pendingInstanceConfirmation, setPendingInstanceConfirmation] =
    useState<PendingInstanceConfirmation | undefined>();
  const [pendingProviderMutation, setPendingProviderMutation] =
    useState<TuiProviderMutation | undefined>();
  const [providerFlowHandle, setProviderFlowHandle] =
    useState<ProviderInteractiveSessionHandle | undefined>();
  const [providerFlowScreen, setProviderFlowScreen] =
    useState<ProviderInteractiveScreen | undefined>();
  const [pendingProviderFlowConfirmation, setPendingProviderFlowConfirmation] =
    useState<PendingProviderFlowConfirmation | undefined>();
  const [navigateToInstanceId, setNavigateToInstanceId] = useState<string | undefined>();
  const [snapshotStale, setSnapshotStale] = useState(false);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const bulkMutationControllerRef = useRef<AbortController | undefined>(undefined);
  const providerFlowBusyRef = useRef(false);
  const diagnosticsGenerationRef = useRef(0);

  const refreshDiagnostics = useCallback(async (): Promise<boolean> => {
    if (diagnosticsOperations === undefined) {
      setDiagnostics({
        status: "failed",
        message: "Privacy-safe Diagnostics are unavailable in this TUI session.",
      });
      return false;
    }

    const generation = diagnosticsGenerationRef.current + 1;
    diagnosticsGenerationRef.current = generation;
    setDiagnostics({ status: "loading" });
    try {
      const report = await diagnosticsOperations.load();
      if (diagnosticsGenerationRef.current !== generation) {
        return false;
      }
      setDiagnostics({
        status: "ready",
        text: serializeTuiDiagnostics(report),
      });
      return true;
    } catch {
      if (diagnosticsGenerationRef.current !== generation) {
        return false;
      }
      setDiagnostics({
        status: "failed",
        message: "Privacy-safe Diagnostics could not be generated.",
      });
      return false;
    }
  }, [diagnosticsOperations]);

  const copyDiagnostics = useCallback(async (): Promise<boolean> => {
    if (diagnosticsOperations === undefined || diagnostics.status !== "ready") {
      return false;
    }
    try {
      await diagnosticsOperations.copy(diagnostics.text);
      return true;
    } catch {
      return false;
    }
  }, [diagnostics, diagnosticsOperations]);

  const refresh = useCallback(async (
    options: { readonly quiet?: boolean } = {},
  ): Promise<boolean> => {
    if (readLoader === undefined) {
      return false;
    }

    setPendingEndpointIntentRemovalRetry(undefined);
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    if (options.quiet !== true) {
      setOperation(
        presentWorkingOperation({
          title: "Refresh EasyServer status",
          detail: "Reading provider, instance and daemon state.",
          activity: "loading",
          cancellable: true,
        }),
      );
    }

    try {
      const next = await readLoader({ signal: controller.signal });
      if (controllerRef.current !== controller || controller.signal.aborted) {
        return false;
      }
      setSnapshot(next);
      setSnapshotStale(false);
      if (options.quiet !== true) {
        setOperation(undefined);
      }
      return true;
    } catch (error) {
      if (controllerRef.current !== controller || controller.signal.aborted) {
        return false;
      }
      setSnapshotStale(true);
      if (options.quiet !== true) {
        setOperation(
          presentOperationError({
            title: "Refresh EasyServer status",
            operation: "read",
            error,
          }),
        );
      }
      return false;
    }
  }, [readLoader]);

  useEffect(() => {
    if (readLoader !== undefined) {
      void refresh();
    }
    return () => {
      controllerRef.current?.abort();
      bulkMutationControllerRef.current?.abort();
    };
  }, [readLoader, refresh]);

  useEffect(
    () => () => {
      void foregroundConnectionOperations?.closeAll().catch(() => undefined);
    },
    [foregroundConnectionOperations],
  );

  const listForegroundAccessMethods = useCallback(
    async (
      instanceId: string,
    ): Promise<readonly AccessMethodDescriptor[] | undefined> => {
      if (foregroundConnectionOperations === undefined) {
        return undefined;
      }
      setOperation(
        presentWorkingOperation({
          title: "Discover Access Methods",
          detail: `Reading supported TCP-forward access for ${instanceId}.`,
          activity: "loading",
        }),
      );
      try {
        const methods = await foregroundConnectionOperations.listAccessMethods(
          instanceId,
          { signal: new AbortController().signal },
        );
        setOperation(undefined);
        return methods;
      } catch (error) {
        setOperation(
          presentOperationError({
            title: "Discover Access Methods",
            operation: "read",
            error,
            allowRetry: false,
          }),
        );
        return undefined;
      }
    },
    [foregroundConnectionOperations],
  );

  const openForegroundConnection = useCallback(
    async (
      request: TuiForegroundConnectionRequest,
    ): Promise<TuiForegroundConnection | undefined> => {
      if (foregroundConnectionOperations === undefined) {
        return undefined;
      }
      setOperation(
        presentWorkingOperation({
          title: "Open foreground Endpoint",
          detail: `${request.instanceId} → ${request.remoteHost ?? "127.0.0.1"}:${request.remotePort}`,
          activity: "waiting-provider",
        }),
      );
      try {
        const connection = await foregroundConnectionOperations.open(
          request,
          { signal: new AbortController().signal },
          {
            confirmHostTrust(trust, signal) {
              if (signal.aborted) {
                return Promise.resolve(false);
              }
              return new Promise<boolean>((resolve) => {
                setPendingHostTrustConfirmation({ resolve });
                setOperation(presentHostTrustRequest(trust));
              });
            },
          },
        );
        setPendingHostTrustConfirmation(undefined);
        setForegroundConnections([...foregroundConnectionOperations.list()]);
        setOperation(undefined);
        return connection;
      } catch (error) {
        setPendingHostTrustConfirmation(undefined);
        setForegroundConnections([...foregroundConnectionOperations.list()]);
        setOperation(
          presentOperationError({
            title: "Open foreground Endpoint",
            operation: "read",
            error,
            allowRetry: false,
          }),
        );
        return undefined;
      }
    },
    [foregroundConnectionOperations],
  );

  const closeForegroundConnection = useCallback(
    async (id: string): Promise<boolean> => {
      if (foregroundConnectionOperations === undefined) {
        return false;
      }
      setOperation(
        presentWorkingOperation({
          title: "Close foreground Endpoint",
          detail: "Closing the TUI-owned local Endpoint and its access transport.",
          activity: "verifying-state",
        }),
      );
      const closing = foregroundConnectionOperations.close(id);
      setForegroundConnections([...foregroundConnectionOperations.list()]);
      try {
        await closing;
        setForegroundConnections([...foregroundConnectionOperations.list()]);
        setOperation(
          presentCompletedOperation({ title: "Foreground Endpoint closed" }),
        );
        return true;
      } catch (error) {
        setForegroundConnections([...foregroundConnectionOperations.list()]);
        setOperation(
          presentOperationError({
            title: "Close foreground Endpoint",
            operation: "read",
            error,
            allowRetry: false,
          }),
        );
        return false;
      }
    },
    [foregroundConnectionOperations],
  );

  const closeForegroundConnectionsForExit = useCallback(async (): Promise<boolean> => {
    if (foregroundConnectionOperations === undefined) {
      return foregroundConnections.length === 0;
    }
    const count = foregroundConnectionOperations.list().length;
    setOperation(
      presentWorkingOperation({
        title: `Closing ${count} TUI-owned ${count === 1 ? "Endpoint" : "Endpoints"}`,
        detail: "Foreground Endpoints close before the TUI exits.",
        activity: "verifying-state",
      }),
    );
    const closing = foregroundConnectionOperations.closeAll();
    setForegroundConnections([...foregroundConnectionOperations.list()]);
    try {
      await closing;
      setForegroundConnections([]);
      return true;
    } catch (error) {
      setForegroundConnections([...foregroundConnectionOperations.list()]);
      setOperation(
        presentOperationError({
          title: "Close foreground Endpoints before exit",
          operation: "read",
          error,
          allowRetry: false,
        }),
      );
      return false;
    }
  }, [foregroundConnectionOperations, foregroundConnections.length]);

  const startDaemon = useCallback(async (): Promise<boolean> => {
    if (daemonOperations === undefined) {
      return false;
    }
    setOperation(
      presentWorkingOperation({
        title: "Start EasyServer daemon",
        detail: "Starting the managed local connection daemon and verifying authenticated health.",
        activity: "verifying-state",
      }),
    );
    try {
      const result = await daemonOperations.start();
      await refresh();
      setOperation(
        presentCompletedOperation({
          title: result.alreadyRunning ? "EasyServer daemon already running" : "EasyServer daemon started",
          detail: `Control endpoint ${result.descriptor.address.host}:${result.descriptor.address.port}`,
        }),
      );
      return true;
    } catch (error) {
      setOperation(
        presentOperationError({
          title: "Start EasyServer daemon",
          operation: "mutation",
          error,
          allowRetry: false,
        }),
      );
      return false;
    }
  }, [daemonOperations, refresh]);

  const requestStopDaemon = useCallback(async (): Promise<boolean> => {
    if (daemonOperations === undefined) {
      return false;
    }
    try {
      const impact = await daemonOperations.shutdownImpact();
      if (impact === undefined) {
        await refresh();
        return true;
      }
      return await new Promise<boolean>((resolve) => {
        setPendingDaemonStopConfirmation({ resolve });
        setOperation(
          presentMutationConfirmation(
            {
              summary: "Stop EasyServer daemon",
              risks: ["destructive"],
              consequence: `closes ${impact.liveSessions} live persistent ${impact.liveSessions === 1 ? "session" : "sessions"} and ${impact.activeEndpointIntents} active Endpoint ${impact.activeEndpointIntents === 1 ? "intent" : "intents"}; daemon-owned Endpoints stop with the daemon`,
            },
            {
              target: "Local EasyServer daemon",
              affectedResources: [
                `${impact.liveSessions} live persistent session(s)`,
                `${impact.activeEndpointIntents} active Endpoint intent(s)`,
              ],
            },
          ),
        );
      });
    } catch (error) {
      setOperation(
        presentOperationError({
          title: "Inspect daemon shutdown impact",
          operation: "read",
          error,
          allowRetry: false,
        }),
      );
      return false;
    }
  }, [daemonOperations, refresh]);

  const createPersistentSession = useCallback(
    async (request: TuiPersistentSessionRequest): Promise<boolean> => {
      if (daemonOperations === undefined) {
        return false;
      }
      setOperation(
        presentWorkingOperation({
          title: "Create persistent Endpoint",
          detail: `${request.instanceId} → ${request.remoteHost ?? "127.0.0.1"}:${request.remotePort}`,
          activity: "waiting-provider",
        }),
      );
      try {
        await daemonOperations.createSession(request, {
          confirmHostTrust(trust, signal) {
            if (signal.aborted) {
              return Promise.resolve(false);
            }
            return new Promise<boolean>((resolve) => {
              setPendingHostTrustConfirmation({ resolve });
              setOperation(presentHostTrustRequest(trust));
            });
          },
        });
        setPendingHostTrustConfirmation(undefined);
        await refresh();
        setOperation(undefined);
        return true;
      } catch (error) {
        setPendingHostTrustConfirmation(undefined);
        await refresh();
        setOperation(
          presentOperationError({
            title: "Create persistent Endpoint",
            operation: "read",
            error,
            allowRetry: false,
          }),
        );
        return false;
      }
    },
    [daemonOperations, refresh],
  );

  const closePersistentSession = useCallback(
    async (id: string): Promise<boolean> => {
      if (daemonOperations === undefined) {
        return false;
      }
      setOperation(
        presentWorkingOperation({
          title: "Close persistent Session",
          detail: id,
          activity: "verifying-state",
        }),
      );
      try {
        await daemonOperations.closeSession(id);
        await refresh();
        setOperation(undefined);
        return true;
      } catch (error) {
        await refresh();
        setOperation(
          presentOperationError({
            title: "Close persistent Session",
            operation: "read",
            error,
            allowRetry: false,
          }),
        );
        return false;
      }
    },
    [daemonOperations, refresh],
  );

  const setEndpointIntentEnabled = useCallback(
    async (name: string, enabled: boolean): Promise<boolean> => {
      if (daemonOperations === undefined) {
        return false;
      }
      const title = enabled ? "Enable persisted Endpoint intent" : "Disable persisted Endpoint intent";
      setOperation(
        presentWorkingOperation({
          title,
          detail: enabled
            ? `${name}: realizing desired Endpoint state.`
            : `${name}: disabling desired state and closing any current realization.`,
          activity: "verifying-state",
        }),
      );
      try {
        await daemonOperations.setEndpointIntentEnabled(name, enabled);
        await refresh();
        setOperation(
          presentCompletedOperation({
            title: `${title} completed`,
            detail: enabled
              ? `${name} is enabled; Starting or Live state reflects current realization.`
              : `${name} remains persisted but disabled; any live realization is closed.`,
          }),
        );
        return true;
      } catch (error) {
        await refresh({ quiet: true });
        setOperation(
          presentOperationError({
            title,
            operation: "read",
            error,
            allowRetry: false,
          }),
        );
        return false;
      }
    },
    [daemonOperations, refresh],
  );

  const retryEndpointIntent = useCallback(
    async (name: string): Promise<boolean> => {
      if (daemonOperations === undefined) {
        return false;
      }
      setOperation(
        presentWorkingOperation({
          title: "Retry persisted Endpoint intent",
          detail: `${name}: reconciling desired state with a new transport realization.`,
          activity: "verifying-state",
        }),
      );
      try {
        await daemonOperations.retryEndpointIntent(name);
        await refresh();
        setOperation(
          presentCompletedOperation({
            title: "Endpoint intent retry requested",
            detail: `${name} remains persisted; refresh will continue to show Starting, Live or Error without reviving an old transport.`,
          }),
        );
        return true;
      } catch (error) {
        await refresh({ quiet: true });
        setOperation(
          presentOperationError({
            title: "Retry persisted Endpoint intent",
            operation: "read",
            error,
            allowRetry: false,
          }),
        );
        return false;
      }
    },
    [daemonOperations, refresh],
  );

  const requestRemoveEndpointIntent = useCallback(
    (intent: TuiEndpointIntentReadItem) => {
      setPendingEndpointIntentRemoval({ intent });
      setOperation(
        presentMutationConfirmation(
          {
            summary: `Remove persisted Endpoint intent ${intent.name}`,
            risks: ["destructive"],
            consequence:
              intent.state === "live"
                ? "deletes the persisted desired state and closes its current live transport realization"
                : intent.state === "starting"
                  ? "deletes the persisted desired state and cancels the current realization attempt"
                  : "deletes the persisted desired state; it will no longer be recovered after daemon restart",
          },
          {
            target: intent.name,
            affectedResources: [
              "Persisted Endpoint intent definition",
              ...(intent.endpoint === undefined
                ? []
                : [`Current live Endpoint ${intent.endpoint.host}:${intent.endpoint.port}`]),
            ],
          },
        ),
      );
    },
    [],
  );

  const removeEndpointIntent = useCallback(
    async (intent: TuiEndpointIntentReadItem) => {
      if (daemonOperations === undefined) {
        return;
      }
      setPendingEndpointIntentRemovalRetry(undefined);
      setOperation(
        presentWorkingOperation({
          title: "Remove persisted Endpoint intent",
          detail: `${intent.name}: removing desired state and cleaning any current realization.`,
          activity: "verifying-state",
        }),
      );
      try {
        await daemonOperations.removeEndpointIntent(intent.operationName);
        await refresh();
        setOperation(
          presentCompletedOperation({
            title: "Persisted Endpoint intent removed",
            detail: `${intent.name} will not be recovered on daemon restart.`,
          }),
        );
      } catch (error) {
        if (isNormalizedError(error) && error.code === "not-found") {
          await refresh({ quiet: true });
          setOperation(
            presentCompletedOperation({
              title: "Persisted Endpoint intent already removed",
              detail: `${intent.name} is no longer configured and will not be recovered on daemon restart.`,
            }),
          );
          return;
        }
        await refresh({ quiet: true });
        setPendingEndpointIntentRemovalRetry({ intent });
        setOperation(
          presentRetryableCleanupFailure(
            "Remove persisted Endpoint intent",
            `${intent.name} did not finish cleanly. Desired state may already be deleted while transport cleanup remains. Retry here only for this original intent name; do not recreate the same name elsewhere until cleanup succeeds.`,
          ),
        );
      }
    },
    [daemonOperations, refresh],
  );

  const mutateInstance = useCallback(
    async (mutation: TuiInstanceMutation) => {
      if (instanceMutationRunner === undefined) {
        return;
      }

      const title = instanceMutationTitle(mutation);
      let warning: string | undefined;
      let observing = false;
      setOperation(
        presentWorkingOperation({
          title,
          detail: mutation.instanceId,
          activity: "requested",
        }),
      );

      try {
        const result = await instanceMutationRunner(mutation, {
          progress(progress) {
            observing = progress === "observing";
            setOperation(
              presentWorkingOperation({
                title,
                detail:
                  progress === "observing"
                    ? `Observing ${mutation.instanceId} until provider state converges.`
                    : `Dispatching the requested operation for ${mutation.instanceId}.`,
                activity: progress,
              }),
            );
          },
          warning(message) {
            warning = message;
          },
          confirm(prompt, details, context) {
            if (context.signal.aborted) {
              return Promise.resolve(false);
            }
            return new Promise<boolean>((resolve) => {
              setPendingInstanceConfirmation({ resolve, workingTitle: title });
              setOperation(
                presentMutationConfirmation(prompt, {
                  target: instanceConfirmationTarget(details),
                  affectedResources: destroyAffectedResources(details),
                }),
              );
            });
          },
        });

        if (!(await refresh())) {
          return;
        }
        setOperation(
          presentCompletedOperation({
            title: `${title} completed`,
            detail: `${mutation.instanceId} observed state=${result.observedState}.${warning === undefined ? "" : ` Warning: ${warning}`}`,
          }),
        );
      } catch (error) {
        setPendingInstanceConfirmation(undefined);
        setOperation(
          presentOperationError({
            title: observing ? "Observe instance state" : title,
            operation: observing ? "read" : "mutation",
            error,
          }),
        );
      }
    },
    [instanceMutationRunner, refresh],
  );

  const mutateBulkInstances = useCallback(
    async (mutation: TuiBulkInstanceMutation) => {
      if (bulkInstanceMutationRunner === undefined) {
        return;
      }

      bulkMutationControllerRef.current?.abort();
      const controller = new AbortController();
      bulkMutationControllerRef.current = controller;
      const title = bulkInstanceMutationTitle(mutation);
      const requestedResults = mutation.instanceIds.map((instanceId) => ({
        instanceId,
        status: "requested" as const,
      }));
      const warnings: string[] = [];
      setOperation(
        presentWorkingOperation({
          title,
          detail: `${mutation.instanceIds.length} explicit ${mutation.instanceIds.length === 1 ? "target" : "targets"}.`,
          activity: "requested",
          cancellable: true,
          instanceResults: requestedResults,
        }),
      );

      try {
        const result = await bulkInstanceMutationRunner(
          mutation,
          { signal: controller.signal },
          {
            progress(progress) {
              setOperation(
                presentWorkingOperation({
                  title,
                  detail:
                    progress === "observing"
                      ? "Observing confirmed successful targets through host convergence."
                      : "Dispatching one host-owned bulk lifecycle request; undispatched targets remain cancellable.",
                  activity: progress,
                  cancellable: !controller.signal.aborted,
                  instanceResults: requestedResults,
                }),
              );
            },
            warning(message) {
              warnings.push(message);
            },
            confirm(prompt, details, context) {
              if (context.signal.aborted) {
                return Promise.resolve(false);
              }
              return new Promise<boolean>((resolve) => {
                setPendingInstanceConfirmation({
                  resolve,
                  workingTitle: title,
                  bulkTargetIds: details.targets.map((target) => target.instanceId),
                });
                setOperation(
                  presentMutationConfirmation(prompt, {
                    target: `${details.targets.length} selected Compute ${details.targets.length === 1 ? "Instance" : "Instances"}`,
                    affectedResources: bulkInstanceConfirmationResources(details),
                  }),
                );
              });
            },
          },
        );

        if (bulkMutationControllerRef.current === controller) {
          bulkMutationControllerRef.current = undefined;
        }
        if (!controller.signal.aborted) {
          await refresh({ quiet: true });
        }
        setOperation(presentBulkInstanceResult(title, result, warnings));
      } catch (error) {
        if (bulkMutationControllerRef.current === controller) {
          bulkMutationControllerRef.current = undefined;
        }
        setPendingInstanceConfirmation(undefined);
        setOperation(
          presentOperationError({
            title,
            operation: "mutation",
            error,
          }),
        );
      }
    },
    [bulkInstanceMutationRunner, refresh],
  );

  const mutateProvider = useCallback(
    async (mutation: TuiProviderMutation) => {
      if (providerMutationRunner === undefined) {
        return;
      }

      const title =
        mutation.kind === "add-plugin"
          ? "Register provider"
          : mutation.kind === "set-enabled"
            ? mutation.enabled
              ? "Enable provider"
              : "Disable provider"
            : mutation.kind === "set-credential"
              ? "Configure provider credential"
              : "Remove provider credential";
      const detail =
        mutation.kind === "add-plugin"
          ? `Validating ${mutation.source} before saving configuration.`
          : mutation.kind === "set-enabled"
            ? `${title} ${mutation.source}.`
            : `${title} ${mutation.name} for ${mutation.source}.`;
      setOperation(
        presentWorkingOperation({
          title,
          detail,
          activity: "verifying-state",
        }),
      );
      try {
        await providerMutationRunner(mutation);
        await refresh();
      } catch (error) {
        const presentationError =
          mutation.kind === "set-credential"
            ? normalizedError(
                "plugin-failure",
                "Credential update failed. Verify provider configuration and try again.",
              )
            : error;
        setOperation(
          presentOperationError({
            title,
            operation: "mutation",
            error: presentationError,
          }),
        );
      }
    },
    [providerMutationRunner, refresh],
  );

  const requestProviderMutation = useCallback(
    (mutation: TuiProviderMutation) => {
      if (mutation.kind !== "remove-credential") {
        void mutateProvider(mutation);
        return;
      }

      setPendingProviderMutation(mutation);
      setOperation(
        presentMutationConfirmation(
          {
            summary: `Remove credential ${mutation.name}`,
            risks: ["destructive"],
            consequence:
              "removes the stored secret and may make subsequent provider operations unavailable until a new value is configured",
          },
          {
            target: mutation.source,
            affectedResources: ["Provider credential readiness"],
          },
        ),
      );
    },
    [mutateProvider],
  );

  const openProviderWorkflow = useCallback(
    async (workflow: TuiProviderWorkflowReadItem) => {
      if (
        providerFlowBusyRef.current ||
        providerFlowOpener === undefined ||
        workflow.presentation.kind !== "interactive-flow"
      ) {
        return;
      }

      providerFlowBusyRef.current = true;
      providerFlowHandle?.close();
      setProviderFlowHandle(undefined);
      setProviderFlowScreen(undefined);
      setNavigateToInstanceId(undefined);
      setOperation(
        presentWorkingOperation({
          title: "Open provider workflow",
          detail: `${workflow.providerId}/${workflow.commandName}`,
          activity: "waiting-provider",
        }),
      );
      try {
        const handle = await providerFlowOpener(
          {
            providerId: workflow.providerId,
            featureId: workflow.featureId,
            flowId: workflow.presentation.flowId,
          },
          { signal: new AbortController().signal },
        );
        setProviderFlowHandle(handle);
        setProviderFlowScreen(handle.screen);
        setOperation(undefined);
      } catch (error) {
        setOperation(
          presentOperationError({
            title: "Open provider workflow",
            operation: "read",
            error,
          }),
        );
      } finally {
        providerFlowBusyRef.current = false;
      }
    },
    [providerFlowHandle, providerFlowOpener],
  );

  const dispatchProviderWorkflow = useCallback(
    async (event: ProviderInteractiveEvent) => {
      const handle = providerFlowHandle;
      if (handle === undefined || providerFlowBusyRef.current) {
        return;
      }

      providerFlowBusyRef.current = true;
      const title = `${handle.descriptor.command.description}`;
      setOperation(
        presentWorkingOperation({
          title: "Update provider workflow",
          detail: title,
          activity: "waiting-provider",
        }),
      );
      const interaction: ProviderFeatureInteraction = {
        confirm(prompt, context) {
          if (context.signal.aborted) {
            return Promise.resolve(false);
          }
          return new Promise<boolean>((resolve) => {
            setPendingProviderFlowConfirmation({
              resolve,
              workingTitle: title,
            });
            setOperation(
              presentMutationConfirmation(prompt, {
                target: `${handle.descriptor.command.name}`,
                affectedResources: ["Provider inventory"],
              }),
            );
          });
        },
      };

      try {
        const result = await handle.dispatch(
          event,
          { signal: new AbortController().signal },
          interaction,
        );
        if (result.kind === "screen") {
          setProviderFlowScreen(result.screen);
          setOperation(undefined);
          return;
        }

        setProviderFlowHandle(undefined);
        setProviderFlowScreen(undefined);
        const targetInstanceId =
          result.execution.handoff.canonicalInstances[0]?.instanceId;
        await refresh();
        if (targetInstanceId !== undefined) {
          setNavigateToInstanceId(targetInstanceId);
        }
        setOperation(presentProviderExecution(title, result.execution));
      } catch (error) {
        handle.close();
        setProviderFlowHandle(undefined);
        setProviderFlowScreen(undefined);
        setPendingProviderFlowConfirmation(undefined);
        setOperation(
          presentOperationError({
            title,
            operation: handle.descriptor.command.operation,
            error,
          }),
        );
      } finally {
        providerFlowBusyRef.current = false;
      }
    },
    [providerFlowHandle, refresh],
  );

  const closeProviderWorkflow = useCallback(() => {
    if (providerFlowBusyRef.current) {
      return;
    }
    providerFlowHandle?.close();
    setProviderFlowHandle(undefined);
    setProviderFlowScreen(undefined);
    setPendingProviderFlowConfirmation(undefined);
    setOperation(undefined);
  }, [providerFlowHandle]);

  const handleOperationAction = useCallback(
    (action: TuiOperationActionKind) => {
      if (
        pendingHostTrustConfirmation !== undefined &&
        (action === "trust" || action === "decline")
      ) {
        const pending = pendingHostTrustConfirmation;
        setPendingHostTrustConfirmation(undefined);
        pending.resolve(action === "trust");
        setOperation(
          action === "trust"
            ? presentWorkingOperation({
                title: "Establish connection",
                detail: "Enrolling the reviewed SSH fingerprint and retrying connection setup once.",
                activity: "waiting-provider",
              })
            : undefined,
        );
        return;
      }
      if (
        pendingDaemonStopConfirmation !== undefined &&
        (action === "confirm" || action === "decline")
      ) {
        const pending = pendingDaemonStopConfirmation;
        setPendingDaemonStopConfirmation(undefined);
        if (action === "decline") {
          setOperation(undefined);
          pending.resolve(false);
          return;
        }
        if (daemonOperations === undefined) {
          setOperation(undefined);
          pending.resolve(false);
          return;
        }
        setOperation(
          presentWorkingOperation({
            title: "Stop EasyServer daemon",
            detail: "Closing daemon-owned sessions and waiting for the managed daemon to stop.",
            activity: "verifying-state",
          }),
        );
        void daemonOperations.stop().then(
          async (result) => {
            await refresh();
            if (result.status === "stale") {
              setOperation(
                presentOperationError({
                  title: "Stop EasyServer daemon",
                  operation: "mutation",
                  error: new Error(`Daemon remained unreachable: ${result.reason}`),
                  allowRetry: false,
                }),
              );
              pending.resolve(false);
              return;
            }
            setOperation(
              presentCompletedOperation({ title: "EasyServer daemon stopped" }),
            );
            pending.resolve(true);
          },
          (error) => {
            setOperation(
              presentOperationError({
                title: "Stop EasyServer daemon",
                operation: "mutation",
                error,
                allowRetry: false,
              }),
            );
            pending.resolve(false);
          },
        );
        return;
      }
      if (
        pendingEndpointIntentRemoval !== undefined &&
        (action === "confirm" || action === "decline")
      ) {
        const pending = pendingEndpointIntentRemoval;
        setPendingEndpointIntentRemoval(undefined);
        if (action === "decline" || daemonOperations === undefined) {
          setOperation(undefined);
          return;
        }
        void removeEndpointIntent(pending.intent);
        return;
      }
      if (
        pendingInstanceConfirmation !== undefined &&
        (action === "confirm" || action === "decline")
      ) {
        const pending = pendingInstanceConfirmation;
        setPendingInstanceConfirmation(undefined);
        pending.resolve(action === "confirm");
        setOperation(
          action === "confirm"
            ? presentWorkingOperation({
                title: pending.workingTitle,
                detail:
                  pending.bulkTargetIds === undefined
                    ? "Dispatching the confirmed instance operation."
                    : "Dispatching the confirmed bulk instance operation; undispatched targets remain cancellable.",
                activity: "dispatching",
                ...(pending.bulkTargetIds === undefined
                  ? {}
                  : {
                      cancellable: true,
                      instanceResults: pending.bulkTargetIds.map((instanceId) => ({
                        instanceId,
                        status: "requested" as const,
                      })),
                    }),
              })
            : undefined,
        );
        return;
      }
      if (
        pendingProviderFlowConfirmation !== undefined &&
        (action === "confirm" || action === "decline")
      ) {
        const pending = pendingProviderFlowConfirmation;
        setPendingProviderFlowConfirmation(undefined);
        pending.resolve(action === "confirm");
        setOperation(
          action === "confirm"
            ? presentWorkingOperation({
                title: pending.workingTitle,
                detail: "Waiting for provider result.",
                activity: "waiting-provider",
              })
            : undefined,
        );
        return;
      }
      if (action === "confirm" && pendingProviderMutation !== undefined) {
        const mutation = pendingProviderMutation;
        setPendingProviderMutation(undefined);
        setOperation(undefined);
        void mutateProvider(mutation);
        return;
      }
      if (action === "decline" && pendingProviderMutation !== undefined) {
        setPendingProviderMutation(undefined);
        setOperation(undefined);
        return;
      }
      if (action === "cancel") {
        if (bulkMutationControllerRef.current !== undefined) {
          bulkMutationControllerRef.current.abort();
          setOperation(
            presentWorkingOperation({
              title: "Bulk lifecycle cancellation requested",
              detail:
                "Undispatched targets will be cancelled. Already dispatched mutations may complete or become outcome-unknown; waiting for the host-owned per-target result.",
              activity: "dispatching",
            }),
          );
          return;
        }
        const controller = controllerRef.current;
        controllerRef.current = undefined;
        controller?.abort();
        setOperation(undefined);
        return;
      }
      if (action === "retry" && pendingEndpointIntentRemovalRetry !== undefined) {
        void removeEndpointIntent(pendingEndpointIntentRemovalRetry.intent);
        return;
      }
      if (action === "retry" || action === "observe" || action === "refresh") {
        void refresh();
        return;
      }
      if (action === "dismiss") {
        setPendingHostTrustConfirmation(undefined);
        setPendingDaemonStopConfirmation(undefined);
        setPendingEndpointIntentRemoval(undefined);
        setPendingEndpointIntentRemovalRetry(undefined);
        setPendingInstanceConfirmation(undefined);
        setPendingProviderMutation(undefined);
        setOperation(undefined);
      }
    },
    [
      daemonOperations,
      mutateProvider,
      pendingDaemonStopConfirmation,
      pendingEndpointIntentRemoval,
      pendingEndpointIntentRemovalRetry,
      pendingHostTrustConfirmation,
      pendingInstanceConfirmation,
      pendingProviderFlowConfirmation,
      pendingProviderMutation,
      refresh,
      removeEndpointIntent,
    ],
  );

  const readStatus: TuiReadStatus =
    snapshot !== undefined
      ? snapshotStale
        ? "stale"
        : "ready"
      : operation?.phase === "working"
        ? "loading"
        : operation === undefined
          ? "idle"
          : "failed";

  return (
    <TuiShell
      colorEnabled={colorEnabled}
      screenReader={screenReader}
      readSnapshot={snapshot}
      readStatus={readStatus}
      diagnostics={diagnostics}
      operation={operation}
      onOperationAction={handleOperationAction}
      onRefresh={(routeId) => {
        if (routeId === "diagnostics") {
          void refreshDiagnostics();
          return;
        }
        void refresh();
      }}
      onCopyDiagnostics={
        diagnosticsOperations === undefined ? undefined : copyDiagnostics
      }
      foregroundConnections={foregroundConnections}
      onListForegroundAccessMethods={
        foregroundConnectionOperations === undefined
          ? undefined
          : listForegroundAccessMethods
      }
      onOpenForegroundConnection={
        foregroundConnectionOperations === undefined
          ? undefined
          : openForegroundConnection
      }
      onCloseForegroundConnection={
        foregroundConnectionOperations === undefined
          ? undefined
          : closeForegroundConnection
      }
      onQuitWithForegroundConnections={
        foregroundConnectionOperations === undefined
          ? undefined
          : closeForegroundConnectionsForExit
      }
      onStartDaemon={daemonOperations === undefined ? undefined : startDaemon}
      onStopDaemon={daemonOperations === undefined ? undefined : requestStopDaemon}
      onCreatePersistentSession={
        daemonOperations === undefined ? undefined : createPersistentSession
      }
      onClosePersistentSession={
        daemonOperations === undefined ? undefined : closePersistentSession
      }
      onSetEndpointIntentEnabled={
        daemonOperations === undefined || operation?.phase === "working"
          ? undefined
          : setEndpointIntentEnabled
      }
      onRetryEndpointIntent={
        daemonOperations === undefined || operation?.phase === "working"
          ? undefined
          : retryEndpointIntent
      }
      onRemoveEndpointIntent={
        daemonOperations === undefined || operation?.phase === "working"
          ? undefined
          : requestRemoveEndpointIntent
      }
      onInstanceMutation={
        instanceMutationRunner !== undefined && canStartInstanceMutation(operation)
          ? (mutation) => {
              void mutateInstance(mutation);
            }
          : undefined
      }
      onBulkInstanceMutation={
        bulkInstanceMutationRunner !== undefined && canStartInstanceMutation(operation)
          ? (mutation) => {
              void mutateBulkInstances(mutation);
            }
          : undefined
      }
      onProviderMutation={
        providerMutationRunner !== undefined && operation?.phase !== "working"
          ? requestProviderMutation
          : undefined
      }
      providerInteractiveScreen={providerFlowScreen}
      providerInteractiveDisabled={operation !== undefined}
      onOpenProviderWorkflow={
        providerFlowOpener === undefined
          ? undefined
          : (workflow) => {
              void openProviderWorkflow(workflow);
            }
      }
      onProviderInteractiveEvent={(event) => {
        void dispatchProviderWorkflow(event);
      }}
      onProviderInteractiveClose={closeProviderWorkflow}
      navigateToInstanceId={navigateToInstanceId}
      onInstanceNavigationHandled={() => {
        setNavigateToInstanceId(undefined);
      }}
    />
  );
}

export interface TuiRuntimeOptions {
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly readLoader?: TuiReadLoader;
  readonly instanceMutationRunner?: TuiInstanceMutationRunner;
  readonly bulkInstanceMutationRunner?: TuiBulkInstanceMutationRunner;
  readonly foregroundConnectionOperations?: TuiForegroundConnectionOperations;
  readonly daemonOperations?: TuiDaemonOperations;
  readonly diagnosticsOperations?: TuiDiagnosticsOperations;
  readonly providerMutationRunner?: TuiProviderMutationRunner;
  readonly providerFlowOpener?: TuiProviderFlowOpener;
}

export function renderTui(options: TuiRuntimeOptions = {}): InkInstance {
  const env = options.env ?? process.env;
  const screenReader = env.INK_SCREEN_READER === "true";
  const colorEnabled = env.NO_COLOR === undefined;
  return render(
    <TuiApp
      colorEnabled={colorEnabled}
      screenReader={screenReader}
      readLoader={options.readLoader}
      instanceMutationRunner={options.instanceMutationRunner}
      bulkInstanceMutationRunner={options.bulkInstanceMutationRunner}
      foregroundConnectionOperations={options.foregroundConnectionOperations}
      daemonOperations={options.daemonOperations}
      diagnosticsOperations={options.diagnosticsOperations}
      providerMutationRunner={options.providerMutationRunner}
      providerFlowOpener={options.providerFlowOpener}
    />,
    {
      stdin: options.stdin ?? process.stdin,
      stdout: options.stdout ?? process.stdout,
      stderr: options.stderr ?? process.stderr,
      alternateScreen: !screenReader,
      isScreenReaderEnabled: screenReader,
      incrementalRendering: true,
      interactive: true,
      maxFps: screenReader ? 10 : 30,
    },
  );
}

export async function runTui(): Promise<void> {
  const app = renderTui({
    readLoader: loadDefaultTuiReadSnapshot,
    instanceMutationRunner: createDefaultTuiInstanceMutationRunner(),
    bulkInstanceMutationRunner: createDefaultTuiBulkInstanceMutationRunner(),
    foregroundConnectionOperations: createDefaultTuiForegroundConnectionOperations(),
    daemonOperations: createDefaultTuiDaemonOperations(),
    diagnosticsOperations: createDefaultTuiDiagnosticsOperations(),
    providerMutationRunner: createDefaultTuiProviderMutationRunner(),
    providerFlowOpener: createDefaultTuiProviderFlowOpener(),
  });
  await app.waitUntilExit();
}
