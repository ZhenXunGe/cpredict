import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSettlementEvidenceDocumentV1,
  canonicalSettlementEvidenceBytes,
  evidenceCidV1Raw,
  evidenceUriFromHash,
  prepareSettlementEvidenceV1,
  settlementEvidenceHash,
  ZERO_EVIDENCE_HASH,
  type SettlementEvidenceDocumentV1,
  type SettlementEvidenceInputV1,
} from "../src/evidence.js";

const emptySha256 =
  "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as const;

describe("canonical settlement evidence", () => {
  it("normalizes a fixed V1 shape and hashes the exact UTF-8 JSON bytes", () => {
    const prepared = prepareSettlementEvidenceV1({
      sourceUri: " https://EXAMPLE.com/evidence ",
      summary: " Re\u0301sultat confirmed ",
      observedAt: "2026-08-08T12:34:56Z",
    });
    const expectedJson =
      '{"version":1,"sourceUri":"https://example.com/evidence","summary":"Résultat confirmed","observedAt":"2026-08-08T12:34:56.000Z"}';
    expect(prepared.document).toEqual({
      version: 1,
      sourceUri: "https://example.com/evidence",
      summary: "Résultat confirmed",
      observedAt: "2026-08-08T12:34:56.000Z",
    });
    expect(prepared.canonicalJson).toBe(expectedJson);
    expect(new TextDecoder().decode(prepared.canonicalBytes)).toBe(
      expectedJson,
    );
    expect(prepared.evidenceHash).toBe(
      `0x${createHash("sha256").update(prepared.canonicalBytes).digest("hex")}`,
    );
    expect(prepared.evidenceUri).toBe(`ipfs://${prepared.cid}`);
  });

  it("uses the standard CIDv1 raw/sha2-256 encoding and maps zero to absent", () => {
    expect(evidenceCidV1Raw(emptySha256)).toBe(
      "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
    );
    expect(evidenceUriFromHash(ZERO_EVIDENCE_HASH)).toBeNull();
    expect(evidenceUriFromHash(emptySha256)).toBe(
      "ipfs://bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
    );
  });

  it("rejects non-canonical documents, unsafe URIs, unsupported fields and byte overflow", () => {
    const credentialUri = new URL("https://example.com/evidence");
    credentialUri.username = ["u", "ser"].join("");
    credentialUri.password = ["pa", "ss"].join("");
    const input = {
      sourceUri: "https://example.com/evidence",
      summary: "confirmed",
      observedAt: "2026-08-08T12:34:56.000Z",
    } satisfies SettlementEvidenceInputV1;
    expect(() =>
      buildSettlementEvidenceDocumentV1({ ...input, extra: true } as never),
    ).toThrow("unsupported fields");
    expect(() =>
      buildSettlementEvidenceDocumentV1({
        ...input,
        sourceUri: credentialUri.toString(),
      }),
    ).toThrow("credentials");
    expect(() =>
      buildSettlementEvidenceDocumentV1({
        ...input,
        summary: "界".repeat(683),
      }),
    ).toThrow("2048 UTF-8 bytes");
    expect(() =>
      buildSettlementEvidenceDocumentV1({ ...input, summary: "\ud800" }),
    ).toThrow("unpaired surrogate");
    expect(() =>
      canonicalSettlementEvidenceBytes({
        version: 1,
        sourceUri: "https://EXAMPLE.com/evidence",
        summary: "confirmed",
        observedAt: "2026-08-08T12:34:56.000Z",
      } satisfies SettlementEvidenceDocumentV1),
    ).toThrow("not canonical");
    expect(() => settlementEvidenceHash(new Uint8Array())).toThrow(
      "within [1, 4096]",
    );
  });
});
