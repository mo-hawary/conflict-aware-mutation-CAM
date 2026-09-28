// Where CAM fits in a TanStack Query mutation, plus a minimal, unstyled
// conflict picker. Type-checked and behavior-tested in CI with its own
// dependencies (see ./package.json); the library itself has no React
// dependency. Adapt the API object and UI to your application.
import { useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { applyConflictDecisions, formatConflictPath, matchConflictError, mergeStates, type ChangeReportEntry, type Conflict } from "conflict-aware-mutation"

export type Order = { status: string; notes: string; customer: { name: string; phone: string } }
type Loaded = { state: Order; etag: string }
type Inputs = { originalState: Order; submittedState: Order; currentServerState: Order }
type SaveVariables = { originalState: Order; submittedState: Order; etag: string; revision: number }
type Choice = "submitted" | "currentServer" | null

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
    readonly sessionId: string,
    readonly candidate: Order = inputs.submittedState,
    readonly terminal = false,
    readonly validationError: string | null = null,
    readonly report: readonly ChangeReportEntry[] = [],
  ) {
    super("Conflicting changes need a decision")
  }
}

export type OrderRecoveryCallbacks = {
  prepareCandidate?: (candidate: Order) => Order
  validateCandidate?: (candidate: Order) => void | string
  isTerminal?: (state: Order) => boolean
}

export function useSaveOrder(id: string, api: OrderApi, callbacks: OrderRecoveryCallbacks = {}) {
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
        if (callbacks.isTerminal?.(latest.state)) {
          throw new ConflictNeedsDecision([], inputs, latest.etag, revision, `${revision}:terminal`, latest.state, true)
        }
        const merged = mergeStates<Order>({ ...inputs, includeReport: true })
        const candidate = merged.ok ? merged.value : inputs.submittedState
        const prepared = callbacks.prepareCandidate ? callbacks.prepareCandidate(candidate) : candidate
        const validation = callbacks.validateCandidate?.(prepared)
        if (typeof validation === "string") throw new ConflictNeedsDecision([], inputs, latest.etag, revision, `${revision}:validation`, prepared, false, validation, merged.report.changes)
        throw new ConflictNeedsDecision(merged.ok ? [] : merged.conflicts, inputs, latest.etag, revision, `${revision}:${latest.etag}`, prepared, false, null, merged.report.changes)
      }
    },
    onSuccess: async (saved) => {
      await queryClient.cancelQueries({ queryKey: ["order", id], exact: true })
      queryClient.setQueryData(["order", id], saved)
    },
  })
}

export function OrderEditor({ id, api, recovery }: { id: string; api: OrderApi; recovery?: OrderRecoveryCallbacks }) {
  const { data } = useQuery({ queryKey: ["order", id], queryFn: () => api.fetchOrder(id) })
  if (!data) return null
  return <Editor key={id} id={id} api={api} original={data} recovery={recovery} />
}

function candidateChangeReport(candidate: Order, currentServerState: Order): readonly ChangeReportEntry[] {
  const result = mergeStates<Order>({
    originalState: currentServerState,
    submittedState: candidate,
    currentServerState,
    includeReport: true,
  })
  return result.report.changes
}

function Editor({ id, api, original, recovery = {} }: { id: string; api: OrderApi; original: Loaded; recovery?: OrderRecoveryCallbacks }) {
  // The baseline state and ETag are one editing-session snapshot. Query
  // refetches do not replace either while the user edits this record.
  const [baseline, setBaseline] = useState(original)
  const [draft, setDraft] = useState(original.state)
  const [pending, setPending] = useState<ConflictNeedsDecision | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const revisionRef = useRef(0)
  const inFlightRef = useRef(false)
  const save = useSaveOrder(id, api, recovery)

  const runSave = async (variables: SaveVariables, isResolution = false) => {
    // React Query's isPending is rendered asynchronously. The ref closes the
    // same-event-window where two clicks could otherwise start two requests.
    if (inFlightRef.current) return
    inFlightRef.current = true
    if (isResolution) setResolving(true)
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
        if (revisionRef.current === variables.revision) setDraft(error.candidate)
        setSaveError(null)
      } else {
        // Keep an existing conflict visible when its resolved request fails.
        setSaveError("Unable to save. Review the request and try again.")
      }
    } finally {
      inFlightRef.current = false
      if (isResolution) setResolving(false)
    }
  }

  const submit = (event: { preventDefault(): void }) => {
    event.preventDefault()
    if (
      pending &&
      (pending.terminal || pending.conflicts.length === 0 || pending.revision === revisionRef.current)
    ) return
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
        disabled={resolving || Boolean(pending?.terminal)}
        onChange={(event) => {
          if (resolving) return
          const notes = event.target.value
          const next = { ...draft, notes }
          revisionRef.current += 1

          if (!pending) {
            setDraft(next)
            return
          }

          const prepared = recovery.prepareCandidate ? recovery.prepareCandidate(next) : next
          const validation = recovery.validateCandidate?.(prepared)
          setDraft(prepared)
          setSaveError(typeof validation === "string" ? validation : null)

          if (pending.conflicts.length === 0) {
            const revision = revisionRef.current
            setPending(new ConflictNeedsDecision(
              [],
              pending.inputs,
              pending.etag,
              revision,
              `${revision}:${pending.etag}`,
              prepared,
              false,
              typeof validation === "string" ? validation : null,
              candidateChangeReport(prepared, pending.inputs.currentServerState),
            ))
          } else {
            setPending(new ConflictNeedsDecision(
              pending.conflicts,
              pending.inputs,
              pending.etag,
              pending.revision,
              pending.sessionId,
              prepared,
              false,
              pending.validationError,
              candidateChangeReport(prepared, pending.inputs.currentServerState),
            ))
          }
        }}
      />
      <button
        type="submit"
        disabled={
          save.isPending ||
          Boolean(pending?.terminal) ||
          Boolean(pending && pending.conflicts.length === 0) ||
          Boolean(pending && pending.conflicts.length > 0 && pending.revision === revisionRef.current)
        }
      >
        {pending?.conflicts.length && pending.revision !== revisionRef.current ? "Refresh choices" : "Save"}
      </button>
      {pending && (
        <ConflictPicker
          pending={pending}
          pendingSave={resolving}
          error={saveError}
          candidate={draft}
          currentRevision={revisionRef.current}
          candidateValid={pending.validationError === null}
          onCandidate={(state, report) => {
            const prepared = recovery.prepareCandidate ? recovery.prepareCandidate(state) : state
            const validation = recovery.validateCandidate?.(prepared)
            setDraft(prepared)
            setSaveError(typeof validation === "string" ? validation : null)
            if (pending.conflicts.length > 0) {
              const revision = revisionRef.current
              setPending(new ConflictNeedsDecision(
                [],
                pending.inputs,
                pending.etag,
                revision,
                `${revision}:${pending.etag}`,
                prepared,
                false,
                typeof validation === "string" ? validation : null,
                report ?? candidateChangeReport(prepared, pending.inputs.currentServerState),
              ))
            }
          }}
          onCancel={() => { setPending(null); setSaveError(null) }}
          onResolved={(state, etag) => {
            if (revisionRef.current !== pending.revision) {
              setSaveError("The draft changed while this conflict was open. Save again to refresh the choices.")
              return Promise.resolve()
            }
            setDraft(state)
            return runSave({ originalState: pending.inputs.currentServerState, submittedState: state, etag, revision: revisionRef.current }, true)
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
  candidate,
  currentRevision,
  candidateValid,
  onCandidate,
  onCancel,
  onResolved,
}: {
  pending: ConflictNeedsDecision
  pendingSave: boolean
  error: string | null
  candidate: Order
  currentRevision: number
  candidateValid: boolean
  onCandidate: (state: Order, report?: readonly ChangeReportEntry[]) => void
  onCancel: () => void
  onResolved: (state: Order, etag: string) => Promise<void>
}) {
  const identity = `${pending.sessionId}:${JSON.stringify(pending.conflicts)}`
  const [choiceState, setChoiceState] = useState<{ identity: string; choices: Choice[] }>(() => ({
    identity,
    choices: pending.conflicts.map(() => null),
  }))
  // Derive unselected choices synchronously when the conflict set changes.
  // An effect reset could leave an old index referring to a different path.
  const choices = choiceState.identity === identity
    ? choiceState.choices
    : pending.conflicts.map(() => null)
  const show = (side: Conflict["submitted"]) => (side.exists ? JSON.stringify(side.value) : "(deleted)")
  const currentSession = currentRevision === pending.revision
  const ready = !pending.terminal && currentSession && candidateValid && pending.conflicts.length === 0
  return (
    <fieldset disabled={pendingSave}>
      <legend>{pending.terminal ? "This order can no longer be edited" : pending.conflicts.length ? "Someone else changed these fields" : "Review changes before saving"}</legend>
      {pending.conflicts.map((conflict, index) => (
        <div key={JSON.stringify(conflict.path)}>
          <code>{formatConflictPath(conflict.path)}</code>
          {(["submitted", "currentServer"] as const).map((side) => (
            <label key={side}>
              <input
                type="radio"
                checked={choices[index] === side}
                onChange={() => {
                  setChoiceState({
                    identity,
                    choices: choices.map((choice, choiceIndex) => (choiceIndex === index ? side : choice)),
                  })
                }}
              />
              {side === "submitted" ? "Yours" : "Theirs"}: {show(conflict[side])}
            </label>
          ))}
        </div>
      ))}
      {pending.validationError && <p role="alert">{pending.validationError}</p>}
      {(pending.report?.length ?? 0) > 0 && (
        <ul aria-label="Change summary">
          {(pending.report ?? []).map((change, index) => (
            <li key={index}>
              {reportLabel(change)}: {change.provenance}
            </li>
          ))}
        </ul>
      )}
      {pending.conflicts.length > 0 && !currentSession && (
        <p role="alert">The draft changed while these choices were open. Save again to refresh the choices.</p>
      )}
      {pending.conflicts.length > 0 && <button
        type="button"
        disabled={pending.terminal || !currentSession || choices.some((choice) => choice === null)}
        onClick={() => {
          const resolved = applyConflictDecisions({
            sessionId: pending.sessionId,
            ...pending.inputs,
            decisions: pending.conflicts.map((conflict, index) => ({
              sessionId: pending.sessionId,
              conflict,
              choice: choices[index] as "submitted" | "currentServer",
            })),
            includeReport: true,
          })
          if (resolved.ok) {
            onCandidate(resolved.value as Order, resolved.report.changes)
          }
        }}
      >
        Apply choices
      </button>}
      <button type="button" disabled={pendingSave || !ready} onClick={() => void onResolved(candidate, pending.etag)}>
        Confirm
      </button>
      {!pending.terminal && <button type="button" disabled={pendingSave} onClick={onCancel}>Cancel</button>}
      {pendingSave && <p role="status">Saving…</p>}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  )
}

function reportLabel(change: ChangeReportEntry): string {
  if (change.kind === "path") return formatConflictPath(change.path)
  const paths = change.original.map(({ path }) => formatConflictPath(path)).join(", ")
  return `${change.groupId}: ${paths}`
}
