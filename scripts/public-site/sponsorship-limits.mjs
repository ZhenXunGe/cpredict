/** Scale monetary and request quotas without changing admission policy or reset windows. */
export function scaleSponsorshipLimits(sponsor, factor) {
  if (!Number.isSafeInteger(factor) || factor < 1)
    throw new Error("invalid quota factor");
  const result = structuredClone(sponsor);
  const money = (value) => {
    if (!/^[1-9]\d*$/.test(value)) throw new Error("invalid monetary quota");
    return (BigInt(value) * BigInt(factor)).toString();
  };
  const count = (value) => {
    const scaled = value * factor;
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      !Number.isSafeInteger(scaled)
    )
      throw new Error("invalid request quota");
    return scaled;
  };
  for (const lane of ["exposure", "exit"]) {
    for (const key of ["projectWei", "accountWei", "subjectWei"])
      result[lane][key] = money(result[lane][key]);
    for (const key of [
      "projectOperations",
      "accountOperations",
      "subjectOperations",
    ])
      result[lane][key] = count(result[lane][key]);
  }
  for (const key of ["projectWei", "exitReserveWei"])
    result.weekly[key] = money(result.weekly[key]);
  result.maxCostPerOperation = money(result.maxCostPerOperation);
  result.methodDailyOperations = count(result.methodDailyOperations);
  if (result.providerHardLimitWei !== null)
    result.providerHardLimitWei = money(result.providerHardLimitWei);
  if (result.providerHardLimitUsd !== null) {
    const [whole, decimals = ""] = result.providerHardLimitUsd.split(".");
    const cents =
      (BigInt(whole) * 100n + BigInt(decimals.padEnd(2, "0"))) * BigInt(factor);
    result.providerHardLimitUsd = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
  }
  return result;
}
