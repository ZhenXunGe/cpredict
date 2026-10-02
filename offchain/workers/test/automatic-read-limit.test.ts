import { it, expect } from "vitest";
import {
  AutomaticReadLimit,
  claimPollDelay,
} from "../src/automatic-read-limit.js";
it("bounds discovery reads and releases slots after failure", async () => {
  const limit = new AutomaticReadLimit(4);
  let active = 0,
    max = 0;
  await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) =>
      limit.run(async () => {
        active++;
        max = Math.max(active, max);
        try {
          await new Promise((r) => setTimeout(r, 1));
          if (i === 1) throw new Error("failure");
        } finally {
          active--;
        }
      }),
    ),
  );
  expect(max).toBe(4);
  expect(await limit.run(async () => 42)).toBe(42);
});
it("unknown queue state and errors never use the idle delay", () => {
  expect(claimPollDelay(null, null, true, 30000)).toBe(2000);
  expect(claimPollDelay(0, true, false, 30000)).toBe(2000);
  expect(claimPollDelay(0, false, false, 30000)).toBe(30000);
});
