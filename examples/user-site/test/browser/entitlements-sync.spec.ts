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
  await expect(row(page)).toContainText("已处理");
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
  await page.getByRole("button", { name: "加载更多权益", exact: true }).click();
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
  await expect(row(page)).toContainText("已处理");
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
