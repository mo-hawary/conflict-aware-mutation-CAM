import {
  applyConflictDecisions,
  formatConflictPath,
  mergeStates,
  resolveConflict,
  type GroupedMergeResult,
  type GroupedMergeResultWithReport,
  type MergeResult,
  type MergeResultWithReport,
  type PathGroup,
} from "../../src/index.js"

const originalState = { a: 0, b: "old" }
const submittedState = { a: 1, b: "new" }
const currentServerState = { a: 2, b: "server" }
const paths: PathGroup[] = [{ id: "pair", paths: [["a"], ["b"]] }]

const ordinary: MergeResult<typeof originalState> = mergeStates({
  originalState,
  submittedState,
  currentServerState,
})
const withReport: MergeResultWithReport<typeof originalState> = mergeStates({
  originalState,
  submittedState,
  currentServerState,
  includeReport: true,
})
const grouped: GroupedMergeResult<typeof originalState> = mergeStates({
  originalState,
  submittedState,
  currentServerState,
  groups: paths,
})
const groupedWithReport: GroupedMergeResultWithReport<typeof originalState> = mergeStates({
  originalState,
  submittedState,
  currentServerState,
  groups: paths,
  includeReport: true,
})

if (ordinary.ok) ordinary.value.a satisfies number
if (withReport.ok) withReport.report.changes satisfies readonly unknown[]
if (grouped.ok) grouped.value.b satisfies string
if (groupedWithReport.ok) groupedWithReport.report.changes satisfies readonly unknown[]

const groupedConflict = grouped.conflicts[0]
if (groupedConflict !== undefined && "kind" in groupedConflict) {
  const chosen = applyConflictDecisions({
    originalState,
    submittedState,
    currentServerState,
    groups: paths,
    sessionId: "edit-1",
    decisions: [{
      sessionId: "edit-1",
      conflict: groupedConflict,
      choice: "currentServer",
    }],
  })
  if (chosen.ok) chosen.value.a satisfies number
}

const matched = resolveConflict({
  error: { code: 409 },
  expectedError: { code: 409 },
  originalState,
  submittedState,
  currentServerState,
  groups: paths,
  includeReport: true,
})
if (matched.matched && matched.result.ok) matched.result.report.changes satisfies readonly unknown[]

formatConflictPath(["x/y", "~key", 0]) satisfies string

// The default contract has no report member.
if (!ordinary.ok) {
  // @ts-expect-error default merge conflicts do not carry opt-in reports
  ordinary.report
}
