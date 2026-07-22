/**
 * `Error.isError` survives SES lockdown (error-taming.ts).
 *
 * SES's error taming rebuilds the `Error` constructor and copies forward only
 * the stack surface, so lockdown used to leave the realm without
 * `Error.isError` entirely — host code and compartments alike. That is a
 * silent gap until something calls it, at which point classification code that
 * uses the cross-realm-correct error test (data-model's `tagFromNativeValue`,
 * for one) throws `TypeError: Error.isError is not a function`.
 *
 * Both halves matter and fail independently: repair mints a separate
 * constructor for the host realm and for compartments, and each has to carry
 * the method. The host assertions run first because they are the ones that
 * would regress if the restoration were dropped from the wrong constructor.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { tagFromNativeValue } from "@commonfabric/data-model/native-type-tags";
import {
  ensureSESLockdown,
  evaluateFunctionSourceInSES,
} from "../src/sandbox/ses-runtime.ts";

/** Post-lockdown `Error.isError`, without asserting its presence to the type. */
const hostIsError = (value: unknown): unknown =>
  (Error as { isError?: (value: unknown) => boolean }).isError?.(value);

const inSES = (expr: string): unknown =>
  evaluateFunctionSourceInSES(`(() => (${expr}))()`, { lockdown: true });

describe("Error.isError under SES lockdown", () => {
  describe("the host realm", () => {
    it("still has the method after lockdown", () => {
      ensureSESLockdown();
      expect(typeof (Error as { isError?: unknown }).isError).toBe("function");
    });

    it("recognizes errors and rejects non-errors", () => {
      ensureSESLockdown();
      expect(hostIsError(new Error("x"))).toBe(true);
      expect(hostIsError(new TypeError("x"))).toBe(true);
      expect(hostIsError({})).toBe(false);
      expect(hostIsError(null)).toBe(false);
      // The distinction that makes it more than an `instanceof` shorthand:
      // a prototype object is not itself error data.
      expect(hostIsError(Error.prototype)).toBe(false);
    });

    it("is hardened along with the rest of the intrinsics", () => {
      ensureSESLockdown();
      expect(Object.isFrozen(Error)).toBe(true);
      const descriptor = Object.getOwnPropertyDescriptor(Error, "isError");
      expect(descriptor?.writable).toBe(false);
      expect(descriptor?.configurable).toBe(false);
      expect(descriptor?.enumerable).toBe(false);
    });
  });

  describe("a compartment", () => {
    it("sees the method on its own (powerless) Error constructor", () => {
      expect(inSES(`typeof Error.isError`)).toBe("function");
    });

    it("recognizes errors it constructed itself", () => {
      expect(inSES(`Error.isError(new Error("x"))`)).toBe(true);
      expect(inSES(`Error.isError(new RangeError("x"))`)).toBe(true);
      expect(inSES(`Error.isError({ name: "Error", message: "x" })`)).toBe(
        false,
      );
    });

    it("recognizes an error handed in from the host", () => {
      // The reason to restore the genuine intrinsic rather than polyfill with
      // `instanceof`: the compartment's `Error` is not the host's, so only the
      // internal-slot test answers this correctly.
      const check = evaluateFunctionSourceInSES(
        `function (value) { return Error.isError(value); }`,
        { lockdown: true },
      ) as (value: unknown) => boolean;
      expect(check(new Error("from the host"))).toBe(true);
      expect(check({})).toBe(false);
    });
  });

  describe("the caller this shim exists for", () => {
    it("classifies a constructor-less error post-lockdown", () => {
      // data-model's `tagFromNativeValue` reaches `Error.isError` for values
      // whose constructor is unreachable, and reaches it before its other
      // fallbacks — so under lockdown the missing method turned a
      // classification into a `TypeError` thrown from deep inside conversion,
      // taking pattern setup down with it. Cross-package on purpose: only the
      // runner runs lockdown, and only data-model makes the call.
      ensureSESLockdown();
      const severed = new Error("severed");
      Object.setPrototypeOf(severed, null);
      expect(tagFromNativeValue(severed)).toBe("Error");
    });
  });
});
