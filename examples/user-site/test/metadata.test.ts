import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, stringToHex } from "viem";
import { createAppKernel } from "../../../offchain/app-core/src/kernel.js";
import {
  appAccount,
  env,
  H,
} from "../../../offchain/app-core/test/fixtures.js";
import {
  encodeMarketRules,
  type MarketRules,
} from "../../../offchain/sdk/src/market-rules.js";
import { SiteApi } from "../src/api.js";
import { publishRules, rulesPublicationErrorCopy } from "../src/metadata.js";
import type { WalletSession } from "../src/wallets.js";

vi.mock("../../../offchain/app-core/src/kernel.js", () => ({
  createAppKernel: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const rules: MarketRules = {
  version: "cpredict-rules-v2",
  question: "Will the published result be yes?",
  outcomes: ["Yes", "No"],
  closeAt: 1_900_000_000,
  eventStartsAt: null,
  outcomeDeadlineAt: 1_900_000_100,
  resolutionDeadlineAt: 1_900_086_500,
  resolutionSource: "https://example.com/result",
  resolutionCriteria: "Use the published final result.",
  cancellationPolicy: "Cancel if the result cannot be verified.",
};
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  const api = new SiteApi(env),
    encoded = encodeMarketRules(rules);
  let issued = 0;
  const request = vi.spyOn(api, "request").mockImplementation(async (path) =>
    path === "/v1/challenges"
      ? {
          challengeId: H(++issued),
          nonce: H(issued + 10),
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        }
      : {
          rulesHash: encoded.rulesHash,
          metadataUri: `https://example.com/v1/markets/${encoded.rulesHash}/outcomes/{id}.json`,
          resolutionSourceHash: keccak256(stringToHex(rules.resolutionSource)),
          resolutionSourceUri: rules.resolutionSource,
        },
  );
  const sign = vi.fn().mockResolvedValue("0x1234");
  vi.mocked(createAppKernel).mockResolvedValue({
    address: appAccount.address,
    signTypedData: sign,
  } as never);
  const session = {
    api,
    controller: vi.fn().mockResolvedValue({}),
  } as unknown as WalletSession;
  return { session, request, sign };
}
describe("rules signing expiry and retry", () => {
  it("does not submit an expired signature; an explicit retry takes a fresh challenge and signs again", async () => {
    const s = setup();
    s.sign.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(301000);
      return "0x1234";
    });
    await expect(
      publishRules(s.session, appAccount, rules, () => {}),
    ).rejects.toMatchObject({ code: "challenge_expired", status: 409 });
    expect(
      s.request.mock.calls.filter(([path]) => path === "/v1/markets"),
    ).toHaveLength(0);
    const result = await publishRules(s.session, appAccount, rules, () => {});
    expect(result.rulesHash).toBe(encodeMarketRules(rules).rulesHash);
    expect(s.sign).toHaveBeenCalledTimes(2);
    expect(s.sign.mock.calls[0]![0].message.nonce).not.toBe(
      s.sign.mock.calls[1]![0].message.nonce,
    );
    expect(
      s.request.mock.calls.filter(([path]) => path === "/v1/markets"),
    ).toHaveLength(1);
  });
  it("explains wallet rejection without exposing its signed payload", async () => {
    const s = setup();
    s.sign.mockRejectedValue({
      cause: { code: 4001, message: "private signed payload" },
    });
    const error = await publishRules(
      s.session,
      appAccount,
      rules,
      () => {},
    ).catch((e) => e);
    expect(error).toMatchObject({ code: "rules_signature_rejected" });
    expect(rulesPublicationErrorCopy(error)).toContain("已取消规则签名");
    expect(rulesPublicationErrorCopy(error)).not.toMatch(/private|操作编号/);
  });
});
