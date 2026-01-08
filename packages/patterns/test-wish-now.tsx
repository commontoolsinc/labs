/// <cts-enable />
/**
 * Test pattern demonstrating wish("#now") behavior
 * 
 * KEY FINDINGS:
 * - wish("#now") captures Date.now() ONCE when the wish first runs
 * - The value is stored in an immutable cell and never changes
 * - Re-reading or re-pulling the value returns the same timestamp
 * - Creating a NEW charm instance creates a NEW timestamp
 * 
 * PRACTICAL USE:
 * - wish("#now") gives you the "charm creation time"
 * - For fresh timestamps on each click, use Date.now() in handlers
 */
import { Cell, computed, Default, NAME, pattern, UI, wish } from "commontools";

interface LogEntry {
  source: string;
  value: number;
  timestamp: string;
}

interface Input {
  log: Cell<LogEntry[]>;
  clickCount: Cell<Default<number, 0>>;
}

export default pattern<Input, Input>(({ log, clickCount }) => {
  // This captures Date.now() ONCE when the charm is created
  const creationTime = wish<number>("#now");

  // Format for display
  const creationTimeFormatted = computed(() => {
    const val = creationTime;
    if (typeof val === "number") {
      return new Date(val).toISOString();
    }
    return "Loading...";
  });

  // Computed to check log length
  const hasEntries = computed(() => {
    const entries = log.get();
    return entries && entries.length > 0;
  });

  return {
    [NAME]: "wish(#now) Behavior Demo",
    [UI]: (
      <div style={{ padding: "20px", fontFamily: "system-ui", maxWidth: "600px" }}>
        <h2>wish("#now") Behavior Demo</h2>
        
        <div style={{ 
          padding: "16px", 
          background: "#e8f4e8", 
          borderRadius: "8px", 
          marginBottom: "20px",
          border: "1px solid #4a4"
        }}>
          <h3 style={{ margin: "0 0 8px 0" }}>Charm Creation Time (via wish)</h3>
          <code style={{ fontSize: "14px" }}>{creationTimeFormatted}</code>
          <p style={{ margin: "8px 0 0 0", fontSize: "12px", color: "#666" }}>
            This value was captured when the charm was created and will never change.
          </p>
        </div>

        <div style={{ marginBottom: "20px" }}>
          <h3>Compare Timestamps</h3>
          <p>Click count: {clickCount}</p>
          
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <ct-button onClick={() => {
              const c = clickCount.get() || 0;
              clickCount.set(c + 1);
              const browserNow = Date.now();
              log.push({
                source: "Date.now() in handler",
                value: browserNow,
                timestamp: new Date(browserNow).toISOString()
              });
            }}>
              Log Date.now() (fresh each click)
            </ct-button>

            <ct-button onClick={() => {
              const c = clickCount.get() || 0;
              clickCount.set(c + 1);
              const wishVal = typeof creationTime === "number" ? creationTime : 0;
              log.push({
                source: "wish(#now) value",
                value: wishVal,
                timestamp: new Date(wishVal).toISOString()
              });
            }}>
              Log wish value (always same)
            </ct-button>

            <ct-button onClick={() => log.set([])}>
              Clear Log
            </ct-button>
          </div>
        </div>

        <div style={{ background: "#f5f5f5", borderRadius: "8px", padding: "16px" }}>
          <h3 style={{ margin: "0 0 12px 0" }}>Log Entries</h3>
          {hasEntries ? (
            log.map((entry, i) => (
              <div style={{ 
                padding: "8px", 
                background: entry.source.includes("Date.now") ? "#e3f2fd" : "#fff3e0",
                borderRadius: "4px",
                marginBottom: "8px",
                fontSize: "13px"
              }}>
                <strong>#{i + 1}</strong> [{entry.source}]
                <br />
                <code>{entry.timestamp}</code>
                <span style={{ color: "#666" }}> ({entry.value})</span>
              </div>
            ))
          ) : (
            <p style={{ color: "#666", fontStyle: "italic" }}>Click buttons to add entries...</p>
          )}
        </div>

        <div style={{ 
          marginTop: "20px", 
          padding: "16px", 
          background: "#fff8e1", 
          borderRadius: "8px",
          border: "1px solid #ffb"
        }}>
          <h3 style={{ margin: "0 0 8px 0" }}>Key Takeaways</h3>
          <ul style={{ margin: 0, paddingLeft: "20px" }}>
            <li><strong>Date.now() in handler</strong>: Fresh timestamp each click</li>
            <li><strong>wish("#now") value</strong>: Same timestamp every time (charm creation time)</li>
            <li>Use wish("#now") for "when was this charm created"</li>
            <li>Use Date.now() in handlers for "when did this action happen"</li>
          </ul>
        </div>
      </div>
    ),
    log,
    clickCount,
    // Export creation time for inspection
    creationTime,
  };
});
