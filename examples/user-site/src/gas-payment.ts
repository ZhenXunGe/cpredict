import {
  createWalletClient,
  custom,
  formatEther,
  parseEther,
  type EIP1193Provider,
  type PublicClient,
} from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { arbitrumSepolia } from "viem/chains";
import {
  AppError,
  sameAddress,
  type AppAccount,
} from "../../../offchain/app-core/src/contracts.js";
import { ENTRY_POINT } from "../../../offchain/app-core/src/kernel.js";

export async function gasBalance(client: PublicClient, account: AppAccount) {
  const [balance, deposit] = await Promise.all([
    client.getBalance({ address: account.address }),
    client.readContract({
      address: ENTRY_POINT.address,
      abi: entryPoint07Abi,
      functionName: "balanceOf",
      args: [account.address],
    }),
  ]);
  return balance + deposit;
}

export function requireGasBalance(balance: bigint, cost: bigint) {
  if (balance < cost)
    throw new AppError(
      "self_funded_balance_insufficient",
      409,
      `智能账户可用 Gas 余额 ${formatEther(balance)} ETH，本次最多需要 ${formatEther(cost)} ETH。请补充 ETH 后重新估算。`,
    );
}

/** Called only by the explicit funding button; the wallet presents the transfer for approval. */
export async function fundGas(
  provider: EIP1193Provider,
  account: AppAccount,
  amount: string,
  stillCurrent: () => boolean = () => true,
) {
  if (
    !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(amount) ||
    parseEther(amount) <= 0n
  )
    throw new AppError("invalid_gas_funding_amount", 400);
  const wallet = createWalletClient({
    chain: arbitrumSepolia,
    transport: custom(provider, { retryCount: 0 }),
  });
  const [addresses, chainId] = await Promise.all([
    wallet.getAddresses(),
    wallet.getChainId(),
  ]);
  if (
    !stillCurrent() ||
    chainId !== arbitrumSepolia.id ||
    !addresses[0] ||
    !sameAddress(addresses[0], account.controller)
  )
    throw new AppError("confirmation_context_changed", 409);
  return wallet.sendTransaction({
    account: account.controller,
    to: account.address,
    value: parseEther(amount),
  });
}
