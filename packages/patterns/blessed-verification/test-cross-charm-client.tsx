/// <cts-enable />
/**
 * Test Pattern: Cross-Charm Stream Client
 *
 * VERIFIED CLAIMS:
 *
 * 1. Cross-Charm Stream Invocation via wish() - WORKS (with corrections to blessed doc)
 *    - Streams from wished charms appear as Cells wrapping { $stream: true } marker
 *    - Call .send(eventData) on the Cell itself (NOT on an "unwrapped" stream)
 *    - The blessed doc's "auto-unwrap via Stream<T> signature" explanation is WRONG
 *    - Event must be an object (runtime calls preventDefault), can have data props but NO functions
 *
 * 2. ct.render Forces Charm Execution - VERIFIED
 *    - Just wishing for a charm doesn't make it run
 *    - Use <ct-render $cell={...} /> to force execution
 *
 * PREREQUISITES DISCOVERED:
 *    - Wish tags must be in JSDoc on Output type (not file-level comments)
 *    - wish({ query: "#tag" }) searches FAVORITES only - charm must be favorited first
 *
 * TESTING:
 *    1. Deploy server charm first, favorite it
 *    2. Deploy this client charm
 *    3. Toggle to Mode B (ct.render active)
 *    4. Click "Invoke Server Stream" - server counter should increment
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

// Handler that invokes a stream from the wished charm
// KEY FINDING: Despite blessed doc claims, Stream<T> in signature does NOT auto-unwrap.
// The stream comes through as a Cell wrapping { $stream: true }. Call .send({}) on the Cell.
const invokeServerStream = handler<
  unknown,
  {
    stream: Stream<void>;
    lastInvocationStatus: Cell<string>;
    invocationCount: Cell<number>;
  }
>((_event, state) => {
  try {
    // Stream arrives as a Cell, not an unwrapped callable stream
    const streamCell = state.stream as any;
    const innerValue = streamCell.get ? streamCell.get() : streamCell;

    if (innerValue && innerValue.$stream) {
      // Cell contains { $stream: true } marker - call .send() on the Cell itself
      // Event must be object (runtime calls preventDefault), can have data props, NO functions
      streamCell.send({});  // Could also be { someData: "value" }
      const count = state.invocationCount.get() + 1;
      state.invocationCount.set(count);
      state.lastInvocationStatus.set(`Success! Server counter should increment (invoked ${count} times)`);
    } else {
      state.lastInvocationStatus.set(`Stream not found or invalid: ${JSON.stringify(innerValue)}`);
    }
  } catch (error) {
    state.lastInvocationStatus.set(`Failed: ${error}`);
  }
});

// Handler for toggling the render mode
const toggleMode = handler<unknown, { useCtRender: Cell<boolean> }>(
  (_event, { useCtRender }) => {
    useCtRender.set(!useCtRender.get());
  }
);

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
            onClick={toggleMode({ useCtRender })}
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
