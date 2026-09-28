// Representative mergeStates() benchmarks. Run with `npm run bench`.
// Set CAM_DIST to a built dist/index.js to benchmark another build, and
// CAM_BENCH_JSON to a file path to also write machine-readable results.
import { writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"
import { mergeArrayById } from "./prototypes/array-by-id.mjs"

const distPath = process.env.CAM_DIST
  ? pathToFileURL(resolve(process.env.CAM_DIST)).href
  : new URL("../dist/index.js", import.meta.url).href
const { mergeStates } = await import(distPath)

const BUDGET_MS = Number(process.env.CAM_BENCH_MS ?? 500)
const results = {}

function bench(name, makeInput, run = mergeStates) {
  const input = makeInput()
  for (let warmup = 0; warmup < 5; warmup += 1) run(input)

  let iterations = 0
  const start = performance.now()
  let elapsed = 0
  while (elapsed < BUDGET_MS) {
    run(input)
    iterations += 1
    elapsed = performance.now() - start
  }

  const perOp = elapsed / iterations
  results[name] = perOp
  const formatted = perOp < 1 ? `${(perOp * 1000).toFixed(1)} µs` : `${perOp.toFixed(2)} ms`
  console.log(`${name.padEnd(40)} ${formatted.padStart(12)}/op  (${iterations} runs)`)
}

const order = (overrides = {}) => ({
  id: "ord_123",
  status: "pending",
  currency: "EGP",
  notes: "Leave at the door",
  customer: { name: "Mona", phone: "111", email: "mona@example.com", tier: "gold" },
  shippingAddress: { street: "Tahrir", city: "Cairo", zip: "11511", country: "EG" },
  billingAddress: { street: "Tahrir", city: "Cairo", zip: "11511", country: "EG" },
  items: Array.from({ length: 20 }, (_, index) => ({
    sku: `sku-${index}`,
    qty: index + 1,
    price: 10 * index,
  })),
  tags: ["priority", "gift"],
  ...Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, index])),
  ...overrides,
})

const wide = (size, value) =>
  Object.fromEntries(Array.from({ length: size }, (_, index) => [`k${index}`, value(index)]))

const chain = (depth, leaf, sibling = 0) => {
  let node = { leaf }
  for (let level = 0; level < depth; level += 1) node = { child: node, sibling }
  return node
}

bench("order form, clean merge", () => {
  const originalState = order()
  return {
    originalState,
    submittedState: order({ shippingAddress: { ...originalState.shippingAddress, city: "Giza" } }),
    currentServerState: order({ customer: { ...originalState.customer, phone: "222" } }),
  }
})

bench(
  "order form, clean merge with report",
  () => {
    const originalState = order()
    return {
      originalState,
      submittedState: order({ shippingAddress: { ...originalState.shippingAddress, city: "Giza" } }),
      currentServerState: order({ customer: { ...originalState.customer, phone: "222" } }),
    }
  },
  (input) => mergeStates({ ...input, includeReport: true }),
)

bench("order form, 3 conflicts", () => ({
  originalState: order(),
  submittedState: order({ status: "paid", notes: "Ring", tags: ["gift"] }),
  currentServerState: order({ status: "void", notes: "Knock", tags: [] }),
}))

bench("wide object, 10k keys", () => {
  const originalState = wide(10_000, (index) => ({ value: index }))
  return {
    originalState,
    submittedState: { ...originalState, k1: { value: -1 } },
    currentServerState: { ...originalState, k2: { value: -2 } },
  }
})

bench("deep chain, 500 levels", () => ({
  originalState: chain(500, 1),
  submittedState: chain(500, 2),
  currentServerState: chain(500, 1, 1),
}))

bench("atomic arrays, 5k items", () => {
  const items = Array.from({ length: 5_000 }, (_, index) => ({ id: index, qty: 1 }))
  return {
    originalState: { items, note: "a" },
    submittedState: { items: items.map((item) => ({ ...item })), note: "b" },
    currentServerState: { items: [...items, { id: -1, qty: 1 }], note: "a" },
  }
})

const sparseArrayScenario = () => {
  const originalState = Array.from({ length: 200 }, (_, index) => ({
    id: `item-${index}`,
    qty: 1,
    price: index + 10,
  }))
  const submittedState = originalState.map((item, index) =>
    index === 10 ? { ...item, qty: 2 } : { ...item },
  )
  const currentServerState = originalState.map((item, index) =>
    index === 150 ? { ...item, price: item.price + 5 } : { ...item },
  )
  return { originalState, submittedState, currentServerState }
}

bench("atomic arrays, 200 sparse record edits", () => {
  const { originalState, submittedState, currentServerState } = sparseArrayScenario()
  return {
    originalState: { items: originalState },
    submittedState: { items: submittedState },
    currentServerState: { items: currentServerState },
  }
})

bench(
  "experimental ID arrays, 200 sparse edits",
  sparseArrayScenario,
  mergeArrayById,
)

bench("10k conflicts", () => ({
  originalState: wide(10_000, (index) => index),
  submittedState: wide(10_000, (index) => -index - 1),
  currentServerState: wide(10_000, (index) => index + 1e6),
}))

if (typeof globalThis.gc === "function") {
  const allocationInput = (() => {
    const originalState = order()
    return {
      originalState,
      submittedState: order({
        status: "processing",
        notes: "Ring twice",
        shippingAddress: { ...originalState.shippingAddress, city: "Giza" },
      }),
      currentServerState: order({
        status: "cancelled",
        customer: { ...originalState.customer, phone: "222" },
        tags: ["gift"],
      }),
    }
  })()
  const retainedCount = Number(process.env.CAM_BENCH_RETAINED_RESULTS ?? 2_000)
  const retainedHeapPerResult = (includeReport) => {
    globalThis.gc()
    const before = process.memoryUsage().heapUsed
    const retained = []
    for (let index = 0; index < retainedCount; index += 1) {
      retained.push(mergeStates({
        ...allocationInput,
        ...(includeReport ? { includeReport: true } : {}),
      }))
    }
    globalThis.gc()
    const after = process.memoryUsage().heapUsed
    const bytes = (after - before) / retainedCount
    retained.length = 0
    globalThis.gc()
    return bytes
  }
  const withoutReport = retainedHeapPerResult(false)
  const withReport = retainedHeapPerResult(true)
  console.log(`retained output heap, reports off/on: ${withoutReport.toFixed(1)} / ${withReport.toFixed(1)} bytes/result`)
} else {
  console.log("retained output heap measurement skipped; run Node with --expose-gc")
}

if (process.env.CAM_BENCH_JSON) {
  writeFileSync(process.env.CAM_BENCH_JSON, `${JSON.stringify(results, null, 2)}\n`)
}
