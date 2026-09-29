import { CAMConfigError } from "./errors.js"
import { normalizePattern, readMatches } from "./paths.js"
import type { NormalizedPattern } from "./paths.js"
import { ABSENT, canonicalKey, cloneJsonValue, jsonEqual } from "./slots.js"
import { snapshotJsonValue } from "./validation.js"
import type { JsonValue } from "./types.js"

/** A validated rule: its id, the patterns it reads, and an evaluator. */
export type CompiledRule = {
  id: string
  /** Every pattern the rule reads; scopes blame and rule conflicts. */
  patterns: NormalizedPattern[]
  /** Returns undefined when the state satisfies the rule, else a message. */
  evaluate(state: JsonValue): string | undefined
}

const BUILT_IN_KEYS = new Set([
  "id",
  "path",
  "message",
  "required",
  "min",
  "max",
  "minLength",
  "maxLength",
  "pattern",
  "oneOf",
  "unique",
  "exactlyOne",
  "allEqual",
  "oneOfPath",
  "sumOf",
  "requiredWith",
])
const CONSTRAINT_KEYS = [...BUILT_IN_KEYS].filter((key) => key !== "id" && key !== "path" && key !== "message")

function ownData(record: object, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor === undefined) return undefined
  if (!("value" in descriptor)) {
    throw new CAMConfigError(`${label}.${key} must not be an accessor property`)
  }
  return descriptor.value
}

function formatLocation(path: readonly (string | number | object)[]): string {
  return path.length === 0
    ? "/"
    : "/" + path.map((segment) => (typeof segment === "object" ? "*" : String(segment))).join("/")
}

const isPresent = (value: JsonValue | typeof ABSENT): value is JsonValue =>
  value !== ABSENT && value !== null

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right))
}

function compileBuiltIn(raw: JsonValue, label: string): CompiledRule {
  const rule = raw as Record<string, JsonValue>
  for (const key of Object.keys(rule)) {
    if (!BUILT_IN_KEYS.has(key)) throw new CAMConfigError(`${label} has unknown property "${key}"`)
  }
  const id = rule.id as string
  const path = normalizePattern(rule.path!, `${label}.path`)
  const constraints = CONSTRAINT_KEYS.filter((key) => Object.hasOwn(rule, key))
  if (constraints.length === 0) {
    throw new CAMConfigError(`${label} must define at least one constraint`)
  }
  const customMessage = rule.message
  if (customMessage !== undefined && (typeof customMessage !== "string" || customMessage.length === 0)) {
    throw new CAMConfigError(`${label}.message must be a non-empty string`)
  }

  const flag = (key: string): void => {
    if (Object.hasOwn(rule, key) && rule[key] !== true) {
      throw new CAMConfigError(`${label}.${key} must be true when provided`)
    }
  }
  const finite = (key: string): number | undefined => {
    if (!Object.hasOwn(rule, key)) return undefined
    const value = rule[key]
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new CAMConfigError(`${label}.${key} must be a finite number`)
    }
    return value
  }
  const count = (key: string): number | undefined => {
    const value = finite(key)
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new CAMConfigError(`${label}.${key} must be a non-negative integer`)
    }
    return value
  }
  flag("required")
  flag("unique")
  flag("exactlyOne")
  flag("allEqual")
  const min = finite("min")
  const max = finite("max")
  const minLength = count("minLength")
  const maxLength = count("maxLength")
  let regex: RegExp | undefined
  if (Object.hasOwn(rule, "pattern")) {
    if (typeof rule.pattern !== "string") throw new CAMConfigError(`${label}.pattern must be a string`)
    try {
      regex = new RegExp(rule.pattern, "u")
    } catch (cause) {
      throw new CAMConfigError(`${label}.pattern is not a valid regular expression`, { cause })
    }
  }
  let oneOf: JsonValue[] | undefined
  if (Object.hasOwn(rule, "oneOf")) {
    if (!Array.isArray(rule.oneOf)) throw new CAMConfigError(`${label}.oneOf must be an array`)
    oneOf = rule.oneOf
  }
  const otherPattern = (key: string): NormalizedPattern | undefined =>
    Object.hasOwn(rule, key) ? normalizePattern(rule[key]!, `${label}.${key}`) : undefined
  const oneOfPath = otherPattern("oneOfPath")
  const sumOf = otherPattern("sumOf")
  const requiredWith = otherPattern("requiredWith")

  const patterns = [path, oneOfPath, sumOf, requiredWith].filter(
    (pattern): pattern is NormalizedPattern => pattern !== undefined,
  )

  const evaluate = (state: JsonValue): string | undefined => {
    const matches = readMatches(state, path)
    const fail = (location: readonly (string | number | object)[], reason: string): string =>
      typeof customMessage === "string" ? customMessage : `${formatLocation(location)} ${reason}`
    if (rule.required === true) {
      for (const match of matches) {
        if (match.slot === ABSENT || match.slot === null || match.slot === "") {
          return fail(match.path, "is required")
        }
      }
    }
    const present = matches.filter((match) => isPresent(match.slot)) as { path: (string | number | object)[]; slot: JsonValue }[]
    for (const { path: location, slot: value } of present) {
      if (min !== undefined || max !== undefined) {
        if (typeof value !== "number") return fail(location, "must be a number")
        if (min !== undefined && value < min) return fail(location, `must be at least ${min}`)
        if (max !== undefined && value > max) return fail(location, `must be at most ${max}`)
      }
      if (minLength !== undefined || maxLength !== undefined) {
        const length = typeof value === "string" ? [...value].length : Array.isArray(value) ? value.length : undefined
        if (length === undefined) return fail(location, "must be a string or an array")
        if (minLength !== undefined && length < minLength) return fail(location, `must have at least ${minLength} items or characters`)
        if (maxLength !== undefined && length > maxLength) return fail(location, `must have at most ${maxLength} items or characters`)
      }
      if (regex !== undefined) {
        if (typeof value !== "string" || !regex.test(value)) return fail(location, `must match ${regex.source}`)
      }
      if (oneOf !== undefined && !oneOf.some((allowed) => jsonEqual(allowed, value))) {
        return fail(location, "is not an allowed value")
      }
    }
    if (rule.unique === true) {
      const seen = new Set<string>()
      for (const { path: location, slot } of present) {
        const identity = canonicalKey(slot)
        if (seen.has(identity)) return fail(location, "must be unique")
        seen.add(identity)
      }
    }
    if (rule.exactlyOne === true && matches.length > 0) {
      const trueCount = present.filter(({ slot }) => slot === true).length
      if (trueCount !== 1) return fail(matches[0]!.path.slice(0, -1), `must have exactly one true value (found ${trueCount})`)
    }
    if (rule.allEqual === true && present.length > 1) {
      const first = canonicalKey(present[0]!.slot)
      const different = present.find(({ slot }) => canonicalKey(slot) !== first)
      if (different !== undefined) return fail(different.path, "must equal the other matched values")
    }
    if (oneOfPath !== undefined) {
      const allowed = new Set(
        readMatches(state, oneOfPath).filter((match) => isPresent(match.slot)).map((match) => canonicalKey(match.slot as JsonValue)),
      )
      for (const { path: location, slot } of present) {
        if (!allowed.has(canonicalKey(slot))) return fail(location, `must match a value at ${formatLocation(oneOfPath)}`)
      }
    }
    if (sumOf !== undefined) {
      let sum = 0
      for (const match of readMatches(state, sumOf)) {
        if (!isPresent(match.slot)) continue
        if (typeof match.slot !== "number") return fail(match.path, "must be a number (summed)")
        sum += match.slot
      }
      for (const { path: location, slot } of present) {
        if (typeof slot !== "number" || !nearlyEqual(slot, sum)) return fail(location, `must equal the sum ${sum}`)
      }
    }
    if (requiredWith !== undefined && present.length > 0) {
      const other = readMatches(state, requiredWith).some((match) => isPresent(match.slot))
      if (!other) return fail(present[0]!.path, `requires a value at ${formatLocation(requiredWith)}`)
    }
    return undefined
  }

  return { id, patterns, evaluate }
}

function compileCustom(record: object, label: string, id: string): CompiledRule {
  for (const key of Object.keys(record)) {
    if (key !== "id" && key !== "paths" && key !== "check") {
      throw new CAMConfigError(`${label} has unknown property "${key}" (custom rule)`)
    }
  }
  const check = ownData(record, "check", label)
  if (typeof check !== "function") throw new CAMConfigError(`${label}.check must be a function`)
  const rawPaths = snapshotJsonValue(ownData(record, "paths", label), `${label}.paths`)
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    throw new CAMConfigError(`${label}.paths must be a non-empty array of paths`)
  }
  const patterns = rawPaths.map((path, index) => normalizePattern(path, `${label}.paths[${index}]`))
  const evaluate = (state: JsonValue): string | undefined => {
    let outcome: unknown
    try {
      // Checks receive a private copy so they cannot alter merge state.
      outcome = (check as (state: JsonValue) => unknown)(cloneJsonValue(state))
    } catch (cause) {
      throw new CAMConfigError(`rule "${id}" check threw`, { cause })
    }
    if (outcome === true) return undefined
    if (typeof outcome === "string" && outcome.length > 0) return outcome
    throw new CAMConfigError(`rule "${id}" check must return true or a non-empty message string`)
  }
  return { id, patterns, evaluate }
}

/** Validates and compiles the `rules` option. */
export function compileRules(raw: unknown): CompiledRule[] {
  if (!Array.isArray(raw)) throw new CAMConfigError("rules must be an array")
  const ids = new Set<string>()
  return raw.map((entry: unknown, index) => {
    const label = `rules[${index}]`
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new CAMConfigError(`${label} must be an object`)
    }
    const id = ownData(entry, "id", label)
    if (typeof id !== "string" || id.length === 0) {
      throw new CAMConfigError(`${label}.id must be a non-empty string`)
    }
    if (ids.has(id)) throw new CAMConfigError(`duplicate rule id: ${id}`)
    ids.add(id)
    if (Object.getOwnPropertyDescriptor(entry, "check") !== undefined) {
      return compileCustom(entry, label, id)
    }
    return compileBuiltIn(snapshotJsonValue(entry, label), label)
  })
}
