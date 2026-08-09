import type { ProviderFeature } from "@easycompute/plugin-sdk";

export interface ProviderFeatureDescriptor {
  readonly pluginId: string;
  readonly providerId: string;
  readonly featureId: string;
  readonly displayName: string;
}

export interface ProviderFeatureAdmission extends ProviderFeatureDescriptor {
  readonly feature: ProviderFeature;
  release(): void;
}

type AcquireFeature = () => ProviderFeatureAdmission | undefined;

interface FeatureRegistration extends ProviderFeatureDescriptor {
  readonly acquire: AcquireFeature;
}

export class ProviderFeatureHost {
  readonly #features = new Map<string, FeatureRegistration>();

  register(
    descriptor: ProviderFeatureDescriptor,
    acquire: AcquireFeature,
  ): void {
    const key = featureKey(descriptor.providerId, descriptor.featureId);
    if (this.#features.has(key)) {
      throw new Error(
        `Provider Feature already registered: ${descriptor.providerId}/${descriptor.featureId}`,
      );
    }

    this.#features.set(key, { ...descriptor, acquire });
  }

  unregisterPlugin(pluginId: string): void {
    for (const [key, registration] of this.#features) {
      if (registration.pluginId === pluginId) {
        this.#features.delete(key);
      }
    }
  }

  acquire(
    providerId: string,
    featureId: string,
  ): ProviderFeatureAdmission | undefined {
    return this.#features.get(featureKey(providerId, featureId))?.acquire();
  }

  listFeatures(): readonly ProviderFeatureDescriptor[] {
    return [...this.#features.values()].map(
      ({ acquire: _acquire, ...descriptor }) => descriptor,
    );
  }
}

function featureKey(providerId: string, featureId: string): string {
  return `${providerId}\u0000${featureId}`;
}
