import {
  normalizedError,
  type AvailableAction,
  type InstanceState,
  type NormalizedErrorCode,
  type OperationContext,
  type ProviderRawState,
} from "@easyai101/easyserver-plugin-sdk";
import type {
  InventoryInstance,
  InventoryResult,
  ProviderInventoryOutcome,
} from "./compute-manager.js";
import {
  LocalDaemonClient,
  readLocalDaemonDescriptor,
  type LocalDaemonDescriptor,
  type PersistentConnectionSession,
} from "./local-daemon.js";
import type { EndpointIntentStatus } from "./endpoint-intent-service.js";
import type { SshHostTrustEvidence } from "./host-trust.js";
import type { PluginStatus } from "./plugin-host.js";
import {
  discoverInstalledProviderPlugins,
  type InstalledProviderPluginCandidate,
} from "./plugin-discovery.js";
import type {
  ProviderFeatureCommandDescriptor,
} from "./provider-feature-operations.js";
import {
  createHostRuntime,
  resolveHostRuntimePaths,
  type HostRuntimePaths,
} from "./host-runtime.js";
import { escapeTerminalText } from "./terminal-text.js";

export type TuiProviderReadiness =
  | "ready"
  | "credentials-missing"
  | "disabled"
  | "failed";

export interface TuiProviderCandidateReadItem {
  readonly source: string;
  readonly displayName: string;
  readonly description?: string;
}

export interface TuiProviderReadItem {
  readonly source: string;
  readonly state: PluginStatus["state"];
  readonly readiness: TuiProviderReadiness;
  readonly pluginId?: string;
  readonly displayName?: string;
  readonly version?: string;
  readonly providerId?: string;
  readonly credentials: {
    readonly configured: number;
    readonly declared: number;
    readonly missingRequired: number;
    readonly items: readonly {
      readonly name: string;
      readonly required: boolean;
      readonly configured: boolean;
      readonly description?: string;
    }[];
  };
  readonly failure?: "incompatible" | "timeout" | "load-failed";
}

export interface TuiInstanceReadItem {
  readonly id: string;
  readonly providerId: string;
  readonly providerExternalId: string;
  readonly management: InventoryInstance["management"];
  readonly name?: string;
  readonly freshness: InventoryInstance["freshness"];
  readonly state?: InstanceState;
  readonly rawState?: ProviderRawState;
  readonly observedAt?: string;
  readonly availableActions: readonly AvailableAction[];
}

export type TuiProviderInventoryOutcome =
  | {
      readonly providerId: string;
      readonly status: "fresh";
    }
  | {
      readonly providerId: string;
      readonly status: "failed";
      readonly error: {
        readonly code: NormalizedErrorCode;
        readonly message: string;
      };
    };

export type TuiReadSection<T> =
  | ({ readonly status: "ready" } & T)
  | {
      readonly status: "failed";
      readonly code: "plugin-failure" | "cancelled";
      readonly message: string;
    };

export interface TuiPersistentSessionReadItem {
  readonly id: string;
  readonly state: PersistentConnectionSession["state"];
  readonly instanceId: string;
  readonly remoteHost: string;
  readonly remotePort: number;
  readonly requestedLocalPort?: number;
  readonly requestedAccessMethodId?: string;
  readonly idempotencyKey?: string;
  readonly accessMethod: {
    readonly id: string;
    readonly kind: string;
    readonly mode: PersistentConnectionSession["accessMethod"]["mode"];
  };
  readonly endpoint?: { readonly host: "127.0.0.1"; readonly port: number };
  readonly failure?: { readonly code: string; readonly message: string };
}

export interface TuiSessionSummary {
  readonly status: "ready";
  readonly total: number;
  readonly live: number;
  readonly closing: number;
  readonly failed: number;
  readonly items: readonly TuiPersistentSessionReadItem[];
}

export interface TuiEndpointIntentReadItem {
  readonly operationName: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly state: EndpointIntentStatus["state"];
  readonly instanceId: string;
  readonly remoteHost: string;
  readonly remotePort: number;
  readonly requestedLocalPort?: number;
  readonly requestedAccessMethodId?: string;
  readonly endpoint?: { readonly host: "127.0.0.1"; readonly port: number };
  readonly accessMethod?: {
    readonly id: string;
    readonly kind: string;
    readonly mode: Extract<EndpointIntentStatus, { readonly state: "live" }>["accessMethod"]["mode"];
  };
  readonly failure?: {
    readonly code: string;
    readonly message: string;
    readonly hostTrust?: SshHostTrustEvidence;
  };
}

export interface TuiEndpointIntentSummary {
  readonly status: "ready";
  readonly total: number;
  readonly live: number;
  readonly starting: number;
  readonly error: number;
  readonly disabled: number;
  readonly items: readonly TuiEndpointIntentReadItem[];
}

export type TuiDaemonReadSnapshot =
  | { readonly status: "stopped" | "stale" | "unreachable" }
  | {
      readonly status: "running";
      readonly sessions: TuiSessionSummary | { readonly status: "unavailable" };
      readonly endpointIntents:
        | TuiEndpointIntentSummary
        | { readonly status: "unavailable" };
    };

export interface TuiProviderWorkflowReadItem {
  readonly providerId: string;
  readonly featureId: string;
  readonly featureDisplayName: string;
  readonly commandName: string;
  readonly description: string;
  readonly operation: ProviderFeatureCommandDescriptor["operation"];
  readonly risks: ProviderFeatureCommandDescriptor["risks"];
  readonly presentation: ProviderFeatureCommandDescriptor["presentation"];
}

export interface TuiProviderWorkflowSourceItem {
  readonly providerId: string;
  readonly featureId: string;
  readonly featureDisplayName: string;
  readonly command: ProviderFeatureCommandDescriptor;
}

export interface TuiReadSnapshot {
  readonly providerCandidates: TuiReadSection<{
    readonly items: readonly TuiProviderCandidateReadItem[];
  }>;
  readonly providerWorkflows: TuiReadSection<{
    readonly items: readonly TuiProviderWorkflowReadItem[];
  }>;
  readonly providers: TuiReadSection<{
    readonly items: readonly TuiProviderReadItem[];
  }>;
  readonly instances: TuiReadSection<{
    readonly items: readonly TuiInstanceReadItem[];
    readonly providerOutcomes: readonly TuiProviderInventoryOutcome[];
    readonly complete: boolean;
  }>;
  readonly daemon: TuiDaemonReadSnapshot;
}

export interface TuiReadSources {
  listProviderCandidates?(): Promise<readonly InstalledProviderPluginCandidate[]>;
  listProviderWorkflows?(): Promise<readonly TuiProviderWorkflowSourceItem[]>;
  listProviders(): Promise<readonly PluginStatus[]>;
  listInventory(context: OperationContext): Promise<InventoryResult>;
  readDaemon(): Promise<TuiDaemonReadSnapshot>;
}

export async function loadDefaultTuiReadSnapshot(
  context: OperationContext,
  paths: HostRuntimePaths = resolveHostRuntimePaths(),
): Promise<TuiReadSnapshot> {
  const runtime = await createHostRuntime({ paths });
  const providerStatuses: PluginStatus[] = [
    ...runtime.pluginHost.listPlugins(),
    ...runtime.state.plugins
      .filter((plugin) => !plugin.enabled)
      .map((plugin) => ({
        source: plugin.source,
        state: "disabled" as const,
      })),
  ];

  return new TuiReadOperations({
    async listProviderCandidates() {
      const configured = new Set(runtime.state.plugins.map((plugin) => plugin.source));
      return (await discoverInstalledProviderPlugins()).filter(
        (candidate) => !configured.has(candidate.source),
      );
    },
    async listProviderWorkflows() {
      return runtime.providerFeatureOperations.listFeatures().flatMap((feature) =>
        runtime.providerFeatureOperations
          .listCommands(feature.providerId, feature.featureId)
          .map((command) => ({
            providerId: feature.providerId,
            featureId: feature.featureId,
            featureDisplayName: feature.displayName,
            command,
          })),
      );
    },
    async listProviders() {
      return providerStatuses;
    },
    async listInventory(operationContext) {
      return runtime.computeManager.listInventory(operationContext);
    },
    async readDaemon() {
      return collectDaemonReadSnapshot(paths.daemonFile);
    },
  }).load(context);
}

export class TuiReadOperations {
  constructor(private readonly sources: TuiReadSources) {}

  async load(context: OperationContext): Promise<TuiReadSnapshot> {
    const [providerCandidates, providerWorkflows, providers, inventory, daemon] = await Promise.allSettled([
      this.sources.listProviderCandidates?.() ?? Promise.resolve([]),
      this.sources.listProviderWorkflows?.() ?? Promise.resolve([]),
      this.sources.listProviders(),
      this.sources.listInventory(context),
      this.sources.readDaemon(),
    ]);

    if (context.signal.aborted) {
      throw normalizedError("cancelled", "TUI read refresh was cancelled");
    }

    return {
      providerCandidates:
        providerCandidates.status === "fulfilled"
          ? {
              status: "ready",
              items: providerCandidates.value.map(projectProviderCandidate),
            }
          : readFailure(
              providerCandidates.reason,
              "Installed provider packages could not be inspected",
            ),
      providerWorkflows:
        providerWorkflows.status === "fulfilled"
          ? {
              status: "ready",
              items: providerWorkflows.value.map(projectProviderWorkflow),
            }
          : readFailure(
              providerWorkflows.reason,
              "Provider workflows could not be inspected",
            ),
      providers:
        providers.status === "fulfilled"
          ? {
              status: "ready",
              items: providers.value.map(projectProvider),
            }
          : readFailure(
              providers.reason,
              "Provider configuration could not be inspected",
            ),
      instances:
        inventory.status === "fulfilled"
          ? projectInventory(inventory.value)
          : readFailure(
              inventory.reason,
              "Instance inventory could not be refreshed",
            ),
      daemon:
        daemon.status === "fulfilled"
          ? daemon.value
          : { status: "unreachable" },
    };
  }
}

interface DaemonReadClient {
  ping(): Promise<void>;
  listSessions(): Promise<readonly PersistentConnectionSession[]>;
  listEndpointIntents(): Promise<readonly EndpointIntentStatus[]>;
}

export interface DaemonReadDependencies {
  readonly readDescriptor?: (
    path: string,
  ) => Promise<LocalDaemonDescriptor | undefined>;
  readonly createClient?: (
    descriptor: LocalDaemonDescriptor,
  ) => DaemonReadClient;
}

export async function collectDaemonReadSnapshot(
  descriptorPath: string,
  dependencies: DaemonReadDependencies = {},
): Promise<TuiDaemonReadSnapshot> {
  const readDescriptor = dependencies.readDescriptor ?? readLocalDaemonDescriptor;
  let descriptor: LocalDaemonDescriptor | undefined;
  try {
    descriptor = await readDescriptor(descriptorPath);
  } catch {
    return { status: "stale" };
  }

  if (descriptor === undefined) {
    return { status: "stopped" };
  }

  const createClient =
    dependencies.createClient ??
    ((value: LocalDaemonDescriptor): DaemonReadClient =>
      new LocalDaemonClient(value.address, value.authToken));
  const client = createClient(descriptor);

  try {
    await client.ping();
  } catch {
    return { status: "unreachable" };
  }

  const [sessions, endpointIntents] = await Promise.allSettled([
    client.listSessions(),
    client.listEndpointIntents(),
  ]);

  return {
    status: "running",
    sessions:
      sessions.status === "fulfilled"
        ? summarizeSessions(sessions.value)
        : { status: "unavailable" },
    endpointIntents:
      endpointIntents.status === "fulfilled"
        ? summarizeEndpointIntents(endpointIntents.value)
        : { status: "unavailable" },
  };
}

function projectProviderWorkflow(
  workflow: TuiProviderWorkflowSourceItem,
): TuiProviderWorkflowReadItem {
  return {
    providerId: escapeTerminalText(workflow.providerId),
    featureId: escapeTerminalText(workflow.featureId),
    featureDisplayName: escapeTerminalText(workflow.featureDisplayName),
    commandName: escapeTerminalText(workflow.command.name),
    description: escapeTerminalText(workflow.command.description),
    operation: workflow.command.operation,
    risks: [...workflow.command.risks],
    presentation:
      workflow.command.presentation.kind === "interactive-flow"
        ? {
            kind: "interactive-flow",
            flowId: escapeTerminalText(workflow.command.presentation.flowId),
          }
        : { kind: "cli-fallback" },
  };
}

function projectProviderCandidate(
  candidate: InstalledProviderPluginCandidate,
): TuiProviderCandidateReadItem {
  return {
    source: escapeTerminalText(candidate.source),
    displayName: escapeTerminalText(candidate.displayName),
    ...(candidate.description === undefined
      ? {}
      : { description: escapeTerminalText(candidate.description) }),
  };
}

function projectProvider(status: PluginStatus): TuiProviderReadItem {
  const credentials = status.credentials ?? [];
  const missingRequired = credentials.filter(
    (credential) => credential.required && !credential.configured,
  ).length;

  return {
    source: escapeTerminalText(status.source),
    state: status.state,
    readiness:
      status.state === "failed"
        ? "failed"
        : status.state === "disabled"
          ? "disabled"
          : missingRequired > 0
            ? "credentials-missing"
            : "ready",
    ...(status.pluginId === undefined
      ? {}
      : { pluginId: escapeTerminalText(status.pluginId) }),
    ...(status.displayName === undefined
      ? {}
      : { displayName: escapeTerminalText(status.displayName) }),
    ...(status.version === undefined
      ? {}
      : { version: escapeTerminalText(status.version) }),
    ...(status.providerId === undefined
      ? {}
      : { providerId: escapeTerminalText(status.providerId) }),
    credentials: {
      configured: credentials.filter((credential) => credential.configured).length,
      declared: credentials.length,
      missingRequired,
      items: credentials.map((credential) => ({
        name: escapeTerminalText(credential.name),
        required: credential.required,
        configured: credential.configured,
        ...(credential.description === undefined
          ? {}
          : { description: escapeTerminalText(credential.description) }),
      })),
    },
    ...(status.state !== "failed"
      ? {}
      : { failure: classifyPluginFailure(status.error) }),
  };
}

function projectInventory(
  inventory: InventoryResult,
): TuiReadSection<{
  readonly items: readonly TuiInstanceReadItem[];
  readonly providerOutcomes: readonly TuiProviderInventoryOutcome[];
  readonly complete: boolean;
}> {
  return {
    status: "ready",
    complete: inventory.complete,
    items: inventory.instances.map(projectInstance),
    providerOutcomes: inventory.providers.map(projectProviderOutcome),
  };
}

function projectInstance(instance: InventoryInstance): TuiInstanceReadItem {
  const base = {
    id: escapeTerminalText(instance.id),
    providerId: escapeTerminalText(instance.providerId),
    providerExternalId: escapeTerminalText(instance.providerExternalId),
    management: instance.management,
    freshness: instance.freshness,
    availableActions: [...instance.availableActions],
    ...("name" in instance && instance.name !== undefined
      ? { name: escapeTerminalText(instance.name) }
      : {}),
    ...("observedAt" in instance
      ? { observedAt: instance.observedAt }
      : {}),
  };

  if (instance.freshness === "unobserved") {
    return base;
  }

  return {
    ...base,
    state: instance.state,
    ...(instance.freshness === "fresh"
      ? { rawState: projectRawState(instance.rawState) }
      : {}),
  };
}

function projectRawState(rawState: ProviderRawState): ProviderRawState {
  return typeof rawState === "string" ? escapeTerminalText(rawState) : rawState;
}

function projectProviderOutcome(
  outcome: ProviderInventoryOutcome,
): TuiProviderInventoryOutcome {
  if (outcome.status === "fresh") {
    return {
      providerId: escapeTerminalText(outcome.providerId),
      status: "fresh",
    };
  }

  return {
    providerId: escapeTerminalText(outcome.providerId),
    status: "failed",
    error: {
      code: outcome.error.code,
      message: escapeTerminalText(outcome.error.message),
    },
  };
}

function summarizeSessions(
  sessions: readonly PersistentConnectionSession[],
): TuiSessionSummary {
  return {
    status: "ready",
    total: sessions.length,
    live: sessions.filter((session) => session.state === "live").length,
    closing: sessions.filter((session) => session.state === "closing").length,
    failed: sessions.filter((session) => session.state === "failed").length,
    items: sessions.map(projectPersistentSession),
  };
}

function projectPersistentSession(
  session: PersistentConnectionSession,
): TuiPersistentSessionReadItem {
  return {
    id: escapeTerminalText(session.id),
    state: session.state,
    instanceId: escapeTerminalText(session.instanceId),
    remoteHost: escapeTerminalText(session.remoteHost),
    remotePort: session.remotePort,
    ...(session.requestedLocalPort === undefined
      ? {}
      : { requestedLocalPort: session.requestedLocalPort }),
    ...(session.requestedAccessMethodId === undefined
      ? {}
      : { requestedAccessMethodId: escapeTerminalText(session.requestedAccessMethodId) }),
    ...(session.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: escapeTerminalText(session.idempotencyKey) }),
    accessMethod: {
      id: escapeTerminalText(session.accessMethod.id),
      kind: escapeTerminalText(session.accessMethod.kind),
      mode: session.accessMethod.mode,
    },
    ...("endpoint" in session && session.endpoint !== undefined
      ? { endpoint: session.endpoint }
      : {}),
    ...(session.state === "failed"
      ? {
          failure: {
            code: escapeTerminalText(session.failure.code),
            message: escapeTerminalText(session.failure.message),
          },
        }
      : {}),
  };
}

function summarizeEndpointIntents(
  intents: readonly EndpointIntentStatus[],
): TuiEndpointIntentSummary {
  return {
    status: "ready",
    total: intents.length,
    live: intents.filter((intent) => intent.state === "live").length,
    starting: intents.filter((intent) => intent.state === "starting").length,
    error: intents.filter((intent) => intent.state === "error").length,
    disabled: intents.filter((intent) => intent.state === "disabled").length,
    items: intents.map(projectEndpointIntent),
  };
}

function projectEndpointIntent(intent: EndpointIntentStatus): TuiEndpointIntentReadItem {
  return {
    operationName: intent.name,
    name: escapeTerminalText(intent.name),
    enabled: intent.enabled,
    state: intent.state,
    instanceId: escapeTerminalText(intent.instanceId),
    remoteHost: escapeTerminalText(intent.remoteHost),
    remotePort: intent.remotePort,
    ...(intent.localPort === undefined
      ? {}
      : { requestedLocalPort: intent.localPort }),
    ...(intent.accessMethodId === undefined
      ? {}
      : { requestedAccessMethodId: escapeTerminalText(intent.accessMethodId) }),
    ...(intent.state === "live"
      ? {
          endpoint: intent.endpoint,
          accessMethod: {
            id: escapeTerminalText(intent.accessMethod.id),
            kind: escapeTerminalText(intent.accessMethod.kind),
            mode: intent.accessMethod.mode,
          },
        }
      : {}),
    ...(intent.state === "error"
      ? {
          failure: {
            code: escapeTerminalText(intent.failure.code),
            message: escapeTerminalText(intent.failure.message),
            ...(intent.failure.hostTrust === undefined
              ? {}
              : {
                  hostTrust: {
                    target: {
                      host: escapeTerminalText(intent.failure.hostTrust.target.host),
                      port: intent.failure.hostTrust.target.port,
                    },
                    key: {
                      type: escapeTerminalText(intent.failure.hostTrust.key.type),
                      fingerprint: escapeTerminalText(
                        intent.failure.hostTrust.key.fingerprint,
                      ),
                    },
                  },
                }),
          },
        }
      : {}),
  };
}

function readFailure(
  error: unknown,
  message: string,
): TuiReadSection<never> {
  return {
    status: "failed",
    code:
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "cancelled"
        ? "cancelled"
        : "plugin-failure",
    message,
  };
}

function classifyPluginFailure(
  error: string | undefined,
): "incompatible" | "timeout" | "load-failed" {
  if (error?.includes("requires EasyServer") || error?.includes("requires plugin SDK")) {
    return "incompatible";
  }
  if (error?.includes("timed out")) {
    return "timeout";
  }
  return "load-failed";
}
