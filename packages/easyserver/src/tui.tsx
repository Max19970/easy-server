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
    label: "Sessions",
    description: "Connections and Endpoint intents",
    body: "Connection sessions and persistent Endpoint intents will appear here.",
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

export interface TuiShellProps {
  readonly width?: number;
  readonly colorEnabled?: boolean;
  readonly screenReader?: boolean;
  readonly operation?: TuiOperationPresentation;
  readonly onOperationAction?: (action: TuiOperationActionKind) => void;
  readonly readSnapshot?: TuiReadSnapshot;
  readonly readStatus?: TuiReadStatus;
  readonly onRefresh?: (routeId: TuiRouteId) => void;
  readonly onProviderMutation?: (mutation: TuiProviderMutation) => void;
  readonly providerInteractiveScreen?: ProviderInteractiveScreen;
  readonly providerInteractiveDisabled?: boolean;
  readonly onOpenProviderWorkflow?: (workflow: TuiProviderWorkflowReadItem) => void;
  readonly onProviderInteractiveEvent?: (event: ProviderInteractiveEvent) => void;
  readonly onProviderInteractiveClose?: () => void;
  readonly navigateToInstanceId?: string;
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
  onProviderMutation,
  providerInteractiveScreen,
  providerInteractiveDisabled = false,
  onOpenProviderWorkflow,
  onProviderInteractiveEvent,
  onProviderInteractiveClose,
  navigateToInstanceId,
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
      : inventoryItems[0]?.id;

  useEffect(() => {
    setSelectedProviderSource((current) =>
      current !== undefined &&
      providerItems.some((provider) => provider.source === current)
        ? current
        : providerItems[0]?.source,
    );
    setSelectedInstanceId((current) =>
      current !== undefined &&
      inventoryItems.some((instance) => instance.id === current)
        ? current
        : inventoryItems[0]?.id,
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
    if (
      navigateToInstanceId === undefined ||
      !inventoryItems.some((instance) => instance.id === navigateToInstanceId)
    ) {
      return;
    }
    const instancesIndex = routes.findIndex((route) => route.id === "instances");
    setSelectedInstanceId(navigateToInstanceId);
    setActiveIndex(instancesIndex);
    setFocusedIndex(instancesIndex);
    setStatus(`Opened ${navigateToInstanceId}.`);
  }, [navigateToInstanceId, readSnapshot]);

  const navigation = useMemo(
    () =>
      routes.map((route, index) => ({
        ...route,
        active: index === activeIndex,
        focused: index === focusedIndex,
      })),
    [activeIndex, focusedIndex],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
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
          exit();
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

    if (input === "q") {
      exit();
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
      const currentIndex = Math.max(
        0,
        inventoryItems.findIndex(
          (instance) => instance.id === effectiveSelectedInstanceId,
        ),
      );
      const nextIndex =
        input === "j"
          ? (currentIndex + 1) % inventoryItems.length
          : (currentIndex - 1 + inventoryItems.length) % inventoryItems.length;
      const next = inventoryItems[nextIndex];
      if (next !== undefined) {
        setSelectedInstanceId(next.id);
        setStatus(`Selected ${next.id}.`);
      }
      return;
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
                  selectedInstanceId={effectiveSelectedInstanceId}
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
            Commands: Tab or arrows move focus; Enter opens; Escape returns or closes help; question mark opens help; R refreshes; J and K select instances; Q quits.
          </Text>
        ) : (
          <Text color={muted} wrap="wrap">
            Tab/Shift+Tab or arrows move · Enter open · Esc back · ? help · r refresh{activeRoute.id === "instances" ? " · j/k select" : activeRoute.id === "providers" && onProviderMutation !== undefined ? " · j/k select · c credentials · e toggle · a register" : activeRoute.id === "new-instance" ? " · j/k select · Enter start" : ""} · q quit
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
    route.id !== "new-instance"
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
}

function InstancesSurface({
  snapshot,
  narrow,
  selectedInstanceId,
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
    items.find((instance) => instance.id === selectedInstanceId) ?? items[0]!;

  return (
    <Box flexDirection="column">
      {snapshot.instances.complete ? null : (
        <PartialInventoryNotice failedProviders={failedProviderOutcomes} />
      )}
      <Text>j/k select instance · r refresh</Text>
      <Box marginTop={1} flexDirection="column">
        {items.map((instance) => (
          <Text key={instance.id} bold={instance.id === selected.id}>
            {instance.id === selected.id ? "> " : "  "}
            {narrow
              ? `${instance.name ?? instance.id} · ${instance.state ?? "unobserved"}`
              : `${instance.name ?? instance.id} · state=${instance.state ?? "unobserved"} · provider=${instance.providerId} · management=${instance.management} · actions=${formatActions(instance.availableActions)}`}
          </Text>
        ))}
      </Box>
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
        <Text>Available actions: {formatActions(selected.availableActions)}</Text>
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
      <Text>q / Ctrl+C — quit EasyServer</Text>
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
  readonly providerMutationRunner?: TuiProviderMutationRunner;
  readonly providerFlowOpener?: TuiProviderFlowOpener;
}

export function TuiApp({
  colorEnabled = true,
  screenReader = false,
  readLoader,
  providerMutationRunner,
  providerFlowOpener,
}: TuiAppProps): React.ReactElement {
  const [snapshot, setSnapshot] = useState<TuiReadSnapshot | undefined>();
  const [operation, setOperation] = useState<TuiOperationPresentation | undefined>();
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

  const refresh = useCallback(async () => {
    if (readLoader === undefined) {
      return;
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
        return;
      }
      setSnapshot(next);
      setSnapshotStale(false);
      setOperation(undefined);
    } catch (error) {
      if (controllerRef.current !== controller || controller.signal.aborted) {
        return;
      }
      setSnapshotStale(true);
      setOperation(
        presentOperationError({
          title: "Refresh EasyServer status",
          operation: "read",
          error,
        }),
      );
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
        providerFlowOpener === undefined ||
        workflow.presentation.kind !== "interactive-flow"
      ) {
        return;
      }

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
      }
    },
    [providerFlowHandle, providerFlowOpener],
  );

  const dispatchProviderWorkflow = useCallback(
    async (event: ProviderInteractiveEvent) => {
      const handle = providerFlowHandle;
      if (handle === undefined) {
        return;
      }

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
      }
    },
    [providerFlowHandle, refresh],
  );

  const closeProviderWorkflow = useCallback(() => {
    providerFlowHandle?.close();
    setProviderFlowHandle(undefined);
    setProviderFlowScreen(undefined);
    setPendingProviderFlowConfirmation(undefined);
    setOperation(undefined);
  }, [providerFlowHandle]);

  const handleOperationAction = useCallback(
    (action: TuiOperationActionKind) => {
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
      if (action === "retry" || action === "refresh") {
        void refresh();
        return;
      }
      if (action === "dismiss") {
        setPendingProviderMutation(undefined);
        setOperation(undefined);
      }
    },
    [
      mutateProvider,
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
    />
  );
}

export interface TuiRuntimeOptions {
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly readLoader?: TuiReadLoader;
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
    providerMutationRunner: createDefaultTuiProviderMutationRunner(),
    providerFlowOpener: createDefaultTuiProviderFlowOpener(),
  });
  await app.waitUntilExit();
}
