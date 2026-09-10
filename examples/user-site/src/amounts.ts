import { parseUnits } from "viem";
import { AppError } from "../../../offchain/app-core/src/contracts.js";
export function parseAssetAmount(input: string): bigint {
  if (!/^(?:0|[1-9]\d{0,70})(?:\.\d{1,6})?$/.test(input))
    throw new AppError("invalid_asset_amount");
  const units = parseUnits(input, 6);
  if (units <= 0n || units >= 2n ** 256n)
    throw new AppError("invalid_asset_amount");
  return units;
}
