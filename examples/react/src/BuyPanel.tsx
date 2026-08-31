import { useMemo, useState, type FormEvent } from "react";
import { getAddress, isAddress, type Address } from "viem";
import {
  classifyProtocolError,
  parseShareUnits,
  parseUsdc,
  type TransactionResult,
} from "../../../offchain/sdk/src/index.js";
import { transactionDeadline } from "./transactionTiming.js";

export interface BuyExecutor {
  buy(input: {
    vault: Address;
    outcomeId: bigint;
    desiredUnits: bigint;
    minimumUnits: bigint;
    maximumPayment: bigint;
    deadline: bigint;
  }): Promise<TransactionResult>;
}

interface BuyPanelProps {
  client: BuyExecutor;
  vault: Address;
  outcomeCount: number;
}

/** Minimal integration example: explicit slippage, exact decimal parsing and click de-duplication. */
export function BuyPanel({ client, vault, outcomeCount }: BuyPanelProps) {
  const [outcome, setOutcome] = useState("0");
  const [shares, setShares] = useState("1");
  const [maximumPayment, setMaximumPayment] = useState("1");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const normalizedVault = useMemo(() => {
    if (!isAddress(vault)) throw new TypeError("invalid vault address");
    return getAddress(vault);
  }, [vault]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setMessage("Simulating transaction…");
    try {
      const outcomeId = BigInt(outcome);
      if (outcomeId < 0n || outcomeId >= BigInt(outcomeCount)) {
        throw new RangeError("outcome is outside this market");
      }
      const desiredUnits = parseShareUnits(shares);
      const maximum = parseUsdc(maximumPayment);
      const result = await client.buy({
        vault: normalizedVault,
        outcomeId,
        desiredUnits,
        minimumUnits: desiredUnits,
        maximumPayment: maximum,
        deadline: transactionDeadline(),
      });
      setMessage(
        `Included in block ${result.blockNumber.toString()}: ${result.hash}`,
      );
    } catch (error: unknown) {
      setMessage(classifyProtocolError(error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} aria-busy={pending}>
      <label>
        Outcome
        <input
          inputMode="numeric"
          value={outcome}
          onChange={(event) => setOutcome(event.currentTarget.value)}
          required
        />
      </label>
      <label>
        Shares
        <input
          inputMode="decimal"
          value={shares}
          onChange={(event) => setShares(event.currentTarget.value)}
          required
        />
      </label>
      <label>
        Maximum USDC payment
        <input
          inputMode="decimal"
          value={maximumPayment}
          onChange={(event) => setMaximumPayment(event.currentTarget.value)}
          required
        />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "Submitting…" : "Buy"}
      </button>
      <output aria-live="polite">{message}</output>
    </form>
  );
}
