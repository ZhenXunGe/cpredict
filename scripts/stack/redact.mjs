export function redactStackLogs(text, secret) {
  let output = String(text);
  for (const [key, value] of Object.entries(secret)) {
    if (typeof value !== "string" || value.length < 1) continue;
    output = output.replaceAll(value, `[REDACTED:${key}]`);
    try {
      const encoded = encodeURIComponent(value);
      if (encoded !== value) output = output.replaceAll(encoded, `[REDACTED:${key}:URL_ENCODED]`);
    } catch {
      // The strict env parser accepts ordinary UTF-8 strings; an encoding failure
      // must not prevent exact-value redaction.
    }
  }
  return output;
}
