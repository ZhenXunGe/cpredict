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

test("holdings use market titles and omit markets that have settled", async ({
  page,
}) => {
  await page.goto(
    `${fixture}?positions-test=1&delay-market-details=1#/ctusd-test/entitlements`,
  );
  await expect(
    page.getByRole("heading", { name: "持仓与权益", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("正在读取市场名称与结算状态", { exact: true }),
  ).toBeVisible();
  const holdings = page
    .getByRole("row")
    .filter({ has: page.getByText("普通持仓", { exact: true }) });
  await expect(holdings).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "持仓成本明细", exact: true }),
  ).toHaveCount(0);
  await expect(holdings).toHaveCount(1);
  await expect(
    holdings.getByRole("link", { name: "仍在进行的测试市场", exact: true }),
  ).toBeVisible();
  const costs = page.locator("section").filter({
    has: page.getByRole("heading", { name: "持仓成本明细", exact: true }),
  });
  await expect(
    costs.getByRole("link", { name: "仍在进行的测试市场", exact: true }),
  ).toBeVisible();
  await expect(holdings.getByText("尚未完成", { exact: true })).toBeVisible();
  await expect(costs.getByText("尚未完成", { exact: true })).toBeVisible();
  await expect(
    costs.getByText("已结算的测试市场", { exact: false }),
  ).toHaveCount(0);
  await expect(
    costs.getByText("已作废的测试市场", { exact: false }),
  ).toHaveCount(0);
  const refund = page
    .getByRole("row")
    .filter({ has: page.getByText("本金退款", { exact: true }) });
  await expect(
    refund.getByRole("link", { name: "已作废的测试市场", exact: true }),
  ).toBeVisible();
  await expect(
    refund.getByRole("button", { name: "领取", exact: true }),
  ).toBeEnabled();
  const winner = page
    .getByRole("row")
    .filter({ has: page.getByText("赢家收益", { exact: true }) });
  await expect(
    winner.getByRole("link", { name: "已结算的测试市场", exact: true }),
  ).toBeVisible();
  await test.info().attach("market-names-and-holdings", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await winner.getByRole("button", { name: "领取", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("已结算的测试市场", { exact: true }),
  ).toBeVisible();
});

test("holdings distinguish both outcomes and retain outcome IDs when rules are unavailable", async ({
  page,
}) => {
  await page.goto(
    `${fixture}?positions-test=1&both-outcomes=1#/ctusd-test/entitlements`,
  );
  await expect(page).toHaveTitle(/Cpredict/);
  const holdings = page
    .getByRole("row")
    .filter({ has: page.getByText("普通持仓", { exact: true }) });
  await expect(holdings).toHaveCount(2);
  const costs = page.locator("section").filter({
    has: page.getByRole("heading", { name: "持仓成本明细", exact: true }),
  });
  for (const name of ["能够完成", "尚未完成"]) {
    await expect(holdings.getByText(name, { exact: true })).toBeVisible();
    await expect(costs.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(
    holdings
      .filter({ hasText: "能够完成" })
      .getByRole("cell", { name: "3", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("holding-outcomes.png"),
    fullPage: true,
  });
  await page.getByLabel("规则读取失败").check();
  await expect(
    holdings.getByText("结果 #0（名称暂不可用）", { exact: true }),
  ).toBeVisible();
  await expect(
    holdings.getByText("结果 #1（名称暂不可用）", { exact: true }),
  ).toBeVisible();
  await expect(holdings.getByText("是", { exact: true })).toHaveCount(0);
  await page.getByLabel("规则读取失败").uncheck();
  await expect(holdings.getByText("尚未完成", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
});

test("holdings disappear when their market settles without reloading the page", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto(`${fixture}?positions-test=1#/ctusd-test/entitlements`);
  const holdings = page
    .getByRole("row")
    .filter({ has: page.getByText("普通持仓", { exact: true }) });
  await expect(holdings).toHaveCount(1);
  await page.getByRole("button", { name: "结算夹具市场", exact: true }).click();
  await page.clock.fastForward(15001);
  await expect(holdings).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "持仓成本明细", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("row")
      .filter({ has: page.getByText("赢家收益", { exact: true }) }),
  ).toBeVisible();
});

test("creator center identifies markets by their names and opens management", async ({
  page,
}) => {
  await open(page, "creator");
  const namedMarket = page
    .getByRole("table")
    .getByRole("link", { name: question, exact: true });
  await expect(namedMarket).toBeVisible();
  await expect(namedMarket).toHaveAttribute(
    "href",
    `#/ctusd-test/creator/${market}`,
  );
  await test.info().attach("creator-market-names", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await namedMarket.click();
  await expect(page).toHaveURL(new RegExp(`/creator/${market}$`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
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
  const feedbackPagination = feedback.getByRole("navigation", {
    name: "反馈记录分页",
  });
  await feedbackPagination.getByRole("button", { name: "下一页" }).click();
  await expect(
    feedbackPagination.getByText("第 2 页", { exact: true }),
  ).toBeVisible();
  await expect(feedback).toContainText("第二条测试反馈");
  await expect(feedback).not.toContainText(
    "<script>浏览器必须按文本显示</script>",
  );
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
  await expect(page.getByText("平台费用累计总额", { exact: true })).toHaveCount(
    0,
  );
});

test("platform lifetime fees remain separate from date windows and incomplete totals", async ({
  page,
}) => {
  await open(page, "ops", true);
  const total = page
    .locator(".stat-card")
    .filter({ hasText: "平台费用累计总额" });
  await expect(total).toContainText("20 ctUSD");
  await page.getByLabel("开始日期（上海）").fill("2026-09-01");
  await page.getByLabel("结束日期（不含）").fill("2026-09-02");
  await page.getByRole("button", { name: "查询报表", exact: true }).click();
  await expect(total).toContainText("20 ctUSD");
  await page.screenshot({
    path: test.info().outputPath("platform-fee-total.png"),
    fullPage: true,
  });
  await page.goto(
    `${fixture}?admin=1&platform-fee-coverage=partial#/ctusd-test/ops`,
  );
  const partial = page
    .locator(".stat-card")
    .filter({ hasText: "平台费用累计已知金额" });
  await expect(partial).toContainText("20 ctUSD");
  await expect(partial).toContainText("不能视为全部平台收入");
  await page.goto(
    `${fixture}?admin=1&platform-fee-coverage=unavailable#/ctusd-test/ops`,
  );
  await expect(partial).toContainText("未知");
  await expect(partial).not.toContainText("0 ctUSD");
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

test("fees distinguish market snapshots from current creation config and remain visible before trading", async ({
  page,
}) => {
  await open(page, `markets/${market}`);
  const fees = page.getByRole("region", { name: "费用说明", exact: true });
  await expect(fees).toContainText("创作者终局抽成的 5%");
  await expect(fees).toContainText("成交总额的 0.25%（由卖家承担）");
  await fees.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("market-fees.png") });
  await reviewBuy(page);
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.locator("dt").filter({ hasText: /^终局平台分成$/ }),
  ).toBeVisible();
  await expect(dialog).toContainText("创作者终局抽成的 5%");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "挂单卖出", exact: true }).click();
  await page.getByLabel("挂单份额", { exact: true }).fill("10");
  await page.getByLabel("每份卖价（ctUSD）", { exact: true }).fill("1");
  await page.getByRole("button", { name: "核对挂单", exact: true }).click();
  await expect(dialog).toContainText("成交总额的 0.25%（成交时由卖家承担）");
  await open(page, "creator/new");
  const creationFees = page.getByRole("region", {
    name: "平台费用说明",
    exact: true,
  });
  await expect(creationFees).toContainText("创作者终局抽成的 20%");
  await expect(creationFees).toContainText("成交总额的 0.5%（由卖家承担）");
  await creationFees.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("creation-fees.png") });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("zero C2C fees remain distinct from unavailable on-chain fee data", async ({
  page,
}) => {
  for (const route of [`markets/${market}`, "creator/new"]) {
    await page.goto(`${fixture}?fee-test=zero#/ctusd-test/${route}`);
    const fees = page.getByRole("region", {
      name: route.startsWith("markets") ? "费用说明" : "平台费用说明",
      exact: true,
    });
    await expect(fees).toContainText("成交总额的 0%（由卖家承担）");
    await page.goto(`${fixture}?fee-test=unavailable#/ctusd-test/${route}`);
    await expect(fees).toContainText("费率暂不可用");
    await expect(fees).not.toContainText("0%");
  }
});

test("timeout action and creator controls use the exact on-chain deadline", async ({
  page,
}) => {
  for (const scenario of ["before", "boundary"]) {
    await page.goto(
      `${fixture}?timeout-test=${scenario}#/ctusd-test/markets/${market}`,
    );
    await expect(
      page.getByRole("heading", { name: "费用说明", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("市场本金的 1%", { exact: true }),
    ).toBeVisible();
    const action = page.getByRole("button", {
      name: "申请超时作废",
      exact: true,
    });
    if (scenario === "before") {
      await expect(action).toHaveCount(0);
      await expect(
        page.locator(".status").filter({ hasText: "已封盘 · 待结算" }),
      ).toBeVisible();
    } else {
      await expect(
        page.locator(".status").filter({ hasText: "已超时 · 待作废" }),
      ).toBeVisible();
      await expect(page.getByText(/但市场尚未作废/)).toBeVisible();
      await action.click();
      await expect(page.getByRole("dialog")).toContainText(
        "已达到结算截止时间",
      );
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "取消", exact: true })
        .click();
      await page.screenshot({
        path: test.info().outputPath("timeout-pending.png"),
      });
    }
    await page.goto(
      `${fixture}?timeout-test=${scenario}#/ctusd-test/creator/${market}`,
    );
    const creatorVoid = page.getByRole("button", {
      name: "核对规则并作废",
      exact: true,
    });
    const resolve = page.getByRole("button", {
      name: "核对结果并结算",
      exact: true,
    });
    if (scenario === "before") {
      await expect(creatorVoid).toBeEnabled();
      await expect(resolve).toBeEnabled();
    } else {
      await expect(creatorVoid).toBeDisabled();
      await expect(resolve).toBeDisabled();
      await expect(
        page.getByRole("link", { name: "前往申请超时作废", exact: true }),
      ).toBeVisible();
    }
  }
});

test("confirmed timeout replaces stale indexed status without a page reload", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto(
    `${fixture}?timeout-test=boundary#/ctusd-test/markets/${market}`,
  );
  await expect(
    page.getByRole("button", { name: "申请超时作废", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.testTimeoutVoided = "1";
  });
  await page.clock.fastForward(15001);
  await expect(page.locator(".status-voided")).toHaveText("已超时作废");
  await expect(
    page.getByText(/已超时作废 · 所有时间均为北京时间/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "申请超时作废", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "领取与退出", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/超时退款与押金罚没补偿分阶段领取/),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("timeout-confirmed.png"),
  });
  await page.goto(
    `${fixture}?timeout-test=voided#/ctusd-test/creator/${market}`,
  );
  await expect(page.getByText(/状态：已超时作废/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "核对规则并作废", exact: true }),
  ).toHaveCount(0);
});

test("market lists identify pending timeouts and legacy timeouts remain terminal", async ({
  page,
}) => {
  await page.goto(`${fixture}?timeout-test=boundary#/ctusd-test/markets`);
  await expect(
    page.getByText("已超时 · 待作废", { exact: true }).first(),
  ).toBeVisible();
  await page.goto(`${fixture}?timeout-test=boundary#/ctusd-test/creator`);
  await expect(
    page.getByRole("cell", { name: "已超时 · 待作废", exact: true }).first(),
  ).toBeVisible();
  await page.goto(
    `${fixture}?timeout-test=voided&legacy=1#/ctusd-test/markets/${market}`,
  );
  await expect(page.locator(".status-voided")).toHaveText("已超时作废");
  await expect(
    page.getByRole("button", { name: "申请超时作废", exact: true }),
  ).toHaveCount(0);
});

test("long market lists stay bounded and navigate by page", async ({
  page,
}) => {
  await page.goto(`${fixture}?pagination-test=1#/ctusd-test/markets`);
  const list = page.locator(".market-list");
  const pagination = page.getByRole("navigation", { name: "市场列表分页" });
  await expect(list.locator(".market-row")).toHaveCount(5);
  await expect(pagination.getByText("第 1 页", { exact: true })).toBeVisible();
  await pagination.getByRole("button", { name: "下一页" }).click();
  await expect(list.locator(".market-row")).toHaveCount(5);
  await expect(pagination.getByText("第 2 页", { exact: true })).toBeVisible();
  await pagination.getByRole("button", { name: "下一页" }).click();
  await expect(list.locator(".market-row")).toHaveCount(2);
  await expect(pagination.getByText("第 3 页", { exact: true })).toBeVisible();
  await pagination.getByRole("button", { name: "上一页" }).click();
  await expect(list.locator(".market-row")).toHaveCount(5);
  await pagination.getByRole("button", { name: "上一页" }).click();
  await expect(list.locator(".market-row")).toHaveCount(5);
});

test("unchanged catalogue data still crosses the timeout deadline while the page stays open", async ({
  page,
}) => {
  await page.clock.install();
  for (const route of ["markets", "creator"]) {
    // A hash-only navigation keeps the prior fixture and its expired deadline.
    await page.goto("about:blank");
    // Allow rendering time before the boundary, then cross it explicitly.
    await page.goto(
      `${fixture}?timeout-test=before&timeout-countdown=1#/ctusd-test/${route}`,
    );
    await expect(
      page.getByText("已封盘 · 待结算", { exact: true }).first(),
    ).toBeVisible();
    await page.clock.fastForward(45001);
    await expect(
      page.getByText("已超时 · 待作废", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText("已超时作废", { exact: true })).toHaveCount(0);
  }
});

test("market names survive rule errors in detail, management and confirmation, and name the leaderboard roster", async ({
  page,
}) => {
  // An invalid document exercises the rule-read failure without a live service
  // or a deliberately generated browser network error.
  await page.route("**/v1/markets/*/rules.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.goto(`${fixture}?rules-error=1#/ctusd-test/markets/${market}`);
  await expect(
    page.getByRole("heading", { name: question, exact: true }),
  ).toBeVisible();
  await page.goto(`${fixture}?rules-error=1#/ctusd-test/creator/${market}`);
  await expect(
    page.getByRole("heading", { name: question, exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("证据说明与公开链接")
    .fill("测试取消依据：https://example.com/results");
  await page
    .getByRole("button", { name: "核对规则并作废", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(question);
  await page.goto(`${fixture}?named-roster=1#/ctusd-test/leaderboard`);
  await page.getByText("指定市场与统计规则", { exact: true }).click();
  await expect(
    page.getByRole("link", { name: question, exact: true }),
  ).toBeVisible();
});

test("platform fee totals are visible to ordinary creators in the center and creation form", async ({
  page,
}) => {
  for (const path of ["creator", "creator/new"]) {
    await page.goto(`${fixture}?ordinary-creator=1#/ctusd-test/${path}`);
    await expect(
      page.getByRole("link", { name: "运营报表", exact: true }),
    ).toHaveCount(0);
    const summary = page.getByRole("region", {
      name: "平台费用汇总",
      exact: true,
    });
    await expect(summary).toContainText("平台费用累计总额");
    await expect(summary).toContainText("20 ctUSD");
    await expect(summary).toContainText("领取不重复计入");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await summary.screenshot({
      path: test
        .info()
        .outputPath(`platform-fees-${path.replace("/", "-")}.png`),
    });
  }
  await page.goto(
    `${fixture}?ordinary-creator=1&platform-fees-incomplete=1#/ctusd-test/creator/new`,
  );
  const summary = page.getByRole("region", {
    name: "平台费用汇总",
    exact: true,
  });
  await expect(summary).toContainText("平台费用累计已知金额");
  await expect(summary).toContainText("不能视为全部平台收入");
});

test("per-market platform rates show selected percentages and old factories do not offer unsupported fields", async ({
  page,
}) => {
  await open(page, "creator/new");
  const fees = page.getByRole("region", { name: "平台费用说明", exact: true });
  await fees.getByLabel("终局平台分成（基点）", { exact: true }).fill("1500");
  await fees.getByLabel("C2C 平台费率（基点）", { exact: true }).fill("75");
  await expect(fees).toContainText("创作者终局抽成的 15%");
  await expect(fees).toContainText("成交总额的 0.75%");
  await fees.getByLabel("终局平台分成（基点）", { exact: true }).fill("0");
  await expect(fees).toContainText("创作者终局抽成的 0%");
  await fees.screenshot({
    path: test.info().outputPath("per-market-platform-fees.png"),
  });
  await page.goto(`${fixture}?old-factory=1#/ctusd-test/creator/new`);
  await expect(fees).toContainText("当前部署尚不支持逐市场设置平台费率");
  await expect(
    fees.getByLabel("终局平台分成（基点）", { exact: true }),
  ).toHaveCount(0);
});

test("platform totals include historical deployments and historical views keep claims accessible", async ({
  page,
}, testInfo) => {
  await page.route(
    "**/historical/indexer/v2/platform-fees?**",
    async (route) => {
      expect(route.request().headers()["x-cpredict-environment"]).toBe(
        "ctusd-history",
      );
      await route.fulfill({
        json: {
          accrued: "5000000",
          complete: true,
          snapshot: {
            environment: "ctusd-history",
            deploymentId: "historical-deployment",
            version: 1,
            epoch: "1",
            blockNumber: "90",
            blockHash: "0x" + "01".repeat(32),
            timestamp: "1780000000",
            coverageStart: "1",
            complete: true,
            status: "shadow",
          },
        },
      });
    },
  );
  await page.goto(
    "/test/browser/fixture.html?ordinary-creator=1&multiple-fees=1#/ctusd-test/creator",
  );
  await expect(
    page.getByRole("region", { name: "平台费用汇总" }),
  ).toContainText("25");
  await expect(
    page.getByRole("region", { name: "平台费用汇总" }),
  ).toContainText("100 / 90");
  if (
    await page
      .getByRole("button", { name: "打开导航", exact: true })
      .isVisible()
  )
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "历史市场", exact: true }).first(),
  ).toHaveAttribute("href", "#/ctusd-history/markets");
  await page.goto(
    "/test/browser/fixture.html?historical-view=1#/ctusd-test/creator",
  );
  await expect(
    page.getByText("这里保留旧市场", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "创建市场", exact: true }),
  ).toHaveCount(0);
  if (
    await page
      .getByRole("button", { name: "打开导航", exact: true })
      .isVisible()
  )
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "持仓与权益", exact: true }).first(),
  ).toHaveAttribute("href", "#/ctusd-test/entitlements");
  await page.screenshot({
    path: testInfo.outputPath("historical-markets.png"),
    fullPage: true,
  });
});

test("historical creation links explain how to return to current markets", async ({
  page,
}) => {
  await page.goto(`${fixture}?historical-view=1#/ctusd-test/creator/new`);
  await expect(
    page.getByText("历史市场用于查看记录和领取旧权益", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("终局平台分成（基点）")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "核对并创建市场", exact: true }),
  ).toHaveCount(0);
});
