import {
  legacyMarketRulesSchema,
  encodeLegacyMarketRules,
} from "../../sdk/src/legacy-market-rules.js";
import {
  getAddress,
  parseAbi,
  keccak256,
  stringToHex,
  type Address,
  type PublicClient,
} from "viem";
import { marketplaceAbi } from "../../sdk/src/abis.js";
import {
  encodeMarketRules,
  marketRulesMatchTimes,
  marketRulesSchema,
} from "../../sdk/src/market-rules.js";
import { type AdmissionReader } from "./calls.js";
import {
  AppError,
  type BusinessIntent,
  type Environment,
} from "./contracts.js";
import { fetchJson } from "./fetch-json.js";

const factoryAbi = parseAbi([
  "function isMarket(address) view returns(bool)",
  "function config() view returns(address)",
  "function marketplace() view returns(address)",
  "function bondEscrow() view returns(address)",
  "function feeVault() view returns(address)",
  "function resolutionWindow() view returns(uint64)",
]);
const vaultAbi = parseAbi([
  "function rulesHash() view returns(bytes32)",
  "function closeAt() view returns(uint64)",
  "function eventStartsAt() view returns(uint64)",
  "function outcomeDeadlineAt() view returns(uint64)",
  "function resolutionDeadline() view returns(uint256)",
]);
const feeAbi = parseAbi(["function creationFee() view returns(uint128)"]);

export class ProtocolAdmissionReader implements AdmissionReader {
  constructor(
    private readonly client: PublicClient,
    private readonly environment: Environment,
    private readonly metadataUrl: string,
  ) {}
  registeredMarket(market: Address): Promise<boolean> {
    return this.client.readContract({
      address: this.environment.deployment.factory,
      abi: factoryAbi,
      functionName: "isMarket",
      args: [market],
    });
  }
  async verifiedRules(market: Address): Promise<boolean> {
    if (this.environment.deployment.protocolVersion === "legacy-v1") {
      const [rulesHash, closeAt] = await Promise.all([
        this.client.readContract({
          address: market,
          abi: vaultAbi,
          functionName: "rulesHash",
        }),
        this.client.readContract({
          address: market,
          abi: vaultAbi,
          functionName: "closeAt",
        }),
      ]);
      const result = legacyMarketRulesSchema.safeParse(
        await fetchJson(
          `${this.metadataUrl.replace(/\/$/, "")}/v1/markets/${rulesHash}/rules.json`,
          { signal: AbortSignal.timeout(5000) },
          32768,
        ),
      );
      return (
        result.success &&
        BigInt(result.data.closesAt) === closeAt &&
        encodeLegacyMarketRules(result.data).rulesHash.toLowerCase() ===
          rulesHash.toLowerCase()
      );
    }
    const [
      rulesHash,
      closeAt,
      eventStartsAt,
      outcomeDeadlineAt,
      resolutionDeadlineAt,
    ] = await Promise.all([
      this.client.readContract({
        address: market,
        abi: vaultAbi,
        functionName: "rulesHash",
      }),
      this.client.readContract({
        address: market,
        abi: vaultAbi,
        functionName: "closeAt",
      }),
      this.client.readContract({
        address: market,
        abi: vaultAbi,
        functionName: "eventStartsAt",
      }),
      this.client.readContract({
        address: market,
        abi: vaultAbi,
        functionName: "outcomeDeadlineAt",
      }),
      this.client.readContract({
        address: market,
        abi: vaultAbi,
        functionName: "resolutionDeadline",
      }),
    ]);
    const result = marketRulesSchema.safeParse(
      await fetchJson(
        `${this.metadataUrl.replace(/\/$/, "")}/v1/markets/${rulesHash}/rules.json`,
        { signal: AbortSignal.timeout(5_000) },
        32_768,
      ),
    );
    if (!result.success) return false;
    return (
      encodeMarketRules(result.data).rulesHash.toLowerCase() ===
        rulesHash.toLowerCase() &&
      marketRulesMatchTimes(result.data, {
        closeAt,
        eventStartsAt: eventStartsAt === 0n ? null : eventStartsAt,
        outcomeDeadlineAt,
        resolutionDeadlineAt,
      })
    );
  }
  async listing(id: `0x${string}`) {
    const row = await this.client.readContract({
      address: this.environment.deployment.marketplace,
      abi: marketplaceAbi,
      functionName: "listings",
      args: [id],
    });
    return {
      market: getAddress(row[0]),
      seller: getAddress(row[1]),
      active: row[6],
    };
  }
  async creationPayment(
    params: Extract<BusinessIntent, { kind: "create-market" }>["params"],
  ): Promise<bigint> {
    if (this.environment.deployment.protocolVersion === "legacy-v1")
      throw new AppError("legacy_creation_requires_demo", 409);
    const [rules, resolutionWindow] = await Promise.all([
      fetchJson(
        `${this.metadataUrl.replace(/\/$/, "")}/v1/markets/${params.rulesHash}/rules.json`,
        { signal: AbortSignal.timeout(5000) },
        32768,
      ).then((v) => marketRulesSchema.parse(v)),
      this.client.readContract({
        address: this.environment.deployment.factory,
        abi: factoryAbi,
        functionName: "resolutionWindow",
      }),
    ]);
    if (
      encodeMarketRules(rules).rulesHash.toLowerCase() !==
        params.rulesHash.toLowerCase() ||
      rules.outcomes.length !== params.outcomeCount ||
      rules.resolutionSource !== params.resolutionSourceURI ||
      keccak256(stringToHex(rules.resolutionSource)).toLowerCase() !==
        params.resolutionSourceHash.toLowerCase() ||
      !marketRulesMatchTimes(rules, {
        closeAt: BigInt(params.closeAt),
        eventStartsAt:
          params.eventStartsAt === "0" ? null : BigInt(params.eventStartsAt),
        outcomeDeadlineAt: BigInt(params.outcomeDeadlineAt),
        resolutionDeadlineAt:
          BigInt(params.outcomeDeadlineAt) + resolutionWindow,
      })
    )
      throw new AppError("rules_unverified", 409);
    const config = await this.client.readContract({
      address: this.environment.deployment.factory,
      abi: factoryAbi,
      functionName: "config",
    });
    const fee = await this.client.readContract({
      address: config,
      abi: feeAbi,
      functionName: "creationFee",
    });
    return fee + BigInt(params.creatorBond);
  }
}
