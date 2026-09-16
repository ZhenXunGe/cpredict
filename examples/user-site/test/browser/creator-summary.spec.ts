import { test, expect, type Page } from "playwright/test";

const market = "0x0000000000000000000000000000000000000065";
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const messages: string[] = [];
  page.on("pageerror", (e) => messages.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") messages.push(m.text());
  });
  errors.set(page, messages);
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:(?:4206|4207)\/)/, (route) =>
    route.abort(),
  );
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

test("creator list opens the settled market with option investments and its named result", async ({
  page,
}) => {
  await page.goto(
    "/test/browser/fixture.html?creator-summary=resolved#/ctusd-test/creator",
  );
  await page.getByRole("link", { name: "查看", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/creator/${market}$`));
  await expect(
    page.getByRole("heading", { name: "市场结算管理" }),
  ).toBeVisible();
  await expect(page.getByText("终局结果：否", { exact: true })).toBeVisible();
  const summary = page.getByRole("region", { name: "一级投入统计" });
  for (const [label, amount] of [
    ["一级投入总额", "5 ctUSD"],
    ["“是”投入金额", "1.25 ctUSD"],
    ["“否”投入金额", "3.75 ctUSD"],
  ] as const)
    await expect(
      summary.locator(".stat-card").filter({ hasText: label }),
    ).toContainText(amount);
  await expect(summary).toContainText("不含 C2C 成交");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("creator-summary.png"),
    fullPage: true,
  });
});

for (const scenario of ["zero", "multi", "unavailable", "voided"])
  test(`creator summary handles ${scenario} without inventing amounts or results`, async ({
    page,
  }) => {
    const query =
      scenario === "voided"
        ? "creator-summary=resolved&timeout-test=voided"
        : `creator-summary=${scenario}`;
    await page.goto(
      `/test/browser/fixture.html?${query}#/ctusd-test/creator/${market}`,
    );
    const summary = page.getByRole("region", { name: "一级投入统计" });
    await expect(summary).toBeVisible();
    if (scenario === "multi") {
      await expect(
        page.getByText("终局结果：丙", { exact: true }),
      ).toBeVisible();
      await expect(
        summary.locator(".stat-card").filter({ hasText: "一级投入总额" }),
      ).toContainText("7 ctUSD");
      await expect(
        summary.locator(".stat-card").filter({ hasText: "“乙”投入金额" }),
      ).toContainText("2 ctUSD");
    } else if (scenario === "zero") {
      await expect(summary.locator(".amount")).toHaveText([
        "0 ctUSD",
        "0 ctUSD",
        "0 ctUSD",
      ]);
      await expect(page.getByText(/^终局结果：/)).toHaveCount(0);
    } else if (scenario === "unavailable") {
      await expect(summary.getByRole("alert")).toBeVisible();
      await expect(summary.locator(".stat-card strong")).toHaveText([
        "未知",
        "未知",
        "未知",
      ]);
      await expect(
        page.getByText("终局结果：否", { exact: true }),
      ).toBeVisible();
    } else {
      await expect(page.getByText(/状态：已超时作废/)).toBeVisible();
      await expect(page.getByText(/^终局结果：/)).toHaveCount(0);
    }
  });
