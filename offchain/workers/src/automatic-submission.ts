/** Probe the selected writer before signing. A failure leaves the action unsent;
 * it never selects a different endpoint or retries a broadcast. */
export async function submissionEndpointReady(
  request: (input: { method: "eth_chainId" | "eth_blockNumber" }) => Promise<unknown>,
  chainId: number,
): Promise<boolean> {
  try {
    const id = await request({ method: "eth_chainId" });
    if (typeof id !== "string" || !/^0x[\da-f]+$/i.test(id) || BigInt(id) !== BigInt(chainId)) return false;
    const head = await request({ method: "eth_blockNumber" });
    return typeof head === "string" && /^0x[\da-f]+$/i.test(head) && BigInt(head) > 0n;
  } catch {
    return false;
  }
}
