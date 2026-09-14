import { erc20Abi, keccak256, parseAbi, type PublicClient } from "viem";
import {
  AppError,
  sameAddress,
  type Environment,
} from "../../app-core/src/contracts.js";
import { tradingPolicyAbi } from "../../app-core/src/trading-session-kernel.js";
export { ProtocolAdmissionReader } from "../../app-core/src/admission-reader.js";
const factoryAbi = parseAbi([
  "function marketplace() view returns(address)",
  "function bondEscrow() view returns(address)",
  "function feeVault() view returns(address)",
]);
const tokenOwnerAbi = parseAbi([
  "function paymentToken() view returns(address)",
]);

export async function verifyDeployment(
  client: PublicClient,
  environment: Environment,
): Promise<void> {
  await verifyQuickTrading(client, environment);
  const d = environment.deployment;
  if ((await client.getChainId()) !== d.chainId)
    throw new AppError("rpc_chain_mismatch", 503);
  const contracts = [
    d.factory,
    d.marketplace,
    d.bondEscrow,
    d.feeVault,
    d.paymentToken,
  ];
  for (const contract of contracts) {
    const code = await client.getCode({ address: contract });
    if (code === undefined || code === "0x")
      throw new AppError("deployment_contract_missing", 503);
    const expected = d.runtimeCodeHashes[contract.toLowerCase()];
    if (!expected || keccak256(code).toLowerCase() !== expected.toLowerCase())
      throw new AppError("deployment_code_mismatch", 503);
  }
  if (
    (await client.readContract({
      address: d.paymentToken,
      abi: erc20Abi,
      functionName: "decimals",
    })) !== environment.decimals
  )
    throw new AppError("payment_decimals_mismatch", 503);
  for (const name of ["marketplace", "bondEscrow", "feeVault"] as const) {
    const actual = await client.readContract({
      address: d.factory,
      abi: factoryAbi,
      functionName: name,
    });
    if (!sameAddress(actual, d[name]))
      throw new AppError("factory_dependency_mismatch", 503);
  }
  for (const owner of [d.bondEscrow, d.feeVault, d.marketplace]) {
    const token = await client.readContract({
      address: owner,
      abi: tokenOwnerAbi,
      functionName: "paymentToken",
    });
    if (!sameAddress(token, d.paymentToken))
      throw new AppError("payment_token_mismatch", 503);
  }
}

export async function verifyQuickTrading(
  client: PublicClient,
  environment: Environment,
) {
  const config = environment.quickTrading;
  if (!config?.enabled) return;
  if (environment.asset !== "ctUSD")
    throw new AppError("quick_trading_environment_invalid", 503);
  await Promise.all(
    (["policy", "signer"] as const).map(async (name) => {
      const code = await client.getCode({ address: config[name] });
      if (
        !code ||
        code === "0x" ||
        keccak256(code).toLowerCase() !==
          config[`${name}CodeHash`].toLowerCase()
      )
        throw new AppError("trading_session_module_mismatch", 503);
    }),
  );
  await Promise.all(
    (
      [
        "factory",
        "marketplace",
        "paymentToken",
        "bondEscrow",
        "feeVault",
        "paymaster",
      ] as const
    ).map(async (name) => {
      const actual = await client.readContract({
        address: config.policy,
        abi: tradingPolicyAbi,
        functionName: name,
      });
      if (
        !sameAddress(
          actual,
          name === "paymaster"
            ? config.paymaster
            : environment.deployment[name],
        )
      )
        throw new AppError("trading_session_dependency_mismatch", 503);
    }),
  );
  const paymasterCode = await client.getCode({ address: config.paymaster });
  if (!paymasterCode || paymasterCode === "0x")
    throw new AppError("trading_session_paymaster_missing", 503);
}
