import { test, expect, type Page } from "playwright/test";
import {
  H,
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
  return {
    update(state: Operation["state"]) {
      record = { ...record, state };
    },
    verify() {
      expect(submissions).toBe(1);
      expect(errors).toEqual([]);
    },
  };
}

test("confirmed creation opens the creator center and closes confirmation", async ({
  page,
}) => {
  const state = await setup(page, "confirmed");
  await expect(page).toHaveURL(/#\/ctusd-test\/creator$/);
  await expect(
    page.getByRole("heading", { name: "创作者中心", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "我创建的市场", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
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
  await expect(page).toHaveURL(/#\/ctusd-test\/creator$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  state.verify();
});

for (const status of ["reverted", "cancelled"] as const)
  test(`${status} creation does not navigate or resubmit`, async ({ page }) => {
    const state = await setup(page, status);
    await page.clock.fastForward(10000);
    await expect(page).toHaveURL(/#\/ctusd-test\/creator\/new$/);
    await expect(page.getByRole("dialog")).toBeVisible();
    state.verify();
  });
