import { test, expect, type Page } from "playwright/test";
const fixture = "/test/browser/fixture.html?usdc=1";
const source = "0x000000000000000000000000000000000000001e";
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const diagnostics: string[] = [];
  errors.set(page, diagnostics);
  page.on("pageerror", (e) => diagnostics.push(e.message));
  page.on("console", (e) => {
    if (e.type() === "error") diagnostics.push(e.text());
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:(?:4206|4207)\/)/, (route) =>
    route.abort(),
  );
  test
    .info()
    .annotations.push({
      type: "proof",
      description:
        "USDC UI fixture, invalid dummy funding signature, no wallet login, hosted paymaster or chain send.",
    });
});
test.afterEach(async ({ page }) => expect(errors.get(page)).toEqual([]));
async function open(page: Page, extra = "") {
  await page.goto(`${fixture}${extra}#/usdc-test/assets`);
  await expect(
    page.getByRole("heading", { name: "免 Gas 入金", exact: true }),
  ).toBeVisible();
}
async function connect(page: Page) {
  await page.getByRole("button", { name: "连接资金钱包", exact: true }).click();
  await page.getByLabel("资金钱包", { exact: true }).selectOption(source);
}
async function prepare(page: Page) {
  await page.getByLabel("入金数量（USDC）", { exact: true }).fill("1.000001");
  await page.getByRole("button", { name: "核对入金", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
test("independent funding wallet keeps the account and requires two separate confirmations", async ({
  page,
}) => {
  await open(page);
  await connect(page);
  await prepare(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(source);
  await expect(dialog).toContainText(
    "0x000000000000000000000000000000000000000A",
  );
  await expect(dialog).toContainText(
    "0x000000000000000000000000000000000000000b",
  );
  await expect(dialog).toContainText("1.000001 USDC");
  await expect(dialog).toContainText("等待项目代付准入");
  await dialog
    .getByRole("button", { name: "1. 授权 USDC 转出", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "2. 确认应用账户接收", exact: true }),
  ).toBeEnabled();
  const stored = await page.evaluate(() => ({
    ...sessionStorage,
    ...localStorage,
  }));
  expect(
    Object.values(stored).some((v) => String(v).includes("11".repeat(64))),
  ).toBe(false);
  expect(
    Object.entries(stored)
      .filter(([k]) => k.startsWith("cpredict-deposit:"))
      .map(([, v]) => v),
  ).toEqual(["40000000-0000-4000-8000-000000000001"]);
  const box = await dialog.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height + 1,
  );
  await page.screenshot({
    path: test.info().outputPath("independent-funding-confirmation.png"),
  });
  await dialog
    .getByRole("button", { name: "2. 确认应用账户接收", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible(); // Fixture controller explicitly refuses to sign.
  await expect(
    dialog.getByRole("button", { name: "1. 授权 USDC 转出", exact: true }),
  ).toBeVisible();
});
test("the current controller can fund with the same two-step authorization", async ({
  page,
}) => {
  await open(page);
  await prepare(page);
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "1. 授权 USDC 转出", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "2. 确认应用账户接收", exact: true }),
  ).toBeVisible();
});
test("funding rejection leaves the first step available and creates no operation", async ({
  page,
}) => {
  await open(page);
  await connect(page);
  await page.getByLabel("资金钱包拒签", { exact: true }).check();
  await prepare(page);
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "1. 授权 USDC 转出", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("已取消资金钱包签名");
  await expect(
    page.getByRole("link", { name: "查询已登记的原操作" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "2. 确认应用账户接收", exact: true }),
  ).toHaveCount(0);
});
test("disconnecting funding invalidates its in-memory signature", async ({
  page,
}) => {
  await open(page);
  await connect(page);
  await page
    .getByRole("button", { name: "1 秒后断开资金钱包", exact: true })
    .click();
  await prepare(page);
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "账户或确认内容已变化",
  );
  await expect(
    page.getByRole("button", { name: "2. 确认应用账户接收", exact: true }),
  ).toHaveCount(0);
});
test("account changes dismiss the old deposit confirmation", async ({
  page,
}) => {
  await open(page);
  await connect(page);
  await page
    .getByRole("button", { name: "3 秒后切换账户", exact: true })
    .click();
  await prepare(page);
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 6000 });
  await expect(
    page.getByRole("button", { name: "继续核对原入金", exact: true }),
  ).toHaveCount(0);
});
test("refresh recovers a server-owned deposit without persisting its signature", async ({
  page,
}) => {
  await open(page, "&deposit=unsigned");
  await page.getByRole("button", { name: "连接资金钱包", exact: true }).click();
  await page
    .getByRole("button", { name: "继续核对原入金", exact: true })
    .click();
  await page
    .getByRole("button", { name: "1. 授权 USDC 转出", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "2. 确认应用账户接收", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "连接资金钱包", exact: true }).click();
  await page
    .getByRole("button", { name: "继续核对原入金", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "1. 授权 USDC 转出", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "2. 确认应用账户接收", exact: true }),
  ).toHaveCount(0);
});
test("unknown deposits survive refresh and a disabled entry without offering a new send", async ({
  page,
}) => {
  await open(page, "&deposit=unknown");
  await expect(
    page.getByRole("link", { name: "查看原入金操作", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "核对入金", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await page.getByRole("button", { name: "关闭入金开关", exact: true }).click();
  await expect(
    page.getByText("当前暂停免 Gas 入金，已有记录仍可查询。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "查看原入金操作", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "取消本次入金", exact: true }),
  ).toHaveCount(0);
});
