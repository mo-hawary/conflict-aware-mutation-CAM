import assert from "node:assert/strict"
import { after, afterEach, test } from "node:test"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import React from "react"
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query"
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
async function mountEditor(id, api, recovery) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  })
  const entry = { ...render(renderEditor({ client, api }, id, recovery)), client, api }
  await waitFor(() => assert.ok(entry.getByLabelText("Notes")))
  mounted.push(entry)
  return entry
}

function renderEditor(entry, id, recovery) {
  return React.createElement(
    QueryClientProvider,
    { client: entry.client },
    React.createElement(OrderEditor, { id, api: entry.api, recovery }),
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

async function confirmReview(entry) {
  const confirm = button(entry, "Confirm")
  assert.ok(confirm, "the review should offer an explicit Confirm action")
  assert.equal(confirm.disabled, false, "the candidate must be valid and fully resolved before confirmation")
  fireEvent.click(confirm)
}

test("review does not write before explicit confirmation and cancel performs no write", async () => {
  const initial = loaded(order({ notes: "original" }), "e1")
  const latest = loaded(order({ status: "approved", notes: "original" }), "e2")
  const puts = []
  const api = {
    fetchOrder: async () => puts.length ? latest : initial,
    putOrder: async (_id, state, etag) => {
      puts.push({ state: structuredClone(state), etag })
      if (puts.length === 1) throw staleWrite()
      return loaded(structuredClone(state), "e3")
    },
  }
  const entry = await mountEditor("one", api)
  changeNotes(entry, "mine")
  await submit(entry)
  await waitFor(() => assert.equal(puts.length, 1))
  await waitFor(() => assert.equal(button(entry, "Confirm").disabled, false))
  fireEvent.click(button(entry, "Cancel"))
  assert.equal(puts.length, 1)
})

test("a conflict cannot be confirmed until each choice is explicitly applied", async () => {
  const fetchQueue = [loaded(order({ notes: "original" }), "e1"), loaded(order({ notes: "server" }), "e2")]
  const puts = []
  const api = {
    fetchOrder: async () => fetchQueue.shift(),
    putOrder: async (_id, state, etag) => {
      puts.push({ state: structuredClone(state), etag })
      if (puts.length === 1) throw staleWrite()
      return loaded(structuredClone(state), "e3")
    },
  }
  const entry = await mountEditor("one", api)
  changeNotes(entry, "mine")
  await submit(entry)
  await waitFor(() => assert.equal(radioInputs(entry).length, 2))
  assert.equal(radioInputs(entry).every((input) => !input.checked), true)
  assert.equal(button(entry, "Apply choices").disabled, true)
  assert.equal(button(entry, "Confirm").disabled, true)
})

async function waitForPuts(puts, count) {
  await waitFor(() => assert.equal(puts.length, count))
}

const staleWrite = () => Object.assign(new Error("stale write"), { code: "STALE_WRITE" })

test("invalid review candidates stay visible and require repair before confirmation", async () => {
  const fetchQueue = [
    loaded(order({ notes: "before" }), "e1"),
    loaded(order({ status: "approved", notes: "before" }), "e2"),
  ]
  const puts = []
  const api = {
    fetchOrder: async () => fetchQueue.shift(),
    putOrder: async (_id, state, etag) => {
      puts.push({ state: structuredClone(state), etag })
      if (puts.length === 1) throw staleWrite()
      return loaded(structuredClone(state), "e3")
    },
  }
  const recovery = {
    prepareCandidate: (candidate) => ({ ...candidate, notes: candidate.notes.trim() }),
    validateCandidate: (candidate) => candidate.notes === "invalid" ? "Notes need correction" : undefined,
  }
  const entry = await mountEditor("one", api, recovery)
  changeNotes(entry, "invalid")
  await submit(entry)
  await waitFor(() => assert.equal(button(entry, "Confirm").disabled, true))
  assert.equal(puts.length, 1, "an invalid candidate is never persisted")
  assert.match(entry.getByRole("alert").textContent, /Notes need correction/)

  changeNotes(entry, "fixed")
  await waitFor(() => assert.equal(button(entry, "Confirm").disabled, false))
  assert.equal(notesInput(entry).value, "fixed")
  await confirmReview(entry)
  await waitForPuts(puts, 2)
  assert.equal(puts[1].etag, "e2")
  assert.equal(puts[1].state.notes, "fixed")
})

test("terminal latest state blocks choices and confirmation", async () => {
  const fetchQueue = [
    loaded(order(), "e1"),
    loaded(order({ status: "cancelled" }), "e2"),
  ]
  const puts = []
  const api = {
    fetchOrder: async () => fetchQueue.shift(),
    putOrder: async (_id, state, etag) => {
      puts.push({ state, etag })
      throw staleWrite()
    },
  }
  const entry = await mountEditor("one", api, {
    isTerminal: (state) => state.status === "cancelled",
  })
  changeNotes(entry, "mine")
  await submit(entry)
  await waitFor(() => assert.ok(entry.getByRole("group", { name: "This order can no longer be edited" })))
  assert.equal(button(entry, "Confirm").disabled, true)
  assert.equal(button(entry, "Save").disabled, true)
  assert.equal(entry.container.querySelector('button[type="button"]'), null, "terminal state cannot be dismissed into an editable form")
  assert.equal(puts.length, 1)
})

test("a stale confirmation returns to review without an automatic second recovery write", async () => {
  const fetchQueue = [
    loaded(order(), "e1"),
    loaded(order({ status: "approved" }), "e2"),
    loaded(order({ status: "shipped" }), "e3"),
  ]
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
  await waitForPuts(puts, 1)
  await confirmReview(entry)
  await waitForPuts(puts, 2)
  await waitFor(() => assert.equal(button(entry, "Confirm").disabled, false))
  assert.equal(puts.length, 2, "a second stale response cannot trigger another write")
  assert.equal(puts[1].etag, "e2")

  await confirmReview(entry)
  await waitForPuts(puts, 3)
  assert.equal(puts[2].etag, "e3", "the refreshed review is guarded by the newest ETag")
  assert.equal(puts[2].state.status, "shipped")
  assert.equal(puts[2].state.notes, "mine")
})

test("a refetch started during a save cannot replace saved cache data or subscribers", async () => {
  const initial = loaded(order(), "e1")
  const staleRefetch = loaded(order({ notes: "stale refetch" }), "e1")
  const saved = loaded(order({ notes: "saved" }), "e2")
  let finishSave
  let finishRefetch
  let backgroundRefetches = 0
  let fetchCount = 0
  const savePromise = new Promise((resolveSaved) => { finishSave = resolveSaved })
  const refetchPromise = new Promise((resolveFetched) => { finishRefetch = resolveFetched })
  const api = {
    fetchOrder: async () => {
      fetchCount += 1
      if (fetchCount === 1) return initial
      backgroundRefetches += 1
      return refetchPromise
    },
    putOrder: async () => savePromise,
  }
  const entry = await mountEditor("one", api)
  const observer = new QueryObserver(entry.client, {
    queryKey: ["order", "one"],
    enabled: false,
  })
  const observedEtags = []
  const unsubscribe = observer.subscribe(({ data }) => {
    if (data) observedEtags.push(data.etag)
  })

  changeNotes(entry, "saved")
  fireEvent.submit(entry.container.querySelector("form"))
  await waitFor(() => assert.equal(button(entry, "Save").disabled, true))

  let invalidation
  act(() => {
    invalidation = entry.client.invalidateQueries({ queryKey: ["order", "one"] })
  })
  await waitFor(() => assert.equal(backgroundRefetches, 1))

  await act(async () => { finishSave(saved) })
  await waitFor(() => assert.deepEqual(entry.client.getQueryData(["order", "one"]), saved))
  await act(async () => {
    finishRefetch(staleRefetch)
    await invalidation
  })

  assert.deepEqual(entry.client.getQueryData(["order", "one"]), saved)
  assert.deepEqual(observer.getCurrentResult().data, saved)
  assert.ok(observedEtags.includes("e2"), "other query subscribers observe the committed save")
  assert.equal(observer.getCurrentResult().data.etag, "e2")
  unsubscribe()
  observer.destroy()
})

test("keeps a dirty draft across refetch, reviews the merge, then confirms against the refreshed ETag", async () => {
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
  await waitForPuts(puts, 1)
  assert.equal(puts[0].etag, "e1")
  assert.equal(button(entry, "Confirm").disabled, false)
  assert.equal(button(entry, "Save").disabled, true)
  assert.equal(puts.length, 1, "a clean structural merge is review-only")
  assert.deepEqual(
    [...entry.container.querySelectorAll('[aria-label="Change summary"] li')].map((item) => item.textContent),
    ["/notes: submitted-only", "/status: server-only"],
  )

  await confirmReview(entry)
  await waitForPuts(puts, 2)
  assert.equal(puts[1].etag, "e2")
  assert.equal(puts[1].state.status, "approved", "the reviewed merge keeps the server-only change")
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

test("review edits are revalidated and confirmation adopts server changes", async () => {
  const fetchQueue = [
    loaded(order(), "e1"),
    loaded(order({ status: "approved" }), "e2"),
  ]
  const puts = []
  let finishAutomaticSave
  const automaticSave = new Promise((resolveSaved) => { finishAutomaticSave = resolveSaved })
  const api = {
    fetchOrder: async () => fetchQueue.shift(),
    putOrder: async (_id, state, etag) => {
      puts.push({ state: structuredClone(state), etag })
      if (puts.length === 1) throw staleWrite()
      if (puts.length === 2) return automaticSave
      return loaded(structuredClone(state), "e4")
    },
  }
  const entry = await mountEditor("one", api)
  changeNotes(entry, "submitted notes")

  fireEvent.submit(entry.container.querySelector("form"))
  await waitForPuts(puts, 1)
  assert.equal(button(entry, "Confirm").disabled, false)
  assert.equal(puts.length, 1, "the stale recovery does not auto-save a merged candidate")

  changeNotes(entry, "newer notes")
  await confirmReview(entry)
  await waitForPuts(puts, 2)
  assert.equal(puts[1].etag, "e2")
  assert.equal(puts[1].state.status, "approved", "the reviewed candidate keeps the server-only change")
  assert.equal(puts[1].state.notes, "newer notes", "candidate edits are included after preparation")
  assert.equal(notesInput(entry).disabled, true, "the candidate cannot change after confirmation starts")
  finishAutomaticSave(loaded(puts[1].state, "e3"))
  await waitFor(() => assert.equal(button(entry, "Save").disabled, false))
  assert.equal(notesInput(entry).value, "newer notes")

  changeNotes(entry, "latest notes")
  await submit(entry)
  await waitForPuts(puts, 3)
  assert.equal(puts[2].etag, "e3", "the next save uses the automatically saved ETag")
  assert.equal(puts[2].state.status, "approved", "the next save retains the server change")
  assert.equal(puts[2].state.notes, "latest notes", "the next save retains newer typing")
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

test("applying choices prepares a candidate; explicit confirmation saves and updates cache", async () => {
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
  assert.equal(button(entry, "Confirm").disabled, true, "unresolved conflicts cannot be persisted")
  assert.equal(puts.length, 1)

  fireEvent.click(radioInputs(entry)[0])
  assert.equal(radioInputs(entry)[0].checked, true, "Yours is the selected resolution")
  await applyChoices(entry)
  assert.equal(puts.length, 1, "applying choices does not write")
  assert.equal(button(entry, "Confirm").disabled, false)
  assert.match(entry.getByLabelText("Change summary").textContent, /\/notes: chosen-submitted/)
  await confirmReview(entry)
  await waitForPuts(puts, 2)
  await waitFor(() => assert.equal(entry.container.querySelector("fieldset").disabled, true))
  assert.equal(entry.getByRole("status").textContent, "Saving…")
  fireEvent.click(button(entry, "Confirm"))
  assert.equal(puts.length, 2, "the pending resolution cannot be submitted twice")
  finishResolution(saved)
  await waitFor(() => assert.deepEqual(entry.client.getQueryData(["order", "one"]), saved))
  assert.equal(puts[1].etag, "e2")
  assert.equal(puts[1].state.notes, "mine")
  assert.equal(entry.container.querySelector("fieldset"), null, "success clears the conflict")
  assert.equal(notesInput(entry).value, "mine")
})

test("Theirs keeps the displayed draft aligned while resolution is pending and on the next save", async () => {
  const fetchQueue = [
    loaded(order({ notes: "original" }), "e1"),
    loaded(order({ status: "approved", notes: "server" }), "e2"),
  ]
  const puts = []
  let finishResolution
  const resolution = new Promise((resolveSaved) => { finishResolution = resolveSaved })
  const api = {
    fetchOrder: async () => fetchQueue.shift(),
    putOrder: async (_id, state, etag) => {
      puts.push({ state: structuredClone(state), etag })
      if (puts.length === 1) throw staleWrite()
      if (puts.length === 2) return resolution
      return loaded(structuredClone(state), "e4")
    },
  }
  const entry = await mountEditor("one", api)
  changeNotes(entry, "mine")
  await submit(entry)
  await waitFor(() => assert.equal(radioInputs(entry).length, 2))

  fireEvent.click(radioInputs(entry)[1])
  await applyChoices(entry)
  assert.equal(puts.length, 1, "applying Theirs prepares a candidate but does not save it")
  assert.equal(button(entry, "Confirm").disabled, false)
  await confirmReview(entry)
  await waitForPuts(puts, 2)
  assert.equal(puts[1].etag, "e2")
  assert.equal(puts[1].state.status, "approved", "the resolution starts from the current server state")
  assert.equal(notesInput(entry).disabled, true, "notes editing is disabled during conflict resolution")
  assert.equal(notesInput(entry).value, "server", "the draft immediately reflects the selected resolution")
  changeNotes(entry, "mine!")
  assert.equal(notesInput(entry).value, "server", "the pending resolution cannot be changed in the editor")

  finishResolution(loaded(puts[1].state, "e3"))
  await waitFor(() => assert.equal(button(entry, "Save").disabled, false))
  assert.equal(notesInput(entry).value, "server")
  assert.equal(entry.container.querySelector("fieldset"), null)

  await submit(entry)
  await waitForPuts(puts, 3)
  assert.equal(puts[2].etag, "e3", "the next save uses the conflict-resolution ETag")
  assert.equal(puts[2].state.status, "approved", "the next save retains the server change")
  assert.equal(puts[2].state.notes, "server", "the next save retains the selected Theirs value")
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

test("keeps the reviewed candidate visible and reports a failed confirmed request", async () => {
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
  fireEvent.click(radioInputs(entry)[1])
  await applyChoices(entry)
  assert.equal(putCount, 1, "applying choices prepares a review candidate")
  assert.equal(entry.container.querySelector("fieldset").textContent.includes("Review changes before saving"), true)
  await confirmReview(entry)
  await waitFor(() => assert.ok(entry.getByRole("alert").textContent))

  assert.ok(entry.getByRole("group", { name: "Review changes before saving" }))
  assert.equal(button(entry, "Confirm").disabled, false)
  assert.equal(notesInput(entry).value, "server", "the draft stays aligned with the failed resolution choice")

  await confirmReview(entry)
  await waitFor(() => assert.equal(putCount, 3))
  assert.deepEqual(etags, ["e1", "e2", "e2"], "the failed resolution keeps its server baseline and ETag")
  await waitFor(() => assert.equal(entry.container.querySelector("fieldset"), null))
  assert.equal(notesInput(entry).value, "server")
  await submit(entry)
  await waitFor(() => assert.equal(putCount, 4))
  assert.equal(etags[3], "e3", "the subsequent save uses the successful retry's ETag")

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
  assert.equal(puts.length, 1, "choice application waits for confirmation")
  await confirmReview(entry)
  await waitForPuts(puts, 2)

  assert.equal(radioInputs(entry).length, 2)
  assert.equal(radioInputs(entry)[0].checked, false, "a new conflict resets to the server choice")
  assert.equal(radioInputs(entry)[1].checked, true)
  assert.equal(puts[1].etag, "e2")

  await applyChoices(entry)
  assert.equal(puts.length, 2)
  await confirmReview(entry)
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
  let choiceIndex = 0
  const props = (conflict, inputs) => {
    choiceIndex += 1
    return {
    pending: {
      conflicts: [conflict],
      inputs,
      etag: "e2",
      revision: 1,
      sessionId: `session-${choiceIndex}`,
      candidate: inputs.submittedState,
      terminal: false,
      validationError: null,
      report: [],
    },
    pendingSave: false,
    error: null,
    candidate: inputs.submittedState,
    currentRevision: 1,
    onCandidate: (state) => { choice = state },
    onCancel: () => {},
    onResolved: async (state) => { choice = state },
  }
  }
  const view = render(React.createElement(ConflictPicker, props(firstConflict, firstInputs)))
  mounted.push({ ...view, client: new QueryClient() })
  fireEvent.click(radioInputs(view)[0])
  view.rerender(React.createElement(ConflictPicker, props(secondConflict, secondInputs)))

  assert.equal(radioInputs(view)[0].checked, false)
  assert.equal(radioInputs(view)[1].checked, true)
  await applyChoices(view)
  assert.equal(choice.status, "approved", "the old choice must not be transferred to the new path")
})
