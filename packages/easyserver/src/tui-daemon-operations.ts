import { randomUUID } from "node:crypto";
import type { HostTrustRequiredError } from "@easyai101/easyserver-plugin-sdk";
import { retryWithHostTrust } from "./connect-command.js";
import {
  ManagedDaemonOperations,
  type ManagedDaemonShutdownImpact,
  type ManagedDaemonStartResult,
  type ManagedDaemonStopResult,
} from "./managed-daemon-operations.js";
import {
  type CreatePersistentSessionRequest,
  type LivePersistentConnectionSession,
} from "./local-daemon.js";
import { resolveHostRuntimePaths, type HostRuntimePaths } from "./host-runtime.js";
import { OpenSshAccessAdapter } from "./ssh-access-adapter.js";

export interface TuiPersistentSessionRequest extends CreatePersistentSessionRequest {
  readonly idempotencyKey: string;
}

export interface TuiDaemonInteraction {
  readonly confirmHostTrust?: (
    trust: HostTrustRequiredError,
    signal: AbortSignal,
  ) => Promise<boolean>;
}

export interface TuiDaemonOperations {
  start(): Promise<ManagedDaemonStartResult>;
  shutdownImpact(): Promise<ManagedDaemonShutdownImpact | undefined>;
  stop(): Promise<ManagedDaemonStopResult>;
  createSession(
    request: TuiPersistentSessionRequest,
    interaction?: TuiDaemonInteraction,
  ): Promise<LivePersistentConnectionSession>;
  closeSession(id: string): Promise<void>;
}

export function newTuiPersistentSessionIdempotencyKey(): string {
  return `tui:${randomUUID()}`;
}

export function createTuiDaemonOperations(
  managed: ManagedDaemonOperations,
  sshAdapter: Pick<OpenSshAccessAdapter, "enrollHostKey">,
): TuiDaemonOperations {
  return {
    start: () => managed.start(),
    shutdownImpact: () => managed.shutdownImpact(),
    stop: () => managed.stop(),
    async createSession(request, interaction = {}) {
      const client = await managed.requireClient();
      return retryWithHostTrust(
        () => client.createSession(request),
        {
          sshAdapter,
          ...(interaction.confirmHostTrust === undefined
            ? {}
            : { confirmHostTrust: interaction.confirmHostTrust }),
        },
      );
    },
    async closeSession(id) {
      await (await managed.requireClient()).closeSession(id);
    },
  };
}

export function createDefaultTuiDaemonOperations(
  paths: HostRuntimePaths = resolveHostRuntimePaths(),
): TuiDaemonOperations {
  return createTuiDaemonOperations(
    new ManagedDaemonOperations({
      daemonFile: paths.daemonFile,
      entrypoint: process.argv[1],
      env: process.env,
    }),
    new OpenSshAccessAdapter(),
  );
}
