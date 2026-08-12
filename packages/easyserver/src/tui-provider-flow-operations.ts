import type { OperationContext } from "@easyai101/easyserver-plugin-sdk";
import {
  createHostRuntime,
  resolveHostRuntimePaths,
  type HostRuntimePaths,
} from "./host-runtime.js";
import type { ProviderInteractiveSessionHandle } from "./provider-feature-operations.js";

export interface TuiProviderFlowRef {
  readonly providerId: string;
  readonly featureId: string;
  readonly flowId: string;
}

export type TuiProviderFlowOpener = (
  flow: TuiProviderFlowRef,
  context: OperationContext,
) => Promise<ProviderInteractiveSessionHandle>;

export function createDefaultTuiProviderFlowOpener(
  paths: HostRuntimePaths = resolveHostRuntimePaths(),
): TuiProviderFlowOpener {
  return async (flow, context) => {
    const runtime = await createHostRuntime({ paths });
    return runtime.providerFeatureOperations.openInteractiveFlow({
      ...flow,
      context,
    });
  };
}
