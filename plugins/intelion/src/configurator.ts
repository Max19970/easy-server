import type {
  ProviderCliCommandContext,
  ProviderCliContribution,
  ProviderFeature,
} from "@easycompute/plugin-sdk";

export interface IntelionServerConfigurationInput {
  readonly name: string;
  readonly flavorId: number;
  readonly networkDiskGb: number;
  readonly osImageId: number;
  readonly pricePlan?: number;
  readonly promotionCodeId?: number;
  readonly queueWhenUnavailable?: boolean;
  readonly addonIds?: readonly number[];
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
}

export interface IntelionServerConfiguratorFeature extends ProviderFeature {
  readonly id: "server-configurator";
  validateConfiguration(
    input: IntelionServerConfigurationInput,
  ): IntelionServerConfiguration;
}

export function createIntelionServerConfiguratorFeature(): IntelionServerConfiguratorFeature {
  return new ServerConfiguratorFeature();
}

class ServerConfiguratorFeature implements IntelionServerConfiguratorFeature {
  readonly id = "server-configurator" as const;
  readonly displayName = "Server Configurator";
  readonly cli: ProviderCliContribution = {
    commands: [
      {
        name: "validate",
        description: "Validate an Intelion cloud-server configuration",
        run: (args, context) => this.#runValidate(args, context),
      },
    ],
  };

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
    if (new Set(addonIds).size !== addonIds.length) {
      throw new TypeError("Intelion addonIds must not contain duplicates");
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
    };
  }

  async #runValidate(
    args: readonly string[],
    context: ProviderCliCommandContext,
  ): Promise<void> {
    const configuration = this.validateConfiguration(parseValidateArgs(args));
    context.write(`${JSON.stringify(configuration)}\n`);
  }
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
  };
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`Intelion ${field} must be a positive integer`);
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
