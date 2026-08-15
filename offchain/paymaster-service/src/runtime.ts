import type { Address, Hex } from "viem";
import { SponsorPolicy } from "./policy.js";
import { createSponsorServer } from "./server.js";
import type { SponsorServiceConfig } from "./config.js";
import type {
  SponsorAccountAdapter,
  SponsorAuthorizer,
  SponsorBudgetStore,
  SponsorSigner,
  SponsorOperationKind,
} from "./types.js";

export interface SponsorRuntimeAdapters {
  accountAdapter: SponsorAccountAdapter;
  authorizer: SponsorAuthorizer;
  budgetStore: SponsorBudgetStore;
  signer: SponsorSigner;
  allowedTargets: ReadonlyMap<Address, ReadonlyMap<Hex, SponsorOperationKind>>;
}

export interface SponsorRuntimeAdapterModule {
  createSponsorRuntimeAdapters(
    config: SponsorServiceConfig,
  ): Promise<SponsorRuntimeAdapters>;
}

function isAdapterModule(value: unknown): value is SponsorRuntimeAdapterModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "createSponsorRuntimeAdapters" in value &&
    typeof value.createSponsorRuntimeAdapters === "function"
  );
}

export async function loadSponsorRuntimeAdapters(
  moduleUrl: string,
  config: SponsorServiceConfig,
): Promise<SponsorRuntimeAdapters> {
  const loaded: unknown = await import(moduleUrl);
  if (!isAdapterModule(loaded))
    throw new TypeError("adapter module has no supported factory");
  return loaded.createSponsorRuntimeAdapters(config);
}

export async function createSponsorRuntime(
  config: SponsorServiceConfig,
  adapters: SponsorRuntimeAdapters,
) {
  const policy = new SponsorPolicy({
    decoder: adapters.accountAdapter,
    allowedTargets: adapters.allowedTargets,
    ...config.policy,
  });
  return createSponsorServer({
    policy,
    signer: adapters.signer,
    authorizer: adapters.authorizer,
    budgetStore: adapters.budgetStore,
    config: config.sponsorship,
    expectedSigner: config.expectedSigner,
    budgetLimits: config.policy.budgetLimits,
    logLevel: config.logLevel,
  });
}
