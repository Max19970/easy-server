import { randomUUID } from "node:crypto";
import {
  parseProviderInstanceList,
  parseProviderInstanceSnapshot,
  PluginContractError,
  type AvailableAction,
  type InstanceState,
  type OperationContext,
  type ProviderInstanceSnapshot,
  type ProviderRawState,
} from "@easycompute/plugin-sdk";
import { ProviderRegistry } from "./provider-registry.js";
import {
  JsonStateStore,
  type EasyComputeState,
  type InstanceBinding,
} from "./state-store.js";

export interface ComputeInstance {
  readonly id: string;
  readonly providerId: string;
  readonly providerExternalId: string;
  readonly name?: string;
  readonly state: InstanceState;
  readonly rawState: ProviderRawState;
  readonly availableActions: readonly AvailableAction[];
}

export class ComputeManager {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly stateStore: JsonStateStore,
  ) {}

  async listInstances(context: OperationContext): Promise<readonly ComputeInstance[]> {
    const state = await this.stateStore.read();
    let bindings = [...(state.instances ?? [])];
    const instances: ComputeInstance[] = [];

    for (const providerId of this.registry.listProviderIds()) {
      const admission = this.registry.acquire(providerId);
      if (admission === undefined) {
        continue;
      }

      try {
        const snapshots = parseProviderInstanceList(
          await admission.provider.listInstances(context),
          admission.capabilities,
        );
        const existing = new Map(
          bindings
            .filter((binding) => binding.providerId === providerId)
            .map((binding) => [binding.providerExternalId, binding]),
        );
        const currentBindings: InstanceBinding[] = [];

        for (const snapshot of snapshots) {
          const binding =
            existing.get(snapshot.providerExternalId) ??
            newBinding(providerId, snapshot.providerExternalId);
          currentBindings.push(binding);
          instances.push(toComputeInstance(binding, snapshot));
        }

        bindings = [
          ...bindings.filter((binding) => binding.providerId !== providerId),
          ...currentBindings,
        ];
      } finally {
        admission.release();
      }
    }

    if (!sameBindings(state.instances ?? [], bindings)) {
      await this.stateStore.write({ ...state, instances: bindings });
    }

    return instances;
  }

  async inspectInstance(
    id: string,
    context: OperationContext,
  ): Promise<ComputeInstance | undefined> {
    const state = await this.stateStore.read();
    const binding = state.instances?.find((candidate) => candidate.id === id);
    if (binding === undefined) {
      return undefined;
    }

    const admission = this.registry.acquire(binding.providerId);
    if (admission === undefined) {
      throw new Error(`Provider is not available: ${binding.providerId}`);
    }

    try {
      const value = await admission.provider.getInstance(
        binding.providerExternalId,
        context,
      );

      if (value === undefined) {
        await this.removeBinding(state, binding.id);
        return undefined;
      }

      const snapshot = parseProviderInstanceSnapshot(value, admission.capabilities);
      if (snapshot.providerExternalId !== binding.providerExternalId) {
        throw new PluginContractError(
          `provider getInstance returned ${snapshot.providerExternalId} for requested ${binding.providerExternalId}`,
        );
      }

      return toComputeInstance(binding, snapshot);
    } finally {
      admission.release();
    }
  }

  private async removeBinding(state: EasyComputeState, id: string): Promise<void> {
    const instances = (state.instances ?? []).filter((binding) => binding.id !== id);
    await this.stateStore.write({ ...state, instances });
  }
}

function newBinding(providerId: string, providerExternalId: string): InstanceBinding {
  return {
    id: `instance:${randomUUID()}`,
    providerId,
    providerExternalId,
  };
}

function toComputeInstance(
  binding: InstanceBinding,
  snapshot: ProviderInstanceSnapshot,
): ComputeInstance {
  const instance: ComputeInstance = {
    id: binding.id,
    providerId: binding.providerId,
    providerExternalId: binding.providerExternalId,
    state: snapshot.state,
    rawState: snapshot.rawState,
    availableActions: snapshot.availableActions,
  };

  return snapshot.name === undefined ? instance : { ...instance, name: snapshot.name };
}

function sameBindings(
  left: readonly InstanceBinding[],
  right: readonly InstanceBinding[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (binding, index) =>
        binding.id === right[index]?.id &&
        binding.providerId === right[index]?.providerId &&
        binding.providerExternalId === right[index]?.providerExternalId,
    )
  );
}
