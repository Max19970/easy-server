import {
  isNormalizedError,
  normalizedError,
  type NormalizedError,
  type NormalizedErrorCode,
} from "@easyai101/easyserver-plugin-sdk";

export const CONNECTION_FAILURE_CAUSES = [
  "ssh-public-key-rejected",
  "ssh-authentication-rejected",
  "ssh-host-identity-mismatch",
  "ssh-host-identity-changed-before-confirmation",
  "ssh-fingerprint-unavailable",
  "ssh-not-ready",
  "tcp-forwarding-forbidden",
  "remote-service-unavailable",
  "ssh-transport-closed",
  "local-openssh-unavailable",
  "unexpected-ssh-transport",
  "local-bind-conflict",
] as const;

export type ConnectionFailureCause = (typeof CONNECTION_FAILURE_CAUSES)[number];

export interface ConnectionFailureDetails {
  readonly cause: ConnectionFailureCause;
}

const details = new WeakMap<object, ConnectionFailureDetails>();

export function tagConnectionFailure<T>(
  error: T,
  cause: ConnectionFailureCause,
): T {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    details.set(error as object, { cause });
  }
  return error;
}

export function connectionFailureDetails(
  error: unknown,
): ConnectionFailureDetails | undefined {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    const direct = details.get(error as object);
    if (direct !== undefined) {
      return direct;
    }
    const serializedCause = (error as { readonly connectionCause?: unknown }).connectionCause;
    if (isConnectionFailureCause(serializedCause)) {
      return { cause: serializedCause };
    }
  }
  if (isNormalizedError(error) && error.cause !== undefined && error.cause !== error) {
    return connectionFailureDetails(error.cause);
  }
  return undefined;
}

export function isConnectionFailureCause(
  value: unknown,
): value is ConnectionFailureCause {
  return (
    typeof value === "string" &&
    (CONNECTION_FAILURE_CAUSES as readonly string[]).includes(value)
  );
}

export function normalizedConnectionError(
  code: NormalizedErrorCode,
  message: string,
  failureCause: ConnectionFailureCause,
  cause?: unknown,
): NormalizedError {
  return tagConnectionFailure(
    normalizedError(code, message, cause),
    failureCause,
  );
}

export function normalizedConnectionException(
  code: NormalizedErrorCode,
  message: string,
  failureCause: ConnectionFailureCause,
  cause?: unknown,
): Error & NormalizedError {
  return tagConnectionFailure(
    Object.assign(new Error(message), normalizedError(code, message, cause)),
    failureCause,
  );
}
