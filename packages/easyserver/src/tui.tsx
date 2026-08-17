import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Text,
  render,
  type Instance as InkInstance,
  useApp,
  useInput,
  useWindowSize,
} from "ink";
import {
  tuiAppearance,
  tuiFocusColor,
  type TuiAppearance,
} from "./tui-appearance.js";
import { tuiReadableMeasure } from "./tui-layout.js";
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
  hostTrustRequiredError,
  isNormalizedError,
  normalizedError,
  type AvailableAction,
  type OperationContext,
  type ProviderInteractiveEvent,
  type ProviderInteractiveScreen,
} from "@easyai101/easyserver-plugin-sdk";
import {
  moveTuiFocus,
  tuiFocusWindowWithinRows,
} from "./tui-focus.js";
import {
  DiagnosticsSurface,
  diagnosticsSummary,
  wrapDiagnosticsText,
  type TuiDiagnosticsView,
} from "./tui-diagnostics-surface.js";
import { connectionFailureDetails } from "./connection-failure.js";
import {
  connectionContextActions,
  diagnosticsContextActions,
  providerContextActions,
  rentContextActions,
  serverContextActions,
  type TuiContextAction,
  type TuiContextActionId,
} from "./tui-context-actions.js";
import {
  NewInstanceSurface,
  ProvidersSurface,
  firstProviderSource,
  firstWorkflowKey,
  workflowKey,
  type ProviderCandidatePickerView,
  type ProviderCredentialFlow,
  type ProviderCredentialFlowView,
} from "./tui-providers-surface.js";
import {
  ConnectionsSurface,
  foregroundConnectionCanRetry,
  foregroundConnectionFlowFromFailedConnection,
  foregroundConnectionNeedsServicePortEdit,
  foregroundConnectionRequest,
  humanizeTuiServerError,
  parseConnectionPort,
  previousForegroundConnectionStep,
  type ForegroundConnectionFlow,
  type TuiConnectionTarget,
} from "./tui-connections-surface.js";
import {
  InstancesSurface,
  bulkInstanceConfirmationResources,
  bulkInstanceMutationStatus,
  bulkInstanceMutationTitle,
  bulkServerDisplayName,
  canStartInstanceMutation,
  destroyAffectedResources,
  destroyServerConsequence,
  firstInstanceId,
  humanizeBulkInstanceMessage,
  humanizeBulkInstanceResult,
  humanizeBulkMutationError,
  instanceMutationStatus,
  instanceMutationTitle,
  serverDisplayName,
} from "./tui-servers-surface.js";
import { EASYSERVER_VERSION } from "./version.js";

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
  readonly onRetryForegroundConnection?: (
    id: string,
  ) => Promise<TuiForegroundConnection | undefined>;
  readonly onCloseForegroundConnection?: (id: string) => Promise<boolean>;
  readonly foregroundConnectionRecoveryId?: string;
  readonly onQuitWithForegroundConnections?: () => Promise<boolean>;
  readonly onStartDaemon?: () => Promise<boolean>;
  readonly onStopDaemon?: () => Promise<boolean>;
  readonly onCreatePersistentSession?: (
    request: TuiPersistentSessionRequest,
  ) => Promise<boolean>;
  readonly onClosePersistentSession?: (id: string) => Promise<boolean>;
  readonly onSetEndpointIntentEnabled?: (name: string, enabled: boolean) => Promise<boolean>;
  readonly onRetryEndpointIntent?: (name: string) => Promise<boolean>;
  readonly onReviewEndpointIntentHostTrust?: (intent: TuiEndpointIntentReadItem) => void;
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
  onRetryForegroundConnection,
  onCloseForegroundConnection,
  foregroundConnectionRecoveryId,
  onQuitWithForegroundConnections,
  onStartDaemon,
  onStopDaemon,
  onCreatePersistentSession,
  onClosePersistentSession,
  onSetEndpointIntentEnabled,
  onRetryEndpointIntent,
  onReviewEndpointIntentHostTrust,
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
  const routeContentRows = Math.max(7, rows - 11);
  const routeContentColumns = Math.max(20, columns - 4);
  const routeVisualColumns = tuiReadableMeasure(routeContentColumns);
  const diagnosticsReportRows = Math.max(1, routeContentRows - 3);
  const diagnosticsVisualLines =
    diagnostics.status === "ready"
      ? wrapDiagnosticsText(diagnostics.text, routeVisualColumns)
      : [];
  const diagnosticsMaxScroll = Math.max(
    0,
    diagnosticsVisualLines.length - diagnosticsReportRows,
  );
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
  const [operationResourceFocus, setOperationResourceFocus] = useState(() => ({
    operation,
    scroll: 0,
  }));
  const operationResourceScroll =
    operationResourceFocus.operation === operation
      ? operationResourceFocus.scroll
      : 0;
  const setOperationResourceScroll = (
    update: React.SetStateAction<number>,
  ): void => {
    setOperationResourceFocus((current) => {
      const currentScroll = current.operation === operation ? current.scroll : 0;
      return {
        operation,
        scroll: typeof update === "function" ? update(currentScroll) : update,
      };
    });
  };
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
  const [diagnosticsReportOpen, setDiagnosticsReportOpen] = useState(false);
  const [diagnosticsScroll, setDiagnosticsScroll] = useState(0);
  const [status, setStatus] = useState<string | undefined>();
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
  const connectionFailureOpen =
    activeRoute.id === "sessions" &&
    foregroundConnectionFlow?.mode === "foreground" &&
    operation?.phase === "failed";
  const operationOwnsViewport =
    operationInteractionOpen || operation?.ownsViewport === true || connectionFailureOpen;
  const providerItems =
    readSnapshot?.providers.status === "ready"
      ? readSnapshot.providers.items
      : [];
  const providerCandidateItems =
    readSnapshot?.providerCandidates?.status === "ready"
      ? readSnapshot.providerCandidates.items
      : [];
  const canRegisterProvider = onProviderMutation !== undefined;
  const canAddInstalledProvider =
    canRegisterProvider && providerCandidateItems.length > 0;
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
  const canStartForegroundConnection =
    inventoryItems.length > 0 &&
    onOpenForegroundConnection !== undefined &&
    onListForegroundAccessMethods !== undefined;
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
  const persistentSessions =
    readSnapshot?.daemon.status === "running" &&
    readSnapshot.daemon.sessions.status === "ready"
      ? readSnapshot.daemon.sessions.items ?? []
      : [];
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
    ...persistentSessions.map((session) => ({
      kind: "persistent" as const,
      id: session.id,
    })),
    ...(connectionDetailsOpen
      ? endpointIntents.map((intent) => ({
          kind: "intent" as const,
          id: intent.operationName,
        }))
      : []),
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
    if (diagnostics.status !== "ready" || activeRoute.id !== "diagnostics") {
      setDiagnosticsReportOpen(false);
      setDiagnosticsScroll(0);
    }
  }, [diagnostics.status, activeRoute.id]);

  useEffect(() => {
    setDiagnosticsScroll((current) => Math.min(current, diagnosticsMaxScroll));
  }, [diagnosticsMaxScroll]);

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
    setStatus(undefined);
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
    setStatus(message);
    if (routeId === "diagnostics") {
      onRefresh?.("diagnostics");
    }
  };

  const requestExit = (): void => {
    const count = foregroundConnections.filter(
      (connection) => connection.state !== "failed",
    ).length;
    if (count === 0) {
      exit();
      return;
    }
    if (!quitArmed) {
      setQuitArmed(true);
      setStatus(
        `${count} local ${count === 1 ? "connection is" : "connections are"} still open in this TUI. Press q or Ctrl+C again to close ${count === 1 ? "it" : "them"} and quit.`,
      );
      return;
    }
    if (onQuitWithForegroundConnections === undefined) {
      setStatus("Cannot quit safely while local connections owned by this TUI are still open.");
      return;
    }
    setStatus(`Closing ${count} local ${count === 1 ? "connection" : "connections"} before exit.`);
    void onQuitWithForegroundConnections().then((closed) => {
      if (closed) {
        exit();
      } else {
        setQuitArmed(false);
      }
    });
  };

  const beginConnectionFlow = (
    mode: "foreground" | "persistent",
    options: {
      readonly instanceId?: string;
      readonly advanced?: boolean;
    } = {},
  ): void => {
    const firstInstance =
      inventoryItems.find((instance) => instance.id === options.instanceId) ??
      inventoryItems.find((instance) => instance.id === effectiveSelectedInstanceId) ??
      inventoryItems[0];
    const advanced = options.advanced === true;
    const serverScoped = options.instanceId !== undefined;
    if (mode === "persistent" && readSnapshot?.daemon.status !== "running") {
      setStatus("Background connections are unavailable until the EasyServer background service is started from Technical details.");
      return;
    }
    if (firstInstance === undefined) {
      setStatus("No server is available for a local connection.");
      return;
    }
    if (
      onListForegroundAccessMethods === undefined ||
      (mode === "foreground"
        ? onOpenForegroundConnection === undefined
        : onCreatePersistentSession === undefined)
    ) {
      setStatus("Local connection creation is unavailable in this TUI session.");
      return;
    }
    setForegroundConnectionFlow({
      mode,
      advanced,
      serverScoped,
      step: serverScoped ? (advanced ? "remote-host" : "remote-port") : "instance",
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
    setStatus(
      serverScoped
        ? `Connecting to ${firstInstance.name ?? "the selected server"}. Enter the app/service port to expose, not the SSH port.`
        : "Choose the server to connect to.",
    );
  };

  const moveConnectionSelection = (direction: -1 | 1): void => {
    if (connectionTargets.length === 0) {
      return;
    }
    const nextIndex =
      (effectiveConnectionCursor + direction + connectionTargets.length) %
      connectionTargets.length;
    setConnectionCursor(nextIndex);
    const target = connectionTargets[nextIndex];
    if (target?.kind === "foreground") {
      setSelectedForegroundConnectionId(target.id);
    } else if (target?.kind === "persistent") {
      setSelectedPersistentSessionId(target.id);
    } else if (target?.kind === "intent") {
      setSelectedEndpointIntentName(target.id);
    }
  };

  const selectedInstance = inventoryItems.find(
    (instance) => instance.id === effectiveSelectedInstanceId,
  );
  const selectedProvider = providerItems.find(
    (provider) => provider.source === effectiveSelectedProviderSource,
  );
  const selectedForegroundConnection =
    selectedConnectionTarget?.kind === "foreground"
      ? foregroundConnections.find(
          (connection) => connection.id === selectedConnectionTarget.id,
        )
      : undefined;
  const recoveryForegroundConnection =
    foregroundConnectionRecoveryId === undefined
      ? undefined
      : foregroundConnections.find(
          (connection) => connection.id === foregroundConnectionRecoveryId,
        );
  const selectedTargetIntent =
    selectedConnectionTarget?.kind === "intent"
      ? endpointIntents.find((intent) => intent.operationName === selectedConnectionTarget.id)
      : undefined;

  const contextActions: readonly TuiContextAction[] = (() => {
    switch (activeRoute.id) {
      case "overview":
      case "settings":
        return [];
      case "instances":
        return serverContextActions({
          selectedInstance,
          detailsOpen: instanceDetailsOpen,
          canConnect:
            onOpenForegroundConnection !== undefined &&
            onListForegroundAccessMethods !== undefined,
          canMutate: onInstanceMutation !== undefined,
          canBulkMutate: onBulkInstanceMutation !== undefined,
          bulkSelectedInstanceIds,
          bulkSelectedInstances,
          missingBulkSelectedInstanceIds,
        });
      case "providers":
        return providerContextActions({
          selectedProvider,
          detailsOpen: providerDetailsOpen,
          canRegister: canRegisterProvider,
          canAddInstalled: canAddInstalledProvider,
          canMutate: onProviderMutation !== undefined,
        });
      case "new-instance":
        return rentContextActions(workflowItems.length > 0);
      case "sessions":
        return connectionContextActions({
          detailsOpen: connectionDetailsOpen,
          canStartForeground: canStartForegroundConnection,
          hasNoServers:
            readSnapshot?.instances.status === "ready" && inventoryItems.length === 0,
          selectedTarget: selectedConnectionTarget,
          selectedForeground: selectedForegroundConnection,
          selectedIntent: selectedTargetIntent,
          canRetryForeground: onRetryForegroundConnection !== undefined,
          canCloseForeground: onCloseForegroundConnection !== undefined,
          canClosePersistent: onClosePersistentSession !== undefined,
          canCreatePersistent:
            onCreatePersistentSession !== undefined &&
            onListForegroundAccessMethods !== undefined,
          canManageDaemon: onStartDaemon !== undefined && onStopDaemon !== undefined,
          daemonRunning: readSnapshot?.daemon.status === "running",
          canSetIntentEnabled: onSetEndpointIntentEnabled !== undefined,
          canReviewIntentHostTrust: onReviewEndpointIntentHostTrust !== undefined,
          canRetryIntent: onRetryEndpointIntent !== undefined,
          canRemoveIntent: onRemoveEndpointIntent !== undefined,
        });
      case "diagnostics":
        return diagnosticsContextActions(
          diagnostics,
          onCopyDiagnostics !== undefined,
        );
    }
  })();

  const executeContextAction = (id: TuiContextActionId): void => {
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
    if (id === "instance-connect" && selectedInstance !== undefined) {
      beginConnectionFlow("foreground", { instanceId: selectedInstance.id });
      openRoute("sessions", `Connect to ${selectedInstance.name ?? "server"}.`);
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
      setStatus(undefined);
      return;
    }
    if (id === "provider-add-advanced") {
      setProviderSourceInput("");
      setStatus(undefined);
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
        setStatus(undefined);
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
      beginConnectionFlow("persistent", { advanced: true });
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
      id === "connection-retry-foreground" &&
      selectedForegroundConnection?.state === "failed" &&
      onRetryForegroundConnection !== undefined
    ) {
      const failedId = selectedForegroundConnection.id;
      setForegroundConnectionBusy(true);
      void onRetryForegroundConnection(failedId).then((connection) => {
        setForegroundConnectionBusy(false);
        if (connection !== undefined) {
          setSelectedForegroundConnectionId(connection.id);
          setStatus(
            `Local address ready at ${connection.endpoint.host}:${connection.endpoint.port}. The remote service is verified when this address is first used.`,
          );
        }
      });
      return;
    }
    if (
      id === "connection-edit-service-port" &&
      selectedForegroundConnection?.state === "failed" &&
      onCloseForegroundConnection !== undefined
    ) {
      const failed = selectedForegroundConnection;
      setForegroundConnectionBusy(true);
      void onCloseForegroundConnection(failed.id).then((closed) => {
        setForegroundConnectionBusy(false);
        if (!closed) {
          return;
        }
        setSelectedForegroundConnectionId(undefined);
        setForegroundConnectionFlow(
          foregroundConnectionFlowFromFailedConnection(failed, "remote-port"),
        );
        setStatus("Edit the app/service port, then review the connection again.");
      });
      return;
    }
    if (
      id === "connection-close-foreground" &&
      selectedConnectionTarget?.kind === "foreground" &&
      onCloseForegroundConnection !== undefined
    ) {
      const connectionId = selectedConnectionTarget.id;
      const wasFailed = selectedForegroundConnection?.state === "failed";
      setForegroundConnectionBusy(true);
      void onCloseForegroundConnection(connectionId).then((closed) => {
        setForegroundConnectionBusy(false);
        if (closed) {
          setSelectedForegroundConnectionId(undefined);
          setStatus(
            wasFailed ? "Failed local connection dismissed." : "Local connection closed.",
          );
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
          setStatus("Background local connection closed.");
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
    if (id === "intent-host-trust" && selectedTargetIntent !== undefined) {
      onReviewEndpointIntentHostTrust?.(selectedTargetIntent);
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
    if (id === "diagnostics-view" && diagnostics.status === "ready") {
      setDiagnosticsScroll(0);
      setDiagnosticsReportOpen(true);
      return;
    }
    if (id === "diagnostics-copy" && diagnostics.status === "ready") {
      void onCopyDiagnostics?.().then((copied) =>
        setStatus(copied ? "Copied reviewed diagnostics report." : "Diagnostics report could not be copied."),
      );
    }
  };

  const dispatchContextAction = (id: TuiContextActionId): boolean => {
    if (!contextActions.some((action) => action.id === id)) {
      return false;
    }
    executeContextAction(id);
    return true;
  };

  const runForegroundConnectionRequest = (
    request: TuiForegroundConnectionRequest,
  ): void => {
    if (onOpenForegroundConnection === undefined) {
      setStatus("Foreground connection creation is unavailable in this TUI session.");
      return;
    }
    setForegroundConnectionBusy(true);
    void onOpenForegroundConnection(request).then((connection) => {
      setForegroundConnectionBusy(false);
      if (connection === undefined) {
        setStatus(
          "Local connection was not opened. Your entered values are preserved for editing.",
        );
        return;
      }
      setForegroundConnectionFlow(undefined);
      setSelectedForegroundConnectionId(connection.id);
      setStatus(
        `Local address ready at ${connection.endpoint.host}:${connection.endpoint.port}. The remote service is verified when this address is first used.`,
      );
    });
  };

  const runOperationAction = (action: TuiOperationActionKind): void => {
    if (action === "diagnostics") {
      onOperationAction?.("dismiss");
      openRoute(
        "diagnostics",
        "Opened privacy-safe Diagnostics from the connection failure.",
      );
      return;
    }
    const recoveryEditAction = operation?.actions.find(
      (candidate) => candidate.kind === "edit",
    );
    if (
      action === "edit" &&
      recoveryForegroundConnection?.state === "failed" &&
      (recoveryEditAction?.label === "Edit service port" ||
        recoveryEditAction?.label === "Edit local port")
    ) {
      onOperationAction?.("dismiss");
      void onCloseForegroundConnection?.(recoveryForegroundConnection.id);
      const editingServicePort = recoveryEditAction.label === "Edit service port";
      setForegroundConnectionFlow(
        foregroundConnectionFlowFromFailedConnection(
          recoveryForegroundConnection,
          editingServicePort ? "remote-port" : "local-port",
        ),
      );
      setStatus(
        editingServicePort
          ? "Edit the app/service port, then review the connection again."
          : "Edit the local port on this computer, then review the connection again.",
      );
      return;
    }
    if (
      action === "edit" &&
      foregroundConnectionFlow?.mode === "foreground" &&
      foregroundConnectionFlow.step === "review"
    ) {
      onOperationAction?.("dismiss");
      setForegroundConnectionFlow({
        ...foregroundConnectionFlow,
        step: "local-port",
      });
      setStatus("Edit the local port on this computer, then review the connection again.");
      return;
    }
    if (
      action === "retry" &&
      operation?.actions.some(
        (candidate) =>
          candidate.kind === "retry" && candidate.label === "Retry connection",
      ) &&
      foregroundConnectionFlow?.mode === "foreground" &&
      foregroundConnectionFlow.step === "review"
    ) {
      const request = foregroundConnectionRequest(foregroundConnectionFlow);
      if (request === undefined) {
        setStatus("The connection request is incomplete.");
        return;
      }
      onOperationAction?.("dismiss");
      runForegroundConnectionRequest(request);
      return;
    }
    onOperationAction?.(action);
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      requestExit();
      return;
    }

    if (operation !== undefined) {
      const affectedResourceCount =
        operation.interaction?.kind === "mutation-confirmation"
          ? operation.interaction.affectedResources.length
          : 0;
      if (!screenReader && affectedResourceCount > 2) {
        if (key.pageDown) {
          setOperationResourceScroll((current) =>
            Math.min(Math.max(0, affectedResourceCount - 2), current + 2),
          );
          return;
        }
        if (key.pageUp) {
          setOperationResourceScroll((current) => Math.max(0, current - 2));
          return;
        }
      }
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
            runOperationAction(action.kind);
          }
          return;
        }
        if (key.escape) {
          const backAction =
            operation.actions.find((action) => action.kind === "decline") ??
            operation.actions.find((action) => action.kind === "dismiss");
          if (backAction !== undefined) {
            runOperationAction(backAction.kind);
            return;
          }
        }
      }
      const accelerator = operationActionForInput(operation, input, key);
      if (accelerator !== undefined) {
        runOperationAction(accelerator);
        return;
      }
      if (operationOwnsViewport) {
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
        setStatus(undefined);
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
        setStatus(undefined);
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
          setStatus(undefined);
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
            setStatus(undefined);
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
          setStatus(undefined);
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
        setStatus(undefined);
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

    if (foregroundConnectionFlow !== undefined && activeRoute.id === "sessions") {
      if (foregroundConnectionBusy) {
        return;
      }
      if (key.escape) {
        const previousStep = previousForegroundConnectionStep(foregroundConnectionFlow);
        if (previousStep === undefined) {
          setForegroundConnectionFlow(undefined);
          setStatus(undefined);
        } else {
          setForegroundConnectionFlow({
            ...foregroundConnectionFlow,
            step: previousStep,
          });
          setStatus(undefined);
        }
        return;
      }

      if (foregroundConnectionFlow.step === "instance") {
        if ((key.downArrow || key.upArrow) && inventoryItems.length > 0) {
          const forwards = key.downArrow;
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
            step: foregroundConnectionFlow.advanced ? "remote-host" : "remote-port",
          });
          setStatus(
            foregroundConnectionFlow.advanced
              ? "Advanced: enter the remote host. 127.0.0.1 is the ordinary default."
              : "Enter the app/service port to expose on this server, not the SSH port.",
          );
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
          setStatus("Enter the app/service port to expose on this server, not the SSH port.");
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
            setStatus("A supported connection method could not be discovered in this TUI session.");
            return;
          }
          setForegroundConnectionBusy(true);
          setStatus("Checking how EasyServer can reach this server…");
          void onListForegroundAccessMethods(foregroundConnectionFlow.instanceId).then(
            (methods) => {
              setForegroundConnectionBusy(false);
              if (methods === undefined) {
                return;
              }
              const defaultMethod = methods[0];
              setForegroundConnectionFlow((current) =>
                current === undefined
                  ? current
                  : {
                      ...current,
                      step:
                        defaultMethod === undefined
                          ? current.advanced ? "access-method" : "remote-port"
                          : current.advanced ? "access-method" : "local-port",
                      accessMethods: methods,
                      accessMethodId: defaultMethod?.id,
                    },
              );
              setStatus(
                defaultMethod === undefined
                  ? "EasyServer could not find a supported way to reach this server. Refresh the server/provider state and try again."
                  : foregroundConnectionFlow.advanced
                    ? "Advanced: choose the connection method."
                    : "Connection method selected automatically. Choose the local port, or leave it blank for an automatic port.",
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
          (key.downArrow || key.upArrow) &&
          foregroundConnectionFlow.accessMethods.length > 0
        ) {
          const forwards = key.downArrow;
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
          setStatus("Choose the local port on this computer, or leave it blank for an automatic port.");
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
              ? "Review the background local connection and press Enter to create it."
              : "Review the local connection and press Enter to open it.",
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
                "Background local connection was not created. Your values are preserved for a safe retry.",
              );
              return;
            }
            setForegroundConnectionFlow(undefined);
            setStatus("Created background local connection.");
          });
          return;
        }
        runForegroundConnectionRequest(request);
      }
      return;
    }

    if (
      activeRoute.id === "diagnostics" &&
      diagnosticsReportOpen &&
      diagnostics.status === "ready"
    ) {
      if (input === "q") {
        requestExit();
        return;
      }
      if (input === "?") {
        setHelpOpen((open) => !open);
        return;
      }
      if (helpOpen) {
        if (key.escape) {
          setHelpOpen(false);
        }
        return;
      }
      if (key.escape) {
        setDiagnosticsReportOpen(false);
        setDiagnosticsScroll(0);
        setStatus(undefined);
        return;
      }
      if (!screenReader && key.downArrow) {
        setDiagnosticsScroll((current) => Math.min(diagnosticsMaxScroll, current + 1));
        return;
      }
      if (!screenReader && key.upArrow) {
        setDiagnosticsScroll((current) => Math.max(0, current - 1));
        return;
      }
      if (key.return) {
        if (onCopyDiagnostics === undefined) {
          setStatus("Clipboard integration is unavailable in this TUI session.");
          return;
        }
        void onCopyDiagnostics().then((copied) =>
          setStatus(
            copied
              ? "Copied the exact reviewed diagnostics report."
              : "Diagnostics report could not be copied.",
          ),
        );
      }
      return;
    }

    if (actionMenuOpen) {
      if (key.escape) {
        setActionMenuOpen(false);
        setActionCursor(0);
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
          dispatchContextAction(action.id);
        }
        return;
      }
      return;
    }

    if (contentFocused && key.escape) {
      openRoute(parentRoute(activeRoute.id));
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

    if (input === "r") {
      dispatchContextAction("refresh");
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

  const appearance = tuiAppearance(colorEnabled);
  const accent = appearance.accent;
  const muted = appearance.muted;
  const actionMenuMaxRows = Math.max(4, routeContentRows - 2);
  const actionMenuRows = actionMenuOpen
    ? contextActionMenuRenderedRows(
        contextActions.length,
        Math.min(actionCursor, Math.max(0, contextActions.length - 1)),
        actionMenuMaxRows,
      )
    : 0;
  const routeSurfaceRows = Math.max(1, routeContentRows - actionMenuRows);
  const surfaceOwnsInteractionHint =
    providerInteractiveScreen !== undefined ||
    providerCandidatePickerView !== undefined ||
    providerSourceInput !== undefined ||
    providerCredentialFlowView !== undefined ||
    foregroundConnectionFlow !== undefined ||
    diagnosticsReportOpen;

  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={accent} aria-label={`EasyServer ${EASYSERVER_VERSION}`}>
          EasyServer
        </Text>
        <Text color={muted}>v{EASYSERVER_VERSION}</Text>
      </Box>
      {activeRoute.id === "overview" && !operationOwnsViewport ? (
        <Text color={muted}>Remote compute, without the provider control panel.</Text>
      ) : null}

      {operationOwnsViewport && operation !== undefined ? (
        <Box
          flexGrow={1}
          minHeight={0}
          overflowY={screenReader ? undefined : "hidden"}
          justifyContent="center"
        >
          <TuiOperationDrawer
            operation={operation}
            colorEnabled={colorEnabled}
            selectedActionIndex={Math.min(
              operationActionCursor,
              Math.max(0, operation.actions.length - 1),
            )}
            interactionResourceScroll={operationResourceScroll}
            screenReader={screenReader}
          />
        </Box>
      ) : helpOpen ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={muted}>{routeBreadcrumb(activeRoute.id)}</Text>
          <HelpPanel colorEnabled={colorEnabled} />
        </Box>
      ) : activeRoute.id === "overview" ? (
        <Box width={routeVisualColumns}>
          <HomeSurface cursor={Math.min(focusedIndex, homeDestinations.length - 1)} appearance={appearance} />
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column" flexGrow={1} minHeight={0} width={routeVisualColumns}>
          <Text color={muted}>{routeBreadcrumb(activeRoute.id)}</Text>
          <Text bold>{activeRoute.label}</Text>
          <Text color={muted}>{activeRoute.description}</Text>
          <Box marginTop={1} flexDirection="column" flexGrow={1} minHeight={0}>
            {readSnapshot !== undefined && readStatus === "stale" ? (
              <Box flexDirection="column" marginBottom={1}>
                <Text bold color={appearance.warning}>Some information could not be refreshed.</Text>
                <Text color={appearance.warning}>Showing the previous snapshot; open Actions to try again.</Text>
              </Box>
            ) : null}
            <RouteSurface
              route={activeRoute}
              snapshot={readSnapshot}
              readStatus={readStatus}
              screenReader={screenReader}
              height={routeSurfaceRows}
              width={routeVisualColumns}
              colorEnabled={colorEnabled}
              settingsCursor={settingsCursor}
              diagnostics={{
                view: diagnostics,
                reportOpen: diagnosticsReportOpen,
                scroll: diagnosticsScroll,
                canCopy: onCopyDiagnostics !== undefined,
              }}
              servers={{
                selectedInstanceId,
                showDetails: instanceDetailsOpen,
                bulkSelectedInstanceIds,
                canMutate: onInstanceMutation !== undefined,
                canBulkMutate: onBulkInstanceMutation !== undefined,
              }}
              connections={{
                flow: foregroundConnectionFlow,
                busy: foregroundConnectionBusy,
                connections: foregroundConnections,
                selectedConnectionId: selectedForegroundConnectionId,
                selectedPersistentSessionId,
                selectedEndpointIntentName: effectiveSelectedEndpointIntentName,
                selectedTarget: selectedConnectionTarget,
                showDetails: connectionDetailsOpen,
              }}
              providers={{
                candidatePicker: providerCandidatePickerView,
                sourceInput: providerSourceInput,
                credentialFlow: providerCredentialFlowView,
                selectedSource: effectiveSelectedProviderSource,
                showDetails: providerDetailsOpen,
                canRegister: canRegisterProvider,
                canAddInstalled: canAddInstalledProvider,
              }}
              rent={{
                selectedWorkflowKey: effectiveSelectedWorkflowKey,
                interactiveScreen: providerInteractiveScreen,
                interactiveDisabled: providerInteractiveDisabled,
                onInteractiveEvent: onProviderInteractiveEvent,
                onInteractiveClose: onProviderInteractiveClose,
              }}
            />
            {actionMenuOpen ? (
              <ContextActionMenu
                actions={contextActions}
                cursor={Math.min(actionCursor, Math.max(0, contextActions.length - 1))}
                colorEnabled={colorEnabled}
                maxRows={actionMenuMaxRows}
              />
            ) : null}
          </Box>
        </Box>
      )}

      {operation === undefined || operationOwnsViewport ? null : (
        <Box marginTop={1}>
          <TuiOperationDrawer
            operation={operation}
            colorEnabled={colorEnabled}
            selectedActionIndex={Math.min(
              operationActionCursor,
              Math.max(0, operation.actions.length - 1),
            )}
            interactionResourceScroll={operationResourceScroll}
            screenReader={screenReader}
          />
        </Box>
      )}

      {operationOwnsViewport || actionMenuOpen ? null : (
        <Box marginTop={1} flexDirection="column">
          {status === undefined ? null : (
            <Text color={muted} aria-label={`Status: ${status}`} wrap="truncate">{status}</Text>
          )}
          {surfaceOwnsInteractionHint ? null : screenReader ? (
            <Text>
              {activeRoute.id === "overview"
                ? "Commands: Up and Down move; Enter opens; question mark opens help; Ctrl+C quits."
                : "Commands: Up and Down move; Enter opens Actions; Escape goes back; question mark opens help; Ctrl+C quits."}
            </Text>
          ) : (
            <Text color={muted}>
              {activeRoute.id === "overview"
                ? "↑/↓ move · Enter open · ? help · Ctrl+C quit"
                : "↑/↓ move · Enter actions · Esc back · ? help · Ctrl+C quit"}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function HomeSurface({ cursor, appearance }: { readonly cursor: number; readonly appearance: TuiAppearance }): React.ReactElement {
  const muted = appearance.muted;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>What do you want to do?</Text>
      <Box flexDirection="column" marginTop={1}>
        {homeDestinations.map((destination, index) => (
          <Box key={destination.routeId} flexDirection="column" marginBottom={index === homeDestinations.length - 1 ? 0 : 1}>
            <Text bold={index === cursor} color={tuiFocusColor(appearance, index === cursor)}>
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
  const appearance = tuiAppearance(colorEnabled);
  const muted = appearance.muted;
  return (
    <Box flexDirection="column">
      <Text>Choose what you want to configure or inspect.</Text>
      <Box flexDirection="column" marginTop={1}>
        {settingsDestinations.map((destination, index) => (
          <Box key={destination.routeId} flexDirection="column" marginBottom={index === settingsDestinations.length - 1 ? 0 : 1}>
            <Text bold={index === cursor} color={tuiFocusColor(appearance, index === cursor)}>
              {index === cursor ? "> " : "  "}{destination.label}
            </Text>
            <Text color={muted}>  {destination.description}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function contextActionMenuRenderedRows(
  actionCount: number,
  cursor: number,
  maxRows: number,
): number {
  const window = tuiFocusWindowWithinRows(
    cursor,
    actionCount,
    Math.max(1, maxRows - 3),
  );
  return (
    3 +
    (window.end - window.start) +
    (window.showBefore ? 1 : 0) +
    (window.showAfter ? 1 : 0)
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
  const appearance = tuiAppearance(colorEnabled);
  const accent = appearance.accent;
  const muted = appearance.muted;
  const window = tuiFocusWindowWithinRows(
    cursor,
    actions.length,
    Math.max(1, maxRows - 3),
  );
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

interface DiagnosticsRouteState {
  readonly view: TuiDiagnosticsView;
  readonly reportOpen: boolean;
  readonly scroll: number;
  readonly canCopy: boolean;
}

interface ServersRouteState {
  readonly selectedInstanceId?: string;
  readonly showDetails: boolean;
  readonly bulkSelectedInstanceIds: readonly string[];
  readonly canMutate: boolean;
  readonly canBulkMutate: boolean;
}

interface ConnectionsRouteState {
  readonly flow?: ForegroundConnectionFlow;
  readonly busy: boolean;
  readonly connections: readonly TuiForegroundConnection[];
  readonly selectedConnectionId?: string;
  readonly selectedPersistentSessionId?: string;
  readonly selectedEndpointIntentName?: string;
  readonly selectedTarget?: TuiConnectionTarget;
  readonly showDetails: boolean;
}

interface ProvidersRouteState {
  readonly candidatePicker?: ProviderCandidatePickerView;
  readonly sourceInput?: string;
  readonly credentialFlow?: ProviderCredentialFlowView;
  readonly selectedSource?: string;
  readonly showDetails: boolean;
  readonly canRegister: boolean;
  readonly canAddInstalled: boolean;
}

interface RentRouteState {
  readonly selectedWorkflowKey?: string;
  readonly interactiveScreen?: ProviderInteractiveScreen;
  readonly interactiveDisabled: boolean;
  readonly onInteractiveEvent?: (event: ProviderInteractiveEvent) => void;
  readonly onInteractiveClose?: () => void;
}

interface RouteSurfaceProps {
  readonly route: TuiRoute;
  readonly snapshot?: TuiReadSnapshot;
  readonly readStatus: TuiReadStatus;
  readonly screenReader: boolean;
  readonly height: number;
  readonly width: number;
  readonly colorEnabled: boolean;
  readonly settingsCursor: number;
  readonly diagnostics: DiagnosticsRouteState;
  readonly servers: ServersRouteState;
  readonly connections: ConnectionsRouteState;
  readonly providers: ProvidersRouteState;
  readonly rent: RentRouteState;
}

function RouteSurface({
  route,
  snapshot,
  readStatus,
  screenReader,
  height,
  width,
  colorEnabled,
  settingsCursor,
  diagnostics,
  servers,
  connections,
  providers,
  rent,
}: RouteSurfaceProps): React.ReactElement {
  if (
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
        diagnostics={diagnostics.view}
        reportOpen={diagnostics.reportOpen}
        scroll={diagnostics.scroll}
        canCopy={diagnostics.canCopy}
        screenReader={screenReader}
        height={height}
        width={width}
        colorEnabled={colorEnabled}
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

  if (route.id === "new-instance") {
    if (rent.interactiveScreen !== undefined) {
      return (
        <ProviderInteractiveSurface
          key={`${rent.interactiveScreen.kind}:${rent.interactiveScreen.id}`}
          screen={rent.interactiveScreen}
          colorEnabled={colorEnabled}
          disabled={rent.interactiveDisabled}
          height={height}
          width={width}
          screenReader={screenReader}
          onEvent={rent.onInteractiveEvent ?? (() => undefined)}
          onClose={rent.onInteractiveClose ?? (() => undefined)}
        />
      );
    }
    return (
      <NewInstanceSurface
        snapshot={snapshot}
        selectedWorkflowKey={rent.selectedWorkflowKey}
        colorEnabled={colorEnabled}
      />
    );
  }
  if (route.id === "instances") {
    return (
      <InstancesSurface
        snapshot={snapshot}
        height={height}
        width={width}
        selectedInstanceId={servers.selectedInstanceId}
        showDetails={servers.showDetails}
        bulkSelectedInstanceIds={servers.bulkSelectedInstanceIds}
        canMutate={servers.canMutate}
        canBulkMutate={servers.canBulkMutate}
        colorEnabled={colorEnabled}
      />
    );
  }
  if (route.id === "sessions") {
    return (
      <ConnectionsSurface
        snapshot={snapshot}
        height={height}
        width={width}
        screenReader={screenReader}
        flow={connections.flow}
        busy={connections.busy}
        connections={connections.connections}
        selectedConnectionId={connections.selectedConnectionId}
        selectedPersistentSessionId={connections.selectedPersistentSessionId}
        selectedEndpointIntentName={connections.selectedEndpointIntentName}
        selectedConnectionTarget={connections.selectedTarget}
        showDetails={connections.showDetails}
        colorEnabled={colorEnabled}
      />
    );
  }
  return (
    <ProvidersSurface
      snapshot={snapshot}
      height={height}
      width={width}
      candidatePicker={providers.candidatePicker}
      sourceInput={providers.sourceInput}
      credentialFlow={providers.credentialFlow}
      selectedSource={providers.selectedSource}
      showDetails={providers.showDetails}
      canRegister={providers.canRegister}
      canAddInstalled={providers.canAddInstalled}
      colorEnabled={colorEnabled}
    />
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
  const accent = tuiAppearance(colorEnabled).accent;
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
        <Text>Local connections close safely with this TUI; background connections can remain available after it exits.</Text>
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
  const [foregroundConnectionRecoveryId, setForegroundConnectionRecoveryId] =
    useState<string | undefined>();
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
  const reportedForegroundFailuresRef = useRef(new Set<string>());

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
        summary: diagnosticsSummary(report),
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

  useEffect(() => {
    if (
      foregroundConnectionOperations === undefined ||
      typeof foregroundConnectionOperations.subscribe !== "function"
    ) {
      return;
    }
    return foregroundConnectionOperations.subscribe(() => {
      setForegroundConnections([...foregroundConnectionOperations.list()]);
    });
  }, [foregroundConnectionOperations]);

  useEffect(() => {
    if (operation !== undefined) {
      return;
    }
    const failed = foregroundConnections.find(
      (connection) =>
        connection.state === "failed" &&
        connection.failure !== undefined &&
        !reportedForegroundFailuresRef.current.has(connection.id),
    );
    if (failed === undefined || failed.failure === undefined) {
      return;
    }
    reportedForegroundFailuresRef.current.add(failed.id);
    setForegroundConnectionRecoveryId(failed.id);
    const serverLabel =
      snapshot === undefined ? "server" : serverDisplayName(snapshot, failed.instanceId);
    const servicePortFailure = foregroundConnectionNeedsServicePortEdit(failed);
    setOperation(
      presentOperationError({
        title: "Local connection failed",
        operation: "read",
        error: humanizeTuiServerError(failed.failure, {
          instanceId: failed.instanceId,
          serverLabel,
          accessMethodId: failed.accessMethod.id,
          connectionVocabulary: true,
        }),
        allowRetry: foregroundConnectionCanRetry(failed),
        retryLabel: "Retry connection",
        allowDiagnostics: true,
        ...(servicePortFailure ? { editLabel: "Edit service port" } : {}),
        ownsViewport: true,
      }),
    );
  }, [foregroundConnections, operation, snapshot]);

  const listForegroundAccessMethods = useCallback(
    async (
      instanceId: string,
    ): Promise<readonly AccessMethodDescriptor[] | undefined> => {
      if (foregroundConnectionOperations === undefined) {
        return undefined;
      }
      const serverLabel =
        snapshot === undefined ? "server" : serverDisplayName(snapshot, instanceId);
      setOperation(
        presentWorkingOperation({
          title: "Check connection method",
          detail: `Checking supported local access for ${serverLabel}.`,
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
            title: "Check connection method",
            operation: "read",
            error: humanizeTuiServerError(error, {
              instanceId,
              serverLabel,
              connectionVocabulary: true,
            }),
            allowRetry: false,
            allowDiagnostics: true,
          }),
        );
        return undefined;
      }
    },
    [foregroundConnectionOperations, snapshot],
  );

  const openForegroundConnection = useCallback(
    async (
      request: TuiForegroundConnectionRequest,
    ): Promise<TuiForegroundConnection | undefined> => {
      if (foregroundConnectionOperations === undefined) {
        return undefined;
      }
      const serverLabel =
        snapshot === undefined ? "server" : serverDisplayName(snapshot, request.instanceId);
      setOperation(
        presentWorkingOperation({
          title: "Open local connection",
          detail: `${serverLabel} · app/service port ${request.remotePort}`,
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
        const localPortConflict =
          connectionFailureDetails(error)?.cause === "local-bind-conflict";
        setOperation(
          presentOperationError({
            title: "Open local connection",
            operation: "read",
            error: humanizeTuiServerError(error, {
              instanceId: request.instanceId,
              serverLabel,
              accessMethodId: request.accessMethodId,
              connectionVocabulary: true,
            }),
            allowRetry:
              !localPortConflict &&
              (!isNormalizedError(error) ||
                (error.code !== "not-found" &&
                  error.code !== "unsupported-operation" &&
                  error.code !== "cancelled" &&
                  error.code !== "outcome-unknown")),
            retryLabel: "Retry connection",
            allowDiagnostics: !localPortConflict,
            ...(localPortConflict ? { editLabel: "Edit local port" } : {}),
          }),
        );
        return undefined;
      }
    },
    [foregroundConnectionOperations, snapshot],
  );

  const retryForegroundConnection = useCallback(
    async (id: string): Promise<TuiForegroundConnection | undefined> => {
      if (foregroundConnectionOperations === undefined) {
        return undefined;
      }
      const failed = foregroundConnectionOperations.list().find((item) => item.id === id);
      if (failed === undefined || failed.state !== "failed") {
        return undefined;
      }
      const serverLabel =
        snapshot === undefined ? "server" : serverDisplayName(snapshot, failed.instanceId);
      setOperation(
        presentWorkingOperation({
          title: "Retry local connection",
          detail: `${serverLabel} · app/service port ${failed.remotePort}`,
          activity: "waiting-provider",
        }),
      );
      try {
        const connection = await foregroundConnectionOperations.retry(
          id,
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
        setForegroundConnectionRecoveryId(undefined);
        setOperation(undefined);
        return connection;
      } catch (error) {
        setPendingHostTrustConfirmation(undefined);
        setForegroundConnections([...foregroundConnectionOperations.list()]);
        const failureCause = connectionFailureDetails(error)?.cause;
        const servicePortFailure = failureCause === "remote-service-unavailable";
        const localPortConflict = failureCause === "local-bind-conflict";
        setOperation(
          presentOperationError({
            title: "Retry local connection",
            operation: "read",
            error: humanizeTuiServerError(error, {
              instanceId: failed.instanceId,
              serverLabel,
              accessMethodId: failed.accessMethod.id,
              connectionVocabulary: true,
            }),
            allowRetry:
              !localPortConflict &&
              (!isNormalizedError(error) ||
                (error.code !== "not-found" &&
                  error.code !== "unsupported-operation" &&
                  error.code !== "cancelled" &&
                  error.code !== "outcome-unknown" &&
                  failureCause !== "ssh-host-identity-mismatch")),
            retryLabel: "Retry connection",
            allowDiagnostics: !localPortConflict,
            ...(localPortConflict
              ? { editLabel: "Edit local port" }
              : servicePortFailure
                ? { editLabel: "Edit service port" }
                : {}),
            ownsViewport: true,
          }),
        );
        return undefined;
      }
    },
    [foregroundConnectionOperations, snapshot],
  );

  const closeForegroundConnection = useCallback(
    async (id: string): Promise<boolean> => {
      if (foregroundConnectionOperations === undefined) {
        return false;
      }
      const connection = foregroundConnectionOperations.list().find((item) => item.id === id);
      if (connection?.state === "failed") {
        await foregroundConnectionOperations.close(id);
        setForegroundConnections([...foregroundConnectionOperations.list()]);
        return true;
      }
      const serverLabel =
        connection === undefined || snapshot === undefined
          ? "server"
          : serverDisplayName(snapshot, connection.instanceId);
      setOperation(
        presentWorkingOperation({
          title: "Close local connection",
          detail: "Closing the local connection and its access transport.",
          activity: "verifying-state",
        }),
      );
      const closing = foregroundConnectionOperations.close(id);
      setForegroundConnections([...foregroundConnectionOperations.list()]);
      try {
        await closing;
        setForegroundConnections([...foregroundConnectionOperations.list()]);
        setOperation(
          presentCompletedOperation({ title: "Local connection closed" }),
        );
        return true;
      } catch (error) {
        setForegroundConnections([...foregroundConnectionOperations.list()]);
        setOperation(
          presentOperationError({
            title: "Close local connection",
            operation: "read",
            error:
              connection === undefined
                ? normalizedError(
                    "plugin-failure",
                    "The local connection could not be closed. Open Diagnostics for details.",
                  )
                : humanizeTuiServerError(error, {
                    instanceId: connection.instanceId,
                    serverLabel,
                    accessMethodId: connection.accessMethod.id,
                    connectionVocabulary: true,
                  }),
            allowRetry: false,
          }),
        );
        return false;
      }
    },
    [foregroundConnectionOperations, snapshot],
  );

  const closeForegroundConnectionsForExit = useCallback(async (): Promise<boolean> => {
    if (foregroundConnectionOperations === undefined) {
      return foregroundConnections.length === 0;
    }
    const count = foregroundConnectionOperations.list().length;
    setOperation(
      presentWorkingOperation({
        title: `Closing ${count} local ${count === 1 ? "connection" : "connections"}`,
        detail: "Connections owned by this TUI close before it exits.",
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
          title: "Close local connections before exit",
          operation: "read",
          error: normalizedError(
            isNormalizedError(error) ? error.code : "plugin-failure",
            "One or more local connections could not be closed. Open Diagnostics for details.",
          ),
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
          title: "Create background local connection",
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
            title: "Create background local connection",
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
      const session =
        snapshot?.daemon.status === "running" && snapshot.daemon.sessions.status === "ready"
          ? snapshot.daemon.sessions.items?.find((item) => item.id === id)
          : undefined;
      const serverLabel =
        session === undefined || snapshot === undefined
          ? "server"
          : serverDisplayName(snapshot, session.instanceId);
      setOperation(
        presentWorkingOperation({
          title: "Close background local connection",
          detail: `Closing the background connection for ${serverLabel}.`,
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
            title: "Close background local connection",
            operation: "read",
            error:
              session === undefined
                ? normalizedError(
                    "plugin-failure",
                    "The background connection could not be closed. Open Diagnostics for details.",
                  )
                : humanizeTuiServerError(error, {
                    instanceId: session.instanceId,
                    serverLabel,
                    accessMethodId: session.accessMethod.id,
                    connectionVocabulary: true,
                  }),
            allowRetry: false,
          }),
        );
        return false;
      }
    },
    [daemonOperations, refresh, snapshot],
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

  const reviewEndpointIntentHostTrust = useCallback(
    (intent: TuiEndpointIntentReadItem): void => {
      const evidence = intent.failure?.hostTrust;
      if (daemonOperations === undefined || evidence === undefined) {
        return;
      }
      const trust = hostTrustRequiredError(
        evidence.target.host,
        evidence.target.port,
        evidence.key.type,
        evidence.key.fingerprint,
      );
      const serverLabel =
        snapshot === undefined
          ? "server"
          : serverDisplayName(snapshot, intent.instanceId);
      void (async () => {
        const accepted = await new Promise<boolean>((resolve) => {
          setPendingHostTrustConfirmation({ resolve });
          setOperation(presentHostTrustRequest(trust));
        });
        if (!accepted) {
          return;
        }
        setOperation(
          presentWorkingOperation({
            title: "Trust SSH host and retry saved connection",
            detail: `${serverLabel} · verifying the reviewed fingerprint before updating EasyServer host trust.`,
            activity: "verifying-state",
          }),
        );
        try {
          await daemonOperations.enrollHostKey(trust);
          await daemonOperations.retryEndpointIntent(intent.operationName);
          await refresh();
          setOperation(
            presentCompletedOperation({
              title: "SSH host trusted; saved connection retry requested",
              detail: `${intent.name} keeps the same saved definition while the daemon realizes a fresh transport.`,
            }),
          );
        } catch (error) {
          await refresh({ quiet: true });
          setOperation(
            presentOperationError({
              title: "Trust SSH host for saved connection",
              operation: "read",
              error: humanizeTuiServerError(error, {
                instanceId: intent.instanceId,
                serverLabel,
                accessMethodId: intent.requestedAccessMethodId,
                connectionVocabulary: true,
              }),
              allowRetry: false,
              allowDiagnostics: true,
              ownsViewport: true,
            }),
          );
        }
      })();
    },
    [daemonOperations, refresh, snapshot],
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
      const serverLabel =
        snapshot === undefined ? "server" : serverDisplayName(snapshot, mutation.instanceId);
      let warning: string | undefined;
      let observing = false;
      setOperation(
        presentWorkingOperation({
          title,
          detail: serverLabel,
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
                    ? `Observing ${serverLabel} until its state converges.`
                    : `Dispatching the requested operation for ${serverLabel}.`,
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
                presentMutationConfirmation(
                  {
                    summary: `Destroy ${serverLabel}?`,
                    risks: [...prompt.risks],
                    consequence: destroyServerConsequence(details),
                  },
                  {
                    target: serverLabel,
                    affectedResources: destroyAffectedResources(details),
                  },
                ),
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
            detail: `${serverLabel} observed state=${result.observedState}.${warning === undefined ? "" : ` Warning: ${warning}`}`,
          }),
        );
      } catch (error) {
        setPendingInstanceConfirmation(undefined);
        setOperation(
          presentOperationError({
            title: observing ? "Observe server state" : title,
            operation: observing ? "read" : "mutation",
            error: humanizeTuiServerError(error, {
              instanceId: mutation.instanceId,
              serverLabel,
            }),
          }),
        );
      }
    },
    [instanceMutationRunner, refresh, snapshot],
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
      const requestedResults = mutation.instanceIds.map((instanceId, targetIndex) => ({
        instanceId: bulkServerDisplayName(snapshot, instanceId, targetIndex),
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
                  presentMutationConfirmation(
                    {
                      ...prompt,
                      summary: `${title}?`,
                      consequence: "Permanently destroys the selected servers and closes their managed connections.",
                    },
                    {
                      target: `${details.targets.length} selected ${details.targets.length === 1 ? "server" : "servers"}`,
                      affectedResources: bulkInstanceConfirmationResources(snapshot, details),
                    },
                  ),
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
        setOperation(
          presentBulkInstanceResult(
            title,
            humanizeBulkInstanceResult(snapshot, result),
            warnings.map((warning) =>
              mutation.instanceIds.reduce(
                (message, instanceId, targetIndex) =>
                  humanizeBulkInstanceMessage(
                    message,
                    snapshot,
                    instanceId,
                    bulkServerDisplayName(snapshot, instanceId, targetIndex),
                  ),
                warning,
              ),
            ),
          ),
        );
      } catch (error) {
        if (bulkMutationControllerRef.current === controller) {
          bulkMutationControllerRef.current = undefined;
        }
        setPendingInstanceConfirmation(undefined);
        setOperation(
          presentOperationError({
            title,
            operation: "mutation",
            error: humanizeBulkMutationError(error, snapshot, mutation.instanceIds),
          }),
        );
      }
    },
    [bulkInstanceMutationRunner, refresh, snapshot],
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
      if (action === "retry" && foregroundConnectionRecoveryId !== undefined) {
        void retryForegroundConnection(foregroundConnectionRecoveryId);
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
        setForegroundConnectionRecoveryId(undefined);
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
      foregroundConnectionRecoveryId,
      refresh,
      removeEndpointIntent,
      retryForegroundConnection,
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
      foregroundConnectionRecoveryId={foregroundConnectionRecoveryId}
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
      onRetryForegroundConnection={
        foregroundConnectionOperations === undefined
          ? undefined
          : retryForegroundConnection
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
      onReviewEndpointIntentHostTrust={
        daemonOperations === undefined || operation?.phase === "working"
          ? undefined
          : reviewEndpointIntentHostTrust
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
