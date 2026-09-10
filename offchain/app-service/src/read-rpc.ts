import { z } from "zod";
import {
  AppError,
  address,
  bytes,
  hash,
} from "../../app-core/src/contracts.js";
import type { RpcTransport } from "./http.js";

const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][\da-fA-F]{0,63})$/);
const block = z.union([
  quantity,
  z.enum(["latest", "pending", "safe", "finalized", "earliest"]),
]);
/** Read-only proxy needed by the official wallet SDK. No arbitrary RPC, batches, traces or state overrides. */
export async function readRpc(
  rpc: RpcTransport,
  method: string,
  input: unknown[],
): Promise<unknown> {
  let params: unknown[];
  switch (method) {
    case "eth_chainId":
    case "eth_blockNumber":
    case "eth_gasPrice":
    case "eth_maxPriorityFeePerGas":
      params = z.tuple([]).parse(input);
      break;
    case "eth_getCode":
    case "eth_getBalance":
      params = z.tuple([address, block]).parse(input);
      break;
    case "eth_getStorageAt":
      params = z.tuple([address, quantity, block]).parse(input);
      break;
    case "eth_getTransactionReceipt":
      params = z.tuple([hash]).parse(input);
      break;
    case "eth_getBlockByNumber":
      params = z.tuple([block, z.literal(false)]).parse(input);
      break;
    case "eth_getBlockByHash":
      params = z.tuple([hash, z.literal(false)]).parse(input);
      break;
    case "eth_call":
      params = z
        .tuple([
          z.strictObject({
            to: address,
            data: bytes,
            from: address.optional(),
            gas: quantity.refine((v) => BigInt(v) <= 10_000_000n).optional(),
          }),
          block,
        ])
        .parse(input);
      break;
    case "eth_feeHistory":
      params = z
        .tuple([
          quantity.refine((v) => BigInt(v) <= 100n),
          block,
          z.array(z.number().min(0).max(100)).max(20),
        ])
        .parse(input);
      break;
    default:
      throw new AppError("rpc_method_not_allowed", 403);
  }
  return rpc.request(method, params);
}
