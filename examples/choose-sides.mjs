// Applies per-path user decisions to an unresolved mergeStates() result.
//
// `choices` maps each conflict (by index) to "submitted" or "currentServer".
// Both sides are patched so every conflicting path agrees, then merged again,
// which keeps all the non-conflicting changes from both sides.
import { mergeStates } from "conflict-aware-mutation"

export function chooseSides({ originalState, submittedState, currentServerState }, conflicts, choices) {
  let submitted = structuredClone(submittedState)
  let currentServer = structuredClone(currentServerState)

  conflicts.forEach((conflict, index) => {
    const chosen = choices[index] === "submitted" ? conflict.submitted : conflict.currentServer
    submitted = setPath(submitted, conflict.path, chosen)
    currentServer = setPath(currentServer, conflict.path, chosen)
  })

  return mergeStates({ originalState, submittedState: submitted, currentServerState: currentServer })
}

// Conflict paths only ever walk plain objects in CAM v1 (arrays are atomic).
function setPath(root, path, slot) {
  if (path.length === 0) return slot.exists ? slot.value : root
  let parent = root
  for (const key of path.slice(0, -1)) parent = parent[key]
  const last = path[path.length - 1]
  if (slot.exists) {
    Object.defineProperty(parent, last, { value: slot.value, enumerable: true, writable: true, configurable: true })
  } else {
    delete parent[last]
  }
  return root
}
