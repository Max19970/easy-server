import {
  normalizedError,
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

  url(path: string): URL {
    return new URL(path, this.baseUrl);
  }

  async #requestJson(
    path: string | URL,
    context: ProviderOperationContext,
    init: RequestInit,
    allowNotFound = false,
  ): Promise<unknown | undefined> {
    const apiKey = await requireApiKey(context);
    let response: Response;
    try {
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
        "provider-unavailable",
        `Vast.ai returned HTTP ${response.status}`,
      );
    }
    if (!response.ok) {
      throw normalizedError(
        "unknown-provider-error",
        `Vast.ai returned HTTP ${response.status}`,
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw normalizedError(
        "plugin-failure",
        "Vast.ai returned an invalid JSON response",
        error,
      );
    }
  }
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
