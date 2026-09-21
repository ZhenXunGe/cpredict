import { describe, it, expect, vi } from "vitest";
import { submissionEndpointReady } from "../src/automatic-submission.js";
describe("submission endpoint admission", () => {
  it("accepts only a live endpoint on the expected chain", async () => {
    const request = vi.fn().mockResolvedValueOnce("0x66eee").mockResolvedValueOnce("0x123");
    expect(await submissionEndpointReady(request,421614)).toBe(true);
    expect(request.mock.calls.map(c=>c[0].method)).toEqual(["eth_chainId","eth_blockNumber"]);
  });
  it.each(["0x1",undefined,"not-a-quantity"])("rejects wrong or malformed chain ID %s",async id=>{
    const request=vi.fn().mockResolvedValue(id);
    expect(await submissionEndpointReady(request,421614)).toBe(false);expect(request).toHaveBeenCalledTimes(1);
  });
  it("fails closed on quota/transport errors without a second endpoint or retry",async()=>{
    const request=vi.fn().mockRejectedValue(new Error("429"));
    expect(await submissionEndpointReady(request,421614)).toBe(false);expect(request).toHaveBeenCalledTimes(1);
  });
});
