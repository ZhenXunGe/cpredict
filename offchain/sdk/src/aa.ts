import { getAddress, isHex, type Address, type Hex } from "viem";
import { z } from "zod";

export interface AccountCall {
  to: Address;
  data: Hex;
  value: bigint;
}

export interface SmartAccountAdapter<TUserOperation> {
  readonly name: string;
  encodeCalls(calls: readonly AccountCall[]): Hex;
  buildUserOperation(args: {
    callData: Hex;
    nonceKey: bigint;
  }): Promise<TUserOperation>;
}

export type SponsorshipLane = "protocol-free" | "external-usdc" | "native-eth";

export interface Sponsorship<TUserOperation> {
  userOperation: TUserOperation;
  lane: Exclude<SponsorshipLane, "native-eth">;
  provider: string;
}

export interface SponsorshipProvider<TUserOperation> {
  readonly name: string;
  readonly lane: Exclude<SponsorshipLane, "native-eth">;
  sponsor(
    userOperation: TUserOperation,
    signal: AbortSignal,
  ): Promise<TUserOperation>;
}

export interface SponsorshipSelection<TUserOperation> {
  userOperation: TUserOperation;
  lane: SponsorshipLane;
  provider?: string;
  failedProviders: readonly string[];
}

/**
 * Chooses gas payment before the account signs or submits a UserOperation.
 * It never retries a submitted operation and never silently turns a free operation into a paid one.
 */
export async function selectSponsorship<TUserOperation>(
  userOperation: TUserOperation,
  providers: readonly SponsorshipProvider<TUserOperation>[],
  options: { timeoutMs: number; allowNativeEth: boolean },
): Promise<SponsorshipSelection<TUserOperation>> {
  if (options.timeoutMs < 100 || options.timeoutMs > 30_000) {
    throw new RangeError("sponsorship timeout must be within [100, 30000]ms");
  }
  assertProviderOrder(providers);
  const failedProviders: string[] = [];
  for (const provider of providers) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`sponsorship provider ${provider.name} timed out`));
        }, options.timeoutMs);
      });
      const sponsored = await Promise.race([
        provider.sponsor(userOperation, controller.signal),
        timedOut,
      ]);
      return {
        userOperation: sponsored,
        lane: provider.lane,
        provider: provider.name,
        failedProviders,
      };
    } catch {
      failedProviders.push(provider.name);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
  if (!options.allowNativeEth) {
    throw new SponsorshipUnavailableError(failedProviders);
  }
  return { userOperation, lane: "native-eth", failedProviders };
}

export class SponsorshipUnavailableError extends Error {
  constructor(readonly providers: readonly string[]) {
    super(
      "all sponsorship providers failed and native ETH fallback is disabled",
    );
    this.name = "SponsorshipUnavailableError";
  }
}

export async function buildAccountBatch<TUserOperation>(
  adapter: SmartAccountAdapter<TUserOperation>,
  calls: readonly AccountCall[],
  nonceKey: bigint,
): Promise<TUserOperation> {
  if (calls.length === 0 || calls.length > 32)
    throw new RangeError("batch size must be within [1, 32]");
  if (nonceKey < 0n) throw new RangeError("nonceKey cannot be negative");
  const normalized = calls.map((call) => {
    if (call.value !== 0n)
      throw new RangeError("protocol batches cannot transfer native value");
    if (!isHex(call.data)) throw new TypeError("call data must be hex");
    return { ...call, to: getAddress(call.to) };
  });
  return adapter.buildUserOperation({
    callData: adapter.encodeCalls(normalized),
    nonceKey,
  });
}

const sponsoredOperationSchema = z.object({
  userOperation: z.unknown(),
});

/** Creates a strict external-USDC Paymaster adapter without embedding provider credentials. */
export function createHttpSponsorshipProvider<TUserOperation>(options: {
  name: string;
  lane: Exclude<SponsorshipLane, "native-eth">;
  endpoint: URL;
  authorization: () => Promise<string>;
  fetch?: typeof fetch;
}): SponsorshipProvider<TUserOperation> {
  if (options.name.trim() === "")
    throw new TypeError("Paymaster provider name is required");
  if (
    options.endpoint.protocol !== "https:" &&
    options.endpoint.hostname !== "127.0.0.1"
  ) {
    throw new TypeError(
      "Paymaster endpoint must use HTTPS (localhost is allowed for development)",
    );
  }
  const fetcher = options.fetch ?? fetch;
  return {
    name: options.name,
    lane: options.lane,
    async sponsor(userOperation, signal) {
      const authorization = await options.authorization();
      const response = await fetcher(options.endpoint, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ userOperation }, bigintJson),
        signal,
      });
      if (!response.ok)
        throw new Error(
          `Paymaster provider ${options.name} rejected the request`,
        );
      const parsed = sponsoredOperationSchema.parse(await response.json());
      return parsed.userOperation as TUserOperation;
    },
  };
}

function assertProviderOrder<TUserOperation>(
  providers: readonly SponsorshipProvider<TUserOperation>[],
): void {
  const names = new Set<string>();
  let externalSeen = false;
  for (const provider of providers) {
    if (provider.name.trim() === "" || names.has(provider.name)) {
      throw new TypeError(
        "Paymaster provider names must be non-empty and unique",
      );
    }
    names.add(provider.name);
    if (provider.lane === "external-usdc") externalSeen = true;
    if (provider.lane === "protocol-free" && externalSeen) {
      throw new TypeError(
        "protocol-free providers must precede external-USDC providers",
      );
    }
  }
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `0x${value.toString(16)}` : value;
}
