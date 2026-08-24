import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "../src/App.js";

describe("web demo application shell", () => {
  it("renders the trust-first Chinese console without fabricated runtime state", () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("Cpredict");
    expect(html).toContain("合约验证控制台");
    expect(html).toContain("写操作已锁定");
    expect(html).toContain("BLOCKED_NOT_DEPLOYED");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });
});
