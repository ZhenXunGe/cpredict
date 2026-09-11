import { AppError } from "../../app-core/src/contracts.js";

/** Container maintenance uses the same isolated PostgreSQL service as the stack. */
export function maintenanceDatabaseUrl(
  value: string,
  containerMode = false,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("database_tls_required");
  }
  const postgres = ["postgres:", "postgresql:"].includes(url.protocol);
  if (containerMode) {
    const query = [...url.searchParams];
    if (
      postgres &&
      url.hostname === "postgres" &&
      (!url.port || url.port === "5432") &&
      !url.hash &&
      query.length === 1 &&
      query[0]?.[0] === "sslmode" &&
      query[0]?.[1] === "disable"
    )
      return value;
    throw new AppError("maintenance_container_database_required");
  }
  if (
    postgres &&
    (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      ["require", "verify-full"].includes(
        url.searchParams.get("sslmode") ?? "",
      ))
  )
    return value;
  throw new AppError("database_tls_required");
}
