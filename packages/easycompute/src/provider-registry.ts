import type { ProviderAdapter } from "@easycompute/plugin-sdk";

export interface ProviderAdmission {
  readonly pluginId: string;
  readonly provider: ProviderAdapter;
  release(): void;
}

type AcquireProvider = () => ProviderAdmission | undefined;

interface ProviderRegistration {
  readonly pluginId: string;
  readonly acquire: AcquireProvider;
}

export class ProviderRegistry {
  readonly #providers = new Map<string, ProviderRegistration>();

  register(providerId: string, pluginId: string, acquire: AcquireProvider): void {
    if (this.#providers.has(providerId)) {
      throw new Error(`Provider already registered: ${providerId}`);
    }

    this.#providers.set(providerId, { pluginId, acquire });
  }

  unregister(providerId: string, pluginId: string): void {
    const registration = this.#providers.get(providerId);

    if (registration?.pluginId === pluginId) {
      this.#providers.delete(providerId);
    }
  }

  acquire(providerId: string): ProviderAdmission | undefined {
    return this.#providers.get(providerId)?.acquire();
  }

  listProviderIds(): readonly string[] {
    return [...this.#providers.keys()];
  }
}
