import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  evidenceUriFromHash,
  settlementEvidenceHash,
  ZERO_EVIDENCE_HASH,
  type CpredictClient,
  type TransactionResult,
} from "../../../offchain/sdk/src/index.js";
import { ClaimsPanel } from "../src/ClaimsPanel.js";
import { CreateMarketPanel } from "../src/CreateMarketPanel.js";
import { MarketLifecyclePanel } from "../src/MarketLifecyclePanel.js";
import { MarketplacePanel } from "../src/MarketplacePanel.js";
import { PrimaryPaymentPanel } from "../src/PrimaryPaymentPanel.js";
import {
  evidenceHashForSettlement,
  type CanonicalEvidenceUploadRequest,
} from "../src/settlementEvidence.js";

const address = "0x00000000000000000000000000000000000000A1";
const result: TransactionResult = {
  hash: `0x${"12".repeat(32)}`,
  blockNumber: 1n,
  gasUsed: 1n,
};
const client = new Proxy(
  {},
  {
    get() {
      return vi.fn(async () => result);
    },
  },
) as Pick<
  CpredictClient,
  | "createMarket"
  | "resolve"
  | "creatorVoid"
  | "voidAfterDeadline"
  | "setMarketplaceApproval"
  | "createListing"
  | "fillListing"
  | "cancelListing"
  | "claimWinner"
  | "claimEarlyBird"
  | "refund"
  | "claimTimeoutBonus"
  | "approvePaymentToken"
  | "buyWithPermit2"
>;

describe("React protocol call examples", () => {
  it("renders immutable creation review and creator settlement warning", () => {
    const createHtml = renderToStaticMarkup(
      <CreateMarketPanel
        client={client}
        paymentToken={address}
        creationFee={1_000_000n}
        draft={{
          factory: address,
          userSalt: `0x${"34".repeat(32)}`,
          params: {
            rulesHash: `0x${"56".repeat(32)}`,
            metadataURI: "ipfs://market",
            resolutionSourceHash: `0x${"78".repeat(32)}`,
            resolutionSourceURI: "https://example.invalid/result",
            outcomeCount: 2,
            closeAt: 1_900_000_000n,
            earlyBirdStart: 1_800_000_000n,
            creatorTreasury: address,
            deploymentMode: 0,
            featureFlags: 0n,
            creatorRakeBps: 100,
            creatorC2CFeeBps: 0,
            perUserPrimaryCap: 100_000_000n,
            marketPrimaryCap: 500_000_000n,
            minimumPrimaryUnits: 1_000_000n,
            minimumC2CUnits: 1_000_000n,
            creatorBond: 10_000_000n,
          },
        }}
      />,
    );
    const lifecycleHtml = renderToStaticMarkup(
      <MarketLifecyclePanel
        client={client}
        vault={address}
        outcomeCount={2}
        creatorMode
      />,
    );
    expect(createHtml).toContain("Create immutable market");
    expect(createHtml).toContain("Approve exact creation fee and bond");
    expect(lifecycleHtml).toContain("unilateral and irreversible");
    expect(lifecycleHtml).toContain("Evidence source URI");
    expect(lifecycleHtml).toContain("exact canonical UTF-8 bytes");
    expect(lifecycleHtml).toContain("does not upload evidence");
    expect(lifecycleHtml).toContain("Permissionless timeout void");
  });

  it("uploads exact canonical evidence bytes before returning the onchain hash", async () => {
    const uploader = vi.fn(async (request: CanonicalEvidenceUploadRequest) => ({
      uri: request.expectedUri,
    }));
    const evidenceHash = await evidenceHashForSettlement(
      {
        sourceUri: "https://example.invalid/result",
        summary: "Official result confirmed outcome 1.",
        observedAt: "2026-08-08T12:34:56.000Z",
      },
      uploader,
    );
    const request = uploader.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    if (request === undefined)
      throw new Error("uploader did not receive canonical evidence");
    expect(settlementEvidenceHash(request.canonicalBytes)).toBe(evidenceHash);
    expect(request.expectedUri).toBe(evidenceUriFromHash(evidenceHash));

    await expect(
      evidenceHashForSettlement({ sourceUri: "", summary: "" }),
    ).resolves.toBe(ZERO_EVIDENCE_HASH);
    await expect(
      evidenceHashForSettlement(
        {
          sourceUri: "https://example.invalid/result",
          summary: "Official result confirmed outcome 1.",
          observedAt: "2026-08-08T12:34:56.000Z",
        },
        async () => ({ uri: "ipfs://wrong" }),
      ),
    ).rejects.toThrow("does not match");
  });

  it("renders separate marketplace approval and all four claim paths", () => {
    const marketHtml = renderToStaticMarkup(
      <MarketplacePanel
        client={client}
        paymentToken={address}
        vault={address}
        marketplace={address}
      />,
    );
    const claimsHtml = renderToStaticMarkup(
      <ClaimsPanel client={client} vault={address} owner={address} />,
    );
    expect(marketHtml).toContain("Step 1: approve share escrow");
    expect(marketHtml).toContain("Approve exact USDC for fill");
    expect(marketHtml).toContain("Cancel listing");
    expect(claimsHtml).toContain("Claim winnings");
    expect(claimsHtml).toContain("Refund principal");
    expect(claimsHtml).toContain("Claim timeout bond bonus");
  });

  it("renders both bounded primary-payment authorization paths", () => {
    const html = renderToStaticMarkup(
      <PrimaryPaymentPanel
        client={client}
        signer={{
          async signTypedData() {
            return `0x${"12".repeat(65)}`;
          },
        }}
        chainId={84532n}
        permit2={address}
        paymentToken={address}
        owner={address}
        vault={address}
        outcomeId={0n}
        units={1_000_000n}
        permitNonce={1n}
      />,
    );
    expect(html).toContain("Approve exact USDC to market");
    expect(html).toContain("Approve exact USDC to Permit2");
    expect(html).toContain("Sign Permit2 witness and buy");
  });
});
