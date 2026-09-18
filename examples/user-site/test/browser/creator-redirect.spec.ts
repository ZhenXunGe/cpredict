import { test, expect, type Page } from "playwright/test";
import {
  H,
  A,
  env,
  appAccount,
  operation,
} from "../../../../offchain/app-core/test/fixtures.js";
import {
  environmentKey,
  intentSchema,
  type Operation,
} from "../../../../offchain/app-core/src/contracts.js";

const intent = intentSchema.parse({
  kind: "create-market",
  userSalt: H(70),
  maxPayment: "10000000",
  params: {
    rulesHash: H(71),
    metadataURI: "https://example.com/rules.json",
    resolutionSourceHash: H(72),
    resolutionSourceURI: "https://example.com/source",
    outcomeCount: 2,
    closeAt: "2000000000",
    eventStartsAt: "0",
    outcomeDeadlineAt: "2000003600",
    creatorTreasury: appAccount.address,
    deploymentMode: 0,
    featureFlags: "0",
    creatorRakeBps: 200,
    creatorC2CFeeBps: 0,
    perUserPrimaryCap: "10000000",
    marketPrimaryCap: "20000000",
    minimumPrimaryUnits: "1000000",
    minimumC2CUnits: "1000000",
    creatorBond: "10000000",
  },
});

async function setup(page: Page, initial: Operation["state"]) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:(?:4206|4207)\/)/, (route) =>
    route.abort(),
  );
  await page.clock.install();
  let record: Operation = {
    ...operation,
    kind: "create-market",
    intent,
    state: initial,
    blockNumber: "100",
  };
  let submissions = 0;
  await page.route("**/test/creator-submit", async (route) => {
    submissions++;
    expect(route.request().postDataJSON().intent).toEqual(intent);
    await route.fulfill({ json: record });
  });
  await page.route("**/ctusd/app/v1/operations/**", (route) =>
    route.fulfill({ json: { operation: record } }),
  );
  let indexed = false;
  let marketReads = 0;
  await page.route("**/ctusd/indexer/public/v2/markets?**", (route) => {
    marketReads++;
    return route.fulfill({
      json: {
        items: indexed
          ? [
              {
                chainId: 421614,
                market: A(101),
                creator: appAccount.address,
                creatorTreasury: appAccount.address,
                outcomeCount: 2,
                closeAt: "2000000000",
                createdAt: "1789600000",
                eventStartsAt: "0",
                outcomeDeadlineAt: "2000003600",
                resolutionWindow: "3600",
                rulesHash: H(71),
                metadataUri: "https://example.com/rules.json",
                resolutionSourceHash: H(72),
                resolutionSourceUri: "https://example.com/source",
                featureFlags: "0",
                marketPrimaryCap: "20000000",
                primaryFilledUnits: "0",
                primaryPayment: "0",
                creatorBond: "10000000",
                state: 0,
                voidReason: 0,
                winningOutcome: null,
                evidenceHash: null,
                createdBlock: "100",
                updatedBlock: "100",
                confirmationStatus: "confirmed",
                question: "刚创建的测试市场",
              },
            ]
          : [],
        nextCursor: null,
      },
    });
  });
  await page.addInitScript(
    ({ key, draft }) => sessionStorage.setItem(key, JSON.stringify(draft)),
    {
      key: `cpredict-draft:${environmentKey(env)}`,
      draft: {
        id: "10000000-0000-4000-8000-000000000070",
        intent,
        summary: [
          { label: "市场问题", value: "创建确认后是否返回创作者中心？" },
        ],
        feeNote: "浏览器夹具，无真实签名",
        path: "/ctusd-test/creator/new",
        accountId: appAccount.id,
        identityKey: "did:privy:fixture",
      },
    },
  );
  // Resume the real creation confirmation after rules publication; submission
  // and polling use local intercepted responses, never a wallet or chain.
  await page.goto(
    "/test/browser/fixture.html?creator-redirect=1#/ctusd-test/creator/new",
  );
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "确认并继续", exact: true }).click();
  await expect.poll(() => submissions).toBe(1);
  return {
    indexed() {
      indexed = true;
    },
    reads() {
      return marketReads;
    },
    update(state: Operation["state"]) {
      record = { ...record, state };
    },
    verify() {
      expect(submissions).toBe(1);
      expect(errors).toEqual([]);
    },
  };
}

test("confirmed creation shows success then refreshes the creator list through indexer lag", async ({
  page,
}) => {
  const state = await setup(page, "confirmed");
  await expect(
    page.getByRole("dialog", { name: "市场创建成功", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/#\/ctusd-test\/creator\/new$/);
  await page.screenshot({ path: test.info().outputPath("creation-success.png"), fullPage: true });
  await page.getByRole("button", { name: "查看我创建的市场" }).click();
  await expect(page).toHaveURL(/#\/ctusd-test\/creator$/);
  await expect(
    page.getByRole("heading", { name: "创作者中心", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "我创建的市场", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText("市场已创建成功，正在同步到列表。", { exact: false }),
  ).toBeVisible();
  const readsBefore = state.reads();
  state.indexed();
  await page.clock.fastForward(4000);
  await expect(
    page.getByRole("link", { name: "刚创建的测试市场", exact: true }),
  ).toBeVisible();
  expect(state.reads()).toBeGreaterThan(readsBefore);
  await expect(
    page.getByText("市场已创建成功，正在同步到列表。", { exact: false }),
  ).toHaveCount(0);

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("created-market-center.png"),
    fullPage: true,
  });
  state.verify();
});

test("submitted, confirming and unknown creation stay until confirmed polling arrives", async ({
  page,
}) => {
  const state = await setup(page, "submitted");
  for (const [status, copy] of [
    ["submitted", "已提交"],
    ["confirming", "链上确认中"],
    ["unknown", "结果未知"],
  ] as const) {
    state.update(status);
    await page.clock.fastForward(4000);
    await expect(
      page.getByRole("dialog").getByText(copy, { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/#\/ctusd-test\/creator\/new$/);
  }
  state.update("confirmed");
  await page.clock.fastForward(4000);
  await expect(
    page.getByRole("dialog", { name: "市场创建成功", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/#\/ctusd-test\/creator\/new$/);
  await page.getByRole("button", { name: "查看我创建的市场" }).click();
  await expect(page).toHaveURL(/#\/ctusd-test\/creator$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  state.verify();
});

for (const status of ["reverted", "cancelled"] as const)
  test(`${status} creation does not navigate or resubmit`, async ({ page }) => {
    const state = await setup(page, status);
    await page.clock.fastForward(10000);
    await expect(page).toHaveURL(/#\/ctusd-test\/creator\/new$/);
    await expect(
      page
        .getByRole("dialog")
        .getByText(status === "reverted" ? "链上已回滚" : "已取消", {
          exact: true,
        }),
    ).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "市场创建成功", exact: true }),
    ).toHaveCount(0);
    state.verify();
  });
