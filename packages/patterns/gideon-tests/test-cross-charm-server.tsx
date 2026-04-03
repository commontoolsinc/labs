/// <cts-enable />
/**
 * Test Pattern: Cross-Piece Stream Server
 *
 * Exposes a Stream that increments a counter when invoked from another piece.
 * Used with test-cross-piece-client.tsx to verify cross-piece stream invocation.
 *
 * IMPORTANT: The #cross-piece-test-server tag is in the JSDoc on the Output
 * interface below (not here) - that's where wish() looks for tags.
 *
 * SETUP: After deploying, you must FAVORITE this piece for wish() to find it.
 */
import {
  Default,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
} from "commontools";

interface Input {
  // Counter value that increments each time the stream is invoked
  counter: Default<number, 0>;

  // Log of invocation timestamps
  invocationLog: Default<string[], []>;
}

/** A #cross-piece-test-server that exposes a stream for testing cross-piece invocation. */
interface Output {
  counter: number;
  invocationLog: string[];

  // Stream that can be invoked from another piece
  incrementCounter: Stream<void>;
}

// Handler that increments the counter and logs the invocation
const incrementHandler = handler<
  void,
  { counter: Writable<number>; invocationLog: Writable<string[]> }
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
    [NAME]: "Cross-Piece Test Server",
    [UI]: (
      <div
        style={{
          padding: "16px",
          border: "2px solid #4CAF50",
          borderRadius: "8px",
        }}
      >
        <h2>Cross-Piece Test Server</h2>
        <p style={{ fontStyle: "italic", color: "#666" }}>
          Tag: #cross-piece-test-server
        </p>

        <div style={{ marginTop: "16px" }}>
          <h3>Counter Value: {counter}</h3>
          <p>
            This counter increments when the incrementCounter stream is invoked
            from another piece.
          </p>
        </div>

        <div style={{ marginTop: "16px" }}>
          <h3>Invocation Log:</h3>
          {invocationLog.length === 0
            ? <p style={{ color: "#999" }}>No invocations yet</p>
            : (
              <ul style={{ maxHeight: "200px", overflowY: "auto" }}>
                {invocationLog.map((logEntry, i) => (
                  <li key={i}>{logEntry}</li>
                ))}
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
            <strong>How it works:</strong> This piece exposes an{" "}
            <code>incrementCounter</code>{" "}
            stream. When another piece wishes for this piece and invokes that
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
    }),
  };
});
