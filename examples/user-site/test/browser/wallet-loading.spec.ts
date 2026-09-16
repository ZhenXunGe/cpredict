import { test, expect, type Page } from "playwright/test";
import { env } from "../../../../offchain/app-core/test/fixtures.js";

async function configure(page: Page) {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:(?:4206|4207)\/)/, (route) =>
    route.abort(),
  );
  await page.route("**/site-config.json", (route) =>
    route.fulfill({
      json: { version: 1, defaultEnvironment: env.id, environments: [env] },
    }),
  );
  await page.route("**/ctusd/indexer/public/v2/markets?*", (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route("**/ctusd/app/v1/telemetry", (route) =>
    route.fulfill({ json: { accepted: true } }),
  );
  await page.route("**/ctusd/app/v1/rpc", (route) =>
    route.fulfill({
      json: {
        jsonrpc: "2.0",
        id: route.request().postDataJSON().id,
        error: { code: -32000, message: "Test chain reads unavailable" },
      },
    }),
  );
  await page.route("**/ctusd/indexer/public/v2/sync-status?*", (route) =>
    route.fulfill({
      json: {
        chainHead: "1",
        applicationConfirmedBlock: "1",
        indexedBlock: "1",
        safeBlock: "1",
        finalizedBlock: "1",
        snapshot: null,
      },
    }),
  );
}

test("built public browsing and account gates do not wait for the wallet bundle", async ({
  page,
}) => {
  await configure(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let walletRequested = false;
  await page.route("**/assets/connected-wallets-*.js", async (route) => {
    walletRequested = true;
    await blocked;
    if (!page.isClosed()) await route.abort();
  });
  try {
    await page.goto("http://127.0.0.1:4207/ctusd-test/markets", {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { name: "探索市场", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("还没有公开测试市场", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => walletRequested).toBe(true);
    await expect(
      page.getByRole("button", { name: "登录 / 连接钱包" }),
    ).toBeDisabled();
    await page.screenshot({
      path: test.info().outputPath("markets-before-wallet.png"),
      fullPage: true,
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByText("还没有公开测试市场", { exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "创建市场", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "登录或连接钱包", exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole("button", { name: "确认并继续" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: "发布规则并核对创建交易" }),
    ).toBeDisabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("wallet-loading-account-gate.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    release();
  }
});

test("session restoration and later updates preserve the mounted public page", async ({
  page,
}) => {
  await configure(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/src/connected-wallets.tsx", async (route) => {
    await blocked;
    await route.fulfill({
      contentType: "application/javascript",
      body: 'export { ConnectedWalletProvider } from "/test/browser/wallet-runtime-fixture.tsx";',
    });
  });
  try {
    await page.goto("/ctusd-test/markets", { waitUntil: "domcontentloaded" });
    const search = page.getByLabel("搜索市场标题或地址");
    await search.fill("保留尚未提交的搜索");
    await expect(
      page.getByRole("button", { name: "登录 / 连接钱包" }),
    ).toBeDisabled();
    release();
    await expect(
      page.getByRole("link", { name: "完成账户验证", exact: true }),
    ).toBeVisible();
    await expect(search).toHaveValue("保留尚未提交的搜索");
    await page.getByRole("button", { name: "测试退出会话" }).click();
    await expect(
      page.getByRole("button", { name: "登录 / 连接钱包" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "登录 / 连接钱包" }).click();
    await expect(
      page.getByRole("link", { name: "完成账户验证", exact: true }),
    ).toBeVisible();
    await expect(search).toHaveValue("保留尚未提交的搜索");
    expect(errors).toEqual([]);
  } finally {
    release();
  }
});
