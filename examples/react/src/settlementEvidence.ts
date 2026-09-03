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

export const EVIDENCE_BOTH_OR_NEITHER_MESSAGE =
  "证据来源 URI 和摘要必须同时填写，或同时留空。";
export const EVIDENCE_UPLOAD_UNAVAILABLE_MESSAGE =
  "当前部署未接入证据上传。请清空证据来源和摘要后再结算；结算不需要填写证据。";
export const EVIDENCE_URI_MISMATCH_MESSAGE =
  "证据上传返回的 URI 与规范文档不一致，未提交结算。";

export function settlementEvidenceBlockReason(
  sourceUri: string,
  summary: string,
  hasUploader: boolean,
): string | null {
  const hasSource = sourceUri.trim().length !== 0;
  const hasSummary = summary.trim().length !== 0;
  if (!hasSource && !hasSummary) return null;
  if (!hasSource || !hasSummary) return EVIDENCE_BOTH_OR_NEITHER_MESSAGE;
  if (!hasUploader) return EVIDENCE_UPLOAD_UNAVAILABLE_MESSAGE;
  return null;
}

export async function evidenceHashForSettlement(
  input: {
    sourceUri: string;
    summary: string;
    observedAt?: string | Date | undefined;
  },
  uploader?: CanonicalEvidenceUploader | undefined,
): Promise<Hex> {
  const blockReason = settlementEvidenceBlockReason(
    input.sourceUri,
    input.summary,
    uploader !== undefined,
  );
  if (blockReason !== null) {
    throw blockReason === EVIDENCE_BOTH_OR_NEITHER_MESSAGE
      ? new RangeError(blockReason)
      : new Error(blockReason);
  }
  if (input.sourceUri.trim().length === 0) return ZERO_EVIDENCE_HASH;
  if (uploader === undefined) {
    throw new Error(EVIDENCE_UPLOAD_UNAVAILABLE_MESSAGE);
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
    throw new Error(EVIDENCE_URI_MISMATCH_MESSAGE);
  }
  return prepared.evidenceHash;
}
