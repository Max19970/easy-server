import {
  isNormalizedError,
  normalizedError,
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
import { IntelionApiClient } from "./api-client.js";
import {
  INTELION_CREATE_COMMAND_HELP,
  INTELION_FLAVORS_COMMAND_HELP,
  INTELION_OS_IMAGES_COMMAND_HELP,
  INTELION_SSH_KEYS_COMMAND_HELP,
  INTELION_VALIDATE_COMMAND_HELP,
} from "./cli-help.js";

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

class ServerConfiguratorFeature implements IntelionServerConfiguratorFeature {
  readonly id = "server-configurator" as const;
  readonly displayName = "Server Configurator";
  readonly cli: ProviderCliContribution = {
    commands: [
      {
        ...INTELION_OS_IMAGES_COMMAND_HELP,
        run: (args, context) => this.#runOsImages(args, context),
      },
      {
        ...INTELION_FLAVORS_COMMAND_HELP,
        run: (args, context) => this.#runFlavors(args, context),
      },
      {
        ...INTELION_SSH_KEYS_COMMAND_HELP,
        run: (args, context) => this.#runSshKeys(args, context),
      },
      {
        ...INTELION_VALIDATE_COMMAND_HELP,
        run: (args, context) => this.#runValidate(args, context),
      },
      {
        ...INTELION_CREATE_COMMAND_HELP,
        run: (args, context) => this.#runCreate(args, context),
      },
    ],
  };
  readonly interactive: ProviderInteractiveContribution = {
    flows: [
      {
        id: "create-server-wizard",
        commandName: "create",
        open: (context) => this.#openCreateFlow(context),
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

  async #openCreateFlow(
    context: ProviderInteractiveContext,
  ): Promise<ProviderInteractiveSession> {
    const readContext = intelionReadContext(context);
    const [flavors, sshKeys] = await Promise.all([
      this.listFlavors(readContext),
      this.listSshKeys(readContext),
    ]);
    const flavorId = flavors.find((flavor) => flavor.available)?.id ?? flavors[0]?.id;
    const osImages = await this.listOsImages(
      flavorId === undefined ? {} : { flavorId },
      readContext,
    );
    return new IntelionCreateInteractiveSession(this, {
      name: "",
      flavorId,
      networkDiskGb: 30,
      osImageId: osImages[0]?.id,
      queueWhenUnavailable: false,
      addonIds: [],
      sshKeyIds: [],
      flavors,
      osImages,
      sshKeys,
    });
  }
}

interface IntelionCreateFlowState {
  readonly name: string;
  readonly flavorId?: number;
  readonly networkDiskGb: number;
  readonly osImageId?: number;
  readonly pricePlan?: number;
  readonly promotionCodeId?: number;
  readonly queueWhenUnavailable: boolean;
  readonly addonIds: readonly number[];
  readonly sshKeyIds: readonly number[];
  readonly flavors: readonly IntelionFlavor[];
  readonly osImages: readonly IntelionOsImage[];
  readonly sshKeys: readonly IntelionSshKey[];
}

interface IntelionFlowValidation {
  readonly fieldId: string;
  readonly message: string;
}

class IntelionCreateInteractiveSession implements ProviderInteractiveSession {
  readonly initialScreen: ProviderInteractiveScreen;
  #state: IntelionCreateFlowState;

  constructor(
    private readonly configurator: ServerConfiguratorFeature,
    state: IntelionCreateFlowState,
  ) {
    this.#state = state;
    this.initialScreen = intelionConfigurationScreen(state);
  }

  async dispatch(
    event: ProviderInteractiveEvent,
    context: ProviderInteractiveContext,
  ): Promise<ProviderInteractiveTransition> {
    if (event.kind === "field-change") {
      this.#state = updateIntelionFlowField(
        this.#state,
        event.fieldId,
        event.value,
      );
      if (event.fieldId === "flavor" && this.#state.flavorId !== undefined) {
        const osImages = await this.configurator.listOsImages(
          { flavorId: this.#state.flavorId },
          intelionReadContext(context),
        );
        this.#state = {
          ...this.#state,
          osImages,
          osImageId: osImages.some(
            (image) => image.id === this.#state.osImageId,
          )
            ? this.#state.osImageId
            : osImages[0]?.id,
        };
      }
      return {
        kind: "screen",
        screen: intelionConfigurationScreen(this.#state),
      };
    }

    if (event.kind === "table-selection") {
      throw new Error("Intelion configurator does not expose table selection");
    }

    switch (event.actionId) {
      case "refresh-catalogs": {
        const readContext = intelionReadContext(context);
        const [flavors, sshKeys, osImages] = await Promise.all([
          this.configurator.listFlavors(readContext),
          this.configurator.listSshKeys(readContext),
          this.configurator.listOsImages(
            this.#state.flavorId === undefined
              ? {}
              : { flavorId: this.#state.flavorId },
            readContext,
          ),
        ]);
        this.#state = { ...this.#state, flavors, sshKeys, osImages };
        return {
          kind: "screen",
          screen: intelionConfigurationScreen(this.#state),
        };
      }
      case "review": {
        try {
          const configuration = this.configurator.validateConfiguration(
            intelionDraftInput(this.#state),
          );
          return {
            kind: "screen",
            screen: intelionReviewScreen(this.#state, configuration),
          };
        } catch (error) {
          const validation = intelionValidationFromError(error);
          return {
            kind: "screen",
            screen: intelionConfigurationScreen(this.#state, validation),
          };
        }
      }
      case "back-configure":
        return {
          kind: "screen",
          screen: intelionConfigurationScreen(this.#state),
        };
      case "create":
        return {
          kind: "submit",
          args: intelionCreateArgs(
            this.configurator.validateConfiguration(
              intelionDraftInput(this.#state),
            ),
          ),
        };
      default:
        throw new Error(`Unknown Intelion configurator flow action: ${event.actionId}`);
    }
  }
}

function intelionConfigurationScreen(
  state: IntelionCreateFlowState,
  invalid?: IntelionFlowValidation,
): ProviderInteractiveScreen {
  const fields: ProviderInteractiveField[] = [
    {
      kind: "text",
      id: "name",
      label: "Server name",
      required: true,
      value: state.name,
      ...intelionFieldValidation("name", invalid),
    },
    state.flavors.length === 0
      ? {
          kind: "integer",
          id: "flavor",
          label: "Flavor ID",
          description: "No flavor choice metadata is available; enter an Intelion flavor ID.",
          required: true,
          ...(state.flavorId === undefined ? {} : { value: state.flavorId }),
          ...intelionFieldValidation("flavor", invalid),
        }
      : {
          kind: "single-choice",
          id: "flavor",
          label: "Flavor",
          required: true,
          choices: state.flavors.map((flavor) => ({
            id: String(flavor.id),
            label: `${flavor.name} · ${(flavor.hourlyPriceRubCents / 100).toFixed(2)} RUB/hour · ${flavor.available ? `${flavor.maxAvailable} available` : "currently unavailable"}`,
          })),
          ...(state.flavorId === undefined ? {} : { value: String(state.flavorId) }),
          ...intelionFieldValidation("flavor", invalid),
        },
    {
      kind: "integer",
      id: "disk",
      label: "Network disk (GB)",
      description: "Intelion requires at least 30 GB.",
      required: true,
      value: state.networkDiskGb,
      ...intelionFieldValidation("disk", invalid),
    },
    state.osImages.length === 0
      ? {
          kind: "integer",
          id: "os",
          label: "OS image ID",
          description: "No OS-image choice metadata is available; enter an Intelion OS image ID.",
          required: true,
          ...(state.osImageId === undefined ? {} : { value: state.osImageId }),
          ...intelionFieldValidation("os", invalid),
        }
      : {
          kind: "single-choice",
          id: "os",
          label: "Operating system",
          required: true,
          choices: state.osImages.map((image) => ({
            id: String(image.id),
            label: `${image.name} · ${image.type} · SSH ${image.sshEnabled ? "yes" : "no"} · RDP ${image.rdpEnabled ? "yes" : "no"}`,
            description: image.description,
          })),
          ...(state.osImageId === undefined ? {} : { value: String(state.osImageId) }),
          ...intelionFieldValidation("os", invalid),
        },
    {
      kind: "integer",
      id: "price-plan",
      label: "Price plan ID",
      description: "Advanced Intelion ID. Leave empty to use provider default 0.",
      required: false,
      ...(state.pricePlan === undefined ? {} : { value: state.pricePlan }),
      ...intelionFieldValidation("price-plan", invalid),
    },
    {
      kind: "integer",
      id: "promocode",
      label: "Promotion code ID",
      description: "Advanced Intelion ID when a promotion code applies.",
      required: false,
      ...(state.promotionCodeId === undefined
        ? {}
        : { value: state.promotionCodeId }),
      ...intelionFieldValidation("promocode", invalid),
    },
    {
      kind: "boolean",
      id: "queue",
      label: "Queue when capacity is unavailable",
      required: false,
      value: state.queueWhenUnavailable,
      ...intelionFieldValidation("queue", invalid),
    },
    {
      kind: "integer",
      id: "addons",
      label: "Addon IDs",
      description: "Advanced typed IDs; comma-separated when editing.",
      required: false,
      repeatable: true,
      value: state.addonIds,
      ...intelionFieldValidation("addons", invalid),
    },
    state.sshKeys.length === 0
      ? {
          kind: "integer",
          id: "ssh-keys",
          label: "SSH key IDs",
          description: "No SSH-key choice metadata is available; enter registered Intelion key IDs.",
          required: false,
          repeatable: true,
          value: state.sshKeyIds,
          ...intelionFieldValidation("ssh-keys", invalid),
        }
      : {
          kind: "multiple-choice",
          id: "ssh-keys",
          label: "SSH keys",
          required: false,
          choices: state.sshKeys.map((key) => ({
            id: String(key.id),
            label: `${key.name} · ${key.keyType}`,
            description: key.fingerprintSha256,
          })),
          value: state.sshKeyIds.map(String),
          ...intelionFieldValidation("ssh-keys", invalid),
        },
  ];

  return {
    kind: "form",
    id: "intelion-server-configuration",
    title: "Intelion server configuration",
    description: "Choose catalog entries where available; advanced provider IDs stay editable as typed fields.",
    fields,
    actions: [
      { id: "refresh-catalogs", label: "Refresh catalogs", kind: "refresh" },
      { id: "review", label: "Review server", kind: "primary" },
    ],
  };
}

function intelionReviewScreen(
  state: IntelionCreateFlowState,
  configuration: IntelionServerConfiguration,
): ProviderInteractiveScreen {
  const flavor = state.flavors.find((candidate) => candidate.id === configuration.flavorId);
  const image = state.osImages.find((candidate) => candidate.id === configuration.osImageId);
  const keys = state.sshKeys.filter((key) => configuration.sshKeyIds.includes(key.id));
  return {
    kind: "review",
    id: "intelion-server-review",
    title: "Review Intelion server",
    description: "EasyServer will ask for billable confirmation before provider dispatch.",
    items: [
      { label: "Name", value: configuration.name },
      {
        label: "Flavor",
        value: flavor === undefined
          ? String(configuration.flavorId)
          : `${flavor.name} (ID ${flavor.id})`,
      },
      {
        label: "OS",
        value: image === undefined
          ? String(configuration.osImageId)
          : `${image.name} (ID ${image.id})`,
      },
      { label: "Disk", value: `${configuration.networkDiskGb} GB` },
      { label: "Price plan", value: String(configuration.pricePlan) },
      {
        label: "Promotion code",
        value: configuration.promotionCodeId === undefined
          ? "none"
          : String(configuration.promotionCodeId),
      },
      {
        label: "Queue",
        value: configuration.queueWhenUnavailable ? "yes" : "no",
      },
      {
        label: "Addons",
        value: configuration.addonIds.length === 0
          ? "none"
          : configuration.addonIds.join(", "),
      },
      {
        label: "SSH keys",
        value:
          keys.length > 0
            ? keys.map((key) => `${key.name} (${key.id})`).join(", ")
            : configuration.sshKeyIds.length === 0
              ? "none"
              : configuration.sshKeyIds.join(", "),
      },
    ],
    actions: [
      { id: "back-configure", label: "Back", kind: "back" },
      { id: "create", label: "Create server", kind: "submit" },
    ],
  };
}

function updateIntelionFlowField(
  state: IntelionCreateFlowState,
  fieldId: string,
  value: ProviderInteractiveFieldValue | undefined,
): IntelionCreateFlowState {
  switch (fieldId) {
    case "name":
      return { ...state, name: typeof value === "string" ? value : "" };
    case "flavor":
      return { ...state, flavorId: intelionOptionalInteger(value) };
    case "disk":
      return {
        ...state,
        networkDiskGb: intelionOptionalInteger(value) ?? state.networkDiskGb,
      };
    case "os":
      return { ...state, osImageId: intelionOptionalInteger(value) };
    case "price-plan":
      return { ...state, pricePlan: intelionOptionalInteger(value) };
    case "promocode":
      return { ...state, promotionCodeId: intelionOptionalInteger(value) };
    case "queue":
      return { ...state, queueWhenUnavailable: value === true };
    case "addons":
      return { ...state, addonIds: intelionIntegerList(value) };
    case "ssh-keys":
      return { ...state, sshKeyIds: intelionIntegerList(value) };
    default:
      throw new Error(`Unknown Intelion configurator flow field: ${fieldId}`);
  }
}

function intelionDraftInput(
  state: IntelionCreateFlowState,
): IntelionServerConfigurationInput {
  return {
    name: state.name,
    flavorId: state.flavorId ?? Number.NaN,
    networkDiskGb: state.networkDiskGb,
    osImageId: state.osImageId ?? Number.NaN,
    ...(state.pricePlan === undefined ? {} : { pricePlan: state.pricePlan }),
    ...(state.promotionCodeId === undefined
      ? {}
      : { promotionCodeId: state.promotionCodeId }),
    queueWhenUnavailable: state.queueWhenUnavailable,
    addonIds: state.addonIds,
    sshKeyIds: state.sshKeyIds,
  };
}

function intelionCreateArgs(
  configuration: IntelionServerConfiguration,
): readonly string[] {
  const args: string[] = [
    "--name",
    configuration.name,
    "--flavor",
    String(configuration.flavorId),
    "--disk",
    String(configuration.networkDiskGb),
    "--os",
    String(configuration.osImageId),
  ];
  if (configuration.pricePlan !== 0) {
    args.push("--price-plan", String(configuration.pricePlan));
  }
  if (configuration.promotionCodeId !== undefined) {
    args.push("--promocode", String(configuration.promotionCodeId));
  }
  if (configuration.queueWhenUnavailable) {
    args.push("--queue");
  }
  for (const addonId of configuration.addonIds) {
    args.push("--addon", String(addonId));
  }
  for (const sshKeyId of configuration.sshKeyIds) {
    args.push("--ssh-key", String(sshKeyId));
  }
  parseValidateArgs(args);
  return args;
}

function intelionValidationFromError(error: unknown): IntelionFlowValidation {
  const message = error instanceof Error ? error.message : "Intelion configuration is invalid";
  const lower = message.toLowerCase();
  const fieldId = lower.includes("name")
    ? "name"
    : lower.includes("flavor")
      ? "flavor"
      : lower.includes("networkdisk")
        ? "disk"
        : lower.includes("osimage")
          ? "os"
          : lower.includes("priceplan")
            ? "price-plan"
            : lower.includes("promotion")
              ? "promocode"
              : lower.includes("addon")
                ? "addons"
                : lower.includes("sshkey")
                  ? "ssh-keys"
                  : lower.includes("queue")
                    ? "queue"
                    : "name";
  return { fieldId, message };
}

function intelionFieldValidation(
  fieldId: string,
  invalid?: IntelionFlowValidation,
): { readonly validation?: { readonly state: "invalid"; readonly message: string } } {
  return invalid?.fieldId === fieldId
    ? { validation: { state: "invalid", message: invalid.message } }
    : {};
}

function intelionOptionalInteger(
  value: ProviderInteractiveFieldValue | undefined,
): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function intelionIntegerList(
  value: ProviderInteractiveFieldValue | undefined,
): readonly number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => intelionOptionalInteger(entry))
    .filter((entry): entry is number => entry !== undefined);
}

function intelionReadContext(
  context: ProviderInteractiveContext,
): ProviderOperationContext {
  return {
    signal: context.signal,
    resolveCredential: context.resolveCredential,
    markMutationDispatched() {
      throw new Error("Intelion interactive preparation cannot dispatch mutations");
    },
  };
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
