import type {
  ProviderCliCommandHelp,
  ProviderCliCommandMetadata,
  ProviderCliHelpContribution,
} from "@easyai101/easyserver-plugin-sdk";

export const INTELION_SERVER_CONFIGURATION_HELP: ProviderCliCommandHelp = {
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

export const INTELION_OS_IMAGES_COMMAND_HELP = {
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
} as const satisfies ProviderCliCommandMetadata;

export const INTELION_FLAVORS_COMMAND_HELP = {
  name: "flavors",
  description: "List Intelion server flavors",
  operation: "read",
  help: {},
} as const satisfies ProviderCliCommandMetadata;

export const INTELION_SSH_KEYS_COMMAND_HELP = {
  name: "ssh-keys",
  description: "List registered Intelion SSH keys",
  operation: "read",
  help: {},
} as const satisfies ProviderCliCommandMetadata;

export const INTELION_VALIDATE_COMMAND_HELP = {
  name: "validate",
  description: "Validate an Intelion cloud-server configuration",
  operation: "read",
  help: INTELION_SERVER_CONFIGURATION_HELP,
} as const satisfies ProviderCliCommandMetadata;

export const INTELION_CREATE_COMMAND_HELP = {
  name: "create",
  description: "Create an Intelion cloud-server configuration",
  operation: "mutation",
  risks: ["billable"],
  help: INTELION_SERVER_CONFIGURATION_HELP,
} as const satisfies ProviderCliCommandMetadata;

export const INTELION_SERVER_CONFIGURATOR_COMMAND_HELP = [
  INTELION_OS_IMAGES_COMMAND_HELP,
  INTELION_FLAVORS_COMMAND_HELP,
  INTELION_SSH_KEYS_COMMAND_HELP,
  INTELION_VALIDATE_COMMAND_HELP,
  INTELION_CREATE_COMMAND_HELP,
] as const satisfies readonly ProviderCliCommandMetadata[];

export const easyserverCliHelp: ProviderCliHelpContribution = {
  pluginId: "intelion",
  providerId: "intelion",
  displayName: "Intelion.cloud",
  features: [
    {
      id: "server-configurator",
      displayName: "Server Configurator",
      commands: INTELION_SERVER_CONFIGURATOR_COMMAND_HELP,
    },
  ],
};
