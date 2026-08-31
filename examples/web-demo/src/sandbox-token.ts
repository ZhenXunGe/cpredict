import { parseAbi, type Address, type PublicClient } from "viem";
import type { ConnectedWallet } from "./wallet.js";

const sandboxTokenAbi = parseAbi([
  "function mint(address to,uint256 amount)",
]);

export interface SandboxMintResult {
  hash: `0x${string}`;
  blockNumber: bigint;
  gasUsed: bigint;
}

export async function mintSandboxToken(
  publicClient: PublicClient,
  wallet: ConnectedWallet,
  token: Address,
  amount: bigint,
): Promise<SandboxMintResult> {
  if (amount <= 0n) throw new RangeError("测试币领取数量必须大于 0");
  const { request } = await publicClient.simulateContract({
    account: wallet.account,
    address: token,
    abi: sandboxTokenAbi,
    functionName: "mint",
    args: [wallet.address, amount],
  });
  const hash = await wallet.walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("测试币 mint 交易失败");
  return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
}
