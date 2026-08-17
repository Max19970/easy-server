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
  type TuiBulkInstanceMutationResult,
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
  hostTrustRequiredError,
  isNormalizedError,
  normalizedError,
  PROVIDER_CAPABILITIES,
  type AvailableAction,
  type OperationContext,
  type ProviderInteractiveEvent,
  type ProviderInteractiveScreen,
} from "@easyai101/easyserver-plugin-sdk";
import {
  moveTuiFocus,
  tuiFocusWindowWithinRows,
} from "./tui-focus.js";
import { escapeTerminalText } from "./terminal-text.js";
import type { DiagnosticsReport } from "./diagnostics.js";
import { EASYSERVER_VERSION } from "./version.js";

interface TuiDiagnosticsSummary {
  readonly version: string;
  readonly stateStatus: DiagnosticsReport["state"]["status"];
  readonly configuredPlugins: number;
  readonly failedPlugins: number;
  readonly daemonStatus: DiagnosticsReport["daemon"]["status"];
  readonly ssh: DiagnosticsReport["access"]["ssh"];
  readonly sshKeyscan: DiagnosticsReport["access"]["sshKeyscan"];
}

type TuiDiagnosticsView =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly text: string;
      readonly summary: TuiDiagnosticsSummary;
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

type TuiContextActionId =
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

interface TuiContextAction {
  readonly id: TuiContextActionId;
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
  const diagnosticsReportRows = Math.max(1, routeContentRows - 3);
  const diagnosticsVisualLines =
    diagnostics.status === "ready"
      ? wrapDiagnosticsText(diagnostics.text, routeContentColumns)
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
          label: instanceDetailsOpen ? "Hide technical details" : "Show technical details",
        });
        if (
          selectedInstance.freshness === "fresh" &&
          onOpenForegroundConnection !== undefined &&
          onListForegroundAccessMethods !== undefined
        ) {
          actions.unshift({ id: "instance-connect", label: "Connect" });
        }
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
              label: instanceActionLabel(action),
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
              label: `${action.slice("instance.".length)} ${bulkSelectedInstanceIds.length} selected server${bulkSelectedInstanceIds.length === 1 ? "" : "s"}`,
            });
          }
        }
      }
      return actions;
    }
    if (activeRoute.id === "providers") {
      const actions: TuiContextAction[] = [{ id: "refresh", label: "Refresh providers" }];
      if (canRegisterProvider) {
        actions.unshift({
          id: "provider-add-advanced",
          label: "Advanced: add module or path",
        });
        if (canAddInstalledProvider) {
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
      const actions: TuiContextAction[] = [
        { id: "refresh", label: "Refresh acquisition options" },
      ];
      if (workflowItems.length === 0) {
        actions.unshift({ id: "providers", label: "Open Providers" });
      }
      return actions;
    }
    if (activeRoute.id === "sessions") {
      const actions: TuiContextAction[] = [
        { id: "connection-details", label: connectionDetailsOpen ? "Hide technical details" : "Show technical details" },
        { id: "refresh", label: "Refresh connections" },
      ];
      if (canStartForegroundConnection) {
        actions.unshift({ id: "connection-new-foreground", label: "New local connection" });
      } else if (
        readSnapshot?.instances.status === "ready" &&
        inventoryItems.length === 0
      ) {
        actions.unshift({ id: "new-instance", label: "Rent a server" });
      }
      if (
        selectedConnectionTarget?.kind === "foreground" &&
        selectedForegroundConnection?.state === "failed"
      ) {
        if (
          foregroundConnectionCanRetry(selectedForegroundConnection) &&
          onRetryForegroundConnection !== undefined
        ) {
          actions.push({ id: "connection-retry-foreground", label: "Retry connection" });
        }
        if (
          foregroundConnectionNeedsServicePortEdit(selectedForegroundConnection) &&
          onCloseForegroundConnection !== undefined
        ) {
          actions.push({ id: "connection-edit-service-port", label: "Edit service port" });
        }
        if (onCloseForegroundConnection !== undefined) {
          actions.push({
            id: "connection-close-foreground",
            label: "Dismiss failed connection",
          });
        }
      } else if (
        selectedConnectionTarget?.kind === "foreground" &&
        onCloseForegroundConnection !== undefined
      ) {
        actions.push({
          id: "connection-close-foreground",
          label: "Close local connection",
        });
      } else if (
        selectedConnectionTarget?.kind === "persistent" &&
        onClosePersistentSession !== undefined
      ) {
        actions.push({ id: "connection-close-persistent", label: "Close local connection" });
      }
      if (connectionDetailsOpen) {
        if (
          onCreatePersistentSession !== undefined &&
          onListForegroundAccessMethods !== undefined
        ) {
          actions.push({ id: "connection-new-persistent", label: "Advanced: new background connection" });
        }
        if (onStartDaemon !== undefined && onStopDaemon !== undefined) {
          actions.push({
            id: "daemon-toggle",
            label: readSnapshot?.daemon.status === "running"
              ? "Advanced: stop background connection service"
              : "Advanced: start background connection service",
          });
        }
        if (selectedTargetIntent !== undefined && onSetEndpointIntentEnabled !== undefined) {
          actions.push({
            id: "intent-toggle",
            label: selectedTargetIntent.enabled ? "Disable selected saved connection" : "Enable selected saved connection",
          });
          if (
            selectedTargetIntent.state === "error" &&
            selectedTargetIntent.failure?.hostTrust !== undefined &&
            onReviewEndpointIntentHostTrust !== undefined
          ) {
            actions.push({ id: "intent-host-trust", label: "Review SSH fingerprint" });
          }
          if (selectedTargetIntent.state === "error" && onRetryEndpointIntent !== undefined) {
            actions.push({ id: "intent-retry", label: "Retry selected saved connection" });
          }
          if (onRemoveEndpointIntent !== undefined) {
            actions.push({ id: "intent-remove", label: "Remove selected saved connection" });
          }
        }
      }
      return actions;
    }
    const actions: TuiContextAction[] = [{ id: "refresh", label: "Refresh diagnostics" }];
    if (diagnostics.status === "ready") {
      actions.unshift({ id: "diagnostics-view", label: "View report" });
      if (onCopyDiagnostics !== undefined) {
        actions.push({ id: "diagnostics-copy", label: "Copy report" });
      }
    }
    actions.push(
      { id: "providers", label: "Open Providers" },
      { id: "connections", label: "Open Connections" },
    );
    return actions;
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

  const accent = colorEnabled ? "cyan" : undefined;
  const muted = colorEnabled ? "gray" : undefined;
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
              diagnosticsReportOpen={diagnosticsReportOpen}
              diagnosticsScroll={diagnosticsScroll}
              canCopyDiagnostics={onCopyDiagnostics !== undefined}
              screenReader={screenReader}
              height={routeSurfaceRows}
              width={routeContentColumns}
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
              providerCandidatePicker={providerCandidatePickerView}
              providerSourceInput={providerSourceInput}
              providerCredentialFlow={providerCredentialFlowView}
              selectedProviderSource={effectiveSelectedProviderSource}
              showProviderDetails={providerDetailsOpen}
              canRegisterProvider={canRegisterProvider}
              canAddInstalledProvider={canAddInstalledProvider}
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
  const accent = colorEnabled ? "cyan" : undefined;
  const muted = colorEnabled ? "gray" : undefined;
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

interface RouteSurfaceProps {
  readonly route: TuiRoute;
  readonly snapshot?: TuiReadSnapshot;
  readonly readStatus: TuiReadStatus;
  readonly diagnostics: TuiDiagnosticsView;
  readonly diagnosticsReportOpen: boolean;
  readonly diagnosticsScroll: number;
  readonly canCopyDiagnostics: boolean;
  readonly screenReader: boolean;
  readonly height: number;
  readonly width: number;
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
  readonly providerCandidatePicker?: ProviderCandidatePickerView;
  readonly providerSourceInput?: string;
  readonly providerCredentialFlow?: ProviderCredentialFlowView;
  readonly selectedProviderSource?: string;
  readonly showProviderDetails: boolean;
  readonly canRegisterProvider: boolean;
  readonly canAddInstalledProvider: boolean;
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
  diagnosticsReportOpen,
  diagnosticsScroll,
  canCopyDiagnostics,
  screenReader,
  height,
  width,
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
  providerCandidatePicker,
  providerSourceInput,
  providerCredentialFlow,
  selectedProviderSource,
  showProviderDetails,
  canRegisterProvider,
  canAddInstalledProvider,
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
        reportOpen={diagnosticsReportOpen}
        scroll={diagnosticsScroll}
        canCopy={canCopyDiagnostics}
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

  if (route.id === "overview") {
    return <OverviewSurface snapshot={snapshot} />;
  }
  if (route.id === "new-instance") {
    if (providerInteractiveScreen !== undefined) {
      return (
        <ProviderInteractiveSurface
          key={`${providerInteractiveScreen.kind}:${providerInteractiveScreen.id}`}
          screen={providerInteractiveScreen}
          colorEnabled={false}
          disabled={providerInteractiveDisabled}
          height={height}
          screenReader={screenReader}
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
        height={height}
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
        height={height}
        screenReader={screenReader}
        flow={foregroundConnectionFlow}
        busy={foregroundConnectionBusy}
        connections={foregroundConnections}
        selectedConnectionId={selectedForegroundConnectionId}
        selectedPersistentSessionId={selectedPersistentSessionId}
        selectedEndpointIntentName={selectedEndpointIntentName}
        selectedConnectionTarget={selectedConnectionTarget}
        showDetails={showConnectionDetails}
      />
    );
  }
  return (
    <ProvidersSurface
      snapshot={snapshot}
      height={height}
      candidatePicker={providerCandidatePicker}
      sourceInput={providerSourceInput}
      credentialFlow={providerCredentialFlow}
      selectedSource={selectedProviderSource}
      showDetails={showProviderDetails}
      canRegister={canRegisterProvider}
      canAddInstalled={canAddInstalledProvider}
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
  reportOpen,
  scroll,
  canCopy,
  screenReader,
  height,
  width,
  colorEnabled,
}: {
  readonly diagnostics: TuiDiagnosticsView;
  readonly reportOpen: boolean;
  readonly scroll: number;
  readonly canCopy: boolean;
  readonly screenReader: boolean;
  readonly height: number;
  readonly width: number;
  readonly colorEnabled: boolean;
}): React.ReactElement {
  const muted = colorEnabled ? "gray" : undefined;
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
      <Text>Local state: {diagnosticsStateLabel(summary.stateStatus)}</Text>
      <Text>
        Providers: {summary.configuredPlugins} configured{summary.failedPlugins > 0 ? ` · ${summary.failedPlugins} need attention` : " · no reported failures"}
      </Text>
      <Text>Connection service: {diagnosticsDaemonLabel(summary.daemonStatus)}</Text>
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

function diagnosticsSummary(report: DiagnosticsReport): TuiDiagnosticsSummary {
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

function wrapDiagnosticsText(text: string, width: number): readonly string[] {
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

interface InstancesSurfaceProps {
  readonly snapshot: TuiReadSnapshot;
  readonly height: number;
  readonly selectedInstanceId?: string;
  readonly showDetails: boolean;
  readonly bulkSelectedInstanceIds: readonly string[];
  readonly canMutate: boolean;
  readonly canBulkMutate: boolean;
}

function InstancesSurface({
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

function ConnectionsSurface({
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
}: {
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
}): React.ReactElement {
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
                    <Text key={instance.id} bold={instance.id === flow.instanceId} wrap="truncate">
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
                <Text key={`${connection.kind}:${connection.id}`} bold={selectedRow} wrap="truncate">
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
            <PersistentSessionDetail session={selectedPersistent} />
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

function serverListLabel(
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

function serverDisplayName(snapshot: TuiReadSnapshot, instanceId: string): string {
  if (snapshot.instances.status !== "ready") {
    return "server";
  }
  const index = snapshot.instances.items.findIndex((instance) => instance.id === instanceId);
  const server = index < 0 ? undefined : snapshot.instances.items[index];
  return server === undefined ? "server" : serverListLabel(server, index, snapshot.instances.items);
}

function bulkServerDisplayName(
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

function humanizeBulkInstanceMessage(
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

function humanizeBulkMutationError(
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

function humanizeBulkInstanceResult(
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
  const code = intent.failure?.code;
  const message = intent.failure?.message ?? "";
  if (code === "host-trust-required") {
    return intent.failure?.hostTrust === undefined
      ? "refresh the saved connection to obtain structured SSH trust evidence, then review the fingerprint before retrying"
      : "use Actions to review this exact SSH fingerprint; after approval EasyServer retries the same saved connection";
  }
  if (code === "authentication") {
    if (/SSH public-key authentication/iu.test(message)) {
      return "make the matching SSH private key available on this computer or authorize its public key on the server, then retry";
    }
    if (/SSH host key mismatch|SSH host identity/iu.test(message)) {
      return "verify whether the server was replaced or reinstalled; changed trusted host identity remains blocked until you deliberately correct EasyServer host trust";
    }
    if (/SSH authentication/iu.test(message)) {
      return "check the SSH login or key expected by the server, then retry";
    }
    return "configure or rotate the required provider credential in Providers, then use Actions to retry";
  }
  if (code === "provider-unavailable") {
    if (/requested service port is not accepting|requested service could not be reached/iu.test(message)) {
      return "SSH works; start the app/service or correct its configured port, then retry the saved connection";
    }
    if (/could not obtain the SSH host fingerprint/iu.test(message)) {
      return "EasyServer could not safely obtain a fingerprint yet; retry, and check local SSH tools in Diagnostics if direct SSH works repeatedly";
    }
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

function ProvidersSurface({
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

function previousForegroundConnectionStep(
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

function humanizeTuiServerError(
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
  if (connectionVocabulary && error.code === "provider-unavailable") {
    if (error.message.includes("could not obtain the SSH host fingerprint")) {
      return normalizedError(
        error.code,
        `EasyServer could not obtain an SSH host fingerprint for ${serverLabel}, so it cannot safely ask you to trust a key yet. Retry connection; if direct SSH works but this keeps failing, check the local SSH tools in Diagnostics.`,
      );
    }
    if (error.message.includes("SSH connected, but the requested service port is not accepting connections yet")) {
      return normalizedError(
        error.code,
        `SSH to ${serverLabel} works, but the requested app/service port is not accepting connections yet. Start or wait for that service, or edit the service port, then retry.`,
      );
    }
    if (error.message.includes("SSH connected, but the requested service could not be reached from the server")) {
      return normalizedError(
        error.code,
        `SSH to ${serverLabel} works, but the requested app/service port could not be reached from the server. Verify the service is running and the port is correct, then retry.`,
      );
    }
    if (error.message.includes("The SSH route closed before TCP forwarding was established")) {
      return normalizedError(
        error.code,
        `The SSH route to ${serverLabel} closed before app/service forwarding was established. Retry the connection; if direct SSH keeps working while forwarding fails, check Diagnostics or try another available connection method.`,
      );
    }
    if (error.message.includes("SSH on the server is not ready or reachable yet")) {
      return normalizedError(
        error.code,
        `SSH for ${serverLabel} is not ready or reachable yet. If the server just started, wait a moment and retry; otherwise check Diagnostics.`,
      );
    }
    return normalizedError(
      error.code,
      `Could not prepare a connection to ${serverLabel}. If the server just started, wait a moment and retry; otherwise refresh Servers or open Diagnostics.`,
    );
  }
  if (error.code === "provider-unavailable") {
    return normalizedError(
      error.code,
      `Could not reach ${serverLabel}. Refresh Servers; use Providers or Diagnostics if the problem continues.`,
    );
  }
  if (connectionVocabulary && error.code === "authentication") {
    if (error.message.includes("changed before trust confirmation")) {
      return normalizedError(
        error.code,
        `The SSH fingerprint for ${serverLabel} changed since you reviewed it. Nothing was trusted. Retry connection to review the current fingerprint before continuing.`,
      );
    }
    if (
      /SSH host key (?:mismatch|changed)|SSH host identity/iu.test(error.message)
    ) {
      return normalizedError(
        error.code,
        `SSH host identity for ${serverLabel} changed. EasyServer blocked the connection. Verify the server was replaced or reinstalled before trusting a new host key; if the change is expected, remove the stale EasyServer host key and retry.`,
      );
    }
    if (error.message.includes("SSH public-key authentication was rejected")) {
      return normalizedError(
        error.code,
        `SSH public-key authentication to ${serverLabel} was rejected. Make sure the matching SSH private key is available to EasyServer/OpenSSH and its public key is authorized on the server, then retry.`,
      );
    }
    return normalizedError(
      error.code,
      `Connection authentication for ${serverLabel} was rejected. Check the login or key expected by the server and retry; this does not necessarily mean the provider API credential is wrong.`,
    );
  }
  if (error.code === "authentication") {
    return normalizedError(
      error.code,
      `Credentials need attention before ${serverLabel} can be used. Open Providers to review them.`,
    );
  }
  if (
    connectionVocabulary &&
    error.code === "unsupported-operation" &&
    error.message.includes("does not permit TCP forwarding")
  ) {
    return normalizedError(
      error.code,
      `SSH to ${serverLabel} works, but this SSH route does not allow TCP forwarding. Choose another connection method if one is available, or use a server/SSH route that permits forwarding.`,
    );
  }
  if (
    connectionVocabulary &&
    error.code === "plugin-failure" &&
    error.message.includes("Local OpenSSH client could not be started")
  ) {
    return normalizedError(
      error.code,
      "This computer could not start OpenSSH. Install or enable OpenSSH Client, make sure ssh is available, then retry. Open Diagnostics to check local SSH tools.",
    );
  }
  if (
    connectionVocabulary &&
    error.code === "plugin-failure" &&
    error.message === "OpenSSH connection failed unexpectedly."
  ) {
    return normalizedError(
      error.code,
      `The SSH transport to ${serverLabel} ended unexpectedly. Retry connection. Diagnostics can check local SSH and provider readiness, but raw SSH output is intentionally not retained.`,
    );
  }
  if (error.code === "plugin-failure" || error.code === "unknown-provider-error") {
    return normalizedError(
      error.code,
      `EasyServer could not complete this operation for ${serverLabel}. Open Diagnostics to check current EasyServer and provider readiness.`,
    );
  }
  if (connectionVocabulary && error.code === "unsupported-operation") {
    return normalizedError(
      error.code,
      `No supported connection method is currently available for ${serverLabel}.`,
    );
  }
  if (error.code === "not-found" && error.message.includes(instanceId)) {
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

function parseConnectionPort(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) {
    return undefined;
  }
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? port
    : undefined;
}

function foregroundConnectionNeedsServicePortEdit(
  connection: TuiForegroundConnection,
): boolean {
  return (
    connection.state === "failed" &&
    connection.failure?.code === "provider-unavailable" &&
    (connection.failure.message.includes(
      "requested service port is not accepting connections",
    ) ||
      connection.failure.message.includes(
        "requested service could not be reached from the server",
      ))
  );
}

function foregroundConnectionCanRetry(
  connection: TuiForegroundConnection,
): boolean {
  if (connection.state !== "failed" || connection.failure === undefined) {
    return false;
  }
  return (
    connection.failure.code !== "unsupported-operation" &&
    !(
      connection.failure.code === "authentication" &&
      /SSH host identity no longer matches|SSH host key mismatch/iu.test(
        connection.failure.message,
      )
    )
  );
}

function foregroundConnectionFlowFromFailedConnection(
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

function instanceMutationStatus(mutation: TuiInstanceMutation): string {
  return mutation.kind === "adopt"
    ? "Server adoption requested."
    : `${instanceActionLabel(mutation.action)} requested.`;
}

function bulkInstanceMutationStatus(mutation: TuiBulkInstanceMutation): string {
  return `${instanceActionLabel(mutation.action)} requested for ${mutation.instanceIds.length} selected ${mutation.instanceIds.length === 1 ? "server" : "servers"}.`;
}

function instanceMutationTitle(mutation: TuiInstanceMutation): string {
  return mutation.kind === "adopt" ? "Adopt server" : instanceActionLabel(mutation.action);
}

function bulkInstanceMutationTitle(mutation: TuiBulkInstanceMutation): string {
  const verb = mutation.action.slice("instance.".length);
  return `${verb[0]?.toUpperCase() ?? ""}${verb.slice(1)} selected servers`;
}

function bulkInstanceConfirmationResources(
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

function destroyAffectedResources(
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

function destroyServerConsequence(details: InstanceDestroyConfirmationDetails): string {
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
      <Text bold>
        Selected servers ({instanceIds.length})
      </Text>
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

function instanceActionLabel(action: AvailableAction): string {
  const verb = action.slice("instance.".length);
  return `${verb[0]?.toUpperCase() ?? ""}${verb.slice(1)} server`;
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
          isNormalizedError(error) &&
          error.code === "conflict" &&
          error.message.startsWith("Local Endpoint port is already in use:");
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
        const servicePortFailure =
          isNormalizedError(error) &&
          error.code === "provider-unavailable" &&
          (error.message.includes("requested service port is not accepting connections") ||
            error.message.includes("requested service could not be reached from the server"));
        const localPortConflict =
          isNormalizedError(error) &&
          error.code === "conflict" &&
          error.message.startsWith("Local Endpoint port is already in use:");
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
                  !(
                    error.code === "authentication" &&
                    /SSH host key mismatch|SSH host identity no longer matches/iu.test(
                      error.message,
                    )
                  ))),
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
