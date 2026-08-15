import { useCallback, useRef, useState } from "react";
import {
  classifyProtocolError,
  type TransactionResult,
} from "../../../offchain/sdk/src/index.js";

export interface TransactionActionState {
  pending: boolean;
  message: string;
  result?: TransactionResult;
}

/** One click produces at most one economic transaction; failures are categorized without auto-retry. */
export function useTransactionAction() {
  const active = useRef(false);
  const [state, setState] = useState<TransactionActionState>({
    pending: false,
    message: "",
  });
  const run = useCallback(async (action: () => Promise<TransactionResult>) => {
    if (active.current) return;
    active.current = true;
    setState({ pending: true, message: "Simulating transaction…" });
    try {
      const result = await action();
      setState({
        pending: false,
        message: `Included in block ${result.blockNumber.toString()}: ${result.hash}`,
        result,
      });
    } catch (error: unknown) {
      const details = classifyProtocolError(error);
      const suffix = details.retryableAfterRefresh
        ? " Refresh chain state before retrying."
        : "";
      setState({ pending: false, message: `${details.message}${suffix}` });
    } finally {
      active.current = false;
    }
  }, []);
  return { state, run } as const;
}
