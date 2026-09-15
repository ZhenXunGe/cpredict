import { test, expect, type Page } from "playwright/test";
import {
  A,
  H,
  appAccount,
  operation,
} from "../../../../offchain/app-core/test/fixtures.js";
import { operationSchema } from "../../../../offchain/app-core/src/contracts.js";
import { ledgerFactSchema } from "../../../../offchain/app-core/src/ledger-contracts.js";

const fixture = "/test/browser/fixture.html?history-test=1#/ctusd-test/history";
const titles = [
  "公开测试：决赛是否在周日结束？",
  "公开测试：最终结果是否为甲方获胜？",
  "公开测试：销量能否达到目标？",
];
const intents = [
  {
    kind: "buy",
    market: A(101),
    outcomeId: "0",
    units: "2000000",
    minUnits: "1000000",
    maxPayment: "2000000",
    deadline: "1999999999",
  },
  { kind: "claim-winner", market: A(102) },
  {
    kind: "create-listing",
    market: A(103),
    outcomeId: "1",
    units: "2500000",
    unitPrice: "1500000",
    expiresAt: "1999999999",
  },
];
const ops = intents.map((intent, i) =>
  operationSchema.parse({
    ...operation,
    id: `20000000-0000-4000-8000-00000000000${i + 1}`,
    kind: intent.kind,
    intent,
    state: "confirmed",
    userOperationHash: H(301 + i),
    transactionHash: H(201 + i),
    blockNumber: "105",
    blockHash: H(105),
    finality: "application-confirmed",
  }),
);
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
const facts = ops.map((o, i) =>
  ledgerFactSchema.parse({
    id: `fact-${i}`,
    kind: ["primary-buy", "winner-claimed", "listing-created"][i],
    blockNumber: "105",
    blockHash: H(105),
    transactionHash: o.transactionHash,
    transactionIndex: i,
    logIndex: 5,
    factIndex: 0,
    timestamp: "1789142400",
    market: A(101 + i),
    owner: appAccount.address,
    counterparty: null,
    outcomeId: "0",
    listingId: i === 2 ? H(55) : null,
    units: ["1250000", "1200000", "2500000"][i],
    amount: ["1250000", "4200000", null][i],
    extra: i === 2 ? { unitPrice: "1500000" } : {},
  }),
);
const errors = new WeakMap<object, string[]>();
test.beforeEach(async ({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on("pageerror", (e) => messages.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") messages.push(m.text());
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:(?:4206|4207)\/)/, (route) =>
    route.abort(),
  );
  await page.clock.install();
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
});
async function setup(page: Page) {
  const state = { indexed: true, missingPrice: false, missingName: false };
  await page.route("**/ctusd/app/v1/operations**", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    return route.fulfill({
      json:
        id === "operations"
          ? { items: ops, nextCursor: null }
          : { operation: ops.find((o) => o.id === id) },
    });
  });
  await page.route("**/ctusd/indexer/public/v2/markets/**", (route) => {
    const addr = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const i = [A(101), A(102), A(103)].findIndex(
      (a) => a.toLowerCase() === addr.toLowerCase(),
    );
    return route.fulfill({
      json: {
        chainId: 421614,
        market: addr,
        creator: appAccount.address,
        creatorTreasury: null,
        outcomeCount: 2,
        closeAt: "1999990000",
        createdAt: null,
        eventStartsAt: null,
        outcomeDeadlineAt: null,
        resolutionWindow: null,
        rulesHash: null,
        metadataUri: null,
        resolutionSourceHash: null,
        resolutionSourceUri: null,
        featureFlags: null,
        marketPrimaryCap: null,
        primaryFilledUnits: "0",
        primaryPayment: "0",
        creatorBond: "0",
        state: 0,
        voidReason: 0,
        winningOutcome: null,
        evidenceHash: null,
        createdBlock: "1",
        updatedBlock: "105",
        confirmationStatus: "confirmed",
        question: state.missingName ? null : titles[i],
      },
    });
  });
  await page.route("**/ctusd/indexer/public/v2/activity/**", (route) => {
    const query = new URL(route.request().url()).searchParams;
    const tx = query.get("transactionHash");
    const marketQuery = query.get("marketQuery");
    const address = query.get("market");
    const rows = facts.map((f) =>
      state.missingPrice && f.kind === "listing-created"
        ? { ...f, extra: {} }
        : f,
    );
    const i = ops.findIndex((o) => o.transactionHash === tx);
    return route.fulfill({
      json: {
        items: !tx
          ? rows.filter(
              (f, index) =>
                (!marketQuery || titles[index]!.includes(marketQuery)) &&
                (!address || f.market?.toLowerCase() === address.toLowerCase()),
            )
          : !state.indexed
            ? []
            : [
                rows[i],
                {
                  ...rows[i],
                  id: `marker-${i}`,
                  kind: "user-operation",
                  logIndex: 6,
                  market: null,
                  amount: "1000",
                  extra: { userOpHash: ops[i]!.userOperationHash },
                },
              ],
        nextCursor: null,
        snapshot,
      },
    });
  });
  await page.route("**/ctusd/indexer/public/v2/pnl/**", (route) =>
    route.fulfill({ json: { items: [], snapshot } }),
  );
  return state;
}

test("operation records show actual purchases, claimed payouts and listing amounts", async ({
  page,
}) => {
  await setup(page);
  await page.goto(fixture);
  await expect(page).toHaveTitle(/Cpredict/);
  const progress = page.locator("section").filter({
    has: page.getByRole("heading", { name: "操作进度", exact: true }),
  });
  for (let i = 0; i < ops.length; i++) {
    const row = progress.getByRole("row").filter({
      has: page.getByRole("link", { name: titles[i]!, exact: true }),
    });
    await row.getByRole("button", { name: "查询原操作", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const details = dialog.getByRole("region", {
      name: "业务明细",
      exact: true,
    });
    await expect(
      details.getByRole("link", { name: titles[i]!, exact: true }),
    ).toBeVisible();
    if (i === 0) {
      await expect(details).toContainText("实际购买份数");
      await expect(details).toContainText("1.25");
      await expect(details).not.toContainText("申请购买 2");
    }
    if (i === 1) {
      await expect(details).toContainText("实际领取金额");
      await expect(details).toContainText("4.2");
      await expect(details).toContainText("不等同于");
      await page.screenshot({
        path: test.info().outputPath("claim-history-details.png"),
      });
    }
    if (i === 2) {
      await expect(details).toContainText("挂单份数");
      await expect(details).toContainText("2.5");
      await expect(details).toContainText("1.5");
      await expect(details).toContainText("3.75");
      await expect(details).toContainText("尚非成交收入");
    }
    await dialog
      .getByRole("button", { name: "关闭", exact: true })
      .last()
      .click();
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("ledger history shows market names, units and priced listing totals", async ({
  page,
}) => {
  await setup(page);
  await page.goto(fixture);
  const listing = page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: "查看", exact: true }) })
    .filter({ hasText: titles[2]! });
  await expect(listing).toContainText("2.5");
  await expect(listing).toContainText("3.75");
  await listing.getByRole("button", { name: "查看", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(titles[2]!);
  await expect(dialog).toContainText("挂单单价（每份）");
  await expect(dialog).toContainText("3.75");
  await expect(dialog.getByRole("button", { name: /复制/ })).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("listing-history-details.png"),
  });
});

test("unsynchronized claims and incomplete listing data never become zero or estimated receipts", async ({
  page,
}) => {
  const state = await setup(page);
  state.indexed = false;
  await page.goto(`${fixture}?operation=${ops[1]!.id}`);
  const details = page
    .getByRole("dialog")
    .getByRole("region", { name: "业务明细", exact: true });
  await expect(details).toContainText("等待链上明细同步");
  await expect(details).not.toContainText("实际领取金额");
  state.indexed = true;
  await page.clock.fastForward(5100);
  await expect(details).toContainText("4.2");
  state.missingPrice = true;
  state.missingName = true;
  await page.goto("about:blank");
  await page.goto(`${fixture}?operation=${ops[2]!.id}`);
  await expect(details).toContainText("名称暂不可用");
  await expect(details).toContainText("未知");
  await expect(details).not.toContainText("3.75");
});

test("history searches market names and retains exact address filtering", async ({
  page,
}) => {
  await setup(page);
  await page.goto(fixture);
  const ledger = page
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "已确认链上历史", exact: true }),
    });
  await page.getByLabel("市场名称或地址").fill(titles[1]!);
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await expect(
    ledger.getByRole("button", { name: "查看", exact: true }),
  ).toHaveCount(1);
  await expect(ledger).toContainText(titles[1]!);
  await page.getByLabel("市场名称或地址").fill(A(103));
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await expect(
    ledger.getByRole("button", { name: "查看", exact: true }),
  ).toHaveCount(1);
  await expect(ledger).toContainText(titles[2]!);
  await page.getByLabel("市场名称或地址").fill("不存在的市场");
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await expect(
    ledger.getByText("此范围内还没有记录", { exact: true }),
  ).toBeVisible();
});
