import { test, expect, type Page } from "playwright/test";
import { A, appAccount } from "../../../../offchain/app-core/test/fixtures.js";
async function setup(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:(?:4206|4207)\/)/, (r) =>
    r.abort(),
  );
  let enabled = true;
  const changes: boolean[] = [];
  await page.route("**/v1/automatic-claims**", async (r) => {
    if (r.request().method() === "POST") {
      enabled = r.request().postDataJSON().enabled;
      changes.push(enabled);
    }
    await r.fulfill({
      json: {
        enabled,
        reason: "waiting_for_entitlement",
        updatedAt: null,
        transactions: [],
        nextCursor: null,
      },
    });
  });
  await page.route("**/v2/orders?**", async (r) => {
    const multipleOwnerBids = new URL(page.url()).searchParams.has(
        "multiple-owner-bids",
      ),
      premiumAsk = new URL(page.url()).searchParams.has("premium-ask"),
      requestUrl = new URL(r.request().url()),
      items = [
        {
          id: "1",
          market: A(101),
          owner: A(99),
          outcomeId: "0",
          side: "bid",
          unitPrice: "500000",
          expiresAt: "2000000000",
          autoMatch: false,
          remainingUnits: "2000000",
          lockedPayment: "1000000",
          active: true,
        },
        {
          id: "2",
          market: A(101),
          owner: appAccount.address,
          outcomeId: "1",
          side: "bid",
          unitPrice: "750000",
          expiresAt: "2000000000",
          autoMatch: true,
          remainingUnits: "4000000",
          lockedPayment: "3000000",
          active: true,
        },
        ...(multipleOwnerBids
          ? [
              {
                id: "3",
                market: A(102),
                owner: appAccount.address,
                outcomeId: "0",
                side: "bid",
                unitPrice: "400000",
                expiresAt: "2000003600",
                autoMatch: false,
                remainingUnits: "5000000",
                lockedPayment: "2000000",
                active: true,
              },
            ]
          : []),
        ...(premiumAsk
          ? [
              {
                id: "4",
                market: A(101),
                owner: A(98),
                outcomeId: "0",
                side: "ask",
                unitPrice: "1200000",
                expiresAt: "2000000000",
                autoMatch: true,
                remainingUnits: "1000000",
                lockedPayment: "0",
                active: true,
              },
            ]
          : []),
      ].filter(
        (order) =>
          (!requestUrl.searchParams.get("owner") ||
            order.owner === requestUrl.searchParams.get("owner")) &&
          (!requestUrl.searchParams.get("market") ||
            order.market === requestUrl.searchParams.get("market")),
      );
    await r.fulfill({
      json: {
        items,
        totalLockedPayment: items
          .reduce((total, order) => total + BigInt(order.lockedPayment), 0n)
          .toString(),
        nextCursor: null,
      },
    });
  });
  return { changes, errors };
}
test("funded bid defaults matching on; confirmation includes outcome, exact reserve and expiry", async ({
  page,
}) => {
  const f = await setup(page);
  await page.goto(
    `/test/browser/fixture.html?orderbook-test=1#/ctusd-test/markets/${A(101)}`,
  );
  const panel = page.locator("section").filter({
    has: page.getByRole("heading", { name: "求购 / 挂卖", exact: true }),
  });
  await expect(
    panel.getByRole("checkbox", { name: "自动撮合（默认开启）" }),
  ).toBeChecked();
  await panel.getByLabel("份数", { exact: true }).fill("2");
  await panel.getByLabel("每份价格（ctUSD）", { exact: true }).fill("0.5");
  await panel.getByRole("button", { name: "核对求购", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("冻结金额", { exact: true })).toBeVisible();
  await expect(dialog.getByText("24小时", { exact: true })).toBeVisible();
  await page.screenshot({
    path: `/tmp/cpredict-orders-${test.info().project.name}.png`,
    fullPage: true,
  });
  expect(f.errors).toEqual([]);
});
test("sell order shows insufficient balance before opening confirmation", async ({
  page,
}) => {
  const f = await setup(page);
  await page.goto(
    `/test/browser/fixture.html?orderbook-test=1&no-shares=1#/ctusd-test/markets/${A(101)}`,
  );
  const panel = page.locator("section").filter({
    has: page.getByRole("heading", { name: "求购 / 挂卖", exact: true }),
  });
  await panel.getByLabel("订单类型").selectOption("ask");
  await expect(
    panel.getByText("可用份额：0 份", { exact: true }),
  ).toBeVisible();
  await panel.getByLabel("份数", { exact: true }).fill("1");
  await expect(panel).toContainText(
    "余额不足：当前结果可用 0 份，请调整挂卖数量。",
  );
  await expect(
    panel.getByRole("button", { name: "核对挂卖", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({
    path: `/tmp/cpredict-insufficient-shares-${test.info().project.name}.png`,
    fullPage: true,
  });
  expect(f.errors).toEqual([]);
});
test("selling into a bid checks outcome shares before opening confirmation", async ({
  page,
}) => {
  const f = await setup(page);
  await page.goto(
    `/test/browser/fixture.html?orderbook-test=1&no-shares=1#/ctusd-test/markets/${A(101)}`,
  );
  const panel = page.locator("section").filter({
    has: page.getByRole("heading", { name: "求购 / 挂卖", exact: true }),
  });
  await panel.getByRole("button", { name: "卖给此求购单" }).click();
  await expect(panel).toContainText(
    "余额不足：当前结果可用 0 份，请调整接单数量。",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(f.errors).toEqual([]);
});
test("sell order with enough shares reaches confirmation", async ({ page }) => {
  const f = await setup(page);
  await page.goto(
    `/test/browser/fixture.html?orderbook-test=1#/ctusd-test/markets/${A(101)}`,
  );
  const panel = page.locator("section").filter({
    has: page.getByRole("heading", { name: "求购 / 挂卖", exact: true }),
  });
  await panel.getByLabel("订单类型").selectOption("ask");
  await expect(
    panel.getByText("可用份额：1000 份", { exact: true }),
  ).toBeVisible();
  await panel.getByLabel("份数", { exact: true }).fill("1");
  await panel.getByRole("button", { name: "核对挂卖", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("挂卖");
  await expect(dialog.getByText("份数", { exact: true })).toBeVisible();
  expect(f.errors).toEqual([]);
});
test("pre-close premium asks warn sellers, order viewers and buyers", async ({
  page,
}) => {
  const f = await setup(page);
  await page.goto(
    `/test/browser/fixture.html?orderbook-test=1&premium-ask=1#/ctusd-test/markets/${A(101)}`,
  );
  const panel = page.locator("section").filter({
    has: page.getByRole("heading", { name: "求购 / 挂卖", exact: true }),
  });
  await panel.getByLabel("订单类型").selectOption("ask");
  await panel.getByLabel("每份价格（ctUSD）", { exact: true }).fill("1.2");
  await expect(
    panel.getByText(/当前挂卖价格高于一级购买每份 1 ctUSD/),
  ).toBeVisible();
  await expect(
    panel.getByText(/此挂卖单高于一级购买每份 1 ctUSD/),
  ).toBeVisible();
  await panel.getByRole("button", { name: "购买此挂卖单" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "高于一级购买每份 1 ctUSD",
  );
  expect(f.errors).toEqual([]);
});
test("claim preference is default on, persists opt-out, and explains market-level timeout", async ({
  page,
}) => {
  const f = await setup(page);
  await page.goto(
    "/test/browser/fixture.html?orderbook-test=1#/ctusd-test/entitlements",
  );
  const checkbox = page.getByRole("checkbox", {
    name: "自动领取权益（默认开启）",
  });
  await expect(checkbox).toBeChecked();
  await expect(checkbox).toBeEnabled();
  await expect(
    page.getByText("关闭你的开关不影响其他权益人触发。", { exact: false }),
  ).toBeVisible();
  await checkbox.uncheck();
  await expect.poll(() => f.changes).toEqual([false]);
  await page.reload();
  await expect(checkbox).not.toBeChecked();
  expect(f.errors).toEqual([]);
});
test("automatic claim audit distinguishes payouts, asset returns and maintenance", async ({
  page,
}) => {
  const f = await setup(page);
  await page.route("**/v1/automatic-claims**", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        reason: "received",
        updatedAt: new Date().toISOString(),
        transactions: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            kind: `settle-bond:${A(101).toLowerCase()}`,
            state: "confirmed",
            tx_hash: "0x" + "1".repeat(64),
            market: A(101),
            amount: null,
            created_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            kind: "return-listing:1",
            effect: "asset-return",
            state: "confirmed",
            tx_hash: "0x" + "2".repeat(64),
            market: A(101),
            amount: null,
            created_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            context: {
              market: A(101),
              marketQuestion: "主播今晚直播间是否会超过30万人？",
              outcomeId: "1",
              outcomeLabel: "是",
              amount: null,
              units: "5000000",
            },
          },
          {
            id: "33333333-3333-4333-8333-333333333333",
            kind: "future-operation",
            state: "confirmed",
            tx_hash: "0x" + "3".repeat(64),
            market: null,
            amount: null,
            created_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
          },
          {
            id: "44444444-4444-4444-8444-444444444444",
            kind: "winner",
            effect: "payout",
            state: "confirmed",
            tx_hash: "0x" + "4".repeat(64),
            market: A(101),
            amount: "9632000",
            created_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            context: {
              market: A(101),
              marketQuestion: "主播今晚直播间是否会超过30万人？",
              outcomeId: "1",
              outcomeLabel: "是",
              amount: "9632000",
              units: "5000000",
            },
          },
          {
            id: "55555555-5555-4555-8555-555555555555",
            kind: "fees",
            effect: "payout",
            state: "broadcasting",
            tx_hash: "0x" + "5".repeat(64),
            market: null,
            amount: null,
            created_at: new Date().toISOString(),
            completed_at: null,
            context: {
              market: null,
              marketQuestion: null,
              relatedMarkets: [
                {
                  market: A(102),
                  marketQuestion: "本周公开测试能否完成全部退出场景？",
                },
              ],
              outcomeId: null,
              outcomeLabel: null,
              amount: null,
              units: null,
            },
          },
          {
            id: "66666666-6666-4666-8666-666666666666",
            kind: "bond",
            effect: "payout",
            state: "confirmed",
            tx_hash: "0x" + "6".repeat(64),
            market: null,
            amount: "10000000",
            created_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            context: {
              market: null,
              marketQuestion: null,
              relatedMarkets: [
                {
                  market: A(101),
                  marketQuestion: "主播今晚直播间是否会超过30万人？",
                },
              ],
              outcomeId: null,
              outcomeLabel: null,
              amount: "10000000",
              units: null,
            },
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.goto(
    "/test/browser/fixture.html?orderbook-test=1#/ctusd-test/entitlements",
  );

  const history = page.getByRole("region", { name: "自动领取记录" });
  const row = history.getByRole("row").filter({ hasText: "市场押金处理" });
  await expect(row).toContainText("已完成");
  await expect(history).toContainText(
    "仅完成市场级押金结算，不代表押金进入你的账户",
  );
  await expect(row).not.toContainText("已到账");
  const assetReturn = history
    .getByRole("row")
    .filter({ hasText: "挂单资产返还" });
  await expect(assetReturn).toContainText("已返还");
  await expect(assetReturn).toContainText("5 份");
  const unknownOperation = history
    .getByRole("row")
    .filter({ hasText: "权益处理" });
  await expect(unknownOperation).toContainText("已完成");
  await expect(unknownOperation).not.toContainText("已到账");
  const winner = history.getByRole("row").filter({ hasText: "赢家收益" });
  await expect(winner).toContainText("主播今晚直播间是否会超过30万人？");
  await expect(winner).toContainText("结果：是");
  await expect(winner).toContainText("9.632 ctUSD");
  await expect(winner).toContainText("已到账");
  const fees = history.getByRole("row").filter({ hasText: "费用收入" });
  await expect(fees).toContainText("本周公开测试能否完成全部退出场景？");
  await expect(fees).toContainText("待链上确认");
  await expect(fees).toContainText("处理中");
  await expect(fees).toContainText("按账户合并领取以上市场的累计费用。");
  const bond = history.getByRole("row").filter({ hasText: "可退押金" });
  await expect(bond).toContainText("10 ctUSD");
  await expect(bond).toContainText("主播今晚直播间是否会超过30万人？");
  await expect(bond).toContainText("按账户合并领取以上市场的可退押金。");
  await page.screenshot({
    path: `/tmp/cpredict-automatic-claim-markets-${test.info().project.name}.png`,
    fullPage: true,
  });
  expect(f.errors).toEqual([]);
});

test("automatic claim history shows market, confirmed amount and paginates newest first", async ({
  page,
}) => {
  const f = await setup(page);
  const transactions = Array.from({ length: 6 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    kind: "winner",
    state: "confirmed",
    tx_hash: `0x${String(index + 1).repeat(64)}`,
    market: A(101),
    amount: String((index + 1) * 1_000_000),
    created_at: new Date(Date.UTC(2026, 8, 21, 9, 0, index)).toISOString(),
    completed_at: new Date(Date.UTC(2026, 8, 21, 9, 1, index)).toISOString(),
  }));
  await page.route("**/v1/automatic-claims**", (route) => {
    const url = new URL(route.request().url());
    const secondPage = url.searchParams.has("cursor");
    return route.fulfill({
      json: {
        enabled: true,
        reason: "received",
        updatedAt: new Date().toISOString(),
        transactions: secondPage
          ? transactions.slice(5)
          : transactions.slice(0, 5),
        nextCursor: secondPage ? null : transactions[4]!.id,
      },
    });
  });
  await page.goto(
    "/test/browser/fixture.html?orderbook-test=1#/ctusd-test/entitlements",
  );

  const history = page.getByRole("region", { name: "自动领取记录" });
  await expect(
    history.getByRole("columnheader", { name: "市场" }),
  ).toBeVisible();
  await expect(
    history.getByRole("columnheader", { name: "实际到账" }),
  ).toBeVisible();
  await expect(history).toContainText("本周公开测试能否完成全部退出场景？");
  await expect(history).toContainText("1 ctUSD");
  await expect(history).not.toContainText("6 ctUSD");
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByText("第 2 页", { exact: true })).toBeVisible();
  await expect(history).toContainText("6 ctUSD");
  await expect(history).not.toContainText("1 ctUSD");
  await page.getByRole("button", { name: "上一页" }).click();
  await expect(page.getByText("第 1 页", { exact: true })).toBeVisible();
  await expect(history).toContainText("1 ctUSD");
  expect(f.errors).toEqual([]);
});

test("a deep reorg withdraws the received message while canonical recovery runs", async ({
  page,
}) => {
  const f = await setup(page);
  await page.route("**/v1/automatic-claims**", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        reason: "rechecking_after_reorg",
        updatedAt: new Date().toISOString(),
        transactions: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            kind: "winner",
            effect: "payout",
            state: "unknown",
            tx_hash: "0x" + "5".repeat(64),
            market: null,
            amount: null,
            created_at: new Date().toISOString(),
            completed_at: null,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.goto(
    "/test/browser/fixture.html?orderbook-test=1#/ctusd-test/entitlements",
  );
  await expect(page.getByRole("status")).toContainText("原到账记录已撤回");
  const history = page.getByRole("region", { name: "自动领取记录" });
  const row = history.getByRole("row").filter({ hasText: "赢家收益" });
  await expect(row).toContainText("处理中");
  await expect(row).not.toContainText("已到账");
  expect(f.errors).toEqual([]);
});
test("manual bid acceptance displays fee-adjusted minimum proceeds and frozen assets separately", async ({
  page,
}) => {
  const f = await setup(page);
  await page.goto(
    `/test/browser/fixture.html?orderbook-test=1#/ctusd-test/markets/${A(101)}`,
  );
  await page.getByRole("button", { name: "卖给此求购单", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("卖家净收款", { exact: true }),
  ).toBeVisible();
  await page.goto(
    "/test/browser/fixture.html?orderbook-test=1#/ctusd-test/assets",
  );
  const frozen = page.getByRole("region", { name: "求购冻结资产" });
  await expect(
    frozen.getByRole("heading", { name: "求购冻结资产" }),
  ).toBeVisible();
  await expect(frozen.locator(".amount")).toHaveText("3 ctUSD");
  expect(f.errors).toEqual([]);
});

test("assets list every funded bid and open cancellation without revisiting each market", async ({
  page,
}) => {
  const f = await setup(page);
  await page.goto(
    "/test/browser/fixture.html?orderbook-test=1&multiple-owner-bids=1#/ctusd-test/assets",
  );
  const frozen = page.getByRole("region", { name: "求购冻结资产" });
  await expect(frozen.getByText("5 ctUSD", { exact: true })).toBeVisible();
  await expect(
    frozen.getByRole("heading", { name: "求购单明细", exact: true }),
  ).toBeVisible();
  const first = frozen
    .getByRole("row")
    .filter({ hasText: "本周公开测试能否完成全部退出场景？" });
  await expect(first).toContainText("尚未完成");
  await expect(first).toContainText("3 ctUSD");
  const second = frozen
    .getByRole("row")
    .filter({ hasText: "主播今晚直播间是否会超过30万人？" });
  await expect(second).toContainText("能够完成");
  await expect(second).toContainText("2 ctUSD");
  await expect(frozen.getByRole("button", { name: "撤销求购单" })).toHaveCount(
    2,
  );
  await page.screenshot({
    path: `/tmp/cpredict-frozen-bids-list-${test.info().project.name}.png`,
    fullPage: true,
  });
  await second.getByRole("button", { name: "撤销求购单" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("撤销订单");
  await expect(dialog).toContainText("主播今晚直播间是否会超过30万人？");
  await expect(dialog).toContainText("解冻金额");
  await expect(dialog).toContainText("2 ctUSD");
  await page.screenshot({
    path: `/tmp/cpredict-frozen-bids-cancel-${test.info().project.name}.png`,
    fullPage: true,
  });
  expect(f.errors).toEqual([]);
});

test("an enabled account sees a blocked shared claims queue and retains manual access", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/v1/automatic-claims**", (r) =>
    r.fulfill({
      json: {
        enabled: true,
        reason: "queue_blocked_unknown_transaction",
        updatedAt: new Date().toISOString(),
        transactions: [],
        nextCursor: null,
      },
    }),
  );
  await page.goto(
    "/test/browser/fixture.html?orderbook-test=1#/ctusd-test/entitlements",
  );
  await expect(
    page.getByRole("checkbox", { name: "自动领取权益（默认开启）" }),
  ).toBeChecked();
  await expect(
    page.getByRole("status").filter({ hasText: "自动领取队列暂缓" }),
  ).toBeVisible();
  await expect(
    page.getByText("无需重复开关，可先手动领取。", { exact: false }),
  ).toBeVisible();
});
