import { describe, expect, it } from "vitest";
import { parseSponsorServiceConfig } from "../src/config.js";

function environment(): Record<string, string> {
  return {
    CPREDICT_PAYMASTER_HOST: "127.0.0.1",
    CPREDICT_PAYMASTER_PORT: "3001",
    CPREDICT_PAYMASTER_LOG_LEVEL: "info",
    CPREDICT_PAYMASTER_ADAPTER_MODULE:
      "file:///opt/cpredict/paymaster-adapters.js",
    CPREDICT_PAYMASTER_CHAIN_ID: "84532",
    CPREDICT_PAYMASTER_ENTRY_POINT:
      "0x1111111111111111111111111111111111111111",
    CPREDICT_PAYMASTER_ADDRESS: "0x2222222222222222222222222222222222222222",
    CPREDICT_PAYMASTER_EXPECTED_SIGNER:
      "0x3333333333333333333333333333333333333333",
    CPREDICT_PAYMASTER_POLICY_VERSION: "7",
    CPREDICT_PAYMASTER_VERIFICATION_GAS_LIMIT: "150000",
    CPREDICT_PAYMASTER_POST_OP_GAS_LIMIT: "100000",
    CPREDICT_PAYMASTER_VALIDITY_SECONDS: "300",
    CPREDICT_PAYMASTER_MAX_COST_PER_REQUEST: "10000000000000000",
    CPREDICT_PAYMASTER_MAX_COST_PER_USER_DAY: "20000000000000000",
    CPREDICT_PAYMASTER_MAX_COST_GLOBAL_DAY: "500000000000000000",
    CPREDICT_PAYMASTER_MAX_INIT_CODE_BYTES: "1024",
    CPREDICT_PAYMASTER_MAX_CALL_DATA_BYTES: "16384",
    CPREDICT_PAYMASTER_MIN_SPONSORED_LISTING_UNITS: "1000000",
    CPREDICT_PAYMASTER_MAX_CREATE_LISTINGS_PER_USER_DAY: "20",
    CPREDICT_PAYMASTER_MAX_CANCEL_LISTINGS_PER_USER_DAY: "40",
  };
}

describe("paymaster service environment", () => {
  it("parses a complete server-side configuration", () => {
    const parsed = parseSponsorServiceConfig(environment());
    expect(parsed.host).toBe("127.0.0.1");
    expect(parsed.sponsorship.verificationGasLimit).toBe(150_000n);
    expect(parsed.policy.maxCostPerRequest).toBe(10_000_000_000_000_000n);
    expect(parsed.policy.minSponsoredListingUnits).toBe(1_000_000n);
  });

  it("fails closed for missing values, public binding and out-of-contract gas limits", () => {
    const missing = environment();
    delete missing.CPREDICT_PAYMASTER_EXPECTED_SIGNER;
    expect(() => parseSponsorServiceConfig(missing)).toThrow();

    const publicHost = environment();
    publicHost.CPREDICT_PAYMASTER_HOST = "0.0.0.0";
    expect(() => parseSponsorServiceConfig(publicHost)).toThrow();

    const excessiveGas = environment();
    excessiveGas.CPREDICT_PAYMASTER_POST_OP_GAS_LIMIT = "300001";
    expect(() => parseSponsorServiceConfig(excessiveGas)).toThrow();

    const insufficientGas = environment();
    insufficientGas.CPREDICT_PAYMASTER_VERIFICATION_GAS_LIMIT = "149999";
    expect(() => parseSponsorServiceConfig(insufficientGas)).toThrow();

    const rawKey = environment();
    rawKey.CPREDICT_PAYMASTER_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    expect(() => parseSponsorServiceConfig(rawKey)).toThrow();

    const inconsistentBudget = environment();
    inconsistentBudget.CPREDICT_PAYMASTER_MAX_COST_PER_USER_DAY = "1";
    expect(() => parseSponsorServiceConfig(inconsistentBudget)).toThrow(
      "request <= user/day",
    );

    const zeroMinimum = environment();
    zeroMinimum.CPREDICT_PAYMASTER_MIN_SPONSORED_LISTING_UNITS = "0";
    expect(() => parseSponsorServiceConfig(zeroMinimum)).toThrow();
  });
});
