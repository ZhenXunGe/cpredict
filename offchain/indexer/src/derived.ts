import {
  decodeEventLog,
  getAddress,
  parseAbiItem,
  toEventSelector,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
} from "viem";
import type { ConfirmationStatus, IndexedEvent } from "./store.js";
import {
  marketFactoryAbi,
  marketplaceAbi,
  marketVaultAbi,
} from "../../sdk/src/abis.js";
import {
  normalizeEvidenceHash,
  ZERO_EVIDENCE_HASH,
} from "../../sdk/src/evidence.js";

export type DerivedMutation =
  | {
      kind: "market-created";
      market: Address;
      creator: Address;
      deploymentMode: number;
      creatorBond: bigint;
    }
  | {
      kind: "market-initialized";
      market: Address;
      creator: Address;
      deploymentMode: number;
      outcomeCount: number;
      closeAt: bigint;
      resolutionWindow: bigint;
      marketPrimaryCap: bigint;
      creatorBond: bigint;
    }
  | {
      kind: "market-metadata";
      market: Address;
      rulesHash: Hex;
      metadataUri: string;
      resolutionSourceHash: Hex;
      resolutionSourceUri: string;
      closeAt: bigint;
      earlyBirdStart: bigint;
      creatorTreasury: Address;
      featureFlags: bigint;
    }
  | {
      kind: "primary-purchased";
      market: Address;
      buyer: Address;
      outcomeId: bigint;
      filledUnits: bigint;
      payment: bigint;
      totalPrincipal: bigint;
    }
  | {
      kind: "market-terminal";
      market: Address;
      terminalKind:
        | "resolved"
        | "voided-creator"
        | "voided-no-winning-supply"
        | "voided-timeout";
      caller: Address | null;
      state: number;
      voidReason: number;
      winningOutcome: bigint | null;
      evidenceHash: Hex | null;
    }
  | {
      kind: "listing-created";
      listingId: Hex;
      vault: Address;
      seller: Address;
      outcomeId: bigint;
      amount: bigint;
      unitPrice: bigint;
      expiresAt: bigint;
    }
  | {
      kind: "listing-filled";
      listingId: Hex;
      buyer: Address;
      seller: Address;
      filledUnits: bigint;
      gross: bigint;
      remainingUnits: bigint;
    }
  | {
      kind: "listing-closed";
      listingId: Hex;
      closeKind: "listing-cancelled" | "terminal-listing-returned";
      seller: Address;
      caller: Address;
    }
  | {
      kind: "position-delta";
      vault: Address;
      owner: Address;
      outcomeId: bigint;
      delta: bigint;
    }
  | {
      kind: "claim";
      vault: Address;
      owner: Address;
      caller: Address;
      claimKind: string;
      units: bigint;
      amount: bigint;
    };

const eventItems: readonly AbiEvent[] = [
  ...eventsFrom(marketFactoryAbi),
  ...eventsFrom(marketVaultAbi),
  ...eventsFrom(marketplaceAbi),
  parseAbiItem(
    "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  ),
  parseAbiItem(
    "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
  ),
] as const;

const eventByTopic = new Map<Hex, (typeof eventItems)[number]>(
  eventItems.map((item) => [toEventSelector(item), item]),
);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export function discoverMarketAddresses(
  logs: readonly Log[],
): readonly Address[] {
  const markets = new Set<Address>();
  for (const log of logs) {
    const event = normalizeForDiscovery(log);
    if (event === undefined) continue;
    for (const mutation of deriveMutations(event)) {
      if (mutation.kind === "market-created") markets.add(mutation.market);
    }
  }
  return [...markets];
}

export function deriveMutations(
  event: IndexedEvent,
): readonly DerivedMutation[] {
  const topic = event.topics[0];
  if (topic === undefined) return [];
  const item = eventByTopic.get(topic);
  if (item === undefined) return [];
  const decoded = decodeEventLog({
    abi: [item],
    data: event.data,
    topics: event.topics as [Hex, ...Hex[]],
    strict: true,
  });
  const args = decoded.args as unknown as Record<string, unknown>;

  switch (decoded.eventName) {
    case "MarketCreated":
      return [
        {
          kind: "market-created",
          market: address(args.market),
          creator: address(args.creator),
          deploymentMode: number(args.deploymentMode),
          creatorBond: bigint(args.creatorBond),
        },
      ];
    case "MarketInitialized":
      return [
        {
          kind: "market-initialized",
          market: address(args.market),
          creator: address(args.creator),
          deploymentMode: number(args.mode),
          outcomeCount: number(args.outcomeCount),
          closeAt: bigint(args.closeAt),
          resolutionWindow: bigint(args.resolutionWindow),
          marketPrimaryCap: bigint(args.marketPrimaryCap),
          creatorBond: bigint(args.creatorBond),
        },
      ];
    case "MarketMetadataUpdated":
      return [
        {
          kind: "market-metadata",
          market: event.address,
          rulesHash: hex(args.rulesHash),
          metadataUri: text(args.metadataURI),
          resolutionSourceHash: hex(args.resolutionSourceHash),
          resolutionSourceUri: text(args.resolutionSourceURI),
          closeAt: bigint(args.closeAt),
          earlyBirdStart: bigint(args.earlyBirdStart),
          creatorTreasury: address(args.creatorTreasury),
          featureFlags: bigint(args.featureFlags),
        },
      ];
    case "PrimaryPurchased":
      return [
        {
          kind: "primary-purchased",
          market: event.address,
          buyer: address(args.buyer),
          outcomeId: bigint(args.outcomeId),
          filledUnits: bigint(args.filledUnits),
          payment: bigint(args.payment),
          totalPrincipal: bigint(args.totalPrincipal),
        },
      ];
    case "MarketResolved":
      return [
        {
          kind: "market-terminal",
          market: event.address,
          terminalKind: "resolved",
          caller: null,
          state: 1,
          voidReason: 0,
          winningOutcome: bigint(args.winningOutcome),
          evidenceHash: optionalEvidenceHash(args.evidenceHash),
        },
      ];
    case "MarketVoided":
      return [
        {
          kind: "market-terminal",
          market: event.address,
          terminalKind: terminalKind(args.reason),
          caller: address(args.caller),
          state: 2,
          voidReason: number(args.reason),
          winningOutcome: null,
          evidenceHash: optionalEvidenceHash(args.evidenceHash),
        },
      ];
    case "ListingCreated":
      return [
        {
          kind: "listing-created",
          listingId: hex(args.listingId),
          vault: address(args.vault),
          seller: address(args.seller),
          outcomeId: bigint(args.outcomeId),
          amount: bigint(args.amount),
          unitPrice: bigint(args.unitPrice),
          expiresAt: bigint(args.expiresAt),
        },
      ];
    case "ListingFilled":
      return [
        {
          kind: "listing-filled",
          listingId: hex(args.listingId),
          buyer: address(args.buyer),
          seller: address(args.seller),
          filledUnits: bigint(args.filledUnits),
          gross: bigint(args.gross),
          remainingUnits: bigint(args.remainingUnits),
        },
      ];
    case "ListingCancelled":
      return [
        {
          kind: "listing-closed",
          listingId: hex(args.listingId),
          closeKind: "listing-cancelled",
          seller: address(args.seller),
          caller: address(args.seller),
        },
      ];
    case "TerminalListingReturned":
      return [
        {
          kind: "listing-closed",
          listingId: hex(args.listingId),
          closeKind: "terminal-listing-returned",
          seller: address(args.seller),
          caller: address(args.caller),
        },
      ];
    case "TransferSingle":
      return positionMutations(
        event.address,
        address(args.from),
        address(args.to),
        [bigint(args.id)],
        [bigint(args.value)],
      );
    case "TransferBatch":
      return positionMutations(
        event.address,
        address(args.from),
        address(args.to),
        bigintArray(args.ids),
        bigintArray(args.values),
      );
    case "WinnerClaimed":
      return [claimMutation(event, args, "winner", "burnedUnits", "payout")];
    case "EarlyBirdClaimed":
      return [claimMutation(event, args, "early-bird", "score", "reward")];
    case "PrincipalRefunded":
      return [
        claimMutation(event, args, "principal-refund", "burnedUnits", "refund"),
      ];
    case "TimeoutBonusClaimed":
      return [claimMutation(event, args, "timeout-bonus", "units", "reward")];
    default:
      return [];
  }
}

function eventsFrom(abi: readonly { readonly type: string }[]): AbiEvent[] {
  return abi.filter((item) => item.type === "event") as AbiEvent[];
}

function positionMutations(
  vault: Address,
  from: Address,
  to: Address,
  ids: readonly bigint[],
  values: readonly bigint[],
): readonly DerivedMutation[] {
  if (ids.length !== values.length)
    throw new Error("ERC-1155 batch ids/values length mismatch");
  const result: DerivedMutation[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const outcomeId = ids[index];
    const value = values[index];
    if (outcomeId === undefined || value === undefined)
      throw new Error("invalid ERC-1155 batch");
    if (from !== ZERO_ADDRESS) {
      result.push({
        kind: "position-delta",
        vault,
        owner: from,
        outcomeId,
        delta: -value,
      });
    }
    if (to !== ZERO_ADDRESS) {
      result.push({
        kind: "position-delta",
        vault,
        owner: to,
        outcomeId,
        delta: value,
      });
    }
  }
  return result;
}

function claimMutation(
  event: IndexedEvent,
  args: Record<string, unknown>,
  claimKind: string,
  unitsField: string,
  amountField: string,
): DerivedMutation {
  return {
    kind: "claim",
    vault: event.address,
    owner: address(args.owner),
    caller: address(args.caller),
    claimKind,
    units: bigint(args[unitsField]),
    amount: bigint(args[amountField]),
  };
}

function normalizeForDiscovery(log: Log): IndexedEvent | undefined {
  if (
    log.blockNumber === null ||
    log.blockHash === null ||
    log.transactionHash === null ||
    log.transactionIndex === null ||
    log.logIndex === null
  )
    return undefined;
  return {
    chainId: 0,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
    address: log.address,
    topics: log.topics,
    data: log.data,
    confirmationStatus: "provisional",
  };
}

function address(value: unknown): Address {
  if (typeof value !== "string")
    throw new TypeError("event address argument is missing");
  return getAddress(value);
}

function hex(value: unknown): Hex {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw new TypeError("event bytes argument is missing");
  }
  return value as Hex;
}

function text(value: unknown): string {
  if (typeof value !== "string")
    throw new TypeError("event string argument is missing");
  return value;
}

function optionalEvidenceHash(value: unknown): Hex | null {
  const normalized = normalizeEvidenceHash(hex(value));
  return normalized === ZERO_EVIDENCE_HASH ? null : normalized;
}

function terminalKind(
  value: unknown,
): "voided-creator" | "voided-no-winning-supply" | "voided-timeout" {
  const reason = number(value);
  if (reason === 1) return "voided-creator";
  if (reason === 2) return "voided-no-winning-supply";
  if (reason === 3) return "voided-timeout";
  throw new RangeError(`invalid void reason ${reason}`);
}

function bigint(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  throw new TypeError("event integer argument is missing");
}

function number(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return value;
  const result = bigint(value);
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError("event integer exceeds JS range");
  return Number(result);
}

function bigintArray(value: unknown): readonly bigint[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "bigint")
  ) {
    throw new TypeError("event integer array argument is missing");
  }
  return value as readonly bigint[];
}

export function confirmationFor(confirmations: bigint): ConfirmationStatus {
  return confirmations === 0n ? "provisional" : "confirmed";
}
