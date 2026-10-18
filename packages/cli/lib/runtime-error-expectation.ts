/**
 * What a pattern test requires of the runtime errors its run raises, the
 * descriptor's `expectRuntimeErrors`, for the single-user runner and for each
 * participant of a multi-user test.
 *
 * An expectation REQUIRES errors rather than tolerating them, so a throwing
 * refusal that reverts to a silent return fails the test: `true` requires at
 * least one, a count exactly that many, and a list of strings one error for
 * each string, the error's text containing it, in any order. A list pins what
 * each error says as well as how many there are, so an unrelated exception, or
 * a refusal giving another reason, does not stand in for the one expected.
 * The errors an expectation counts are tolerated.
 */

/** A test's `expectRuntimeErrors`, as `runtimeErrorExpectation()` reads it. */
export type RuntimeErrorExpectation = true | number | readonly string[];

/**
 * The expectation a descriptor's `expectRuntimeErrors` states: `true`, a whole
 * count, or a list of strings. Anything else, `false` included, states none.
 */
export function runtimeErrorExpectation(
  value: unknown,
): RuntimeErrorExpectation | undefined {
  if (value === true) return true;
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return [...value];
  }
  return undefined;
}

/**
 * Why the runtime errors `errors` don't meet `expected`, for a person to read,
 * or `undefined` when they do. No error at all meets no expectation. For a
 * list, each expected string claims one error that contains it, the longest
 * strings first, so a short string that also appears in a longer one's error
 * does not take that error from it.
 */
export function unmetRuntimeErrorExpectation(
  expected: RuntimeErrorExpectation,
  errors: readonly string[],
): string | undefined {
  if (expected === true) {
    return errors.length > 0
      ? undefined
      : "expected some runtime error(s), saw 0";
  }
  if (typeof expected === "number") {
    return errors.length > 0 && errors.length === expected
      ? undefined
      : `expected ${expected} runtime error(s), saw ${errors.length}`;
  }
  const unclaimed = [...errors];
  const missing: string[] = [];
  for (const text of [...expected].sort((a, b) => b.length - a.length)) {
    const at = unclaimed.findIndex((error) => error.includes(text));
    if (at === -1) missing.push(text);
    else unclaimed.splice(at, 1);
  }
  if (errors.length > 0 && missing.length === 0 && unclaimed.length === 0) {
    return undefined;
  }
  return [
    `expected ${expected.length} runtime error(s), saw ${errors.length}`,
    ...missing.map((text) => `none contains ${JSON.stringify(text)}`),
    ...unclaimed.map((error) => `unexpected: ${error.split("\n")[0]}`),
  ].join("; ");
}
