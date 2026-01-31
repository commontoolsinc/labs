/// <cts-enable />
/**
 * TEST PATTERN: computed() and derive() Are The Same Thing
 *
 * CLAIM: computed() and derive() are functionally identical
 * SOURCE: folk_wisdom/reactivity.md
 *
 * WHAT THIS TESTS:
 * - Creating a derived value with computed()
 * - Creating an equivalent derived value with derive()
 * - Both update when dependencies change
 * - Both produce the same output values
 *
 * FRAMEWORK CODE EVIDENCE:
 * In packages/runner/src/builder/module.ts:227-228:
 *   export const computed = <T>(fn: () => T) => lift<any, T>(fn)(undefined);
 *
 * computed() is literally implemented as lift(fn)(undefined), which is
 * exactly how derive() works but with no input dependencies.
 *
 * EXPECTED BEHAVIOR:
 * Two side-by-side displays showing that computed and derive produce
 * identical values and update in lockstep.
 *
 * MANUAL VERIFICATION STEPS:
 * 1. Load the pattern
 * 2. See that both computed and derive show the same initial value
 * 3. Change the first name input
 * 4. Verify BOTH values update identically
 * 5. Change the last name input
 * 6. Verify BOTH values update identically
 */
import {
  computed,
  Default,
  derive,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";

interface TestInput {
  firstName: Default<string, "John">;
  lastName: Default<string, "Doe">;
  age: Default<number, 30>;
}

const updateNames = handler<
  unknown,
  { firstName: Writable<string>; lastName: Writable<string> }
>((_event, { firstName, lastName }) => {
  const names = ["Alice", "Bob", "Charlie", "Diana"];
  const randomIndex = Math.floor(secureRandom() * names.length);
  const randomName = names[randomIndex];
  firstName.set(randomName);
  lastName.set(`Smith-${Temporal.Now.instant().epochMilliseconds % 1000}`);
});

export default pattern<TestInput>(({ firstName, lastName, age }) => {
  // Using computed() - transformer extracts captured values, unwraps them
  // No .get() needed - values are already unwrapped by transformer
  const computedFullName = computed(
    () => `${firstName} ${lastName} (age ${age})`,
  );

  // Using derive() with no explicit deps - same behavior as computed
  // Transformer also extracts and unwraps captured values
  const deriveFullName = derive(
    {},
    () => `${firstName} ${lastName} (age ${age})`,
  );

  // Using derive() with explicit deps - also equivalent
  // Parameters are explicitly unwrapped
  const deriveWithDeps = derive(
    { fn: firstName, ln: lastName, a: age },
    ({ fn, ln, a }) => `${fn} ${ln} (age ${a})`,
  );

  return {
    [NAME]: "Test: computed() = derive()",
    [UI]: (
      <div style={{ padding: "20px", fontFamily: "sans-serif" }}>
        <h2>computed() and derive() Equivalence Test</h2>

        <div
          style={{
            padding: "15px",
            marginBottom: "20px",
            backgroundColor: "#e3f2fd",
            borderRadius: "5px",
          }}
        >
          <h3>Inputs</h3>
          <div style={{ marginBottom: "10px" }}>
            <label>First Name:</label>
            <ct-input $value={firstName} />
          </div>
          <div style={{ marginBottom: "10px" }}>
            <label>Last Name:</label>
            <ct-input $value={lastName} />
          </div>
          <div style={{ marginBottom: "10px" }}>
            <label>Age:</label>
            <ct-input $value={age} type="number" />
          </div>
          <ct-button onClick={updateNames({ firstName, lastName })}>
            Randomize Names
          </ct-button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: "15px",
            marginBottom: "20px",
          }}
        >
          <div
            style={{
              padding: "15px",
              backgroundColor: "#f3e5f5",
              borderRadius: "5px",
            }}
          >
            <h4 style={{ margin: "0 0 10px 0" }}>computed()</h4>
            <code style={{ fontSize: "14px" }}>{computedFullName}</code>
          </div>

          <div
            style={{
              padding: "15px",
              backgroundColor: "#e8f5e9",
              borderRadius: "5px",
            }}
          >
            <h4 style={{ margin: "0 0 10px 0" }}>derive({"{}"}, fn)</h4>
            <code style={{ fontSize: "14px" }}>{deriveFullName}</code>
          </div>

          <div
            style={{
              padding: "15px",
              backgroundColor: "#fff3e0",
              borderRadius: "5px",
            }}
          >
            <h4 style={{ margin: "0 0 10px 0" }}>derive(deps, fn)</h4>
            <code style={{ fontSize: "14px" }}>{deriveWithDeps}</code>
          </div>
        </div>

        <div
          style={{
            padding: "15px",
            backgroundColor: "#fffde7",
            borderRadius: "5px",
          }}
        >
          <h4>What to observe:</h4>
          <ul>
            <li>All three values are IDENTICAL</li>
            <li>Changing any input updates ALL THREE simultaneously</li>
            <li>
              This proves computed() and derive() use the same underlying
              mechanism (lift)
            </li>
          </ul>
          <p style={{ marginTop: "10px", fontSize: "14px", color: "#666" }}>
            <strong>Framework code:</strong> computed() is implemented as{" "}
            <code>lift(fn)(undefined)</code>
          </p>
        </div>
      </div>
    ),
    firstName,
    lastName,
    age,
    computedFullName,
    deriveFullName,
    deriveWithDeps,
  };
});
