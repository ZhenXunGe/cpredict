import type { Hex } from "viem";
import {
  prepareSettlementEvidenceV1,
  SETTLEMENT_EVIDENCE_MEDIA_TYPE,
  ZERO_EVIDENCE_HASH,
} from "../../../offchain/sdk/src/index.js";

export interface CanonicalEvidenceUploadRequest {
  /** Upload these bytes verbatim; re-serialization changes the committed CID/hash. */
  canonicalBytes: Uint8Array;
  evidenceHash: Hex;
  expectedUri: `ipfs://${string}`;
  mediaType: typeof SETTLEMENT_EVIDENCE_MEDIA_TYPE;
}

export interface CanonicalEvidenceUploadResult {
  uri: string;
}

/** Deployment-owned boundary; this example repository does not provide an IPFS credential/client. */
export type CanonicalEvidenceUploader = (
  request: CanonicalEvidenceUploadRequest,
) => Promise<CanonicalEvidenceUploadResult>;

export async function evidenceHashForSettlement(
  input: {
    sourceUri: string;
    summary: string;
    observedAt?: string | Date | undefined;
  },
  uploader?: CanonicalEvidenceUploader | undefined,
): Promise<Hex> {
  const hasSource = input.sourceUri.trim().length !== 0;
  const hasSummary = input.summary.trim().length !== 0;
  if (!hasSource && !hasSummary) return ZERO_EVIDENCE_HASH;
  if (!hasSource || !hasSummary) {
    throw new RangeError(
      "evidence source URI and summary must be supplied together",
    );
  }
  if (uploader === undefined) {
    throw new Error("settlement evidence requires an injected IPFS uploader");
  }
  const prepared = prepareSettlementEvidenceV1({
    sourceUri: input.sourceUri,
    summary: input.summary,
    observedAt: input.observedAt ?? new Date(),
  });
  const uploaded = await uploader({
    canonicalBytes: prepared.canonicalBytes.slice(),
    evidenceHash: prepared.evidenceHash,
    expectedUri: prepared.evidenceUri,
    mediaType: SETTLEMENT_EVIDENCE_MEDIA_TYPE,
  });
  if (uploaded.uri !== prepared.evidenceUri) {
    throw new Error(
      "IPFS uploader returned a URI that does not match the canonical evidence bytes",
    );
  }
  return prepared.evidenceHash;
}
