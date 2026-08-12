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
  presentCompletedOperation,
  presentHostTrustRequest,
  presentMutationConfirmation,
  presentOperationError,
  presentProviderExecution,
  presentWorkingOperation,
  type TuiOperationActionKind,
  type TuiOperationPresentation,
} from "./tui-operation-model.js";
import {
  loadDefaultTuiReadSnapshot,
  type TuiInstanceReadItem,
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
  createDefaultTuiInstanceMutationRunner,
  type TuiInstanceMutation,
  type TuiInstanceMutationRunner,
} from "./tui-instance-operations.js";
import type { InstanceDestroyConfirmationDetails } from "./instance-operations.js";
import type { AccessMethodDescriptor } from "./connection-gateway.js";
import {
  createDefaultTuiForegroundConnectionOperations,
  type TuiForegroundConnection,
  type TuiForegroundConnectionOperations,
  type TuiForegroundConnectionRequest,
} from "./tui-foreground-connections.js";
import {
  normalizedError,
  type OperationContext,
  type ProviderInteractiveEvent,
  type ProviderInteractiveScreen,
} from "@easyai101/easyserver-plugin-sdk";
import { escapeTerminalText } from "./terminal-text.js";
import { EASYSERVER_VERSION } from "./version.js";

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
}

interface PendingHostTrustConfirmation {
  readonly resolve: (accepted: boolean) => void;
}

type ForegroundConnectionStep =
  | "instance"
  | "remote-host"
  | "remote-port"
  | "access-method"
  | "local-port"
  | "review";

interface ForegroundConnectionFlow {
  readonly step: ForegroundConnectionStep;
  readonly instanceId: string;
  readonly remoteHost: string;
  readonly remotePort: string;
  readonly accessMethods: readonly AccessMethodDescriptor[];
  readonly accessMethodId?: string;
  readonly localPort: string;
}

export interface TuiShellProps {
  readonly width?: number;
  readonly colorEnabled?: boolean;
  readonly screenReader?: boolean;
  readonly operation?: TuiOperationPresentation;
  readonly onOperationAction?: (action: TuiOperationActionKind) => void;
  readonly readSnapshot?: TuiReadSnapshot;
  readonly readStatus?: TuiReadStatus;
  readonly onRefresh?: (routeId: TuiRouteId) => void;
  readonly onInstanceMutation?: (mutation: TuiInstanceMutation) => void;
  readonly foregroundConnections?: readonly TuiForegroundConnection[];
  readonly onListForegroundAccessMethods?: (
    instanceId: string,
  ) => Promise<readonly AccessMethodDescriptor[] | undefined>;
  readonly onOpenForegroundConnection?: (
    request: TuiForegroundConnectionRequest,
  ) => Promise<TuiForegroundConnection | undefined>;
  readonly onCloseForegroundConnection?: (id: string) => Promise<boolean>;
  readonly onQuitWithForegroundConnections?: () => Promise<boolean>;
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
  onRefresh,
  onInstanceMutation,
  foregroundConnections = [],
  onListForegroundAccessMethods,
  onOpenForegroundConnection,
  onCloseForegroundConnection,
  onQuitWithForegroundConnections,
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
  const [selectedWorkflowKey, setSelectedWorkflowKey] = useState<string | undefined>(
    () => firstWorkflowKey(readSnapshot),
  );
  const [foregroundConnectionFlow, setForegroundConnectionFlow] =
    useState<ForegroundConnectionFlow | undefined>();
  const [selectedForegroundConnectionId, setSelectedForegroundConnectionId] =
    useState<string | undefined>(() => foregroundConnections[0]?.id);
  const [foregroundConnectionBusy, setForegroundConnectionBusy] = useState(false);
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
  const effectiveSelectedForegroundConnectionId =
    selectedForegroundConnectionId !== undefined &&
    foregroundConnections.some(
      (connection) => connection.id === selectedForegroundConnectionId,
    )
      ? selectedForegroundConnectionId
      : undefined;

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

    if (foregroundConnectionFlow !== undefined) {
      if (foregroundConnectionBusy) {
        return;
      }
      if (key.escape) {
        const previousStep = previousForegroundConnectionStep(
          foregroundConnectionFlow.step,
        );
        if (previousStep === undefined) {
          setForegroundConnectionFlow(undefined);
          setStatus("Foreground connection setup cancelled.");
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
          setStatus("Review the foreground Endpoint and press Enter to open it.");
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
        if (request === undefined || onOpenForegroundConnection === undefined) {
          setStatus("The foreground Endpoint request is incomplete.");
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
      setActiveIndex(focusedIndex);
      setStatus(`Opened ${routes[focusedIndex]?.label ?? "Overview"}.`);
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
                  narrow={narrow}
                  selectedInstanceId={selectedInstanceId}
                  canMutateInstances={onInstanceMutation !== undefined}
                  foregroundConnectionFlow={foregroundConnectionFlow}
                  foregroundConnectionBusy={foregroundConnectionBusy}
                  foregroundConnections={foregroundConnections}
                  selectedForegroundConnectionId={selectedForegroundConnectionId}
                  canManageForegroundConnections={
                    onOpenForegroundConnection !== undefined &&
                    onCloseForegroundConnection !== undefined
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
            Commands: Tab or arrows move focus; Enter opens; Escape returns or closes help; question mark opens help; R refreshes; J and K select items; on Instances, A adopts discovered resources and number keys run shown lifecycle actions; on Connections, N starts a foreground Endpoint and X closes the selected one; Q quits.
          </Text>
        ) : (
          <Text color={muted} wrap="wrap">
            Tab/Shift+Tab or arrows move · Enter open · Esc back · ? help · r refresh{activeRoute.id === "instances" ? onInstanceMutation === undefined ? " · j/k select" : " · j/k select · a adopt · 1-4 actions" : activeRoute.id === "sessions" ? " · n new Endpoint · j/k select · x close" : activeRoute.id === "providers" && onProviderMutation !== undefined ? " · j/k select · c credentials · e toggle · a register" : activeRoute.id === "new-instance" ? " · j/k select · Enter start" : ""} · q quit
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
  readonly narrow: boolean;
  readonly selectedInstanceId?: string;
  readonly canMutateInstances: boolean;
  readonly foregroundConnectionFlow?: ForegroundConnectionFlow;
  readonly foregroundConnectionBusy: boolean;
  readonly foregroundConnections: readonly TuiForegroundConnection[];
  readonly selectedForegroundConnectionId?: string;
  readonly canManageForegroundConnections: boolean;
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
  narrow,
  selectedInstanceId,
  canMutateInstances,
  foregroundConnectionFlow,
  foregroundConnectionBusy,
  foregroundConnections,
  selectedForegroundConnectionId,
  canManageForegroundConnections,
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
    route.id !== "sessions"
  ) {
    return <Text wrap="wrap">{route.body}</Text>;
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
        canMutate={canMutateInstances}
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
        canManage={canManageForegroundConnections}
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
    </Box>
  );
}

interface InstancesSurfaceProps {
  readonly snapshot: TuiReadSnapshot;
  readonly narrow: boolean;
  readonly selectedInstanceId?: string;
  readonly canMutate: boolean;
}

function InstancesSurface({
  snapshot,
  narrow,
  selectedInstanceId,
  canMutate,
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

  return (
    <Box flexDirection="column">
      {snapshot.instances.complete ? null : (
        <PartialInventoryNotice failedProviders={failedProviderOutcomes} />
      )}
      <Text>
        j/k select instance{canMutate ? " · a adopt · 1-4 lifecycle actions" : ""} · r refresh
      </Text>
      <Box marginTop={1} flexDirection="column">
        {items.map((instance) => (
          <Text key={instance.id} bold={instance.id === selected?.id}>
            {instance.id === selected?.id ? "> " : "  "}
            {narrow
              ? `${instance.name ?? instance.id} · ${instance.state ?? "unobserved"}`
              : `${instance.name ?? instance.id} · state=${instance.state ?? "unobserved"} · provider=${instance.providerId} · management=${instance.management} · actions=${formatActions(availableInstanceActions(instance))}`}
          </Text>
        ))}
      </Box>
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
          <Text>Management: {selected.management}</Text>
          <Text>Available actions: {formatActions(availableInstanceActions(selected))}</Text>
          {canMutate ? <InstanceActionGuidance instance={selected} /> : null}
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
  canManage,
}: {
  readonly snapshot: TuiReadSnapshot;
  readonly flow?: ForegroundConnectionFlow;
  readonly busy: boolean;
  readonly connections: readonly TuiForegroundConnection[];
  readonly selectedConnectionId?: string;
  readonly canManage: boolean;
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
        <Text bold>New TUI-owned foreground Endpoint</Text>
        <Text>
          This Endpoint exists only while this TUI process is running. Esc returns to the previous step.
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
              <Text bold>Review foreground Endpoint</Text>
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
              <Text>Lifetime: closes when this TUI exits.</Text>
              <Text>Enter open · Esc back</Text>
            </>
          )}
        </Box>
      </Box>
    );
  }

  const selected = connections.find(
    (connection) => connection.id === selectedConnectionId,
  );
  return (
    <Box flexDirection="column">
      <Text>
        TUI-owned foreground Endpoints stay loopback-only and close when this TUI exits.
      </Text>
      <Text>
        {canManage ? "n new Endpoint · j/k select · x close" : "Foreground connection management is unavailable in this TUI session."}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>TUI-owned foreground Endpoints</Text>
        {connections.length === 0 ? (
          <Text>
            None open. {snapshot.instances.status === "ready" && snapshot.instances.items.length === 0 ? "Create or discover an instance first." : "Press n to create one."}
          </Text>
        ) : (
          connections.map((connection) => (
            <Text key={connection.id} bold={connection.id === selected?.id}>
              {connection.id === selected?.id ? "> " : "  "}
              {connection.endpoint.host}:{connection.endpoint.port} · {connection.state} · {connection.instanceId} → {escapeTerminalText(connection.remoteHost)}:{connection.remotePort} · {escapeTerminalText(connection.accessMethod.id)}
            </Text>
          ))
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Persistent connection service</Text>
        <Text>Daemon: {snapshot.daemon.status}</Text>
        <Text>Persistent session workflows are handled separately from these TUI-owned Endpoints.</Text>
      </Box>
    </Box>
  );
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
      <Text bold>Inventory is partial.</Text>
      <Text>Available provider results remain usable.</Text>
      {failedProviders.map((provider) =>
        provider.status === "failed" ? (
          <Text key={provider.providerId}>
            {provider.providerId} · {provider.error.code} · {provider.error.message}
          </Text>
        ) : null,
      )}
      <Text>Review the provider issue and press r to refresh.</Text>
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
    return "No compute instances are currently visible because provider inventory is incomplete. Review the provider issue above and press r to refresh.";
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
      <Text>j / k — select next / previous instance on Instances</Text>
      <Text>a — adopt the selected discovered instance when offered</Text>
      <Text>1-4 — run the shown lifecycle action on the selected instance</Text>
      <Text>n — start a TUI-owned foreground Endpoint on Connections</Text>
      <Text>x — close the selected TUI-owned foreground Endpoint</Text>
      <Text>q / Ctrl+C — quit EasyServer; live foreground Endpoints require a second quit confirmation</Text>
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
  readonly foregroundConnectionOperations?: TuiForegroundConnectionOperations;
  readonly providerMutationRunner?: TuiProviderMutationRunner;
  readonly providerFlowOpener?: TuiProviderFlowOpener;
}

export function TuiApp({
  colorEnabled = true,
  screenReader = false,
  readLoader,
  instanceMutationRunner,
  foregroundConnectionOperations,
  providerMutationRunner,
  providerFlowOpener,
}: TuiAppProps): React.ReactElement {
  const [snapshot, setSnapshot] = useState<TuiReadSnapshot | undefined>();
  const [operation, setOperation] = useState<TuiOperationPresentation | undefined>();
  const [foregroundConnections, setForegroundConnections] = useState<
    readonly TuiForegroundConnection[]
  >(() => foregroundConnectionOperations?.list() ?? []);
  const [pendingHostTrustConfirmation, setPendingHostTrustConfirmation] =
    useState<PendingHostTrustConfirmation | undefined>();
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
  const providerFlowBusyRef = useRef(false);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (readLoader === undefined) {
      return false;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setOperation(
      presentWorkingOperation({
        title: "Refresh EasyServer status",
        detail: "Reading provider, instance and daemon state.",
        activity: "loading",
        cancellable: true,
      }),
    );

    try {
      const next = await readLoader({ signal: controller.signal });
      if (controllerRef.current !== controller || controller.signal.aborted) {
        return false;
      }
      setSnapshot(next);
      setSnapshotStale(false);
      setOperation(undefined);
      return true;
    } catch (error) {
      if (controllerRef.current !== controller || controller.signal.aborted) {
        return false;
      }
      setSnapshotStale(true);
      setOperation(
        presentOperationError({
          title: "Refresh EasyServer status",
          operation: "read",
          error,
        }),
      );
      return false;
    }
  }, [readLoader]);

  useEffect(() => {
    if (readLoader !== undefined) {
      void refresh();
    }
    return () => {
      controllerRef.current?.abort();
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
                title: "Open foreground Endpoint",
                detail: "Enrolling the reviewed SSH fingerprint and retrying connection setup once.",
                activity: "waiting-provider",
              })
            : undefined,
        );
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
                detail: "Dispatching the confirmed instance operation.",
                activity: "dispatching",
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
        const controller = controllerRef.current;
        controllerRef.current = undefined;
        controller?.abort();
        setOperation(undefined);
        return;
      }
      if (action === "retry" || action === "observe" || action === "refresh") {
        void refresh();
        return;
      }
      if (action === "dismiss") {
        setPendingHostTrustConfirmation(undefined);
        setPendingInstanceConfirmation(undefined);
        setPendingProviderMutation(undefined);
        setOperation(undefined);
      }
    },
    [
      mutateProvider,
      pendingHostTrustConfirmation,
      pendingInstanceConfirmation,
      pendingProviderFlowConfirmation,
      pendingProviderMutation,
      refresh,
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
      operation={operation}
      onOperationAction={handleOperationAction}
      onRefresh={() => {
        void refresh();
      }}
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
      onInstanceMutation={
        instanceMutationRunner !== undefined && operation?.phase !== "working"
          ? (mutation) => {
              void mutateInstance(mutation);
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
  readonly foregroundConnectionOperations?: TuiForegroundConnectionOperations;
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
      foregroundConnectionOperations={options.foregroundConnectionOperations}
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
    foregroundConnectionOperations: createDefaultTuiForegroundConnectionOperations(),
    providerMutationRunner: createDefaultTuiProviderMutationRunner(),
    providerFlowOpener: createDefaultTuiProviderFlowOpener(),
  });
  await app.waitUntilExit();
}
