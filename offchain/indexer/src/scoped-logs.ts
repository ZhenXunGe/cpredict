import {
  getAddress,
  parseAbiItem,
  type Address,
  type Log,
  type PublicClient,
} from "viem";
import { entryPoint07Address, entryPoint07Abi } from "viem/account-abstraction";
const transfer = parseAbiItem(
  "event Transfer(address indexed from,address indexed to,uint256 value)",
);
const userOperation = entryPoint07Abi.find(
  (e) => e.type === "event" && e.name === "UserOperationEvent",
)!;

/** Never scans the payment token or EntryPoint without a verified account topic filter. */
export async function scopedAccountLogs(
  client: PublicClient,
  paymentToken: Address,
  accounts: readonly Address[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Log[]> {
  const unique = [...new Set(accounts.map((a) => getAddress(a)))],
    logs: Log[] = [];
  for (let offset = 0; offset < unique.length; offset += 50) {
    const owners = unique.slice(offset, offset + 50);
    const result = await Promise.all([
      client.getLogs({
        address: paymentToken,
        event: transfer,
        args: { from: owners },
        fromBlock,
        toBlock,
        strict: true,
      }),
      client.getLogs({
        address: paymentToken,
        event: transfer,
        args: { to: owners },
        fromBlock,
        toBlock,
        strict: true,
      }),
      client.getLogs({
        address: entryPoint07Address,
        event: userOperation,
        args: { sender: owners },
        fromBlock,
        toBlock,
        strict: true,
      }),
    ]);
    for (const group of result) logs.push(...group);
  }
  return logs;
}
