import assert from "node:assert/strict"
import { after, afterEach, test } from "node:test"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { JSDOM } from "jsdom"
import ts from "typescript"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.MutationObserver = dom.window.MutationObserver
globalThis.IS_REACT_ACT_ENVIRONMENT = true
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true })
const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react")
const here = dirname(fileURLToPath(import.meta.url))
const exampleRoot = resolve(here, "..")
const sourcePath = join(exampleRoot, "tanstack-query-react.tsx")
const compiledPath = join(exampleRoot, "tanstack-query-react.test-build.mjs")
const source = readFileSync(sourcePath, "utf8")
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourcePath,
}).outputText
writeFileSync(compiledPath, compiled)
const { OrderEditor, ConflictPicker } = await import(pathToFileURL(compiledPath).href)

const mounted = []
after(() => {
  cleanup()
  dom.window.close()
  rmSync(compiledPath, { force: true })
})
afterEach(() => {
  const entries = mounted.splice(0)
  cleanup()
  for (const entry of entries) entry.client.clear()
})

const order = (overrides = {}) => ({
  status: "pending",
  notes: "before",
  customer: { name: "Mona", phone: "111" },
  ...overrides,
})
const loaded = (state, etag) => ({ state, etag })
async function mountEditor(id, api) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  })
  const entry = { ...render(renderEditor({ client, api }, id)), client, api }
  await waitFor(() => assert.ok(entry.getByLabelText("Notes")))
  mounted.push(entry)
  return entry
}

function renderEditor(entry, id) {
  return React.createElement(
    QueryClientProvider,
    { client: entry.client },
    React.createElement(OrderEditor, { id, api: entry.api }),
  )
}

function notesInput(entry) {
  return entry.getByLabelText("Notes")
}

function radioInputs(entry) {
  return [...entry.container.querySelectorAll('input[type="radio"]')]
}

function button(entry, text) {
  return entry.getByRole("button", { name: text })
}

function changeNotes(entry, value) {
  fireEvent.change(notesInput(entry), { target: { value } })
}

async function submit(entry) {
  fireEvent.submit(entry.container.querySelector("form"))
}

async function applyChoices(entry) {
  const apply = button(entry, "Apply choices")
  assert.ok(apply, "the conflict picker should offer Apply choices")
  fireEvent.click(apply)
}

async function waitForPuts(puts, count) {
  await waitFor(() => assert.equal(puts.length, count))
}

const staleWrite = () => Object.assign(new Error("stale write"), { code: "STALE_WRITE" })

test("keeps a dirty draft across refetch, merges, then saves against the refreshed ETag", async () => {
  const initial = loaded(order(), "e1")
  const refetched = loaded(order({ status: "approved" }), "e2")
  const currentAfterStale = loaded(order({ status: "approved" }), "e2")
  const fetchQueue = [initial, refetched, currentAfterStale]
  const puts = []
  const api = {
    fetchOrder: async () => fetchQueue.shift(),
    putOrder: async (_id, state, etag) => {
      puts.push({ state: structuredClone(state), etag })
      if (etag === "e1") throw staleWrite()
      return loaded(structuredClone(state), etag === "e2" ? "e3" : "e4")
    },
  }
  const entry = await mountEditor("one", api)

  changeNotes(entry, "mine")
  await act(async () => {
    await entry.client.invalidateQueries({ queryKey: ["order", "one"] })
  })
  assert.equal(notesInput(entry).value, "mine", "background data must not replace the draft")

  await submit(entry)
  await waitForPuts(puts, 2)
  assert.equal(puts[0].etag, "e1")
  assert.equal(puts[1].etag, "e2")
  assert.equal(puts[1].state.status, "approved", "the automatic merge keeps the server-only change")
  assert.equal(notesInput(entry).value, "mine")

  changeNotes(entry, "mine again")
  await submit(entry)
  await waitForPuts(puts, 3)
  assert.equal(puts[2].etag, "e3", "the next save uses the baseline returned by the merged save")
  assert.equal(puts[2].state.notes, "mine again")
})

test("preserves edits made while a save is pending and prevents duplicate requests", async () => {
  let finishFirstPut
  const firstPut = new Promise((resolvePut) => { finishFirstPut = resolvePut })
  const puts = []
  const api = {
    fetchOrder: async () => loaded(order(), "e1"),
    putOrder: async (_id, state, etag) => {
      puts.push({ state: structuredClone(state), etag })
      if (puts.length === 1) return firstPut
      return loaded(structuredClone(state), "e3")
    },
  }
  const entry = await mountEditor("one", api)
  changeNotes(entry, "submitted")

  fireEvent.submit(entry.container.querySelector("form"))
  await waitForPuts(puts, 1)
  assert.equal(button(entry, "Save").disabled, true)
  fireEvent.submit(entry.container.querySelector("form"))
  changeNotes(entry, "typed while saving")
  assert.equal(puts.length, 1, "a second submit is ignored while the first request is pending")
  finishFirstPut(loaded(puts[0].state, "e2"))

  await waitFor(() => assert.equal(button(entry, "Save").disabled, false))
  assert.equal(notesInput(entry).value, "typed while saving")
  await submit(entry)
  await waitForPuts(puts, 2)
  assert.equal(puts[1].etag, "e2")
  assert.equal(puts[1].state.notes, "typed while saving")
})

test("switching record IDs starts a fresh draft and ETag session", async () => {
  const puts = []
  const api = {
    fetchOrder: async (id) => loaded(order({ notes: `${id} notes` }), `${id}-etag`),
    putOrder: async (id, state, etag) => {
      puts.push({ id, state: structuredClone(state), etag })
      return loaded(structuredClone(state), `${id}-saved`)
    },
  }
  const entry = await mountEditor("one", api)
  changeNotes(entry, "unsaved one")
  entry.rerender(renderEditor(entry, "two"))
  await waitFor(() => assert.equal(notesInput(entry).value, "two notes"))

  changeNotes(entry, "saved two")
  await submit(entry)
  await waitForPuts(puts, 1)
  assert.equal(puts[0].id, "two")
  assert.equal(puts[0].etag, "two-etag")
})

test("applying choices awaits the save, refreshes editor state, and updates cache", async () => {
  const initial = loaded(order({ notes: "original" }), "e1")
  const latest = loaded(order({ notes: "server" }), "e2")
  const fetchQueue = [initial, latest]
  const puts = []
  const saved = loaded(order({ notes: "mine" }), "e3")
  let finishResolution
  const resolution = new Promise((resolveSaved) => { finishResolution = resolveSaved })
  const api = {
    fetchOrder: async () => fetchQueue.shift(),
    putOrder: async (_id, state, etag) => {
      puts.push({ state: structuredClone(state), etag })
      if (puts.length === 1) throw staleWrite()
      return resolution
    },
  }
  const entry = await mountEditor("one", api)
  changeNotes(entry, "mine")
  await submit(entry)
  await waitFor(() => assert.equal(radioInputs(entry).length, 2))

  fireEvent.click(radioInputs(entry)[0])
  await applyChoices(entry)
  await waitForPuts(puts, 2)
  await waitFor(() => assert.equal(entry.container.querySelector("fieldset").disabled, true))
  assert.equal(entry.getByRole("status").textContent, "Saving…")
  fireEvent.click(button(entry, "Apply choices"))
  assert.equal(puts.length, 2, "the pending resolution cannot be submitted twice")
  finishResolution(saved)
  await waitFor(() => assert.deepEqual(entry.client.getQueryData(["order", "one"]), saved))
  assert.equal(puts[1].etag, "e2")
  assert.equal(puts[1].state.notes, "mine")
  assert.equal(entry.container.querySelector("fieldset"), null, "success clears the conflict")
  assert.equal(notesInput(entry).value, "mine")
})

test("reports a network failure without a code as a save error", async () => {
  const puts = []
  const api = {
    fetchOrder: async () => loaded(order(), "e1"),
    putOrder: async (_id, state, etag) => {
      puts.push({ state: structuredClone(state), etag })
      if (puts.length === 1) throw new TypeError("Failed to fetch")
      return loaded(structuredClone(state), "e2")
    },
  }
  const entry = await mountEditor("one", api)
  changeNotes(entry, "mine")
  await submit(entry)
  await waitFor(() => assert.equal(entry.getByRole("alert").textContent, "Unable to save. Review the request and try again."))
  assert.equal(entry.container.querySelector("fieldset"), null, "a network failure is not a conflict")
  const [failed] = entry.client.getMutationCache().getAll()
  assert.ok(failed.state.error instanceof TypeError, "the original error is rethrown, not a CAMConfigError")
  assert.equal(failed.state.error.message, "Failed to fetch")

  await submit(entry)
  await waitForPuts(puts, 2)
  assert.equal(puts[1].etag, "e1")
  assert.equal(puts[1].state.notes, "mine")
})

test("keeps the conflict visible and reports a failed resolved request", async () => {
  const fetchQueue = [loaded(order({ notes: "original" }), "e1"), loaded(order({ notes: "server" }), "e2")]
  let putCount = 0
  const etags = []
  const api = {
    fetchOrder: async () => fetchQueue.shift(),
    putOrder: async (_id, state, etag) => {
      putCount += 1
      etags.push(etag)
      if (putCount === 1) throw staleWrite()
      if (putCount === 2) throw Object.assign(new Error("offline"), { code: "NETWORK" })
      return loaded(structuredClone(state), "e3")
    },
  }
  const entry = await mountEditor("one", api)
  changeNotes(entry, "mine")
  await submit(entry)
  await waitFor(() => assert.equal(radioInputs(entry).length, 2))
  fireEvent.click(radioInputs(entry)[0])
  await applyChoices(entry)
  await waitFor(() => assert.ok(entry.getByRole("alert").textContent))

  assert.ok(entry.getByRole("group", { name: "Someone else changed these fields" }))
  assert.equal(button(entry, "Apply choices").disabled, false)

  await applyChoices(entry)
  await waitFor(() => assert.equal(putCount, 3))
  assert.deepEqual(etags, ["e1", "e2", "e2"], "the failed resolution keeps its server baseline and ETag")
  await waitFor(() => assert.equal(entry.container.querySelector("fieldset"), null))
})

test("draft edits after a conflict invalidate old choices and survive a fresh merge", async () => {
  const fetchQueue = [
    loaded(order({ notes: "original" }), "e1"),
    loaded(order({ notes: "server one" }), "e2"),
    loaded(order({ notes: "server two" }), "e3"),
  ]
  const puts = []
  const api = {
    fetchOrder: async () => fetchQueue.shift(),
    putOrder: async (_id, state, etag) => {
      puts.push({ state: structuredClone(state), etag })
      throw staleWrite()
    },
  }
  const entry = await mountEditor("one", api)
  changeNotes(entry, "mine")
  await submit(entry)
  await waitFor(() => assert.equal(radioInputs(entry).length, 2))

  fireEvent.click(radioInputs(entry)[0])
  changeNotes(entry, "later draft")
  await applyChoices(entry)
  await waitFor(() => assert.match(entry.getByRole("alert").textContent, /Save again to refresh the choices/))
  assert.equal(puts.length, 1, "choices based on the older draft do not start a save")
  assert.equal(notesInput(entry).value, "later draft")

  await submit(entry)
  await waitFor(() => assert.equal(radioInputs(entry).length, 2))
  assert.equal(puts.length, 2)
  assert.equal(puts[1].etag, "e1", "the refreshed merge starts from the coherent editing session")
  assert.equal(notesInput(entry).value, "later draft")
  assert.match(entry.container.querySelector("fieldset").textContent, /later draft/)
  assert.match(entry.container.querySelector("fieldset").textContent, /server two/)
  assert.equal(radioInputs(entry)[0].checked, false, "the new conflict resets to the server choice")
  assert.equal(radioInputs(entry)[1].checked, true)
})

test("a second stale write creates a new conflict and resets the choice set", async () => {
  const initial = loaded(order({ notes: "original" }), "e1")
  const firstServer = loaded(order({ notes: "server one" }), "e2")
  const secondServer = loaded(order({ notes: "server two" }), "e3")
  const fetchQueue = [initial, firstServer, secondServer]
  const puts = []
  const api = {
    fetchOrder: async () => fetchQueue.shift(),
    putOrder: async (_id, state, etag) => {
      puts.push({ state: structuredClone(state), etag })
      if (puts.length <= 2) throw staleWrite()
      return loaded(structuredClone(state), "e4")
    },
  }
  const entry = await mountEditor("one", api)
  changeNotes(entry, "mine")
  await submit(entry)
  await waitFor(() => assert.equal(radioInputs(entry).length, 2))
  fireEvent.click(radioInputs(entry)[0])
  await applyChoices(entry)
  await waitForPuts(puts, 2)

  assert.equal(radioInputs(entry).length, 2)
  assert.equal(radioInputs(entry)[0].checked, false, "a new conflict resets to the server choice")
  assert.equal(radioInputs(entry)[1].checked, true)
  assert.equal(puts[1].etag, "e2")

  await applyChoices(entry)
  await waitForPuts(puts, 3)
  await waitFor(() => assert.equal(entry.container.querySelector("fieldset"), null))
  assert.equal(puts[2].etag, "e3")
})

test("a changed conflict path cannot inherit the previous path's choice", async () => {
  const firstConflict = {
    path: ["notes"],
    submitted: { exists: true, value: "mine" },
    currentServer: { exists: true, value: "server" },
  }
  const secondConflict = {
    path: ["status"],
    submitted: { exists: true, value: "paid" },
    currentServer: { exists: true, value: "approved" },
  }
  let choice
  const firstInputs = {
    originalState: order({ notes: "base", status: "pending" }),
    submittedState: order({ notes: "mine", status: "pending" }),
    currentServerState: order({ notes: "server", status: "pending" }),
  }
  const secondInputs = {
    originalState: order({ notes: "server", status: "pending" }),
    submittedState: order({ notes: "mine", status: "paid" }),
    currentServerState: order({ notes: "server", status: "approved" }),
  }
  const props = (conflict, inputs) => ({
    pending: { conflicts: [conflict], inputs, etag: "e2" },
    pendingSave: false,
    error: null,
    onResolved: async (state) => { choice = state },
  })
  const view = render(React.createElement(ConflictPicker, props(firstConflict, firstInputs)))
  mounted.push({ ...view, client: new QueryClient() })
  fireEvent.click(radioInputs(view)[0])
  view.rerender(React.createElement(ConflictPicker, props(secondConflict, secondInputs)))

  assert.equal(radioInputs(view)[0].checked, false)
  assert.equal(radioInputs(view)[1].checked, true)
  await applyChoices(view)
  assert.equal(choice.status, "approved", "the old choice must not be transferred to the new path")
})
