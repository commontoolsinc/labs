import { expect } from "@std/expect";
import type { Async, Expected } from "@std/expect";
import { isRecord } from "@commontools/utils/types";

// Define MatcherContext interface since it's not exported from @std/expect
interface MatcherContext<IsAsync = false> extends Expected<IsAsync> {
  value: unknown;
  isNot: boolean;
  equal: (a: unknown, b: unknown) => boolean;
  customTesters: Array<
    (a: unknown, b: unknown, customTesters: unknown[]) => void
  >;
  customMessage: string | undefined;

  // NOTE: You also need to overrides the following typings to allow modifiers to correctly infer typing
  not: IsAsync extends true ? Async<MatcherContext<true>>
    : ExtendedExpected<false>;
  resolves: Async<MatcherContext<true>>;
  rejects: Async<MatcherContext<true>>;
}

/**
 * Strips all symbol properties from an object recursively
 */
export function stripSymbols(obj: unknown): unknown {
  if (!isRecord(obj)) return obj;

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(stripSymbols);
  }

  // Handle plain objects
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    result[key] = stripSymbols(obj[key]);
  }
  return result;
}

/**
 * Custom matchers that compare objects while ignoring symbol properties
 */
expect.extend({
  toEqualIgnoringSymbols(
    context,
    expected,
  ): { message: () => string; pass: boolean } {
    const cleanReceived = stripSymbols(context.value);
    const cleanExpected = stripSymbols(expected);

    const pass = context.equal(cleanReceived, cleanExpected);

    if (pass) {
      return {
        message: () =>
          `expected ${JSON.stringify(context.value)} not to equal ${
            JSON.stringify(expected)
          } when ignoring symbols`,
        pass: true,
      };
    } else {
      return {
        message: () => {
          const receivedStr = JSON.stringify(cleanReceived, null, 2);
          const expectedStr = JSON.stringify(cleanExpected, null, 2);
          return `expected objects to be equal when ignoring symbols\n\nExpected:\n${expectedStr}\n\nReceived:\n${receivedStr}`;
        },
        pass: false,
      };
    }
  },

  toMatchObjectIgnoringSymbols(context, expected) {
    const cleanReceived = stripSymbols(context.value);
    const cleanExpected = stripSymbols(expected);

    // Implement partial matching logic similar to toMatchObject
    const matches = (obj: unknown, subset: unknown): boolean => {
      if (subset === obj) return true;
      if (
        typeof subset !== "object" || subset === null ||
        typeof obj !== "object" || obj === null
      ) {
        return false;
      }

      for (const key in subset) {
        if (!(key in subset)) return false;
        if (!(key in obj)) return false;
        const objValue = (subset as Record<string, unknown>)[key] as unknown;
        const subsetValue = (subset as Record<string, unknown>)[key] as unknown;
        if (!context.equal(objValue, subsetValue)) {
          // For nested objects, apply partial matching
          if (
            typeof objValue === "object" && objValue !== null &&
            typeof subsetValue === "object" && subsetValue !== null
          ) {
            if (!matches(objValue, subsetValue)) return false;
          } else {
            return false;
          }
        }
      }
      return true;
    };

    const pass = matches(cleanReceived, cleanExpected);

    if (pass) {
      return {
        message: () =>
          `expected ${JSON.stringify(context.value)} not to match object ${
            JSON.stringify(expected)
          } when ignoring symbols`,
        pass: true,
      };
    } else {
      return {
        message: () => {
          const receivedStr = JSON.stringify(cleanReceived, null, 2);
          const expectedStr = JSON.stringify(cleanExpected, null, 2);
          return `expected object to match when ignoring symbols\n\nExpected subset:\n${expectedStr}\n\nReceived:\n${receivedStr}`;
        },
        pass: false,
      };
    }
  },
});

declare module "@std/expect" {
  interface Expected<IsAsync = false> {
    toEqualIgnoringSymbols(expected: unknown): void;
    toMatchObjectIgnoringSymbols(expected: unknown): void;
  }
}

// Extend the Expected interface to include our custom matchers
export interface ExtendedExpected<IsAsync = false> extends Expected<IsAsync> {
  toEqualIgnoringSymbols(expected: unknown): void;
  toMatchObjectIgnoringSymbols(expected: unknown): void;

  // Override modifiers to maintain proper typing
  not: IsAsync extends true ? Async<ExtendedExpected<true>>
    : ExtendedExpected<false>;
  resolves: Async<ExtendedExpected<true>>;
  rejects: Async<ExtendedExpected<true>>;
}
