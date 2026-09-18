import { expect, test } from "vitest";
import { checkCreationTime } from "../src/market-creation.js";
test("rejects the observed 4m57s failure and the five-minute signing race", () => {
  expect(() => checkCreationTime(1789627200n, 1789626903n)).toThrow();
  expect(() => checkCreationTime(1300n, 1000n)).toThrow();
  expect(() => checkCreationTime(1359n, 1000n)).toThrow();
  expect(() => checkCreationTime(1360n, 1000n)).not.toThrow();
});
test("uses fresh chain time and retains the contract's maximum horizon", () => {
  expect(() => checkCreationTime(1360n, 1001n)).toThrow();
  expect(() => checkCreationTime(1000n + 90n * 86400n, 1000n)).not.toThrow();
  expect(() => checkCreationTime(1001n + 90n * 86400n, 1000n)).toThrow();
});
