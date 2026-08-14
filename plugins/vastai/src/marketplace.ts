import {
  isNormalizedError,
  normalizedError,
  providerCliUsageError,
  type ProviderCliCommandContext,
  type ProviderCliCommandResult,
  type ProviderCliContribution,
  type ProviderFeature,
  type ProviderInteractiveContext,
  type ProviderInteractiveContribution,
  type ProviderInteractiveEvent,
  type ProviderInteractiveField,
  type ProviderInteractiveFieldValue,
  type ProviderInteractiveScreen,
  type ProviderInteractiveSession,
  type ProviderInteractiveTransition,
  type ProviderOperationContext,
} from "@easyai101/easyserver-plugin-sdk";
import { VastApiClient } from "./api-client.js";
import {
  VAST_RENT_COMMAND_HELP,
  VAST_SEARCH_COMMAND_HELP,
} from "./cli-help.js";

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
        ...VAST_SEARCH_COMMAND_HELP,
        run: (args, context) => this.#runSearchCommand(args, context),
      },
      {
        ...VAST_RENT_COMMAND_HELP,
        run: (args, context) => this.#runRentCommand(args, context),
      },
    ],
  };
  readonly interactive: ProviderInteractiveContribution = {
    flows: [
      {
        id: "rent-wizard",
        commandName: "rent",
        open: (context) => this.#openRentFlow(context),
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

  async #openRentFlow(
    _context: ProviderInteractiveContext,
  ): Promise<ProviderInteractiveSession> {
    return new VastRentInteractiveSession(this);
  }
}

interface VastRentFlowState {
  readonly search: VastOfferSearch;
  readonly offers: readonly VastOffer[];
  readonly selectedOfferId?: string;
  readonly image: string;
  readonly diskGb?: number;
  readonly runtype?: VastRuntype;
  readonly label?: string;
}

class VastRentInteractiveSession implements ProviderInteractiveSession {
  readonly initialScreen: ProviderInteractiveScreen;
  #state: VastRentFlowState = {
    search: { limit: 10 },
    offers: [],
    image: "",
  };

  constructor(private readonly marketplace: MarketplaceFeature) {
    this.initialScreen = vastSearchScreen(this.#state);
  }

  async dispatch(
    event: ProviderInteractiveEvent,
    context: ProviderInteractiveContext,
  ): Promise<ProviderInteractiveTransition> {
    if (event.kind === "field-change") {
      this.#state = updateVastFlowField(this.#state, event.fieldId, event.value);
      return {
        kind: "screen",
        screen: isVastRentalField(event.fieldId)
          ? vastRentalScreen(this.#state)
          : vastSearchScreen(this.#state),
      };
    }

    if (event.kind === "table-selection") {
      const selectedOfferId =
        event.rowIds.length === 1 &&
        this.#state.offers.some((offer) => offer.id === event.rowIds[0])
          ? event.rowIds[0]
          : undefined;
      this.#state = { ...this.#state, selectedOfferId };
      return { kind: "screen", screen: vastResultsScreen(this.#state) };
    }

    switch (event.actionId) {
      case "search":
      case "refresh": {
        const validation = validateVastSearch(this.#state.search);
        if (validation !== undefined) {
          return {
            kind: "screen",
            screen: vastSearchScreen(this.#state, validation),
          };
        }
        const offers = await this.marketplace.searchOffers(
          this.#state.search,
          providerReadContext(context),
        );
        this.#state = {
          ...this.#state,
          offers,
          selectedOfferId: offers.some(
            (offer) => offer.id === this.#state.selectedOfferId,
          )
            ? this.#state.selectedOfferId
            : undefined,
        };
        return { kind: "screen", screen: vastResultsScreen(this.#state) };
      }
      case "back-search":
        return { kind: "screen", screen: vastSearchScreen(this.#state) };
      case "continue":
        return {
          kind: "screen",
          screen:
            this.#state.selectedOfferId === undefined
              ? vastResultsScreen(this.#state)
              : vastRentalScreen(this.#state),
        };
      case "back-results":
        return { kind: "screen", screen: vastResultsScreen(this.#state) };
      case "review": {
        const validation = validateVastRental(this.#state);
        if (validation !== undefined) {
          return {
            kind: "screen",
            screen: vastRentalScreen(this.#state, validation),
          };
        }
        return { kind: "screen", screen: vastReviewScreen(this.#state) };
      }
      case "back-rental":
        return { kind: "screen", screen: vastRentalScreen(this.#state) };
      case "rent":
        return { kind: "submit", args: vastRentArgs(this.#state) };
      default:
        throw new Error(`Unknown Vast.ai marketplace flow action: ${event.actionId}`);
    }
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

interface VastFlowValidation {
  readonly fieldId: string;
  readonly message: string;
}

function vastSearchScreen(
  state: VastRentFlowState,
  invalid?: VastFlowValidation,
): ProviderInteractiveScreen {
  const fields: ProviderInteractiveField[] = [
    {
      kind: "text",
      id: "gpu",
      label: "GPU model/name",
      description: "Optional exact Vast.ai GPU name filter",
      required: false,
      ...(state.search.gpuName === undefined ? {} : { value: state.search.gpuName }),
      ...fieldValidation("gpu", invalid),
    },
    {
      kind: "integer",
      id: "min-gpus",
      label: "Minimum GPU count",
      required: false,
      ...(state.search.minGpuCount === undefined
        ? {}
        : { value: state.search.minGpuCount }),
      ...fieldValidation("min-gpus", invalid),
    },
    {
      kind: "decimal",
      id: "max-hourly",
      label: "Maximum hourly USD",
      required: false,
      ...(state.search.maxHourlyPrice === undefined
        ? {}
        : { value: state.search.maxHourlyPrice }),
      ...fieldValidation("max-hourly", invalid),
    },
    {
      kind: "decimal",
      id: "min-reliability",
      label: "Minimum reliability",
      description: "Ratio from 0 to 1",
      required: false,
      ...(state.search.minReliability === undefined
        ? {}
        : { value: state.search.minReliability }),
      ...fieldValidation("min-reliability", invalid),
    },
    {
      kind: "boolean",
      id: "verified",
      label: "Verified hosts only",
      required: false,
      value: state.search.verifiedOnly ?? false,
    },
    {
      kind: "integer",
      id: "limit",
      label: "Result limit",
      required: false,
      value: state.search.limit ?? 10,
      ...fieldValidation("limit", invalid),
    },
  ];
  return {
    kind: "form",
    id: "vast-marketplace-search",
    title: "Vast.ai marketplace search",
    description: "Filter currently rentable offers before choosing one to rent.",
    fields,
    actions: [{ id: "search", label: "Search offers", kind: "primary" }],
  };
}

function vastResultsScreen(state: VastRentFlowState): ProviderInteractiveScreen {
  return {
    kind: "table",
    id: "vast-marketplace-results",
    title: "Vast.ai marketplace offers",
    description:
      state.offers.length === 0
        ? "No rentable offers matched the current filters. Refresh or go back to change filters."
        : "Select one offer, then continue to rental options.",
    columns: [
      { id: "offer", label: "Offer" },
      { id: "gpu", label: "GPU" },
      { id: "count", label: "Count" },
      { id: "memory", label: "VRAM" },
      { id: "hourly", label: "USD/hour" },
      { id: "reliability", label: "Reliability" },
      { id: "location", label: "Location" },
    ],
    rows: state.offers.map((offer) => ({
      id: offer.id,
      cells: {
        offer: offer.id,
        gpu: offer.gpuName,
        count: offer.gpuCount,
        memory: `${(offer.gpuRamMb / 1024).toFixed(1)} GiB`,
        hourly: offer.hourlyPriceUsd,
        reliability: `${(offer.reliability * 100).toFixed(1)}%`,
        location: offer.location ?? "unknown",
      },
    })),
    selection: "single",
    selectedRowIds:
      state.selectedOfferId === undefined ? [] : [state.selectedOfferId],
    actions: [
      { id: "back-search", label: "Change filters", kind: "back" },
      { id: "refresh", label: "Refresh offers", kind: "refresh" },
      {
        id: "continue",
        label: "Use selected offer",
        kind: "primary",
        disabled: state.selectedOfferId === undefined,
      },
    ],
  };
}

function vastRentalScreen(
  state: VastRentFlowState,
  invalid?: VastFlowValidation,
): ProviderInteractiveScreen {
  return {
    kind: "form",
    id: "vast-rental-options",
    title: "Vast.ai rental options",
    description: `Selected offer: ${state.selectedOfferId ?? "none"}`,
    fields: [
      {
        kind: "text",
        id: "image",
        label: "Container image",
        required: true,
        value: state.image,
        ...fieldValidation("image", invalid),
      },
      {
        kind: "decimal",
        id: "disk",
        label: "Disk size (GB)",
        required: false,
        ...(state.diskGb === undefined ? {} : { value: state.diskGb }),
        ...fieldValidation("disk", invalid),
      },
      {
        kind: "single-choice",
        id: "runtype",
        label: "Runtype",
        required: false,
        choices: VAST_RUNTYPES.map((runtype) => ({
          id: runtype,
          label: runtype,
        })),
        ...(state.runtype === undefined ? {} : { value: state.runtype }),
      },
      {
        kind: "text",
        id: "label",
        label: "Instance label",
        required: false,
        ...(state.label === undefined ? {} : { value: state.label }),
      },
    ],
    actions: [
      { id: "back-results", label: "Back to offers", kind: "back" },
      { id: "review", label: "Review rental", kind: "primary" },
    ],
  };
}

function vastReviewScreen(state: VastRentFlowState): ProviderInteractiveScreen {
  const offer = state.offers.find((candidate) => candidate.id === state.selectedOfferId);
  return {
    kind: "review",
    id: "vast-rental-review",
    title: "Review Vast.ai rental",
    description: "EasyServer will ask for billable confirmation before provider dispatch.",
    items: [
      { label: "Offer", value: state.selectedOfferId ?? "none" },
      ...(offer === undefined
        ? []
        : [
            { label: "GPU", value: `${offer.gpuCount} × ${offer.gpuName}` },
            { label: "Hourly price", value: `$${offer.hourlyPriceUsd}/hour` },
          ]),
      { label: "Image", value: state.image },
      { label: "Disk", value: state.diskGb === undefined ? "provider default" : `${state.diskGb} GB` },
      { label: "Runtype", value: state.runtype ?? "provider default" },
      { label: "Label", value: state.label ?? "none" },
    ],
    actions: [
      { id: "back-rental", label: "Back", kind: "back" },
      { id: "rent", label: "Rent selected offer", kind: "submit" },
    ],
  };
}

function updateVastFlowField(
  state: VastRentFlowState,
  fieldId: string,
  value: ProviderInteractiveFieldValue | undefined,
): VastRentFlowState {
  switch (fieldId) {
    case "gpu":
      return {
        ...state,
        search: {
          ...state.search,
          gpuName: optionalText(value),
        },
      };
    case "min-gpus":
      return {
        ...state,
        search: { ...state.search, minGpuCount: optionalNumber(value) },
      };
    case "max-hourly":
      return {
        ...state,
        search: { ...state.search, maxHourlyPrice: optionalNumber(value) },
      };
    case "min-reliability":
      return {
        ...state,
        search: { ...state.search, minReliability: optionalNumber(value) },
      };
    case "verified":
      return {
        ...state,
        search: { ...state.search, verifiedOnly: value === true },
      };
    case "limit":
      return {
        ...state,
        search: { ...state.search, limit: optionalNumber(value) },
      };
    case "image":
      return { ...state, image: typeof value === "string" ? value : "" };
    case "disk":
      return { ...state, diskGb: optionalNumber(value) };
    case "runtype":
      return {
        ...state,
        runtype:
          typeof value === "string" && isVastRuntype(value)
            ? value
            : undefined,
      };
    case "label":
      return { ...state, label: optionalText(value) };
    default:
      throw new Error(`Unknown Vast.ai marketplace flow field: ${fieldId}`);
  }
}

function validateVastSearch(search: VastOfferSearch): VastFlowValidation | undefined {
  if (
    search.minGpuCount !== undefined &&
    (!Number.isInteger(search.minGpuCount) || search.minGpuCount <= 0)
  ) {
    return { fieldId: "min-gpus", message: "Must be a positive integer" };
  }
  if (search.maxHourlyPrice !== undefined && search.maxHourlyPrice <= 0) {
    return { fieldId: "max-hourly", message: "Must be greater than zero" };
  }
  if (
    search.minReliability !== undefined &&
    (search.minReliability < 0 || search.minReliability > 1)
  ) {
    return { fieldId: "min-reliability", message: "Must be between 0 and 1" };
  }
  if (
    search.limit !== undefined &&
    (!Number.isInteger(search.limit) || search.limit <= 0)
  ) {
    return { fieldId: "limit", message: "Must be a positive integer" };
  }
  return undefined;
}

function validateVastRental(state: VastRentFlowState): VastFlowValidation | undefined {
  if (state.selectedOfferId === undefined) {
    return { fieldId: "image", message: "Select an offer first" };
  }
  if (state.image.trim().length === 0) {
    return { fieldId: "image", message: "Container image is required" };
  }
  if (state.diskGb !== undefined && state.diskGb <= 0) {
    return { fieldId: "disk", message: "Disk size must be greater than zero" };
  }
  return undefined;
}

function vastRentArgs(state: VastRentFlowState): readonly string[] {
  const validation = validateVastRental(state);
  if (validation !== undefined || state.selectedOfferId === undefined) {
    throw new Error(validation?.message ?? "Vast.ai rental is incomplete");
  }
  const args: string[] = [state.selectedOfferId, "--image", state.image.trim()];
  if (state.diskGb !== undefined) {
    args.push("--disk", String(state.diskGb));
  }
  if (state.runtype !== undefined) {
    args.push("--runtype", state.runtype);
  }
  if (state.label !== undefined) {
    args.push("--label", state.label);
  }
  parseRentalArgs(args);
  return args;
}

function fieldValidation(
  fieldId: string,
  invalid?: VastFlowValidation,
): { readonly validation?: { readonly state: "invalid"; readonly message: string } } {
  return invalid?.fieldId === fieldId
    ? { validation: { state: "invalid", message: invalid.message } }
    : {};
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isVastRentalField(fieldId: string): boolean {
  return fieldId === "image" || fieldId === "disk" || fieldId === "runtype" || fieldId === "label";
}

function providerReadContext(
  context: ProviderInteractiveContext,
): ProviderOperationContext {
  return {
    signal: context.signal,
    resolveCredential: context.resolveCredential,
    markMutationDispatched() {
      throw new Error("Vast.ai interactive preparation cannot dispatch mutations");
    },
  };
}

function parseRentalArgs(args: readonly string[]): VastRentalRequest {
  const [offerId, ...options] = args;
  if (offerId === undefined) {
    throw providerCliUsageError("Vast marketplace rent requires <offer-id>");
  }

  let image: string | undefined;
  let diskGb: number | undefined;
  let runtype: VastRuntype | undefined;
  let label: string | undefined;

  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (value === undefined) {
      throw providerCliUsageError(`Missing value for Vast rental option ${option}`);
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
          throw providerCliUsageError(`Unsupported Vast runtype: ${value}`);
        }
        runtype = value;
        break;
      case "--label":
        label = value;
        break;
      default:
        throw providerCliUsageError(`Unknown Vast rental option: ${option}`);
    }
  }

  if (image === undefined) {
    throw providerCliUsageError("Vast marketplace rent requires --image <image>");
  }

  const request = {
    offerId,
    image,
    ...(diskGb === undefined ? {} : { diskGb }),
    ...(runtype === undefined ? {} : { runtype }),
    ...(label === undefined ? {} : { label }),
  };
  try {
    expectOfferId(request.offerId);
    buildRentalRequest(request);
  } catch (error) {
    if (error instanceof TypeError) {
      throw providerCliUsageError(error.message);
    }
    throw error;
  }
  return request;
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
      throw providerCliUsageError(`Missing value for Vast marketplace option ${option}`);
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
        throw providerCliUsageError(`Unknown Vast marketplace option: ${option}`);
    }
  }

  try {
    buildOfferSearchRequest(search);
  } catch (error) {
    if (error instanceof TypeError) {
      throw providerCliUsageError(error.message);
    }
    throw error;
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
