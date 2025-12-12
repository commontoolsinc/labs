/// <cts-enable />
/**
 * Test Pattern: Cross-Charm Stream Server
 *
 * Exposes a Stream that increments a counter when invoked from another charm.
 * Used with test-cross-charm-client.tsx to verify cross-charm stream invocation.
 *
 * IMPORTANT: The #cross-charm-test-server tag is in the JSDoc on the Output
 * interface below (not here) - that's where wish() looks for tags.
 *
 * SETUP: After deploying, you must FAVORITE this charm for wish() to find it.
 */
import { Cell, Default, handler, NAME, pattern, Stream, UI } from "commontools";

interface Input {
  // Counter value that increments each time the stream is invoked
  counter: Default<number, 0>;

  // Log of invocation timestamps
  invocationLog: Default<string[], []>;
}

/** A #cross-charm-test-server that exposes a stream for testing cross-charm invocation. */
interface Output {
  counter: number;
  invocationLog: string[];

  // Stream that can be invoked from another charm
  incrementCounter: Stream<void>;
}

// Handler that increments the counter and logs the invocation
const incrementHandler = handler<
  unknown,
  { counter: Cell<number>; invocationLog: Cell<string[]> }
>((_event, { counter, invocationLog }) => {
  // Increment counter
  counter.set(counter.get() + 1);

  // Add timestamp to log
  const timestamp = new Date().toISOString();
  const log = invocationLog.get();
  invocationLog.set([...log, `Invoked at ${timestamp}`]);
});

export default pattern<Input, Output>(({ counter, invocationLog }) => {
  return {
    [NAME]: "Cross-Charm Test Server",
    [UI]: (
      <div
        style={{
          padding: "16px",
          border: "2px solid #4CAF50",
          borderRadius: "8px",
        }}
      >
        <h2>Cross-Charm Test Server</h2>
        <p style={{ fontStyle: "italic", color: "#666" }}>
          Tag: #cross-charm-test-server
        </p>

        <div style={{ marginTop: "16px" }}>
          <h3>Counter Value: {counter}</h3>
          <p>
            This counter increments when the incrementCounter stream is invoked
            from another charm.
          </p>
        </div>

        <div style={{ marginTop: "16px" }}>
          <h3>Invocation Log:</h3>
          {invocationLog.length === 0
            ? <p style={{ color: "#999" }}>No invocations yet</p>
            : (
              <ul style={{ maxHeight: "200px", overflowY: "auto" }}>
                {invocationLog.map((logEntry, i) => <li key={i}>{logEntry}</li>)}
              </ul>
            )}
        </div>

        <div
          style={{
            marginTop: "16px",
            padding: "8px",
            backgroundColor: "#f5f5f5",
            borderRadius: "4px",
          }}
        >
          <p style={{ fontSize: "12px", margin: 0 }}>
            <strong>How it works:</strong> This charm exposes an{" "}
            <code>incrementCounter</code>{" "}
            stream. When another charm wishes for this charm and invokes that
            stream, the counter increments and a log entry is added.
          </p>
        </div>
      </div>
    ),
    counter,
    invocationLog,
    incrementCounter: incrementHandler({
      counter,
      invocationLog,
    }) as unknown as Stream<void>,
  };
});
