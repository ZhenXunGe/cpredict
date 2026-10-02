import { test, expect, type Page } from "playwright/test";
import {
  A,
  H,
  appAccount,
} from "../../../../offchain/app-core/test/fixtures.js";
import { computePnl } from "../../../../offchain/app-core/src/pnl.js";
const snapshot = {
  environment: appAccount.environment,
  deploymentId: appAccount.deploymentId,
  version: 1,
  epoch: "1",
  blockNumber: "105",
  blockHash: H(105),
  timestamp: "1789142400",
  coverageStart: "1",
  complete: true,
  status: "active",
};
const fact = (id: string) => ({
  id,
  kind: "early-bird-claimed",
  blockNumber: "105",
  blockHash: H(105),
  transactionHash: H(205),
  transactionIndex: 0,
  logIndex: 1,
  factIndex: 0,
  timestamp: "1789142400",
  market: A(101),
  owner: appAccount.address,
  counterparty: null,
  outcomeId: null,
  listingId: null,
  units: null,
  amount: "32000",
  extra: {},
});
async function setup(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:(?:4206|4207)\/)/, (r) =>
    r.abort(),
  );
  const state = { received: false, missing: true, reads: 0 };
  await page.route("**/v1/operations**", (r) =>
    r.fulfill({ json: { items: [] } }),
  );
  await page.route("**/v2/entitlements/**", (r) =>
    r.fulfill({ json: { items: [], nextCursor: null, snapshot } }),
  );
  await page.route("**/v2/pnl/**", (r) =>
    r.fulfill({
      json: {
        pnl: computePnl(appAccount.address, [], { coverageComplete: true }),
        snapshot,
      },
    }),
  );
  await page.route("**/v1/automatic-claims**", (r) =>
    r.fulfill({
      json: {
        enabled: true,
        reason: "waiting_for_entitlement",
        updatedAt: null,
        transactions: [],
        nextCursor: null,
      },
    }),
  );
  await page.route("**/v1/claim-receipts**", (r) => {
    state.reads++;
    return r.fulfill({
      json: {
        items: state.received
          ? ["manual", "automatic", "direct"].map((source, i) => ({
              fact: fact(String(i)),
              source,
              marketQuestion: "到账核验市场",
              actualGasCostWei: source === "direct" ? null : "7000000000000",
              gasPayment: source === "direct" ? "unknown" : "sponsored",
            }))
          : [],
        nextCursor: null,
        snapshot,
      },
    });
  });
  await page.route("**/v1/sponsored-gas**", (r) =>
    r.fulfill({
      json: {
        scope: "current-environment",
        currency: "ETH",
        knownActualWei: "7000000000000",
        totalActualWei: state.missing ? null : "7000000000000",
        missingCount: state.missing ? 1 : 0,
        pendingCount: 0,
        shared: {
          knownActualWei: "1000000000000",
          totalActualWei: "1000000000000",
          missingCount: 0,
        },
        items: [
          {
            id: "gas1",
            kind: "claim-early-bird",
            source: "user-operation",
            transactionHash: H(205),
            timestamp: "2026-09-11T16:00:00.000Z",
            state: "reverted",
            actualGasCostWei: "7000000000000",
          },
        ],
        nextCursor: null,
        snapshot,
      },
    }),
  );
  return { state, errors };
}
test("unified receipts refresh and actual personal fees remain separate from public fees", async ({
  page,
}) => {
  const { state, errors } = await setup(page);
  await page.clock.install();
  await page.goto(
    "/test/browser/fixture.html?entitlements-test=1&orderbook-test=1&account-evidence-test=1#/ctusd-test/entitlements",
  );
  await expect(
    page.getByRole("heading", { name: "持仓与权益", exact: true }),
  ).toBeVisible();
  const receipts = page.getByRole("region", { name: "已到账记录" });
  // Sections expose their accessible name as regions.
  await expect(receipts).toContainText("暂无已到账记录");
  const gas = page.getByRole("region", { name: "平台代付 Gas" });
  await expect(gas).toContainText("0.000007 ETH");
  await expect(gas).toContainText("部分费用待核验（1 项）");
  await gas.getByText("查看个人代付明细", { exact: true }).click();
  await expect(gas).toContainText("交易执行失败");
  state.received = true;
  state.missing = false;
  await page.clock.fastForward(5100);
  await expect(receipts.getByRole("row")).toHaveCount(4);
  for (const label of ["手动领取", "自动领取", "链上直接领取"])
    await expect(
      receipts.getByRole("cell", { name: label, exact: true }),
    ).toHaveCount(1);
  await expect(gas.getByText(/部分费用待核验/)).toHaveCount(0);
  await expect(
    receipts.getByRole("link", { name: "查看", exact: true }).first(),
  ).toHaveAttribute("href", new RegExp(H(205)));
  await page.screenshot({
    path: `/tmp/cpredict-evidence-${test.info().project.name}.png`,
    fullPage: true,
  });
  expect(await page.locator("vite-error-overlay").count()).toBe(0);
  expect(errors).toEqual([]);
  expect(
    await page
      .locator("body")
      .evaluate((e) => e.scrollWidth <= window.innerWidth),
  ).toBe(true);
});

test("receipt pages do not duplicate and hidden pages pause periodic refresh", async ({
  page,
}) => {
  const { state, errors } = await setup(page);
  await page.clock.install();
  await page.route("**/v1/claim-receipts**", (r) => {
    state.reads++;
    const second = new URL(r.request().url()).searchParams.has("cursor");
    return r.fulfill({
      json: {
        items: Array.from({ length: second ? 1 : 10 }, (_, i) => ({
          fact: fact(String(second ? 10 : i)),
          source: "direct",
          marketQuestion: second ? "第二页到账" : "第一页到账",
          actualGasCostWei: null,
          gasPayment: "unknown",
        })),
        nextCursor: second ? null : "page2",
        snapshot,
      },
    });
  });
  await page.goto(
    "/test/browser/fixture.html?entitlements-test=1&orderbook-test=1&account-evidence-test=1#/ctusd-test/entitlements",
  );
  const region = page.getByRole("region", { name: "已到账记录" });
  await expect(region.getByRole("row")).toHaveCount(11);
  await region.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(region).toContainText("第二页到账");
  await expect(region.getByRole("row")).toHaveCount(2);
  await region.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(region.getByRole("row")).toHaveCount(11);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const reads = state.reads;
  await page.clock.fastForward(15000);
  expect(state.reads).toBe(reads);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(5100);
  await expect.poll(() => state.reads).toBeGreaterThan(reads);
  expect(errors).toEqual([]);
});
