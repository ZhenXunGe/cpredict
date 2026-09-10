import { erc20Abi, keccak256, parseAbi, type PublicClient } from "viem";
import {
  AppError,
  sameAddress,
  type Environment,
} from "../../app-core/src/contracts.js";
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
