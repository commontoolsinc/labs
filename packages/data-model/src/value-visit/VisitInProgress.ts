import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { IndexTrackingStack } from "@commonfabric/utils/index-tracking-stack";
import { type Primitive } from "@commonfabric/utils/types";

import { codecOf, NULL_LIVE_ENVIRONMENT } from "@/codec-common/index.ts";
import { isValidDeepFrozenFabricValue } from "@/deep-freeze.ts";
import {
  type FabricArray,
  type FabricContainerValue,
  FabricInstance,
  type FabricPlainObject,
  FabricPrimitive,
  type FabricValue,
} from "@/interface.ts";
import {
  isValidFabricValue,
  isValidFabricValueLayer,
} from "@/validity-check.ts";
import { toCompactDebugString } from "@/value-debug.ts";
import {
  type FabricValueTag,
  tagFromFabricValue,
  tagFromFabricValueElseNull,
  VALUE_TAGS,
} from "@/value-tags.ts";

import {
  type BaselineVisitResult,
  type DispatchingVisitorResult,
  DO_VISIT_SUBTYPE,
  type DomainFor,
  type LeafVisitorResult,
  type RecurseForm,
  type ReplaceForm,
  type ValueVisitor,
  type VisitSubtypeForm,
} from "./interface.ts";

/**
 * Special result form used to indicate what actual value to use as the target
 * of a `visitSubtype`, based on following the `replace` chain. This is used
 * _only_ when a replacement has been made (expected to be uncommon), thereby
 * avoiding allocation for the common un-replaced `visitSubtype` cases.
 */
type VisitSubtypeOfForm<DomainExtra> = {
  readonly type: "visitSubtypeOf";
  readonly value: DomainFor<DomainExtra>;
};

/**
 * Similar to `VisitSubtypeOfForm`, but for `recurse`. Unlike that one, though,
 * this one is _always_ propagated in the engine after getting a plain `recurse`
 * result, on the theory that if we're going to iterate the one extra allocation
 * is small potatoes, and it keeps the code a wee bit simpler.
 */
type RecurseOfForm = {
  readonly type: "recurseOf";
  readonly containerTag:
    | typeof VALUE_TAGS.Array
    | typeof VALUE_TAGS.FabricInstance
    | typeof VALUE_TAGS.Object;
  readonly container: FabricContainerValue;
  readonly doKeys: boolean;
  readonly doValues: boolean;
};

/**
 * State of a visit currently in progress, along with most of the visit
 * execution machinery.
 *
 * This class is _intentionally_ omitted from the barrel `export` file for the
 * submodule.
 */
export class VisitInProgress<DomainExtra = never, ResultType = FabricValue> {
  /** Concrete visitor implementation. */
  #visitor: ValueVisitor<DomainExtra, ResultType>;

  /** Container stack of the visit currently in progress. */
  #stack = new IndexTrackingStack<DomainFor<DomainExtra>>();

  /** Indicates if a visit is now actually in-progress. */
  #inProgress = false;

  /**
   * Indicates if the value being visited is assumed to be a valid
   * `FabricValue`.
   */
  #assumeValid = false;

  /**
   * When `#assumeValid` is `false`, whether to do deep type checks (vs.
   * shallow).
   */
  #deepTypeCheck = false;

  /**
   * Constructs an instance.
   */
  constructor(visitor: ValueVisitor<DomainExtra, ResultType>) {
    this.#visitor = visitor;
  }

  //
  // Public instance members
  //

  /**
   * Visits the indicated value as a top-level operation, where the domain and
   * result type are assumed to all be known-valid `FabricValue`. This is only
   * appropriate to call when this class is instantiated with default type
   * parameters _and_ `value` can safely be assumed to be valid (either because
   * of an explicit check or by fiat).
   */
  visitFabricValue(value: FabricValue): BaselineVisitResult<ResultType> {
    return this.#mainVisit(value, true, false);
  }

  /**
   * Visits the indicated value as a top-level operation, checking every
   * encountered value to determine whether or not it is a `FabricValue`.
   * See `visitValue()` for details on the `deepTypeCheck` argument.
   */
  visit(
    value: DomainFor<DomainExtra>,
    deepTypeCheck: boolean,
  ): BaselineVisitResult<ResultType> {
    return this.#mainVisit(value, false, deepTypeCheck);
  }

  //
  // Visitor engine implementation
  //
  // This is arranged in approximately top-down fashion, to aid in readability.
  //

  /** Helper which implements most of a top-level visit. */
  #mainVisit(
    value: DomainFor<DomainExtra>,
    assumeValid: boolean,
    deepTypeCheck: boolean,
  ): BaselineVisitResult<ResultType> {
    if (this.#inProgress) {
      // This is a defense-in-depth protection against bugs in this submodule,
      // and also serves as documentation for the intended use of this class.
      throw new Error(
        "Shouldn't happen: Cannot use `VisitInProgress` for multiple concurrent top-level visits.",
      );
    }

    this.#inProgress = true;
    try {
      this.#assumeValid = assumeValid;
      this.#deepTypeCheck = deepTypeCheck;
      return this.#visitValue(value);
    } finally {
      this.#inProgress = false;
    }
  }

  /**
   * Visits a top-level value or contained sub-value.
   */
  #visitValue(value: DomainFor<DomainExtra>): BaselineVisitResult<ResultType> {
    const result = this.#visitResolvingSubtype(value);

    switch (result?.type) {
      case "mainResult":
      case undefined: {
        return result;
      }

      case "recurseOf": {
        switch (result.containerTag) {
          case VALUE_TAGS.Array: {
            return this.#iterateArray(result);
          }

          case VALUE_TAGS.FabricInstance: {
            return this.#iterateFabricInstance(result);
          }

          case VALUE_TAGS.Object: {
            return this.#iterateMap(result);
          }

          default: {
            throw new Error(
              `Shouldn't happen: Got unrecognized \`containerTag\`: \`${result.containerTag}\``,
            );
          }
        }
      }

      default: {
        // deno-coverage-ignore-start

        // This is a defense-in-depth protection against bugs in this file. The
        // above is meant to cover all declared result types, so anything else
        // is a bug, either in this method or in result production.
        const type = (result as { type: string }).type;
        throw new Error(
          `Shouldn't happen: Got result type \`${type}\` from dispatched visitor method.`,
        );
      }
        // deno-coverage-ignore-stop
    }
  }

  /**
   * Iteratively calls `visitValue()`, `visitCycle()`, and the subtype-specific
   * visitor methods, until the visitor returns something other than a `replace`
   * or `visitSubtype` result.
   *
   * **Note:** We always transform `recurse` to `recurseOf` for returning from
   * this method. See comment on the definition of `RecurseOfForm` for details.
   */
  #visitResolvingSubtype(
    value: DomainFor<DomainExtra>,
  ):
    | RecurseOfForm
    | Exclude<
      LeafVisitorResult<DomainExtra, ResultType>,
      ReplaceForm<DomainExtra>
    > {
    const vis = this.#visitor;

    for (;;) {
      const resolvedResult = this.#visitResolvingCyclesAndReplacement(value);

      switch (resolvedResult?.type) {
        case "visitSubtype": {
          // Need dispatch. `value` _has not_ been replaced.
          break;
        }

        case "visitSubtypeOf": {
          // Need dispatch. `value` _has_ been replaced.
          value = resolvedResult.value;
          break;
        }

        default: {
          // No dispatch required.
          return resolvedResult;
        }
      }

      const tag = this.#tagFromValueElseNull(value);
      let result: DispatchingVisitorResult<DomainExtra, ResultType>;

      switch (tag) {
        case VALUE_TAGS.Array: {
          const array = value as FabricArray;
          result = vis.visitFabricContainer(array);
          if (result?.type === "visitSubtype") {
            result = vis.visitFabricArray(array);
          }
          break;
        }

        case VALUE_TAGS.FabricInstance: {
          const instance = value as FabricInstance;
          result = vis.visitFabricContainer(instance);
          if (result?.type === "visitSubtype") {
            result = vis.visitFabricInstance(instance);
          }
          break;
        }

        case VALUE_TAGS.Object: {
          const object = value as FabricPlainObject;
          result = vis.visitFabricContainer(object);
          if (result?.type === "visitSubtype") {
            result = vis.visitFabricPlainObject(object);
          }
          break;
        }

        case null: {
          // `null` means that `value` was not recognized as a `FabricValue`.
          if (this.#assumeValid) {
            const desc = toCompactDebugString(value);
            throw new Error(
              `Encountered a non-\`FabricValue\` while doing an "assume valid" visit: ${desc}`,
            );
          } else if (vis.isDomainExtra(value)) {
            result = vis.visitNonFabricValue(value);
          } else {
            const desc = toCompactDebugString(value);
            throw new Error(
              `Encountered a value outside of the visitor's domain: ${desc}`,
            );
          }
          break;
        }

        default: {
          const prim = value as Primitive | FabricPrimitive;
          result = vis.visitPrimitive(prim, tag);
          break;
        }
      }

      switch (result?.type) {
        case "recurse": {
          return this.#adjustRecurseForm(result, value, tag);
        }

        case "replace": {
          value = result.value;
          break; // ...and continue to iterate.
        }

        default: {
          return result;
        }
      }
    }
  }

  /**
   * Iteratively calls `visitValue()` and `visitCycle()` on the visitor, until
   * the visitor returns something other than a `replace` result.
   */
  #visitResolvingCyclesAndReplacement(
    value: DomainFor<DomainExtra>,
  ):
    | RecurseOfForm
    | VisitSubtypeOfForm<DomainExtra>
    | Exclude<
      DispatchingVisitorResult<DomainExtra, ResultType>,
      ReplaceForm<DomainExtra> | RecurseForm
    > {
    const vis = this.#visitor;
    const origValue = value;

    for (;;) {
      const cycleAt = this.#stack.indexOf(value);
      const result = (cycleAt === -1)
        ? vis.visitValue(value)
        : vis.visitCycle(value, cycleAt, this.#stack.depth);

      switch (result?.type) {
        case "recurse": {
          return this.#adjustRecurseForm(result, value);
        }

        case "replace": {
          value = result.value;
          break;
        }

        case "visitSubtype": {
          return this.#visitSubtypeFormFor(origValue, value);
        }

        default: {
          return result;
        }
      }
    }
  }

  /**
   * Iterates over all the elements in an array, in response to a `recurse`
   * result.
   */
  #iterateArray(result: RecurseOfForm): BaselineVisitResult<ResultType> {
    const { container, doValues } = result;
    const array = container as FabricArray;
    const vis = this.#visitor;

    if (!doValues) {
      // `result` represents a no-op `recurse`. Though pointless, nothing
      // prevents a client from returning it as a visit result, so just handle
      // it gracefully here.
      return undefined;
    }

    this.#stack.push(array);

    let lastIdx = -1;
    try {
      for (const idx in array) {
        if (!isArrayIndexPropertyName(idx)) {
          throw new Error(
            `Non-index property in alleged \`FabricArray\`: \`${idx}\``,
          );
        }

        const idxNumber = Number(idx);

        if (idxNumber !== (lastIdx + 1)) {
          // There's a gap just before this element.
          const result = vis.visitedArrayGap(
            array,
            lastIdx + 1,
            idxNumber - lastIdx - 1,
          );
          if (result?.type === "mainResult") {
            return result;
          }
        }

        lastIdx = idxNumber;

        const element = array[idxNumber]!;
        const elemResult = this.#visitValue(element);
        if (elemResult?.type === "mainResult") {
          return elemResult;
        }

        // TODO(danfuzz): When we have a non-`mainResult` visit-result type,
        // we'll want to pass the result value from `elemResult` into
        // `visitedArrayElement()` and not the original `element`.
        const result = vis.visitedArrayElement(array, idxNumber, element);
        if (result?.type === "mainResult") {
          return result;
        }
      }

      if (array.length !== (lastIdx + 1)) {
        // There's a gap at the end of the array.
        const result = vis.visitedArrayGap(
          array,
          lastIdx + 1,
          array.length - lastIdx - 1,
        );
        if (result?.type === "mainResult") {
          return result;
        }
      }

      return undefined;
    } finally {
      this.#stack.popExpect(array);
    }
  }

  /**
   * Recurses on a `FabricInstance`, in response to a `recurse` result. The
   * recursion consists of a single sub-value visit, of the instance's state,
   * per its normal codec.
   */
  #iterateFabricInstance(
    result: RecurseOfForm,
  ): BaselineVisitResult<ResultType> {
    const { container, doValues } = result;
    const instance = container as FabricInstance;
    const vis = this.#visitor;

    if (!doValues) {
      // `result` represents a no-op `recurse`. Though pointless, nothing
      // prevents a client from returning it as a visit result, so just handle
      // it gracefully here.
      return undefined;
    }

    const state = codecOf(instance).encode(instance, NULL_LIVE_ENVIRONMENT);
    this.#stack.push(instance);

    try {
      const stateResult = this.#visitValue(state);
      if (stateResult?.type === "mainResult") {
        return stateResult;
      }

      // TODO(danfuzz): When we have a non-`mainResult` visit-result type, we'll
      // want to pass the result value from the visits immediately above instead
      // of the original `state`.
      const result = vis.visitedFabricInstance(instance, state);
      if (result?.type === "mainResult") {
        return result;
      }

      return undefined;
    } finally {
      this.#stack.popExpect(instance);
    }
  }

  /**
   * Iterates over all the elements in a map-like value, in response to a
   * `recurse` result.
   */
  #iterateMap(result: RecurseOfForm): BaselineVisitResult<ResultType> {
    const { container, doKeys, doValues } = result;
    const plainObj = container as FabricPlainObject;
    const vis = this.#visitor;

    if (!(doKeys || doValues)) {
      // `result` represents a no-op `recurse`. Though pointless, nothing
      // prevents a client from returning it as a visit result, so just handle
      // it gracefully here.
      return undefined;
    }

    const mappings = Object.entries(plainObj);

    this.#stack.push(plainObj);

    try {
      for (const [key, value] of mappings) {
        if (doKeys) {
          const keyResult = this.#visitValue(key);
          if (keyResult?.type === "mainResult") {
            return keyResult;
          }
        }

        if (doValues) {
          const valueResult = this.#visitValue(value);
          if (valueResult?.type === "mainResult") {
            return valueResult;
          }
        }

        // TODO(danfuzz): When we have a non-`mainResult` visit-result type,
        // we'll want to pass the result value(s) from the visits immediately
        // above instead of the original `key` and `value`.
        const result = vis.visitedMapping(plainObj, key, value);
        if (result?.type === "mainResult") {
          return result;
        }
      }

      return undefined;
    } finally {
      this.#stack.popExpect(plainObj);
    }
  }

  //
  // Utility methods
  //

  /**
   * Validates and rewrites a `recurse` form as a `recurseOf` form.
   */
  #adjustRecurseForm(
    result: RecurseForm,
    finalValue: DomainFor<DomainExtra>,
    finalValueTagIfKnown?: FabricValueTag | null,
  ): RecurseOfForm {
    const tag = (finalValueTagIfKnown === undefined)
      ? this.#tagFromValueElseNull(finalValue)
      : finalValueTagIfKnown;

    switch (tag) {
      case VALUE_TAGS.Array:
      case VALUE_TAGS.FabricInstance:
      case VALUE_TAGS.Object: {
        return {
          type: "recurseOf",
          containerTag: tag,
          container: finalValue as FabricContainerValue,
          doKeys: result.doKeys,
          doValues: result.doValues,
        };
      }
    }

    const desc = toCompactDebugString(finalValue, { backtickQuote: true });
    throw new Error(
      `Cannot use \`recurse\` result with non-container: ${desc}`,
    );
  }

  /**
   * Returns either a `visitSubtype` or `visitSubtypeOf` form as necessary,
   * based on whether the visited value is a replacement.
   */
  #visitSubtypeFormFor(
    origValue: DomainFor<DomainExtra>,
    finalValue: DomainFor<DomainExtra>,
  ):
    | VisitSubtypeForm
    | VisitSubtypeOfForm<DomainExtra> {
    if (Object.is(origValue, finalValue)) {
      return DO_VISIT_SUBTYPE;
    }

    return {
      type: "visitSubtypeOf",
      value: finalValue,
    };
  }

  /**
   * Gets the tag for the given value, in a manner which honors the
   * type-checking style indicated by the top-level `visit*()` call on this
   * instance.
   */
  #tagFromValueElseNull(value: DomainFor<DomainExtra>): FabricValueTag | null {
    if (this.#assumeValid) {
      return tagFromFabricValueElseNull(value as FabricValue);
    } else if (this.#deepTypeCheck) {
      // TODO(danfuzz): If cached, `isValidDeepFrozenFabricValue()` is faster
      // than `isValidFabricValue()`. The latter should actually sniff at the
      // frozen cache.
      const isFabricValue = isValidDeepFrozenFabricValue(value) ||
        isValidFabricValue(value);
      return isFabricValue ? tagFromFabricValue(value) : null;
    } else {
      return isValidFabricValueLayer(value)
        ? tagFromFabricValue(value as FabricValue)
        : null;
    }
  }
}
