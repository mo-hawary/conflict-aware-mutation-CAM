# Migrating from 0.1.x

This guide describes the breaking changes introduced by the validation and merge hardening work. Consult the [changelog](../CHANGELOG.md) for the released version containing them; the main branch may be ahead of npm.

## Catch CAM configuration errors explicitly

`CAMConfigError` extends `Error`, not `TypeError`. Replace checks that use `instanceof TypeError` to identify invalid CAM input:

```js
import { CAMConfigError, mergeStates } from "conflict-aware-mutation"

try {
  mergeStates({ originalState: {}, submittedState: { value: undefined }, currentServerState: {} })
} catch (error) {
  if (!(error instanceof CAMConfigError)) throw error
  console.error(error.code, error.message) // CAM_CONFIG_ERROR and the invalid path
}
```

The stable discriminator is `code: "CAM_CONFIG_ERROR"`. When inspecting an unknown error by code, check that it is a non-null object first. Internal invariant failures remain distinguishable from public validation errors.

## Pass explicit JSON snapshots

Enumerable object accessors and array-index accessors are rejected without invoking them. Array subclasses, sparse arrays, non-enumerable array indices, extra enumerable non-index array properties, and symbol keys are rejected. Materialize supported data explicitly before calling CAM; do not rely on getters or custom collection behavior.

Non-enumerable object properties and non-enumerable extra array properties are ignored. This is not identical to `JSON.stringify`: CAM requires enumerable array indices and rejects values that JSON serialization might omit or transform.

## Existing merge behavior

The three input names and success/conflict result shapes are unchanged. Nested objects merge recursively; arrays remain atomic. Absence still means deletion and differs from null. Outputs do not alias inputs, and negative zero is normalized to zero.

Validate the combined result against your domain rules and retry with the latest backend version or ETag. A structurally valid merge does not guarantee a valid business operation.
