import { test, expect, type Page } from "playwright/test";
import {
  A,
  H,
  appAccount,
  operation,
} from "../../../../offchain/app-core/test/fixtures.js";
import { computePnl } from "../../../../offchain/app-core/src/pnl.js";
import type { Operation } from "../../../../offchain/app-core/src/contracts.js";

const fixture =
  "/test/browser/fixture.html?entitlements-test=1#/ctusd-test/entitlements";
const confirmed: Operation = {
  ...operation,
  kind: "claim-early-bird",
  intent: { kind: "claim-early-bird", market: A(101) },
  state: "confirmed",
  blockNumber: "105",
  blockHash: H(105),
  transactionHash: H(205),
  userOperationHash: H(305),
  finality: "application-confirmed",
};
const snapshot = (block: number) => ({
  environment: appAccount.environment,
  deploymentId: appAccount.deploymentId,
  version: 1,
  epoch: "1",
  blockNumber: String(block),
  blockHash: H(block),
  timestamp: "1789142400",
  coverageStart: "1",
  complete: true,
  status: "active",
});
const earlyBird = (processed: boolean) => ({
  id: "early",
  market: A(101),
  kind: "early-bird",
  outcomeId: null,
  listingId: null,
  units: "0",
  amount: "40000",
  status: processed ? "claimed" : "claimable",
  reason: null,
});
const errors = new WeakMap<Page, string[]>();
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
  test.info().annotations.push({
    type: "proof",
    description:
      "Browser plugin not available; Chrome with intercepted local API responses, no wallet/signature/broadcast.",
  });
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  expect(await page.locator("vite-error-overlay").count()).toBe(0);
});

async function setup(page: Page, paginated = false) {
  const state = {
    operation: null as Operation | null,
    reportOperation: true,
    rightsBlock: 100,
    pnlBlock: 100,
    firstPageBlock: 100,
    rightsReads: 0,
    pnlReads: 0,
    submissions: 0,
    cursors: [] as string[],
    holdOperations: null as Promise<void> | null,
  };
  await page.route("**/ctusd/app/v1/operations**", async (route) => {
    await state.holdOperations;
    const url = new URL(route.request().url());
    const items =
      state.operation &&
      state.reportOperation &&
      url.searchParams.get("accountId") === appAccount.id
        ? [state.operation]
        : [];
    await route.fulfill({
      json: url.pathname.endsWith("/operations")
        ? { items }
        : { operation: state.operation },
    });
  });
  await page.route(
    "**/ctusd/indexer/public/v2/entitlements/**",
    async (route) => {
      state.rightsReads++;
      const url = new URL(route.request().url()),
        cursor = url.searchParams.get("cursor");
      const otherAccount = !url.pathname
        .toLowerCase()
        .endsWith(appAccount.address.toLowerCase());
      if (cursor) state.cursors.push(cursor);
      await route.fulfill({
        json:
          paginated && !cursor
            ? {
                items: [
                  {
                    ...earlyBird(false),
                    id: "fees",
                    kind: "fees",
                    market: null,
                    status: "conditional",
                    amount: "0",
                  },
                ],
                nextCursor: `page2:${state.firstPageBlock}`,
                snapshot: snapshot(state.firstPageBlock),
              }
            : {
                items: [earlyBird(!otherAccount && state.rightsBlock >= 105)],
                nextCursor: null,
                snapshot: snapshot(state.rightsBlock),
              },
      });
    },
  );
  await page.route("**/ctusd/indexer/public/v2/pnl/**", async (route) => {
    state.pnlReads++;
    await route.fulfill({
      json: {
        pnl: {
          ...computePnl(appAccount.address, [], { coverageComplete: true }),
          realizedNet: state.pnlBlock >= 105 ? "40000" : "0",
          knownRealizedNet: state.pnlBlock >= 105 ? "40000" : "0",
        },
        snapshot: snapshot(state.pnlBlock),
      },
    });
  });
  await page.route("**/test/entitlement-submit", async (route) => {
    state.submissions++;
    state.operation = confirmed;
    await route.fulfill({ json: confirmed });
  });
  return state;
}
async function open(page: Page) {
  await page.goto(fixture);
  await expect(page).toHaveTitle(/Cpredict/);
  await expect(page).toHaveURL(/ctusd-test\/entitlements$/);
  await expect(
    page.getByRole("heading", { name: "持仓与权益", exact: true }),
  ).toBeVisible();
}
const row = (page: Page) =>
  page.getByRole("row").filter({ hasText: "早鸟返还" });
async function tick(page: Page) {
  await page.clock.fastForward(5100);
}

test("confirmed claims stay blocked while snapshots lag and rights plus PnL refresh without reloading", async ({
  page,
}) => {
  const state = await setup(page);
  state.reportOperation = false; // Exercise the gap before the list poll sees the modal record.
  await open(page);
  await row(page).getByRole("button", { name: "领取", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "确认并继续", exact: true }).click();
  await expect(dialog).toContainText("已确认");
  await dialog
    .locator(".dialog-footer")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(row(page)).toContainText("已确认，等待同步");
  await expect(
    row(page).getByRole("button", { name: "等待同步", exact: true }),
  ).toBeDisabled();
  await expect(
    row(page).getByRole("button", { name: "领取", exact: true }),
  ).toHaveCount(0);
  await expect(
    row(page).getByRole("link", { name: "查询原操作" }),
  ).toHaveAttribute("href", new RegExp(confirmed.id));
  await page.screenshot({
    path: test.info().outputPath("waiting-for-entitlements.png"),
    fullPage: true,
  });

  const reads = state.rightsReads;
  await tick(page);
  await expect.poll(() => state.rightsReads).toBeGreaterThan(reads);
  await expect(row(page)).toContainText("已确认，等待同步");
  state.rightsBlock = 105;
  await tick(page);
  await expect(row(page)).toHaveCount(0);
  await expect(
    page.getByText(
      "交易已确认，权益与收益正在等待同步。页面会自动更新，请勿重复领取。",
      { exact: true },
    ),
  ).toBeVisible();
  state.pnlBlock = 105;
  await tick(page);
  await expect(
    page.locator(".stat-card").filter({ hasText: "已实现净收益" }),
  ).toContainText("0.04");
  await expect(
    page.getByText(
      "交易已确认，权益与收益正在等待同步。页面会自动更新，请勿重复领取。",
      { exact: true },
    ),
  ).toHaveCount(0);
  await expect(
    row(page).getByRole("button", { name: "领取", exact: true }),
  ).toHaveCount(0);
  expect(state.submissions).toBe(1);
  await page.screenshot({
    path: test.info().outputPath("entitlements-synchronized.png"),
    fullPage: true,
  });
});

test("early-bird claims leave no zero refund or winner placeholders but preserve real winner payouts", async ({
  page,
}) => {
  const state = await setup(page);
  let winnerAmount = "0";
  await page.unroute("**/ctusd/indexer/public/v2/entitlements/**");
  await page.route(
    "**/ctusd/indexer/public/v2/entitlements/**",
    async (route) => {
      state.rightsReads++;
      await route.fulfill({
        json: {
          items: [
            earlyBird(state.rightsBlock >= 105),
            {
              ...earlyBird(false),
              id: "principal-refund",
              kind: "refund",
              units: "10000000",
              amount: "0",
              status: "conditional",
            },
            {
              ...earlyBird(false),
              id: "winner",
              kind: "winner",
              units: winnerAmount === "0" ? "0" : "1000000",
              amount: winnerAmount,
              status: winnerAmount === "0" ? "conditional" : "claimable",
            },
          ],
          nextCursor: null,
          snapshot: snapshot(state.rightsBlock),
        },
      });
    },
  );
  await open(page);
  const refund = page
    .getByRole("row")
    .filter({ has: page.getByText("本金退款", { exact: true }) });
  const winner = page
    .getByRole("row")
    .filter({ has: page.getByText("赢家收益", { exact: true }) });
  await expect(refund).toHaveCount(0);
  await expect(winner).toHaveCount(0);
  await row(page).getByRole("button", { name: "领取", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "确认并继续", exact: true }).click();
  await expect(dialog).toContainText("已确认");
  await dialog
    .locator(".dialog-footer")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(row(page)).toContainText("已确认，等待同步");
  state.rightsBlock = 105;
  state.pnlBlock = 105;
  await tick(page);
  await expect(row(page)).toHaveCount(0);
  await expect(refund).toHaveCount(0);
  await expect(winner).toHaveCount(0);
  await expect(page.getByText("暂无待处理权益", { exact: true })).toBeVisible();
  await expect(page.getByText("待满足条件", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("early-bird-completed-no-placeholders.png"),
    fullPage: true,
  });
  winnerAmount = "2000000";
  await page.clock.fastForward(15100);
  await expect(winner).toHaveCount(1);
  await expect(winner).toContainText("2 ctUSD");
  await expect(
    winner.getByRole("button", { name: "领取", exact: true }),
  ).toBeEnabled();
  await expect(refund).toHaveCount(0);
  expect(state.submissions).toBe(1);
});

test("a returnable creator bond settles and arrives from one claim action", async ({
  page,
}) => {
  await setup(page);
  await page.unroute("**/ctusd/indexer/public/v2/entitlements/**");
  await page.route(
    "**/ctusd/indexer/public/v2/entitlements/**",
    async (route) => {
      await route.fulfill({
        json: {
          items: [
            {
              id: "creator-bond",
              market: A(101),
              kind: "bond",
              outcomeId: null,
              listingId: null,
              units: null,
              amount: "1000000",
              status: "claimable",
              reason: "settle_and_claim_bond",
            },
          ],
          nextCursor: null,
          snapshot: snapshot(100),
        },
      });
    },
  );
  let submitted: unknown;
  await page.unroute("**/test/entitlement-submit");
  await page.route("**/test/entitlement-submit", async (route) => {
    submitted = await route.request().postDataJSON();
    await route.fulfill({
      json: {
        ...confirmed,
        kind: "settle-bond-and-claim",
        intent: { kind: "settle-bond-and-claim", market: A(101) },
      },
    });
  });
  await open(page);
  const bond = page.getByRole("row").filter({ hasText: "创作者押金" });
  await expect(bond).toContainText("将结算并领取押金，一笔操作到账。");
  await bond.getByRole("button", { name: "领取押金", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("本次将结算并领取押金，确认后一次到账。");
  await dialog.getByRole("button", { name: "确认并继续", exact: true }).click();
  await expect(dialog).toContainText("已确认");
  expect(submitted).toEqual({
    intent: { kind: "settle-bond-and-claim", market: A(101) },
  });
  await page.screenshot({
    path: test.info().outputPath("creator-bond-one-step.png"),
    fullPage: true,
  });
});

test("a timeout creator bond updates without any creator action before or after funding", async ({
  page,
}) => {
  const state = await setup(page);
  await page.unroute("**/ctusd/indexer/public/v2/pnl/**");
  await page.route("**/ctusd/indexer/public/v2/pnl/**", async (route) => {
    await route.fulfill({
      json: {
        pnl: computePnl(appAccount.address, [], { coverageComplete: true }),
        snapshot: snapshot(state.pnlBlock),
      },
    });
  });
  await page.unroute("**/ctusd/indexer/public/v2/entitlements/**");
  await page.route(
    "**/ctusd/indexer/public/v2/entitlements/**",
    async (route) => {
      const funded = state.rightsBlock >= 105;
      await route.fulfill({
        json: {
          items: [
            {
              id: "creator-bond",
              market: A(101),
              kind: "bond",
              outcomeId: null,
              listingId: null,
              units: null,
              amount: "0",
              status: funded ? "claimed" : "conditional",
              reason: funded
                ? "bond_slashed_into_timeout_pool"
                : "bond_slashed_pending_timeout_funding",
            },
          ],
          nextCursor: null,
          snapshot: snapshot(state.rightsBlock),
        },
      });
    },
  );
  await open(page);
  const bond = page.getByRole("row").filter({ hasText: "创作者押金" });
  await expect(bond).toContainText(
    "市场已超时作废，押金已罚没，待注入超时补偿池，无法领取。",
  );
  await expect(bond.locator(".badge")).toHaveText("已罚没，待注入");
  await expect(bond.getByRole("button")).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("timeout-bond-pending.png"),
    fullPage: true,
  });
  state.rightsBlock = 105;
  state.pnlBlock = 105;
  await page.clock.fastForward(15100);
  await expect(bond).toHaveCount(0);
  await expect(bond.getByRole("button")).toHaveCount(0);
  expect(state.submissions).toBe(0);
  await page.screenshot({
    path: test.info().outputPath("timeout-bond-funded.png"),
    fullPage: true,
  });
});

test("a timeout participant sees principal and expected bonus together before refunding", async ({
  page,
}) => {
  const state = await setup(page);
  await page.unroute("**/ctusd/indexer/public/v2/entitlements/**");
  await page.route(
    "**/ctusd/indexer/public/v2/entitlements/**",
    async (route) => {
      const refunded = state.rightsBlock >= 105;
      const base = {
        market: A(101),
        outcomeId: null,
        listingId: null,
        units: "10000000",
      };
      await route.fulfill({
        json: {
          items: [
            {
              ...base,
              id: "refund",
              kind: "refund",
              amount: "10000000",
              status: refunded ? "claimed" : "claimable",
              reason: "principal_first_then_timeout_compensation",
            },
            {
              ...base,
              id: "timeout",
              kind: "timeout-bonus",
              amount: "5000000",
              status: refunded ? "claimable" : "conditional",
              reason: refunded ? null : "refund_before_timeout_compensation",
            },
          ],
          nextCursor: null,
          snapshot: snapshot(state.rightsBlock),
        },
      });
    },
  );
  await page.unroute("**/test/entitlement-submit");
  await page.route("**/test/entitlement-submit", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      intent: { kind: "refund", market: A(101) },
    });
    state.operation = {
      ...confirmed,
      kind: "refund",
      intent: { kind: "refund", market: A(101) },
    };
    await route.fulfill({ json: state.operation });
  });
  await open(page);
  const refund = page
    .getByRole("row")
    .filter({ has: page.getByText("本金退款", { exact: true }) });
  const bonus = page
    .getByRole("row")
    .filter({ has: page.getByText("超时补偿", { exact: true }) });
  await expect(refund).toContainText("10 ctUSD");
  await expect(bonus).toContainText("5 ctUSD");
  await expect(bonus).toContainText("预计补偿");
  await expect(bonus).toContainText("待领取本金");
  await expect(
    bonus.getByRole("button", { name: "领取", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("timeout-participant-before-refund.png"),
    fullPage: true,
  });
  await refund.getByRole("button", { name: "领取", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "确认并继续", exact: true }).click();
  await expect(dialog).toContainText("已确认");
  await dialog
    .locator(".dialog-footer")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  state.rightsBlock = 105;
  state.pnlBlock = 105;
  await tick(page);
  await expect(refund).toHaveCount(0);
  await expect(
    bonus.getByRole("button", { name: "领取", exact: true }),
  ).toBeEnabled();
  await expect(bonus).not.toContainText("预计补偿");
});

test("another account does not inherit a confirmed claim waiting for synchronization", async ({
  page,
}) => {
  const state = await setup(page);
  state.operation = confirmed;
  await open(page);
  await expect(row(page)).toContainText("已确认，等待同步");
  await page.getByRole("button", { name: "切换夹具账户", exact: true }).click();
  await expect(
    row(page).getByRole("button", { name: "领取", exact: true }),
  ).toBeEnabled();
  await expect(row(page)).not.toContainText("已确认，等待同步");
  await page.getByRole("button", { name: "切换夹具账户", exact: true }).click();
  await expect(
    row(page).getByRole("button", { name: "等待同步", exact: true }),
  ).toBeDisabled();
  expect(state.submissions).toBe(0);
});

test("loaded cursor pages refresh from the first page and keep each old snapshot protected", async ({
  page,
}) => {
  const state = await setup(page, true);
  state.operation = confirmed;
  await open(page);
  await expect.poll(() => state.cursors.includes("page2:100")).toBe(true);
  await expect(row(page)).toContainText("已确认，等待同步");
  state.firstPageBlock = 105;
  await tick(page);
  await expect.poll(() => state.cursors.includes("page2:105")).toBe(true);
  await expect(
    row(page).getByRole("button", { name: "等待同步", exact: true }),
  ).toBeDisabled();
  state.rightsBlock = 105;
  state.pnlBlock = 105;
  await tick(page);
  await expect(row(page)).toHaveCount(0);
  expect(state.submissions).toBe(0);
});

test("claim actions wait for the operation lookup and unknown results never become retryable", async ({
  page,
}) => {
  const state = await setup(page);
  let release!: () => void;
  state.holdOperations = new Promise<void>((resolve) => {
    release = resolve;
  });
  await open(page);
  await expect(
    row(page).getByRole("button", { name: "正在核对操作", exact: true }),
  ).toBeDisabled();
  state.operation = {
    ...confirmed,
    state: "unknown",
    blockNumber: null,
    blockHash: null,
    transactionHash: null,
    reason: "provider_result_unknown",
  };
  release();
  await expect(row(page)).toContainText("结果待核对");
  state.rightsBlock = 999;
  await tick(page);
  await expect(row(page)).toContainText("结果待核对");
  await expect(
    row(page).getByRole("button", { name: "领取", exact: true }),
  ).toHaveCount(0);
  expect(state.submissions).toBe(0);
});

test("completed pages are skipped and only current holdings and unfinished rights remain", async ({
  page,
}) => {
  const state = await setup(page);
  const cursors: Array<string | null> = [];
  await page.unroute("**/ctusd/indexer/public/v2/entitlements/**");
  await page.route(
    "**/ctusd/indexer/public/v2/entitlements/**",
    async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      cursors.push(cursor);
      const processed = state.rightsBlock >= 105;
      await route.fulfill({
        json: {
          items: !cursor
            ? Array.from({ length: 20 }, (_, i) => ({
                ...earlyBird(true),
                id: `completed-${i}`,
              }))
            : [
                earlyBird(processed),
                ...["winner", "refund", "early-bird"].map((kind) => ({
                  ...earlyBird(false),
                  id: `zero-${kind}`,
                  kind,
                  units: "1000000",
                  amount: "0",
                  status: "conditional",
                })),
                {
                  ...earlyBird(false),
                  id: "holding",
                  kind: "holding",
                  units: processed ? "0" : "1000000",
                  amount: null,
                  status: "conditional",
                },
                {
                  ...earlyBird(false),
                  id: "empty-holding",
                  kind: "holding",
                  units: "0",
                  amount: null,
                  status: "conditional",
                },
                {
                  ...earlyBird(false),
                  id: "empty-fees",
                  market: null,
                  kind: "fees",
                  amount: "0",
                  status: "conditional",
                },
                {
                  ...earlyBird(false),
                  id: "fees",
                  market: null,
                  kind: "fees",
                  amount: "1000000",
                  status: "claimable",
                },
                {
                  ...earlyBird(false),
                  id: "uncertain",
                  kind: "refund",
                  amount: null,
                  status: "unknown",
                  reason: "chain_read_unavailable",
                },
              ],
          nextCursor: cursor ? null : "active-page",
          snapshot: snapshot(state.rightsBlock),
        },
      });
    },
  );
  await page.unroute("**/ctusd/indexer/public/v2/pnl/**");
  await page.route("**/ctusd/indexer/public/v2/pnl/**", async (route) => {
    await route.fulfill({
      json: {
        pnl: {
          ...computePnl(appAccount.address, [], { coverageComplete: true }),
          lots: [
            {
              market: A(101),
              outcomeId: "0",
              units: state.rightsBlock >= 105 ? "0" : "1000000",
              escrowUnits: "0",
              knownCost: "1000000",
              costComplete: true,
            },
            {
              market: A(101),
              outcomeId: "1",
              units: "0",
              escrowUnits: "0",
              knownCost: "0",
              costComplete: true,
            },
          ],
        },
        snapshot: snapshot(state.rightsBlock),
      },
    });
  });
  await open(page);
  await expect(row(page)).toHaveCount(1);
  await expect.poll(() => cursors.includes("active-page")).toBe(true);
  await expect(page.getByText("已处理", { exact: true })).toHaveCount(0);
  const holding = page
    .getByRole("row")
    .filter({ has: page.getByText("普通持仓", { exact: true }) });
  await expect(holding).toHaveCount(1);
  const fee = page
    .getByRole("row")
    .filter({ has: page.getByText("费用收入", { exact: true }) });
  await expect(fee).toHaveCount(1);
  await expect(
    fee.getByRole("button", { name: "领取", exact: true }),
  ).toBeEnabled();
  const uncertain = page
    .getByRole("row")
    .filter({ has: page.getByText("本金退款", { exact: true }) });
  await expect(uncertain).toHaveCount(1);
  await expect(uncertain).toContainText("待核对");
  await expect(page.getByText("赢家收益", { exact: true })).toHaveCount(0);
  const costs = page.locator("section").filter({
    has: page.getByRole("heading", { name: "持仓成本明细", exact: true }),
  });
  await expect(costs.getByRole("row")).toHaveCount(2);
  state.rightsBlock = 105;
  state.pnlBlock = 105;
  await page.clock.fastForward(15100);
  await expect(row(page)).toHaveCount(0);
  await expect(holding).toHaveCount(0);
  await expect(costs).toHaveCount(0);
  await expect(uncertain).toHaveCount(1);
  await expect(uncertain).toContainText("待核对");
  await expect(page.getByText("赢家收益", { exact: true })).toHaveCount(0);
  await expect(
    fee.getByRole("button", { name: "领取", exact: true }),
  ).toBeEnabled();
  expect(state.submissions).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("active-rights-only.png"),
    fullPage: true,
  });
});
