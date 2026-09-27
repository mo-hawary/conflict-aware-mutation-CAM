import { mergeStates, type MergeResult } from "../../src/index.js"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const assertType = <T extends true>(): T => true as T

type Order = {
  id: string
  phone?: string
  shippingAddress: { city: string }
}

declare const order: Order

const result = mergeStates<Order>({
  originalState: order,
  submittedState: order,
  currentServerState: order,
})

assertType<Equal<typeof result, MergeResult<Order>>>()

if (result.ok) {
  assertType<Equal<typeof result.value, Order>>()
} else {
  // @ts-expect-error conflict results never expose a partially merged value
  void result.value
}

// Documented limitation: interfaces lack an implicit index signature, so they
// are not assignable to JsonValue. Use a `type` alias instead.
interface OrderInterface {
  id: string
}
declare const orderInterface: OrderInterface
// @ts-expect-error interfaces are not assignable to JsonValue
mergeStates({ originalState: orderInterface, submittedState: orderInterface, currentServerState: orderInterface })
