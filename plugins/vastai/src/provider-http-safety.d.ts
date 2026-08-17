export function readBoundedJsonObject(
  response: Response,
): Promise<Record<string, unknown> | undefined>;

export function safeDiagnosticText(
  value: unknown,
  credential: string,
): string | undefined;

export function appendProviderDetail(
  base: string,
  detail: string | undefined,
): string;
