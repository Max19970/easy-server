import type {
  ProviderCliCommandMetadata,
  ProviderCliHelpContribution,
} from "@easyai101/easyserver-plugin-sdk";

export const VAST_SEARCH_COMMAND_HELP = {
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
  } as const satisfies ProviderCliCommandMetadata;

export const VAST_RENT_COMMAND_HELP = {
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
  } as const satisfies ProviderCliCommandMetadata;

export const VAST_MARKETPLACE_COMMAND_HELP = [
  VAST_SEARCH_COMMAND_HELP,
  VAST_RENT_COMMAND_HELP,
] as const satisfies readonly ProviderCliCommandMetadata[];

export const easyserverCliHelp: ProviderCliHelpContribution = {
  pluginId: "vastai",
  providerId: "vastai",
  displayName: "Vast.ai",
  features: [
    {
      id: "marketplace",
      displayName: "Marketplace",
      commands: VAST_MARKETPLACE_COMMAND_HELP,
    },
  ],
};
