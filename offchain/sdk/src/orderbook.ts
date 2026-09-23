import { parseAbi } from "viem";

/** V2 order IDs are deployment-local uint256 values; never interpret them as V1 listing hashes. */
export const orderbookAbi = parseAbi([
  "function createOrder(address vault,uint8 outcomeId,uint8 side,uint128 units,uint128 unitPrice,uint64 expiresAt,bool autoMatch) returns(uint256 id)",
  "function fillOrder(uint256 id,uint128 desiredUnits,uint128 minUnits,uint256 paymentLimit,uint64 deadline) returns(uint256 units,uint256 gross)",
  "function cancelOrder(uint256 id)",
  "function releaseOrder(uint256 id)",
  "function withdrawOrderShares(uint256 id,address recipient)",
  "function matchOrders(address vault,uint8 outcomeId,uint256 maxSteps) returns(uint256 fills)",
  "function orders(uint256 id) view returns(address vault,address owner,uint128 remainingUnits,uint128 unitPrice,uint64 expiresAt,uint8 outcomeId,uint8 side,bool autoMatch,bool active,uint256 lockedPayment)",
  "function pendingShares(uint256 id) view returns(uint256)",
  "function receiverRecoveryVersion() pure returns(uint256)",
  "function bestOrder(address vault,uint8 outcomeId,uint8 side) view returns(uint256)",
  "function nextOrderId() view returns(uint256)",
  "function totalLockedPayment() view returns(uint256)",
  "event OrderCreated(uint256 indexed orderId,address indexed vault,address indexed owner,uint8 outcomeId,uint8 side,uint256 units,uint256 unitPrice,uint64 expiresAt,bool autoMatch,uint256 lockedPayment)",
  "event OrderReleased(uint256 indexed orderId,address indexed owner,uint8 reason,uint256 returnedUnits,uint256 returnedPayment)",
  "event OrderFilled(uint256 indexed orderId,address indexed buyer,address indexed seller,uint256 units,uint256 unitPrice,uint256 gross,uint256 platformFee,uint256 creatorFee,uint256 remainingUnits,uint256 lockedPayment)",
  "event TradeExecuted(uint256 indexed orderId,address indexed vault,address indexed buyer,address seller,uint8 outcomeId,uint256 units,uint256 unitPrice,uint256 gross,uint256 platformFee,uint256 creatorFee,bool escrowed,uint256 remainingAskUnits)",
  "event OrdersMatched(uint256 indexed bidId,uint256 indexed askId,uint256 indexed makerId,uint256 units,uint256 unitPrice)",
  "event BidExcessReturned(uint256 indexed orderId,address indexed owner,uint256 amount)",
  "event OrderSharesDeferred(uint256 indexed orderId,address indexed owner,uint256 units)",
  "event OrderSharesWithdrawn(uint256 indexed orderId,address indexed owner,address indexed recipient,uint256 units)",
]);
export function bidReserve(units: bigint, price: bigint): bigint {
  return (units * price + 999_999n) / 1_000_000n;
}
