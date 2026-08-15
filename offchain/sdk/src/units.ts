import { formatUnits, parseUnits } from "viem";

export const USDC_DECIMALS = 6;
export const SHARE_DECIMALS = 6;
export const SHARE_SCALE = 1_000_000n;

function assertExactDecimals(
  value: string,
  decimals: number,
  field: string,
): void {
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) {
    throw new TypeError(`${field} must be a non-negative decimal string`);
  }
  const fraction = value.split(".")[1];
  if (fraction !== undefined && fraction.length > decimals) {
    throw new RangeError(`${field} has more than ${decimals} decimal places`);
  }
}

export function parseUsdc(value: string): bigint {
  assertExactDecimals(value, USDC_DECIMALS, "USDC amount");
  return parseUnits(value, USDC_DECIMALS);
}

export function formatUsdc(value: bigint): string {
  return formatUnits(value, USDC_DECIMALS);
}

export function parseShareUnits(value: string): bigint {
  assertExactDecimals(value, SHARE_DECIMALS, "share amount");
  return parseUnits(value, SHARE_DECIMALS);
}

export function formatShareUnits(value: bigint): string {
  return formatUnits(value, SHARE_DECIMALS);
}
