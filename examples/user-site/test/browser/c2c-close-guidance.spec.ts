import { test, expect } from "playwright/test";
const market = "0x0000000000000000000000000000000000000065";
test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:(?:4206|4207)\/)/, (route) =>
    route.abort(),
  );
  await page.clock.install({ time: new Date("2026-09-17T08:00:00Z") });
});
test("legacy listing purchase checks payment balance before confirmation", async ({
  page,
  isMobile,
}) => {
  await page.goto(
    `/test/browser/fixture.html?c2c-price=2000000&low-asset-balance=1#/ctusd-test/markets/${market}`,
  );
  const buy = page.getByRole("button", { name: "购买", exact: true });
  await buy.scrollIntoViewIfNeeded();
  if (isMobile) await buy.press("Enter");
  else await buy.click();
  const listing = page.locator("form").filter({
    has: page.getByRole("heading", { name: "核对挂单购买" }),
  });
  await listing.getByRole("button", { name: "核对购买" }).click();
  await expect(listing).toContainText("余额不足");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
for (const closed of [false, true]) {
  test(`premium C2C guidance ${closed ? "is hidden after close" : "disappears at close without a refresh"}`, async ({
    page,
    isMobile,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(
      `/test/browser/fixture.html?c2c-price=2000000${closed ? "&timeout-test=before" : ""}#/ctusd-test/markets/${market}`,
    );
    const premium = page.getByText("高于一级价格", { exact: true });
    const buy = page.getByRole("button", { name: "购买", exact: true });
    await buy.scrollIntoViewIfNeeded();
    // Narrow-viewport coverage uses keyboard activation; touch hit-testing
    // in this Chromium fixture is a separate, unresolved check.
    if (isMobile) await buy.press("Enter");
    else await buy.click();
    await expect(
      page.getByRole("heading", { name: "核对挂单购买" }),
    ).toBeVisible();
    if (!closed) {
      await expect(premium).toBeVisible();
      await expect(page.getByText(/高于一级购买每份 1/)).toBeVisible();
      await expect(
        page.getByRole("button", { name: "去一级购买", exact: true }),
      ).toBeVisible();
      await page.clock.setSystemTime(new Date("2026-09-18T07:59:45Z"));
      await page.clock.fastForward(15000);
    }
    await expect(premium).toHaveCount(0);
    await expect(page.getByText(/高于一级购买每份 1/)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "去一级购买", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "核对挂单购买" }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: /^购买份额/ })).toHaveValue(
      "10",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/c2c-close-${closed}-${test.info().project.name}.png`,
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
}
