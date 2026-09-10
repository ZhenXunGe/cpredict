import { describe, expect, it } from "vitest";
import { parseMetadataServiceUrl } from "../src/service-url.js";

describe("metadata transport boundary", () => {
  it("accepts the two declared internal services only in container mode", () => {
    for (const host of ["metadata", "metadata-usdc"]) {
      const url = `http://${host}:8793`;
      expect(parseMetadataServiceUrl(url, true)).toBe(url);
      expect(() => parseMetadataServiceUrl(url, false)).toThrow();
    }
  });
  it("does not make arbitrary HTTP hosts, ports or credential URLs trusted", () => {
    for (const url of [
      "http://metadata:80",
      "http://example.com:8793",
      "http://metadata.evil:8793",
      "http://secret@metadata:8793",
      "http://metadata:8793?token=secret",
      "http://metadata:8793/admin",
      "http://postgres:5432",
    ]) {
      expect(() => parseMetadataServiceUrl(url, true)).toThrow();
    }
    expect(parseMetadataServiceUrl("https://metadata.example.com", false)).toBe(
      "https://metadata.example.com",
    );
    expect(parseMetadataServiceUrl("http://127.0.0.1:8793", false)).toBe(
      "http://127.0.0.1:8793",
    );
  });
});
