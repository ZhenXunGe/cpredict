import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, keccak256, toBytes, type Hex } from "viem";
import { encodeMarketRules, type MarketRules } from "../../../offchain/sdk/src/index.js";
import { publishMarketMetadata } from "../src/metadata-client.js";
import type { ConnectedWallet } from "../src/wallet.js";

const creator = getAddress("0x000000000000000000000000000000000000c001");
const factory = getAddress("0x000000000000000000000000000000000000f001");
const rules: MarketRules = {
  version: "cpredict-rules-v1",
  question: "Will the cited public result be Yes at close?",
  outcomes: ["Yes", "No"],
  closesAt: 1_900_000_000,
  resolutionSource: "https://example.com/result",
  resolutionCriteria: "Use the final result published by the cited source.",
  cancellationPolicy: "Void if no unambiguous result is published in time.",
};

afterEach(() => vi.unstubAllGlobals());

describe("wallet metadata publication client", () => {
  it("rebuilds typed data locally and verifies every returned commitment", async () => {
    const encoded = encodeMarketRules(rules);
    const challengeId = `0x${"11".repeat(32)}` as Hex;
    const nonce = `0x${"22".repeat(32)}` as Hex;
    const signature = `0x${"33".repeat(65)}` as Hex;
    const expiresAt = Math.floor(Date.now() / 1_000) + 300;
    const signTypedData = vi.fn(async () => signature);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        challengeId,
        nonce,
        expiresAt,
        typedData: { domain: { verifyingContract: "0x0000000000000000000000000000000000000000" } },
      }))
      .mockResolvedValueOnce(json({
        rulesHash: encoded.rulesHash,
        metadataUri: `https://101.32.241.211/metadata/v1/markets/${encoded.rulesHash}/outcomes/{id}.json`,
        resolutionSourceHash: keccak256(toBytes(rules.resolutionSource)),
        resolutionSourceUri: rules.resolutionSource,
      }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const wallet = {
      address: creator,
      chainId: 421_614,
      account: { address: creator, type: "json-rpc" },
      walletClient: { signTypedData },
    } as unknown as ConnectedWallet;

    await expect(publishMarketMetadata({
      basePath: "/metadata",
      chainId: 421_614,
      factory,
      wallet,
      rules,
    })).resolves.toMatchObject({
      rulesHash: encoded.rulesHash,
      resolutionSourceURI: rules.resolutionSource,
    });
    expect(signTypedData).toHaveBeenCalledWith(expect.objectContaining({
      domain: expect.objectContaining({ verifyingContract: factory }),
      message: expect.objectContaining({ creator, rulesHash: encoded.rulesHash, nonce }),
    }));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      challengeId,
      signature,
      rules,
    });
  });

  it("does not ask the wallet to sign an expired challenge", async () => {
    const signTypedData = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => json({
      challengeId: `0x${"11".repeat(32)}`,
      nonce: `0x${"22".repeat(32)}`,
      expiresAt: Math.floor(Date.now() / 1_000),
    })));
    const wallet = {
      address: creator,
      chainId: 421_614,
      account: { address: creator, type: "json-rpc" },
      walletClient: { signTypedData },
    } as unknown as ConnectedWallet;
    await expect(publishMarketMetadata({
      basePath: "/metadata",
      chainId: 421_614,
      factory,
      wallet,
      rules,
    })).rejects.toThrow("challenge response is invalid");
    expect(signTypedData).not.toHaveBeenCalled();
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
