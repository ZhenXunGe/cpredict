import { test, expect } from "playwright/test";

test("rules publication shows the real HTTP error and preserves the creation form for retry", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("Failed to load resource"))
      errors.push(m.text());
  });
  // No real wallets, suppliers, RPC or publication writes in this regression.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:(?:4206|4207)\/)/, (route) =>
    route.abort(),
  );
  const responses = [
    {
      status: 400,
      body: JSON.stringify({ error: "invalid challenge request" }),
      type: "application/json",
      copy: "Factory",
    },
    {
      status: 409,
      body: JSON.stringify({
        error: "challenge expired",
        code: "challenge_expired",
      }),
      type: "application/json",
      copy: "挑战已过期",
    },
    {
      status: 500,
      body: JSON.stringify({
        error: "metadata signature storage is incompatible",
        code: "metadata_storage_incompatible",
        requestId: "req-test",
      }),
      type: "application/json",
      copy: "签名存储格式不兼容",
    },
    {
      status: 502,
      body: "<html><h1>Bad Gateway</h1></html>",
      type: "text/html",
      copy: "Bad Gateway",
    },
  ];
  let index = 0;
  await page.route("**/ctusd/metadata/v1/challenges", (route) => {
    const response = responses[index++]!;
    return route.fulfill({
      status: response.status,
      contentType: response.type,
      body: response.body,
    });
  });
  await page.goto(
    "/test/browser/fixture.html?rules-error=1#/ctusd-test/creator/new",
  );
  await expect(
    page.getByRole("heading", { name: "创建测试市场" }),
  ).toBeVisible();
  const question = "公开测试规则发布失败后是否可以重试？";
  await page.getByLabel("市场问题", { exact: true }).fill(question);
  const shanghai = (delta: number) =>
    new Date(Date.now() + delta + 8 * 3600000).toISOString().slice(0, 16);
  await page
    .getByLabel("封盘时间（上海）", { exact: true })
    .fill(shanghai(86400000));
  await page
    .getByLabel("结果判断截止时间（上海）", { exact: true })
    .fill(shanghai(90000000));
  await page
    .getByLabel("公开结果来源（HTTPS）", { exact: true })
    .fill("https://example.com/result");
  await page
    .getByLabel("结果判定规则", { exact: true })
    .fill("根据公开发布的最终结果进行判定。");
  await page
    .getByLabel("取消、延期和无法判断时的处理规则", { exact: true })
    .fill("无法确认公开结果时按约定取消市场。");
  await page
    .getByLabel("我已核对不可变规则、费用和押金，并理解创建者结算责任。")
    .check();
  const publish = page.getByRole("button", {
    name: "发布规则并核对创建交易",
    exact: true,
  });
  for (const response of responses) {
    await publish.click();
    const alert = page.getByRole("alert").filter({ hasText: "规则发布未完成" });
    await expect(alert).toContainText(response.copy);
    await expect(alert).toContainText(`HTTP ${response.status}`);
    await expect(alert).toContainText("尚未提交链上创建交易");
    await expect(alert).not.toContainText(
      /service_unavailable|rules_publication_failed|操作编号|恢复入口/,
    );
    await expect(page.getByLabel("市场问题", { exact: true })).toHaveValue(
      question,
    );
    await expect(publish).toBeEnabled();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await alert.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath(`creator-error-${response.status}.png`),
    });
  }
  expect(index).toBe(4);
  expect(errors).toEqual([]);
});
