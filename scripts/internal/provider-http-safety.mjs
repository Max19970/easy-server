const MAX_PROVIDER_ERROR_BODY_BYTES = 4_096;
const MAX_PROVIDER_ERROR_DETAIL_LENGTH = 240;

export async function readBoundedJsonObject(response) {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (contentType === undefined || !contentType.includes("application/json")) {
    return undefined;
  }

  const reader = response.body?.getReader();
  if (reader === undefined) {
    return undefined;
  }

  const chunks = [];
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
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

export function safeDiagnosticText(value, credential) {
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

export function appendProviderDetail(base, detail) {
  return detail === undefined ? base : `${base}: ${detail}`;
}
