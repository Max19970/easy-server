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
  | "providers"
  | "new-instance"
  | "sessions"
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
    label: "Overview",
    description: "EasyServer at a glance",
    body: "Choose a section to inspect or manage your EasyServer environment.",
  },
  {
    id: "instances",
    label: "Instances",
    description: "Compute inventory and lifecycle",
    body: "Instance inventory and lifecycle workflows will appear on this surface.",
  },
  {
    id: "providers",
    label: "Providers",
    description: "Plugins, setup and acquisition",
    body: "Provider readiness, credentials and provider-owned flows will appear here.",
  },
  {
    id: "new-instance",
    label: "New instance",
    description: "Provider-owned acquisition workflows",
    body: "Interactive provider acquisition workflows will appear here.",
  },
  {
    id: "sessions",
    label: "Connections",
    description: "Foreground Endpoints and persistent sessions",
    body: "TUI-owned foreground Endpoints and persistent sessions will appear here.",
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    description: "Health and support information",
    body: "Privacy-safe health and support information will appear here.",
  },
];

export type TuiReadStatus = "idle" | "loading" | "ready" | "stale" | "failed";

type ProviderCredentialFlow =
  | {
      readonly kind: "picker";
      readonly providerSource: string;
      readonly selectedName: string;
    }
  | {
      readonly kind: "secret";
      readonly providerSource: string;
      readonly credentialName: string;
      readonly secret: string;
    };

type ProviderCredentialFlowView =
  | Extract<ProviderCredentialFlow, { readonly kind: "picker" }>
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
  const narrow = columns < 72;
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [status, setStatus] = useState("Ready.");
  const [providerSourceInput, setProviderSourceInput] = useState<string | undefined>();
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
      : providerCredentialFlow.kind === "picker"
        ? providerCredentialFlow
        : {
            kind: "secret",
            providerSource: providerCredentialFlow.providerSource,
            credentialName: providerCredentialFlow.credentialName,
            hasSecret: providerCredentialFlow.secret.length > 0,
          };
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
    setSelectedInstanceId(navigateToInstanceId);
    setActiveIndex(instancesIndex);
    setFocusedIndex(instancesIndex);
    setStatus(`Opened ${navigateToInstanceId}.`);
    onInstanceNavigationHandled?.();
  }, [navigateToInstanceId, readSnapshot, onInstanceNavigationHandled]);

  const navigation = useMemo(
    () =>
      routes.map((route, index) => ({
        ...route,
        active: index === activeIndex,
        focused: index === focusedIndex,
      })),
    [activeIndex, focusedIndex],
  );

  const openRoute = (routeId: TuiRouteId, message?: string): void => {
    const index = routes.findIndex((route) => route.id === routeId);
    if (index < 0) {
      return;
    }
    setActiveIndex(index);
    setFocusedIndex(index);
    setStatus(message ?? `Opened ${routes[index]?.label ?? "Overview"}.`);
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

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      requestExit();
      return;
    }

    if (operation !== undefined) {
      const action = operationActionForInput(operation, input, key);
      if (action !== undefined) {
        onOperationAction?.(action);
        return;
      }
      if (operationInteractionOpen) {
        return;
      }
    }

    if (providerInteractiveScreen !== undefined) {
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
      if (providerCredentialFlow.kind === "picker") {
        if (input === "q") {
          requestExit();
          return;
        }
        if (key.escape) {
          setProviderCredentialFlow(undefined);
          setStatus("Credential setup closed.");
          return;
        }
        const currentIndex = Math.max(
          0,
          credentialFlowItems.findIndex(
            (credential) =>
              credential.name === providerCredentialFlow.selectedName,
          ),
        );
        if ((input === "j" || input === "k") && credentialFlowItems.length > 0) {
          const nextIndex =
            input === "j"
              ? (currentIndex + 1) % credentialFlowItems.length
              : (currentIndex - 1 + credentialFlowItems.length) %
                credentialFlowItems.length;
          const next = credentialFlowItems[nextIndex];
          if (next !== undefined) {
            setProviderCredentialFlow({
              ...providerCredentialFlow,
              selectedName: next.name,
            });
          }
          return;
        }
        const selected = credentialFlowItems.find(
          (credential) =>
            credential.name === providerCredentialFlow.selectedName,
        );
        if (key.return && selected !== undefined) {
          setProviderCredentialFlow({
            kind: "secret",
            providerSource: providerCredentialFlow.providerSource,
            credentialName: selected.name,
            secret: "",
          });
          setStatus(`Enter a new value for credential ${selected.name}.`);
          return;
        }
        if (input === "x" && selected?.configured) {
          onProviderMutation?.({
            kind: "remove-credential",
            source: providerCredentialFlow.providerSource,
            name: selected.name,
          });
          setProviderCredentialFlow(undefined);
          setStatus(`Removing credential ${selected.name}.`);
          return;
        }
        return;
      }

      if (key.escape) {
        setProviderCredentialFlow({
          kind: "picker",
          providerSource: providerCredentialFlow.providerSource,
          selectedName: providerCredentialFlow.credentialName,
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
        if ((input === "j" || input === "k") && inventoryItems.length > 0) {
          const currentIndex = Math.max(
            0,
            inventoryItems.findIndex(
              (instance) => instance.id === foregroundConnectionFlow.instanceId,
            ),
          );
          const nextIndex =
            input === "j"
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
          (input === "j" || input === "k") &&
          foregroundConnectionFlow.accessMethods.length > 0
        ) {
          const currentIndex = Math.max(
            0,
            foregroundConnectionFlow.accessMethods.findIndex(
              (method) => method.id === foregroundConnectionFlow.accessMethodId,
            ),
          );
          const nextIndex =
            input === "j"
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
      } else if (activeIndex !== 0 || focusedIndex !== 0) {
        setActiveIndex(0);
        setFocusedIndex(0);
        setStatus("Returned to Overview.");
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
      activeRoute.id === "providers" &&
      input === "a" &&
      onProviderMutation !== undefined
    ) {
      setProviderSourceInput("");
      setStatus("Enter an installed provider module or path.");
      return;
    }

    if (
      activeRoute.id === "providers" &&
      input === "c" &&
      onProviderMutation !== undefined
    ) {
      const selected = providerItems.find(
        (provider) => provider.source === effectiveSelectedProviderSource,
      );
      if (selected?.state === "disabled") {
        setStatus("Enable the selected provider before managing credentials.");
        return;
      }
      if (selected?.state === "failed") {
        setStatus("Resolve the provider load failure before managing credentials.");
        return;
      }
      const firstCredential = selected?.credentials.items[0];
      if (selected !== undefined && firstCredential !== undefined) {
        setProviderCredentialFlow({
          kind: "picker",
          providerSource: selected.source,
          selectedName: firstCredential.name,
        });
        setStatus(`Managing credentials for ${selected.source}.`);
      } else {
        setStatus("The selected provider declares no credentials.");
      }
      return;
    }

    if (
      activeRoute.id === "providers" &&
      providerItems.length > 0 &&
      (input === "j" || input === "k")
    ) {
      const currentIndex = Math.max(
        0,
        providerItems.findIndex(
          (provider) => provider.source === effectiveSelectedProviderSource,
        ),
      );
      const nextIndex =
        input === "j"
          ? (currentIndex + 1) % providerItems.length
          : (currentIndex - 1 + providerItems.length) % providerItems.length;
      const next = providerItems[nextIndex];
      if (next !== undefined) {
        setSelectedProviderSource(next.source);
        setStatus(`Selected provider ${next.source}.`);
      }
      return;
    }

    if (
      activeRoute.id === "providers" &&
      input === "e" &&
      onProviderMutation !== undefined
    ) {
      const selected = providerItems.find(
        (provider) => provider.source === effectiveSelectedProviderSource,
      );
      if (selected !== undefined) {
        onProviderMutation({
          kind: "set-enabled",
          source: selected.source,
          enabled: selected.state === "disabled",
        });
        setStatus(
          `${selected.state === "disabled" ? "Enabling" : "Disabling"} provider ${selected.source}.`,
        );
      }
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
            `CLI fallback: easyserver provider ${selected.providerId} ${selected.featureId} ${selected.commandName}`,
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
      const route = routes[focusedIndex];
      if (route !== undefined) {
        openRoute(route.id);
      }
      return;
    }

    const backwards = key.upArrow || key.leftArrow || (key.tab && key.shift);
    const forwards = key.downArrow || key.rightArrow || (key.tab && !key.shift);
    if (!backwards && !forwards) {
      return;
    }

    setFocusedIndex((current) => {
      if (backwards) {
        return (current - 1 + routes.length) % routes.length;
      }
      return (current + 1) % routes.length;
    });
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
      <Text color={muted}>
        Control center · {narrow ? "compact layout" : "wide layout"}
      </Text>

      <Box
        flexDirection={narrow ? "column" : "row"}
        marginTop={1}
        gap={narrow ? 1 : 3}
      >
        <Box
          flexDirection="column"
          width={narrow ? "100%" : 25}
          aria-role="tablist"
        >
          {navigation.map((route) => (
            <Box
              key={route.id}
              aria-role="tab"
              aria-state={{ selected: route.active }}
              aria-label={`${route.label}${route.active ? ", active" : ""}${route.focused ? ", focused" : ""}`}
            >
              <Text
                bold={route.focused}
                color={route.focused ? accent : undefined}
              >
                {route.focused ? "> " : "  "}
                {route.label}
                {route.active ? " [active]" : ""}
              </Text>
            </Box>
          ))}
        </Box>

        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          {helpOpen ? (
            <HelpPanel colorEnabled={colorEnabled} />
          ) : (
            <Box flexDirection="column">
              <Text bold>{activeRoute.label}</Text>
              <Text color={muted}>{activeRoute.description}</Text>
              <Box marginTop={1} flexDirection="column">
                {readSnapshot !== undefined && readStatus === "stale" ? (
                  <Box flexDirection="column" marginBottom={1}>
                    <Text bold>Last refresh failed.</Text>
                    <Text>Showing the previous snapshot; press r to try again.</Text>
                  </Box>
                ) : null}
                <RouteSurface
                  route={activeRoute}
                  snapshot={readSnapshot}
                  readStatus={readStatus}
                  diagnostics={diagnostics}
                  canCopyDiagnostics={onCopyDiagnostics !== undefined}
                  narrow={narrow}
                  selectedInstanceId={selectedInstanceId}
                  bulkSelectedInstanceIds={bulkSelectedInstanceIds}
                  canMutateInstances={onInstanceMutation !== undefined}
                  canBulkMutateInstances={onBulkInstanceMutation !== undefined}
                  foregroundConnectionFlow={foregroundConnectionFlow}
                  foregroundConnectionBusy={foregroundConnectionBusy}
                  foregroundConnections={foregroundConnections}
                  selectedForegroundConnectionId={selectedForegroundConnectionId}
                  selectedPersistentSessionId={selectedPersistentSessionId}
                  selectedEndpointIntentName={effectiveSelectedEndpointIntentName}
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
                  providerSourceInput={providerSourceInput}
                  providerCredentialFlow={providerCredentialFlowView}
                  selectedProviderSource={effectiveSelectedProviderSource}
                  canRegisterProvider={onProviderMutation !== undefined}
                  selectedWorkflowKey={effectiveSelectedWorkflowKey}
                  providerInteractiveScreen={providerInteractiveScreen}
                  providerInteractiveDisabled={providerInteractiveDisabled}
                  onProviderInteractiveEvent={onProviderInteractiveEvent}
                  onProviderInteractiveClose={onProviderInteractiveClose}
                />
              </Box>
            </Box>
          )}
        </Box>
      </Box>

      {operation === undefined ? null : (
        <Box marginTop={1}>
          <TuiOperationDrawer operation={operation} colorEnabled={colorEnabled} />
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text aria-label={`Status: ${status}`}>Status: {status}</Text>
        {operationInteractionOpen ? (
          <Text color={muted} wrap="wrap">
            Confirmation has focus · use the actions shown above · q quit
          </Text>
        ) : operation !== undefined ? (
          <Text color={muted} wrap="wrap">
            Operation status shown · Tab/Shift+Tab or arrows still navigate · drawer actions use the keys shown above · q quit
          </Text>
        ) : providerInteractiveScreen !== undefined ? (
          <Text color={muted} wrap="wrap">
            Provider workflow has focus · use the commands shown in the workflow · Ctrl+C quit
          </Text>
        ) : screenReader ? (
          <Text>
            Commands: Tab or arrows move focus; Enter opens; Escape returns or closes help; question mark opens help; r refreshes; g opens privacy-safe Diagnostics; on Instances, J and K select, Space marks bulk targets, 0 clears marks, and number keys run lifecycle actions; on Connections, N starts a foreground Endpoint, P creates a persistent Session, D starts or stops the daemon, lowercase J/K/X manage foreground Endpoints, uppercase J/K/C manage persistent Sessions, brackets select persisted Endpoint intents, E toggles them, T retries Error state, and uppercase X removes after confirmation; on Diagnostics, lowercase c copies the reviewed payload, P opens Providers and uppercase C opens Connections; Q quits.
          </Text>
        ) : (
          <Text color={muted} wrap="wrap">
            Tab/Shift+Tab or arrows move · Enter open · Esc back · ? help · r refresh · g diagnostics{activeRoute.id === "instances" ? onInstanceMutation === undefined ? " · j/k select" : onBulkInstanceMutation === undefined ? " · j/k select · a adopt · 1-4 actions" : " · j/k select · Space mark · 0 clear · a adopt · 1-4 actions" : activeRoute.id === "sessions" ? " · n foreground · p persistent · d daemon · j/k/x foreground · J/K/c sessions · [/] intents · e toggle · t retry · X remove" : activeRoute.id === "providers" && onProviderMutation !== undefined ? " · j/k select · c credentials · e toggle · a register" : activeRoute.id === "new-instance" ? " · j/k select · Enter start" : activeRoute.id === "diagnostics" ? " · c copy · P providers · C connections" : ""} · q quit
          </Text>
        )}
      </Box>
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
  readonly selectedInstanceId?: string;
  readonly bulkSelectedInstanceIds: readonly string[];
  readonly canMutateInstances: boolean;
  readonly canBulkMutateInstances: boolean;
  readonly foregroundConnectionFlow?: ForegroundConnectionFlow;
  readonly foregroundConnectionBusy: boolean;
  readonly foregroundConnections: readonly TuiForegroundConnection[];
  readonly selectedForegroundConnectionId?: string;
  readonly selectedPersistentSessionId?: string;
  readonly selectedEndpointIntentName?: string;
  readonly canManageForegroundConnections: boolean;
  readonly canManagePersistentSessions: boolean;
  readonly canManageEndpointIntents: boolean;
  readonly canManageDaemon: boolean;
  readonly providerSourceInput?: string;
  readonly providerCredentialFlow?: ProviderCredentialFlowView;
  readonly selectedProviderSource?: string;
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
  selectedInstanceId,
  bulkSelectedInstanceIds,
  canMutateInstances,
  canBulkMutateInstances,
  foregroundConnectionFlow,
  foregroundConnectionBusy,
  foregroundConnections,
  selectedForegroundConnectionId,
  selectedPersistentSessionId,
  selectedEndpointIntentName,
  canManageForegroundConnections,
  canManagePersistentSessions,
  canManageEndpointIntents,
  canManageDaemon,
  providerSourceInput,
  providerCredentialFlow,
  selectedProviderSource,
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
      sourceInput={providerSourceInput}
      credentialFlow={providerCredentialFlow}
      selectedSource={selectedProviderSource}
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
      <Text bold>Readiness</Text>
      {providers.status === "failed" ? (
        <Text>Providers unavailable: {providers.message}</Text>
      ) : providerItems.length === 0 ? (
        <Text>No provider plugins configured. Open Providers for the next setup step.</Text>
      ) : (
        <Text>
          Providers: {providerItems.length} configured · {readyProviders} ready · {missingCredentials} credentials missing · {disabledPlugins} disabled · {failedPlugins} failed
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
            Instances: {instanceItems.length} total · {runningInstances} running · {staleInstances} stale · {unobservedInstances} unobserved
          </Text>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Daemon and connections</Text>
        <Text>Daemon: {snapshot.daemon.status}</Text>
        {snapshot.daemon.status !== "running" ? null : (
          <>
            <Text>
              Live sessions: {snapshot.daemon.sessions.status === "ready" ? snapshot.daemon.sessions.live : "unavailable"}
            </Text>
            <Text>
              Live Endpoint intents: {snapshot.daemon.endpointIntents.status === "ready" ? snapshot.daemon.endpointIntents.live : "unavailable"}
            </Text>
          </>
        )}
      </Box>

      {failedProviderOutcomes.length === 0 ? null : (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Provider issues</Text>
          {failedProviderOutcomes.map((provider) => (
            <Text key={provider.providerId}>
              {provider.providerId} · {provider.error.code} · {provider.error.message}
            </Text>
          ))}
          <Text>Healthy provider inventory remains available above.</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text>Support: press g to inspect the privacy-safe Diagnostics payload before sharing it.</Text>
      </Box>
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
        <Text>Press r to generate the privacy-safe support payload.</Text>
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
        <Text>Press r to retry. Do not substitute raw logs that may contain sensitive data.</Text>
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
          ? "Press c to copy exactly the JSON shown below; nothing else is added."
          : "Clipboard integration is unavailable in this TUI session; the exact safe payload is still shown below."}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>{diagnostics.text}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Support guidance</Text>
        <Text>Raw logs are not the same as this sanitized payload. Review raw logs separately and never share credentials, tokens or private keys.</Text>
        <Text>Press P to open Providers for plugin, credential or readiness remediation.</Text>
        <Text>Press C to open Connections for daemon, Endpoint or SSH remediation.</Text>
      </Box>
    </Box>
  );
}

interface InstancesSurfaceProps {
  readonly snapshot: TuiReadSnapshot;
  readonly narrow: boolean;
  readonly selectedInstanceId?: string;
  readonly bulkSelectedInstanceIds: readonly string[];
  readonly canMutate: boolean;
  readonly canBulkMutate: boolean;
}

function InstancesSurface({
  snapshot,
  narrow,
  selectedInstanceId,
  bulkSelectedInstanceIds,
  canMutate,
  canBulkMutate,
}: InstancesSurfaceProps): React.ReactElement {
  if (snapshot.instances.status === "failed") {
    return (
      <Box flexDirection="column">
        <Text>Instance inventory unavailable: {snapshot.instances.message}</Text>
        <Text>Press r to refresh. Other TUI sections remain available.</Text>
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
      <Text>
        j/k select instance{canBulkMutate ? " · Space mark/unmark · 0 clear marks" : ""}{canMutate ? " · a adopt · 1-4 lifecycle actions" : ""} · r refresh
      </Text>
      <Box marginTop={1} flexDirection="column">
        {items.map((instance) => (
          <Text key={instance.id} bold={instance.id === selected?.id}>
            {instance.id === selected?.id ? "> " : "  "}
            {canBulkMutate ? (marked.has(instance.id) ? "[x] " : "[ ] ") : ""}
            {narrow
              ? `${instance.name ?? instance.id} · ${instance.state ?? "unobserved"} · ${instance.freshness}`
              : `${instance.name ?? instance.id} · state=${instance.state ?? "unobserved"} · freshness=${instance.freshness} · provider=${instance.providerId} · management=${instance.management} · actions=${formatActions(availableInstanceActions(instance))}`}
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
            {selectedInstanceId} disappeared from the refreshed inventory. No action target has been changed; press j/k to choose a current instance.
          </Text>
        </Box>
      ) : selected === undefined ? null : (
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
              <Text>j/k select · Enter continue · Esc cancel</Text>
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
              <Text>j/k select · Enter continue · Esc back</Text>
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

  const selected = connections.find(
    (connection) => connection.id === selectedConnectionId,
  );
  const persistentSessions =
    snapshot.daemon.status === "running" && snapshot.daemon.sessions.status === "ready"
      ? snapshot.daemon.sessions.items ?? []
      : [];
  const selectedPersistent = persistentSessions.find(
    (session) => session.id === selectedPersistentSessionId,
  );
  const endpointIntents =
    snapshot.daemon.status === "running" &&
    snapshot.daemon.endpointIntents.status === "ready"
      ? snapshot.daemon.endpointIntents.items ?? []
      : [];
  const selectedIntent = endpointIntents.find(
    (intent) => intent.operationName === selectedEndpointIntentName,
  );
  return (
    <Box flexDirection="column">
      <Text>
        Foreground Endpoints belong to this TUI; persistent Endpoints belong to the daemon and survive TUI exit.
      </Text>
      <Text>
        {canManage ? "n new foreground" : "foreground unavailable"}
        {canManagePersistent ? " · p new persistent Session · J/K select Session · c close Session" : ""}
        {canManageIntents ? " · [/] select persisted intent · e enable/disable · t retry Error · X remove" : ""}
        {canManageDaemon ? " · d start/stop daemon" : ""}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>TUI-owned foreground Endpoints</Text>
        {connections.length === 0 ? (
          <Text>
            None open. {snapshot.instances.status === "ready" && snapshot.instances.items.length === 0 ? "Create or discover an instance first." : "Press n to create one."}
          </Text>
        ) : (
          <>
            <Text>j/k select · x close</Text>
            {connections.map((connection) => (
              <Text key={connection.id} bold={connection.id === selected?.id}>
                {connection.id === selected?.id ? "> " : "  "}
                {connection.endpoint.host}:{connection.endpoint.port} · {connection.state} · {connection.instanceId} → {escapeTerminalText(connection.remoteHost)}:{connection.remotePort} · {escapeTerminalText(connection.accessMethod.id)}
              </Text>
            ))}
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
            {canManageIntents ? <Text>[/] select · e enable/disable · t retry Error · X remove</Text> : null}
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
      <Box marginTop={1} flexDirection="column">
        <Text bold>Daemon-owned Connection Sessions (runtime state)</Text>
        <Text>Daemon: {snapshot.daemon.status}</Text>
        {snapshot.daemon.status === "stale" ? (
          <Text>Daemon state is stale because its descriptor is invalid. Start will reconcile the managed daemon state.</Text>
        ) : snapshot.daemon.status === "unreachable" ? (
          <Text>Daemon descriptor exists, but authenticated health failed. No session mutation is attempted.</Text>
        ) : snapshot.daemon.status === "stopped" ? (
          <Text>Daemon is stopped. Press d to start it.</Text>
        ) : "sessions" in snapshot.daemon && snapshot.daemon.sessions.status === "unavailable" ? (
          <Text>Daemon is healthy, but Connection Session details are temporarily unavailable.</Text>
        ) : persistentSessions.length === 0 ? (
          <Text>No persistent sessions. Press p to create one.</Text>
        ) : (
          <>
            <Text>J/K select · c close · p new</Text>
            {persistentSessions.map((session) => (
              <PersistentSessionLine
                key={session.id}
                session={session}
                selected={session.id === selectedPersistent?.id}
              />
            ))}
            {selectedPersistent === undefined ? null : (
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
      {selected ? "> " : "  "}{session.id} · {session.state} · {endpoint} · {session.instanceId} → {session.remoteHost}:{session.remotePort}
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
      {selected ? "> " : "  "}{intent.name} · desired={intent.enabled ? "enabled" : "disabled"} · {realization} · {intent.instanceId} → {intent.remoteHost}:{intent.remotePort} · requested-local-port={intent.requestedLocalPort ?? "dynamic"}
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
        <Text>Recovery: desired state is disabled; press e to enable and realize it again.</Text>
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
    return "review and enroll the exact SSH host fingerprint through a normal TUI connection flow, then press t to retry this intent";
  }
  if (code === "authentication") {
    return "configure or rotate the required provider credential in Providers, then press t to retry";
  }
  if (code === "provider-unavailable") {
    return "restore provider or instance availability, refresh state, then press t to retry";
  }
  if (code === "conflict" && /port/i.test(message)) {
    return "the requested fixed local port is unavailable; free it, or remove and recreate the intent with another fixed or dynamic port, then retry";
  }
  if (code === "unsupported-operation") {
    return "restore a compatible provider Access Method, then press t to retry";
  }
  return "resolve the reported cause without deleting the desired intent, then press t to retry realization";
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
        <Text>Press r to retry. Provider CLI commands remain available.</Text>
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
        <Text>Configure a provider first, or use its CLI commands when it exposes no interactive flow.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>j/k select · Enter start</Text>
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
  sourceInput,
  credentialFlow,
  selectedSource,
  canRegister,
}: {
  readonly snapshot: TuiReadSnapshot;
  readonly sourceInput?: string;
  readonly credentialFlow?: ProviderCredentialFlowView;
  readonly selectedSource?: string;
  readonly canRegister: boolean;
}): React.ReactElement {
  if (sourceInput !== undefined) {
    return (
      <Box flexDirection="column">
        <Text bold>Register installed provider</Text>
        <Text>Module or path: {escapeTerminalText(sourceInput)}</Text>
        <Text>Enter register · Esc cancel</Text>
        <Text>Install, update and uninstall stay with your package manager.</Text>
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

      return (
        <Box flexDirection="column">
          <Text bold>Credentials for {providerLabel}</Text>
          <Text>j/k select · Enter set or rotate · x remove configured · Esc back</Text>
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
        <Text>Press r to retry. Instance inventory may still be available.</Text>
      </Box>
    );
  }

  if (snapshot.providers.items.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>No provider plugins configured.</Text>
        {canRegister ? (
          <Text>Press a to register an already-installed provider module or path.</Text>
        ) : (
          <Text>For now, add one with: easyserver plugins add &lt;module&gt;</Text>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {canRegister ? (
        <Box marginBottom={1}>
          <Text>j/k select · c credentials · e enable/disable · a register another installed provider</Text>
        </Box>
      ) : null}
      {snapshot.providers.items.map((provider) => {
        const selected = provider.source === selectedSource;
        return (
        <Box key={`${provider.source}:${provider.pluginId ?? "unloaded"}`} flexDirection="column" marginBottom={1}>
          <Text bold={selected}>
            {selected ? "> " : "  "}{provider.displayName ?? provider.pluginId ?? provider.providerId ?? provider.source}
          </Text>
          <Text>
            {provider.state} · {provider.failure ?? provider.readiness}
          </Text>
          <Text>Source: {provider.source}</Text>
          {provider.providerId === undefined ? null : (
            <Text>Provider ID: {provider.providerId}</Text>
          )}
          {provider.version === undefined ? null : <Text>Version: {provider.version}</Text>}
          {provider.state === "disabled" ? (
            <Text>Credential metadata unavailable while disabled.</Text>
          ) : provider.state === "failed" ? (
            <Text>Credential metadata unavailable while the provider is failed.</Text>
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
          {provider.state === "failed" ? (
            <Text>Remediation: verify the installed module and compatibility, then press r to refresh.</Text>
          ) : null}
          {provider.state === "failed" || provider.credentials.missingRequired > 0 ? (
            <Text>Support: press g to inspect privacy-safe Diagnostics before sharing provider details.</Text>
          ) : null}
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
    return "No compute instances are visible. Provider configuration could not be inspected; resolve provider setup and press r to refresh.";
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
        Bulk actions: {actions.map((action, index) => `${index + 1} ${action.slice("instance.".length)} (${bulkActionSupportCount(instances, action)}/${instances.length} advertise)`).join(" · ")}
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
        <Text>a Adopt for EasyServer management</Text>
      ) : null}
      {instance.management === "discovered" &&
      instance.availableActions.includes("instance.destroy") ? (
        <Text>Destroy is unavailable until this resource is explicitly adopted.</Text>
      ) : null}
      {actions.length === 0 ? (
        <Text>No lifecycle actions are currently available.</Text>
      ) : (
        <Text>
          Actions: {actions.map((action, index) => `${index + 1} ${action.slice("instance.".length)}`).join(" · ")}
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
      <Text>Tab / Shift+Tab — move focus</Text>
      <Text>Arrow keys — move focus</Text>
      <Text>Enter — open focused section</Text>
      <Text>Esc — close help or return to Overview</Text>
      <Text>? — toggle this help</Text>
      <Text>r — refresh current section</Text>
      <Text>g — open privacy-safe Diagnostics from any main surface</Text>
      <Text>c / P / C — on Diagnostics: copy reviewed payload / open Providers / open Connections</Text>
      <Text>j / k — select next / previous instance on Instances</Text>
      <Text>Space — mark or unmark the selected fresh instance for a bulk lifecycle action</Text>
      <Text>0 — clear the exact bulk target set</Text>
      <Text>a — adopt the selected discovered instance when offered</Text>
      <Text>1-4 — run the shown lifecycle action on the selected instance, or on all marked targets</Text>
      <Text>n — start a TUI-owned foreground Endpoint on Connections</Text>
      <Text>p — create a daemon-owned persistent Connection Session</Text>
      <Text>d — start or stop the managed daemon</Text>
      <Text>j / k and x — select or close foreground Endpoints</Text>
      <Text>J / K and c — select or close daemon-owned Connection Sessions</Text>
      <Text>[ / ] — select persisted Endpoint intents (desired state)</Text>
      <Text>e — enable or disable the selected persisted Endpoint intent</Text>
      <Text>t — retry realization for a selected intent in Error state</Text>
      <Text>X — remove the selected persisted intent after destructive confirmation</Text>
      <Text>q / Ctrl+C — quit EasyServer; live foreground Endpoints require a second quit confirmation, persistent Sessions survive</Text>
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
