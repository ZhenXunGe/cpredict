import { describe, it, expect, vi } from "vitest";
import {
  SubmissionEndpointPool,
  parseSubmissionUrls,
  submissionEndpointReady,
} from "../src/automatic-submission.js";
describe("submission endpoint admission", () => {
  it("accepts only a live endpoint on the expected chain", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce("0x66eee")
      .mockResolvedValueOnce("0x123");
    expect(await submissionEndpointReady(request, 421614)).toBe(true);
    expect(request.mock.calls.map((c) => c[0].method)).toEqual([
      "eth_chainId",
      "eth_blockNumber",
    ]);
  });
  it.each(["0x1", undefined, "not-a-quantity"])(
    "rejects wrong or malformed chain ID %s",
    async (id) => {
      const request = vi.fn().mockResolvedValue(id);
      expect(await submissionEndpointReady(request, 421614)).toBe(false);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects a writer too far behind the current read head", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce("0x66eee")
      .mockResolvedValueOnce("0x100");
    expect(await submissionEndpointReady(request, 421614, 0x200n)).toBe(false);
  });
  it("fails closed on quota/transport errors without a second endpoint or retry", async () => {
    const request = vi.fn().mockRejectedValue(new Error("429"));
    expect(await submissionEndpointReady(request, 421614)).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("automation writer selection", () => {
  it("validates private writer URLs without exposing them in errors", () => {
    expect(
      parseSubmissionUrls(
        "https://primary.example.invalid",
        '["https://backup.example.invalid"]',
      ),
    ).toHaveLength(2);
    for (const json of [
      '["https://primary.example.invalid"]',
      '["http://remote.example.invalid"]',
      "not-json",
      JSON.stringify(
        Array.from(
          { length: 9 },
          (_, index) => `https://backup-${index}.example.invalid`,
        ),
      ),
    ]) {
      expect(() =>
        parseSubmissionUrls("https://primary.example.invalid", json),
      ).toThrow("invalid private automation writer configuration");
    }
  });
  it("uses a healthy fallback after a failed writer probe and broadcasts once", async () => {
    const rejected = vi.fn().mockRejectedValue(new Error("401 private"));
    const healthy = vi.fn(async ({ method }: { method: string }) =>
      method === "eth_chainId"
        ? "0x66eee"
        : method === "eth_blockNumber"
          ? "0x123"
          : "0xhash",
    );
    const pool = new SubmissionEndpointPool(
      [{ request: rejected }, { request: healthy }],
      421614,
    );
    expect(await pool.ready()).toBe(true);
    expect(await pool.sendRaw("0xsigned")).toBe("0xhash");
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(healthy.mock.calls.map((call) => call[0].method)).toEqual([
      "eth_chainId",
      "eth_blockNumber",
      "eth_sendRawTransaction",
    ]);
    await expect(pool.sendRaw("0xsigned")).rejects.toThrow(
      "submission_rpc_unavailable",
    );
    expect(healthy).toHaveBeenCalledTimes(3);
  });
  it("does not resend through a fallback when broadcast times out", async () => {
    const first = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_sendRawTransaction")
        throw new Error("unknown outcome");
      return method === "eth_chainId" ? "0x66eee" : "0x123";
    });
    const second = vi.fn();
    const pool = new SubmissionEndpointPool(
      [{ request: first }, { request: second }],
      421614,
    );
    expect(await pool.ready()).toBe(true);
    await expect(pool.sendRaw("0xsigned")).rejects.toThrow("unknown outcome");
    expect(second).not.toHaveBeenCalled();
    await expect(pool.sendRaw("0xsigned")).rejects.toThrow(
      "submission_rpc_unavailable",
    );
  });
  it("rechecks an exhausted primary on a bounded schedule and returns to it", async () => {
    let now = 1_000_000;
    let exhausted = true;
    const first = vi.fn(async ({ method }: { method: string }) => {
      if (exhausted) throw new Error("quota");
      return method === "eth_chainId"
        ? "0x66eee"
        : method === "eth_blockNumber"
          ? "0x123"
          : "0xfirst";
    });
    const second = vi.fn(async ({ method }: { method: string }) =>
      method === "eth_chainId"
        ? "0x66eee"
        : method === "eth_blockNumber"
          ? "0x123"
          : "0xsecond",
    );
    const pool = new SubmissionEndpointPool(
      [{ request: first }, { request: second }],
      421614,
      () => now,
    );
    expect(await pool.ready()).toBe(true);
    expect(await pool.sendRaw("0x01")).toBe("0xsecond");
    expect(await pool.ready()).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    now += 60_000;
    exhausted = false;
    expect(await pool.ready()).toBe(true);
    expect(await pool.sendRaw("0x02")).toBe("0xfirst");
    expect(first.mock.calls.map((call) => call[0].method)).toEqual([
      "eth_chainId",
      "eth_chainId",
      "eth_blockNumber",
      "eth_sendRawTransaction",
    ]);
  });
});
