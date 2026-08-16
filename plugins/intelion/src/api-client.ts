import {
  normalizedError,
  type ProviderOperationContext,
} from "@easyai101/easyserver-plugin-sdk";

export const INTELION_API_TOKEN_CREDENTIAL = "api-token";

export type IntelionFetch = typeof globalThis.fetch;

export class IntelionApiClient {
  readonly #baseUrl: URL;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: IntelionFetch,
  ) {
    this.#baseUrl = new URL(baseUrl);
  }

  getJson(
    path: string | URL,
    context: ProviderOperationContext,
    allowNotFound = false,
  ): Promise<unknown | undefined> {
    return this.#requestJson(
      this.url(path),
      context,
      { method: "GET" },
      allowNotFound,
      false,
    );
  }

  postJsonMutation(
    path: string | URL,
    body: unknown,
    context: ProviderOperationContext,
  ): Promise<unknown> {
    return this.#requestJson(
      this.url(path),
      context,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      false,
      true,
    );
  }

  url(path: string | URL): URL {
    const url = path instanceof URL ? new URL(path) : new URL(path, this.#baseUrl);
    if (url.origin !== this.#baseUrl.origin) {
      throw normalizedError(
        "plugin-failure",
        `Intelion API attempted cross-origin pagination to ${url.origin}`,
      );
    }
    return url;
  }

  async #requestJson(
    url: URL,
    context: ProviderOperationContext,
    init: RequestInit,
    allowNotFound: boolean,
    mutation: boolean,
  ): Promise<unknown | undefined> {
    if (context.signal.aborted) {
      throw normalizedError(
        "cancelled",
        "Intelion request was cancelled before dispatch",
      );
    }

    const token = await requireApiToken(context);
    if (context.signal.aborted) {
      throw normalizedError(
        "cancelled",
        "Intelion request was cancelled before dispatch",
      );
    }

    let response: Response;
    try {
      if (mutation) {
        context.markMutationDispatched();
      }
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Token ${token}`,
          Accept: "application/json",
          ...init.headers,
        },
        signal: context.signal,
      });
    } catch (error) {
      if (mutation) {
        throw normalizedError(
          "outcome-unknown",
          "Intelion mutation outcome is unknown after request dispatch",
          error,
        );
      }
      if (context.signal.aborted) {
        throw normalizedError(
          "cancelled",
          "Intelion request was cancelled before a response was received",
          error,
        );
      }
      throw normalizedError(
        "provider-unavailable",
        "Intelion request failed before a response was received",
        error,
      );
    }

    if (allowNotFound && response.status === 404) {
      return undefined;
    }
    if (mutation && response.status === 404) {
      throw normalizedError("not-found", "Intelion resource was not found");
    }
    if (response.status === 401) {
      throw normalizedError(
        "authentication",
        "Intelion rejected the configured API token",
      );
    }
    if (response.status === 403) {
      throw normalizedError(
        "unknown-provider-error",
        appendProviderDetail(
          "Intelion denied the requested operation",
          await readSafeIntelionErrorDetail(response, token),
        ),
      );
    }
    if (response.status === 409) {
      throw normalizedError(
        "conflict",
        appendProviderDetail(
          "Intelion rejected the operation as conflicting",
          await readSafeIntelionErrorDetail(response, token),
        ),
      );
    }
    if (response.status === 429) {
      throw normalizedError("rate-limited", "Intelion rate limit exceeded");
    }
    if (response.status >= 500) {
      throw normalizedError(
        mutation ? "outcome-unknown" : "provider-unavailable",
        mutation
          ? `Intelion mutation outcome is unknown after HTTP ${response.status}`
          : `Intelion returned HTTP ${response.status}`,
      );
    }
    if (!response.ok) {
      throw normalizedError(
        "unknown-provider-error",
        appendProviderDetail(
          `Intelion returned HTTP ${response.status}`,
          await readSafeIntelionErrorDetail(response, token),
        ),
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw normalizedError(
        mutation ? "outcome-unknown" : "plugin-failure",
        mutation
          ? "Intelion mutation succeeded but its response could not be reconciled"
          : "Intelion returned an invalid JSON response",
        error,
      );
    }
  }
}

const MAX_PROVIDER_ERROR_BODY_BYTES = 4_096;
const MAX_PROVIDER_ERROR_DETAIL_LENGTH = 240;

async function readSafeIntelionErrorDetail(
  response: Response,
  token: string,
): Promise<string | undefined> {
  const payload = await readBoundedJsonObject(response);
  if (payload === undefined) {
    return undefined;
  }

  for (const value of [payload.detail, payload.message, payload.error]) {
    const detail = safeDiagnosticText(value, token);
    if (detail !== undefined) {
      return detail;
    }
  }

  const nonFieldErrors = payload.non_field_errors;
  if (Array.isArray(nonFieldErrors)) {
    for (const value of nonFieldErrors) {
      const detail = safeDiagnosticText(value, token);
      if (detail !== undefined) {
        return detail;
      }
    }
  }

  for (const [field, value] of Object.entries(payload)) {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/u.test(field) || !Array.isArray(value)) {
      continue;
    }
    for (const item of value) {
      const detail = safeDiagnosticText(item, token);
      if (detail !== undefined) {
        return `${field}: ${detail}`;
      }
    }
  }
  return undefined;
}

async function readBoundedJsonObject(
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (contentType === undefined || !contentType.includes("application/json")) {
    return undefined;
  }

  const reader = response.body?.getReader();
  if (reader === undefined) {
    return undefined;
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_PROVIDER_ERROR_BODY_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function safeDiagnosticText(
  value: unknown,
  credential: string,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.replace(/\s+/gu, " ").trim();
  if (
    text.length === 0 ||
    text.includes(credential) ||
    /<\/?[a-z][^>]*>/iu.test(text) ||
    /-----BEGIN [^-]*PRIVATE KEY-----/iu.test(text) ||
    /\b(?:authorization|bearer|api[_ -]?key|token|password|secret|private[_ -]?key)\b\s*[:=]\s*\S+/iu.test(
      text,
    )
  ) {
    return undefined;
  }
  return text.length <= MAX_PROVIDER_ERROR_DETAIL_LENGTH
    ? text
    : `${text.slice(0, MAX_PROVIDER_ERROR_DETAIL_LENGTH - 3)}...`;
}

function appendProviderDetail(base: string, detail: string | undefined): string {
  return detail === undefined ? base : `${base}: ${detail}`;
}

async function requireApiToken(
  context: ProviderOperationContext,
): Promise<string> {
  const value = await context.resolveCredential(INTELION_API_TOKEN_CREDENTIAL);
  if (value === undefined || value.length === 0) {
    throw normalizedError(
      "authentication",
      `Intelion requires configured credential ${INTELION_API_TOKEN_CREDENTIAL}`,
    );
  }
  return value;
}
