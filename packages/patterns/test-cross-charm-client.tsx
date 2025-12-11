/// <cts-enable />
/**
 * Test Pattern: Cross-Charm Stream Client
 *
 * This pattern tests two claims about cross-charm interaction:
 *
 * CLAIM 1: Cross-Charm Stream Invocation via wish()
 * - Streams from wished charms appear as opaque objects with $stream marker
 * - To invoke them, pass to a handler that declares Stream<T> in its signature
 * - Framework "unwraps" the opaque stream into a callable one
 *
 * CLAIM 2: ct.render Forces Charm Execution
 * - Just wishing for a charm doesn't make it run
 * - Use ct.render() to force the charm to execute
 * - Even in a hidden div, ct.render makes the charm active
 *
 * MANUAL TESTING INSTRUCTIONS:
 *
 * Step 1: Deploy the server charm first
 *   deno task ct charm new --identity ~/labs/tony.key --api-url http://localhost:8000 \
 *     --space test packages/patterns/test-cross-charm-server.tsx
 *
 * Step 2: Deploy this client charm
 *   deno task ct charm new --identity ~/labs/tony.key --api-url http://localhost:8000 \
 *     --space test packages/patterns/test-cross-charm-client.tsx
 *
 * Step 3: Open the space in browser
 *   http://localhost:8000/test
 *
 * Step 4: Test Claim 2 (ct.render Forces Execution)
 *   - Initially, mode is "Wish Only (no ct.render)"
 *   - Check server charm - it should NOT be executing yet (no UI updates)
 *   - Click "Toggle Mode" button
 *   - Now mode is "Wish + ct.render"
 *   - Check server charm - it should NOW be executing (UI should appear/update)
 *   - This confirms ct.render() forces charm execution
 *
 * Step 5: Test Claim 1 (Stream Invocation)
 *   - Click "Invoke Server Stream" button
 *   - Check the server charm - counter should increment
 *   - Check the client charm - it should show "Last invocation successful"
 *   - Click multiple times to verify each invocation increments the counter
 *   - This confirms streams can be invoked across charms
 *
 * EXPECTED BEHAVIOR:
 * - Claim 1: Each click of "Invoke Server Stream" increments the server's counter
 * - Claim 2: Server charm only executes when ct.render is active (mode B)
 */
import { Cell, Default, NAME, pattern, Stream, UI, wish, derive, handler } from "commontools";
import ct from "commontools";

interface Input {
  // Toggle between Mode A (wish only) and Mode B (wish + ct.render)
  useCtRender: Default<boolean, false>;

  // Track last invocation result
  lastInvocationStatus: Default<string, "Not invoked yet">;

  // Track invocation count
  invocationCount: Default<number, 0>;
}

interface Output {
  useCtRender: boolean;
  lastInvocationStatus: string;
  invocationCount: number;
}

// Handler that attempts to invoke a stream from the wished charm
// The claim is that when you pass an opaque stream to a handler that declares Stream<T>
// in its signature, the framework unwraps it and makes it callable
const invokeServerStream = handler<
  unknown,
  {
    stream: Stream<void>;
    lastInvocationStatus: Cell<string>;
    invocationCount: Cell<number>;
  }
>((_event, state) => {
  try {
    // Test Claim 1: Can we invoke a stream from a wished charm?
    // The stream should be unwrapped by the framework when declared as Stream<T> in the signature
    // At compile time this shows as an error, but the claim is it should work at runtime
    (state.stream as any)();

    const count = state.invocationCount.get() + 1;
    state.invocationCount.set(count);
    state.lastInvocationStatus.set(`Successful (invoked ${count} times)`);
  } catch (error) {
    state.lastInvocationStatus.set(`Failed: ${error}`);
  }
});

export default pattern<Input, Output>(({ useCtRender, lastInvocationStatus, invocationCount }) => {
  // Wish for the server charm by tag
  const wishResult = wish<{
    counter: number;
    invocationLog: string[];
    incrementCounter: Stream<void>;
  }>({
    query: "#cross-charm-test-server",
  });

  // Access the result from the wish (WishState has a result property)
  const serverCharm = wishResult.result;

  // Extract the stream using derive
  const serverStream = derive(serverCharm, (charm) => charm?.incrementCounter);

  return {
    [NAME]: "Cross-Charm Test Client",
    [UI]: (
      <div style={{ padding: "16px", border: "2px solid #2196F3", borderRadius: "8px" }}>
        <h2>Cross-Charm Test Client</h2>

        {/* Mode Toggle Section */}
        <div style={{ marginTop: "16px", padding: "12px", backgroundColor: "#E3F2FD", borderRadius: "4px" }}>
          <h3 style={{ marginTop: 0 }}>Claim 2 Test: ct.render Forces Execution</h3>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span>Current Mode:</span>
            <strong style={{ color: useCtRender ? "#4CAF50" : "#FF9800" }}>
              {useCtRender ? "Mode B: Wish + ct.render" : "Mode A: Wish Only (no ct.render)"}
            </strong>
          </div>
          <ct-button
            onClick={() => {
              useCtRender.set(!useCtRender.get());
            }}
            style="margin-top: 8px;"
          >
            Toggle Mode
          </ct-button>
          <p style={{ fontSize: "12px", marginTop: "8px", marginBottom: 0 }}>
            In Mode A, server charm should NOT execute. In Mode B, it should execute.
          </p>
        </div>

        {/* Server Charm Rendering Section */}
        <div style={{ marginTop: "16px", padding: "12px", backgroundColor: "#FFF3E0", borderRadius: "4px" }}>
          <h3 style={{ marginTop: 0 }}>Server Charm Status</h3>
          {useCtRender ? (
            <div>
              <p style={{ color: "#4CAF50", fontWeight: "bold" }}>
                Mode B Active: Rendering server charm with ct.render
              </p>
              {/* Use ct.render to force execution - even hidden, this makes the charm active */}
              <div style={{ border: "1px dashed #999", padding: "8px", marginTop: "8px" }}>
                <ct-render $cell={wishResult.result} />
              </div>
            </div>
          ) : (
            <p style={{ color: "#FF9800", fontWeight: "bold" }}>
              Mode A Active: Server charm wished for but NOT rendered (should not execute)
            </p>
          )}
        </div>

        {/* Stream Invocation Section */}
        <div style={{ marginTop: "16px", padding: "12px", backgroundColor: "#F3E5F5", borderRadius: "4px" }}>
          <h3 style={{ marginTop: 0 }}>Claim 1 Test: Stream Invocation</h3>
          <div style={{ marginBottom: "8px" }}>
            <strong>Last Invocation Status:</strong> {lastInvocationStatus}
          </div>
          <ct-button
            onClick={invokeServerStream({
              stream: serverStream,
              lastInvocationStatus,
              invocationCount,
            })}
            style="margin-top: 8px;"
          >
            Invoke Server Stream
          </ct-button>
          <p style={{ fontSize: "12px", marginTop: "8px", marginBottom: 0 }}>
            Click to invoke the incrementCounter stream from the server charm.
            Check the server charm to see if the counter incremented.
          </p>
        </div>

        {/* Debug Info */}
        <div style={{ marginTop: "16px", padding: "8px", backgroundColor: "#f5f5f5", borderRadius: "4px" }}>
          <details>
            <summary style={{ cursor: "pointer", fontWeight: "bold" }}>Debug Info</summary>
            <pre style={{ fontSize: "10px", overflow: "auto" }}>
              {JSON.stringify(
                {
                  useCtRender,
                  invocationCount,
                  lastInvocationStatus,
                  serverCharmExists: serverCharm !== undefined && serverCharm !== null,
                  serverStreamExists: serverStream !== undefined && serverStream !== null,
                },
                null,
                2
              )}
            </pre>
          </details>
        </div>
      </div>
    ),
    useCtRender,
    lastInvocationStatus,
    invocationCount,
  };
});
