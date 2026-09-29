import {
  ANY,
  EACH,
  applyConflictDecisions,
  formatConflictPath,
  mergeStates,
  resolveConflict,
} from "../../src/index.js"
import type {
  AdvancedMergeConflict,
  AdvancedMergeResult,
  ExtendedPathSegment,
  MergeResult,
  MergeRule,
  RuleViolation,
} from "../../src/index.js"

type Order = { items: { id: string; qty: number }[]; tags: string[]; total: number }
const order: Order = { items: [{ id: "a", qty: 1 }], tags: ["x"], total: 1 }

const plain: MergeResult<Order> = mergeStates({
  originalState: order,
  submittedState: order,
  currentServerState: order,
})
void plain

const rules: MergeRule[] = [
  { id: "cap", path: ["total"], max: 100 },
  { id: "custom", paths: [["items", ANY, "qty"]], check: (state) => state !== null || "missing" },
]

const advanced: AdvancedMergeResult<Order> = mergeStates({
  originalState: order,
  submittedState: order,
  currentServerState: order,
  arrays: { default: "sequence", rules: [{ path: ["items"], mode: "keyed", key: "id" }, { path: ["tags"], mode: "set" }] },
  groups: [{ id: "line", paths: [["items", EACH, "qty"]] }],
  derived: [["total"]],
  rules,
  autoMerge: "review-mixed",
  includeReport: true,
})

if (!advanced.ok) {
  if (advanced.kind === "invalid") {
    const violations: RuleViolation[] = advanced.violations
    void violations
  } else if (advanced.kind === "review") {
    const value: Order = advanced.value
    void value
    void advanced.report.changes
  } else {
    const conflicts: AdvancedMergeConflict[] = advanced.conflicts
    for (const conflict of conflicts) {
      if (!("kind" in conflict)) {
        const path: ExtendedPathSegment[] = conflict.path
        void formatConflictPath(path)
      } else if (conflict.kind === "rule") {
        void conflict.message
      } else {
        void conflict.binding
      }
    }
    const next: AdvancedMergeResult<Order> = applyConflictDecisions({
      originalState: order,
      submittedState: order,
      currentServerState: order,
      arrays: { rules: [{ path: ["items"], mode: "keyed", key: "id" }] },
      sessionId: "s",
      decisions: conflicts.map((conflict) => ({ sessionId: "s", conflict, choice: "submitted" as const })),
    })
    void next
  }
}

const onlyRules = mergeStates({
  originalState: order,
  submittedState: order,
  currentServerState: order,
  rules: [{ id: "cap", path: ["total"], max: 100 }],
})
const onlyRulesTyped: AdvancedMergeResult<Order> = onlyRules
void onlyRulesTyped

const patternGroups: AdvancedMergeResult<Order> = mergeStates({
  originalState: order,
  submittedState: order,
  currentServerState: order,
  groups: [{ id: "g", paths: [["items", ANY, "qty"]] }],
})
void patternGroups

const resolved = resolveConflict({
  error: { code: 409 },
  expectedError: { code: 409 },
  originalState: order,
  submittedState: order,
  currentServerState: order,
  arrays: { rules: [{ path: ["tags"], mode: "set" }] },
})
if (resolved.matched) {
  const result: AdvancedMergeResult<Order> = resolved.result
  void result
}

// @ts-expect-error keyed rules require a key
mergeStates({ originalState: order, submittedState: order, currentServerState: order, arrays: { rules: [{ path: ["items"], mode: "keyed" }] } })

// @ts-expect-error custom rules must return true or a message
const badRule: MergeRule = { id: "x", paths: [["total"]], check: () => false }
void badRule
