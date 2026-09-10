import type { ConnectedWallet } from "@privy-io/react-auth";
import {
  createWalletClient,
  custom,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { arbitrumSepolia } from "viem/chains";
import { z } from "zod";
import {
  address,
  AppError,
  sameAddress,
  type AppAccount,
  type Deposit,
} from "../../../offchain/app-core/src/contracts.js";
import {
  readUsdcDomain,
  receiveTypedData,
  USDC_ADDRESS,
} from "../../../offchain/app-core/src/usdc.js";
import type { SiteApi } from "./api.js";

export function assertDepositContext(
  d: Deposit,
  api: SiteApi,
  account: AppAccount,
  source: string,
  amount: bigint,
): void {
  if (
    d.environment !== api.environment.id ||
    d.deploymentId !== api.environment.deployment.id ||
    d.accountId !== account.id ||
    !sameAddress(d.account, account.address) ||
    !sameAddress(d.authorization.to, account.address) ||
    !sameAddress(d.authorization.from, source) ||
    BigInt(d.authorization.value) !== amount ||
    d.domain.chainId !== api.environment.deployment.chainId ||
    d.domain.verifyingContract !== USDC_ADDRESS ||
    d.operationId !== null ||
    d.state !== "awaiting-authorization"
  )
    throw new AppError("deposit_authorization_mismatch", 409);
}

export async function signDepositAuthorization(
  api: SiteApi,
  deposit: Deposit,
  wallet: ConnectedWallet,
  stillCurrent: () => boolean,
): Promise<Hex> {
  const current = () => {
    if (!stillCurrent())
      throw new AppError("confirmation_context_changed", 409);
  };
  try {
    current();
    if (!sameAddress(wallet.address, deposit.authorization.from))
      throw new AppError("deposit_source_required", 400);
    await wallet.switchChain(api.environment.deployment.chainId);
    current();
    const provider = (await wallet.getEthereumProvider()) as EIP1193Provider;
    const addresses = z
      .array(address)
      .parse(await provider.request({ method: "eth_accounts" }));
    const chain = await provider.request({ method: "eth_chainId" });
    if (
      !addresses.some((a) => sameAddress(a, deposit.authorization.from)) ||
      BigInt(chain) !== 421614n
    )
      throw new AppError("confirmation_context_changed", 409);
    const client = api.publicClient(),
      block = await client.getBlock();
    const domain = await readUsdcDomain(client, block.number);
    if (JSON.stringify(domain) !== JSON.stringify(deposit.domain))
      throw new AppError("deposit_domain_changed", 409);
    if (
      BigInt(deposit.authorization.validBefore) <= block.timestamp ||
      BigInt(deposit.authorization.validAfter) >= block.timestamp
    )
      throw new AppError("deposit_authorization_expired", 409);
    current();
    const signer = createWalletClient({
      account: deposit.authorization.from,
      chain: arbitrumSepolia,
      transport: custom(provider),
    });
    const signature = await signer.signTypedData(
      receiveTypedData(domain, deposit.authorization),
    );
    current();
    return z
      .string()
      .regex(/^0x[\da-fA-F]{130}$/)
      .parse(signature) as Hex;
  } catch (error) {
    if (error instanceof AppError) throw error;
    let cause: unknown = error;
    for (let i = 0; i < 5 && cause && typeof cause === "object"; i++) {
      if ("code" in cause && cause.code === 4001)
        throw new AppError("deposit_signature_rejected", 400);
      cause = "cause" in cause ? cause.cause : undefined;
    }
    // Wallet errors may contain signed requests; never expose them to UI/logging.
    throw new AppError("deposit_signature_invalid", 400);
  }
}
