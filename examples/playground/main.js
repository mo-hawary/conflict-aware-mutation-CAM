import { CAMConfigError, mergeStates } from "conflict-aware-mutation"

const initial = {
  originalState: { customer: { name: "Mona", phone: "111" }, notes: "", tags: ["gift"] },
  submittedState: { customer: { name: "Mona", phone: "333" }, notes: "Leave at the door", tags: ["gift"] },
  currentServerState: { customer: { name: "Mona", phone: "222" }, notes: "", tags: ["gift", "priority"] },
}

const fields = Object.keys(initial).map((name) => document.getElementById(name))
const output = document.getElementById("result")

for (const field of fields) {
  field.value = JSON.stringify(initial[field.id], null, 2)
  field.addEventListener("input", render)
}
render()

function render() {
  const input = {}
  for (const field of fields) {
    try {
      input[field.id] = JSON.parse(field.value)
    } catch (error) {
      output.textContent = `${field.id} is not valid JSON: ${error.message}`
      return
    }
  }

  try {
    output.textContent = JSON.stringify(mergeStates(input), null, 2)
  } catch (error) {
    output.textContent = error instanceof CAMConfigError ? `CAMConfigError: ${error.message}` : String(error)
  }
}
