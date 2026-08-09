export const PROVIDER_CAPABILITIES = [
  "instance.start",
  "instance.stop",
  "instance.restart",
  "instance.destroy",
] as const;

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

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

export interface ProviderAdapter {
  readonly providerId: string;
}

export interface ProviderPlugin {
  readonly manifest: PluginManifest;
  readonly provider: ProviderAdapter;
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
  "unknown-provider-error",
] as const;

export type NormalizedErrorCode = (typeof NORMALIZED_ERROR_CODES)[number];

export interface NormalizedError {
  readonly kind: "easycompute-error";
  readonly code: NormalizedErrorCode;
  readonly message: string;
  readonly cause?: unknown;
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

  if (providerId !== manifest.provider.id) {
    throw new PluginContractError(
      "provider plugin.provider.providerId must match plugin manifest.provider.id",
    );
  }

  return {
    manifest,
    provider: provider as unknown as ProviderAdapter,
  };
}

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SECRET_REFERENCE_PATTERN =
  /^secret:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PROVIDER_CAPABILITY_SET = new Set<string>(PROVIDER_CAPABILITIES);
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
