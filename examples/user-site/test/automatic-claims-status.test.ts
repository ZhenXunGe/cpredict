import { it, expect } from "vitest";
import {
  automaticQueueMessage,
  automaticClaimsRefresh,
} from "../src/automatic-claims-status.js";
import { automaticClaimsStatusSchema } from "../../../offchain/app-core/src/orderbook-contracts.js";
const queue = {
  state: "queued" as const,
  readyCount: 2,
  inFlightCount: 0,
  deferredCount: 1,
  oldestQueuedAt: null,
  updatedAt: null,
  reason: null,
};
it("shows unsigned work separately from received transactions", () => {
  expect(automaticQueueMessage(queue)).toBe("有 3 项权益等待自动领取");
  expect(
    automaticQueueMessage({ ...queue, state: "confirming", inFlightCount: 1 }),
  ).toBe("正在确认 1 笔领取交易");
  expect(automaticQueueMessage({ ...queue, state: "unavailable" })).toContain(
    "暂不可用",
  );
  expect(
    automaticQueueMessage({
      ...queue,
      state: "paused",
      reason: "gas_balance_insufficient",
    }),
  ).toContain("Gas 余额不足");
});
it("preserves old API and pauses hidden-page refresh", () => {
  expect(
    automaticClaimsStatusSchema.parse({
      enabled: true,
      reason: "waiting_for_entitlement",
      updatedAt: null,
      transactions: [],
      nextCursor: null,
    }).queue,
  ).toBeUndefined();
  expect(automaticQueueMessage(undefined)).toBeNull();
  expect(automaticClaimsRefresh(queue, true)).toBe(2000);
  expect(automaticClaimsRefresh(undefined, true)).toBe(5000);
  expect(automaticClaimsRefresh(queue, false)).toBe(false);
});
