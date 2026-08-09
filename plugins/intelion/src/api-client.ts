import {
  normalizedError,
  type ProviderOperationContext,
} from "@easycompute/plugin-sdk";

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
    if (response.status === 401 || response.status === 403) {
      throw normalizedError(
        "authentication",
        "Intelion rejected the configured API token",
      );
    }
    if (response.status === 409) {
      throw normalizedError("conflict", "Intelion rejected the operation as conflicting");
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
        `Intelion returned HTTP ${response.status}`,
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
