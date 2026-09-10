/**
 * Types and classes for visiting (a/k/a, iterating or walking over)
 * `FabricValue`s.
 */

import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { IndexTrackingStack } from "@commonfabric/utils/index-tracking-stack";
import { type Primitive } from "@commonfabric/utils/types";

import { isValidDeepFrozenFabricValue } from "./deep-freeze.ts";
import {
  FabricArray,
  FabricContainerValue,
  FabricInstance,
  FabricPlainObject,
  FabricPrimitive,
  FabricValue,
} from "./interface.ts";
import {
  isValidFabricValue,
  isValidFabricValueLayer,
} from "./validity-check.ts";
import {
  type FabricValueTag,
  type PrimitiveValueTag,
  tagFromFabricValue,
  tagFromFabricValueElseNull,
  VALUE_TAGS,
} from "./value-tags.ts";
import { toCompactDebugString } from "./value-debug.ts";

//
// Individual result form types and associated definitions
//

/** Full domain for a `ValueVisitor` class, given its `DomainExtra`. */
export type DomainFor<DomainExtra> = FabricValue | DomainExtra;

/**
 * An `iterateArray` form. This is returned by visitor methods which wish to
 * treat the value they received as a container of array-like contents. `value`
 * indicates the contents of the container, and by returning this, the engine
 * will iterate over the contents, calling
 * `ValueVisitor.visitArrayContentsItem()` on each element.
 */
export type IterateArrayForm<DomainExtra> = {
  type: "iterateArray";
  value: readonly DomainFor<DomainExtra>[];
};

/**
 * An `iterateMap` form. This is returned by visitor methods which wish to
 * treat the value they received as a container of map-like contents. `value`
 * indicates the contents of the container as `[key, value]` pairs (similar to
 * the return value from `Map.entries()` or `Object.entries()`), and by
 * returning this, the engine will iterate over the contents, calling
 * `ValueVisitor.visitMapContentsItem()` on each element.
 */
export type IterateMapForm<DomainExtra> = {
  type: "iterateMap";
  value: readonly [DomainFor<DomainExtra>, DomainFor<DomainExtra>][];
};

/**
 * A `mainResult` form. `value` is a value that is to be returned from the
 * original main (top-level) `visit()` call, and by returning this form, a
 * visitor indicates that the `visit()` should end promptly (do no further
 * sub-visits), returning this value.
 */
export type MainResultForm<ResultType> = {
  type: "mainResult";
  value: ResultType;
};

/**
 * A `recurse` form. This is returned by visitor methods which are used to
 * iterate over container contents. By returning this form, a visitor indicates
 * that the value should be visited by the engine, recursively, such that it is
 * known by the engine to be an element of the container which is being iterated
 * over.
 */
export type RecurseForm = { type: "recurse" };

/**
 * A `replace` form. `value` is a value that is to be used in place of the value
 * originally received by the visitor method which returns this. This tells the
 * visitor engine to redo visitor dispatch with the replacement (as if the
 * replacement were the value in the same position as the original).
 */
export type ReplaceForm<DomainExtra> = {
  type: "replace";
  value: DomainFor<DomainExtra>;
};

/**
 * A `visitSubtype` form. This is returned by visitor methods which cover
 * multiple possible subtype dispatches. By returning this form, a visitor
 * indicates that the engine should in fact do a subtype-based dispatch.
 */
export type VisitSubtypeForm = { type: "visitSubtype" };

/**
 * Standard instance of `RecurseForm`.
 *
 * The `DO_` prefix is intended to make it clear at use sites that it is telling
 * the visitor engine to "do" something.
 */
export const DO_RECURSE: RecurseForm = Object.freeze(
  { type: "recurse" } as const,
);

/**
 * Standard instance of `VisitSubtypeForm`.
 *
 * The `DO_` prefix is intended to make it clear at use sites that it is telling
 * the visitor engine to "do" something.
 */
export const DO_VISIT_SUBTYPE: VisitSubtypeForm = Object.freeze(
  { type: "visitSubtype" } as const,
);

/**
 * Constructs an `iterateArray` form.
 *
 * The `do` prefix is intended to make it clear at use sites that it is telling
 * the visitor engine to "do" something.
 */
export function doIterateArray<DomainExtra>(
  values: readonly DomainFor<DomainExtra>[],
): IterateArrayForm<DomainExtra> {
  return { type: "iterateArray", value: values };
}

/**
 * Constructs an `iterateMap` form.
 *
 * The `do` prefix is intended to make it clear at use sites that it is telling
 * the visitor engine to "do" something.
 */
export function doIterateMap<DomainExtra>(
  mappings: readonly [DomainFor<DomainExtra>, DomainFor<DomainExtra>][],
): IterateMapForm<DomainExtra> {
  return { type: "iterateMap", value: mappings };
}

//
// `visit*()` method result union types
//

/**
 * Baseline possible results from arbitrary `visit*()` calls, defining the
 * result cases common to all of these methods.
 *
 * See the included result types for details on what they mean. As for
 * `undefined`, if a visitor returns it in the context of this type, it means
 * that the visit of the given value was completed; the visitor engine will not
 * process it further, and there is no specific value to return from (this part
 * of) the visit.
 */
export type BaselineVisitResult<ResultType = FabricValue> =
  | MainResultForm<ResultType>
  | undefined;

/**
 * Possible results from a value-in-container visitor method, that is, methods
 * which are called per container element as part of an iteration.
 *
 * See the included result types for details on what they mean.
 */
export type ContainerIterationResult<ResultType = FabricValue> =
  | BaselineVisitResult<ResultType>
  | RecurseForm;

/**
 * Possible results from a visitor method which covers two or more subtypes of
 * value that the visitor engine can dispatch to.
 *
 * See the included result types for details on what they mean.
 */
export type DispatchingVisitorResult<
  DomainExtra = never,
  ResultType = FabricValue,
> =
  | LeafVisitorResult<DomainExtra, ResultType>
  | VisitSubtypeForm;

/**
 * Possible results from a visitor method which accepts leaf (non-container)
 * values when not _directly_ being the subject of an iteration.
 *
 * This is a "leaf" in the sense of visitor dispatch -- there is not a
 * more-specific subtype-based visitor method to call -- but that said, the
 * value being visited itself might or might not be a leaf in the sense of the
 * graph structure of the value.
 *
 * See the included result types for details on what they mean.
 */
export type LeafVisitorResult<DomainExtra = never, ResultType = FabricValue> =
  | BaselineVisitResult<ResultType>
  | ReplaceForm<DomainExtra>
  | IterateArrayForm<DomainExtra>
  | IterateMapForm<DomainExtra>;

//
// Visitor interface and exported implementations thereof
//

/**
 * Interface for visit receivers.
 *
 * Each `visit*()` method accepts a `value` of the (parametric) `Domain` type,
 * in some cases along with other arguments, and returns a structured result or
 * `undefined`, which indicates what the visitor engine should do next.
 * Different methods are allowed to return different subsets of the full
 * complement of possible results (see their declarations for more detail). Each
 * structured result type is documented as to its meaning.
 *
 * The value domain of visitors always includes `FabricValue`, and the
 * `DomainExtra` type parameter is available to selectively include another type
 * (possibly itself compound) as an additional option.
 */
export interface ValueVisitor<DomainExtra = never, ResultType = FabricValue> {
  /**
   * Visits an item from an `iterateArray` result.
   */
  visitArrayContentsItem(
    index: number,
    value: DomainFor<DomainExtra>,
  ): ContainerIterationResult<ResultType>;

  /**
   * Visits a value which is already in the process of being visited. The
   * visitor engine calls this method _before_ calling `visitValue()` when the
   * value to be visited is already in the middle of being visited as a
   * container.
   */
  visitCycle(
    /** Value to visit. */
    value: DomainFor<DomainExtra>,
    /** Depth at which `value` was originally encountered. */
    originalDepth: number,
    /** Depth of the current visit. */
    thisDepth: number,
  ): LeafVisitorResult<DomainExtra, ResultType>;

  /**
   * Visits the given `FabricArray`.
   */
  visitFabricArray(
    value: FabricArray,
  ): LeafVisitorResult<DomainExtra, ResultType>;

  /**
   * Visits the given `FabricInstance`.
   */
  visitFabricInstance(
    value: FabricInstance,
  ): LeafVisitorResult<DomainExtra, ResultType>;

  /**
   * Visits the given `FabricPlainObject`.
   */
  visitFabricPlainObject(
    value: FabricPlainObject,
  ): LeafVisitorResult<DomainExtra, ResultType>;

  /**
   * Visits the given `FabricContainerValue`. If this returns type
   * `visitSubtype`, then the visitor system will call one of
   * `visitFabricArray()`, `visitFabricInstance()`, or
   * `visitFabricPlainObject()`.
   */
  visitFabricContainer(
    value: FabricContainerValue,
  ): DispatchingVisitorResult<DomainExtra, ResultType>;

  /**
   * Visits an item from an `iterateMap` result.
   */
  visitMapContentsItem(
    key: DomainFor<DomainExtra>,
    value: DomainFor<DomainExtra>,
  ): ContainerIterationResult<ResultType>;

  /**
   * Visits a value determined to _not_ be a valid `FabricValue`.
   *
   * **Note:** When this visitor is called using a function that allows for
   * non-`FabricValue`s, the visitor engine will call this method on an
   * ostensible `FabricValue` that did not pass its type check.
   */
  visitNonFabricValue(
    value: DomainExtra,
  ): LeafVisitorResult<DomainExtra, ResultType>;

  /**
   * Visits the given primitive value, which can be either a native JavaScript
   * primitive or a `FabricPrimitive`.
   */
  visitPrimitive(
    value: Primitive | FabricPrimitive,
    type: PrimitiveValueTag,
  ): LeafVisitorResult<DomainExtra, ResultType>;

  /**
   * Visits the given arbitrary value. If this returns type `visitSubtype`, then
   * the visitor system will call one of `visitFabricContainer()`,
   * `visitNonFabricValue()`, or `visitPrimitive()`.
   */
  visitValue(
    value: DomainFor<DomainExtra>,
  ): DispatchingVisitorResult<DomainExtra, ResultType>;
}

/**
 * Base implementation of `ValueVisitor`, which leaves all visitor methods
 * `abstract` and includes `protected` helper methods.
 */
export abstract class BaseValueVisitor<
  DomainExtra = never,
  ResultType = FabricValue,
> implements ValueVisitor<DomainExtra, ResultType> {
  //
  // Subclass contract
  //

  /** @inheritDoc */
  abstract visitArrayContentsItem(
    index: number,
    value: DomainFor<DomainExtra>,
  ): ContainerIterationResult<ResultType>;

  /** @inheritDoc */
  abstract visitCycle(
    value: DomainFor<DomainExtra>,
    originalDepth: number,
    thisDepth: number,
  ): LeafVisitorResult<DomainExtra, ResultType>;

  /** @inheritDoc */
  abstract visitFabricArray(
    value: FabricArray,
  ): LeafVisitorResult<DomainExtra, ResultType>;

  /** @inheritDoc */
  abstract visitFabricInstance(
    value: FabricInstance,
  ): LeafVisitorResult<DomainExtra, ResultType>;

  /** @inheritDoc */
  abstract visitFabricPlainObject(
    value: FabricPlainObject,
  ): LeafVisitorResult<DomainExtra, ResultType>;

  /** @inheritDoc */
  abstract visitFabricContainer(
    value: FabricContainerValue,
  ): DispatchingVisitorResult<DomainExtra, ResultType>;

  /** @inheritDoc */
  abstract visitMapContentsItem(
    key: DomainFor<DomainExtra>,
    value: DomainFor<DomainExtra>,
  ): ContainerIterationResult<ResultType>;

  /** @inheritDoc */
  abstract visitNonFabricValue(
    value: DomainExtra,
  ): LeafVisitorResult<DomainExtra, ResultType>;

  /** @inheritDoc */
  abstract visitPrimitive(
    value: Primitive | FabricPrimitive,
    type: PrimitiveValueTag,
  ): LeafVisitorResult<DomainExtra, ResultType>;

  /** @inheritDoc */
  abstract visitValue(
    value: DomainFor<DomainExtra>,
  ): DispatchingVisitorResult<DomainExtra, ResultType>;

  //
  // Instance members
  //

  /**
   * Throws an error indicating that this visitor does not handle cycles.
   */
  protected throwNoCycles(value: DomainFor<DomainExtra>): never {
    const desc = toCompactDebugString(value, { backtickQuote: true });
    throw new Error(`Cannot visit cyclic value: ${desc}`);
  }
}

/**
 * Empty implementation of `ValueVisitor`: Every method is implemented and just
 * returns `undefined`. This is meant to be a reasonable base class for more
 * useful visitors, not to be particularly useful by itself.
 */
export class EmptyValueVisitor<DomainExtra = never, ResultType = FabricValue>
  extends BaseValueVisitor<DomainExtra, ResultType> {
  /** @inheritDoc */
  visitArrayContentsItem(
    _index: number,
    _value: DomainFor<DomainExtra>,
  ): ContainerIterationResult<ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitCycle(
    _value: DomainFor<DomainExtra>,
    _originalDepth: number,
    _thisDepth: number,
  ): LeafVisitorResult<DomainExtra, ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitFabricArray(
    _value: FabricArray,
  ): LeafVisitorResult<DomainExtra, ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitFabricInstance(
    _value: FabricInstance,
  ): LeafVisitorResult<DomainExtra, ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitFabricPlainObject(
    _value: FabricPlainObject,
  ): LeafVisitorResult<DomainExtra, ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitFabricContainer(
    _value: FabricContainerValue,
  ): DispatchingVisitorResult<DomainExtra, ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitMapContentsItem(
    _key: DomainFor<DomainExtra>,
    _value: DomainFor<DomainExtra>,
  ): ContainerIterationResult<ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitNonFabricValue(
    _value: DomainExtra,
  ): LeafVisitorResult<DomainExtra, ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitPrimitive(
    _value: Primitive | FabricPrimitive,
    _type: PrimitiveValueTag,
  ): LeafVisitorResult<DomainExtra, ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitValue(
    _value: DomainFor<DomainExtra>,
  ): DispatchingVisitorResult<DomainExtra, ResultType> {
    return undefined;
  }
}

/**
 * Visitor which handles all containers by requesting that the engine iterate
 * over their contents. This class leaves all non-container `visit*()` methods
 * `abstract`.
 */
export abstract class ContainerIteratingVisitor<
  DomainExtra = never,
  ResultType = FabricValue,
> extends BaseValueVisitor<DomainExtra, ResultType> {
  /** @inheritDoc */
  visitFabricArray(
    value: FabricArray,
  ): LeafVisitorResult<DomainExtra, ResultType> {
    return doIterateArray<DomainExtra>(value);
  }

  /** @inheritDoc */
  visitFabricInstance(
    _value: FabricInstance,
  ): LeafVisitorResult<DomainExtra, ResultType> {
    // TODO(danfuzz): This is where we finally need to sort out `FabricInstance`
    // iteration.
    throw new Error("`FabricInstance` not yet visitable");
  }

  /** @inheritDoc */
  visitFabricPlainObject(
    value: FabricPlainObject,
  ): LeafVisitorResult<DomainExtra, ResultType> {
    return doIterateMap<DomainExtra>(Object.entries(value));
  }

  /** @inheritDoc */
  visitFabricContainer(
    _value: FabricContainerValue,
  ): DispatchingVisitorResult<DomainExtra, ResultType> {
    return DO_VISIT_SUBTYPE;
  }
}

//
// Visitor engine
//

/**
 * Special result form used to indicate what actual value to use as the target
 * of a `visitSubtype`, based on following the `replace` chain. This is used
 * _only_ when a replacement has been made (expected to be uncommon), thereby
 * avoiding allocation for the common un-replaced `visitSubtype` cases.
 */
type VisitSubtypeOfForm<DomainExtra> =
  { type: "visitSubtypeOf", value: DomainFor<DomainExtra> };

/**
 * State of a visit currently in progress, along with most of the visit
 * execution machinery.
 */
class VisitInProgress<DomainExtra = never, ResultType = FabricValue> {
  /** Concrete visitor implementation. */
  #visitor: ValueVisitor<DomainExtra, ResultType>;

  /** Container stack of the visit currently in progress. */
  #stack = new IndexTrackingStack<DomainFor<DomainExtra>>();

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
  // Instance members
  //

  /**
   * Visits the indicated value as a top-level operation, where the domain and
   * result type are assumed to all be known-valid `FabricValue`. This is only
   * appropriate to call when this class is instantiated with default type
   * parameters _and_ `value` can safely be assumed to be valid (either because
   * of an explicit check or by fiat).
   */
  visitFabricValue(value: FabricValue): BaselineVisitResult<ResultType> {
    this.#assumeValid = true;
    this.#deepTypeCheck = false;
    return this.#mainVisit(value);
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
    this.#assumeValid = false;
    this.#deepTypeCheck = deepTypeCheck;
    return this.#mainVisit(value);
  }

  /** Helper which implements most of a top-level visit. */
  #mainVisit(value: DomainFor<DomainExtra>): BaselineVisitResult<ResultType> {
    if (this.#stack.depth !== 0) {
      // deno-coverage-ignore-start

      // This is a defense-in-depth protection against bugs in this file, and
      // also serves as documentation for the intended use of this class.
      throw new Error(
        "Shouldn't happen: Cannot use `VisitInProgress` for multiple concurrent top-level visits.",
      );
    }
    // deno-coverage-ignore-stop

    const result = this.#visitValue(value);

    if (result === undefined) {
      return undefined;
    } else if (result.type === "mainResult") {
      return result;
    } else {
      throw new Error(
        `Shouldn't happen: Got result type \`${result.type}\` from top-level visit.`,
      );
    }
  }

  /**
   * Visit a top-level value or contained sub-value.
   */
  #visitValue(value: DomainFor<DomainExtra>): BaselineVisitResult<ResultType> {
    const result = this.#visitResolvingSubtype(value);

    if (result === undefined) {
      return result;
    }

    switch (result.type) {
      case "iterateArray": {
        return this.#subvisitArray(value, result.value);
      }

      case "mainResult": {
        return result;
      }

      case "iterateMap": {
        return this.#subvisitMap(value, result.value);
      }
    }
  }

  /**
   * Visits the items in an `iterateArray` result, recursing or returning as
   * directed by `ValueVisitor.visitArrayContentsItem()`.
   */
  #subvisitArray(
    value: DomainFor<DomainExtra>,
    values: readonly DomainFor<DomainExtra>[],
  ): BaselineVisitResult<ResultType> {
    const vis = this.#visitor;

    this.#stack.push(value);

    try {
      for (const idx in values) {
        if (!isArrayIndexPropertyName(idx)) {
          throw new Error("Improper array returned in `iterateArray` result.");
        }

        const idxNumber = Number(idx);
        const item = values[idxNumber]!;
        const result = vis.visitArrayContentsItem(idxNumber, item);

        if (result !== undefined) {
          switch (result.type) {
            case "mainResult": {
              return result;
            }
            case "recurse": {
              const recurseResult = this.#visitValue(item);
              if (recurseResult?.type === "mainResult") {
                return recurseResult;
              }
            }
          }
        }
      }

      return undefined;
    } finally {
      this.#stack.popExpect(value);
    }
  }

  /**
   * Visits the items in an `iterateMap` result, recursing or returning as
   * directed by `ValueVisitor.visitMapContentsItem()`.
   */
  #subvisitMap(
    value: DomainFor<DomainExtra>,
    mappings: readonly [DomainFor<DomainExtra>, DomainFor<DomainExtra>][],
  ): BaselineVisitResult<ResultType> {
    const vis = this.#visitor;

    this.#stack.push(value);

    try {
      for (const [key, item] of mappings) {
        const result = vis.visitMapContentsItem(key, item);

        if (result !== undefined) {
          switch (result.type) {
            case "mainResult": {
              return result;
            }
            case "recurse": {
              const recurseResult = this.#visitValue(item);
              if (recurseResult?.type === "mainResult") {
                return recurseResult;
              }
            }
          }
        }
      }
    } finally {
      this.#stack.popExpect(value);
    }
  }

  /**
   * Iteratively call `visitValue()` and `visitCycle()` on the visitor, until
   * the visitor returns something other than a `replace` result.
   */
  #visitResolvingCyclesAndReplacement(
    value: DomainFor<DomainExtra>,
  ): VisitSubtypeOfForm<DomainExtra> | Exclude<
    DispatchingVisitorResult<DomainExtra, ResultType>,
    ReplaceForm<DomainExtra>
  > {
    const vis = this.#visitor;
    let resultValue = value;

    for (;;) {
      const cycleAt = this.#stack.indexOf(resultValue);
      const result = (cycleAt === -1)
        ? vis.visitValue(resultValue)
        : vis.visitCycle(resultValue, cycleAt, this.#stack.depth);

      switch(result?.type) {
        case "replace": {
          resultValue = result.value;
          break;
        }

        case "visitSubtype": {
          return (value === resultValue)
            ? result
            : { type: "visitSubtypeOf", value: resultValue };
        }

        default: {
          return result;
        }
      }
    }
  }

  /**
   * Iteratively call `visitValue()`, `visitCycle()`, and the subtype-specific
   * visitor methods, until the visitor returns something other than a `replace`
   * or `visitSubtype` result.
   */
  #visitResolvingSubtype(
    value: DomainFor<DomainExtra>,
  ): Exclude<
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
      let result;

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
          }
          result = vis.visitNonFabricValue(value as DomainExtra);
          break;
        }

        default: {
          const prim = value as Primitive | FabricPrimitive;
          result = vis.visitPrimitive(prim, tag);
          break;
        }
      }

      if (result?.type !== "replace") {
        return result;
      }

      value = result.value;
    }
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

//
// Exported functions
//

/**
 * Performs a one-off visit of a value with a visitor, where the value is
 * assumed to be a valid `FabricValue` and where the full domain of the visit is
 * exactly `FabricValue`.
 */
export function visitFabricValue<ResultType = FabricValue>(
  value: FabricValue,
  visitor: ValueVisitor<never, ResultType>,
): BaselineVisitResult<ResultType> {
  const inProgress = new VisitInProgress(visitor);
  return inProgress.visitFabricValue(value);
}

/**
 * Creates a visitor function bound to the given visitor. The result is a
 * single-argument `visit(value)` function.
 */
export function makeVisitFabricValueFunction<ResultType = FabricValue>(
  visitor: ValueVisitor<never, ResultType>,
): (value: FabricValue) => BaselineVisitResult<ResultType> {
  return (value: FabricValue) => visitFabricValue(value, visitor);
}

/**
 * Performs a one-off visit of a value with a visitor, using runtime type checks
 * to determine whether or not an encountered value is a `FabricValue`.
 *
 * Type checking can be performed either as a deep-validity check or a shallow
 * "shape of value" check:
 *
 * * The shallow check is a fast single-layer check and considers all arrays to
 *   be `FabricArray`s and all plain objects to be `FabricPlainObject`s.
 *
 * * The deep check performs a full-depth validity check anywhere an encountered
 *   value to be dispatched might turn out not to be a valid `FabricValue`,
 *   resulting in a guarantee that anything of type `FabricValue` passed to the
 *   visitor is in fact a valid `FabricValue`.
 *
 * This can incur significant performance overhead. As a worst-case, it can
 * result in O(N^2) checks on the number of values in the graph of the top-level
 * value being visited. _If this turns out to be a problem in practice,_ this
 * will become an active area of optimization.
 */
export function visitValue<DomainExtra, ResultType>(
  value: NoInfer<DomainFor<DomainExtra>>,
  visitor: ValueVisitor<DomainExtra, ResultType>,
  deepTypeCheck: boolean = false,
): BaselineVisitResult<ResultType> {
  const inProgress = new VisitInProgress<DomainExtra, ResultType>(visitor);
  return inProgress.visit(value, deepTypeCheck);
}

/**
 * Creates a visitor function bound to the given visitor. The result is a
 * single-argument `visit(value)` function.
 *
 * See `visitValue()` for details on the `deepTypeCheck` argument.
 */
export function makeVisitValueFunction<DomainExtra, ResultType>(
  visitor: ValueVisitor<DomainExtra, ResultType>,
  deepTypeCheck: boolean = false,
): (value: DomainFor<DomainExtra>) => BaselineVisitResult<ResultType> {
  return (value: DomainFor<DomainExtra>) =>
    visitValue(value, visitor, deepTypeCheck);
}
