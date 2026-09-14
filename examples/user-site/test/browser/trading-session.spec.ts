import { test, expect } from "playwright/test";
const url = "/test/browser/trading-session-fixture.html";
test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:(?:4206|4207)\/)/, (r) =>
    r.abort(),
  );
  test
    .info()
    .annotations.push({
      type: "proof",
      description:
        "Real WebCrypto/IndexedDB and production confirmation UI; synthetic credentials and simulated operation transport. No live Privy, external wallet, hosted sponsor or chain transaction.",
    });
});
test("encrypted browser persistence survives refresh and is isolated by identity, environment and account", async ({
  page,
  context,
}) => {
  await page.goto(url);
  await page.getByRole("button", { name: "暂不开启" }).click();
  await page.getByRole("button", { name: "写入测试授权" }).click();
  await expect(page.getByTestId("restored")).toHaveText("本地会话已恢复");
  const proof = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("cpredict-trading-sessions", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = reject;
    });
    const rows = await new Promise<Record<string, unknown>[]>(
      (resolve, reject) => {
        const r = db.transaction("sessions").objectStore("sessions").getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = reject;
      },
    );
    db.close();
    const row = rows[0]!,
      key = row.key as CryptoKey;
    let exportRejected = false;
    try {
      await crypto.subtle.exportKey("raw", key);
    } catch {
      exportRejected = true;
    }
    return {
      extractable: key.extractable,
      exportRejected,
      plaintextFields: "privateKey" in row || "enableSignature" in row,
      ciphertext: row.ciphertext instanceof ArrayBuffer,
    };
  });
  expect(proof).toEqual({
    extractable: false,
    exportRejected: true,
    plaintextFields: false,
    ciphertext: true,
  });
  await page.reload();
  await expect(page.getByTestId("restored")).toHaveText("本地会话已恢复");
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { sessionStorageProof: () => Promise<unknown> }
      ).sessionStorageProof(),
    ),
  ).toEqual({
    restored: true,
    otherUser: false,
    otherAccount: false,
    otherEnvironment: false,
  });
  const other = await context.newPage();
  await other.goto(url);
  await expect(other.getByTestId("restored")).toHaveText("本地会话已恢复");
  await page.getByRole("button", { name: "退出并清理测试会话" }).click();
  await expect(other.getByTestId("restored")).toHaveText("无本地会话");
  await expect(page.getByText(/已停用；链上撤销待完成/)).toBeVisible();
});
for (const wallet of ["embedded", "external"]) {
  test(`${wallet} fixture keeps site consent for two quick operations and never silently switches signing mode`, async ({
    page,
  }) => {
    await page.goto(`${url}?wallet=${wallet}`);
    const authorization = page.getByRole("dialog");
    await expect(authorization).toContainText("仅当前浏览器有效");
    await expect(authorization).toContainText("执行失败也不返还");
    await page.screenshot({
      path: `/tmp/cpredict-session-authorization-${test.info().project.name}.png`,
    });
    await expect(page.getByLabel(/单笔买入额度/)).toHaveValue("100");
    await expect(page.getByLabel(/累计买入额度/)).toHaveValue("1000");
    await page.getByRole("button", { name: "暂不开启" }).click();
    await page.getByRole("button", { name: "写入测试授权" }).click();
    await expect(page.getByTestId("restored")).toHaveText("本地会话已恢复");
    for (let i = 0; i < 2; i++) {
      await page
        .getByRole("button", { name: "购买 10 ctUSD", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("每笔交易都需要你的明确确认");
      await expect(page.locator("html")).toHaveAttribute(
        "data-local-signs",
        String(i),
      );
      await expect(page.getByLabel("签名方式")).toHaveValue("session");
      await dialog.getByRole("button", { name: "确认并继续" }).click();
      await expect(page.locator("html")).toHaveAttribute(
        "data-local-signs",
        String(i + 1),
      );
      await expect(dialog).toContainText("已提交");
      await dialog
        .getByRole("button", { name: "关闭", exact: true })
        .last()
        .click();
    }
    await expect(page.locator("html")).toHaveAttribute(
      "data-controller-requests",
      "0",
    );
    await page
      .getByRole("button", { name: "购买 10 ctUSD", exact: true })
      .click();
    await page.getByLabel("Gas 支付方式").selectOption("self-funded");
    await expect(page.getByLabel("签名方式")).toHaveValue("session");
    await page.getByRole("button", { name: "估算自付 Gas" }).click();
    await expect(page.getByRole("dialog")).toContainText(
      "快捷交易仅支持项目代付",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-controller-requests",
      "0",
    );
    await page.getByLabel("签名方式").selectOption("controller");
    await expect(page.getByLabel("签名方式")).toHaveValue("controller");
  });
}
