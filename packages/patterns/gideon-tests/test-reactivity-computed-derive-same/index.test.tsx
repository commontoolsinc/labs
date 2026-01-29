/// <cts-enable />
/**
 * Test Pattern: computed() and derive() equivalence
 *
 * This test pattern validates that computed() and derive() are functionally
 * identical by verifying they produce the same values and update in lockstep.
 *
 * Pattern under test: ./index.tsx
 */
import { Cell, computed, handler, pattern } from "commontools";
import TestPattern from "./index.tsx";

// 2. Define test actions at module scope (handlers with void event, hardcoded test data)

const changeFirstName = handler<void, { firstName: Cell<string> }>(
  (_event, { firstName }) => {
    firstName.set("Alice");
  },
);

const changeLastName = handler<void, { lastName: Cell<string> }>(
  (_event, { lastName }) => {
    lastName.set("Smith");
  },
);

const changeAge = handler<void, { age: Cell<number> }>((_event, { age }) => {
  age.set(25);
});

const changeAll = handler<
  void,
  { firstName: Cell<string>; lastName: Cell<string>; age: Cell<number> }
>((_event, { firstName, lastName, age }) => {
  firstName.set("Bob");
  lastName.set("Johnson");
  age.set(42);
});

const setEmptyFirstName = handler<void, { firstName: Cell<string> }>(
  (_event, { firstName }) => {
    firstName.set("");
  },
);

export default pattern(() => {
  // 1. Instantiate the pattern under test with initial state
  const subject = TestPattern({
    firstName: Cell.of("John"),
    lastName: Cell.of("Doe"),
    age: Cell.of(30),
  });

  // Bind handlers to subject cells
  const action_change_firstName = changeFirstName({
    firstName: subject.firstName,
  });
  const action_change_lastName = changeLastName({ lastName: subject.lastName });
  const action_change_age = changeAge({ age: subject.age });
  const action_change_all = changeAll({
    firstName: subject.firstName,
    lastName: subject.lastName,
    age: subject.age,
  });
  const action_set_empty_firstName = setEmptyFirstName({
    firstName: subject.firstName,
  });

  // 3. Define assertions as Cell<boolean>

  // Initial state assertion
  const assert_initial_values_identical = computed(() => {
    const expected = "John Doe (age 30)";
    return (
      subject.computedFullName === expected &&
      subject.deriveFullName === expected &&
      subject.deriveWithDeps === expected
    );
  });

  // After firstName change
  const assert_firstName_change_propagates = computed(() => {
    const expected = "Alice Doe (age 30)";
    return (
      subject.computedFullName === expected &&
      subject.deriveFullName === expected &&
      subject.deriveWithDeps === expected
    );
  });

  // After lastName change
  const assert_lastName_change_propagates = computed(() => {
    const expected = "Alice Smith (age 30)";
    return (
      subject.computedFullName === expected &&
      subject.deriveFullName === expected &&
      subject.deriveWithDeps === expected
    );
  });

  // After age change
  const assert_age_change_propagates = computed(() => {
    const expected = "Alice Smith (age 25)";
    return (
      subject.computedFullName === expected &&
      subject.deriveFullName === expected &&
      subject.deriveWithDeps === expected
    );
  });

  // After changing all values
  const assert_all_changes_propagate = computed(() => {
    const expected = "Bob Johnson (age 42)";
    return (
      subject.computedFullName === expected &&
      subject.deriveFullName === expected &&
      subject.deriveWithDeps === expected
    );
  });

  // After setting empty firstName
  const assert_empty_string_handled = computed(() => {
    const expected = " Johnson (age 42)";
    return (
      subject.computedFullName === expected &&
      subject.deriveFullName === expected &&
      subject.deriveWithDeps === expected
    );
  });

  // 4. Return tests array - processed sequentially
  return {
    tests: [
      // Test 1: Initial values are identical
      { assertion: assert_initial_values_identical },
      // Test 2: firstName change propagates to all three
      { action: action_change_firstName },
      { assertion: assert_firstName_change_propagates },
      // Test 3: lastName change propagates to all three
      { action: action_change_lastName },
      { assertion: assert_lastName_change_propagates },
      // Test 4: age change propagates to all three
      { action: action_change_age },
      { assertion: assert_age_change_propagates },
      // Test 5: Multiple changes propagate
      { action: action_change_all },
      { assertion: assert_all_changes_propagate },
      // Test 6: Empty string handled correctly
      { action: action_set_empty_firstName },
      { assertion: assert_empty_string_handled },
    ],
    // Expose subject for debugging when deployed as piece
    subject,
  };
});
