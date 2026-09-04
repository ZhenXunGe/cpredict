import {
  bondStorageKey,
  parseBondSubmission,
  type BondSubmission,
  type CreatorBondIdentity,
} from "./creator-bond.js";

export class BondStorageUnavailableError extends Error {}

/** The only storage writer: a public, fixed-shape receipt checkpoint, never wallet/session secrets. */
export function saveBondOperation(
  identity: CreatorBondIdentity,
  submission: BondSubmission | null,
) {
  validateIdentity(identity);
  const key = bondStorageKey(identity);
  if (submission === null) {
    window.sessionStorage.removeItem(key);
    return;
  }
  const safe = parseBondSubmission(JSON.stringify(submission));
  window.sessionStorage.setItem(key, JSON.stringify(safe));
}

export function loadBondOperation(
  identity: CreatorBondIdentity,
): BondSubmission | null {
  validateIdentity(identity);
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(bondStorageKey(identity));
  } catch {
    throw new BondStorageUnavailableError("Browser storage is unavailable");
  }
  return parseBondSubmission(raw);
}

function validateIdentity(identity: CreatorBondIdentity) {
  if (
    !Number.isSafeInteger(identity.chainId) ||
    identity.chainId <= 0 ||
    [identity.wallet, identity.creator, identity.market, identity.escrow].some(
      (value) => !/^0x[0-9a-fA-F]{40}$/.test(value),
    )
  ) {
    throw new Error("Invalid bond checkpoint identity");
  }
}
