// Deterministic local load data through the real ingestion/financial projection path.
import { A, H, env } from "../../dist/offchain/app-core/test/fixtures.js";
import {
  raw,
  block,
} from "../../dist/offchain/indexer/test/financial-fixtures.js";

export async function seedPublicSite(store, sql) {
  const accounts = Array.from({ length: 50 }, (_, i) => A(1000 + i));
  for (const account of accounts)
    await sql`INSERT INTO ledger_tracked_accounts(address,from_block) VALUES(${account.toLowerCase()},1)`;
  for (let m = 0; m < 100; m++) {
    const market = A(10000 + m),
      creator = A(20000 + m),
      n = m * 2 + 1;
    await store.applyBatch(
      [
        raw(
          "MarketInitialized",
          market,
          {
            market,
            creator,
            mode: 0,
            outcomeCount: 2,
            createdAt: 100n,
            closeAt: 2000000000n,
            eventStartsAt: 2000000001n,
            outcomeDeadlineAt: 2000003600n,
            resolutionWindow: 900n,
            marketPrimaryCap: 1000000000n,
            creatorBond: 10000000n,
          },
          n,
          0,
        ),
        raw(
          "MarketCreated",
          env.deployment.factory,
          {
            market,
            creator,
            deploymentMode: 0,
            implementation: A(200),
            salt: H(m + 1),
            runtimeCodeHash: H(202),
            creatorNonce: 0n,
            creationFee: 2000000n,
            creatorBond: 10000000n,
          },
          n,
          1,
        ),
      ],
      [block(n)],
      block(n),
    );
    const events = [];
    for (let i = 0; i < accounts.length; i++) {
      const owner = accounts[i],
        tx = H((n + 1) * 1000 + i);
      const event = (name, contract, args, log) => ({
        ...raw(name, contract, args, n + 1, log, tx),
        transactionIndex: i,
      });
      events.push(
        event(
          "TransferSingle",
          market,
          { operator: owner, from: A(0), to: owner, id: 0n, value: 1000000n },
          i * 2,
        ),
        event(
          "PrimaryPurchased",
          market,
          {
            buyer: owner,
            outcomeId: 0n,
            desiredUnits: 1000000n,
            filledUnits: 1000000n,
            payment: 1000000n,
            earlyBirdWeight: 3,
            cumulativeUserPrimary: 1000000n,
            totalPrincipal: BigInt(i + 1) * 1000000n,
          },
          i * 2 + 1,
        ),
      );
    }
    const seller = accounts[m % 50],
      tx = H((n + 1) * 1000 + 100);
    events.push(
      {
        ...raw(
          "TransferSingle",
          market,
          {
            operator: seller,
            from: seller,
            to: env.deployment.marketplace,
            id: 0n,
            value: 100000n,
          },
          n + 1,
          100,
          tx,
        ),
        transactionIndex: 50,
      },
      {
        ...raw(
          "ListingCreated",
          env.deployment.marketplace,
          {
            listingId: H(50000 + m),
            vault: market,
            seller,
            outcomeId: 0n,
            amount: 100000n,
            unitPrice: 1000000n,
            expiresAt: 2000000000n,
            sellerNonce: BigInt(m),
          },
          n + 1,
          101,
          tx,
        ),
        transactionIndex: 50,
      },
    );
    await store.applyBatch(events, [block(n + 1)], block(n + 1));
    await sql`UPDATE markets SET rules_hash=${H(90000 + m)} WHERE market=${market.toLowerCase()}`;
    await sql`INSERT INTO public_market_metadata(market,rules_hash,question,verified) VALUES(${market.toLowerCase()},${H(90000 + m)},${`Local capacity fixture market ${m}`},true)`;
  }
  await store.financial.accountScanned(
    accounts,
    1n,
    200n,
    block(200).blockHash,
  );
  await sql.unsafe("ANALYZE");
  const [counts] =
    await sql`SELECT (SELECT count(*)::int FROM markets) AS markets,(SELECT count(*)::int FROM listings) AS listings,(SELECT count(*)::int FROM chain_events) AS raw_events,(SELECT count(*)::int FROM ledger_facts) AS facts`;
  if (
    counts.markets !== 100 ||
    counts.listings !== 100 ||
    counts.raw_events !== 10400 ||
    counts.facts < 5000
  )
    throw new Error("capacity fixture ingestion is incomplete");
  return {
    ...counts,
    accounts: accounts.length,
    throughBlock: "200",
    realChainData: false,
  };
}
