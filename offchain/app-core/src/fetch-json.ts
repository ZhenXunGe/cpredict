import { AppError } from "./contracts.js";

/** No automatic retry, raw upstream error forwarding, or unbounded response body. */
export async function fetchJson(
  url: string,
  init: RequestInit = {},
  maximumBytes = 1_048_576,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AppError("upstream_unavailable", 503);
  }
  return readJsonResponse(response, maximumBytes);
}

export async function readJsonResponse(
  response: Response,
  maximumBytes = 1_048_576,
): Promise<unknown> {
  if (!response.ok || !response.body)
    throw new AppError("upstream_rejected", 503);
  const reader = response.body.getReader();
  let size = 0;
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes)
        throw new AppError("upstream_response_too_large", 503);
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError("upstream_invalid_response", 503);
  } finally {
    reader.releaseLock();
  }
}
