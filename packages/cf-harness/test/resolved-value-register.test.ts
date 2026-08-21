/**
 * Unit tests for the run's resolved-value register: what it records, the
 * forms of a value it recognizes coming back, and the placeholder it leaves.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  createHarnessResolvedValueRegister,
  MIN_SCRUBBABLE_VALUE_LENGTH,
  RESOLVED_VALUE_PLACEHOLDER,
  scrubResolvedValuesDeep,
} from "../src/contracts/resolved-value-register.ts";

describe("resolved-value-register", () => {
  describe("createHarnessResolvedValueRegister", () => {
    it("returns text unchanged while nothing is recorded", () => {
      const register = createHarnessResolvedValueRegister();
      expect(register.size).toBe(0);
      expect(register.scrub("hunter2 stays put")).toBe("hunter2 stays put");
    });

    it("replaces every occurrence of a recorded value with the placeholder", () => {
      const register = createHarnessResolvedValueRegister();
      register.record("hunter2");
      expect(register.scrub("typed hunter2 into hunter2")).toBe(
        `typed ${RESOLVED_VALUE_PLACEHOLDER} into ${RESOLVED_VALUE_PLACEHOLDER}`,
      );
      expect(register.size).toBe(1);
    });

    it("replaces the percent-encoded and form-encoded echoes of a value", () => {
      const register = createHarnessResolvedValueRegister();
      register.record("Ada Lovelace");
      expect(register.scrub("https://example.com/?q=Ada%20Lovelace")).toBe(
        `https://example.com/?q=${RESOLVED_VALUE_PLACEHOLDER}`,
      );
      expect(register.scrub("q=Ada+Lovelace")).toBe(
        `q=${RESOLVED_VALUE_PLACEHOLDER}`,
      );
    });

    it("replaces a containing value whole rather than leaving its remainder", () => {
      const register = createHarnessResolvedValueRegister();
      register.record("secret");
      register.record("supersecretary");
      expect(register.scrub("supersecretary")).toBe(
        RESOLVED_VALUE_PLACEHOLDER,
      );
    });

    it("records but never matches a value below the minimum length", () => {
      const register = createHarnessResolvedValueRegister();
      const short = "x".repeat(MIN_SCRUBBABLE_VALUE_LENGTH - 1);
      register.record(short);
      // Recorded, because the run did materialize it.
      expect(register.size).toBe(1);
      // Not matched: a substring that short is ordinary text everywhere, and
      // replacing it would blank output that never carried the value.
      expect(register.scrub(`the ${short}-axis of the exit code`)).toBe(
        `the ${short}-axis of the exit code`,
      );
    });

    it("matches a value at exactly the minimum length", () => {
      const register = createHarnessResolvedValueRegister();
      const shortest = "y".repeat(MIN_SCRUBBABLE_VALUE_LENGTH);
      register.record(shortest);
      expect(register.scrub(`typed ${shortest}`)).toBe(
        `typed ${RESOLVED_VALUE_PLACEHOLDER}`,
      );
    });

    it("ignores an empty value, which would otherwise match everywhere", () => {
      const register = createHarnessResolvedValueRegister();
      register.record("");
      expect(register.size).toBe(0);
      expect(register.scrub("nothing to hide")).toBe("nothing to hide");
    });

    it("scrubs values recorded by earlier calls, not only the latest", () => {
      const register = createHarnessResolvedValueRegister();
      register.record("first");
      register.record("second");
      expect(register.scrub("first and second")).toBe(
        `${RESOLVED_VALUE_PLACEHOLDER} and ${RESOLVED_VALUE_PLACEHOLDER}`,
      );
      expect(register.size).toBe(2);
    });
  });
});

describe("scrubResolvedValuesDeep", () => {
  it("returns the value untouched when the register is absent or empty", () => {
    const empty = createHarnessResolvedValueRegister();
    expect(scrubResolvedValuesDeep(undefined, { a: "secret" })).toEqual({
      a: "secret",
    });
    expect(scrubResolvedValuesDeep(empty, { a: "secret" })).toEqual({
      a: "secret",
    });
  });

  it("scrubs registered values out of nested strings and arrays, leaving keys alone", () => {
    const register = createHarnessResolvedValueRegister();
    register.record("hunter2");

    expect(
      scrubResolvedValuesDeep(register, {
        stdout: "typed hunter2 into the field",
        rows: ["a", "saw hunter2 again"],
        hunter2: "key too",
        nested: { deep: "hunter2" },
        count: 3,
      }),
    ).toEqual({
      stdout: `typed ${RESOLVED_VALUE_PLACEHOLDER} into the field`,
      rows: ["a", `saw ${RESOLVED_VALUE_PLACEHOLDER} again`],
      hunter2: "key too",
      nested: { deep: RESOLVED_VALUE_PLACEHOLDER },
      count: 3,
    });
  });

  it("leaves a protocol key that a materialized value happens to equal", () => {
    // A value equal to a field name is exotic; rewriting the field names of
    // every later tool output is not, so the shape of the output wins.
    const register = createHarnessResolvedValueRegister();
    register.record("status");

    expect(
      scrubResolvedValuesDeep(register, {
        status: "error",
        data: { type: "cf-harness.browser-output", status: "ok" },
      }),
    ).toEqual({
      status: "error",
      data: { type: "cf-harness.browser-output", status: "ok" },
    });
  });

  it("scrubs a value that a different tool's output carries back", () => {
    // The browser materialized the value; a skill script driving the same
    // page is what reads it back. The boundary scrub covers both.
    const register = createHarnessResolvedValueRegister();
    register.record("Ada Lovelace");

    expect(
      scrubResolvedValuesDeep(register, {
        type: "cf-harness.run-skill-script-output",
        stdout: "form field traveller=Ada%20Lovelace submitted",
        stderr: "",
      }),
    ).toEqual({
      type: "cf-harness.run-skill-script-output",
      stdout: `form field traveller=${RESOLVED_VALUE_PLACEHOLDER} submitted`,
      stderr: "",
    });
  });
});
