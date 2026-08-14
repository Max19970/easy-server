import {
  parseProviderCliHelpModule,
  type ProviderCliHelpContribution,
} from "@easyai101/easyserver-plugin-sdk";
import { JsonStateStore } from "./state-store.js";

export type ProviderCliHelpImporter = (specifier: string) => Promise<unknown>;

export interface ProviderCliHelpLookupOptions {
  readonly stateFile: string;
  readonly importer?: ProviderCliHelpImporter;
}

export async function loadProviderCliHelp(
  providerId: string,
  options: ProviderCliHelpLookupOptions,
): Promise<ProviderCliHelpContribution | undefined> {
  let state;
  try {
    state = await new JsonStateStore(options.stateFile).read();
  } catch {
    return undefined;
  }
  const importer = options.importer ?? importProviderCliHelp;

  for (const registration of state.plugins) {
    const specifier = providerHelpSpecifier(registration.source);
    if (specifier === undefined) {
      continue;
    }
    let imported: unknown;
    try {
      imported = await importer(specifier);
    } catch {
      continue;
    }
    let contribution: ProviderCliHelpContribution;
    try {
      contribution = parseProviderCliHelpModule(imported);
    } catch {
      continue;
    }
    if (contribution.providerId === providerId) {
      return contribution;
    }
  }

  return undefined;
}

export function providerHelpSpecifier(source: string): string | undefined {
  return /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(source)
    ? `${source}/easyserver-help`
    : undefined;
}

async function importProviderCliHelp(specifier: string): Promise<unknown> {
  return import(specifier);
}
