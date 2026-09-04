import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  evidenceUriFromHash,
  settlementEvidenceHash,
  ZERO_EVIDENCE_HASH,
  type CpredictClient,
  type ListingSnapshot,
  type TransactionResult,
} from "../../../offchain/sdk/src/index.js";
import { ClaimsPanel } from "../src/ClaimsPanel.js";
import { CreateMarketPanel } from "../src/CreateMarketPanel.js";
import {
  creatorSettlementPhase,
  MarketLifecyclePanel,
  outcomeOptionLabel,
} from "../src/MarketLifecyclePanel.js";
import {
  MarketplacePanel,
  quoteFillFromChain,
} from "../src/MarketplacePanel.js";
import { PrimaryPaymentPanel } from "../src/PrimaryPaymentPanel.js";
import {
  EVIDENCE_UPLOAD_UNAVAILABLE_MESSAGE,
  EVIDENCE_URI_MISMATCH_MESSAGE,
  evidenceHashForSettlement,
  settlementEvidenceBlockReason,
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
  | "readListing"
  | "createListing"
  | "fillListing"
  | "cancelListing"
  | "claimWinner"
  | "claimEarlyBird"
  | "refund"
  | "claimTimeoutBonus"
  | "settleBond"
  | "claimBondFor"
  | "approvePaymentToken"
  | "buy"
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
            eventStartsAt: 0n,
            outcomeDeadlineAt: 1_900_000_000n,
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
    expect(createHtml).toContain(
      "Authorize exact payment and create immutable market",
    );
    expect(createHtml).toContain("Approve exact creation fee and bond");
    expect(lifecycleHtml).toContain("单方面且不可逆");
    expect(lifecycleHtml).toContain("证据来源 URI");
    expect(lifecycleHtml).toContain("证据为可选项");
    expect(lifecycleHtml).toContain("未开启证据上传");
    expect(lifecycleHtml).toContain("选填，可留空");
    expect(lifecycleHtml).toContain("超时作废");
    expect(lifecycleHtml).toContain("结果 1");
    expect(lifecycleHtml).toContain("结果 2");
    expect(lifecycleHtml).toContain("不要填写数字编号");
    expect(lifecycleHtml).toContain("<select");
    expect(lifecycleHtml).not.toMatch(/获胜结果\s*<input/);
  });

  it("labels winning outcomes by name instead of a raw 0-index", () => {
    const html = renderToStaticMarkup(
      <MarketLifecyclePanel
        client={client}
        vault={address}
        outcomeCount={2}
        creatorMode
        outcomeLabels={["是", "否"]}
        closeAt={1_900_000_000n}
        resolutionDeadline={1_900_000_900n}
        observedAt={1_900_000_100n}
        marketState={0}
      />,
    );
    expect(html).toContain(">是<");
    expect(html).toContain(">否<");
    expect(html).toContain("剩余 13 分钟");
    expect(html).toContain("指定获胜结果");
    expect(html).not.toContain('value="0" inputMode="numeric"');
  });

  it("blocks creator resolve after the settlement window and points to timeout void", () => {
    const html = renderToStaticMarkup(
      <MarketLifecyclePanel
        client={client}
        vault={address}
        outcomeCount={2}
        creatorMode
        outcomeLabels={["王者赢", "对手赢"]}
        closeAt={1_900_000_000n}
        resolutionDeadline={1_900_000_900n}
        observedAt={1_900_000_900n}
        marketState={0}
      />,
    );
    expect(html).toContain("创建者结算窗口已过");
    expect(html).toContain("本金退还给所有人");
    expect(html).toContain(">王者赢<");
    expect(html).toMatch(
      /type="submit"[^>]*disabled|disabled[^>]*type="submit"/,
    );
    expect(html).toMatch(/超时作废<\/button>/);
  });

  it("points creators to bond release after a non-timeout terminal", () => {
    const html = renderToStaticMarkup(
      <MarketLifecyclePanel
        client={client}
        vault={address}
        outcomeCount={2}
        creatorMode
        closeAt={1_900_000_000n}
        resolutionDeadline={1_900_000_900n}
        observedAt={1_900_000_200n}
        marketState={1}
      />,
    );
    expect(html).toContain("该市场已终局");
    expect(html).toContain("释放并领取押金");
    expect(html).toContain("仅超时弃盘且有参与者时押金罚没");
  });

  it("maps settlement phases from closeAt and resolutionDeadline", () => {
    expect(
      creatorSettlementPhase({
        marketState: 0,
        observedAt: 99n,
        closeAt: 100n,
        resolutionDeadline: 200n,
      }),
    ).toBe("before-close");
    expect(
      creatorSettlementPhase({
        marketState: 0,
        observedAt: 100n,
        closeAt: 100n,
        resolutionDeadline: 200n,
      }),
    ).toBe("creator-window");
    expect(
      creatorSettlementPhase({
        marketState: 0,
        observedAt: 200n,
        closeAt: 100n,
        resolutionDeadline: 200n,
      }),
    ).toBe("window-expired");
    expect(
      creatorSettlementPhase({
        marketState: 2,
        observedAt: 150n,
        closeAt: 100n,
        resolutionDeadline: 200n,
      }),
    ).toBe("terminal");
    expect(creatorSettlementPhase({})).toBeNull();
    expect(outcomeOptionLabel(0, ["是", "否"])).toBe("是");
    expect(outcomeOptionLabel(1, undefined)).toBe("结果 2");
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
      evidenceHashForSettlement({
        sourceUri: "https://example.invalid/result",
        summary: "Official result confirmed outcome 1.",
      }),
    ).rejects.toThrow(EVIDENCE_UPLOAD_UNAVAILABLE_MESSAGE);
    await expect(
      evidenceHashForSettlement(
        {
          sourceUri: "https://example.invalid/result",
          summary: "Official result confirmed outcome 1.",
          observedAt: "2026-08-08T12:34:56.000Z",
        },
        async () => ({ uri: "ipfs://wrong" }),
      ),
    ).rejects.toThrow(EVIDENCE_URI_MISMATCH_MESSAGE);
    expect(
      settlementEvidenceBlockReason(
        "https://example.invalid/result",
        "Official result confirmed outcome 1.",
        false,
      ),
    ).toBe(EVIDENCE_UPLOAD_UNAVAILABLE_MESSAGE);
    expect(settlementEvidenceBlockReason("", "", false)).toBeNull();
  });

  it("explains optional evidence upload when an uploader is injected", () => {
    const html = renderToStaticMarkup(
      <MarketLifecyclePanel
        client={client}
        vault={address}
        outcomeCount={2}
        creatorMode
        uploadCanonicalEvidence={async (request) => ({
          uri: request.expectedUri,
        })}
      />,
    );
    expect(html).toContain("证据为可选项");
    expect(html).toContain("都填写时会生成规范文档并上传");
    expect(html).not.toContain("未开启证据上传");
  });

  it("renders separate marketplace approval and all four claim paths", () => {
    const listingId = `0x${"ab".repeat(32)}` as const;
    const marketHtml = renderToStaticMarkup(
      <MarketplacePanel
        client={client}
        paymentToken={address}
        vault={address}
        marketplace={address}
        observedAt={1_800_000_000n}
        closeAt={1_900_000_000n}
        selectedListing={{
          listingId,
          vault: address,
          outcomeId: 0n,
          remainingUnits: 2_000_000n,
          unitPrice: 900_000n,
          expiresAt: 1_900_000_000n,
        }}
      />,
    );
    const claimsHtml = renderToStaticMarkup(
      <ClaimsPanel
        client={client}
        vault={address}
        owner={address}
        bondEscrow={address}
        creator={address}
      />,
    );
    expect(marketHtml).toContain("单独授权份额托管");
    expect(marketHtml).toContain("授权份额托管并创建挂单");
    expect(marketHtml).toContain(listingId);
    expect(marketHtml).toContain("固定价");
    expect(marketHtml).toContain("0.9 USDC");
    expect(marketHtml).toContain("合计：1.8 USDC");
    expect(marketHtml).toContain("精确授权 USDC 用于成交");
    expect(marketHtml).toContain("精确授权 USDC 并成交");
    expect(marketHtml).toContain("取消所选挂单");
    expect(claimsHtml).toContain("Claim winnings");
    expect(claimsHtml).toContain("Refund principal");
    expect(claimsHtml).toContain("Claim timeout bond bonus");
    expect(claimsHtml).toContain("Release creator bond");
    expect(claimsHtml).toContain("Claim creator bond");
    expect(claimsHtml).toContain("Timeout abandonment with participants");
  });

  it("quotes only an active, unexpired onchain listing with enough remaining shares", () => {
    const listing: ListingSnapshot = {
      listingId: `0x${"ab".repeat(32)}`,
      vault: address,
      seller: address,
      remainingUnits: 2_000_000n,
      unitPrice: 900_000n,
      expiresAt: 1_900_000_000n,
      outcomeId: 0n,
      active: true,
      observedAt: 1_800_000_000n,
    };
    expect(quoteFillFromChain(listing, address, 1_000_000n)).toBe(900_000n);
    expect(() =>
      quoteFillFromChain({ ...listing, active: false }, address, 1_000_000n),
    ).toThrow("已失效");
    expect(() =>
      quoteFillFromChain(
        { ...listing, observedAt: listing.expiresAt },
        address,
        1_000_000n,
      ),
    ).toThrow("已过期");
    expect(() => quoteFillFromChain(listing, address, 3_000_000n)).toThrow(
      "超过",
    );
    expect(
      quoteFillFromChain(
        { ...listing, unitPrice: 1_200_000n },
        address,
        1_000_000n,
      ),
    ).toBe(1_200_000n);
    expect(() =>
      quoteFillFromChain(
        { ...listing, vault: "0x00000000000000000000000000000000000000b2" },
        address,
        1_000_000n,
      ),
    ).toThrow("不属于当前市场");
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
        chainId={421614n}
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
    expect(html).toContain("Authorize exact USDC and buy");
    expect(html).toContain("Approve exact USDC to Permit2");
    expect(html).toContain(
      "Authorize exact USDC, sign Permit2 witness and buy",
    );
  });
});
