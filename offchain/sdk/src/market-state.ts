/** Canonical state values for the fresh target deployment, not legacy V1 state aliases. */
export const MARKET_STATE = { OPEN: 0, RESOLVED: 1, VOIDED: 2 } as const;
export const VOID_REASON = {
  NONE: 0,
  CREATOR: 1,
  NO_WINNING_SUPPLY: 2,
  TIMEOUT: 3,
} as const;

/** Reject ambiguous/inconsistent terminal data rather than inferring a financial outcome. */
export function assertMarketState(state: number, voidReason: number): void {
  if (
    !Number.isInteger(state) ||
    !Number.isInteger(voidReason) ||
    state < MARKET_STATE.OPEN ||
    state > MARKET_STATE.VOIDED ||
    (state === MARKET_STATE.VOIDED
      ? voidReason < VOID_REASON.CREATOR || voidReason > VOID_REASON.TIMEOUT
      : voidReason !== VOID_REASON.NONE)
  )
    throw new RangeError(`invalid market state/reason: ${state}/${voidReason}`);
}
