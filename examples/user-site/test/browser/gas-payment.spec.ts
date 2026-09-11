import { test, expect } from "playwright/test";

test("exhausted sponsorship offers self-funded ETH with funding details and a second explicit fee confirmation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:(?:4206|4207)\/)/, (route) =>
    route.abort(),
  );
  await page.goto(
    "/test/browser/fixture.html?gas-test=1#/ctusd-test/markets/0x0000000000000000000000000000000000000065",
  );
  await expect(page).toHaveTitle(/Cpredict/);
  await page.getByLabel("投入数量（ctUSD）").fill("10");
  await page.getByRole("button", { name: "核对购买", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "确认并继续", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("本周代付额度已用尽");
  await expect(dialog.getByRole("alert")).toContainText("自行支付 ETH");
  await expect(page.locator("html")).toHaveAttribute(
    "data-test-gas-signatures",
    "0",
  );
  await dialog
    .getByLabel("Gas 支付方式", { exact: true })
    .selectOption("self-funded");
  await expect(dialog).toContainText("0.005 ETH");
  await dialog.getByText("向智能账户补充 ETH", { exact: true }).click();
  await expect(dialog.getByLabel("转入金额（ETH）")).toHaveValue("0.005");
  await expect(dialog).toContainText("Arbitrum Sepolia");
  await expect(
    dialog.getByRole("button", { name: "在钱包中确认转入" }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("self-funded-top-up.png"),
  });
  await dialog.getByText("向智能账户补充 ETH", { exact: true }).click();
  await dialog.getByRole("button", { name: "估算自付 Gas" }).click();
  await expect(dialog).toContainText("本次最多支付 0.00008 ETH");
  await expect(
    dialog.locator(".dialog-footer").getByText(/本次最多支付/),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute(
    "data-test-gas-signatures",
    "0",
  );
  await expect(
    dialog.getByRole("button", { name: "确认自付 ETH 并签名" }),
  ).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height + 1,
  );
  await page.screenshot({
    path: test.info().outputPath("self-funded-fee-review.png"),
  });
  await dialog.getByRole("button", { name: "确认自付 ETH 并签名" }).click();
  await expect(dialog).toContainText("已提交");
  await expect(page.locator("html")).toHaveAttribute(
    "data-test-gas-signatures",
    "1",
  );
  await expect(
    dialog.getByRole("button", { name: "确认自付 ETH 并签名" }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("cancelling fee review keeps the business draft and makes no signature", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(
    "/test/browser/fixture.html?gas-test=1#/ctusd-test/markets/0x0000000000000000000000000000000000000065",
  );
  await page.getByLabel("投入数量（ctUSD）").fill("10");
  await page.getByRole("button", { name: "核对购买", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Gas 支付方式", { exact: true })
    .selectOption("self-funded");
  await dialog.getByRole("button", { name: "估算自付 Gas" }).click();
  await dialog.getByRole("button", { name: "取消签名" }).click();
  await expect(
    dialog.getByRole("button", { name: "估算自付 Gas" }),
  ).toBeEnabled();
  await expect(dialog).toContainText("10 ctUSD");
  await expect(page.locator("html")).toHaveAttribute(
    "data-test-gas-signatures",
    "0",
  );
  expect(errors).toEqual([]);
});
