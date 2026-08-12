import { spawn, type ChildProcess } from "node:child_process";
import { acquireFilesystemLock } from "./filesystem-lock.js";
import {
  LocalDaemonClient,
  readLocalDaemonDescriptor,
  type DaemonShutdownSummary,
  type LocalDaemonDescriptor,
  type PersistentConnectionSession,
} from "./local-daemon.js";
import type { EndpointIntentStatus } from "./endpoint-intent-service.js";

export type ManagedDaemonState =
  | { readonly status: "running"; readonly descriptor: LocalDaemonDescriptor }
  | { readonly status: "stopped" }
  | {
      readonly status: "stale";
      readonly descriptor?: LocalDaemonDescriptor;
      readonly reason: string;
    };

export interface ManagedDaemonStartResult {
  readonly alreadyRunning: boolean;
  readonly descriptor: LocalDaemonDescriptor;
}

export type ManagedDaemonStopResult =
  | { readonly status: "already-stopped" }
  | { readonly status: "stale"; readonly reason: string }
  | {
      readonly status: "stopped";
      readonly summary: DaemonShutdownSummary;
    };

export interface ManagedDaemonShutdownImpact {
  readonly liveSessions: number;
  readonly activeEndpointIntents: number;
}

export interface ManagedDaemonOperationsOptions {
  readonly daemonFile: string;
  readonly entrypoint?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly startTimeoutMs?: number;
}

export class ManagedDaemonOperations {
  readonly #daemonFile: string;
  readonly #entrypoint?: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #startTimeoutMs: number;

  constructor(options: ManagedDaemonOperationsOptions) {
    this.#daemonFile = options.daemonFile;
    this.#entrypoint = options.entrypoint;
    this.#env = options.env ?? process.env;
    this.#startTimeoutMs = options.startTimeoutMs ?? configuredStartTimeout(this.#env);
  }

  async inspect(): Promise<ManagedDaemonState> {
    let descriptor: LocalDaemonDescriptor | undefined;
    try {
      descriptor = await readLocalDaemonDescriptor(this.#daemonFile);
    } catch {
      return { status: "stale", reason: "descriptor is invalid" };
    }
    if (descriptor === undefined) {
      return { status: "stopped" };
    }

    try {
      await new LocalDaemonClient(descriptor.address, descriptor.authToken).ping();
      return { status: "running", descriptor };
    } catch {
      return {
        status: "stale",
        descriptor,
        reason: "authenticated health check failed",
      };
    }
  }

  async requireClient(): Promise<LocalDaemonClient> {
    const state = await this.inspect();
    if (state.status === "running") {
      return new LocalDaemonClient(state.descriptor.address, state.descriptor.authToken);
    }
    if (state.status === "stale") {
      throw new Error(`EasyServer daemon is unreachable: ${state.reason}`);
    }
    throw new Error("EasyServer daemon is not running");
  }

  async start(): Promise<ManagedDaemonStartResult> {
    const lock = await acquireFilesystemLock(`${this.#daemonFile}.managed.lock`, {
      timeoutMs: 35_000,
    });
    try {
      const current = await this.inspect();
      if (current.status === "running") {
        return { alreadyRunning: true, descriptor: current.descriptor };
      }
      if (this.#entrypoint === undefined || this.#entrypoint.length === 0) {
        throw new Error("Cannot determine the EasyServer CLI entrypoint");
      }

      const child = spawn(process.execPath, [this.#entrypoint, "daemon", "run"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: this.#env,
      });
      let spawnError: Error | undefined;
      child.once("error", (error) => {
        spawnError = error;
      });
      child.unref();

      try {
        const deadline = Date.now() + this.#startTimeoutMs;
        while (Date.now() < deadline) {
          if (spawnError !== undefined) {
            throw spawnError;
          }
          const state = await this.inspect();
          if (state.status === "running") {
            return { alreadyRunning: false, descriptor: state.descriptor };
          }
          if (child.exitCode !== null) {
            throw new Error(
              `EasyServer daemon exited during startup with code ${child.exitCode}`,
            );
          }
          await delay(25);
        }

        const finalState = await this.inspect();
        if (finalState.status === "running") {
          return { alreadyRunning: false, descriptor: finalState.descriptor };
        }
        throw new Error("Timed out waiting for EasyServer daemon startup");
      } catch (error) {
        await terminateChild(child);
        throw error;
      }
    } finally {
      await lock.release();
    }
  }

  async shutdownImpact(): Promise<ManagedDaemonShutdownImpact | undefined> {
    const state = await this.inspect();
    if (state.status !== "running") {
      return undefined;
    }
    const client = new LocalDaemonClient(
      state.descriptor.address,
      state.descriptor.authToken,
    );
    const [sessions, intents] = await Promise.all([
      client.listSessions(),
      client.listEndpointIntents(),
    ]);
    return {
      liveSessions: sessions.filter((session) => session.state === "live").length,
      activeEndpointIntents: intents.filter(
        (intent) => intent.state === "live" || intent.state === "starting",
      ).length,
    };
  }

  async stop(): Promise<ManagedDaemonStopResult> {
    const lock = await acquireFilesystemLock(`${this.#daemonFile}.managed.lock`, {
      timeoutMs: 35_000,
    });
    try {
      const state = await this.inspect();
      if (state.status === "stopped") {
        return { status: "already-stopped" };
      }
      if (state.status === "stale") {
        return { status: "stale", reason: state.reason };
      }

      const client = new LocalDaemonClient(
        state.descriptor.address,
        state.descriptor.authToken,
      );
      const summary = await client.requestShutdown();
      await this.#waitForStop(state.descriptor);
      return { status: "stopped", summary };
    } finally {
      await lock.release();
    }
  }

  async listSessions(): Promise<readonly PersistentConnectionSession[]> {
    return (await this.requireClient()).listSessions();
  }

  async listEndpointIntents(): Promise<readonly EndpointIntentStatus[]> {
    return (await this.requireClient()).listEndpointIntents();
  }

  async #waitForStop(expected: LocalDaemonDescriptor): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      let current: LocalDaemonDescriptor | undefined;
      try {
        current = await readLocalDaemonDescriptor(this.#daemonFile);
      } catch {
        current = undefined;
      }
      if (
        current === undefined ||
        current.authToken !== expected.authToken ||
        current.address.port !== expected.address.port
      ) {
        return;
      }
      await delay(25);
    }
    throw new Error("Timed out waiting for EasyServer daemon shutdown");
  }
}

function configuredStartTimeout(env: NodeJS.ProcessEnv): number {
  const configured = env.EASYSERVER_DAEMON_START_TIMEOUT_MS;
  if (configured === undefined) {
    return 30_000;
  }
  const value = Number(configured);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("EASYSERVER_DAEMON_START_TIMEOUT_MS must be a positive integer");
  }
  return value;
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await Promise.race([exited, delay(2_000)]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
