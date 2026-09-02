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

/**
 * Runs one deliberate user action. The action may contain a confirmed bounded
 * authorization followed by one economic transaction; neither step auto-retries.
 */
export function useTransactionAction() {
  const active = useRef(false);
  const [state, setState] = useState<TransactionActionState>({
    pending: false,
    message: "",
  });
  const run = useCallback(async (action: () => Promise<TransactionResult>) => {
    if (active.current) return;
    active.current = true;
    setState({ pending: true, message: "Checking authorization and simulating…" });
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
