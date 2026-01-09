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

export default pattern(() => {
  // 1. Instantiate the pattern under test with initial state
  const subject = TestPattern({
    firstName: Cell.of("John"),
    lastName: Cell.of("Doe"),
    age: Cell.of(30),
  });

  // 2. Define test actions (handlers with void event, hardcoded test data)

  const action_change_firstName = handler<
    void,
    { firstName: Cell<string> }
  >((_event, { firstName }) => {
    firstName.set("Alice");
  })({ firstName: subject.firstName });

  const action_change_lastName = handler<
    void,
    { lastName: Cell<string> }
  >((_event, { lastName }) => {
    lastName.set("Smith");
  })({ lastName: subject.lastName });

  const action_change_age = handler<void, { age: Cell<number> }>(
    (_event, { age }) => {
      age.set(25);
    },
  )({ age: subject.age });

  const action_change_all = handler<
    void,
    { firstName: Cell<string>; lastName: Cell<string>; age: Cell<number> }
  >((_event, { firstName, lastName, age }) => {
    firstName.set("Bob");
    lastName.set("Johnson");
    age.set(42);
  })({
    firstName: subject.firstName,
    lastName: subject.lastName,
    age: subject.age,
  });

  const action_set_empty_firstName = handler<
    void,
    { firstName: Cell<string> }
  >((_event, { firstName }) => {
    firstName.set("");
  })({ firstName: subject.firstName });

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

  // 4. Return tests array - processed in order
  return {
    tests: [
      // Test 1: Initial values are identical
      assert_initial_values_identical,

      // Test 2: firstName change propagates to all three
      action_change_firstName,
      assert_firstName_change_propagates,

      // Test 3: lastName change propagates to all three
      action_change_lastName,
      assert_lastName_change_propagates,

      // Test 4: age change propagates to all three
      action_change_age,
      assert_age_change_propagates,

      // Test 5: Multiple changes propagate
      action_change_all,
      assert_all_changes_propagate,

      // Test 6: Empty string handled correctly
      action_set_empty_firstName,
      assert_empty_string_handled,
    ],
    // Expose subject for debugging when deployed as charm
    subject,
  };
});
