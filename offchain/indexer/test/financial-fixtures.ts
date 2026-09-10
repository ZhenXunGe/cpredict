import {
  encodeAbiParameters,
  encodeEventTopics,
  type Address,
  type Hex,
} from "viem";
import { financialEventsAbi } from "../src/financial-facts.js";
import { A, H, env } from "../../app-core/test/fixtures.js";
import type { CanonicalBlock, IndexedEvent } from "../src/store.js";
export const trader = A(11),
  seller = A(12),
  vault = A(101),
  listing = H(44);
export const block = (n: number): CanonicalBlock => ({
  chainId: env.deployment.chainId,
  blockNumber: BigInt(n),
  blockHash: H(n),
  parentHash: H(n - 1),
  timestamp: BigInt(n * 100),
  confirmationStatus: "confirmed",
});
export function raw(
  name: string,
  contract: Address,
  args: Record<string, unknown>,
  n: number,
  index: number,
  tx = H(n * 10),
): IndexedEvent {
  const event = financialEventsAbi.find((e) => e.name === name);
  if (!event) throw new Error(`missing event ${name}`);
  return {
    chainId: env.deployment.chainId,
    blockNumber: BigInt(n),
    blockHash: H(n),
    transactionHash: tx,
    transactionIndex: 0,
    logIndex: index,
    address: contract,
    topics: encodeEventTopics({
      abi: [event],
      eventName: event.name,
      args: args as never,
    }) as Hex[],
    data: encodeAbiParameters(
      event.inputs.filter((i) => !("indexed" in i && i.indexed)),
      event.inputs
        .filter((i) => !("indexed" in i && i.indexed))
        .map((i) => args[i.name]) as never,
    ),
    confirmationStatus: "confirmed",
  };
}
export function createMarket(n = 1): IndexedEvent[] {
  return [
    raw(
      "MarketCreated",
      env.deployment.factory,
      {
        market: vault,
        creator: seller,
        deploymentMode: 0,
        implementation: A(200),
        salt: H(201),
        runtimeCodeHash: H(202),
        creatorNonce: 0n,
        creationFee: 2n,
        creatorBond: 100n,
      },
      n,
      1,
    ),
    raw(
      "MarketInitialized",
      vault,
      {
        market: vault,
        creator: seller,
        mode: 0,
        outcomeCount: 2,
        createdAt: 100n,
        closeAt: 1000n,
        eventStartsAt: 1001n,
        outcomeDeadlineAt: 2000n,
        resolutionWindow: 900n,
        marketPrimaryCap: 100000n,
        creatorBond: 100n,
      },
      n,
      0,
    ),
  ];
}
export function purchase(n = 2, owner = trader): IndexedEvent[] {
  return [
    raw(
      "TransferSingle",
      vault,
      { operator: owner, from: A(0), to: owner, id: 0n, value: 100n },
      n,
      0,
    ),
    raw(
      "PrimaryPurchased",
      vault,
      {
        buyer: owner,
        outcomeId: 0n,
        desiredUnits: 100n,
        filledUnits: 100n,
        payment: 100n,
        earlyBirdWeight: 3,
        cumulativeUserPrimary: 100n,
        totalPrincipal: 100n,
      },
      n,
      1,
    ),
  ];
}
