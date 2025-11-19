# Gleam Memory Wrapper (Experimental)

**This is an experimental branch** - The Gleam integration is a proof-of-concept for gradually adding Gleam versions of function in the memory package

## What is This?

We are approaching Gleam migration incrementally by adding Gleam implementations of functions one at a time. The Gleam code gets compiled to a JavaScript target, which can then be imported and called by our existing TypeScript code.

**Current proof-of-concept approach:** The TypeScript code calls into Gleam (compiled to JS), which currently just calls back to the original TypeScript implementation via FFI. This validates the FFI bridge works before we implement actual logic in Gleam.

**General flow for a Gleam-wrapped function:**
```
TypeScript code (space.ts)
  ↓ imports and calls
Gleam function (compiled to .mjs)
  ↓ implements logic or calls FFI
JavaScript/TypeScript (for parts not yet in Gleam)
  ↓ returns result
Back to TypeScript caller
```

## Prerequisites

You need to have [Gleam](https://gleam.run/) installed.

To verify Gleam is installed:
```bash
gleam --version
```

## Building

From the `packages/memory/gleam` directory:

```bash
gleam build --target javascript
```

This will compile the Gleam code to JavaScript modules in `build/dev/javascript/memory_gleam/`.

Once the Gleam code is built, you can use Deno normally to run the memory package or toolshed. The compiled JavaScript will be automatically imported by the TypeScript code in `space.ts`.

## Project Structure

```
gleam/
├── README.md              # This file
├── gleam.toml            # Gleam project configuration
├── src/
│   └── memory_gleam.gleam # Main Gleam source (FFI wrapper)
└── build/
    └── dev/
        └── javascript/
            └── memory_gleam/
                └── memory_gleam.mjs  # Compiled JavaScript output
```

## How It Works

1. **`src/memory_gleam.gleam`** - Defines `select_gleam()` which uses the `@external` annotation to call JavaScript
2. **`../space_ffi.mjs`** - FFI bridge that wraps `select_jsimpl` and converts between JavaScript and Gleam Result types
3. **`../space.ts`** - The main memory module imports the compiled Gleam and uses it instead of calling `select_jsimpl` directly

## Running Tests

The existing TypeScript test suite in `packages/memory/` should continue to work:

```bash
# From packages/memory/
deno test
```

## Next Steps

The current implementation just passes through to JavaScript. Future work would:

1. Gradually implement actual logic in Gleam (starting with simple functions like `selectFacts`)
2. Replace TypeScript implementations piece by piece
3. Add Gleam-specific tests
4. Once fully implemented in Gleam, consider migrating server-side portions to BEAM target for better concurrency

## Future: BEAM Target

Once the entire memory package is rewritten in Gleam, we can switch server-side portions to the BEAM target:

```toml
# In gleam.toml
target = "erlang"  # Instead of "javascript"
```

This would give us access to:
- True lightweight processes
- Better concurrency model
- OTP supervision trees
- Hot code reloading

But for now, we're using the JavaScript target to allow gradual migration.
