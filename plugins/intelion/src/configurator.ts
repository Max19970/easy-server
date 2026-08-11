import {
  isNormalizedError,
  normalizedError,
  type ProviderCliCommandContext,
  type ProviderCliCommandHelp,
  type ProviderCliCommandResult,
  type ProviderCliContribution,
  type ProviderFeature,
  type ProviderOperationContext,
} from "@easyai101/easyserver-plugin-sdk";
import { IntelionApiClient } from "./api-client.js";

export interface IntelionServerConfigurationInput {
  readonly name: string;
  readonly flavorId: number;
  readonly networkDiskGb: number;
  readonly osImageId: number;
  readonly pricePlan?: number;
  readonly promotionCodeId?: number;
  readonly queueWhenUnavailable?: boolean;
  readonly addonIds?: readonly number[];
  readonly sshKeyIds?: readonly number[];
}

export interface IntelionServerConfiguration {
  readonly name: string;
  readonly flavorId: number;
  readonly networkDiskGb: number;
  readonly osImageId: number;
  readonly pricePlan: number;
  readonly promotionCodeId?: number;
  readonly queueWhenUnavailable: boolean;
  readonly addonIds: readonly number[];
  readonly sshKeyIds: readonly number[];
}

export interface IntelionServerCreationResult {
  readonly providerExternalId: string;
}

export interface IntelionOsImageQuery {
  readonly flavorId?: number;
}

export interface IntelionOsImage {
  readonly id: number;
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly sshEnabled: boolean;
  readonly rdpEnabled: boolean;
  readonly compatibleFlavorIds?: readonly number[];
}

export interface IntelionFlavor {
  readonly id: number;
  readonly name: string;
  readonly cpuCount: number;
  readonly ramCount: number;
  readonly gpuCount?: number;
  readonly monthlyPriceRubCents: number;
  readonly hourlyPriceRubCents: number;
  readonly maxAvailable: number;
  readonly available: boolean;
}

export interface IntelionSshKey {
  readonly id: number;
  readonly name: string;
  readonly keyType: string;
  readonly fingerprintSha256: string;
}

export interface IntelionServerConfiguratorFeature extends ProviderFeature {
  readonly id: "server-configurator";
  listOsImages(
    query: IntelionOsImageQuery,
    context: ProviderOperationContext,
  ): Promise<readonly IntelionOsImage[]>;
  listFlavors(
    context: ProviderOperationContext,
  ): Promise<readonly IntelionFlavor[]>;
  listSshKeys(
    context: ProviderOperationContext,
  ): Promise<readonly IntelionSshKey[]>;
  validateConfiguration(
    input: IntelionServerConfigurationInput,
  ): IntelionServerConfiguration;
  createServer(
    input: IntelionServerConfigurationInput,
    context: ProviderOperationContext,
  ): Promise<IntelionServerCreationResult>;
}

export function createIntelionServerConfiguratorFeature(
  client: IntelionApiClient,
): IntelionServerConfiguratorFeature {
  return new ServerConfiguratorFeature(client);
}

const SERVER_CONFIGURATION_HELP: ProviderCliCommandHelp = {
  options: [
    {
      name: "--name",
      valueName: "name",
      description: "Server name",
      required: true,
    },
    {
      name: "--flavor",
      valueName: "id",
      description: "Intelion flavor ID",
      required: true,
    },
    {
      name: "--disk",
      valueName: "gb",
      description: "Network disk size in GB (minimum 30)",
      required: true,
    },
    {
      name: "--os",
      valueName: "id",
      description: "Intelion OS image ID",
      required: true,
    },
    {
      name: "--price-plan",
      valueName: "id",
      description: "Price plan ID (defaults to 0)",
      required: false,
    },
    {
      name: "--promocode",
      valueName: "id",
      description: "Promotion code ID",
      required: false,
    },
    {
      name: "--queue",
      description: "Queue creation when capacity is unavailable",
      required: false,
    },
    {
      name: "--addon",
      valueName: "id",
      description: "Addon ID; may be supplied more than once",
      required: false,
      repeatable: true,
    },
    {
      name: "--ssh-key",
      valueName: "id",
      description: "Registered SSH key ID; may be supplied more than once",
      required: false,
      repeatable: true,
    },
  ],
  examples: [
    "--name gpu-box --flavor 12 --disk 40 --os 27 --ssh-key 8",
  ],
};

class ServerConfiguratorFeature implements IntelionServerConfiguratorFeature {
  readonly id = "server-configurator" as const;
  readonly displayName = "Server Configurator";
  readonly cli: ProviderCliContribution = {
    commands: [
      {
        name: "os-images",
        description: "List Intelion operating-system images",
        operation: "read",
        help: {
          options: [
            {
              name: "--flavor",
              valueName: "id",
              description: "Filter images compatible with one flavor ID",
              required: false,
            },
          ],
          examples: ["--flavor 12"],
        },
        run: (args, context) => this.#runOsImages(args, context),
      },
      {
        name: "flavors",
        description: "List Intelion server flavors",
        operation: "read",
        help: {},
        run: (args, context) => this.#runFlavors(args, context),
      },
      {
        name: "ssh-keys",
        description: "List registered Intelion SSH keys",
        operation: "read",
        help: {},
        run: (args, context) => this.#runSshKeys(args, context),
      },
      {
        name: "validate",
        description: "Validate an Intelion cloud-server configuration",
        operation: "read",
        help: SERVER_CONFIGURATION_HELP,
        run: (args, context) => this.#runValidate(args, context),
      },
      {
        name: "create",
        description: "Create an Intelion cloud-server configuration",
        operation: "mutation",
        risks: ["billable"],
        help: SERVER_CONFIGURATION_HELP,
        run: (args, context) => this.#runCreate(args, context),
      },
    ],
  };

  constructor(private readonly client: IntelionApiClient) {}

  async listOsImages(
    query: IntelionOsImageQuery,
    context: ProviderOperationContext,
  ): Promise<readonly IntelionOsImage[]> {
    const flavorId =
      query.flavorId === undefined
        ? undefined
        : positiveInteger(query.flavorId, "flavorId");
    const images: IntelionOsImage[] = [];
    const seenPages = new Set<string>();
    let page = this.client.url("/api/v2/os-images/");
    if (flavorId !== undefined) {
      page.searchParams.set("flavor_id", String(flavorId));
    }

    for (;;) {
      const pageKey = page.href;
      if (seenPages.has(pageKey)) {
        throw normalizedError(
          "plugin-failure",
          "Intelion returned a repeated OS-image pagination URL",
        );
      }
      seenPages.add(pageKey);

      const parsed = parseCatalogPage(
        await this.client.getJson(page, context),
        "OS-image",
      );
      images.push(...parsed.results.map(parseOsImage));
      if (parsed.next === undefined) {
        return images;
      }
      page = this.client.url(parsed.next);
    }
  }

  async listFlavors(
    context: ProviderOperationContext,
  ): Promise<readonly IntelionFlavor[]> {
    const flavors: IntelionFlavor[] = [];
    const seenPages = new Set<string>();
    let page = this.client.url("/api/v2/flavors/");

    for (;;) {
      const pageKey = page.href;
      if (seenPages.has(pageKey)) {
        throw normalizedError(
          "plugin-failure",
          "Intelion returned a repeated flavor pagination URL",
        );
      }
      seenPages.add(pageKey);

      const parsed = parseCatalogPage(
        await this.client.getJson(page, context),
        "flavor",
      );
      flavors.push(...parsed.results.map(parseFlavor));
      if (parsed.next === undefined) {
        return flavors;
      }
      page = this.client.url(parsed.next);
    }
  }

  async listSshKeys(
    context: ProviderOperationContext,
  ): Promise<readonly IntelionSshKey[]> {
    const keys: IntelionSshKey[] = [];
    const seenPages = new Set<string>();
    let page = this.client.url("/api/v2/ssh-keys/");

    for (;;) {
      const pageKey = page.href;
      if (seenPages.has(pageKey)) {
        throw normalizedError(
          "plugin-failure",
          "Intelion returned a repeated SSH-key pagination URL",
        );
      }
      seenPages.add(pageKey);

      const parsed = parseCatalogPage(
        await this.client.getJson(page, context),
        "SSH-key",
      );
      keys.push(...parsed.results.map(parseSshKey));
      if (parsed.next === undefined) {
        return keys;
      }
      page = this.client.url(parsed.next);
    }
  }

  validateConfiguration(
    input: IntelionServerConfigurationInput,
  ): IntelionServerConfiguration {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new TypeError("Intelion server name must be non-empty");
    }

    const flavorId = positiveInteger(input.flavorId, "flavorId");
    const networkDiskGb = integerAtLeast(
      input.networkDiskGb,
      30,
      "networkDiskGb",
    );
    const osImageId = positiveInteger(input.osImageId, "osImageId");
    const pricePlan = nonNegativeInteger(input.pricePlan ?? 0, "pricePlan");
    const promotionCodeId =
      input.promotionCodeId === undefined
        ? undefined
        : positiveInteger(input.promotionCodeId, "promotionCodeId");

    if (
      input.queueWhenUnavailable !== undefined &&
      typeof input.queueWhenUnavailable !== "boolean"
    ) {
      throw new TypeError("Intelion queueWhenUnavailable must be a boolean");
    }

    const addonIds = (input.addonIds ?? []).map((id) =>
      positiveInteger(id, "addonIds entry"),
    );
    const sshKeyIds = (input.sshKeyIds ?? []).map((id) =>
      positiveInteger(id, "sshKeyIds entry"),
    );
    if (new Set(addonIds).size !== addonIds.length) {
      throw new TypeError("Intelion addonIds must not contain duplicates");
    }
    if (new Set(sshKeyIds).size !== sshKeyIds.length) {
      throw new TypeError("Intelion sshKeyIds must not contain duplicates");
    }

    return {
      name,
      flavorId,
      networkDiskGb,
      osImageId,
      pricePlan,
      ...(promotionCodeId === undefined ? {} : { promotionCodeId }),
      queueWhenUnavailable: input.queueWhenUnavailable ?? false,
      addonIds,
      sshKeyIds,
    };
  }

  async createServer(
    input: IntelionServerConfigurationInput,
    context: ProviderOperationContext,
  ): Promise<IntelionServerCreationResult> {
    const configuration = this.validateConfiguration(input);
    const response = await this.client.postJsonMutation(
      "/api/v2/cloud-servers/",
      createPayload(configuration),
      context,
    );
    return parseCreationResult(response);
  }

  async #runOsImages(
    args: readonly string[],
    context: ProviderCliCommandContext,
  ): Promise<void> {
    const images = await this.listOsImages(parseOsImageArgs(args), context);
    context.write(`${JSON.stringify(images)}\n`);
  }

  async #runFlavors(
    args: readonly string[],
    context: ProviderCliCommandContext,
  ): Promise<void> {
    if (args.length !== 0) {
      throw new Error("Intelion flavors does not accept arguments");
    }
    const flavors = await this.listFlavors(context);
    context.write(`${JSON.stringify(flavors)}\n`);
  }

  async #runSshKeys(
    args: readonly string[],
    context: ProviderCliCommandContext,
  ): Promise<void> {
    if (args.length !== 0) {
      throw new Error("Intelion ssh-keys does not accept arguments");
    }
    const keys = await this.listSshKeys(context);
    context.write(`${JSON.stringify(keys)}\n`);
  }

  async #runValidate(
    args: readonly string[],
    context: ProviderCliCommandContext,
  ): Promise<void> {
    const configuration = this.validateConfiguration(parseValidateArgs(args));
    context.write(`${JSON.stringify(configuration)}\n`);
  }

  async #runCreate(
    args: readonly string[],
    context: ProviderCliCommandContext,
  ): Promise<ProviderCliCommandResult> {
    const result = await this.createServer(parseValidateArgs(args), context);
    context.write(`${JSON.stringify(result)}\n`);
    return {
      refreshProviderInventory: true,
      affectedProviderExternalIds: [result.providerExternalId],
    };
  }
}

function parseOsImageArgs(args: readonly string[]): IntelionOsImageQuery {
  if (args.length === 0) {
    return {};
  }
  if (args.length === 2 && args[0] === "--flavor") {
    return { flavorId: Number(args[1]) };
  }
  throw new Error("Intelion os-images accepts only optional --flavor <id>");
}

function parseCatalogPage(
  value: unknown,
  catalogName: string,
): { readonly results: readonly unknown[]; readonly next?: string } {
  try {
    if (Array.isArray(value)) {
      return { results: value };
    }
    const page = expectRecord(value, `Intelion ${catalogName} list response`);
    if (!Array.isArray(page.results)) {
      throw new TypeError(
        `Intelion ${catalogName} list response.results must be an array`,
      );
    }
    if (page.next === null || page.next === undefined) {
      return { results: page.results };
    }
    if (typeof page.next !== "string" || page.next.length === 0) {
      throw new TypeError(
        `Intelion ${catalogName} list response.next must be a non-empty string or null`,
      );
    }
    return { results: page.results, next: page.next };
  } catch (error) {
    if (isNormalizedError(error)) {
      throw error;
    }
    throw normalizedError(
      "plugin-failure",
      `Intelion returned an invalid ${catalogName} list payload`,
      error,
    );
  }
}

function parseOsImage(value: unknown): IntelionOsImage {
  try {
    const image = expectRecord(value, "Intelion OS image");
    const id = positiveIntegerValue(image.id, "Intelion OS image.id");
    if (typeof image.name !== "string" || image.name.trim().length === 0) {
      throw new TypeError("Intelion OS image.name must be a non-empty string");
    }
    const type = optionalString(image.type, "Intelion OS image.type");
    const description = optionalString(
      image.description,
      "Intelion OS image.description",
    );
    const sshEnabled = optionalBoolean(
      image.ssh_enabled,
      "Intelion OS image.ssh_enabled",
    );
    const rdpEnabled = optionalBoolean(
      image.rdp_enabled,
      "Intelion OS image.rdp_enabled",
    );
    const compatibleFlavorIds = parseOptionalPositiveIntegerList(
      image.compatible_flavor_ids,
      "Intelion OS image.compatible_flavor_ids",
    );

    return {
      id,
      name: image.name,
      type,
      description,
      sshEnabled,
      rdpEnabled,
      ...(compatibleFlavorIds === undefined ? {} : { compatibleFlavorIds }),
    };
  } catch (error) {
    if (isNormalizedError(error)) {
      throw error;
    }
    throw normalizedError(
      "plugin-failure",
      "Intelion returned an invalid OS-image payload",
      error,
    );
  }
}

function parseFlavor(value: unknown): IntelionFlavor {
  try {
    const flavor = expectRecord(value, "Intelion flavor");
    const id = positiveIntegerValue(flavor.id, "Intelion flavor.id");
    if (typeof flavor.name !== "string" || flavor.name.trim().length === 0) {
      throw new TypeError("Intelion flavor.name must be a non-empty string");
    }
    const cpuCount = optionalNonNegativeInteger(
      flavor.cpu_count,
      "Intelion flavor.cpu_count",
    );
    const ramCount = optionalNonNegativeInteger(
      flavor.ram_count,
      "Intelion flavor.ram_count",
    );
    const gpuCount = optionalNullableNonNegativeInteger(
      flavor.gpu_count,
      "Intelion flavor.gpu_count",
    );
    const monthlyPriceRubCents = optionalNonNegativeInteger(
      flavor.flavor_monthly_price_rub_cents,
      "Intelion flavor.flavor_monthly_price_rub_cents",
    );
    const hourlyPriceRubCents = optionalNonNegativeInteger(
      flavor.flavor_hourly_price_rub_cents,
      "Intelion flavor.flavor_hourly_price_rub_cents",
    );
    const maxAvailable = optionalNonNegativeInteger(
      flavor.max_available,
      "Intelion flavor.max_available",
    );

    return {
      id,
      name: flavor.name,
      cpuCount,
      ramCount,
      ...(gpuCount === undefined ? {} : { gpuCount }),
      monthlyPriceRubCents,
      hourlyPriceRubCents,
      maxAvailable,
      available: maxAvailable > 0,
    };
  } catch (error) {
    if (isNormalizedError(error)) {
      throw error;
    }
    throw normalizedError(
      "plugin-failure",
      "Intelion returned an invalid flavor payload",
      error,
    );
  }
}

function parseSshKey(value: unknown): IntelionSshKey {
  try {
    const key = expectRecord(value, "Intelion SSH key");
    const id = positiveIntegerValue(key.id, "Intelion SSH key.id");
    if (typeof key.name !== "string" || key.name.trim().length === 0) {
      throw new TypeError("Intelion SSH key.name must be a non-empty string");
    }
    if (
      typeof key.key_type !== "string" ||
      key.key_type.trim().length === 0
    ) {
      throw new TypeError("Intelion SSH key.key_type must be a non-empty string");
    }
    if (
      typeof key.fingerprint_sha256 !== "string" ||
      key.fingerprint_sha256.trim().length === 0
    ) {
      throw new TypeError(
        "Intelion SSH key.fingerprint_sha256 must be a non-empty string",
      );
    }
    return {
      id,
      name: key.name,
      keyType: key.key_type,
      fingerprintSha256: key.fingerprint_sha256,
    };
  } catch (error) {
    if (isNormalizedError(error)) {
      throw error;
    }
    throw normalizedError(
      "plugin-failure",
      "Intelion returned an invalid SSH-key payload",
      error,
    );
  }
}

function createPayload(
  configuration: IntelionServerConfiguration,
): Record<string, unknown> {
  return {
    name: configuration.name,
    flavor_id: configuration.flavorId,
    ssd_count: configuration.networkDiskGb,
    os_id: configuration.osImageId,
    price_plan: configuration.pricePlan,
    ...(configuration.promotionCodeId === undefined
      ? {}
      : { promocode_id: configuration.promotionCodeId }),
    ...(configuration.queueWhenUnavailable ? { is_in_queue: true } : {}),
    ...(configuration.addonIds.length === 0
      ? {}
      : { addon_ids: [...configuration.addonIds] }),
    ...(configuration.sshKeyIds.length === 0
      ? {}
      : { ssh_key_ids: [...configuration.sshKeyIds] }),
  };
}

function parseCreationResult(value: unknown): IntelionServerCreationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw normalizedError(
      "outcome-unknown",
      "Intelion create response did not identify the created cloud server",
    );
  }
  const id = (value as Record<string, unknown>).id;
  if (!Number.isInteger(id) || (id as number) < 0) {
    throw normalizedError(
      "outcome-unknown",
      "Intelion create response did not identify the created cloud server",
    );
  }
  return { providerExternalId: String(id) };
}

function parseValidateArgs(args: readonly string[]): IntelionServerConfigurationInput {
  let name: string | undefined;
  let flavorId: number | undefined;
  let networkDiskGb: number | undefined;
  let osImageId: number | undefined;
  let pricePlan: number | undefined;
  let promotionCodeId: number | undefined;
  let queueWhenUnavailable = false;
  const addonIds: number[] = [];
  const sshKeyIds: number[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--queue") {
      queueWhenUnavailable = true;
      continue;
    }

    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for Intelion configurator option ${option}`);
    }
    index += 1;

    switch (option) {
      case "--name":
        name = value;
        break;
      case "--flavor":
        flavorId = Number(value);
        break;
      case "--disk":
        networkDiskGb = Number(value);
        break;
      case "--os":
        osImageId = Number(value);
        break;
      case "--price-plan":
        pricePlan = Number(value);
        break;
      case "--promocode":
        promotionCodeId = Number(value);
        break;
      case "--addon":
        addonIds.push(Number(value));
        break;
      case "--ssh-key":
        sshKeyIds.push(Number(value));
        break;
      default:
        throw new Error(`Unknown Intelion configurator option: ${option}`);
    }
  }

  if (name === undefined) {
    throw new Error("Intelion configurator requires --name <name>");
  }
  if (flavorId === undefined) {
    throw new Error("Intelion configurator requires --flavor <id>");
  }
  if (networkDiskGb === undefined) {
    throw new Error("Intelion configurator requires --disk <gb>");
  }
  if (osImageId === undefined) {
    throw new Error("Intelion configurator requires --os <id>");
  }

  return {
    name,
    flavorId,
    networkDiskGb,
    osImageId,
    ...(pricePlan === undefined ? {} : { pricePlan }),
    ...(promotionCodeId === undefined ? {} : { promotionCodeId }),
    queueWhenUnavailable,
    addonIds,
    sshKeyIds,
  };
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveIntegerValue(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(
      `${path} must be a positive integer within JavaScript's safe range`,
    );
  }
  return value as number;
}

function optionalString(value: unknown, path: string): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new TypeError(`${path} must be a string when present`);
  }
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new TypeError(`${path} must be a boolean when present`);
  }
  return value;
}

function parseOptionalPositiveIntegerList(
  value: unknown,
  path: string,
): readonly number[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array when present`);
  }
  return value.map((entry, index) =>
    positiveIntegerValue(entry, `${path}[${index}]`),
  );
}

function optionalNonNegativeInteger(value: unknown, path: string): number {
  if (value === undefined || value === null) {
    return 0;
  }
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`${path} must be a non-negative integer when present`);
  }
  return value as number;
}

function optionalNullableNonNegativeInteger(
  value: unknown,
  path: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return optionalNonNegativeInteger(value, path);
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      `Intelion ${field} must be a positive integer within JavaScript's safe range`,
    );
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`Intelion ${field} must be a non-negative integer`);
  }
  return value;
}

function integerAtLeast(value: number, min: number, field: string): number {
  if (!Number.isInteger(value) || value < min) {
    throw new TypeError(`Intelion ${field} must be an integer >= ${min}`);
  }
  return value;
}
