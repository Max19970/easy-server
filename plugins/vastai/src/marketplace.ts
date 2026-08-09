import {
  isNormalizedError,
  normalizedError,
  type ProviderCliCommandContext,
  type ProviderCliContribution,
  type ProviderFeature,
  type ProviderOperationContext,
} from "@easycompute/plugin-sdk";
import { VastApiClient } from "./api-client.js";

export interface VastOfferSearch {
  readonly gpuName?: string;
  readonly minGpuCount?: number;
  readonly maxHourlyPrice?: number;
  readonly minReliability?: number;
  readonly verifiedOnly?: boolean;
  readonly limit?: number;
}

export interface VastOffer {
  readonly id: string;
  readonly machineId: string;
  readonly gpuName: string;
  readonly gpuCount: number;
  readonly gpuRamMb: number;
  readonly hourlyPriceUsd: number;
  readonly reliability: number;
  readonly location: string;
}

export interface VastMarketplaceFeature extends ProviderFeature {
  readonly id: "marketplace";
  searchOffers(
    search: VastOfferSearch,
    context: ProviderOperationContext,
  ): Promise<readonly VastOffer[]>;
}

export function createVastMarketplaceFeature(
  client: VastApiClient,
): VastMarketplaceFeature {
  return new MarketplaceFeature(client);
}

class MarketplaceFeature implements VastMarketplaceFeature {
  readonly id = "marketplace" as const;
  readonly displayName = "Marketplace";
  readonly cli: ProviderCliContribution = {
    commands: [
      {
        name: "search",
        description: "Search Vast.ai marketplace offers",
        run: (args, context) => this.#runSearchCommand(args, context),
      },
    ],
  };

  constructor(private readonly client: VastApiClient) {}

  async searchOffers(
    search: VastOfferSearch,
    context: ProviderOperationContext,
  ): Promise<readonly VastOffer[]> {
    const body = await this.client.postJson(
      "/api/v0/bundles/",
      buildOfferSearchRequest(search),
      context,
    );
    return parseOffers(body);
  }

  async #runSearchCommand(
    args: readonly string[],
    context: ProviderCliCommandContext,
  ): Promise<void> {
    const offers = await this.searchOffers(parseSearchArgs(args), context);
    context.write(`${JSON.stringify(offers)}\n`);
  }
}

function parseSearchArgs(args: readonly string[]): VastOfferSearch {
  const search: {
    gpuName?: string;
    minGpuCount?: number;
    maxHourlyPrice?: number;
    minReliability?: number;
    verifiedOnly?: boolean;
    limit?: number;
  } = {};

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--verified") {
      search.verifiedOnly = true;
      continue;
    }

    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for Vast marketplace option ${option}`);
    }
    index += 1;

    switch (option) {
      case "--gpu":
        search.gpuName = value;
        break;
      case "--min-gpus":
        search.minGpuCount = Number(value);
        break;
      case "--max-hourly":
        search.maxHourlyPrice = Number(value);
        break;
      case "--min-reliability":
        search.minReliability = Number(value);
        break;
      case "--limit":
        search.limit = Number(value);
        break;
      default:
        throw new Error(`Unknown Vast marketplace option: ${option}`);
    }
  }

  return search;
}

function buildOfferSearchRequest(search: VastOfferSearch): Record<string, unknown> {
  const request: Record<string, unknown> = {};

  if (search.gpuName !== undefined) {
    const gpuName = search.gpuName.trim();
    if (gpuName.length === 0) {
      throw new TypeError("Vast marketplace gpuName must be non-empty");
    }
    request.gpu_name = { eq: gpuName };
  }
  if (search.minGpuCount !== undefined) {
    if (!Number.isInteger(search.minGpuCount) || search.minGpuCount < 1) {
      throw new TypeError("Vast marketplace minGpuCount must be a positive integer");
    }
    request.num_gpus = { gte: search.minGpuCount };
  }
  if (search.maxHourlyPrice !== undefined) {
    if (!Number.isFinite(search.maxHourlyPrice) || search.maxHourlyPrice < 0) {
      throw new TypeError("Vast marketplace maxHourlyPrice must be non-negative");
    }
    request.dph_total = { lte: search.maxHourlyPrice };
  }
  if (search.minReliability !== undefined) {
    if (
      !Number.isFinite(search.minReliability) ||
      search.minReliability < 0 ||
      search.minReliability > 1
    ) {
      throw new TypeError("Vast marketplace minReliability must be between 0 and 1");
    }
    request.reliability = { gte: search.minReliability };
  }
  if (search.verifiedOnly) {
    request.verified = { eq: true };
  }
  if (search.limit !== undefined) {
    if (!Number.isInteger(search.limit) || search.limit < 1) {
      throw new TypeError("Vast marketplace limit must be a positive integer");
    }
    request.limit = search.limit;
  }

  return request;
}

function parseOffers(value: unknown): readonly VastOffer[] {
  try {
    const response = expectRecord(value, "Vast.ai offer search response");
    if (!Array.isArray(response.offers)) {
      throw new TypeError("Vast.ai offer search response.offers must be an array");
    }
    return response.offers.map(parseOffer);
  } catch (error) {
    if (isNormalizedError(error)) {
      throw error;
    }
    throw normalizedError(
      "plugin-failure",
      "Vast.ai returned an invalid marketplace payload",
      error,
    );
  }
}

function parseOffer(value: unknown): VastOffer {
  const offer = expectRecord(value, "Vast.ai offer");
  return {
    id: String(expectInteger(offer.id, "Vast.ai offer.id", 0)),
    machineId: String(
      expectInteger(offer.machine_id, "Vast.ai offer.machine_id", 0),
    ),
    gpuName: expectString(offer.gpu_name, "Vast.ai offer.gpu_name"),
    gpuCount: expectInteger(offer.num_gpus, "Vast.ai offer.num_gpus", 1),
    gpuRamMb: expectNumber(offer.gpu_ram, "Vast.ai offer.gpu_ram", 0),
    hourlyPriceUsd: expectNumber(
      offer.dph_total,
      "Vast.ai offer.dph_total",
      0,
    ),
    reliability: expectNumber(
      offer.reliability,
      "Vast.ai offer.reliability",
      0,
      1,
    ),
    location: expectString(offer.geolocation, "Vast.ai offer.geolocation"),
  };
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function expectInteger(value: unknown, path: string, min: number): number {
  if (!Number.isInteger(value) || (value as number) < min) {
    throw new TypeError(`${path} must be an integer >= ${min}`);
  }
  return value as number;
}

function expectNumber(
  value: unknown,
  path: string,
  min: number,
  max = Number.POSITIVE_INFINITY,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw new TypeError(`${path} must be between ${min} and ${max}`);
  }
  return value;
}
