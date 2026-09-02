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
    setState({
      pending: true,
      message: "正在检查授权并模拟…",
    });
    try {
      const result = await action();
      setState({
        pending: false,
        message: `已纳入区块 ${result.blockNumber.toString()}：${result.hash}`,
        result,
      });
    } catch (error: unknown) {
      const details = classifyProtocolError(error);
      setState({ pending: false, message: details.message });
    } finally {
      active.current = false;
    }
  }, []);
  return { state, run } as const;
}
