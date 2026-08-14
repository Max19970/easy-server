export const PLUGIN_SDK_VERSION = "0.2.0";

export const PROVIDER_CAPABILITIES = [
  "instance.start",
  "instance.stop",
  "instance.restart",
  "instance.destroy",
] as const;

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export const POWER_ACTIONS = [
  "instance.start",
  "instance.stop",
  "instance.restart",
] as const;

export type PowerAction = (typeof POWER_ACTIONS)[number];

declare const secretReferenceBrand: unique symbol;

export type SecretReference = string & {
  readonly [secretReferenceBrand]: true;
};

export function parseSecretReference(value: unknown): SecretReference {
  if (typeof value !== "string" || !SECRET_REFERENCE_PATTERN.test(value)) {
    throw new PluginContractError(
      "secret reference must have the form secret:<uuid>",
    );
  }

  return value as SecretReference;
}

export function isSecretReference(value: unknown): value is SecretReference {
  return typeof value === "string" && SECRET_REFERENCE_PATTERN.test(value);
}

export interface ProviderIdentity {
  readonly id: string;
  readonly displayName: string;
}

export interface PluginCompatibility {
  readonly easyserver: string;
  readonly pluginSdk: string;
}

export interface PluginCredentialDescriptor {
  /** Stable plugin-owned name passed to context.resolveCredential(name). */
  readonly name: string;
  /** Whether normal plugin operation requires this credential to be configured. */
  readonly required: boolean;
  /** User-facing setup guidance; must never contain secret values. */
  readonly description?: string;
}

export interface PluginManifest {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly compatibility: PluginCompatibility;
  readonly credentials?: readonly PluginCredentialDescriptor[];
  readonly provider: ProviderIdentity & {
    readonly capabilities: readonly ProviderCapability[];
  };
}

export interface OperationContext {
  /** Host-owned cooperative cancellation for this invocation. */
  readonly signal: AbortSignal;
}

export interface ProviderOperationContext extends OperationContext {
  /** Resolve one configured provider credential by stable plugin-owned name. */
  resolveCredential(name: string): Promise<string | undefined>;
  /** Mark the point immediately before a remote mutation may be dispatched. */
  markMutationDispatched(): void;
}

export const INSTANCE_STATES = [
  "provisioning",
  "running",
  "stopped",
  "starting",
  "stopping",
  "terminating",
  "terminated",
  "error",
  "unknown",
] as const;

export type InstanceState = (typeof INSTANCE_STATES)[number];
export type ProviderRawState = string | number | boolean | null;
export type AvailableAction = ProviderCapability;

export interface ProviderInstanceSnapshot {
  readonly providerExternalId: string;
  readonly name?: string;
  readonly state: InstanceState;
  readonly rawState: ProviderRawState;
  readonly availableActions: readonly AvailableAction[];
}

export interface ProviderAdapter {
  readonly providerId: string;
  listInstances(
    context: ProviderOperationContext,
  ): Promise<readonly ProviderInstanceSnapshot[]>;
  /**
   * Return `undefined` only when the provider can authoritatively confirm that
   * the requested resource does not exist. Transient, unavailable, rate-limited,
   * or otherwise inconclusive lookups must reject instead of returning
   * `undefined`, so EasyServer does not discard canonical local identity.
   */
  getInstance(
    providerExternalId: string,
    context: ProviderOperationContext,
  ): Promise<ProviderInstanceSnapshot | undefined>;
  getAccessMethods?(
    providerExternalId: string,
    context: ProviderOperationContext,
  ): Promise<readonly AccessMethod[]>;
  resolveAccessCredential?(
    providerExternalId: string,
    credentialId: string,
    context: ProviderOperationContext,
  ): Promise<string | undefined>;
  performPowerAction?(
    providerExternalId: string,
    action: PowerAction,
    context: ProviderOperationContext,
  ): Promise<void>;
  destroy?(
    providerExternalId: string,
    context: ProviderOperationContext,
  ): Promise<void>;
}

export function parseProviderInstanceSnapshot(
  value: unknown,
  capabilities: readonly ProviderCapability[],
): ProviderInstanceSnapshot {
  const snapshot = expectRecord(value, "provider instance snapshot");
  const parsed: ProviderInstanceSnapshot = {
    providerExternalId: expectNonEmptyString(
      snapshot.providerExternalId,
      "provider instance snapshot.providerExternalId",
    ),
    state: expectInstanceState(
      snapshot.state,
      "provider instance snapshot.state",
    ),
    rawState: expectRawState(
      snapshot.rawState,
      "provider instance snapshot.rawState",
    ),
    availableActions: expectAvailableActions(
      snapshot.availableActions,
      capabilities,
      "provider instance snapshot.availableActions",
    ),
  };

  if (snapshot.name !== undefined) {
    return {
      ...parsed,
      name: expectNonEmptyString(snapshot.name, "provider instance snapshot.name"),
    };
  }

  return parsed;
}

export function parseProviderInstanceList(
  value: unknown,
  capabilities: readonly ProviderCapability[],
): readonly ProviderInstanceSnapshot[] {
  if (!Array.isArray(value)) {
    throw new PluginContractError("provider instance list must be an array");
  }

  const instances: ProviderInstanceSnapshot[] = [];
  const seenExternalIds = new Set<string>();

  for (const candidate of value) {
    const instance = parseProviderInstanceSnapshot(candidate, capabilities);

    if (seenExternalIds.has(instance.providerExternalId)) {
      throw new PluginContractError(
        `provider instance list contains duplicate providerExternalId: ${instance.providerExternalId}`,
      );
    }

    seenExternalIds.add(instance.providerExternalId);
    instances.push(instance);
  }

  return instances;
}

export interface ProviderCliCommandContext extends ProviderOperationContext {
  write(text: string): void;
  writeError(text: string): void;
}

export class ProviderCliUsageError extends Error {
  readonly kind = "easyserver-provider-cli-usage-error" as const;

  constructor(message: string) {
    if (message.trim().length === 0) {
      throw new TypeError("provider CLI usage error message must be non-empty");
    }
    super(message);
    this.name = "ProviderCliUsageError";
  }
}

export function providerCliUsageError(message: string): ProviderCliUsageError {
  return new ProviderCliUsageError(message);
}

export function isProviderCliUsageError(value: unknown): value is ProviderCliUsageError {
  return (
    isRecord(value) &&
    value.kind === "easyserver-provider-cli-usage-error" &&
    typeof value.message === "string" &&
    value.message.trim().length > 0
  );
}

export interface ProviderCliCommandResult {
  readonly refreshProviderInventory?: boolean;
  /**
   * Provider-owned identities of Compute resources affected by this command.
   * EasyServer may use them only to reconcile back to canonical instance:<uuid>
   * identities; this is not a universal provisioning request/result schema.
   */
  readonly affectedProviderExternalIds?: readonly string[];
}

export function parseProviderCliCommandResult(
  value: unknown,
): ProviderCliCommandResult | undefined {
  if (value === undefined) {
    return undefined;
  }

  const result = expectRecord(value, "provider CLI command result");
  const parsed: {
    refreshProviderInventory?: boolean;
    affectedProviderExternalIds?: readonly string[];
  } = {};

  if (result.refreshProviderInventory !== undefined) {
    if (typeof result.refreshProviderInventory !== "boolean") {
      throw new PluginContractError(
        "provider CLI command result.refreshProviderInventory must be a boolean",
      );
    }
    parsed.refreshProviderInventory = result.refreshProviderInventory;
  }

  if (result.affectedProviderExternalIds !== undefined) {
    if (!Array.isArray(result.affectedProviderExternalIds)) {
      throw new PluginContractError(
        "provider CLI command result.affectedProviderExternalIds must be an array",
      );
    }
    const ids = result.affectedProviderExternalIds.map((candidate) =>
      expectNonEmptyString(
        candidate,
        "provider CLI command result.affectedProviderExternalIds[]",
      ),
    );
    if (new Set(ids).size !== ids.length) {
      throw new PluginContractError(
        "provider CLI command result.affectedProviderExternalIds must not contain duplicates",
      );
    }
    parsed.affectedProviderExternalIds = ids;
  }

  return parsed;
}

export type ProviderCliOperation = "read" | "mutation";

export const PROVIDER_MUTATION_RISKS = ["billable", "destructive"] as const;
export type ProviderMutationRisk = (typeof PROVIDER_MUTATION_RISKS)[number];

export interface ProviderCliArgumentHelp {
  /** Stable provider-owned positional argument name, rendered as <name>. */
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly repeatable?: boolean;
}

export interface ProviderCliOptionHelp {
  /** Provider-owned long option such as --gpu or --ssh-key. */
  readonly name: string;
  /** Optional value placeholder, rendered as <valueName>. Omit for boolean flags. */
  readonly valueName?: string;
  readonly description: string;
  readonly required: boolean;
  readonly repeatable?: boolean;
}

export interface ProviderCliCommandHelp {
  readonly arguments?: readonly ProviderCliArgumentHelp[];
  readonly options?: readonly ProviderCliOptionHelp[];
  /** Provider-owned argument examples, without the leading easyserver command path. */
  readonly examples?: readonly string[];
}

export interface ProviderCliCommandMetadata {
  readonly name: string;
  readonly description: string;
  readonly operation: ProviderCliOperation;
  /** Host-owned safety classification for mutations that need explicit consent. */
  readonly risks?: readonly ProviderMutationRisk[];
  readonly help?: ProviderCliCommandHelp;
}

export interface ProviderCliCommand extends ProviderCliCommandMetadata {
  run(
    args: readonly string[],
    context: ProviderCliCommandContext,
  ): Promise<void | ProviderCliCommandResult>;
}

export interface ProviderCliContribution {
  readonly commands: readonly ProviderCliCommand[];
}

/**
 * Declarative provider CLI metadata exported from the dedicated
 * `./easyserver-help` package subpath. This help-only entrypoint must not
 * resolve credentials, contact provider APIs, mutate Local State or dispatch
 * provider work during module evaluation.
 */
export interface ProviderCliHelpContribution {
  readonly pluginId: string;
  readonly providerId: string;
  readonly displayName?: string;
  readonly features: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly commands: readonly ProviderCliCommandMetadata[];
  }[];
}

export interface ProviderCliHelpModule {
  readonly easyserverCliHelp: ProviderCliHelpContribution;
}

/**
 * Presentation-neutral context for provider-owned interactive preparation.
 * Interactive flows may inspect provider state and credentials, but remote
 * mutations stay behind the linked CLI command so host safety semantics remain
 * authoritative.
 */
export interface ProviderInteractiveContext extends OperationContext {
  resolveCredential(name: string): Promise<string | undefined>;
}

export type ProviderInteractiveValidationState = "valid" | "invalid" | "pending";

export interface ProviderInteractiveValidation {
  readonly state: ProviderInteractiveValidationState;
  readonly message?: string;
}

export interface ProviderInteractiveChoice {
  /** Provider-owned stable identity; it is not interpreted by EasyServer. */
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

interface ProviderInteractiveFieldBase {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly required: boolean;
  readonly disabled?: boolean;
  readonly validation?: ProviderInteractiveValidation;
}

export interface ProviderInteractiveTextField extends ProviderInteractiveFieldBase {
  readonly kind: "text";
  readonly repeatable?: boolean;
  readonly value?: string | readonly string[];
}

export interface ProviderInteractiveIntegerField extends ProviderInteractiveFieldBase {
  readonly kind: "integer";
  readonly repeatable?: boolean;
  readonly value?: number | readonly number[];
}

export interface ProviderInteractiveDecimalField extends ProviderInteractiveFieldBase {
  readonly kind: "decimal";
  readonly repeatable?: boolean;
  readonly value?: number | readonly number[];
}

export interface ProviderInteractiveBooleanField extends ProviderInteractiveFieldBase {
  readonly kind: "boolean";
  readonly value?: boolean;
}

export interface ProviderInteractiveSingleChoiceField extends ProviderInteractiveFieldBase {
  readonly kind: "single-choice";
  readonly choices: readonly ProviderInteractiveChoice[];
  readonly loading?: boolean;
  readonly value?: string;
}

export interface ProviderInteractiveMultipleChoiceField extends ProviderInteractiveFieldBase {
  readonly kind: "multiple-choice";
  readonly choices: readonly ProviderInteractiveChoice[];
  readonly loading?: boolean;
  readonly value?: readonly string[];
}

export type ProviderInteractiveField =
  | ProviderInteractiveTextField
  | ProviderInteractiveIntegerField
  | ProviderInteractiveDecimalField
  | ProviderInteractiveBooleanField
  | ProviderInteractiveSingleChoiceField
  | ProviderInteractiveMultipleChoiceField;

export type ProviderInteractiveActionKind =
  | "primary"
  | "secondary"
  | "submit"
  | "back"
  | "refresh";

export interface ProviderInteractiveAction {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderInteractiveActionKind;
  readonly disabled?: boolean;
}

interface ProviderInteractiveScreenBase {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly actions: readonly ProviderInteractiveAction[];
}

export interface ProviderInteractiveFormScreen extends ProviderInteractiveScreenBase {
  readonly kind: "form";
  /**
   * Providers express dependencies by returning a new screen with fields
   * omitted, disabled or revalidated after a field-change event.
   */
  readonly fields: readonly ProviderInteractiveField[];
}

export type ProviderInteractiveTableCell = string | number | boolean | null;

export interface ProviderInteractiveTableColumn {
  readonly id: string;
  readonly label: string;
}

export interface ProviderInteractiveTableRow {
  readonly id: string;
  readonly cells: Readonly<Record<string, ProviderInteractiveTableCell>>;
  readonly disabled?: boolean;
}

export interface ProviderInteractiveTableScreen extends ProviderInteractiveScreenBase {
  readonly kind: "table";
  readonly columns: readonly ProviderInteractiveTableColumn[];
  readonly rows: readonly ProviderInteractiveTableRow[];
  readonly selection: "single" | "multiple";
  readonly selectedRowIds: readonly string[];
  readonly loading?: boolean;
}

export interface ProviderInteractiveReviewItem {
  readonly label: string;
  /** Provider-formatted review text; EasyServer does not infer domain meaning. */
  readonly value: string;
}

export interface ProviderInteractiveReviewScreen extends ProviderInteractiveScreenBase {
  readonly kind: "review";
  readonly items: readonly ProviderInteractiveReviewItem[];
}

export type ProviderInteractiveScreen =
  | ProviderInteractiveFormScreen
  | ProviderInteractiveTableScreen
  | ProviderInteractiveReviewScreen;

export type ProviderInteractiveFieldValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

export type ProviderInteractiveEvent =
  | {
      readonly kind: "field-change";
      readonly fieldId: string;
      readonly value?: ProviderInteractiveFieldValue;
    }
  | {
      readonly kind: "table-selection";
      readonly rowIds: readonly string[];
    }
  | {
      readonly kind: "action";
      readonly actionId: string;
    };

export type ProviderInteractiveTransition =
  | {
      readonly kind: "screen";
      readonly screen: ProviderInteractiveScreen;
    }
  | {
      /**
       * Final provider-owned argument assembly. The host executes these args
       * through commandName's existing ProviderCliCommand and safety/handoff path.
       */
      readonly kind: "submit";
      readonly args: readonly string[];
    };

export interface ProviderInteractiveSession {
  readonly initialScreen: ProviderInteractiveScreen;
  dispatch(
    event: ProviderInteractiveEvent,
    context: ProviderInteractiveContext,
  ): Promise<ProviderInteractiveTransition>;
}

export interface ProviderInteractiveFlow {
  readonly id: string;
  /** Existing CLI command whose metadata, safety and execution stay authoritative. */
  readonly commandName: string;
  open(context: ProviderInteractiveContext): Promise<ProviderInteractiveSession>;
}

export interface ProviderInteractiveContribution {
  readonly flows: readonly ProviderInteractiveFlow[];
}

export interface ProviderFeature {
  readonly id: string;
  readonly displayName: string;
  readonly cli?: ProviderCliContribution;
  readonly interactive?: ProviderInteractiveContribution;
}

export type AccessMethodMode = "tcp-forward" | "interactive";

export type AccessCredentialSource =
  | {
      readonly kind: "secret-ref";
      readonly secretRef: SecretReference;
    }
  | {
      readonly kind: "provider-deferred";
      readonly id: string;
    };

export interface SshAccessDescriptor {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly privateKeySecretRef?: SecretReference;
  readonly passwordCredentialId?: string;
}

export interface AccessMethod {
  readonly id: string;
  readonly kind: string;
  readonly mode: AccessMethodMode;
  readonly credentialSources?: readonly AccessCredentialSource[];
  readonly ssh?: SshAccessDescriptor;
}

export function isSshAccessMethod(
  method: AccessMethod,
): method is AccessMethod & { readonly kind: "ssh"; readonly ssh: SshAccessDescriptor } {
  return method.kind === "ssh" && method.ssh !== undefined;
}

export interface TcpForwardTarget {
  readonly host: string;
  readonly port: number;
}

export interface AccessSetupContext extends OperationContext {
  registerCleanup(cleanup: () => void | Promise<void>): void;
  resolveSecret(ref: SecretReference): Promise<string>;
  resolveCredential(id: string): Promise<string>;
}

export interface AccessAdapter {
  readonly kind: string;
  openTcpForward(
    method: AccessMethod,
    providerExternalId: string,
    target: TcpForwardTarget,
    context: AccessSetupContext,
  ): Promise<AccessTransportSession>;
}

export interface AccessTransportSession {
  openChannel(context: OperationContext): Promise<AccessChannel>;
  close(): Promise<void>;
}

export interface AccessChannel {
  readonly stream: import("node:stream").Duplex;
  close(): Promise<void>;
}

export interface ProviderPlugin {
  readonly manifest: PluginManifest;
  readonly provider: ProviderAdapter;
  readonly features?: readonly ProviderFeature[];
  readonly accessAdapters?: readonly AccessAdapter[];
}

export const NORMALIZED_ERROR_CODES = [
  "authentication",
  "not-found",
  "unsupported-operation",
  "conflict",
  "rate-limited",
  "provider-unavailable",
  "cancelled",
  "timeout",
  "outcome-unknown",
  "plugin-failure",
  "host-trust-required",
  "unknown-provider-error",
] as const;

export type NormalizedErrorCode = (typeof NORMALIZED_ERROR_CODES)[number];

export interface NormalizedError {
  readonly kind: "easyserver-error";
  readonly code: NormalizedErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

export interface HostTrustRequiredError extends NormalizedError {
  readonly code: "host-trust-required";
  readonly host: string;
  readonly port: number;
  readonly keyType: string;
  readonly fingerprint: string;
}

export function hostTrustRequiredError(
  host: string,
  port: number,
  keyType: string,
  fingerprint: string,
): HostTrustRequiredError {
  return {
    kind: "easyserver-error",
    code: "host-trust-required",
    message: `SSH host trust is required for ${host}:${port}`,
    host,
    port,
    keyType,
    fingerprint,
  };
}

export function isHostTrustRequiredError(
  value: unknown,
): value is HostTrustRequiredError {
  return (
    isNormalizedError(value) &&
    value.code === "host-trust-required" &&
    typeof (value as Partial<HostTrustRequiredError>).host === "string" &&
    typeof (value as Partial<HostTrustRequiredError>).port === "number" &&
    typeof (value as Partial<HostTrustRequiredError>).keyType === "string" &&
    typeof (value as Partial<HostTrustRequiredError>).fingerprint === "string"
  );
}

export function normalizedError(
  code: NormalizedErrorCode,
  message: string,
  cause?: unknown,
): NormalizedError {
  if (message.trim().length === 0) {
    throw new TypeError("normalized error message must be non-empty");
  }

  return cause === undefined
    ? { kind: "easyserver-error", code, message }
    : { kind: "easyserver-error", code, message, cause };
}

export function isNormalizedError(value: unknown): value is NormalizedError {
  if (!isRecord(value) || value.kind !== "easyserver-error") {
    return false;
  }

  return (
    typeof value.message === "string" &&
    value.message.trim().length > 0 &&
    typeof value.code === "string" &&
    NORMALIZED_ERROR_CODE_SET.has(value.code)
  );
}

export class PluginContractError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "PluginContractError";
  }
}

export function parsePluginManifest(value: unknown): PluginManifest {
  const manifest = expectRecord(value, "plugin manifest");
  const compatibility = expectRecord(
    manifest.compatibility,
    "plugin manifest.compatibility",
  );
  const provider = expectRecord(manifest.provider, "plugin manifest.provider");

  const credentials = parsePluginCredentialDescriptors(
    manifest.credentials,
    "plugin manifest.credentials",
  );
  const parsed: PluginManifest = {
    id: expectId(manifest.id, "plugin manifest.id"),
    displayName: expectNonEmptyString(
      manifest.displayName,
      "plugin manifest.displayName",
    ),
    version: expectVersion(manifest.version, "plugin manifest.version"),
    compatibility: {
      easyserver: expectNonEmptyString(
        compatibility.easyserver,
        "plugin manifest.compatibility.easyserver",
      ),
      pluginSdk: expectNonEmptyString(
        compatibility.pluginSdk,
        "plugin manifest.compatibility.pluginSdk",
      ),
    },
    ...(credentials === undefined ? {} : { credentials }),
    provider: {
      id: expectId(provider.id, "plugin manifest.provider.id"),
      displayName: expectNonEmptyString(
        provider.displayName,
        "plugin manifest.provider.displayName",
      ),
      capabilities: expectCapabilities(
        provider.capabilities,
        "plugin manifest.provider.capabilities",
      ),
    },
  };

  return parsed;
}

function parsePluginCredentialDescriptors(
  value: unknown,
  path: string,
): readonly PluginCredentialDescriptor[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new PluginContractError(`${path} must be an array`);
  }

  const descriptors: PluginCredentialDescriptor[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const descriptor = expectRecord(candidate, `${path}[${index}]`);
    const name = expectId(descriptor.name, `${path}[${index}].name`);
    if (seen.has(name)) {
      throw new PluginContractError(`${path} contains duplicate name: ${name}`);
    }
    if (typeof descriptor.required !== "boolean") {
      throw new PluginContractError(`${path}[${index}].required must be a boolean`);
    }
    const description =
      descriptor.description === undefined
        ? undefined
        : expectNonEmptyString(
            descriptor.description,
            `${path}[${index}].description`,
          );
    seen.add(name);
    descriptors.push({
      name,
      required: descriptor.required,
      ...(description === undefined ? {} : { description }),
    });
  }
  return descriptors;
}

export function parseProviderPlugin(value: unknown): ProviderPlugin {
  const plugin = expectRecord(value, "provider plugin");
  const manifest = parsePluginManifest(plugin.manifest);
  const provider = expectRecord(plugin.provider, "provider plugin.provider");
  const providerId = expectId(provider.providerId, "provider plugin.provider.providerId");
  expectFunction(
    provider.listInstances,
    "provider plugin.provider.listInstances",
  );
  expectFunction(provider.getInstance, "provider plugin.provider.getInstance");
  if (provider.getAccessMethods !== undefined) {
    expectFunction(
      provider.getAccessMethods,
      "provider plugin.provider.getAccessMethods",
    );
  }
  if (provider.resolveAccessCredential !== undefined) {
    expectFunction(
      provider.resolveAccessCredential,
      "provider plugin.provider.resolveAccessCredential",
    );
  }
  assertLifecycleMethods(provider, manifest.provider.capabilities);

  if (providerId !== manifest.provider.id) {
    throw new PluginContractError(
      "provider plugin.provider.providerId must match plugin manifest.provider.id",
    );
  }

  const features = parseProviderFeatures(plugin.features);
  const accessAdapters = parseAccessAdapters(
    plugin.accessAdapters,
    manifest.provider.id,
  );
  const parsed: ProviderPlugin = {
    manifest,
    provider: provider as unknown as ProviderAdapter,
  };

  return {
    ...parsed,
    ...(features.length === 0 ? {} : { features }),
    ...(accessAdapters.length === 0 ? {} : { accessAdapters }),
  };
}

export function parseProviderCliHelpModule(value: unknown): ProviderCliHelpContribution {
  const module = expectRecord(value, "provider CLI help module");
  const contribution = expectRecord(
    module.easyserverCliHelp,
    "provider CLI help module.easyserverCliHelp",
  );
  const pluginId = expectId(
    contribution.pluginId,
    "provider CLI help module.easyserverCliHelp.pluginId",
  );
  const providerId = expectId(
    contribution.providerId,
    "provider CLI help module.easyserverCliHelp.providerId",
  );
  const displayName =
    contribution.displayName === undefined
      ? undefined
      : expectNonEmptyString(
          contribution.displayName,
          "provider CLI help module.easyserverCliHelp.displayName",
        );
  if (!Array.isArray(contribution.features)) {
    throw new PluginContractError(
      "provider CLI help module.easyserverCliHelp.features must be an array",
    );
  }

  const seenFeatures = new Set<string>();
  const features = contribution.features.map((candidate, index) => {
    const path = `provider CLI help module.easyserverCliHelp.features[${index}]`;
    const feature = expectRecord(candidate, path);
    const id = expectId(feature.id, `${path}.id`);
    if (seenFeatures.has(id)) {
      throw new PluginContractError(
        "provider CLI help module.easyserverCliHelp.features must not contain duplicate IDs",
      );
    }
    seenFeatures.add(id);
    const featureDisplayName = expectNonEmptyString(
      feature.displayName,
      `${path}.displayName`,
    );
    if (!Array.isArray(feature.commands)) {
      throw new PluginContractError(`${path}.commands must be an array`);
    }
    const seenCommands = new Set<string>();
    const commands = feature.commands.map((command, commandIndex) => {
      const commandPath = `${path}.commands[${commandIndex}]`;
      const commandRecord = expectRecord(command, commandPath);
      assertOnlyKeys(
        commandRecord,
        ["name", "description", "operation", "risks", "help"],
        commandPath,
      );
      const parsed = parseProviderCliCommandMetadata(commandRecord, commandPath);
      if (seenCommands.has(parsed.name)) {
        throw new PluginContractError(
          `${path}.commands must not contain duplicate names`,
        );
      }
      seenCommands.add(parsed.name);
      return parsed;
    });
    return { id, displayName: featureDisplayName, commands };
  });

  return {
    pluginId,
    providerId,
    ...(displayName === undefined ? {} : { displayName }),
    features,
  };
}

export function parseAccessMethods(value: unknown): readonly AccessMethod[] {
  if (!Array.isArray(value)) {
    throw new PluginContractError("provider access methods must be an array");
  }

  const methods: AccessMethod[] = [];
  const seen = new Set<string>();

  for (const [index, candidate] of value.entries()) {
    const path = `provider access methods[${index}]`;
    const method = expectRecord(candidate, path);
    assertOnlyKeys(
      method,
      ["id", "kind", "mode", "credentialSources", "ssh"],
      path,
    );
    const id = expectId(method.id, `${path}.id`);
    const kind = expectAccessKind(method.kind, `${path}.kind`);
    const mode = expectAccessMethodMode(method.mode, `${path}.mode`);
    const credentialSources = parseAccessCredentialSources(
      method.credentialSources,
      `${path}.credentialSources`,
    );
    const ssh = parseSshAccessDescriptor(
      method.ssh,
      kind,
      mode,
      credentialSources,
      `${path}.ssh`,
    );

    if (seen.has(id)) {
      throw new PluginContractError(
        `provider access methods contains duplicate id: ${id}`,
      );
    }

    seen.add(id);
    methods.push({
      id,
      kind,
      mode,
      ...(credentialSources === undefined ? {} : { credentialSources }),
      ...(ssh === undefined ? {} : { ssh }),
    });
  }

  return methods;
}

function parseSshAccessDescriptor(
  value: unknown,
  kind: string,
  mode: AccessMethodMode,
  credentialSources: readonly AccessCredentialSource[] | undefined,
  path: string,
): SshAccessDescriptor | undefined {
  if (kind !== "ssh") {
    if (value !== undefined) {
      throw new PluginContractError(`${path} is only valid for kind ssh`);
    }
    return undefined;
  }

  if (mode !== "tcp-forward") {
    throw new PluginContractError("SSH Access Methods must use tcp-forward mode");
  }

  const ssh = expectRecord(value, path);
  assertOnlyKeys(
    ssh,
    ["host", "port", "username", "privateKeySecretRef", "passwordCredentialId"],
    path,
  );
  const passwordCredentialId =
    ssh.passwordCredentialId === undefined
      ? undefined
      : expectId(ssh.passwordCredentialId, `${path}.passwordCredentialId`);
  if (
    passwordCredentialId !== undefined &&
    !credentialSources?.some(
      (source) =>
        source.kind === "provider-deferred" && source.id === passwordCredentialId,
    )
  ) {
    throw new PluginContractError(
      `${path}.passwordCredentialId must reference a declared provider-deferred credential source`,
    );
  }
  const parsed: SshAccessDescriptor = {
    host: expectSshToken(ssh.host, `${path}.host`),
    port: expectTcpPort(ssh.port, `${path}.port`),
    username: expectSshToken(ssh.username, `${path}.username`),
  };

  return {
    ...parsed,
    ...(ssh.privateKeySecretRef === undefined
      ? {}
      : { privateKeySecretRef: parseSecretReference(ssh.privateKeySecretRef) }),
    ...(passwordCredentialId === undefined ? {} : { passwordCredentialId }),
  };
}

function parseAccessCredentialSources(
  value: unknown,
  path: string,
): readonly AccessCredentialSource[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new PluginContractError(`${path} must be an array`);
  }

  return value.map((candidate, index) => {
    const sourcePath = `${path}[${index}]`;
    const source = expectRecord(candidate, sourcePath);

    if (source.kind === "secret-ref") {
      assertOnlyKeys(source, ["kind", "secretRef"], sourcePath);
      return {
        kind: "secret-ref" as const,
        secretRef: parseSecretReference(source.secretRef),
      };
    }

    if (source.kind === "provider-deferred") {
      assertOnlyKeys(source, ["kind", "id"], sourcePath);
      return {
        kind: "provider-deferred" as const,
        id: expectId(source.id, `${sourcePath}.id`),
      };
    }

    throw new PluginContractError(
      `${sourcePath}.kind must be secret-ref or provider-deferred`,
    );
  });
}

function parseAccessAdapters(
  value: unknown,
  providerId: string,
): readonly AccessAdapter[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new PluginContractError("provider plugin.accessAdapters must be an array");
  }

  const adapters: AccessAdapter[] = [];
  const seen = new Set<string>();

  for (const [index, candidate] of value.entries()) {
    const path = `provider plugin.accessAdapters[${index}]`;
    const adapter = expectRecord(candidate, path);
    const kind = expectAccessKind(adapter.kind, `${path}.kind`);
    if (!kind.startsWith(`${providerId}:`)) {
      throw new PluginContractError(
        `${path}.kind must be namespaced to provider ${providerId}`,
      );
    }
    expectFunction(adapter.openTcpForward, `${path}.openTcpForward`);

    if (seen.has(kind)) {
      throw new PluginContractError(
        `provider plugin.accessAdapters contains duplicate kind: ${kind}`,
      );
    }

    seen.add(kind);
    adapters.push(adapter as unknown as AccessAdapter);
  }

  return adapters;
}

function parseProviderFeatures(value: unknown): readonly ProviderFeature[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new PluginContractError("provider plugin.features must be an array");
  }

  const features: ProviderFeature[] = [];
  const seen = new Set<string>();

  for (const [index, candidate] of value.entries()) {
    const feature = expectRecord(candidate, `provider plugin.features[${index}]`);
    const id = expectId(feature.id, `provider plugin.features[${index}].id`);
    expectNonEmptyString(
      feature.displayName,
      `provider plugin.features[${index}].displayName`,
    );

    if (seen.has(id)) {
      throw new PluginContractError(
        `provider plugin.features contains duplicate id: ${id}`,
      );
    }

    if (feature.cli !== undefined) {
      parseProviderCliContribution(
        feature.cli,
        `provider plugin.features[${index}].cli`,
      );
    }
    if (feature.interactive !== undefined) {
      parseProviderInteractiveContribution(
        feature.interactive,
        `provider plugin.features[${index}].interactive`,
        feature.cli,
      );
    }

    seen.add(id);
    features.push(feature as unknown as ProviderFeature);
  }

  return features;
}

function parseProviderInteractiveContribution(
  value: unknown,
  path: string,
  cliValue: unknown,
): void {
  const contribution = expectRecord(value, path);
  if (!Array.isArray(contribution.flows)) {
    throw new PluginContractError(`${path}.flows must be an array`);
  }

  const commandNames = new Set<string>();
  if (cliValue !== undefined) {
    const cli = expectRecord(cliValue, `${path} command source`);
    if (Array.isArray(cli.commands)) {
      for (const [index, commandValue] of cli.commands.entries()) {
        const command = expectRecord(commandValue, `${path} command source.commands[${index}]`);
        commandNames.add(
          expectId(command.name, `${path} command source.commands[${index}].name`),
        );
      }
    }
  }

  const seenIds = new Set<string>();
  const seenCommands = new Set<string>();
  for (const [index, candidate] of contribution.flows.entries()) {
    const flowPath = `${path}.flows[${index}]`;
    const flow = expectRecord(candidate, flowPath);
    const id = expectId(flow.id, `${flowPath}.id`);
    const commandName = expectId(flow.commandName, `${flowPath}.commandName`);
    expectFunction(flow.open, `${flowPath}.open`);

    if (!commandNames.has(commandName)) {
      throw new PluginContractError(
        `${flowPath}.commandName must reference a declared CLI command`,
      );
    }
    if (seenIds.has(id)) {
      throw new PluginContractError(`${path}.flows contains duplicate id: ${id}`);
    }
    if (seenCommands.has(commandName)) {
      throw new PluginContractError(
        `${path}.flows must not define multiple flows for CLI command: ${commandName}`,
      );
    }
    seenIds.add(id);
    seenCommands.add(commandName);
  }
}

export function parseProviderInteractiveSession(
  value: unknown,
): ProviderInteractiveSession {
  const session = expectRecord(value, "provider interactive session");
  parseProviderInteractiveScreen(session.initialScreen);
  expectFunction(session.dispatch, "provider interactive session.dispatch");
  return session as unknown as ProviderInteractiveSession;
}

export function parseProviderInteractiveTransition(
  value: unknown,
): ProviderInteractiveTransition {
  const transition = expectRecord(value, "provider interactive transition");
  if (transition.kind === "screen") {
    return {
      kind: "screen",
      screen: parseProviderInteractiveScreen(transition.screen),
    };
  }
  if (transition.kind === "submit") {
    if (!Array.isArray(transition.args)) {
      throw new PluginContractError(
        "provider interactive transition.args must be an array",
      );
    }
    const args = transition.args.map((arg, index) => {
      if (typeof arg !== "string") {
        throw new PluginContractError(
          `provider interactive transition.args[${index}] must be a string`,
        );
      }
      return arg;
    });
    return { kind: "submit", args };
  }
  throw new PluginContractError(
    "provider interactive transition.kind must be screen or submit",
  );
}

export function parseProviderInteractiveScreen(
  value: unknown,
): ProviderInteractiveScreen {
  const path = "provider interactive screen";
  const screen = expectRecord(value, path);
  expectId(screen.id, `${path}.id`);
  expectNonEmptyString(screen.title, `${path}.title`);
  if (screen.description !== undefined) {
    expectNonEmptyString(screen.description, `${path}.description`);
  }
  parseProviderInteractiveActions(screen.actions, `${path}.actions`);

  if (screen.kind === "form") {
    if (!Array.isArray(screen.fields)) {
      throw new PluginContractError(`${path}.fields must be an array`);
    }
    const seen = new Set<string>();
    for (const [index, fieldValue] of screen.fields.entries()) {
      const fieldPath = `${path}.fields[${index}]`;
      const field = expectRecord(fieldValue, fieldPath);
      const id = expectId(field.id, `${fieldPath}.id`);
      if (seen.has(id)) {
        throw new PluginContractError(`${path} contains duplicate field id: ${id}`);
      }
      seen.add(id);
      parseProviderInteractiveField(field, fieldPath);
    }
    return screen as unknown as ProviderInteractiveFormScreen;
  }

  if (screen.kind === "table") {
    parseProviderInteractiveTable(screen, path);
    return screen as unknown as ProviderInteractiveTableScreen;
  }

  if (screen.kind === "review") {
    if (!Array.isArray(screen.items)) {
      throw new PluginContractError(`${path}.items must be an array`);
    }
    for (const [index, itemValue] of screen.items.entries()) {
      const item = expectRecord(itemValue, `${path}.items[${index}]`);
      expectNonEmptyString(item.label, `${path}.items[${index}].label`);
      expectNonEmptyString(item.value, `${path}.items[${index}].value`);
    }
    return screen as unknown as ProviderInteractiveReviewScreen;
  }

  throw new PluginContractError(
    `${path}.kind must be form, table or review`,
  );
}

function parseProviderInteractiveActions(value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    throw new PluginContractError(`${path} must be an array`);
  }
  const seen = new Set<string>();
  const kinds = new Set<ProviderInteractiveActionKind>([
    "primary",
    "secondary",
    "submit",
    "back",
    "refresh",
  ]);
  for (const [index, actionValue] of value.entries()) {
    const actionPath = `${path}[${index}]`;
    const action = expectRecord(actionValue, actionPath);
    const id = expectId(action.id, `${actionPath}.id`);
    expectNonEmptyString(action.label, `${actionPath}.label`);
    if (!kinds.has(action.kind as ProviderInteractiveActionKind)) {
      throw new PluginContractError(`${actionPath}.kind is not supported`);
    }
    if (action.disabled !== undefined && typeof action.disabled !== "boolean") {
      throw new PluginContractError(`${actionPath}.disabled must be a boolean`);
    }
    if (seen.has(id)) {
      throw new PluginContractError(`${path} contains duplicate id: ${id}`);
    }
    seen.add(id);
  }
}

function parseProviderInteractiveField(
  field: Record<string, unknown>,
  path: string,
): void {
  expectNonEmptyString(field.label, `${path}.label`);
  if (field.description !== undefined) {
    expectNonEmptyString(field.description, `${path}.description`);
  }
  if (typeof field.required !== "boolean") {
    throw new PluginContractError(`${path}.required must be a boolean`);
  }
  if (field.disabled !== undefined && typeof field.disabled !== "boolean") {
    throw new PluginContractError(`${path}.disabled must be a boolean`);
  }
  if (field.validation !== undefined) {
    parseProviderInteractiveValidation(field.validation, `${path}.validation`);
  }

  if (field.kind === "text") {
    parseProviderInteractiveRepeatable(field, path, "string");
    return;
  }
  if (field.kind === "integer") {
    parseProviderInteractiveRepeatable(field, path, "integer");
    return;
  }
  if (field.kind === "decimal") {
    parseProviderInteractiveRepeatable(field, path, "number");
    return;
  }
  if (field.kind === "boolean") {
    if (field.value !== undefined && typeof field.value !== "boolean") {
      throw new PluginContractError(`${path}.value must be a boolean`);
    }
    return;
  }
  if (field.kind === "single-choice" || field.kind === "multiple-choice") {
    parseProviderInteractiveChoices(field.choices, `${path}.choices`);
    if (field.loading !== undefined && typeof field.loading !== "boolean") {
      throw new PluginContractError(`${path}.loading must be a boolean`);
    }
    if (field.kind === "single-choice") {
      if (field.value !== undefined && typeof field.value !== "string") {
        throw new PluginContractError(`${path}.value must be a string`);
      }
    } else if (field.value !== undefined) {
      parseStringArray(field.value, `${path}.value`);
    }
    return;
  }

  throw new PluginContractError(`${path}.kind is not supported`);
}

function parseProviderInteractiveRepeatable(
  field: Record<string, unknown>,
  path: string,
  scalar: "string" | "integer" | "number",
): void {
  if (field.repeatable !== undefined && typeof field.repeatable !== "boolean") {
    throw new PluginContractError(`${path}.repeatable must be a boolean`);
  }
  if (field.value === undefined) {
    return;
  }
  const values = field.repeatable === true ? field.value : [field.value];
  if (field.repeatable === true && !Array.isArray(values)) {
    throw new PluginContractError(`${path}.value must be an array when repeatable`);
  }
  if (field.repeatable !== true && Array.isArray(field.value)) {
    throw new PluginContractError(`${path}.value must not be an array unless repeatable`);
  }
  const list = Array.isArray(values) ? values : [values];
  for (const [index, candidate] of list.entries()) {
    const valuePath = field.repeatable === true ? `${path}.value[${index}]` : `${path}.value`;
    if (scalar === "string" && typeof candidate !== "string") {
      throw new PluginContractError(`${valuePath} must be a string`);
    }
    if (scalar === "integer" && !Number.isInteger(candidate)) {
      throw new PluginContractError(`${valuePath} must be an integer`);
    }
    if (
      scalar === "number" &&
      (typeof candidate !== "number" || !Number.isFinite(candidate))
    ) {
      throw new PluginContractError(`${valuePath} must be a finite number`);
    }
  }
}

function parseProviderInteractiveValidation(value: unknown, path: string): void {
  const validation = expectRecord(value, path);
  if (
    validation.state !== "valid" &&
    validation.state !== "invalid" &&
    validation.state !== "pending"
  ) {
    throw new PluginContractError(`${path}.state is not supported`);
  }
  if (validation.message !== undefined) {
    expectNonEmptyString(validation.message, `${path}.message`);
  }
}

function parseProviderInteractiveChoices(value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    throw new PluginContractError(`${path} must be an array`);
  }
  const seen = new Set<string>();
  for (const [index, choiceValue] of value.entries()) {
    const choicePath = `${path}[${index}]`;
    const choice = expectRecord(choiceValue, choicePath);
    const id = expectNonEmptyString(choice.id, `${choicePath}.id`);
    expectNonEmptyString(choice.label, `${choicePath}.label`);
    if (choice.description !== undefined) {
      expectNonEmptyString(choice.description, `${choicePath}.description`);
    }
    if (choice.disabled !== undefined && typeof choice.disabled !== "boolean") {
      throw new PluginContractError(`${choicePath}.disabled must be a boolean`);
    }
    if (seen.has(id)) {
      throw new PluginContractError(`${path} contains duplicate id: ${id}`);
    }
    seen.add(id);
  }
}

function parseProviderInteractiveTable(
  table: Record<string, unknown>,
  path: string,
): void {
  if (!Array.isArray(table.columns)) {
    throw new PluginContractError(`${path}.columns must be an array`);
  }
  const columnIds = new Set<string>();
  for (const [index, columnValue] of table.columns.entries()) {
    const columnPath = `${path}.columns[${index}]`;
    const column = expectRecord(columnValue, columnPath);
    const id = expectId(column.id, `${columnPath}.id`);
    expectNonEmptyString(column.label, `${columnPath}.label`);
    if (columnIds.has(id)) {
      throw new PluginContractError(`${path}.columns contains duplicate id: ${id}`);
    }
    columnIds.add(id);
  }
  if (!Array.isArray(table.rows)) {
    throw new PluginContractError(`${path}.rows must be an array`);
  }
  const rowIds = new Set<string>();
  for (const [index, rowValue] of table.rows.entries()) {
    const rowPath = `${path}.rows[${index}]`;
    const row = expectRecord(rowValue, rowPath);
    const id = expectNonEmptyString(row.id, `${rowPath}.id`);
    const cells = expectRecord(row.cells, `${rowPath}.cells`);
    for (const [columnId, cell] of Object.entries(cells)) {
      if (!columnIds.has(columnId)) {
        throw new PluginContractError(
          `${rowPath}.cells contains unknown column: ${columnId}`,
        );
      }
      if (
        cell !== null &&
        typeof cell !== "string" &&
        typeof cell !== "number" &&
        typeof cell !== "boolean"
      ) {
        throw new PluginContractError(`${rowPath}.cells.${columnId} is not renderable`);
      }
    }
    if (row.disabled !== undefined && typeof row.disabled !== "boolean") {
      throw new PluginContractError(`${rowPath}.disabled must be a boolean`);
    }
    if (rowIds.has(id)) {
      throw new PluginContractError(`${path}.rows contains duplicate id: ${id}`);
    }
    rowIds.add(id);
  }
  if (table.selection !== "single" && table.selection !== "multiple") {
    throw new PluginContractError(`${path}.selection must be single or multiple`);
  }
  const selected = parseStringArray(table.selectedRowIds, `${path}.selectedRowIds`);
  if (table.selection === "single" && selected.length > 1) {
    throw new PluginContractError(`${path}.selectedRowIds must contain at most one row`);
  }
  for (const id of selected) {
    if (!rowIds.has(id)) {
      throw new PluginContractError(`${path}.selectedRowIds contains unknown row: ${id}`);
    }
  }
  if (table.loading !== undefined && typeof table.loading !== "boolean") {
    throw new PluginContractError(`${path}.loading must be a boolean`);
  }
}

function parseStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new PluginContractError(`${path} must be an array`);
  }
  const parsed = value.map((candidate, index) =>
    expectNonEmptyString(candidate, `${path}[${index}]`),
  );
  if (new Set(parsed).size !== parsed.length) {
    throw new PluginContractError(`${path} must not contain duplicates`);
  }
  return parsed;
}

function parseProviderCliContribution(value: unknown, path: string): void {
  const contribution = expectRecord(value, path);
  if (!Array.isArray(contribution.commands)) {
    throw new PluginContractError(`${path}.commands must be an array`);
  }

  const seen = new Set<string>();
  for (const [index, candidate] of contribution.commands.entries()) {
    const commandPath = `${path}.commands[${index}]`;
    const command = expectRecord(candidate, commandPath);
    const metadata = parseProviderCliCommandMetadata(command, commandPath);
    expectFunction(command.run, `${commandPath}.run`);

    if (seen.has(metadata.name)) {
      throw new PluginContractError(
        `${path}.commands contains duplicate name: ${metadata.name}`,
      );
    }
    seen.add(metadata.name);
  }
}

function parseProviderCliCommandMetadata(
  value: unknown,
  path: string,
): ProviderCliCommandMetadata {
  const command = expectRecord(value, path);
  const name = expectId(command.name, `${path}.name`);
  const description = expectNonEmptyString(command.description, `${path}.description`);
  if (command.operation !== "read" && command.operation !== "mutation") {
    throw new PluginContractError(`${path}.operation must be read or mutation`);
  }
  if (command.risks !== undefined) {
    parseProviderMutationRisks(command.risks, `${path}.risks`, command.operation);
  }
  if (command.help !== undefined) {
    parseProviderCliCommandHelp(command.help, `${path}.help`);
  }
  return {
    name,
    description,
    operation: command.operation,
    ...(command.risks === undefined
      ? {}
      : { risks: command.risks as readonly ProviderMutationRisk[] }),
    ...(command.help === undefined
      ? {}
      : { help: command.help as unknown as ProviderCliCommandHelp }),
  };
}

function parseProviderMutationRisks(
  value: unknown,
  path: string,
  operation: ProviderCliOperation,
): void {
  if (!Array.isArray(value)) {
    throw new PluginContractError(`${path} must be an array`);
  }
  if (value.length > 0 && operation !== "mutation") {
    throw new PluginContractError(`${path} may be declared only for mutation commands`);
  }

  const seen = new Set<string>();
  for (const [index, risk] of value.entries()) {
    if (!PROVIDER_MUTATION_RISK_SET.has(risk as string)) {
      throw new PluginContractError(
        `${path}[${index}] must be billable or destructive`,
      );
    }
    if (seen.has(risk as string)) {
      throw new PluginContractError(`${path} must not contain duplicates`);
    }
    seen.add(risk as string);
  }
}

function parseProviderCliCommandHelp(value: unknown, path: string): void {
  const help = expectRecord(value, path);
  parseProviderCliHelpItems(help.arguments, `${path}.arguments`, "argument");
  parseProviderCliHelpItems(help.options, `${path}.options`, "option");

  if (help.examples !== undefined) {
    if (!Array.isArray(help.examples)) {
      throw new PluginContractError(`${path}.examples must be an array`);
    }
    help.examples.forEach((example, index) =>
      expectNonEmptyString(example, `${path}.examples[${index}]`),
    );
  }
}

function parseProviderCliHelpItems(
  value: unknown,
  path: string,
  kind: "argument" | "option",
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new PluginContractError(`${path} must be an array`);
  }

  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const item = expectRecord(candidate, `${path}[${index}]`);
    const name = expectNonEmptyString(item.name, `${path}[${index}].name`);
    if (kind === "argument") {
      if (!ID_PATTERN.test(name)) {
        throw new PluginContractError(
          `${path}[${index}].name must be a stable lowercase argument identifier`,
        );
      }
    } else if (!CLI_LONG_OPTION_PATTERN.test(name)) {
      throw new PluginContractError(
        `${path}[${index}].name must be a long option such as --example`,
      );
    }
    if (seen.has(name)) {
      throw new PluginContractError(`${path} contains duplicate name: ${name}`);
    }
    seen.add(name);

    expectNonEmptyString(
      item.description,
      `${path}[${index}].description`,
    );
    if (typeof item.required !== "boolean") {
      throw new PluginContractError(`${path}[${index}].required must be a boolean`);
    }
    if (item.repeatable !== undefined && typeof item.repeatable !== "boolean") {
      throw new PluginContractError(`${path}[${index}].repeatable must be a boolean`);
    }

    if (kind === "option" && item.valueName !== undefined) {
      const valueName = expectNonEmptyString(
        item.valueName,
        `${path}[${index}].valueName`,
      );
      if (!CLI_HELP_VALUE_PATTERN.test(valueName)) {
        throw new PluginContractError(
          `${path}[${index}].valueName must be a simple placeholder identifier`,
        );
      }
    }
  }
}

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const CLI_LONG_OPTION_PATTERN = /^--[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CLI_HELP_VALUE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const ACCESS_KIND_PATTERN =
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*(?::[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)?$/;
const SECRET_REFERENCE_PATTERN =
  /^secret:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PROVIDER_CAPABILITY_SET = new Set<string>(PROVIDER_CAPABILITIES);
const POWER_ACTION_SET = new Set<string>(POWER_ACTIONS);
const INSTANCE_STATE_SET = new Set<string>(INSTANCE_STATES);
const NORMALIZED_ERROR_CODE_SET = new Set<string>(NORMALIZED_ERROR_CODES);
const PROVIDER_MUTATION_RISK_SET = new Set<string>(PROVIDER_MUTATION_RISKS);

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new PluginContractError(`${path} must be an object`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PluginContractError(`${path} must be a non-empty string`);
  }

  return value;
}

function expectSshToken(value: unknown, path: string): string {
  const token = expectNonEmptyString(value, path);
  if (/[,\[\]\s\u0000-\u001f\u007f]/u.test(token)) {
    throw new PluginContractError(
      `${path} must not contain whitespace, control characters, commas or brackets`,
    );
  }

  return token;
}

function expectTcpPort(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new PluginContractError(`${path} must be an integer between 1 and 65535`);
  }

  return value as number;
}

function expectAccessKind(value: unknown, path: string): string {
  const kind = expectNonEmptyString(value, path);
  if (!ACCESS_KIND_PATTERN.test(kind)) {
    throw new PluginContractError(`${path} must be a valid access kind`);
  }

  return kind;
}

function expectAccessMethodMode(value: unknown, path: string): AccessMethodMode {
  if (value !== "tcp-forward" && value !== "interactive") {
    throw new PluginContractError(`${path} must be tcp-forward or interactive`);
  }

  return value;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new PluginContractError(`${path}.${key} is not allowed`);
    }
  }
}

function expectId(value: unknown, path: string): string {
  const id = expectNonEmptyString(value, path);

  if (!ID_PATTERN.test(id)) {
    throw new PluginContractError(
      `${path} must start with a lowercase letter and contain only lowercase letters, digits, dots, underscores or hyphens`,
    );
  }

  return id;
}

function expectVersion(value: unknown, path: string): string {
  const version = expectNonEmptyString(value, path);

  if (!VERSION_PATTERN.test(version)) {
    throw new PluginContractError(`${path} must be a semantic version`);
  }

  return version;
}

function assertLifecycleMethods(
  provider: Record<string, unknown>,
  capabilities: readonly ProviderCapability[],
): void {
  if (
    capabilities.some((capability) => POWER_ACTION_SET.has(capability)) &&
    typeof provider.performPowerAction !== "function"
  ) {
    throw new PluginContractError(
      "provider plugin.provider.performPowerAction must be a function when power capabilities are declared",
    );
  }

  if (
    capabilities.includes("instance.destroy") &&
    typeof provider.destroy !== "function"
  ) {
    throw new PluginContractError(
      "provider plugin.provider.destroy must be a function when instance.destroy is declared",
    );
  }
}

function expectFunction(value: unknown, path: string): void {
  if (typeof value !== "function") {
    throw new PluginContractError(`${path} must be a function`);
  }
}

function expectInstanceState(value: unknown, path: string): InstanceState {
  if (typeof value !== "string" || !INSTANCE_STATE_SET.has(value)) {
    throw new PluginContractError(`${path} is not a supported instance state`);
  }

  return value as InstanceState;
}

function expectRawState(value: unknown, path: string): ProviderRawState {
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new PluginContractError(`${path} must be a scalar value or null`);
  }

  return value;
}

function expectAvailableActions(
  value: unknown,
  capabilities: readonly ProviderCapability[],
  path: string,
): readonly AvailableAction[] {
  const actions = expectCapabilities(value, path);
  const capabilitySet = new Set<string>(capabilities);

  for (const action of actions) {
    if (!capabilitySet.has(action)) {
      throw new PluginContractError(
        `${path} contains ${action}, which is not declared by the provider`,
      );
    }
  }

  return actions;
}

function expectCapabilities(
  value: unknown,
  path: string,
): readonly ProviderCapability[] {
  if (!Array.isArray(value)) {
    throw new PluginContractError(`${path} must be an array`);
  }

  const capabilities: ProviderCapability[] = [];
  const seen = new Set<string>();

  for (const [index, capability] of value.entries()) {
    if (
      typeof capability !== "string" ||
      !PROVIDER_CAPABILITY_SET.has(capability)
    ) {
      throw new PluginContractError(
        `${path}[${index}] is not a supported provider capability`,
      );
    }

    if (seen.has(capability)) {
      throw new PluginContractError(`${path} must not contain duplicates`);
    }

    seen.add(capability);
    capabilities.push(capability as ProviderCapability);
  }

  return capabilities;
}
