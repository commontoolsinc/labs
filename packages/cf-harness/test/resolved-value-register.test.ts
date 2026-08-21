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

  it("scrubs payload text fields, including nested ones, and leaves the rest", () => {
    const register = createHarnessResolvedValueRegister();
    register.record("hunter2");

    expect(
      scrubResolvedValuesDeep(register, {
        outputId: "browser:1",
        stdout: "typed hunter2 into the field",
        output: ["a", "saw hunter2 again"],
        detail: { note: "hunter2 once more" },
        path: "/tmp/hunter2.txt",
        hunter2: "key too",
        count: 3,
      }),
    ).toEqual({
      outputId: "browser:1",
      stdout: `typed ${RESOLVED_VALUE_PLACEHOLDER} into the field`,
      output: ["a", `saw ${RESOLVED_VALUE_PLACEHOLDER} again`],
      detail: { note: `${RESOLVED_VALUE_PLACEHOLDER} once more` },
      path: "/tmp/hunter2.txt",
      hunter2: "key too",
      count: 3,
    });
  });

  it("scrubs a payload text field nested inside another tool result", () => {
    const register = createHarnessResolvedValueRegister();
    register.record("hunter2");

    expect(
      scrubResolvedValuesDeep(register, {
        type: "cf-harness.subagent-return-output",
        result: { status: "ok", message: "the child saw hunter2" },
      }),
    ).toEqual({
      type: "cf-harness.subagent-return-output",
      result: {
        status: "ok",
        message: `the child saw ${RESOLVED_VALUE_PLACEHOLDER}`,
      },
    });
  });

  it("scrubs a bare string, which is payload text in whole", () => {
    const register = createHarnessResolvedValueRegister();
    register.record("hunter2");

    expect(scrubResolvedValuesDeep(register, "image at hunter2.png")).toBe(
      `image at ${RESOLVED_VALUE_PLACEHOLDER}.png`,
    );
  });

  it("leaves a protocol field a materialized value happens to spell", () => {
    // Recording "browser" must not turn `outputId: "browser:1"` into a
    // placeholder followed by `:1`: the result would no longer satisfy its
    // tool descriptor, and status/output correlation would break with it.
    const register = createHarnessResolvedValueRegister();
    register.record("browser");

    expect(
      scrubResolvedValuesDeep(register, {
        outputId: "browser:1",
        toolId: "browser",
        status: "ok",
        output: "the browser tab is open",
      }),
    ).toEqual({
      outputId: "browser:1",
      toolId: "browser",
      status: "ok",
      output: `the ${RESOLVED_VALUE_PLACEHOLDER} tab is open`,
    });
  });

  it("leaves a status a materialized value happens to spell", () => {
    const register = createHarnessResolvedValueRegister();
    register.record("error");

    expect(
      scrubResolvedValuesDeep(register, {
        status: "error",
        code: "command_failed",
        message: "the page reported an error",
      }),
    ).toEqual({
      status: "error",
      code: "command_failed",
      message: `the page reported an ${RESOLVED_VALUE_PLACEHOLDER}`,
    });
  });

  it("leaves a protocol key that a materialized value happens to equal", () => {
    // A key names a field of a protocol this code defines; rewriting one
    // changes the shape of a tool result.
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
