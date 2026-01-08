/// <cts-enable />
/**
 * TEST PATTERN: Cell.of(null) Returns Cell Reference, Not Null
 *
 * CLAIM: Cell.of(null) returns a Cell reference object instead of primitive null,
 * causing !== null checks to always be truthy
 * SOURCE: superstitions/2025-12-22-cell-of-null-returns-cell-reference.md
 *
 * WHAT THIS TESTS:
 * - Cell.of(null).get() behavior - does it return primitive null or Cell object?
 * - Cell.of<T>() with undefined vs Cell.of(null)
 * - Correct patterns for nullable cell values
 *
 * EXPECTED BEHAVIOR:
 * - Cell.of(null).get() !== null is ALWAYS TRUE (returns Cell reference)
 * - Cell.of<T>().get() === undefined (correct for "no value")
 * - Using !!value instead of !== null works correctly
 *
 * MANUAL VERIFICATION STEPS:
 * 1. Load the pattern
 * 2. Observe the initial state of each cell
 * 3. Check the boolean condition results
 * 4. Try setting/clearing values to see behavior
 */
import {
  Cell,
  computed,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
} from "commontools";

const setNullValue = handler<unknown, { cell: Cell<string | null> }>(
  (_event, { cell }) => {
    cell.set(null);
  },
);

const setUndefinedValue = handler<unknown, { cell: Cell<string | undefined> }>(
  (_event, { cell }) => {
    cell.set(undefined);
  },
);

const setActualValue = handler<
  unknown,
  { cell: Cell<string | null | undefined> }
>(
  (_event, { cell }) => {
    cell.set("Hello!");
  },
);

export default pattern(() => {
  // Cell initialized with null - the problematic pattern
  const cellWithNull = Cell.of<string | null>(null);

  // Cell initialized without argument - the correct pattern
  const cellWithUndefined = Cell.of<string | undefined>();

  // Derived checks
  const nullCheckNotEquals = computed(() => {
    const value = cellWithNull.get();
    return value !== null;
  });

  const nullCheckDoubleNot = computed(() => {
    const value = cellWithNull.get();
    return !!value;
  });

  const undefinedCheckNotEquals = computed(() => {
    const value = cellWithUndefined.get();
    return value !== undefined;
  });

  const undefinedCheckDoubleNot = computed(() => {
    const value = cellWithUndefined.get();
    return !!value;
  });

  // Type inspection
  const nullValueType = computed(() => {
    const value = cellWithNull.get();
    if (value === null) return "primitive null";
    if (value === undefined) return "undefined";
    if (typeof value === "string") return "string";
    if (typeof value === "object") {
      return `object: ${JSON.stringify(value).slice(0, 50)}`;
    }
    return typeof value;
  });

  const undefinedValueType = computed(() => {
    const value = cellWithUndefined.get();
    if (value === null) return "primitive null";
    if (value === undefined) return "undefined";
    if (typeof value === "string") return "string";
    if (typeof value === "object") {
      return `object: ${JSON.stringify(value).slice(0, 50)}`;
    }
    return typeof value;
  });

  // Raw value display
  const nullRawValue = computed(() => {
    const value = cellWithNull.get();
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  });

  const undefinedRawValue = computed(() => {
    const value = cellWithUndefined.get();
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  });

  return {
    [NAME]: "Test: Cell.of(null) Behavior",
    [UI]: (
      <div style={{ padding: "20px", fontFamily: "monospace" }}>
        <h2>Superstition: Cell.of(null) Returns Cell Reference</h2>
        <p style={{ color: "#666", marginBottom: "20px" }}>
          CLAIM: Cell.of(null).get() returns a Cell object, not primitive null.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "20px",
            marginBottom: "20px",
          }}
        >
          {/* Cell.of(null) VERSION */}
          <div
            style={{
              padding: "15px",
              backgroundColor: "#ffebee",
              borderRadius: "8px",
              border: "2px solid #f44336",
            }}
          >
            <h3 style={{ color: "#c62828", margin: "0 0 10px 0" }}>
              BAD: Cell.of(null)
            </h3>
            <pre
              style={{
                backgroundColor: "#fff",
                padding: "10px",
                borderRadius: "4px",
                fontSize: "11px",
              }}
            >
              {`const cell = Cell.of<string | null>(null);`}
            </pre>

            <div
              style={{
                marginTop: "15px",
                padding: "10px",
                backgroundColor: "#fff",
                borderRadius: "4px",
              }}
            >
              <table style={{ width: "100%", fontSize: "12px" }}>
                <tbody>
                  <tr>
                    <td style={{ padding: "4px" }}>Raw .get() value:</td>
                    <td style={{ padding: "4px", fontWeight: "bold" }}>
                      {nullRawValue}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ padding: "4px" }}>typeof value:</td>
                    <td style={{ padding: "4px", fontWeight: "bold" }}>
                      {nullValueType}
                    </td>
                  </tr>
                  <tr style={{ backgroundColor: "#ffcdd2" }}>
                    <td style={{ padding: "4px" }}>value !== null:</td>
                    <td style={{ padding: "4px", fontWeight: "bold" }}>
                      {nullCheckNotEquals ? "TRUE (BUG!)" : "false"}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ padding: "4px" }}>!!value:</td>
                    <td style={{ padding: "4px", fontWeight: "bold" }}>
                      {nullCheckDoubleNot ? "true" : "false"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div
              style={{
                marginTop: "10px",
                display: "flex",
                gap: "5px",
                flexWrap: "wrap",
              }}
            >
              <ct-button onClick={setNullValue({ cell: cellWithNull })}>
                Set null
              </ct-button>
              <ct-button onClick={setActualValue({ cell: cellWithNull })}>
                Set "Hello!"
              </ct-button>
            </div>

            {/* Conditional rendering demo */}
            <div style={{ marginTop: "15px" }}>
              <div style={{ fontSize: "12px", marginBottom: "5px" }}>
                ifElse(value !== null):
              </div>
              {ifElse(
                nullCheckNotEquals,
                <div
                  style={{
                    padding: "5px",
                    backgroundColor: "#ffcdd2",
                    borderRadius: "4px",
                  }}
                >
                  SHOWING (unexpected if no value set!)
                </div>,
                <div
                  style={{
                    padding: "5px",
                    backgroundColor: "#c8e6c9",
                    borderRadius: "4px",
                  }}
                >
                  HIDDEN (correct for null)
                </div>,
              )}
            </div>
          </div>

          {/* Cell.of<T>() VERSION */}
          <div
            style={{
              padding: "15px",
              backgroundColor: "#e8f5e9",
              borderRadius: "8px",
              border: "2px solid #4caf50",
            }}
          >
            <h3 style={{ color: "#2e7d32", margin: "0 0 10px 0" }}>
              GOOD: Cell.of{"<T>"}()
            </h3>
            <pre
              style={{
                backgroundColor: "#fff",
                padding: "10px",
                borderRadius: "4px",
                fontSize: "11px",
              }}
            >
              {`const cell = Cell.of<string | undefined>();`}
            </pre>

            <div
              style={{
                marginTop: "15px",
                padding: "10px",
                backgroundColor: "#fff",
                borderRadius: "4px",
              }}
            >
              <table style={{ width: "100%", fontSize: "12px" }}>
                <tbody>
                  <tr>
                    <td style={{ padding: "4px" }}>Raw .get() value:</td>
                    <td style={{ padding: "4px", fontWeight: "bold" }}>
                      {undefinedRawValue}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ padding: "4px" }}>typeof value:</td>
                    <td style={{ padding: "4px", fontWeight: "bold" }}>
                      {undefinedValueType}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ padding: "4px" }}>value !== undefined:</td>
                    <td style={{ padding: "4px", fontWeight: "bold" }}>
                      {undefinedCheckNotEquals ? "true" : "false"}
                    </td>
                  </tr>
                  <tr style={{ backgroundColor: "#c8e6c9" }}>
                    <td style={{ padding: "4px" }}>!!value:</td>
                    <td style={{ padding: "4px", fontWeight: "bold" }}>
                      {undefinedCheckDoubleNot ? "true" : "false (correct!)"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div
              style={{
                marginTop: "10px",
                display: "flex",
                gap: "5px",
                flexWrap: "wrap",
              }}
            >
              <ct-button
                onClick={setUndefinedValue({ cell: cellWithUndefined })}
              >
                Set undefined
              </ct-button>
              <ct-button onClick={setActualValue({ cell: cellWithUndefined })}>
                Set "Hello!"
              </ct-button>
            </div>

            {/* Conditional rendering demo */}
            <div style={{ marginTop: "15px" }}>
              <div style={{ fontSize: "12px", marginBottom: "5px" }}>
                ifElse(!!value):
              </div>
              {ifElse(
                undefinedCheckDoubleNot,
                <div
                  style={{
                    padding: "5px",
                    backgroundColor: "#c8e6c9",
                    borderRadius: "4px",
                  }}
                >
                  SHOWING (has value)
                </div>,
                <div
                  style={{
                    padding: "5px",
                    backgroundColor: "#e0e0e0",
                    borderRadius: "4px",
                  }}
                >
                  HIDDEN (no value - correct!)
                </div>,
              )}
            </div>
          </div>
        </div>

        {/* Analysis */}
        <div
          style={{
            padding: "15px",
            backgroundColor: "#fff3e0",
            borderRadius: "8px",
          }}
        >
          <h3 style={{ margin: "0 0 10px 0" }}>Analysis</h3>
          <div
            style={{
              padding: "10px",
              backgroundColor: "#fffde7",
              borderRadius: "4px",
            }}
          >
            <strong>Expected Result:</strong>
            <ul style={{ margin: "5px 0 0 0", paddingLeft: "20px" }}>
              <li>
                If Cell.of(null).get() !== null is TRUE initially, superstition
                is TRUE
              </li>
              <li>
                The typeof should show "object" instead of "primitive null"
              </li>
              <li>
                Use undefined and !!value for reliable null checks
              </li>
            </ul>
          </div>
          <div style={{ marginTop: "15px" }}>
            <strong>Recommended Pattern:</strong>
            <pre
              style={{
                backgroundColor: "#fff",
                padding: "10px",
                borderRadius: "4px",
                fontSize: "12px",
                marginTop: "5px",
              }}
            >
              {`// Instead of:
const cell = Cell.of<Entry | null>(null);
if (cell.get() !== null) { ... }

// Use:
const cell = Cell.of<Entry | undefined>();
if (!!cell.get()) { ... }`}
            </pre>
          </div>
        </div>
      </div>
    ),
    cellWithNull,
    cellWithUndefined,
  };
});
