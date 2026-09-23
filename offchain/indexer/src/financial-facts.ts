import { orderbookAbi } from "../../sdk/src/orderbook.js";
import { orderListingId } from "./orderbook.js";
import {
  legacyMarketEvents,
  publicMarketState,
} from "../../sdk/src/legacy-protocol.js";
import {
  decodeEventLog,
  getAddress,
  parseAbi,
  toEventSelector,
  zeroAddress,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import {
  marketFactoryAbi,
  marketplaceAbi,
  marketVaultAbi,
} from "../../sdk/src/abis.js";
import {
  jsonSafe,
  sameAddress,
  type Environment,
} from "../../app-core/src/contracts.js";
import { ENTRY_POINT } from "../../app-core/src/kernel.js";
import {
  ledgerFactSchema,
  type FactKind,
  type LedgerFact,
} from "../../app-core/src/ledger-contracts.js";
import type { CanonicalBlock, IndexedEvent } from "./store.js";

export const financialEventsAbi = [
  ...marketFactoryAbi.filter((v) => v.type === "event"),
  ...marketplaceAbi.filter((v) => v.type === "event"),
  ...orderbookAbi.filter((v) => v.type === "event"),
  ...marketVaultAbi.filter((v) => v.type === "event"),
  ...entryPoint07Abi.filter(
    (v) => v.type === "event" && v.name === "UserOperationEvent",
  ),
  ...parseAbi([
    "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
    "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
    "event Transfer(address indexed from,address indexed to,uint256 value)",
    "event FeeAccrued(address indexed beneficiary,address indexed source,bytes32 indexed feeKind,bytes32 feeReference,uint256 amount)",
    "event FeeClaimed(address indexed beneficiary,address indexed caller,uint256 amount)",
    "event BondLocked(address indexed market,address indexed creator,uint256 amount)",
    "event BondCredited(address indexed market,address indexed creator,uint256 amount)",
    "event EmptyTimeoutBondCredited(address indexed market,address indexed creator,uint256 amount)",
    "event BondFundedToTimeoutMarket(address indexed market,uint256 amount)",
    "event BondClaimed(address indexed creator,address indexed caller,uint256 amount)",
    "event LosingPositionBurned(address indexed owner,uint256 indexed outcomeId,uint256 units)",
    "event FinalRemainderAssigned(bytes32 indexed pool,address indexed owner,uint256 amount)",
    "event EconomicSnapshotCreated(uint16 creatorRakeBps,uint16 protocolShareBps,uint16 earlyBirdShareBps,uint16 platformC2CFeeBps,uint16 creatorC2CFeeBps,address indexed protocolTreasury)",
  ]),
] as const;
const byTopic = new Map<string, AbiEvent>(
  financialEventsAbi.map((item) => [toEventSelector(item).toLowerCase(), item]),
);
const legacyByTopic = new Map<string, AbiEvent>([
  ...byTopic,
  ...legacyMarketEvents.map((item): [string, AbiEvent] => [
    toEventSelector(item).toLowerCase(),
    item,
  ]),
]);
type Args = Record<string, unknown>;
type Decoded = { event: IndexedEvent; name: string; args: Args };
/** Read only historical order identities referenced by this scan batch. */
export function referencedOrderIds(
  events: readonly IndexedEvent[],
  environment: Environment,
): bigint[] {
  const d = environment.deployment;
  if (d.marketplaceVersion !== "orderbook-v2") return [];
  const ids = new Set<bigint>();
  for (const event of events) {
    const isOrder = sameAddress(event.address, d.marketplace);
    const isFee = sameAddress(event.address, d.feeVault);
    if (!isOrder && !isFee) continue;
    const item = byTopic.get(event.topics[0]?.toLowerCase() ?? "");
    if (!item) continue;
    const decoded = decodeEventLog({
      abi: [item],
      data: event.data,
      topics: event.topics as [Hex, ...Hex[]],
      strict: true,
    });
    const args = decoded.args as Args;
    if (isOrder && "orderId" in args) ids.add(BigInt(amount(args.orderId)));
    if (
      isFee &&
      decoded.eventName === "FeeAccrued" &&
      sameAddress(addr(args.source), d.marketplace)
    )
      ids.add(BigInt(hex(args.feeReference)));
  }
  return [...ids];
}
export interface LedgerListing {
  market: Address;
  seller: Address;
  outcomeId: string;
}
export interface FinancialContext {
  environment: Environment;
  markets: ReadonlySet<string>;
  listings: ReadonlyMap<string, LedgerListing>;
  orders?: ReadonlyMap<string, Args>;
  trackedAccounts: ReadonlySet<string>;
}
const addr = (v: unknown): Address => {
  if (typeof v !== "string") throw new Error("missing event address");
  return getAddress(v);
};
const nullableAddr = (v: unknown): Address | null => {
  const a = addr(v);
  return sameAddress(a, zeroAddress) ? null : a;
};
const amount = (v: unknown): string => {
  // Persisted order identities use canonical decimal strings, while freshly decoded logs use bigint.
  if (typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v)) return v;
  if (
    typeof v !== "bigint" &&
    !(typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
  )
    throw new Error("missing event integer");
  return v.toString();
};
const hex = (v: unknown): Hex => {
  if (typeof v !== "string" || !/^0x[\da-fA-F]{64}$/.test(v))
    throw new Error("missing event bytes32");
  return v as Hex;
};

/** Transaction-aware normalization prevents a purchase and its token mint becoming two costs. */
export function normalizeFinancialFacts(
  events: readonly IndexedEvent[],
  blocks: readonly CanonicalBlock[],
  context: FinancialContext,
): LedgerFact[] {
  const timestamps = new Map(
    blocks.map((b) => [b.blockNumber.toString(), b.timestamp.toString()]),
  );
  const decoded: Decoded[] = [];
  for (const e of [...events].sort(compareRaw)) {
    const item = (
      context.environment.deployment.protocolVersion === "legacy-v1"
        ? legacyByTopic
        : byTopic
    ).get(e.topics[0]?.toLowerCase() ?? "");
    if (!item) continue;
    const value = decodeEventLog({
      abi: [item],
      data: e.data,
      topics: e.topics as [Hex, ...Hex[]],
      strict: true,
    });
    decoded.push({
      event: e,
      name: value.eventName,
      args: value.args as unknown as Args,
    });
  }
  const markets = new Set(context.markets),
    listings = new Map(context.listings),
    d = context.environment.deployment;
  for (const { event, name, args } of decoded) {
    if (name === "MarketCreated" && sameAddress(event.address, d.factory))
      markets.add(addr(args.market).toLowerCase());
    if (name === "ListingCreated" && sameAddress(event.address, d.marketplace))
      listings.set(hex(args.listingId).toLowerCase(), {
        market: addr(args.vault),
        seller: addr(args.seller),
        outcomeId: amount(args.outcomeId),
      });
  }
  const orders = new Map(context.orders);
  for (const { event, name, args } of decoded)
    if (name === "OrderCreated" && sameAddress(event.address, d.marketplace))
      orders.set(amount(args.orderId), args);
  const output: LedgerFact[] = [];
  type Movement = {
    event: IndexedEvent;
    index: number;
    market: Address;
    from: Address | null;
    to: Address | null;
    outcome: string;
    remaining: bigint;
  };
  const movements: Movement[] = [];
  for (const { event, name, args } of decoded) {
    if (!markets.has(event.address.toLowerCase())) continue;
    if (name === "TransferSingle")
      movements.push({
        event,
        index: 0,
        market: event.address,
        from: nullableAddr(args.from),
        to: nullableAddr(args.to),
        outcome: amount(args.id),
        remaining: BigInt(amount(args.value)),
      });
    if (name === "TransferBatch") {
      const ids = args.ids,
        values = args.values;
      if (
        !Array.isArray(ids) ||
        !Array.isArray(values) ||
        ids.length !== values.length
      )
        throw new Error("invalid ERC-1155 batch event");
      ids.forEach((id, i) =>
        movements.push({
          event,
          index: i,
          market: event.address,
          from: nullableAddr(args.from),
          to: nullableAddr(args.to),
          outcome: amount(id),
          remaining: BigInt(amount(values[i])),
        }),
      );
    }
  }
  const matchesAddress = (a: Address | null, b: Address | null) =>
    a === null || b === null ? a === b : sameAddress(a, b);
  const consume = (
    e: IndexedEvent,
    market: Address,
    from: Address | null,
    to: Address | null,
    units: string,
    outcome?: string,
  ): { outcomeId: string; units: string }[] => {
    let needed = BigInt(units);
    const used: { outcomeId: string; units: string }[] = [];
    for (const m of movements) {
      if (
        m.event.transactionHash !== e.transactionHash ||
        m.event.logIndex > e.logIndex ||
        !sameAddress(m.market, market) ||
        !matchesAddress(m.from, from) ||
        !matchesAddress(m.to, to) ||
        (outcome !== undefined && m.outcome !== outcome) ||
        m.remaining === 0n
      )
        continue;
      const take = needed < m.remaining ? needed : m.remaining;
      if (take > 0n) {
        m.remaining -= take;
        needed -= take;
        used.push({ outcomeId: m.outcome, units: take.toString() });
      }
      if (needed === 0n) break;
    }
    return used;
  };
  const add = (
    e: IndexedEvent,
    kind: FactKind,
    fields: Partial<LedgerFact> = {},
    extra: Args = {},
  ) => {
    const timestamp = timestamps.get(e.blockNumber.toString());
    if (timestamp === undefined)
      throw new Error("financial event has no canonical timestamp");
    const f = ledgerFactSchema.parse({
      id: `${e.transactionHash}:${e.logIndex}:${fields.factIndex ?? 0}`,
      kind,
      blockNumber: e.blockNumber.toString(),
      blockHash: e.blockHash,
      transactionHash: e.transactionHash,
      transactionIndex: e.transactionIndex,
      logIndex: e.logIndex,
      factIndex: 0,
      timestamp,
      market: null,
      owner: null,
      counterparty: null,
      outcomeId: null,
      listingId: null,
      units: null,
      amount: null,
      extra: jsonSafe(extra),
      ...fields,
    });
    output.push(f);
  };
  const coverage = (
    e: IndexedEvent,
    market: Address,
    owner: Address,
    units: string,
    used: { units: string }[],
  ) => {
    if (used.reduce((n, u) => n + BigInt(u.units), 0n) !== BigInt(units))
      add(
        e,
        "coverage-gap",
        { market, owner, factIndex: 999 },
        { reason: "share_movement_missing" },
      );
  };
  for (const { event: e, name, args: a } of decoded) {
    const isMarket = markets.has(e.address.toLowerCase());
    if (name === "MarketCreated" && sameAddress(e.address, d.factory)) {
      add(
        e,
        "market-created",
        {
          market: addr(a.market),
          owner: addr(a.creator),
          amount: amount(a.creationFee),
        },
        a,
      );
      continue;
    }
    if (
      sameAddress(e.address, d.marketplace) &&
      d.marketplaceVersion === "orderbook-v2"
    ) {
      if (name === "OrderCreated")
        add(
          e,
          "order-created",
          {
            market: addr(a.vault),
            owner: addr(a.owner),
            outcomeId: amount(a.outcomeId),
            units: amount(a.units),
            amount: amount(a.lockedPayment),
            listingId: orderListingId(BigInt(amount(a.orderId))),
          },
          a,
        );
      if (name === "BidExcessReturned") {
        const order = orders.get(amount(a.orderId));
        if (!order) throw new Error("order_funds_without_creation");
        add(
          e,
          "order-funds-returned",
          {
            market: addr(order.vault),
            owner: addr(a.owner),
            outcomeId: amount(order.outcomeId),
            amount: amount(a.amount),
            listingId: orderListingId(BigInt(amount(a.orderId))),
          },
          a,
        );
      }
      if (name === "OrderCreated" && Number(a.side) === 1) {
        const market = addr(a.vault),
          owner = addr(a.owner),
          units = amount(a.units),
          outcomeId = amount(a.outcomeId);
        const used = consume(e, market, owner, d.marketplace, units, outcomeId);
        add(
          e,
          "listing-created",
          {
            market,
            owner,
            units,
            outcomeId,
            listingId: orderListingId(BigInt(amount(a.orderId))),
          },
          { ...a, orderId: amount(a.orderId), orderbook: true },
        );
        coverage(e, market, owner, units, used);
      } else if (name === "OrderReleased") {
        const order = orders.get(amount(a.orderId));
        if (!order) throw new Error("order_release_without_creation");
        add(
          e,
          "order-released",
          {
            market: addr(order.vault),
            owner: addr(a.owner),
            outcomeId: amount(order.outcomeId),
            units: amount(a.returnedUnits),
            amount: amount(a.returnedPayment),
            listingId: orderListingId(BigInt(amount(a.orderId))),
          },
          { ...a, unitPrice: amount(order.unitPrice), side: order.side },
        );
        if (Number(order.side) === 1 && BigInt(amount(a.returnedUnits)) > 0n) {
          const market = addr(order.vault),
            owner = addr(a.owner),
            units = amount(a.returnedUnits),
            outcomeId = amount(order.outcomeId);
          const used = consume(
            e,
            market,
            d.marketplace,
            owner,
            units,
            outcomeId,
          );
          add(
            e,
            "listing-returned",
            {
              market,
              owner,
              units,
              outcomeId,
              listingId: orderListingId(BigInt(amount(a.orderId))),
            },
            { ...a, orderbook: true },
          );
          coverage(e, market, owner, units, used);
        }
      } else if (name === "OrderSharesDeferred") {
        const order = orders.get(amount(a.orderId));
        if (!order) throw new Error("order_deferred_without_creation");
        add(
          e,
          "order-shares-deferred",
          {
            market: addr(order.vault),
            owner: addr(a.owner),
            outcomeId: amount(order.outcomeId),
            units: amount(a.units),
            listingId: orderListingId(BigInt(amount(a.orderId))),
          },
          a,
        );
      } else if (name === "OrderSharesWithdrawn") {
        const order = orders.get(amount(a.orderId));
        if (!order || Number(order.side) !== 1)
          throw new Error("order_withdrawal_without_ask");
        const market = addr(order.vault),
          owner = addr(a.owner),
          recipient = addr(a.recipient),
          units = amount(a.units),
          outcomeId = amount(order.outcomeId),
          listingId = orderListingId(BigInt(amount(a.orderId)));
        const used = consume(e, market, d.marketplace, recipient, units, outcomeId);
        add(
          e,
          "listing-returned",
          { market, owner, outcomeId, units, listingId },
          { ...a, orderbook: true, deferred: true },
        );
        if (!sameAddress(owner, recipient))
          add(
            e,
            "share-transfer",
            {
              market,
              owner,
              counterparty: recipient,
              outcomeId,
              units,
              factIndex: 1,
            },
            { source: "deferred-order-withdrawal", orderId: amount(a.orderId) },
          );
        coverage(e, market, recipient, units, used);
      } else if (name === "TradeExecuted") {
        const market = addr(a.vault),
          buyer = addr(a.buyer),
          seller = addr(a.seller),
          units = amount(a.units),
          outcomeId = amount(a.outcomeId);
        const used = consume(
          e,
          market,
          a.escrowed === true ? d.marketplace : seller,
          buyer,
          units,
          outcomeId,
        );
        add(
          e,
          "listing-filled",
          {
            market,
            owner: buyer,
            counterparty: seller,
            units,
            outcomeId,
            amount: amount(a.gross),
            listingId: orderListingId(BigInt(amount(a.orderId))),
          },
          {
            ...a,
            orderbook: true,
            remainingUnits: amount(a.remainingAskUnits),
            sellerProceeds: (
              BigInt(amount(a.gross)) -
              BigInt(amount(a.platformFee)) -
              BigInt(amount(a.creatorFee))
            ).toString(),
          },
        );
        coverage(e, market, buyer, units, used);
      }
    }
    if (name.startsWith("Listing") || name === "TerminalListingReturned") {
      if (!sameAddress(e.address, d.marketplace)) continue;
      const listingId = hex(a.listingId),
        listing = listings.get(listingId.toLowerCase());
      if (!listing)
        throw new Error("financial event references unknown listing");
      const common = {
        market: listing.market,
        outcomeId: listing.outcomeId,
        listingId,
      };
      if (name === "ListingCreated") {
        const units = amount(a.amount),
          used = consume(
            e,
            listing.market,
            listing.seller,
            d.marketplace,
            units,
            listing.outcomeId,
          );
        add(
          e,
          "listing-created",
          { ...common, owner: listing.seller, units },
          a,
        );
        coverage(e, listing.market, listing.seller, units, used);
      } else if (name === "ListingFilled") {
        const buyer = addr(a.buyer),
          units = amount(a.filledUnits),
          used = consume(
            e,
            listing.market,
            d.marketplace,
            buyer,
            units,
            listing.outcomeId,
          );
        add(
          e,
          "listing-filled",
          {
            ...common,
            owner: buyer,
            counterparty: listing.seller,
            units,
            amount: amount(a.gross),
          },
          a,
        );
        coverage(e, listing.market, buyer, units, used);
      } else {
        const units = amount(a.returnedUnits),
          used = consume(
            e,
            listing.market,
            d.marketplace,
            listing.seller,
            units,
            listing.outcomeId,
          );
        add(
          e,
          name === "ListingCancelled"
            ? "listing-cancelled"
            : "listing-returned",
          { ...common, owner: listing.seller, units },
          a,
        );
        coverage(e, listing.market, listing.seller, units, used);
      }
      continue;
    }
    if (
      sameAddress(e.address, d.feeVault) &&
      (name === "FeeAccrued" || name === "FeeClaimed")
    ) {
      let market: Address | null = null;
      if (name === "FeeAccrued") {
        const source = addr(a.source),
          reference = hex(a.feeReference);
        if (markets.has(source.toLowerCase())) market = source;
        else if (sameAddress(source, d.marketplace))
          market =
            d.marketplaceVersion === "orderbook-v2"
              ? orders.get(BigInt(reference).toString())?.vault
                ? addr(orders.get(BigInt(reference).toString())!.vault)
                : null
              : (listings.get(reference.toLowerCase())?.market ?? null);
        else if (sameAddress(source, d.factory)) {
          const candidate = getAddress(`0x${reference.slice(-40)}`);
          if (markets.has(candidate.toLowerCase())) market = candidate;
        }
      }
      add(
        e,
        name === "FeeAccrued" ? "fee-accrued" : "fee-claimed",
        { market, owner: addr(a.beneficiary), amount: amount(a.amount) },
        a,
      );
      continue;
    }
    if (sameAddress(e.address, d.bondEscrow)) {
      // EmptyTimeoutBondCredited is an explanatory companion to BondCredited, not a second credit.
      const kind: Record<string, FactKind> = {
        BondLocked: "bond-locked",
        BondCredited: "bond-credited",
        BondFundedToTimeoutMarket: "bond-timeout-funded",
        BondClaimed: "bond-claimed",
      };
      if (kind[name])
        add(
          e,
          kind[name]!,
          {
            market: a.market ? addr(a.market) : null,
            owner: a.creator ? addr(a.creator) : null,
            amount: amount(a.amount),
          },
          a,
        );
      continue;
    }
    if (name === "Transfer" && sameAddress(e.address, d.paymentToken)) {
      const from = nullableAddr(a.from),
        to = nullableAddr(a.to);
      if (
        (from && context.trackedAccounts.has(from.toLowerCase())) ||
        (to && context.trackedAccounts.has(to.toLowerCase()))
      )
        add(
          e,
          "payment-transfer",
          { owner: from, counterparty: to, amount: amount(a.value) },
          { mint: from === null },
        );
      continue;
    }
    if (
      name === "UserOperationEvent" &&
      sameAddress(e.address, ENTRY_POINT.address) &&
      context.trackedAccounts.has(addr(a.sender).toLowerCase())
    ) {
      add(
        e,
        "user-operation",
        { owner: addr(a.sender), amount: amount(a.actualGasCost) },
        a,
      );
      continue;
    }
    if (!isMarket) continue;
    const common = { market: e.address };
    switch (name) {
      case "MarketInitialized":
        add(e, "market-initialized", { ...common, owner: addr(a.creator) }, a);
        break;
      case "MarketMetadataUpdated":
        add(
          e,
          "market-metadata",
          { ...common, owner: addr(a.creatorTreasury) },
          a,
        );
        break;
      case "EconomicSnapshotCreated":
        add(e, "economic-snapshot", common, a);
        break;
      case "PrimaryPurchased": {
        const owner = addr(a.buyer),
          units = amount(a.filledUnits),
          outcomeId = amount(a.outcomeId),
          used = consume(e, e.address, null, owner, units, outcomeId);
        add(
          e,
          "primary-buy",
          { ...common, owner, units, outcomeId, amount: amount(a.payment) },
          {
            ...a,
            score: (
              BigInt(units) * BigInt(amount(a.earlyBirdWeight))
            ).toString(),
          },
        );
        coverage(e, e.address, owner, units, used);
        break;
      }
      case "MarketResolved":
        add(
          e,
          "market-resolved",
          { ...common, outcomeId: amount(a.winningOutcome) },
          a,
        );
        break;
      case "MarketVoided":
        add(
          e,
          "market-voided",
          common,
          context.environment.deployment.protocolVersion === "legacy-v1"
            ? {
                ...a,
                reason: publicMarketState(
                  "legacy-v1",
                  Number(a.terminalState),
                  0,
                ).voidReason,
              }
            : a,
        );
        break;
      case "WinnerClaimed":
      case "PrincipalRefunded":
      case "LosingPositionBurned": {
        const owner = addr(a.owner),
          units = amount(a.burnedUnits ?? a.units);
        const used = consume(
          e,
          e.address,
          owner,
          null,
          units,
          name === "LosingPositionBurned" ? amount(a.outcomeId) : undefined,
        );
        const kind =
          name === "WinnerClaimed"
            ? "winner-claimed"
            : name === "PrincipalRefunded"
              ? "refunded"
              : "losing-burned";
        add(
          e,
          kind,
          {
            ...common,
            owner,
            units,
            outcomeId: used.length === 1 ? used[0]!.outcomeId : null,
            amount:
              name === "LosingPositionBurned"
                ? null
                : amount(a.payout ?? a.refund),
          },
          { ...a, consumed: used },
        );
        coverage(e, e.address, owner, units, used);
        break;
      }
      case "EarlyBirdClaimed":
        add(
          e,
          "early-bird-claimed",
          { ...common, owner: addr(a.owner), amount: amount(a.reward) },
          a,
        );
        break;
      case "TimeoutBonusClaimed":
        add(
          e,
          "timeout-claimed",
          {
            ...common,
            owner: addr(a.owner),
            units: amount(a.units),
            amount: amount(a.reward),
          },
          a,
        );
        break;
      case "TimeoutBonusFunded":
        add(e, "timeout-funded", { ...common, amount: amount(a.amount) }, a);
        break;
      case "FinalRemainderAssigned":
        add(
          e,
          "remainder-assigned",
          { ...common, owner: addr(a.owner), amount: amount(a.amount) },
          a,
        );
        break;
    }
  }
  for (const m of movements)
    if (m.remaining > 0n)
      add(
        m.event,
        "share-transfer",
        {
          market: m.market,
          owner: m.from,
          counterparty: m.to,
          outcomeId: m.outcome,
          units: m.remaining.toString(),
          factIndex: m.index,
        },
        { source: "ERC1155" },
      );
  return output.sort(compareFacts);
}
export function compareFacts(a: LedgerFact, b: LedgerFact): number {
  return BigInt(a.blockNumber) < BigInt(b.blockNumber)
    ? -1
    : BigInt(a.blockNumber) > BigInt(b.blockNumber)
      ? 1
      : a.transactionIndex - b.transactionIndex ||
        a.logIndex - b.logIndex ||
        a.factIndex - b.factIndex;
}
function compareRaw(a: IndexedEvent, b: IndexedEvent): number {
  return a.blockNumber < b.blockNumber
    ? -1
    : a.blockNumber > b.blockNumber
      ? 1
      : a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex;
}
