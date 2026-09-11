import { describe, expect, it } from "vitest";
import { maintenanceDatabaseUrl } from "../src/maintenance-database.js";

describe("maintenance database transport", () => {
  it("requires explicit container mode for the isolated Compose database", () => {
    for (const authority of ["postgres", "postgres:5432"]) {
      const url = `postgresql://fixture:fixture@${authority}/cpredict_indexer?sslmode=disable`;
      expect(maintenanceDatabaseUrl(url, true)).toBe(url);
      expect(() => maintenanceDatabaseUrl(url)).toThrowError(
        expect.objectContaining({ code: "database_tls_required" }),
      );
    }
  });

  it("does not permit a different host, port, protocol or driver override in container mode", () => {
    for (const url of [
      "postgresql://database.example/test?sslmode=disable",
      "postgresql://127.0.0.1/test?sslmode=disable",
      "postgresql://postgres.example/test?sslmode=disable",
      "postgresql://postgres:6432/test?sslmode=disable",
      "https://postgres/test?sslmode=disable",
      "postgresql://postgres/test",
      "postgresql://postgres/test?sslmode=require",
      "postgresql://postgres/test?sslmode=disable&host=database.example",
      "postgresql://postgres/test?sslmode=disable&sslmode=require",
      "postgresql://postgres/test?sslmode=disable#ignored",
    ])
      expect(() => maintenanceDatabaseUrl(url, true)).toThrowError(
        expect.objectContaining({
          code: "maintenance_container_database_required",
        }),
      );
  });

  it("preserves local and remote TLS maintenance without the container flag", () => {
    for (const url of [
      "postgresql://localhost/test",
      "postgres://127.0.0.1:5433/test?sslmode=disable",
      "postgresql://[::1]/test",
      "postgresql://database.example/test?sslmode=require",
      "postgresql://database.example/test?sslmode=verify-full",
    ])
      expect(maintenanceDatabaseUrl(url)).toBe(url);
    expect(() =>
      maintenanceDatabaseUrl(
        "postgresql://database.example/test?sslmode=disable",
      ),
    ).toThrowError(expect.objectContaining({ code: "database_tls_required" }));
  });

  it("rejects malformed connection details without including them in the error", () => {
    const invalid = "fixture-private-connection-details";
    expect(() => maintenanceDatabaseUrl(invalid)).toThrowError(
      expect.objectContaining({ code: "database_tls_required" }),
    );
    try {
      maintenanceDatabaseUrl(invalid);
    } catch (error) {
      expect(String(error)).not.toContain(invalid);
    }
  });
});
