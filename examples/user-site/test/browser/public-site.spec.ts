import { test, expect, type Page } from "playwright/test";

const built = "http://127.0.0.1:4207";
const fixture = "/test/browser/fixture.html";
const market = "0x0000000000000000000000000000000000000065";
const question = "本周公开测试能否完成全部退出场景？";
const diagnostics = new WeakMap<Page, string[]>();
async function open(page: Page, route = "markets", admin = false) {
  await page.goto(`${fixture}${admin ? "?admin=1" : ""}#/ctusd-test/${route}`);
  await expect(
    page.getByText("浏览器夹具 · 无真实资金或签名", { exact: true }),
  ).toBeVisible();
}
async function reviewBuy(page: Page) {
  await page.getByLabel("投入数量（ctUSD）").fill("10");
  await page.getByRole("button", { name: "核对购买", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  // No test may accidentally connect to a wallet, supplier or public RPC.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:(?:4206|4207)\/)/, (route) =>
    route.abort(),
  );
  test.info().annotations.push({
    type: "proof",
    description:
      "Local build and non-signing UI fixture; no real wallet, paymaster or physical mobile device.",
  });
  diagnostics.set(page, errors);
});
test.afterEach(async ({ page }) => {
  expect(diagnostics.get(page)).toEqual([]);
});

test("built public entry keeps trading closed without configuration and survives a deep-link refresh", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  await page.goto(`${built}/ctusd-test/markets/${market}`);
  await expect(
    page.getByRole("heading", { name: "公开测试站尚未开放" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "公开测试站尚未开放" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "确认并继续" })).toHaveCount(0);
  expect(requested.some((url) => url.includes("/connected-wallets-"))).toBe(
    false,
  );
});

test("built third-party notices retain supplier notices and downloadable license text", async ({
  page,
}) => {
  await page.goto(`${built}/third-party/index.html`);
  await expect(
    page.getByRole("heading", { name: "第三方软件声明", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Portions © 2025 Reown, Inc. All Rights Reserved", {
      exact: true,
    }),
  ).toBeVisible();
  const copy = page
    .locator("li")
    .filter({ has: page.getByText("@reown/appkit 1.8.9", { exact: true }) })
    .getByRole("link")
    .first();
  const path = await copy.getAttribute("href");
  expect(path).toMatch(/^[a-f0-9]{64}\.txt$/);
  const response = await page.request.get(`${built}/third-party/${path}`);
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain("Monthly MAU limit of 500");
});

test("built independent recovery loads without the application API", async ({
  page,
}) => {
  await page.goto(`${built}/recovery.html`);
  await expect(
    page.getByRole("heading", { name: "独立账户恢复与退出" }),
  ).toBeVisible();
  await expect(page.getByLabel("账户恢复配置 JSON")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认自付 ETH 并签名提交" }),
  ).toHaveCount(0);
});

test("market navigation, browser back and empty pools show no invented return", async ({
  page,
}) => {
  await open(page);
  await page
    .getByRole("link", { name: new RegExp(question.slice(0, -1)) })
    .click();
  await expect(page.getByRole("heading", { name: question })).toBeVisible();
  await expect(
    page.getByText("市场尚无资金投入，当前不展示赔率或预期收益。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "探索市场" })).toBeVisible();
});

test("confirmation identifies both addresses, fits the viewport and restores keyboard focus", async ({
  page,
}) => {
  await open(page, `markets/${market}`);
  await reviewBuy(page);
  const dialog = page.getByRole("dialog");
  for (const value of ["资产账户", "控制钱包", "10 ctUSD", "等待代付准入"])
    await expect(dialog).toContainText(value);
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height + 1,
  );
  await page.screenshot({ path: test.info().outputPath("confirmation.png") });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "核对购买", exact: true }),
  ).toBeFocused();
});

test("account changes dismiss a confirmation prepared for the old account", async ({
  page,
}) => {
  await open(page, `markets/${market}`);
  await page.getByLabel("投入数量（ctUSD）").fill("10");
  await page
    .getByRole("button", { name: "3 秒后切换账户", exact: true })
    .click();
  await reviewBuy(page);
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 6000 });
});

test("unverifiable rules disable new exposure while keeping existing early-bird exit visible", async ({
  page,
}) => {
  await open(page, `markets/${market}`);
  const review = page.getByRole("button", { name: "核对购买", exact: true });
  await expect(review).toBeEnabled();
  await page.getByLabel("规则读取失败", { exact: true }).check();
  await expect(review).toBeDisabled();
  await expect(
    page.getByText(
      "规则暂不可验证，新增购买与挂单已暂停。已有资产的领取、撤单和终局份额取回仍可使用。",
    ),
  ).toBeVisible();
  await page.goto(`${fixture}#/ctusd-test/entitlements`);
  await expect(
    page.getByRole("button", { name: "领取", exact: true }),
  ).toBeEnabled();
});

test("key pages do not overflow the document", async ({ page }) => {
  for (const route of [
    "markets",
    "assets",
    "entitlements",
    "history",
    "creator",
    "leaderboard",
    "help",
  ]) {
    await open(page, route);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
  }
});

test("search and filters survive refresh and anonymous browsing", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "夹具退出", exact: true }).click();
  await page
    .getByRole("textbox", { name: "搜索市场标题或地址" })
    .fill("不存在的测试市场");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page).toHaveURL(/q=/);
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "搜索市场标题或地址" }),
  ).toHaveValue("不存在的测试市场");
  await expect(
    page.getByRole("link", { name: new RegExp(question.slice(0, -1)) }),
  ).toHaveCount(0);
});

test("old delayed balance responses cannot replace the newly selected account", async ({
  page,
}) => {
  await page.clock.install();
  await open(page, "assets");
  await expect(page.locator(".balance-value")).toContainText("1000 ctUSD");
  await page.getByLabel("延迟响应", { exact: true }).check();
  await page
    .getByLabel("当前应用账户")
    .selectOption("10000000-0000-4000-8000-000000000002");
  await page.clock.runFor(650);
  await expect(page.locator(".balance-value")).toContainText("2000 ctUSD");
  await page
    .getByLabel("当前应用账户")
    .selectOption("10000000-0000-4000-8000-000000000001");
  await page
    .getByLabel("当前应用账户")
    .selectOption("10000000-0000-4000-8000-000000000002");
  await page.clock.runFor(650);
  await expect(page.locator(".balance-value")).toContainText("2000 ctUSD");
});

test("transfer confirmation preserves the exact recipient and amount", async ({
  page,
}) => {
  await open(page, "assets");
  await page
    .getByLabel("接收地址", { exact: true })
    .fill("0x000000000000000000000000000000000000000C");
  await page.getByLabel("转出数量（ctUSD）").fill("12.345678");
  await page.getByRole("button", { name: "核对转出" }).click();
  await expect(page.getByRole("dialog")).toContainText("12.345678 ctUSD");
  await expect(page.getByRole("dialog")).toContainText(
    "0x000000000000000000000000000000000000000C",
  );
});

test("unknown claims expose only the original operation and never a resend button", async ({
  page,
}) => {
  await open(page, "entitlements");
  await page.getByLabel("存在未知操作", { exact: true }).check();
  await expect(
    page.getByRole("link", { name: "查询原操作", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "领取", exact: true }),
  ).toHaveCount(0);
  await page.goto(
    `${fixture}#/ctusd-test/history?operation=20000000-0000-4000-8000-000000000001`,
  );
  const dialog = page.getByRole("dialog", { name: "原操作记录" });
  await expect(dialog).toContainText(
    "正在继续查询此操作。不要为了重试而重复付款。",
  );
  await expect(
    dialog.getByRole("button", { name: /确认|重试|提交|取消尚未/ }),
  ).toHaveCount(0);
});

test("creator form, history and test leaderboard distinguish missing data from zero income", async ({
  page,
}) => {
  await open(page, "creator/new");
  await expect(
    page.getByRole("heading", { name: "创建测试市场" }),
  ).toBeVisible();
  await expect(page.getByLabel("市场问题", { exact: true })).toBeEditable();
  await open(page, "history");
  await expect(
    page.getByRole("heading", { name: "此范围内还没有记录" }),
  ).toBeVisible();
  await open(page, "leaderboard");
  await expect(page.getByText("首期测试市场名单尚未公布。")).toBeVisible();
});

test("read-only reports show stale supplier data, retain unknown money and paginate escaped feedback", async ({
  page,
}) => {
  await open(page, "ops", true);
  const provider = page.getByRole("region", { name: "供应商读取状态" });
  await expect(provider).toContainText("请求受限");
  await expect(provider).toContainText("已过期");
  await expect(page.getByText(/供应商实际花费：未知/)).toBeVisible();
  const feedback = page.getByRole("region", { name: "测试反馈" });
  await expect(feedback).toContainText("<script>浏览器必须按文本显示</script>");
  await expect(feedback.locator("script")).toHaveCount(0);
  await feedback.getByRole("button", { name: "更多反馈" }).click();
  await expect(feedback).toContainText("第二条测试反馈");
  await feedback.getByLabel("反馈编号（留空查看全部）").fill("invalid-id");
  await feedback.getByRole("button", { name: "查询反馈" }).click();
  await expect(feedback.getByRole("alert")).toContainText(
    "请输入有效的反馈编号。",
  );
});

test("server report denial never displays financial values or feedback", async ({
  page,
}) => {
  await open(page, "ops");
  await expect(page.getByRole("alert")).toHaveCount(2);
  await expect(
    page.getByRole("heading", { name: "Gas、预算与服务状态" }),
  ).toHaveCount(0);
  await expect(page.getByText("第一条测试反馈")).toHaveCount(0);
});

test("saved feedback returns a traceable record number", async ({ page }) => {
  await open(page, "feedback");
  await page
    .getByLabel("问题与复现步骤")
    .fill("PC 浏览器领取成功后，余额需要等待索引更新。");
  await page.getByRole("button", { name: "提交反馈", exact: true }).click();
  await expect(page.getByText(/反馈已保存，编号：[a-f0-9-]{36}/)).toBeVisible();
});

test("retired Demo URLs lead to the new site and its assets are unavailable", async ({
  page,
}) => {
  for (const path of ["/demo", "/demo/", "/demo/markets"]) {
    const response = await page.request.get(`${built}${path}`, {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(308);
    expect(response.headers().location).toBe("/");
  }
  await page.goto(`${built}/demo/`);
  await expect(page).toHaveURL(`${built}/`);
  await expect(
    page.getByRole("heading", { name: "公开测试站尚未开放" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "公开测试站尚未开放" }),
  ).toBeVisible();
  const response = await page.request.get(`${built}/demo/assets/index.js`);
  expect(response.status()).toBe(404);
});

test("account help keeps app recovery without linking to the retired Demo", async ({
  page,
}) => {
  await open(page, "help");
  await expect(page.getByRole("heading", { name: "账户与帮助" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "独立恢复操作说明" }),
  ).toBeVisible();
  await expect(page.locator('a[href^="/demo"]')).toHaveCount(0);
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "退出登录", exact: true }),
  ).toHaveCount(0);
});

test("legacy deployment creation has no obsolete fallback or incompatible form", async ({
  page,
}) => {
  await page.goto(`${fixture}?legacy=1#/ctusd-test/creator/new`);
  await expect(
    page.getByRole("heading", { name: "创建测试市场" }),
  ).toBeVisible();
  await expect(
    page.getByText("当前部署暂不支持在本站创建市场，已创建的市场仍可浏览。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('a[href^="/demo"]')).toHaveCount(0);
  await expect(page.getByLabel("市场问题")).toHaveCount(0);
});
