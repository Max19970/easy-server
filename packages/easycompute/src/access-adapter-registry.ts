import type { AccessAdapter, AccessMethod } from "@easycompute/plugin-sdk";
import type { ProviderAdmission } from "./provider-registry.js";

export class AccessAdapterRegistry {
  readonly #builtIns = new Map<string, AccessAdapter>();

  registerBuiltIn(adapter: AccessAdapter): void {
    if (this.#builtIns.has(adapter.kind)) {
      throw new Error(`Access Adapter already registered: ${adapter.kind}`);
    }

    this.#builtIns.set(adapter.kind, adapter);
  }

  resolveTcpForward(
    method: AccessMethod,
    providerAdmission: ProviderAdmission,
  ): AccessAdapter | undefined {
    if (method.mode !== "tcp-forward") {
      return undefined;
    }

    return (
      providerAdmission.accessAdapters.find(
        (adapter) => adapter.kind === method.kind,
      ) ?? this.#builtIns.get(method.kind)
    );
  }
}
