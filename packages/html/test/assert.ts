import { isRecord } from "@commontools/utils/types";

export class AssertionError<A, E> extends Error {
  actual: A | undefined;
  expected: E | undefined;

  constructor({
    message,
    actual = undefined,
    expected = undefined,
  }: {
    message: string;
    actual?: A | undefined;
    expected?: E | undefined;
  }) {
    super(message);
    this.name = "AssertionError";
    this.actual = actual;
    this.expected = expected;
  }
}

export const assert = (condition: boolean, message = "") => {
  if (!condition) {
    throw new AssertionError({
      message,
      actual: false,
      expected: true,
    });
  }
};

export const equal = (actual: unknown, expected: unknown, message = "") => {
  if (actual !== expected) {
    throw new AssertionError({
      message,
      actual,
      expected,
    });
  }
};

export const matchObject = (
  actual: unknown,
  expected: unknown,
  message = "",
) => {
  if (!isRecord(actual) || !isRecord(expected)) {
    throw new AssertionError({
      message: message || "Both arguments must be objects",
      actual,
      expected,
    });
  }

  try {
    for (const key in expected) {
      if (!(key in actual)) {
        throw new AssertionError({
          message: message || `Missing expected property: ${key}`,
          actual,
          expected,
        });
      }

      if (isRecord(expected[key]) && isRecord(actual[key])) {
        // Recursively check nested objects
        matchObject(actual[key], expected[key], message);
      } else if (actual[key] !== expected[key]) {
        throw new AssertionError({
          message: message || `Property ${key} does not match`,
          actual: actual[key],
          expected: expected[key],
        });
      }
    }
  } catch (error) {
    if (error instanceof AssertionError) {
      throw error;
    }
    throw new AssertionError({
      message: message || "Comparison failed",
      actual,
      expected,
    });
  }
};

export const throws = (run: () => void, message = "") => {
  try {
    run();
  } catch (e) {
    return;
  }
  throw new AssertionError({
    message,
  });
};
