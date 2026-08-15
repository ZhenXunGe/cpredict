#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { keccak256, stringToHex } from "viem";
import {
  REQUIRED_CANARY_STEPS,
  assertAddress,
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertInteger,
  assertRuntimeEvidence,
  assertSha256,
  assertTimestamp,
  assertUnique,
  readJson,
  sha256Json,
  validateReceipt,
} from "./evidence-lib.mjs";

const EXPECTED_REVERT_STEPS = new Set([
  "security.permit2ReplayRejected",
  "paymaster.budgetRejected",
  "timeout.deadlineCreatorVoidRejected",
]);
const EXPECTED_REVERT_SELECTORS = Object.freeze({
  "security.permit2ReplayRejected": keccak256(
    stringToHex("InvalidNonce()"),
  ).slice(0, 10),
  "paymaster.budgetRejected": keccak256(
    stringToHex("SponsorshipBudgetExceeded()"),
  ).slice(0, 10),
  "timeout.deadlineCreatorVoidRejected": keccak256(
    stringToHex("ResolutionWindowExpired()"),
  ).slice(0, 10),
});

const STEP_MODES = Object.freeze({
  "full.create": "FULL",
  "primary.allowanceBuy": "FULL",
  "aa.approvalAndListing": "FULL",
  "c2c.partialFill": "FULL",
  "resolve.winnerClaim": "FULL",
  "resolve.earlyBirdClaim": "FULL",
  "resolve.feeClaim": "FULL",
  "resolve.bondClaim": "FULL",
  "clone.create": "CLONE",
  "primary.permit2Buy": "CLONE",
  "security.permit2ReplayRejected": "CLONE",
  "c2c.cancel": "CLONE",
  "c2c.terminalReturn": "CLONE",
  "creatorVoid.refund": "CLONE",
  "emergency.pauseNewRisk": "PROTOCOL",
  "emergency.exitWhilePaused": "PROTOCOL",
  "emergency.autoExpiry": "PROTOCOL",
  "paymaster.sponsored": "PROTOCOL",
  "paymaster.budgetRejected": "PROTOCOL",
  "paymaster.fallback": "PROTOCOL",
  "timeout.deadlineMinusOneCreatorVoid": "FULL",
  "timeout.deadlineCreatorVoidRejected": "FULL",
});

function validateExpectedRevert(evidence, path) {
  assertExactKeys(
    evidence,
    [
      "blockNumber",
      "blockHash",
      "timestamp",
      "callDataSha256",
      "revertSelector",
    ],
    path,
  );
  assertInteger(evidence.blockNumber, `${path}.blockNumber`, { min: 1 });
  assertHash(evidence.blockHash, `${path}.blockHash`);
  assertInteger(evidence.timestamp, `${path}.timestamp`, { min: 1 });
  assertSha256(evidence.callDataSha256, `${path}.callDataSha256`);
  if (!/^0x[0-9a-fA-F]{8}$/.test(evidence.revertSelector))
    throw new Error(`${path}.revertSelector: must be a 4-byte selector`);
}

function validateStep(step, path) {
  assertExactKeys(step, ["id", "mode", "market", "outcome", "evidence"], path);
  if (!REQUIRED_CANARY_STEPS.includes(step.id))
    throw new Error(`${path}.id: unknown step ${step.id}`);
  if (step.mode !== STEP_MODES[step.id])
    throw new Error(`${path}.mode: ${step.id} must use ${STEP_MODES[step.id]}`);
  assertAddress(step.market, `${path}.market`, {
    allowZero: step.mode === "PROTOCOL",
  });
  const expectedRevert = EXPECTED_REVERT_STEPS.has(step.id);
  if (step.outcome !== (expectedRevert ? "EXPECTED_REVERT" : "SUCCESS"))
    throw new Error(`${path}.outcome: wrong outcome for ${step.id}`);
  if (expectedRevert) {
    validateExpectedRevert(step.evidence, `${path}.evidence`);
    if (
      step.evidence.revertSelector.toLowerCase() !==
      EXPECTED_REVERT_SELECTORS[step.id]
    )
      throw new Error(
        `${path}.evidence.revertSelector: wrong expected error for ${step.id}`,
      );
  } else validateReceipt(step.evidence, `${path}.evidence`);
}

function validateTimeout(timeout, path, { zeroParticipant = false } = {}) {
  const common = [
    "market",
    "mode",
    "closeAt",
    "deadline",
    "voidReceipt",
    "slashedBond",
  ];
  const keys = zeroParticipant
    ? [...common, "bondSettleReceipt", "creator", "creatorCreditIncrease"]
    : [
        ...common,
        "totalPrincipal",
        "principalRefunds",
        "bondSettlement",
        "bonusClaims",
      ];
  assertExactKeys(timeout, keys, path);
  assertAddress(timeout.market, `${path}.market`);
  if (!["FULL", "CLONE"].includes(timeout.mode))
    throw new Error(`${path}.mode: must be FULL or CLONE`);
  assertInteger(timeout.closeAt, `${path}.closeAt`, { min: 1 });
  assertInteger(timeout.deadline, `${path}.deadline`, { min: 1 });
  if (timeout.deadline !== timeout.closeAt + 86_400)
    throw new Error(`${path}.deadline: must equal closeAt + 86400`);
  validateReceipt(timeout.voidReceipt, `${path}.voidReceipt`);
  if (timeout.voidReceipt.timestamp < timeout.deadline)
    throw new Error(
      `${path}.voidReceipt.timestamp: timeout void occurred before deadline`,
    );
  const slashedBond = BigInt(
    assertDecimalString(timeout.slashedBond, `${path}.slashedBond`),
  );
  if (slashedBond <= 0n)
    throw new Error(`${path}.slashedBond: must be positive`);

  if (zeroParticipant) {
    validateReceipt(timeout.bondSettleReceipt, `${path}.bondSettleReceipt`);
    assertAddress(timeout.creator, `${path}.creator`);
    if (
      BigInt(
        assertDecimalString(
          timeout.creatorCreditIncrease,
          `${path}.creatorCreditIncrease`,
        ),
      ) !== slashedBond
    )
      throw new Error(`${path}.creatorCreditIncrease: must equal slashed bond`);
    return;
  }

  const totalPrincipal = BigInt(
    assertDecimalString(timeout.totalPrincipal, `${path}.totalPrincipal`),
  );
  if (totalPrincipal <= 0n)
    throw new Error(`${path}.totalPrincipal: must be positive`);
  if (
    !Array.isArray(timeout.principalRefunds) ||
    timeout.principalRefunds.length === 0
  )
    throw new Error(`${path}.principalRefunds: must be a non-empty array`);
  let refundUnits = 0n;
  let refundPayout = 0n;
  for (const [i, refund] of timeout.principalRefunds.entries()) {
    const itemPath = `${path}.principalRefunds[${i}]`;
    assertExactKeys(
      refund,
      ["holder", "burnedUnits", "payout", "receipt"],
      itemPath,
    );
    assertAddress(refund.holder, `${itemPath}.holder`);
    const units = BigInt(
      assertDecimalString(refund.burnedUnits, `${itemPath}.burnedUnits`),
    );
    const payout = BigInt(
      assertDecimalString(refund.payout, `${itemPath}.payout`),
    );
    if (units <= 0n || payout !== units)
      throw new Error(
        `${itemPath}: principal refund must be positive and exactly 1:1`,
      );
    validateReceipt(refund.receipt, `${itemPath}.receipt`);
    if (refund.receipt.timestamp < timeout.voidReceipt.timestamp)
      throw new Error(`${itemPath}.receipt.timestamp: precedes timeout void`);
    refundUnits += units;
    refundPayout += payout;
  }
  if (refundUnits !== totalPrincipal || refundPayout !== totalPrincipal)
    throw new Error(`${path}.principalRefunds: sums must equal totalPrincipal`);

  assertExactKeys(
    timeout.bondSettlement,
    ["fundedBonus", "receipt"],
    `${path}.bondSettlement`,
  );
  if (
    BigInt(
      assertDecimalString(
        timeout.bondSettlement.fundedBonus,
        `${path}.bondSettlement.fundedBonus`,
      ),
    ) !== slashedBond
  )
    throw new Error(
      `${path}.bondSettlement.fundedBonus: must equal slashed bond`,
    );
  validateReceipt(
    timeout.bondSettlement.receipt,
    `${path}.bondSettlement.receipt`,
  );
  if (!Array.isArray(timeout.bonusClaims) || timeout.bonusClaims.length === 0)
    throw new Error(`${path}.bonusClaims: must be a non-empty array`);
  let bonusUnits = 0n;
  let bonusPayout = 0n;
  for (const [i, claim] of timeout.bonusClaims.entries()) {
    const itemPath = `${path}.bonusClaims[${i}]`;
    assertExactKeys(
      claim,
      ["holder", "bonusUnits", "payout", "receipt"],
      itemPath,
    );
    assertAddress(claim.holder, `${itemPath}.holder`);
    bonusUnits += BigInt(
      assertDecimalString(claim.bonusUnits, `${itemPath}.bonusUnits`),
    );
    bonusPayout += BigInt(
      assertDecimalString(claim.payout, `${itemPath}.payout`),
    );
    validateReceipt(claim.receipt, `${itemPath}.receipt`);
    if (claim.receipt.timestamp < timeout.bondSettlement.receipt.timestamp)
      throw new Error(`${itemPath}.receipt.timestamp: precedes bond funding`);
  }
  if (bonusUnits !== totalPrincipal)
    throw new Error(
      `${path}.bonusClaims: bonus units must equal total principal eligibility`,
    );
  if (bonusPayout !== slashedBond)
    throw new Error(`${path}.bonusClaims: payout sum must equal slashed bond`);
}

export function validateCanaryEvidence(evidence) {
  assertExactKeys(
    evidence,
    [
      "schemaVersion",
      "evidenceClass",
      "status",
      "chainId",
      "generatedAt",
      "deploymentIdentity",
      "referenceBlock",
      "steps",
      "timeoutCanary",
      "zeroParticipantTimeoutCanary",
    ],
    "canary",
  );
  assertRuntimeEvidence(evidence, "cpredict.base-sepolia.canary.v1", "canary");
  if (evidence.status !== "COMPLETE")
    throw new Error("canary.status: must equal COMPLETE");
  assertTimestamp(evidence.generatedAt, "canary.generatedAt");
  assertExactKeys(
    evidence.deploymentIdentity,
    [
      "factory",
      "factoryActivationFingerprint",
      "bootstrapFinalizeTx",
      "sourceCommit",
    ],
    "canary.deploymentIdentity",
  );
  assertAddress(
    evidence.deploymentIdentity.factory,
    "canary.deploymentIdentity.factory",
  );
  assertHash(
    evidence.deploymentIdentity.factoryActivationFingerprint,
    "canary.deploymentIdentity.factoryActivationFingerprint",
  );
  assertHash(
    evidence.deploymentIdentity.bootstrapFinalizeTx,
    "canary.deploymentIdentity.bootstrapFinalizeTx",
  );
  if (!/^[0-9a-f]{40}$/.test(evidence.deploymentIdentity.sourceCommit))
    throw new Error(
      "canary.deploymentIdentity.sourceCommit: must be a full lowercase commit SHA",
    );
  assertExactKeys(
    evidence.referenceBlock,
    ["number", "hash"],
    "canary.referenceBlock",
  );
  assertInteger(
    evidence.referenceBlock.number,
    "canary.referenceBlock.number",
    { min: 1 },
  );
  assertHash(evidence.referenceBlock.hash, "canary.referenceBlock.hash");
  if (
    !Array.isArray(evidence.steps) ||
    evidence.steps.length !== REQUIRED_CANARY_STEPS.length
  )
    throw new Error(
      `canary.steps: must contain exactly ${REQUIRED_CANARY_STEPS.length} required steps`,
    );
  evidence.steps.forEach((step, i) => validateStep(step, `canary.steps[${i}]`));
  const ids = evidence.steps.map((step) => step.id);
  assertUnique(ids, "canary.steps ids");
  for (const required of REQUIRED_CANARY_STEPS)
    if (!ids.includes(required))
      throw new Error(`canary.steps: missing ${required}`);
  const fullCreate = evidence.steps.find((step) => step.id === "full.create");
  const cloneCreate = evidence.steps.find((step) => step.id === "clone.create");
  if (
    fullCreate.mode !== "FULL" ||
    cloneCreate.mode !== "CLONE" ||
    fullCreate.market.toLowerCase() === cloneCreate.market.toLowerCase()
  )
    throw new Error(
      "canary.steps: Full and Clone creation evidence must be distinct and correctly typed",
    );

  validateTimeout(evidence.timeoutCanary, "canary.timeoutCanary");
  validateTimeout(
    evidence.zeroParticipantTimeoutCanary,
    "canary.zeroParticipantTimeoutCanary",
    { zeroParticipant: true },
  );
  if (
    evidence.timeoutCanary.market.toLowerCase() ===
    evidence.zeroParticipantTimeoutCanary.market.toLowerCase()
  )
    throw new Error("canary timeout markets must be distinct");
  const before = evidence.steps.find(
    (step) => step.id === "timeout.deadlineMinusOneCreatorVoid",
  );
  const atDeadline = evidence.steps.find(
    (step) => step.id === "timeout.deadlineCreatorVoidRejected",
  );
  for (const step of evidence.steps) {
    if (
      step.mode === "FULL" &&
      !step.id.startsWith("timeout.") &&
      step.market.toLowerCase() !== fullCreate.market.toLowerCase()
    )
      throw new Error(
        `canary.steps: ${step.id} must target the Full canary market`,
      );
    if (
      step.mode === "CLONE" &&
      step.market.toLowerCase() !== cloneCreate.market.toLowerCase()
    )
      throw new Error(
        `canary.steps: ${step.id} must target the Clone canary market`,
      );
  }
  if (
    before.market.toLowerCase() === evidence.timeoutCanary.market.toLowerCase()
  )
    throw new Error(
      "deadline-1 creator void must use a separate boundary canary market",
    );
  if (
    atDeadline.market.toLowerCase() !==
    evidence.timeoutCanary.market.toLowerCase()
  )
    throw new Error(
      "deadline creator void rejection must target the timeout canary market",
    );
  if (before.evidence.timestamp > evidence.timeoutCanary.deadline - 1)
    throw new Error("deadline-1 creator void evidence is too late");
  if (atDeadline.evidence.timestamp < evidence.timeoutCanary.deadline)
    throw new Error("deadline creator void rejection evidence is too early");
  return { evidence, sha256: sha256Json(evidence) };
}

async function main() {
  const path = process.argv[2];
  if (!path)
    throw new Error(
      "usage: node scripts/deployment/validate-canary-evidence.mjs <canary-evidence.json>",
    );
  const result = validateCanaryEvidence(await readJson(path));
  process.stdout.write(`PASS Base Sepolia canary evidence ${result.sha256}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    process.stderr.write(`FAIL ${error.message}\n`);
    process.exitCode = 1;
  });
