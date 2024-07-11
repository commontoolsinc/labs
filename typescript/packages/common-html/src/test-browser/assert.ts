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

export const throws = (run: () => void, message = "") => {
  try {
    run();
  } catch (e) {
    return;
  }
  throw new AssertionError({
    message
  });
};