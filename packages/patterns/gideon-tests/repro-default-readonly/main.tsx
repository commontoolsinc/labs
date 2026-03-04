/// <cts-enable />
import {
  Default,
  NAME,
  pattern,
  UI,
  Writable,
  action,
} from "commontools";

// ============================================================
// Variation 1: Default array with pre-populated item
// Expected: typing in the notes field triggers ReadOnlyAddressError
// because the default item is a literal data: URI
// ============================================================

interface SimpleItem {
  name: string;
  notes: Default<string, "">;
}

interface Var1Input {
  prepopulated: Writable<
    Default<SimpleItem[], [{ name: "Alice"; notes: "" }]>
  >;
}

// ============================================================
// Variation 2: Default empty array, item added via button click
// Question: does pushing an item at runtime produce a writable
// cell, or does it also end up read-only?
// ============================================================

interface Var2Input {
  pushed: Writable<Default<SimpleItem[], []>>;
}

// ============================================================
// Variation 3: Nested object with defaults at multiple levels
// Question: can $value bind to a leaf property on a nested
// default object?
// ============================================================

interface Address {
  street: Default<string, "">;
  city: Default<string, "">;
}

interface PersonWithAddress {
  name: string;
  address: Default<Address, { street: ""; city: "" }>;
}

interface Var3Input {
  nested: Writable<
    Default<
      PersonWithAddress[],
      [{ name: "Bob"; address: { street: "123 Main St"; city: "Springfield" } }]
    >
  >;
}

// ============================================================
// Variation 4: Single nested default object (no array, no .map())
// Question: is the issue specific to arrays, or does any default
// object with $value binding on a nested property fail?
// ============================================================

interface Var4Input {
  solo: Writable<
    Default<
      PersonWithAddress,
      { name: "Dana"; address: { street: "456 Elm St"; city: "Shelbyville" } }
    >
  >;
}

// ============================================================
// Combined pattern
// ============================================================

interface AllInput extends Var1Input, Var2Input, Var3Input, Var4Input {}
interface AllOutput extends AllInput {}

export default pattern<AllInput, AllOutput>(
  ({ prepopulated, pushed, nested, solo }) => {
    const addCharlie = action(() => {
      pushed.push({ name: "Charlie", notes: "" });
    });

    return {
      [NAME]: "Default Readonly Repro",
      [UI]: (
        <div style={{ display: "flex", flexDirection: "column", gap: "24px", padding: "16px" }}>
          {/* --- Variation 1 --- */}
          <div>
            <h3>Variation 1: Pre-populated Default</h3>
            <p style={{ fontSize: "0.85rem", color: "#666" }}>
              Item comes from Default literal. Expect ReadOnlyAddressError on typing.
            </p>
            {prepopulated.map((item) => (
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <span style={{ fontWeight: "600", minWidth: "80px" }}>{item.name}</span>
                <ct-input $value={item.notes} placeholder="Type here..." />
              </div>
            ))}
          </div>

          {/* --- Variation 2 --- */}
          <div>
            <h3>Variation 2: Empty Default + Push via Button</h3>
            <p style={{ fontSize: "0.85rem", color: "#666" }}>
              Array starts empty. Click the button to push an item, then try typing in its notes field.
              Does a runtime-pushed item produce a writable cell?
            </p>
            <ct-button onClick={() => addCharlie.send()}>Add Charlie</ct-button>
            {pushed.map((item) => (
              <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "8px" }}>
                <span style={{ fontWeight: "600", minWidth: "80px" }}>{item.name}</span>
                <ct-input $value={item.notes} placeholder="Type here..." />
              </div>
            ))}
          </div>

          {/* --- Variation 3 --- */}
          <div>
            <h3>Variation 3: Nested Default Object</h3>
            <p style={{ fontSize: "0.85rem", color: "#666" }}>
              Item has a nested address object with defaults at multiple levels.
              Can $value bind to address.street and address.city?
            </p>
            {nested.map((person) => (
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <span style={{ fontWeight: "600" }}>{person.name}</span>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <span style={{ minWidth: "50px", fontSize: "0.85rem" }}>Street:</span>
                  <ct-input $value={person.address.street} placeholder="Street..." />
                </div>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <span style={{ minWidth: "50px", fontSize: "0.85rem" }}>City:</span>
                  <ct-input $value={person.address.city} placeholder="City..." />
                </div>
              </div>
            ))}
          </div>
          {/* --- Variation 4 --- */}
          <div>
            <h3>Variation 4: Single Nested Object (no array, no .map())</h3>
            <p style={{ fontSize: "0.85rem", color: "#666" }}>
              A single Writable object with Default, not inside an array.
              Writable with .key() to access nested properties. Does $value on .key("address").key("city") work?
            </p>
            <span style={{ fontWeight: "600" }}>{solo.key("name")}</span>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "4px" }}>
              <span style={{ minWidth: "50px", fontSize: "0.85rem" }}>Street:</span>
              <ct-input $value={solo.key("address").key("street")} placeholder="Street..." />
            </div>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "4px" }}>
              <span style={{ minWidth: "50px", fontSize: "0.85rem" }}>City:</span>
              <ct-input $value={solo.key("address").key("city")} placeholder="City..." />
            </div>
          </div>
        </div>
      ),
      prepopulated,
      pushed,
      nested,
      solo,
    };
  },
);
