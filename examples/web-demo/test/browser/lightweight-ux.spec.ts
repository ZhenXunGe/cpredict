import { expect, test } from "playwright/test";
import { UX_LISTING, UX_MARKET, UX_RULES } from "../ux-fixtures.js";
import type { Page } from "playwright/test";

const bondPanel = (page: Page) =>
  page.getByRole("region", { name: "creator 押金退还", exact: true });
async function openBond(page: Page, scenario = "bond-resolved") {
  await page.goto(`/test/browser/lightweight-ux.html?scenario=${scenario}`);
  await expect(page).toHaveTitle("Cpredict 轻量体验交互回归");
  await expect(bondPanel(page)).toContainText("5 USDC");
}

const json = (value: unknown) =>
  JSON.stringify(value, (_, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
let browserErrors: string[];

test.beforeEach(async ({ page }) => {
  browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:4197") {
      browserErrors.push(`Unexpected external request: ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/indexer/")) return route.continue();
    const scenario = new URL(page.url()).searchParams.get("scenario");
    const response = url.pathname.endsWith("/sync-status")
      ? {
          status: "ready",
          chainId: 421614,
          indexedBlock: "100",
          safeBlock: "100",
        }
      : url.pathname.endsWith("/listings")
        ? { items: [UX_LISTING] }
        : url.pathname.includes("/positions/") && scenario === "void-indexed"
          ? {
              items: [
                {
                  vault: UX_MARKET.address,
                  owner: UX_MARKET.creator,
                  outcomeId: "0",
                  balance: "2000000",
                  updatedBlock: "100",
                  confirmationStatus: "confirmed",
                  marketState: 2,
                  winningOutcome: "0",
                },
              ],
            }
          : { items: [] };
    await route.fulfill({
      contentType: "application/json",
      body: json(response),
    });
  });
});

test.afterEach(async ({ page }) => {
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});

test("L1: primary rules precede a valid first purchase; no history or odds prerequisite", async ({
  page,
}, testInfo) => {
  await page.goto("/test/browser/lightweight-ux.html?scenario=purchase");
  await expect(page).toHaveTitle("Cpredict 轻量体验交互回归");
  const rules = page.getByRole("region", { name: "购买前必读规则" });
  for (const text of [
    UX_RULES.question,
    UX_RULES.resolutionCriteria,
    UX_RULES.resolutionSource,
    UX_RULES.cancellationPolicy,
    UX_MARKET.creator,
    "本盘由 creator 单方结算，协议与平台不裁决对错",
  ]) {
    await expect(rules).toContainText(text);
  }
  await expect(
    page.getByRole("button", { name: "精确授权并模拟购买", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("primary-rules.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "精确授权并模拟购买", exact: true })
    .click();
  await expect(page.getByTestId("transaction-calls")).toContainText(
    '"method":"buy"',
  );
  await expect(page.getByTestId("transaction-calls")).toContainText(
    '"desiredUnits":"1000000"',
  );
});

test("L1: missing or mismatched rules block new purchase, recovery restores it", async ({
  page,
}) => {
  await page.goto("/test/browser/lightweight-ux.html?scenario=purchase");
  const purchase = page.getByRole("button", {
    name: "精确授权并模拟购买",
    exact: true,
  });
  for (const control of ["规则暂不可用", "规则哈希不符"]) {
    await page.getByRole("button", { name: control, exact: true }).click();
    await expect(purchase).toBeDisabled();
    await expect(
      page.getByRole("region", { name: "购买前必读规则" }),
    ).toContainText("暂不能购买");
    await expect(
      page.getByText("被篡改的判定标准，不应展示为已验证规则。", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(page.getByTestId("transaction-calls")).toBeEmpty();
    await page.getByRole("button", { name: "恢复规则", exact: true }).click();
    await expect(purchase).toBeEnabled();
  }
});

test("L1/L3: all-high-price catalog expands and fills before close at the listed price", async ({
  page,
}, testInfo) => {
  await page.goto("/test/browser/lightweight-ux.html?scenario=c2c");
  await expect(
    page.getByRole("region", { name: "购买前必读规则" }),
  ).toContainText(UX_RULES.resolutionCriteria);
  const listing = page.locator(".folded-listings article");
  await expect(listing).toBeHidden();
  await page.locator(".folded-listings summary").click();
  await expect(listing).toBeVisible();
  await expect(listing).toContainText("creator 本人");
  await expect(listing).toContainText("1.2 USDC");
  await expect(page.getByText("池子直买更便宜", { exact: false })).toHaveCount(
    0,
  );
  await listing.getByRole("button", { name: "选择此挂单" }).click();
  const selected = page.getByRole("region", { name: "已选挂单", exact: true });
  await expect(selected).toContainText("creator 本人");
  await expect(selected).toContainText(UX_MARKET.creator, { ignoreCase: true });
  await selected.getByLabel("买入份数").fill("1");
  await expect(selected).toContainText("合计：1.2 USDC");
  await page.screenshot({
    path: testInfo.outputPath("c2c-expanded.png"),
    fullPage: true,
  });
  await selected
    .getByRole("button", { name: "精确授权 USDC 并成交", exact: true })
    .click();
  await expect(page.getByTestId("transaction-calls")).toContainText(
    '"method":"fillListing"',
  );
  await expect(page.getByTestId("transaction-calls")).toContainText(
    '"maximumGross":"1200000"',
  );
  await expect(selected).toContainText("剩余1 份");
});

test("L3: a fresh inactive listing cannot be filled even when its displayed snapshot was active", async ({
  page,
}) => {
  await page.goto("/test/browser/lightweight-ux.html?scenario=c2c");
  await page.locator(".folded-listings summary").click();
  await page.getByRole("button", { name: "选择此挂单", exact: true }).click();
  await page
    .getByRole("button", { name: "链上挂单已失效", exact: true })
    .click();
  await page
    .getByRole("button", { name: "精确授权 USDC 并成交", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("已失效");
  await expect(page.getByTestId("transaction-calls")).toBeEmpty();
});

test("L1/L3: missing rules do not block cancellation of an existing listing", async ({
  page,
}) => {
  await page.goto("/test/browser/lightweight-ux.html?scenario=c2c");
  await page.locator(".folded-listings summary").click();
  await page.getByRole("button", { name: "选择此挂单", exact: true }).click();
  await page.getByRole("button", { name: "规则暂不可用", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "精确授权 USDC 并成交", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "取消所选挂单", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "取消所选挂单", exact: true }).click();
  await expect(page.getByTestId("transaction-calls")).toContainText(
    '"method":"cancelListing"',
  );
  await expect(page.getByTestId("transaction-calls")).not.toContainText(
    '"method":"fillListing"',
  );
});

test("L3: at close high-price listings are visible and the insider risk is explicit", async ({
  page,
}) => {
  await page.goto("/test/browser/lightweight-ux.html?scenario=closed-c2c");
  await expect(page.locator(".listing-catalog article")).toBeVisible();
  await expect(page.locator(".folded-listings")).toHaveCount(0);
  await expect(
    page.getByText("封盘后内幕转让风险", { exact: false }),
  ).toBeVisible();
});

for (const scenario of ["void", "void-indexed", "void-no-indexer"]) {
  test(`L2: ${scenario} position links to the existing refund without auto-submitting`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/test/browser/lightweight-ux.html?scenario=${scenario}`);
    const card =
      scenario === "void-no-indexer"
        ? page.locator(".position-grid > div").filter({ hasText: "本金待退款" })
        : page.locator(".position-catalog article");
    await expect(card).toContainText("本金待退款");
    await page.screenshot({
      path: testInfo.outputPath("void-position.png"),
      fullPage: true,
    });
    await card.getByRole("link", { name: "去退还本金", exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`#/settlement/${UX_MARKET.address}$`),
    );
    await expect(page.getByTestId("transaction-calls")).toBeEmpty();
    await page
      .getByRole("button", { name: "规则暂不可用", exact: true })
      .click();
    await page.getByRole("button", { name: "退还本金", exact: true }).click();
    await expect(page.getByTestId("transaction-calls")).toContainText(
      json({ method: "refund", args: [UX_MARKET.address, UX_MARKET.creator] }),
    );
    if (scenario !== "void-indexed") {
      await page.getByRole("button", { name: "返回持仓", exact: true }).click();
      await expect(page.getByText("本金待退款", { exact: true })).toHaveCount(
        0,
      );
    }
  });
}

test("L4: no default result; changing or switching back invalidates confirmation", async ({
  page,
}, testInfo) => {
  await page.goto("/test/browser/lightweight-ux.html?scenario=settlement");
  const select = page.getByRole("combobox", { name: "获胜结果", exact: true });
  const resolve = page.getByRole("button", { name: "结算", exact: true });
  await expect(select).toHaveValue("");
  await expect(resolve).toBeDisabled();
  await select.selectOption("0");
  await page.getByRole("checkbox", { name: /我已核对上述市场/ }).check();
  await expect(resolve).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "创建者作废", exact: true }),
  ).toBeDisabled();
  await select.selectOption("1");
  await expect(resolve).toBeDisabled();
  await select.selectOption("0");
  await expect(resolve).toBeDisabled();
  await select.selectOption("1");
  await expect(page.locator(".settlement-confirmation")).toContainText(
    UX_RULES.question,
  );
  await expect(page.locator(".settlement-confirmation")).toContainText(
    UX_MARKET.address,
  );
  await expect(page.locator(".settlement-confirmation")).toContainText("NO");
  await page.getByRole("checkbox", { name: /确认结果为「NO」/ }).check();
  await page.screenshot({
    path: testInfo.outputPath("settlement-confirmation.png"),
    fullPage: true,
  });
  await resolve.click();
  await expect(page.getByTestId("transaction-calls")).toContainText(
    json({
      method: "resolve",
      args: [UX_MARKET.address, "1", `0x${"00".repeat(32)}`],
    }),
  );
});

test("L4: market/account changes reset the choice, and void has its own confirmation", async ({
  page,
}) => {
  await page.goto("/test/browser/lightweight-ux.html?scenario=settlement");
  const select = page.getByRole("combobox", { name: "获胜结果", exact: true });
  await select.selectOption("0");
  await page.getByRole("checkbox", { name: /我已核对上述市场/ }).check();
  await page.getByRole("button", { name: "切换市场", exact: true }).click();
  await expect(select).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "结算", exact: true }),
  ).toBeDisabled();
  await select.selectOption("1");
  await page.getByRole("checkbox", { name: /我已核对上述市场/ }).check();
  await page.getByRole("button", { name: "规则哈希不符", exact: true }).click();
  await expect(select).toHaveValue("");
  await expect(select).not.toContainText("YES");
  await expect(
    page.getByRole("button", { name: "结算", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "恢复规则", exact: true }).click();
  await select.selectOption("1");
  await page.getByRole("checkbox", { name: /我已核对上述市场/ }).check();
  await page.getByRole("button", { name: "切换账户", exact: true }).click();
  await expect(select).toHaveCount(0);
  await page.getByRole("button", { name: "切换账户", exact: true }).click();
  await expect(select).toHaveValue("");
  await page.getByRole("checkbox", { name: /我确认作废上述市场/ }).check();
  await page.getByRole("button", { name: "创建者作废", exact: true }).click();
  await expect(page.getByTestId("transaction-calls")).toContainText(
    '"method":"creatorVoid"',
  );
  await expect(page.getByTestId("transaction-calls")).not.toContainText(
    '"method":"resolve"',
  );
});

test("existing public result needs no wallet; winning holder can reach the existing claim", async ({
  page,
}, testInfo) => {
  await page.goto("/test/browser/lightweight-ux.html?scenario=winner-public");
  await expect(
    page.getByText("链上已终局，结算结果：NO。", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "去领取胜出款", exact: true }),
  ).toHaveCount(0);
  await page.goto("/test/browser/lightweight-ux.html?scenario=winner");
  await expect(page.getByRole("status")).toContainText("胜出款待领取");
  await page.screenshot({
    path: testInfo.outputPath("winner-result.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "去领取胜出款", exact: true }).click();
  await expect(page.getByTestId("transaction-calls")).toBeEmpty();
  await page.getByRole("button", { name: "领取胜出款", exact: true }).click();
  await expect(page.getByTestId("transaction-calls")).toContainText(
    '"method":"claimWinner"',
  );
});

test("L5: resolved bond is released then claimed, never auto-transferred by settlement", async ({
  page,
}, testInfo) => {
  await openBond(page);
  const panel = bondPanel(page);
  await expect(panel).toContainText("押金待退还");
  await expect(
    panel.getByRole("button", { name: "领取押金", exact: true }),
  ).toBeDisabled();
  await expect(page.getByTestId("transaction-calls")).toBeEmpty();
  await panel.screenshot({ path: testInfo.outputPath("bond-pending.png") });
  await panel.getByRole("button", { name: "释放押金", exact: true }).click();
  await expect(panel).toContainText("尚未转入钱包");
  await expect(
    panel.getByRole("button", { name: "释放押金", exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "领取押金", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("transaction-calls")).not.toContainText(
    '"method":"claimBondFor"',
  );
  await panel.screenshot({ path: testInfo.outputPath("bond-released.png") });
  await panel.getByRole("button", { name: "领取押金", exact: true }).click();
  await expect(panel).toContainText("押金已到账：5 USDC");
  await expect(panel).toContainText("不是单个市场的到账归属");
  await expect(panel.getByTestId("bond-state")).toContainText(
    "当前没有可领取押金",
  );
  await expect(panel.getByTestId("bond-state")).not.toContainText("继续领取");
  await expect(
    panel.getByRole("button", { name: "领取押金", exact: true }),
  ).toBeDisabled();
  await panel.screenshot({ path: testInfo.outputPath("bond-paid.png") });
});

for (const scenario of ["bond-void", "bond-zero", "bond-empty-timeout"]) {
  test(`L5: ${scenario} returns the creator bond without slashing`, async ({
    page,
  }) => {
    await openBond(page, scenario);
    const panel = bondPanel(page);
    await expect(panel.getByTestId("bond-state")).toContainText("押金待退还");
    await panel.getByRole("button", { name: "释放押金", exact: true }).click();
    await expect(panel).toContainText("押金已释放：5 USDC");
    await expect(
      panel.getByRole("button", { name: "领取押金", exact: true }),
    ).toBeEnabled();
  });
}

for (const action of ["resolve", "void"]) {
  test(`L5: ${action} success immediately refreshes the bond without auto-release`, async ({
    page,
  }) => {
    await openBond(page, "bond-open");
    const panel = bondPanel(page);
    await expect(panel.getByTestId("bond-state")).toContainText("尚未终局");
    if (action === "resolve") {
      await page
        .getByRole("combobox", { name: "获胜结果", exact: true })
        .selectOption("0");
      await page.getByRole("checkbox", { name: /我已核对上述市场/ }).check();
      await page.getByRole("button", { name: "结算", exact: true }).click();
    } else {
      await page.getByRole("checkbox", { name: /我确认作废上述市场/ }).check();
      await page
        .getByRole("button", { name: "创建者作废", exact: true })
        .click();
    }
    await expect(panel.getByTestId("bond-state")).toContainText("押金待退还");
    await expect(page.getByTestId("transaction-calls")).not.toContainText(
      "settleBond",
    );
  });
}

test("L5: timeout slashes only this market; other credited bonds remain claimable", async ({
  page,
}) => {
  await openBond(page, "bond-timeout");
  const panel = bondPanel(page);
  await expect(panel.getByTestId("bond-state")).toContainText("该盘押金应罚没");
  await page
    .getByRole("button", { name: "其他市场释放 3 USDC", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "领取押金", exact: true }),
  ).toBeEnabled();
  await panel
    .getByRole("button", { name: "将罚没押金转入奖励池", exact: true })
    .click();
  await expect(panel.getByTestId("bond-state")).toContainText("已罚没并转入");
  await panel.getByRole("button", { name: "领取押金", exact: true }).click();
  await expect(panel).toContainText("押金已到账：3 USDC");
});

test("L5: unknown reads never become zero or paid, missing rules do not block recovery", async ({
  page,
}) => {
  await openBond(page);
  const panel = bondPanel(page);
  await page
    .getByRole("button", { name: "押金 RPC 故障", exact: true })
    .click();
  await expect(panel.getByTestId("bond-state")).toContainText("未知");
  await expect(panel.locator(".bond-amounts")).not.toContainText("0 USDC");
  await expect(
    panel.getByRole("button", { name: "释放押金", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "规则暂不可用", exact: true }).click();
  await page.getByRole("button", { name: "恢复押金读取", exact: true }).click();
  await panel.getByRole("button", { name: "释放押金", exact: true }).click();
  await expect(panel).toContainText("押金已释放");
});

test("L5: pre-submit reads skip worker-released bonds and claims already consumed elsewhere", async ({
  page,
}) => {
  await openBond(page);
  const panel = bondPanel(page);
  await page
    .getByRole("button", { name: "worker 已释放押金", exact: true })
    .click();
  await panel.getByRole("button", { name: "释放押金", exact: true }).click();
  await expect(panel).toContainText("无需重复释放");
  await expect(page.getByTestId("transaction-calls")).toBeEmpty();
  await page
    .getByRole("button", { name: "余额已被其他交易领走", exact: true })
    .click();
  await panel.getByRole("button", { name: "领取押金", exact: true }).click();
  await expect(panel).toContainText("当前没有可领取押金");
  await expect(panel).not.toContainText("押金已到账：");
  await expect(page.getByTestId("transaction-calls")).toBeEmpty();
});

test("L5: successful payment survives refresh failure and uses actual aggregate event amount", async ({
  page,
}, testInfo) => {
  await openBond(page);
  const panel = bondPanel(page);
  await panel.getByRole("button", { name: "释放押金", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "领取押金", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "领取时追加一个原子单位", exact: true })
    .click();
  await page
    .getByRole("button", { name: "交易成功后刷新失败", exact: true })
    .click();
  await panel.getByRole("button", { name: "领取押金", exact: true }).click();
  await expect(panel).toContainText("押金已到账：5.000001 USDC");
  await expect(panel.getByTestId("bond-state")).toContainText("未知");
  await expect(
    panel.getByRole("button", { name: "领取押金", exact: true }),
  ).toBeDisabled();
  await panel.screenshot({
    path: testInfo.outputPath("bond-success-refresh-failed.png"),
  });
});

test("L5: uncertain receipt is looked up without repeating the write", async ({
  page,
}) => {
  await openBond(page);
  const panel = bondPanel(page);
  await page.getByRole("button", { name: "回执暂不可见", exact: true }).click();
  await panel.getByRole("button", { name: "释放押金", exact: true }).click();
  await expect(panel).toContainText("不会重复提交");
  await expect(
    panel.getByRole("button", { name: "领取押金", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "原交易已确认", exact: true }).click();
  await panel
    .getByRole("button", { name: "核对原交易结果", exact: true })
    .click();
  await expect(panel).toContainText("押金已释放：5 USDC");
  await expect(
    panel.getByRole("button", { name: "领取押金", exact: true }),
  ).toBeEnabled();
  expect(
    (await page.getByTestId("transaction-calls").textContent())?.match(
      /settleBond/g,
    ),
  ).toHaveLength(1);
});

test("L5: reload restores the unresolved identity; another account never inherits it", async ({
  page,
}) => {
  await openBond(page);
  await page.getByRole("button", { name: "回执暂不可见", exact: true }).click();
  await bondPanel(page)
    .getByRole("button", { name: "释放押金", exact: true })
    .click();
  await expect(bondPanel(page)).toContainText("原交易哈希");
  await page.reload();
  await expect(bondPanel(page)).toContainText("发现未核实的押金交易");
  await expect(
    bondPanel(page).getByRole("button", { name: "释放押金", exact: true }),
  ).toBeDisabled();
  await expect(page.getByTestId("transaction-calls")).toBeEmpty();
  await page.getByRole("button", { name: "切换账户", exact: true }).click();
  await expect(bondPanel(page)).not.toContainText("原交易哈希");
  await page.getByRole("button", { name: "切换账户", exact: true }).click();
  await expect(bondPanel(page)).toContainText("原交易哈希");
});

test("L5: an unknown wallet response without hash requires original transaction lookup", async ({
  page,
}) => {
  await openBond(page);
  const panel = bondPanel(page);
  await page
    .getByRole("button", { name: "钱包丢失提交哈希", exact: true })
    .click();
  await panel.getByRole("button", { name: "释放押金", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "领取押金", exact: true }),
  ).toBeDisabled();
  await panel
    .getByLabel("钱包中的原交易哈希")
    .fill(`0x${"1".padStart(64, "0")}`);
  await panel
    .getByRole("button", { name: "核对原交易结果", exact: true })
    .click();
  await expect(panel).toContainText("押金已释放：5 USDC");
  expect(
    (await page.getByTestId("transaction-calls").textContent())?.match(
      /settleBond/g,
    ),
  ).toHaveLength(1);
});

test("L5: explicit rejection and a reverted receipt never appear as paid", async ({
  page,
}) => {
  await openBond(page);
  const panel = bondPanel(page);
  await page.getByRole("button", { name: "拒绝押金签名", exact: true }).click();
  await panel.getByRole("button", { name: "释放押金", exact: true }).click();
  await expect(panel).toContainText("用户拒绝签名");
  await expect(panel).not.toContainText("原交易哈希");
  await page.getByRole("button", { name: "恢复押金读取", exact: true }).click();
  await page.getByRole("button", { name: "押金交易回滚", exact: true }).click();
  await panel.getByRole("button", { name: "释放押金", exact: true }).click();
  await expect(panel).toContainText("原押金交易已确认失败");
  await expect(panel.getByTestId("bond-state")).toContainText("押金待退还");
  await expect(panel).not.toContainText("押金已到账：");
});

test("L5: late reads cannot replace a new market, and receipt notices reset on chain changes", async ({
  page,
}) => {
  await openBond(page);
  await page.getByRole("button", { name: "延迟押金读取", exact: true }).click();
  await expect(bondPanel(page)).toHaveAttribute("aria-busy", "true");
  await page.getByRole("button", { name: "切换市场", exact: true }).click();
  await expect(bondPanel(page)).toContainText("7 USDC");
  await page.getByRole("button", { name: "返回旧读取", exact: true }).click();
  await expect(bondPanel(page).locator(".bond-amounts")).not.toContainText(
    "5 USDC",
  );
  await bondPanel(page)
    .getByRole("button", { name: "释放押金", exact: true })
    .click();
  await expect(bondPanel(page)).toContainText("押金已释放：7 USDC");
  await page.getByRole("button", { name: "切换测试链", exact: true }).click();
  await expect(bondPanel(page)).not.toContainText("押金已释放：7 USDC");
});

test("L5: browser storage denial does not block a fresh onchain bond exit", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "sessionStorage", {
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
  });
  await openBond(page);
  const panel = bondPanel(page);
  await expect(panel).toContainText("本页仍可操作");
  await panel.getByRole("button", { name: "释放押金", exact: true }).click();
  await expect(panel).toContainText("押金已释放：5 USDC");
  await panel.getByRole("button", { name: "领取押金", exact: true }).click();
  await expect(panel).toContainText("押金已到账：5 USDC");
});
