# OpaqueRef TypeScript Transformer

This module provides a TypeScript AST transformer that automatically transforms certain patterns involving `OpaqueRef` types from the CommonTools framework.

## Overview

The transformer handles three main transformations:

1. **Ternary operators**: `opaqueRef ? a : b` → `ifElse(opaqueRef, a, b)`
2. **Binary expressions**: `opaqueRef + 1` → `derive(opaqueRef, _v => _v + 1)`
3. **JSX expressions**: `{opaqueRef + 1}` → `{derive(opaqueRef, _v => _v + 1)}`

## Usage

### Basic Usage

```typescript
import { createOpaqueRefTransformer } from "./transformer/mod.ts";

const transformer = createOpaqueRefTransformer(tsProgram);

// Use in TypeScript compilation
tsProgram.emit(sourceFile, undefined, undefined, undefined, {
  before: [transformer],
});
```

### With Options

```typescript
const transformer = createOpaqueRefTransformer(tsProgram, {
  mode: 'transform',  // or 'error' to report errors instead
  debug: true,        // Enable debug logging
  logger: console.log // Custom logger function
});
```

## Modes

### Transform Mode (default)

In transform mode, the transformer automatically modifies the code:

```typescript
// Before
const result = isActive ? "on" : "off";
const next = count + 1;

// After
const result = ifElse(isActive, "on", "off");
const next = derive(count, _v => _v + 1);
```

### Error Mode

In error mode, the transformer reports errors instead of transforming:

```typescript
const transformer = createOpaqueRefTransformer(tsProgram, { mode: 'error' });

// This will throw an error listing all transformations that would be applied
```

## Architecture

The transformer is split into focused modules:

- `opaque-ref.ts` - Main transformer with configuration
- `types.ts` - Type checking utilities for OpaqueRef detection
- `transforms.ts` - Individual transformation functions
- `imports.ts` - Import management utilities (generic import helpers)
- `test-utils.ts` - Testing utilities
- `mod.ts` - Public exports

## Testing

The module includes comprehensive unit tests and test utilities:

```typescript
import { transformSource, checkWouldTransform } from "./test-utils.ts";

// Transform source code for testing
const transformed = transformSource(sourceCode, { 
  mode: 'transform',
  types: { "commontools.d.ts": typeDefinitions }
});

// Check if transformation would occur
const needsTransform = checkWouldTransform(sourceCode);
```

## Examples

### Example 1: Ternary Transformation

```typescript
// Input
import { OpaqueRef } from "commontools";
const isActive: OpaqueRef<boolean> = getActiveState();
const status = isActive ? "active" : "inactive";

// Output
import { OpaqueRef, ifElse } from "commontools";
const isActive: OpaqueRef<boolean> = getActiveState();
const status = ifElse(isActive, "active", "inactive");
```

### Example 2: Binary Expression

```typescript
// Input
import { OpaqueRef } from "commontools";
const count: OpaqueRef<number> = getCount();
const doubled = count * 2;

// Output
import { OpaqueRef, derive } from "commontools";
const count: OpaqueRef<number> = getCount();
const doubled = derive(count, _v => _v * 2);
```

### Example 3: JSX Expression

```typescript
// Input
import { OpaqueRef, h } from "commontools";
const price: OpaqueRef<number> = getPrice();
const element = <div>Price: ${price * 1.1}</div>;

// Output
import { OpaqueRef, h, derive } from "commontools";
const price: OpaqueRef<number> = getPrice();
const element = <div>Price: ${derive(price, _v => _v * 1.1)}</div>;
```

Note: Simple references like `{price}` are not transformed, only expressions that perform operations.

## Extending

To add new transformations:

1. Add detection logic to `checkTransformation` in `transforms.ts`
2. Implement the transformation function
3. Update the visitor in `opaque-ref.ts`
4. Add tests to `opaque-ref.test.ts`