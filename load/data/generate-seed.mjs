import fs from "node:fs";
import { once } from "node:events";

const output = process.env.SEED_OUTPUT;
if (output === undefined || output.length === 0) {
  throw new Error("SEED_OUTPUT must name the NDJSON output file");
}
const marketCount = integer("SEED_MARKETS", 100, 1, 10_000);
const listingsPerMarket = integer(
  "SEED_LISTINGS_PER_MARKET",
  1_000,
  1,
  100_000,
);
const totalListings = marketCount * listingsPerMarket;
if (
  totalListings > 10_000 &&
  process.env.CPREDICT_LOAD_CONFIRM !== "I_UNDERSTAND_RESOURCE_USAGE"
) {
  throw new Error(
    "large seed generation requires explicit resource acknowledgement",
  );
}

const stream = fs.createWriteStream(output, { flags: "wx", encoding: "utf8" });
for (let marketId = 0; marketId < marketCount; marketId += 1) {
  await write({
    type: "market",
    id: marketId,
    vault: address(marketId + 1),
    state: "OPEN",
    totalPrincipal: String((marketId + 1) * 1_000_000),
  });
}
for (let marketId = 0; marketId < marketCount; marketId += 1) {
  for (
    let listingIndex = 0;
    listingIndex < listingsPerMarket;
    listingIndex += 1
  ) {
    const globalId = marketId * listingsPerMarket + listingIndex;
    await write({
      type: "listing",
      id: `0x${globalId.toString(16).padStart(64, "0")}`,
      marketId,
      outcomeId: globalId % 2,
      seller: address(globalId + 10_001),
      remainingUnits: String(10_000 + (globalId % 100) * 1_000),
      unitPrice: String(500_000 + (globalId % 500_000)),
      active: true,
    });
  }
}
stream.end();
await once(stream, "finish");
process.stdout.write(
  `${JSON.stringify({ output, marketCount, totalListings })}\n`,
);

async function write(record) {
  if (!stream.write(`${JSON.stringify(record)}\n`)) await once(stream, "drain");
}

function address(value) {
  return `0x${value.toString(16).padStart(40, "0")}`;
}

function integer(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer within [${minimum}, ${maximum}]`,
    );
  }
  return value;
}
