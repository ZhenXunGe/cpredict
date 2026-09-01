import { getAddress, isAddress, type Address, type Hex } from "viem";
import {
  encodeMarketRules,
  marketRulesSchema,
  type MarketRules,
} from "../../../offchain/sdk/src/index.js";

export type CatalogStatus =
  | "open"
  | "resolved"
  | "voided-creator"
  | "voided-timeout";

export interface MarketCatalogItem {
  market: Address;
  creator: Address;
  deploymentMode: number;
  outcomeCount: number | null;
  closeAt: bigint | null;
  rulesHash: Hex | null;
  marketPrimaryCap: bigint | null;
  primaryFilledUnits: bigint;
  creatorBond: bigint;
  status: CatalogStatus;
  createdBlock: bigint;
  confirmationStatus: "provisional" | "confirmed";
}

export interface WalletActivityItem {
  transactionHash: Hex;
  logIndex: number;
  kind: ActivityKind;
  vault: Address;
  actor: Address | null;
  counterparty: Address | null;
  outcomeId: bigint | null;
  listingId: Hex | null;
  units: bigint | null;
  amount: bigint | null;
  blockNumber: bigint;
  confirmationStatus: "provisional" | "confirmed";
}

export interface IndexedPosition {
  vault: Address;
  owner: Address;
  outcomeId: bigint;
  balance: bigint;
  updatedBlock: bigint;
  confirmationStatus: "provisional" | "confirmed";
}

export interface IndexedListing {
  listingId: Hex;
  vault: Address;
  seller: Address;
  outcomeId: bigint;
  remainingUnits: bigint;
  unitPrice: bigint;
  expiresAt: bigint;
  active: boolean;
  updatedBlock: bigint;
  confirmationStatus: "provisional" | "confirmed";
}

export type ActivityKind =
  | "market-created"
  | "primary-purchased"
  | "listing-created"
  | "listing-filled"
  | "listing-cancelled"
  | "terminal-listing-returned"
  | "market-resolved"
  | "market-voided-creator"
  | "market-voided-timeout"
  | "winner-claimed"
  | "early-bird-claimed"
  | "principal-refunded"
  | "timeout-bonus-claimed";

export interface QueryPage<T> {
  items: readonly T[];
  nextCursor?: string;
}

export async function fetchMarketCatalog(input: {
  basePath: string;
  chainId: number;
  owner?: Address;
  status?: CatalogStatus;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<QueryPage<MarketCatalogItem>> {
  const url = endpoint(input.basePath, "/v2/markets");
  url.searchParams.set("chainId", String(input.chainId));
  url.searchParams.set("limit", "20");
  if (input.owner !== undefined) url.searchParams.set("owner", input.owner);
  if (input.status !== undefined) url.searchParams.set("status", input.status);
  if (input.cursor !== undefined) url.searchParams.set("cursor", input.cursor);
  return fetchPage(url, parseMarket, input.signal);
}

export async function fetchWalletActivity(input: {
  basePath: string;
  chainId: number;
  owner: Address;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<QueryPage<WalletActivityItem>> {
  const url = endpoint(input.basePath, `/v2/activity/${input.owner}`);
  url.searchParams.set("chainId", String(input.chainId));
  url.searchParams.set("limit", "50");
  if (input.cursor !== undefined) url.searchParams.set("cursor", input.cursor);
  return fetchPage(url, parseActivity, input.signal);
}

export async function fetchWalletPositions(input: {
  basePath: string;
  chainId: number;
  owner: Address;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<QueryPage<IndexedPosition>> {
  const url = endpoint(input.basePath, `/v1/positions/${input.owner}`);
  url.searchParams.set("chainId", String(input.chainId));
  url.searchParams.set("limit", "100");
  if (input.cursor !== undefined) url.searchParams.set("cursor", input.cursor);
  return fetchPage(url, parsePosition, input.signal);
}

export async function fetchListings(input: {
  basePath: string;
  chainId: number;
  vault?: Address;
  active?: boolean;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<QueryPage<IndexedListing>> {
  const url = endpoint(input.basePath, "/v1/listings");
  url.searchParams.set("chainId", String(input.chainId));
  url.searchParams.set("limit", "50");
  if (input.vault !== undefined) url.searchParams.set("vault", input.vault);
  if (input.active !== undefined) url.searchParams.set("active", String(input.active));
  if (input.cursor !== undefined) url.searchParams.set("cursor", input.cursor);
  return fetchPage(url, parseListing, input.signal);
}

export async function fetchMarketRules(input: {
  metadataBasePath: string;
  rulesHash: Hex;
  signal?: AbortSignal;
}): Promise<MarketRules> {
  const response = await fetch(
    endpoint(
      input.metadataBasePath,
      `/v1/markets/${input.rulesHash}/rules.json`,
    ),
    requestInit(input.signal),
  );
  if (!response.ok) throw new Error(`Metadata HTTP ${response.status}`);
  requireJson(response);
  const rules = marketRulesSchema.parse(await response.json());
  if (
    encodeMarketRules(rules).rulesHash.toLowerCase() !==
    input.rulesHash.toLowerCase()
  ) {
    throw new Error("Metadata rules do not match the on-chain commitment");
  }
  return rules;
}

async function fetchPage<T>(
  url: URL,
  parseItem: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<QueryPage<T>> {
  const response = await fetch(url, requestInit(signal));
  if (!response.ok) throw new Error(`Indexer HTTP ${response.status}`);
  requireJson(response);
  const value: unknown = await response.json();
  const object = record(value, "Indexer page");
  if (!Array.isArray(object.items)) throw new TypeError("Indexer page is invalid");
  const nextCursor = object.nextCursor;
  if (nextCursor !== undefined && (typeof nextCursor !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(nextCursor))) {
    throw new TypeError("Indexer cursor is invalid");
  }
  return {
    items: object.items.map(parseItem),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function parseMarket(value: unknown): MarketCatalogItem {
  const item = record(value, "market");
  const outcomeCount = nullableInteger(item.outcomeCount, "outcomeCount", 2, 32);
  const status = enumValue(item.status, ["open", "resolved", "voided-creator", "voided-timeout"] as const, "status");
  return {
    market: address(item.market, "market"),
    creator: address(item.creator, "creator"),
    deploymentMode: integer(item.deploymentMode, "deploymentMode", 0, 1),
    outcomeCount,
    closeAt: nullableBigint(item.closeAt, "closeAt"),
    rulesHash: nullableBytes32(item.rulesHash, "rulesHash"),
    marketPrimaryCap: nullableBigint(item.marketPrimaryCap, "marketPrimaryCap"),
    primaryFilledUnits: bigint(item.primaryFilledUnits, "primaryFilledUnits"),
    creatorBond: bigint(item.creatorBond, "creatorBond"),
    status,
    createdBlock: bigint(item.createdBlock, "createdBlock"),
    confirmationStatus: confirmation(item.confirmationStatus),
  };
}

function parseActivity(value: unknown): WalletActivityItem {
  const item = record(value, "activity");
  return {
    transactionHash: bytes32(item.transactionHash, "transactionHash"),
    logIndex: integer(item.logIndex, "logIndex", 0, Number.MAX_SAFE_INTEGER),
    kind: enumValue(item.kind, ["market-created", "primary-purchased", "listing-created", "listing-filled", "listing-cancelled", "terminal-listing-returned", "market-resolved", "market-voided-creator", "market-voided-timeout", "winner-claimed", "early-bird-claimed", "principal-refunded", "timeout-bonus-claimed"] as const, "kind"),
    vault: address(item.vault, "vault"),
    actor: nullableAddress(item.actor, "actor"),
    counterparty: nullableAddress(item.counterparty, "counterparty"),
    outcomeId: nullableBigint(item.outcomeId, "outcomeId"),
    listingId: nullableBytes32(item.listingId, "listingId"),
    units: nullableBigint(item.units, "units"),
    amount: nullableBigint(item.amount, "amount"),
    blockNumber: bigint(item.blockNumber, "blockNumber"),
    confirmationStatus: confirmation(item.confirmationStatus),
  };
}

function parsePosition(value: unknown): IndexedPosition {
  const item = record(value, "position");
  return {
    vault: address(item.vault, "vault"),
    owner: address(item.owner, "owner"),
    outcomeId: bigint(item.outcomeId, "outcomeId"),
    balance: bigint(item.balance, "balance"),
    updatedBlock: bigint(item.updatedBlock, "updatedBlock"),
    confirmationStatus: confirmation(item.confirmationStatus),
  };
}

function parseListing(value: unknown): IndexedListing {
  const item = record(value, "listing");
  if (typeof item.active !== "boolean") throw new TypeError("active is invalid");
  return {
    listingId: bytes32(item.listingId, "listingId"),
    vault: address(item.vault, "vault"),
    seller: address(item.seller, "seller"),
    outcomeId: bigint(item.outcomeId, "outcomeId"),
    remainingUnits: bigint(item.remainingUnits, "remainingUnits"),
    unitPrice: bigint(item.unitPrice, "unitPrice"),
    expiresAt: bigint(item.expiresAt, "expiresAt"),
    active: item.active,
    updatedBlock: bigint(item.updatedBlock, "updatedBlock"),
    confirmationStatus: confirmation(item.confirmationStatus),
  };
}

function endpoint(basePath: string, suffix: string): URL {
  if (!/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,255}$/.test(basePath))
    throw new TypeError("same-origin service path is invalid");
  const base = basePath.replace(/\/$/, "");
  return new URL(`${base}${suffix}`, globalThis.location?.origin ?? "https://local.invalid");
}

function requestInit(signal?: AbortSignal): RequestInit {
  return {
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: { accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  };
}

function requireJson(response: Response): void {
  if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? ""))
    throw new TypeError("service response is not JSON");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function address(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value))
    throw new TypeError(`${label} is invalid`);
  return getAddress(value);
}

function nullableAddress(value: unknown, label: string): Address | null {
  return value === null ? null : address(value, label);
}

function bytes32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new TypeError(`${label} is invalid`);
  return value as Hex;
}

function nullableBytes32(value: unknown, label: string): Hex | null {
  return value === null ? null : bytes32(value, label);
}

function bigint(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new TypeError(`${label} is invalid`);
  return BigInt(value);
}

function nullableBigint(value: unknown, label: string): bigint | null {
  return value === null ? null : bigint(value, label);
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new TypeError(`${label} is invalid`);
  return value;
}

function nullableInteger(value: unknown, label: string, minimum: number, maximum: number): number | null {
  return value === null ? null : integer(value, label, minimum, maximum);
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value))
    throw new TypeError(`${label} is invalid`);
  return value as T[number];
}

function confirmation(value: unknown): "provisional" | "confirmed" {
  return enumValue(value, ["provisional", "confirmed"] as const, "confirmationStatus");
}
