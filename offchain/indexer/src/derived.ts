import {
  decodeEventLog,
  getAddress,
  parseAbiItem,
  toEventSelector,
  type Address,
  type Hex,
  type Log,
} from "viem";
import type { ConfirmationStatus, IndexedEvent } from "./store.js";
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
      marketPrimaryCap: bigint;
      creatorBond: bigint;
    }
  | {
      kind: "market-terminal";
      market: Address;
      state: number;
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
  | { kind: "listing-closed"; listingId: Hex }
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

const eventItems = [
  parseAbiItem(
    "event MarketCreated(address indexed market,address indexed creator,uint8 indexed deploymentMode,address implementation,bytes32 salt,bytes32 runtimeCodeHash,uint256 creatorNonce,uint256 creationFee,uint256 creatorBond)",
  ),
  parseAbiItem(
    "event MarketInitialized(address indexed market,address indexed creator,uint8 indexed mode,uint8 outcomeCount,uint64 closeAt,uint128 marketPrimaryCap,uint128 creatorBond)",
  ),
  parseAbiItem(
    "event MarketResolved(uint256 indexed winningOutcome,uint256 totalPrincipal,uint256 totalRake,uint256 protocolFee,uint256 creatorFee,uint256 earlyBirdPool,uint256 winnerPool,bytes32 indexed evidenceHash)",
  ),
  parseAbiItem(
    "event MarketVoided(uint8 indexed terminalState,address indexed caller,uint256 refundPrincipal,bytes32 indexed evidenceHash)",
  ),
  parseAbiItem(
    "event ListingCreated(bytes32 indexed listingId,address indexed vault,address indexed seller,uint256 outcomeId,uint256 amount,uint256 unitPrice,uint64 expiresAt,uint256 sellerNonce)",
  ),
  parseAbiItem(
    "event ListingFilled(bytes32 indexed listingId,address indexed buyer,address indexed seller,uint256 desiredUnits,uint256 filledUnits,uint256 gross,uint256 sellerProceeds,uint256 platformFee,uint256 creatorFee,uint256 remainingUnits)",
  ),
  parseAbiItem(
    "event ListingCancelled(bytes32 indexed listingId,address indexed seller,uint256 returnedUnits)",
  ),
  parseAbiItem(
    "event TerminalListingReturned(bytes32 indexed listingId,address indexed caller,address indexed seller,uint256 returnedUnits)",
  ),
  parseAbiItem(
    "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  ),
  parseAbiItem(
    "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
  ),
  parseAbiItem(
    "event WinnerClaimed(address indexed owner,address indexed caller,uint256 burnedUnits,uint256 payout)",
  ),
  parseAbiItem(
    "event EarlyBirdClaimed(address indexed owner,address indexed caller,uint256 score,uint256 reward)",
  ),
  parseAbiItem(
    "event PrincipalRefunded(address indexed owner,address indexed caller,uint256 burnedUnits,uint256 refund,bool timeoutEligibilityRecorded)",
  ),
  parseAbiItem(
    "event TimeoutBonusClaimed(address indexed owner,address indexed caller,uint256 units,uint256 reward)",
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
          marketPrimaryCap: bigint(args.marketPrimaryCap),
          creatorBond: bigint(args.creatorBond),
        },
      ];
    case "MarketResolved":
      return [
        {
          kind: "market-terminal",
          market: event.address,
          state: 1,
          winningOutcome: bigint(args.winningOutcome),
          evidenceHash: optionalEvidenceHash(args.evidenceHash),
        },
      ];
    case "MarketVoided":
      return [
        {
          kind: "market-terminal",
          market: event.address,
          state: number(args.terminalState),
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
    case "TerminalListingReturned":
      return [{ kind: "listing-closed", listingId: hex(args.listingId) }];
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

function optionalEvidenceHash(value: unknown): Hex | null {
  const normalized = normalizeEvidenceHash(hex(value));
  return normalized === ZERO_EVIDENCE_HASH ? null : normalized;
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
