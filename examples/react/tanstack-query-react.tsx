// Where CAM fits in a TanStack Query mutation, plus a minimal, unstyled
// conflict picker. Type-checked in CI with its own dependencies (see
// ./package.json); the library itself has no React dependency. Adapt the API
// calls and UI to your application.
import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { matchConflictError, mergeStates, type Conflict } from "conflict-aware-mutation"

import { chooseSides } from "../choose-sides.mjs"

type Order = { status: string; notes: string; customer: { name: string; phone: string } }
type Loaded = { state: Order; etag: string }
type Inputs = { originalState: Order; submittedState: Order; currentServerState: Order }

// Your API layer: throw a normalized { code?, text? } error on failure.
declare function fetchOrder(id: string): Promise<Loaded>
declare function putOrder(id: string, state: Order, etag: string): Promise<Loaded>

class ConflictNeedsDecision extends Error {
  constructor(readonly conflicts: Conflict[], readonly inputs: Inputs, readonly etag: string) {
    super("Conflicting changes need a decision")
  }
}

export function useSaveOrder(id: string, original: Loaded) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (submittedState: Order) => {
      try {
        return await putOrder(id, submittedState, original.etag)
      } catch (error) {
        const match = matchConflictError({ error: error as { code: string }, expectedError: { code: "STALE_WRITE" } })
        if (!match.matched) throw match.error

        const latest = await fetchOrder(id)
        const inputs = { originalState: original.state, submittedState, currentServerState: latest.state }
        const merged = mergeStates<Order>(inputs)
        if (!merged.ok) throw new ConflictNeedsDecision(merged.conflicts, inputs, latest.etag)

        return putOrder(id, merged.value, latest.etag)
      }
    },
    onSuccess: (saved) => queryClient.setQueryData(["order", id], saved),
  })
}

export function OrderEditor({ id }: { id: string }) {
  const { data } = useQuery({ queryKey: ["order", id], queryFn: () => fetchOrder(id) })
  if (!data) return null
  return <Editor id={id} original={data} />
}

function Editor({ id, original }: { id: string; original: Loaded }) {
  const [draft, setDraft] = useState(original.state)
  const save = useSaveOrder(id, original)
  const pending = save.error instanceof ConflictNeedsDecision ? save.error : null

  return (
    <form onSubmit={(event) => { event.preventDefault(); save.mutate(draft) }}>
      <input value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
      <button type="submit">Save</button>
      {pending && <ConflictPicker pending={pending} onResolved={(state, etag) => putOrder(id, state, etag)} />}
    </form>
  )
}

function ConflictPicker({
  pending,
  onResolved,
}: {
  pending: ConflictNeedsDecision
  onResolved: (state: Order, etag: string) => void
}) {
  const [choices, setChoices] = useState<("submitted" | "currentServer")[]>(
    pending.conflicts.map(() => "currentServer"),
  )
  const show = (side: Conflict["submitted"]) => (side.exists ? JSON.stringify(side.value) : "(deleted)")

  return (
    <fieldset>
      <legend>Someone else changed these fields</legend>
      {pending.conflicts.map((conflict, index) => (
        <div key={conflict.path.join("\u0000")}>
          <code>{conflict.path.join(" › ")}</code>
          {(["submitted", "currentServer"] as const).map((side) => (
            <label key={side}>
              <input
                type="radio"
                checked={choices[index] === side}
                onChange={() => setChoices(choices.map((choice, i) => (i === index ? side : choice)))}
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
          if (resolved.ok) onResolved(resolved.value as Order, pending.etag)
        }}
      >
        Apply choices
      </button>
    </fieldset>
  )
}
