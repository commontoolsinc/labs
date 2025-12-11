# Cross-Charm Test Patterns

## Overview

Two test patterns have been created to verify cross-charm interaction claims:

1. **test-cross-charm-server.tsx** - Exposes a Stream that can be invoked from another charm
2. **test-cross-charm-client.tsx** - Wishes for the server and tests both claims

## Claims Being Tested

### Claim 1: Cross-Charm Stream Invocation via wish()
- Streams from wished charms appear as opaque objects with $stream marker
- To invoke them, pass to a handler that declares `Stream<T>` in its signature
- Framework "unwraps" the opaque stream into a callable one

### Claim 2: ct.render Forces Charm Execution
- Just wishing for a charm doesn't make it run
- Use `ct.render()` to force the charm to execute
- Even in a hidden div, `ct.render` makes the charm active

## Pattern Files

- **Server**: `/Users/gideonwald/coding/common_tools/labs/packages/patterns/test-cross-charm-server.tsx`
- **Client**: `/Users/gideonwald/coding/common_tools/labs/packages/patterns/test-cross-charm-client.tsx`

## Manual Testing Instructions

### Step 1: Deploy the Server Charm
```bash
deno task ct charm new --identity ~/labs/tony.key --api-url http://localhost:8000 \
  --space test packages/patterns/test-cross-charm-server.tsx
```

Note the charm ID returned (e.g., `baedreiAAA...`)

### Step 2: Deploy the Client Charm
```bash
deno task ct charm new --identity ~/labs/tony.key --api-url http://localhost:8000 \
  --space test packages/patterns/test-cross-charm-client.tsx
```

### Step 3: Open the Space
Navigate to: `http://localhost:8000/test`

You should see both charms in the space.

### Step 4: Test Claim 2 (ct.render Forces Execution)

**Initial State (Mode A):**
- The client will be in "Mode A: Wish Only (no ct.render)"
- Observe the server charm - it should NOT be executing yet (no UI updates or minimal rendering)

**Toggle to Mode B:**
- Click the "Toggle Mode" button in the client charm
- Mode changes to "Mode B: Wish + ct.render"
- Observe the server charm - it should NOW be executing (full UI should appear/update)

**Expected Result:** This confirms that `ct.render()` forces charm execution, whereas just wishing doesn't.

### Step 5: Test Claim 1 (Stream Invocation)

**Setup:**
- Ensure you're in Mode B so the server charm is visible
- Note the initial counter value in the server charm (should be 0)

**Test Stream Invocation:**
1. Click "Invoke Server Stream" button in the client charm
2. Check the server charm:
   - Counter should increment to 1
   - Invocation log should show a new timestamp entry
3. Check the client charm:
   - "Last Invocation Status" should show "Successful (invoked 1 times)"
4. Click multiple times to verify:
   - Each click increments the server's counter
   - Each click adds to the server's invocation log
   - Client tracks total invocation count

**Expected Result:** This confirms that streams can be invoked across charms by passing them to handlers with `Stream<T>` signatures.

## How It Works

### Server Pattern
- Exposes an `incrementCounter` stream in its Output interface
- Tagged with `#cross-charm-test-server` for discovery
- Stream increments a counter and logs each invocation with timestamp

### Client Pattern
- Uses `wish({ query: "#cross-charm-test-server" })` to find the server
- Extracts the stream using `derive()`
- Has two modes:
  - **Mode A**: Only wishes (tests that wishing alone doesn't execute the charm)
  - **Mode B**: Wishes + uses `ct.render()` (tests that ct.render forces execution)
- Has a handler that accepts `Stream<void>` and attempts to invoke it
- Uses `as any` cast because TypeScript doesn't know streams are callable (but the runtime should handle it)

## Technical Notes

### Stream Type Handling
- At compile-time, `Stream<T>` is not callable (no call signatures)
- The claim is that at runtime, when a handler declares `stream: Stream<T>` in its parameters, the framework unwraps the opaque stream reference
- We use `(state.stream as any)()` to bypass TypeScript's compile-time check
- If the claim is correct, the runtime invocation should work despite the compile-time error

### WishState Structure
- `wish()` returns a `WishState<T>` object
- `WishState` has properties: `result?: T`, `error?: any`, `[UI]?: VNode`
- Access the wished charm via `wishResult.result`

### ct.render Usage
- `ct.render` is a component that forces a charm to execute
- Pass the charm cell via `$cell` attribute: `<ct-render $cell={charm} />`
- Even if the rendered output is hidden or in a collapsed section, the charm becomes active

## Success Criteria

**Claim 1 Passes If:**
- Clicking "Invoke Server Stream" increments the server's counter
- Multiple invocations work correctly
- No runtime errors occur during invocation

**Claim 2 Passes If:**
- In Mode A, the server charm is NOT fully active/executing
- In Mode B, the server charm IS fully active/executing
- The difference is observable in the UI rendering

## Potential Failure Modes

**Claim 1 May Fail If:**
- Runtime error: "stream is not a function"
- Server counter doesn't increment
- TypeScript's compile-time restriction prevents runtime execution

**Claim 2 May Fail If:**
- Server charm executes even in Mode A (wishing is sufficient for execution)
- Server charm doesn't execute even in Mode B (ct.render doesn't force execution)
- No observable difference between the modes

## Files Created

1. `/Users/gideonwald/coding/common_tools/labs/packages/patterns/test-cross-charm-server.tsx` - Server pattern
2. `/Users/gideonwald/coding/common_tools/labs/packages/patterns/test-cross-charm-client.tsx` - Client pattern
3. This documentation file

## Next Steps

1. Deploy both patterns to a test space
2. Follow the manual testing instructions
3. Document the actual behavior observed
4. Update the claims in the documentation based on results
5. If claims are validated, add examples to CHARM_LINKING.md
6. If claims fail, investigate why and update the patterns or documentation accordingly
