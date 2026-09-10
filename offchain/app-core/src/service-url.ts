import { secureUrl } from "./contracts.js";

/** Only the two declared Compose metadata services may use internal HTTP. */
export function parseMetadataServiceUrl(
  value: string,
  containerMode: boolean,
): string {
  const secure = secureUrl.safeParse(value);
  if (secure.success) return secure.data;
  const url = new URL(value);
  if (
    containerMode &&
    url.protocol === "http:" &&
    ["metadata", "metadata-usdc"].includes(url.hostname) &&
    url.port === "8793" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === "/"
  )
    return value;
  throw new TypeError(
    "metadata URL must use HTTPS, loopback, or the declared Compose metadata endpoint",
  );
}
