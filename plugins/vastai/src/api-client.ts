import {
  normalizedError,
  type NormalizedErrorCode,
  type ProviderOperationContext,
} from "@easycompute/plugin-sdk";

export const VAST_API_KEY_CREDENTIAL = "api-key";

export type VastFetch = typeof globalThis.fetch;

export class VastApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: VastFetch,
  ) {}

  getJson(
    path: string | URL,
    context: ProviderOperationContext,
    allowNotFound = false,
  ): Promise<unknown | undefined> {
    return this.#requestJson(path, context, { method: "GET" }, allowNotFound);
  }

  postJson(
    path: string | URL,
    body: unknown,
    context: ProviderOperationContext,
  ): Promise<unknown> {
    return this.#requestJson(path, context, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  putJsonMutation(
    path: string | URL,
    body: unknown,
    context: ProviderOperationContext,
    badRequestCode?: NormalizedErrorCode,
  ): Promise<unknown> {
    return this.#requestJson(
      path,
      context,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      false,
      true,
      badRequestCode,
    );
  }

  putMutation(
    path: string | URL,
    context: ProviderOperationContext,
    badRequestCode?: NormalizedErrorCode,
  ): Promise<unknown> {
    return this.#requestJson(
      path,
      context,
      { method: "PUT" },
      false,
      true,
      badRequestCode,
    );
  }

  deleteMutation(
    path: string | URL,
    context: ProviderOperationContext,
    badRequestCode?: NormalizedErrorCode,
  ): Promise<unknown> {
    return this.#requestJson(
      path,
      context,
      { method: "DELETE" },
      false,
      true,
      badRequestCode,
    );
  }

  url(path: string): URL {
    return new URL(path, this.baseUrl);
  }

  async #requestJson(
    path: string | URL,
    context: ProviderOperationContext,
    init: RequestInit,
    allowNotFound = false,
    mutation = false,
    badRequestCode?: NormalizedErrorCode,
  ): Promise<unknown | undefined> {
    if (context.signal.aborted) {
      throw normalizedError(
        "cancelled",
        "Vast.ai request was cancelled before dispatch",
      );
    }

    let apiKey: string;
    try {
      apiKey = await requireApiKey(context);
    } catch (error) {
      if (context.signal.aborted) {
        throw normalizedError(
          "cancelled",
          "Vast.ai request was cancelled before dispatch",
          error,
        );
      }
      throw error;
    }
    if (context.signal.aborted) {
      throw normalizedError(
        "cancelled",
        "Vast.ai request was cancelled before dispatch",
      );
    }

    let response: Response;
    try {
      if (mutation) {
        context.markMutationDispatched();
      }
      response = await this.fetchImpl(
        path instanceof URL ? path : this.url(path),
        {
          ...init,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
            ...init.headers,
          },
          signal: context.signal,
        },
      );
    } catch (error) {
      if (mutation) {
        throw normalizedError(
          "outcome-unknown",
          "Vast.ai mutation outcome is unknown after request dispatch",
          error,
        );
      }
      if (context.signal.aborted) {
        throw normalizedError(
          "cancelled",
          "Vast.ai request was cancelled before a response was received",
          error,
        );
      }
      throw normalizedError(
        "provider-unavailable",
        "Vast.ai request failed before a response was received",
        error,
      );
    }

    if (allowNotFound && response.status === 404) {
      return undefined;
    }
    if (mutation && response.status === 404) {
      throw normalizedError("not-found", "Vast.ai resource was not found");
    }
    if (mutation && response.status === 400 && badRequestCode !== undefined) {
      throw normalizedError(
        badRequestCode,
        appendProviderDetail(
          `Vast.ai rejected the mutation with HTTP ${response.status}`,
          await readSafeVastErrorDetail(response, apiKey),
        ),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw normalizedError(
        "authentication",
        "Vast.ai rejected the configured API key",
      );
    }
    if (response.status === 429) {
      throw normalizedError("rate-limited", "Vast.ai rate limit exceeded");
    }
    if (response.status >= 500) {
      throw normalizedError(
        mutation ? "outcome-unknown" : "provider-unavailable",
        mutation
          ? `Vast.ai mutation outcome is unknown after HTTP ${response.status}`
          : `Vast.ai returned HTTP ${response.status}`,
      );
    }
    if (!response.ok) {
      throw normalizedError(
        "unknown-provider-error",
        appendProviderDetail(
          `Vast.ai returned HTTP ${response.status}`,
          await readSafeVastErrorDetail(response, apiKey),
        ),
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw normalizedError(
        mutation ? "outcome-unknown" : "plugin-failure",
        mutation
          ? "Vast.ai mutation outcome is unknown because the success response was unreadable"
          : "Vast.ai returned an invalid JSON response",
        error,
      );
    }
  }
}

const MAX_PROVIDER_ERROR_BODY_BYTES = 4_096;
const MAX_PROVIDER_ERROR_DETAIL_LENGTH = 240;

async function readSafeVastErrorDetail(
  response: Response,
  apiKey: string,
): Promise<string | undefined> {
  const payload = await readBoundedJsonObject(response);
  if (payload === undefined) {
    return undefined;
  }
  return safeDiagnosticText(payload.msg ?? payload.message, apiKey);
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

async function requireApiKey(context: ProviderOperationContext): Promise<string> {
  const value = await context.resolveCredential(VAST_API_KEY_CREDENTIAL);
  if (value === undefined || value.length === 0) {
    throw normalizedError(
      "authentication",
      `Vast.ai requires configured credential ${VAST_API_KEY_CREDENTIAL}`,
    );
  }
  return value;
}
