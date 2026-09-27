// Where CAM fits in a TanStack Query mutation, plus a minimal, unstyled
// conflict picker. Type-checked and behavior-tested in CI with its own
// dependencies (see ./package.json); the library itself has no React
// dependency. Adapt the API object and UI to your application.
import { useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { matchConflictError, mergeStates, type Conflict } from "conflict-aware-mutation"

import { chooseSides } from "../choose-sides.mjs"

export type Order = { status: string; notes: string; customer: { name: string; phone: string } }
type Loaded = { state: Order; etag: string }
type Inputs = { originalState: Order; submittedState: Order; currentServerState: Order }
type SaveVariables = { originalState: Order; submittedState: Order; etag: string; revision: number }
type Choice = "submitted" | "currentServer"

export type OrderApi = {
  fetchOrder(id: string): Promise<Loaded>
  putOrder(id: string, state: Order, etag: string): Promise<Loaded>
}

// API failures carry a string `code`. Anything else (for example a fetch
// network TypeError) is not a CAM error signal and is rethrown untouched.
function toErrorSignal(error: unknown): { code: string } | null {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === "string" ? { code } : null
}

class ConflictNeedsDecision extends Error {
  constructor(
    readonly conflicts: Conflict[],
    readonly inputs: Inputs,
    readonly etag: string,
    readonly revision: number,
  ) {
    super("Conflicting changes need a decision")
  }
}

export function useSaveOrder(id: string, api: OrderApi) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ originalState, submittedState, etag, revision }: SaveVariables) => {
      try {
        return await api.putOrder(id, submittedState, etag)
      } catch (error) {
        const signal = toErrorSignal(error)
        if (!signal || !matchConflictError({ error: signal, expectedError: { code: "STALE_WRITE" } }).matched) {
          throw error
        }

        const latest = await api.fetchOrder(id)
        const inputs = { originalState, submittedState, currentServerState: latest.state }
        const merged = mergeStates<Order>(inputs)
        if (!merged.ok) throw new ConflictNeedsDecision(merged.conflicts, inputs, latest.etag, revision)

        // Each submission gets one merge and at most one automatic re-save.
        // A write that races that re-save is surfaced as an error; the caller
        // can submit again, which starts from the same coherent state/ETag pair.
        return api.putOrder(id, merged.value, latest.etag)
      }
    },
    onSuccess: (saved) => queryClient.setQueryData(["order", id], saved),
  })
}

export function OrderEditor({ id, api }: { id: string; api: OrderApi }) {
  const { data } = useQuery({ queryKey: ["order", id], queryFn: () => api.fetchOrder(id) })
  if (!data) return null
  return <Editor key={id} id={id} api={api} original={data} />
}

function Editor({ id, api, original }: { id: string; api: OrderApi; original: Loaded }) {
  // The baseline state and ETag are one editing-session snapshot. Query
  // refetches do not replace either while the user edits this record.
  const [baseline, setBaseline] = useState(original)
  const [draft, setDraft] = useState(original.state)
  const [pending, setPending] = useState<ConflictNeedsDecision | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const revisionRef = useRef(0)
  const inFlightRef = useRef(false)
  const save = useSaveOrder(id, api)

  const runSave = async (variables: SaveVariables) => {
    // React Query's isPending is rendered asynchronously. The ref closes the
    // same-event-window where two clicks could otherwise start two requests.
    if (inFlightRef.current) return
    inFlightRef.current = true
    setSaveError(null)
    try {
      const saved = await save.mutateAsync(variables)
      setBaseline(saved)
      setDraft((current) =>
        revisionRef.current === variables.revision
          ? saved.state
          : { ...saved.state, notes: current.notes },
      )
      setPending(null)
    } catch (error) {
      if (error instanceof ConflictNeedsDecision) {
        setPending(error)
        setSaveError(null)
      } else {
        // Keep an existing conflict visible when its resolved request fails.
        setSaveError("Unable to save. Review the request and try again.")
      }
    } finally {
      inFlightRef.current = false
    }
  }

  const submit = (event: { preventDefault(): void }) => {
    event.preventDefault()
    return runSave({
      originalState: baseline.state,
      submittedState: draft,
      etag: baseline.etag,
      revision: revisionRef.current,
    })
  }

  return (
    <form onSubmit={submit}>
      <input
        aria-label="Notes"
        value={draft.notes}
        onChange={(event) => {
          revisionRef.current += 1
          const notes = event.target.value
          setDraft((current) => ({ ...current, notes }))
        }}
      />
      <button type="submit" disabled={save.isPending}>Save</button>
      {pending && (
        <ConflictPicker
          pending={pending}
          pendingSave={save.isPending}
          error={saveError}
          onResolved={(state, etag) => {
            if (revisionRef.current !== pending.revision) {
              setSaveError("The draft changed while this conflict was open. Save again to refresh the choices.")
              return Promise.resolve()
            }
            return runSave({
              originalState: pending.inputs.currentServerState,
              submittedState: state,
              etag,
              revision: revisionRef.current,
            })
          }}
        />
      )}
      {saveError && !pending && <p role="alert">{saveError}</p>}
    </form>
  )
}

export function ConflictPicker({
  pending,
  pendingSave,
  error,
  onResolved,
}: {
  pending: ConflictNeedsDecision
  pendingSave: boolean
  error: string | null
  onResolved: (state: Order, etag: string) => Promise<void>
}) {
  const identity = JSON.stringify(pending.conflicts)
  const [choiceState, setChoiceState] = useState<{ identity: string; choices: Choice[] }>(() => ({
    identity,
    choices: pending.conflicts.map(() => "currentServer"),
  }))
  // Derive defaults synchronously when the conflict set changes. An effect
  // reset would leave one render where an old index could refer to a new path.
  const choices = choiceState.identity === identity
    ? choiceState.choices
    : pending.conflicts.map(() => "currentServer" as const)
  const show = (side: Conflict["submitted"]) => (side.exists ? JSON.stringify(side.value) : "(deleted)")

  return (
    <fieldset disabled={pendingSave}>
      <legend>Someone else changed these fields</legend>
      {pending.conflicts.map((conflict, index) => (
        <div key={JSON.stringify(conflict.path)}>
          <code>{conflict.path.join(" › ")}</code>
          {(["submitted", "currentServer"] as const).map((side) => (
            <label key={side}>
              <input
                type="radio"
                checked={choices[index] === side}
                onChange={() => setChoiceState({
                  identity,
                  choices: choices.map((choice, choiceIndex) => (choiceIndex === index ? side : choice)),
                })}
              />
              {side === "submitted" ? "Yours" : "Theirs"}: {show(conflict[side])}
            </label>
          ))}
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          const resolved = chooseSides(pending.inputs, pending.conflicts, choices)
          if (resolved.ok) return onResolved(resolved.value as Order, pending.etag)
        }}
      >
        Apply choices
      </button>
      {pendingSave && <p role="status">Saving…</p>}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  )
}
