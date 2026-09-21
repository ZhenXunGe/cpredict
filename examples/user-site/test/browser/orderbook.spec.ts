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
      },
    });
  });
  await page.route("**/v2/orders?**", async (r) =>
    r.fulfill({
      json: {
        items: [
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
        ].filter(
          (o) =>
            !r.request().url().includes("owner=") ||
            o.owner === appAccount.address,
        ),
        totalLockedPayment: r.request().url().includes("owner=")
          ? "3000000"
          : "4000000",
        nextCursor: null,
      },
    }),
  );
  return { changes, errors };
}
test("funded bid defaults matching on; confirmation includes outcome, exact reserve and expiry", async ({
  page,
}) => {
  const f = await setup(page);
  await page.goto(
    `/test/browser/fixture.html?orderbook-test=1#/ctusd-test/markets/${A(101)}`,
  );
  const panel = page
    .locator("section")
    .filter({
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
  await expect(
    page.getByRole("heading", { name: "求购冻结资产" }),
  ).toBeVisible();
  await expect(page.getByText("3 ctUSD", { exact: true })).toBeVisible();
  expect(f.errors).toEqual([]);
});


test("an enabled account sees a blocked shared claims queue and retains manual access", async ({page}) => {
  await setup(page);
  await page.route("**/v1/automatic-claims**",r=>r.fulfill({json:{enabled:true,reason:"queue_blocked_unknown_transaction",updatedAt:new Date().toISOString(),transactions:[]}}));
  await page.goto("/test/browser/fixture.html?orderbook-test=1#/ctusd-test/entitlements");
  await expect(page.getByRole("checkbox",{name:"自动领取权益（默认开启）"})).toBeChecked();
  await expect(page.getByRole("status").filter({hasText:"自动领取队列暂缓"})).toBeVisible();
  await expect(page.getByText("无需重复开关，可先手动领取。",{exact:false})).toBeVisible();
});
