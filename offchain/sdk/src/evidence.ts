import { hexToBytes, sha256, type Hex } from "viem";

export const SETTLEMENT_EVIDENCE_VERSION = 1 as const;
export const SETTLEMENT_EVIDENCE_MEDIA_TYPE =
  "application/vnd.cpredict.settlement-evidence+json;version=1";
export const ZERO_EVIDENCE_HASH = `0x${"00".repeat(32)}` as Hex;

export interface SettlementEvidenceInputV1 {
  sourceUri: string;
  summary: string;
  observedAt: string | Date;
}

export interface SettlementEvidenceDocumentV1 {
  version: typeof SETTLEMENT_EVIDENCE_VERSION;
  sourceUri: string;
  summary: string;
  observedAt: string;
}

export interface PreparedSettlementEvidenceV1 {
  document: SettlementEvidenceDocumentV1;
  canonicalJson: string;
  canonicalBytes: Uint8Array;
  evidenceHash: Hex;
  cid: string;
  evidenceUri: `ipfs://${string}`;
}

const encoder = new TextEncoder();
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const CIDV1_BASE32 = /^b[a-z2-7]{10,}$/;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const MAX_SOURCE_URI_BYTES = 512;
const MAX_SUMMARY_BYTES = 2_048;
const MAX_DOCUMENT_BYTES = 4_096;

/** Builds the normalized, fixed-shape V1 document whose field order is consensus for this repo. */
export function buildSettlementEvidenceDocumentV1(
  input: SettlementEvidenceInputV1,
): SettlementEvidenceDocumentV1 {
  assertExactKeys(input, ["sourceUri", "summary", "observedAt"]);
  const sourceUri = normalizeSourceUri(input.sourceUri);
  const summary = normalizeText(input.summary, "summary");
  assertUtf8Bound(sourceUri, MAX_SOURCE_URI_BYTES, "sourceUri");
  assertUtf8Bound(summary, MAX_SUMMARY_BYTES, "summary");
  if (summary.length === 0) throw new RangeError("summary must not be empty");
  const observedAt = normalizeObservedAt(input.observedAt);
  return {
    version: SETTLEMENT_EVIDENCE_VERSION,
    sourceUri,
    summary,
    observedAt,
  };
}

/** Serializes only the exact V1 shape as UTF-8 JSON with no insignificant whitespace. */
export function canonicalSettlementEvidenceBytes(
  document: SettlementEvidenceDocumentV1,
): Uint8Array {
  assertExactKeys(document, ["version", "sourceUri", "summary", "observedAt"]);
  if (document.version !== SETTLEMENT_EVIDENCE_VERSION) {
    throw new RangeError("unsupported settlement evidence version");
  }
  const normalized = buildSettlementEvidenceDocumentV1({
    sourceUri: document.sourceUri,
    summary: document.summary,
    observedAt: document.observedAt,
  });
  if (
    normalized.sourceUri !== document.sourceUri ||
    normalized.summary !== document.summary ||
    normalized.observedAt !== document.observedAt
  ) {
    throw new TypeError("settlement evidence document is not canonical");
  }
  const bytes = encoder.encode(
    JSON.stringify({
      version: document.version,
      sourceUri: document.sourceUri,
      summary: document.summary,
      observedAt: document.observedAt,
    }),
  );
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new RangeError(
      `canonical evidence document exceeds ${MAX_DOCUMENT_BYTES} UTF-8 bytes`,
    );
  }
  return bytes;
}

/** SHA-256 commitment used as the opaque onchain bytes32 evidenceHash. */
export function settlementEvidenceHash(canonicalBytes: Uint8Array): Hex {
  if (
    canonicalBytes.byteLength === 0 ||
    canonicalBytes.byteLength > MAX_DOCUMENT_BYTES
  ) {
    throw new RangeError(
      `canonical evidence bytes must be within [1, ${MAX_DOCUMENT_BYTES}]`,
    );
  }
  return sha256(canonicalBytes);
}

/** Reconstructs a CIDv1 raw/sha2-256 CID from its 32-byte digest. */
export function evidenceCidV1Raw(evidenceHash: Hex): string {
  const normalized = normalizeEvidenceHash(evidenceHash);
  const digest = hexToBytes(normalized);
  // CID version 1, multicodec raw (0x55), multihash sha2-256 (0x12), digest length 32.
  const cidBytes = new Uint8Array(4 + digest.byteLength);
  cidBytes.set([0x01, 0x55, 0x12, 0x20]);
  cidBytes.set(digest, 4);
  return `b${base32(cidBytes)}`;
}

/** Zero means absent; every non-zero hash has exactly one repository-defined IPFS URI. */
export function evidenceUriFromHash(
  evidenceHash: Hex,
): `ipfs://${string}` | null {
  const normalized = normalizeEvidenceHash(evidenceHash);
  return normalized === ZERO_EVIDENCE_HASH
    ? null
    : `ipfs://${evidenceCidV1Raw(normalized)}`;
}

export function prepareSettlementEvidenceV1(
  input: SettlementEvidenceInputV1,
): PreparedSettlementEvidenceV1 {
  const document = buildSettlementEvidenceDocumentV1(input);
  const canonicalBytes = canonicalSettlementEvidenceBytes(document);
  const evidenceHash = settlementEvidenceHash(canonicalBytes);
  const cid = evidenceCidV1Raw(evidenceHash);
  return {
    document,
    canonicalJson: new TextDecoder().decode(canonicalBytes),
    canonicalBytes,
    evidenceHash,
    cid,
    evidenceUri: `ipfs://${cid}`,
  };
}

export function normalizeEvidenceHash(value: Hex): Hex {
  if (typeof value !== "string" || !BYTES32.test(value)) {
    throw new TypeError("evidenceHash must be exactly 32 bytes");
  }
  return value.toLowerCase() as Hex;
}

function normalizeSourceUri(value: string): string {
  const normalized = normalizeText(value, "sourceUri");
  if (normalized.length === 0)
    throw new RangeError("sourceUri must not be empty");
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new TypeError("sourceUri must be an absolute URI");
  }
  if (url.protocol !== "https:" && url.protocol !== "ipfs:") {
    throw new TypeError("sourceUri must use https: or ipfs:");
  }
  if (url.username !== "" || url.password !== "") {
    throw new TypeError("sourceUri must not contain credentials");
  }
  if (url.protocol === "ipfs:" && !CIDV1_BASE32.test(url.hostname)) {
    throw new TypeError(
      "ipfs sourceUri must use a lowercase base32 CIDv1 host",
    );
  }
  return url.href.normalize("NFC");
}

function normalizeObservedAt(value: string | Date): string {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new TypeError("observedAt must be a valid timestamp");
  return date.toISOString();
}

function normalizeText(value: string, field: string): string {
  if (typeof value !== "string")
    throw new TypeError(`${field} must be a string`);
  if (hasUnpairedSurrogate(value))
    throw new TypeError(`${field} contains an unpaired surrogate`);
  return value.trim().normalize("NFC");
}

function assertUtf8Bound(value: string, maximum: number, field: string): void {
  if (encoder.encode(value).byteLength > maximum) {
    throw new RangeError(`${field} exceeds ${maximum} UTF-8 bytes`);
  }
}

function assertExactKeys(value: object, expected: readonly string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("settlement evidence must be an object");
  }
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    keys.length !== wanted.length ||
    keys.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError("settlement evidence contains unsupported fields");
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)
        return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function base32(bytes: Uint8Array): string {
  let output = "";
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET.charAt((accumulator >>> bits) & 31);
    }
  }
  if (bits > 0)
    output += BASE32_ALPHABET.charAt((accumulator << (5 - bits)) & 31);
  return output;
}
