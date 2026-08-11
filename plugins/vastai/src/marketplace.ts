import {
  isNormalizedError,
  normalizedError,
  type ProviderCliCommandContext,
  type ProviderCliCommandResult,
  type ProviderCliContribution,
  type ProviderFeature,
  type ProviderOperationContext,
} from "@easyai101/easyserver-plugin-sdk";
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
  readonly location?: string;
}

export type VastRuntype =
  | "ssh"
  | "jupyter"
  | "args"
  | "ssh_proxy"
  | "ssh_direct"
  | "jupyter_proxy"
  | "jupyter_direct";

export interface VastRentalRequest {
  readonly offerId: VastOffer["id"];
  readonly image: string;
  readonly diskGb?: number;
  readonly runtype?: VastRuntype;
  readonly label?: string;
}

export interface VastRentalResult {
  readonly providerExternalId: string;
}

export interface VastMarketplaceFeature extends ProviderFeature {
  readonly id: "marketplace";
  searchOffers(
    search: VastOfferSearch,
    context: ProviderOperationContext,
  ): Promise<readonly VastOffer[]>;
  rentOffer(
    request: VastRentalRequest,
    context: ProviderOperationContext,
  ): Promise<VastRentalResult>;
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
        operation: "read",
        help: {
          options: [
            {
              name: "--gpu",
              valueName: "gpu-name",
              description: "Filter by GPU model/name",
              required: false,
            },
            {
              name: "--min-gpus",
              valueName: "count",
              description: "Require at least this many GPUs",
              required: false,
            },
            {
              name: "--max-hourly",
              valueName: "usd",
              description: "Maximum hourly price in USD",
              required: false,
            },
            {
              name: "--min-reliability",
              valueName: "ratio",
              description: "Minimum reliability ratio",
              required: false,
            },
            {
              name: "--verified",
              description: "Require verified hosts",
              required: false,
            },
            {
              name: "--limit",
              valueName: "count",
              description: "Maximum number of offers to return",
              required: false,
            },
          ],
          examples: ["--gpu 'RTX 4090' --max-hourly 0.50 --verified --limit 10"],
        },
        run: (args, context) => this.#runSearchCommand(args, context),
      },
      {
        name: "rent",
        description: "Rent a Vast.ai marketplace offer",
        operation: "mutation",
        risks: ["billable"],
        help: {
          arguments: [
            {
              name: "offer-id",
              description: "Vast.ai marketplace offer ID",
              required: true,
            },
          ],
          options: [
            {
              name: "--image",
              valueName: "image",
              description: "Container image to run",
              required: true,
            },
            {
              name: "--disk",
              valueName: "gb",
              description: "Requested disk size in GB",
              required: false,
            },
            {
              name: "--runtype",
              valueName: "runtype",
              description: "Vast.ai runtype such as ssh or jupyter",
              required: false,
            },
            {
              name: "--label",
              valueName: "label",
              description: "Optional provider-side instance label",
              required: false,
            },
          ],
          examples: ["123456 --image pytorch/pytorch:latest --runtype ssh --disk 40"],
        },
        run: (args, context) => this.#runRentCommand(args, context),
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
    const offers = parseOffers(body);
    return search.maxHourlyPrice === undefined
      ? offers
      : offers.filter(
          (offer) => offer.hourlyPriceUsd <= search.maxHourlyPrice!,
        );
  }

  async rentOffer(
    request: VastRentalRequest,
    context: ProviderOperationContext,
  ): Promise<VastRentalResult> {
    const offerId = expectOfferId(request.offerId);
    const body = await this.client.putJsonMutation(
      `/api/v0/asks/${offerId}/`,
      buildRentalRequest(request),
      context,
    );
    return parseRentalResult(body);
  }

  async #runSearchCommand(
    args: readonly string[],
    context: ProviderCliCommandContext,
  ): Promise<void> {
    const offers = await this.searchOffers(parseSearchArgs(args), context);
    context.write(`${JSON.stringify(offers)}\n`);
  }

  async #runRentCommand(
    args: readonly string[],
    context: ProviderCliCommandContext,
  ): Promise<ProviderCliCommandResult> {
    const rental = await this.rentOffer(parseRentalArgs(args), context);
    context.write(`${JSON.stringify(rental)}\n`);
    return {
      refreshProviderInventory: true,
      affectedProviderExternalIds: [rental.providerExternalId],
    };
  }
}

const VAST_RUNTYPES: readonly VastRuntype[] = [
  "ssh",
  "jupyter",
  "args",
  "ssh_proxy",
  "ssh_direct",
  "jupyter_proxy",
  "jupyter_direct",
];

function parseRentalArgs(args: readonly string[]): VastRentalRequest {
  const [offerId, ...options] = args;
  if (offerId === undefined) {
    throw new Error("Vast marketplace rent requires <offer-id>");
  }

  let image: string | undefined;
  let diskGb: number | undefined;
  let runtype: VastRuntype | undefined;
  let label: string | undefined;

  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for Vast rental option ${option}`);
    }

    switch (option) {
      case "--image":
        image = value;
        break;
      case "--disk":
        diskGb = Number(value);
        break;
      case "--runtype":
        if (!isVastRuntype(value)) {
          throw new Error(`Unsupported Vast runtype: ${value}`);
        }
        runtype = value;
        break;
      case "--label":
        label = value;
        break;
      default:
        throw new Error(`Unknown Vast rental option: ${option}`);
    }
  }

  if (image === undefined) {
    throw new Error("Vast marketplace rent requires --image <image>");
  }

  return {
    offerId,
    image,
    ...(diskGb === undefined ? {} : { diskGb }),
    ...(runtype === undefined ? {} : { runtype }),
    ...(label === undefined ? {} : { label }),
  };
}

function buildRentalRequest(request: VastRentalRequest): Record<string, unknown> {
  const image = request.image.trim();
  if (image.length === 0) {
    throw new TypeError("Vast rental image must be non-empty");
  }

  const body: Record<string, unknown> = { image };
  if (request.diskGb !== undefined) {
    if (!Number.isFinite(request.diskGb) || request.diskGb <= 0) {
      throw new TypeError("Vast rental diskGb must be positive");
    }
    body.disk = request.diskGb;
  }
  if (request.runtype !== undefined) {
    if (!isVastRuntype(request.runtype)) {
      throw new TypeError(`Unsupported Vast runtype: ${request.runtype}`);
    }
    body.runtype = request.runtype;
  }
  if (request.label !== undefined) {
    const label = request.label.trim();
    if (label.length === 0) {
      throw new TypeError("Vast rental label must be non-empty");
    }
    body.label = label;
  }
  return body;
}

function parseRentalResult(value: unknown): VastRentalResult {
  try {
    const response = expectRecord(value, "Vast.ai create instance response");
    if (response.success !== true) {
      throw new TypeError("Vast.ai create instance response.success must be true");
    }
    return {
      providerExternalId: String(
        expectInteger(
          response.new_contract,
          "Vast.ai create instance response.new_contract",
          0,
        ),
      ),
    };
  } catch (error) {
    if (isNormalizedError(error)) {
      throw error;
    }
    throw normalizedError(
      "outcome-unknown",
      "Vast.ai rental outcome is unknown because the success payload was ambiguous",
      error,
    );
  }
}

function isVastRuntype(value: string): value is VastRuntype {
  return VAST_RUNTYPES.includes(value as VastRuntype);
}

function expectOfferId(value: string): string {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new TypeError("Vast rental offerId must be a non-negative integer ID");
  }
  return value;
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
  const request: Record<string, unknown> = {
    rentable: { eq: true },
  };

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
    const offers: VastOffer[] = [];
    for (const value of response.offers) {
      const offer = expectRecord(value, "Vast.ai offer");
      if (expectBoolean(offer.rentable, "Vast.ai offer.rentable")) {
        offers.push(parseOffer(offer));
      }
    }
    return offers;
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
  const location = optionalString(offer.geolocation, "Vast.ai offer.geolocation");
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
    ...(location === undefined ? {} : { location }),
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

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined || value === null ? undefined : expectString(value, path);
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${path} must be a boolean`);
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
