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
  readonly easycompute: string;
  readonly pluginSdk: string;
}

export interface PluginManifest {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly compatibility: PluginCompatibility;
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
  getInstance(
    providerExternalId: string,
    context: ProviderOperationContext,
  ): Promise<ProviderInstanceSnapshot | undefined>;
  getAccessMethods?(
    providerExternalId: string,
    context: ProviderOperationContext,
  ): Promise<readonly AccessMethod[]>;
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

export interface ProviderCliCommandResult {
  readonly refreshProviderInventory?: boolean;
}

export interface ProviderCliCommand {
  readonly name: string;
  readonly description: string;
  run(
    args: readonly string[],
    context: ProviderCliCommandContext,
  ): Promise<void | ProviderCliCommandResult>;
}

export interface ProviderCliContribution {
  readonly commands: readonly ProviderCliCommand[];
}

export interface ProviderFeature {
  readonly id: string;
  readonly displayName: string;
  readonly cli?: ProviderCliContribution;
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
  readonly kind: "easycompute-error";
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
    kind: "easycompute-error",
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
    ? { kind: "easycompute-error", code, message }
    : { kind: "easycompute-error", code, message, cause };
}

export function isNormalizedError(value: unknown): value is NormalizedError {
  if (!isRecord(value) || value.kind !== "easycompute-error") {
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

  const parsed: PluginManifest = {
    id: expectId(manifest.id, "plugin manifest.id"),
    displayName: expectNonEmptyString(
      manifest.displayName,
      "plugin manifest.displayName",
    ),
    version: expectVersion(manifest.version, "plugin manifest.version"),
    compatibility: {
      easycompute: expectNonEmptyString(
        compatibility.easycompute,
        "plugin manifest.compatibility.easycompute",
      ),
      pluginSdk: expectNonEmptyString(
        compatibility.pluginSdk,
        "plugin manifest.compatibility.pluginSdk",
      ),
    },
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
    const ssh = parseSshAccessDescriptor(method.ssh, kind, mode, `${path}.ssh`);

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
  assertOnlyKeys(ssh, ["host", "port", "username", "privateKeySecretRef"], path);
  const parsed: SshAccessDescriptor = {
    host: expectSshToken(ssh.host, `${path}.host`),
    port: expectTcpPort(ssh.port, `${path}.port`),
    username: expectSshToken(ssh.username, `${path}.username`),
  };

  return ssh.privateKeySecretRef === undefined
    ? parsed
    : {
        ...parsed,
        privateKeySecretRef: parseSecretReference(ssh.privateKeySecretRef),
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

    seen.add(id);
    features.push(feature as unknown as ProviderFeature);
  }

  return features;
}

function parseProviderCliContribution(value: unknown, path: string): void {
  const contribution = expectRecord(value, path);
  if (!Array.isArray(contribution.commands)) {
    throw new PluginContractError(`${path}.commands must be an array`);
  }

  const seen = new Set<string>();
  for (const [index, candidate] of contribution.commands.entries()) {
    const command = expectRecord(candidate, `${path}.commands[${index}]`);
    const name = expectId(command.name, `${path}.commands[${index}].name`);
    expectNonEmptyString(
      command.description,
      `${path}.commands[${index}].description`,
    );
    expectFunction(command.run, `${path}.commands[${index}].run`);

    if (seen.has(name)) {
      throw new PluginContractError(
        `${path}.commands contains duplicate name: ${name}`,
      );
    }
    seen.add(name);
  }
}

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
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
