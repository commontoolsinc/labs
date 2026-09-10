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
import { isValidFabricValue } from "./validity-check.ts";
import { tagFromFabricValue, VALUE_TAGS, type ValueTag } from "./value-tags.ts";

/**
 * An `arrayContents` form. This is returned by visitor methods which wish to
 * treat the value they received as a container of array-like contents. `value`
 * indicates the contents of the container, and by returning this, the engine
 * will iterate over the contents, calling
 * `ValueVisitor.visitArrayContentsItem()` on each element.
 */
export type ArrayContentsForm<Domain> =
  { type: "arrayContents"; value: readonly Domain[] };

/**
 * A `mainResult` form. `value` is a value that is to be returned from the
 * original main (top-level) `visit()` call, and by returning this form, a
 * visitor indicates that the `visit()` should end promptly (do no further
 * sub-visits), returning this value.
 */
export type MainResultForm<ResultType> =
  { type: "mainResult"; value: ResultType };

/**
  * A `mapContents` form. This is returned by visitor methods which wish to
  * treat the value they received as a container of map-like contents. `value`
  * indicates the contents of the container as `[key, value]` pairs (similar to
  * the return value from `Map.entries()` or `Object.entries()`), and by
  * returning this, the engine will iterate over the contents, calling
  * `ValueVisitor.visitMapContentsItem()` on each element.
  */
export type MapContentsForm<Domain> =
  { type: "mapContents"; value: readonly [Domain, Domain][] };

/**
 * A `recurse` form. This is returned by visitor methods which are used to
 * iterate over container contents. By returning this form, a visitor indicates
 * that the value should be visited by the engine, recursively, such that it is
 * known by the engine to be an element of the container which is being iterated
 * over.
 */
export type RecurseForm = { type: "recurse"; value: true };

/**
 * A `replace` form. `value` is a value that is to be used in place of the value
 * originally received by the visitor method which returns this. This tells the
 * visitor engine to redo visitor dispatch with the replacement (as if the
 * replacement were the value in the same posistion as the original).
 */
export type ReplaceForm<Domain> = { type: "replace"; value: Domain };

/**
 * A `visitSubtype` form. This is returned by visitor methods which cover
 * multiple possible subtype dispatches. By returning this form, a visitor
 * indicates that the engine should in fact do a subtype-based dispatch.
 */
export type VisitSubtypeForm = { type: "visitSubtype"; value: true };

/**
 * Possible results from a visitor method which covers two or more subtypes of
 * value that the visitor engine can dispatch to.
 *
 * See the included result types for details on what they mean.
 */
export type GeneralVisitorResult<Domain, ResultType> =
  | LeafVisitorResult<Domain, ResultType>
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
export type LeafVisitorResult<Domain, ResultType> =
  | BaselineVisitResult<ResultType>
  | ReplaceForm<Domain>
  | ArrayContentsForm<Domain>
  | MapContentsForm<Domain>;

/**
 * Possible results from a value-in-container visitor method, that is, methods
 * which are called per container element as part of an iteration.
 *
 * See the included result types for details on what they mean.
 */
export type ContainerIterationResult<ResultType> =
  | BaselineVisitResult<ResultType>
  | RecurseForm;

/**
 * Baseline possible results from arbitrary `visit*()` calls, defining the
 * result cases common to all of these methods.
 *
 * See the included result types for details on what they mean. As for
 * `undefined`, if a visitor returns it in the context of this type, it means
 * that the visit of the given value was completed; the visitor ngine will not
 * process it further, and there is no specific value to return from (this part
 * of) the visit.
 */
export type BaselineVisitResult<ResultType> =
  | MainResultForm<ResultType>
  | undefined;

/**
 * Interface for visit receivers.
 *
 * Each `visit*()` method accepts a `value` of the (parametric) `Domain` type,
 * in some cases along with other arguments, and returns a structured result or
 * `undefined`, which indicates what the visitor engine should do next.
 * Different methods are allowed to return different subsets of the full
 * complement of possible results (see their declarations for more detail). Each
 * structured result type is documented as to its meaning.
 */
export interface ValueVisitor<Domain = FabricValue, ResultType = FabricValue> {
  /**
   * Visits an item from an `arrayContents` result.
   */
  visitArrayContentsItem(
    index: number,
    value: Domain,
  ): ContainerIterationResult<ResultType>;

  /**
   * Visits a value which is already in the process of being visited.
   */
  visitCycle(
    /** Value to visit. */
    value: Domain,
    /** Depth at which `value` was originally encountered. */
    originalDepth: number,
    /** Depth of the current visit. */
    thisDepth: number,
  ): LeafVisitorResult<Domain, ResultType>;

  /**
   * Visits the given _known-valid_ `FabricArray`.
   */
  visitFabricArray(
    value: Domain & FabricArray,
  ): LeafVisitorResult<Domain, ResultType>;

  /**
   * Visits the given _known-valid_ `FabricInstance`.
   */
  visitFabricInstance(
    value: Domain & FabricInstance,
  ): LeafVisitorResult<Domain, ResultType>;

  /**
   * Visits the given _known-valid_ `FabricPlainObject`.
   */
  visitFabricPlainObject(
    value: Domain & FabricPlainObject,
  ): LeafVisitorResult<Domain, ResultType>;

  /**
   * Visits the given _known-valid_ `FabricContainerValue`. If this returns type
   * `visitSubtype`, then the visitor system will call one of
   * `visitFabricArray()`, `visitFabricInstance()`, or
   * `visitFabricPlainObject()`.
   */
  visitFabricContainer(
    value: Domain & FabricContainerValue,
  ): GeneralVisitorResult<Domain, ResultType>;

  /**
   * Visits an item from a `mapContents` result.
   */
  visitMapContentsItem(
    key: Domain,
    value: Domain,
  ): ContainerIterationResult<ResultType>;

  /**
   * Visits a value determined to _not_ be a valid `FabricValue`.
   */
  visitNonFabricValue(
    value: Domain,
  ): LeafVisitorResult<Domain, ResultType>;

  /**
   * Visits the given primitive value, which can be either a native JavaScript
   * primitve or a `FabricPrimitive`.
   */
  visitPrimitive(
    value: Domain & (Primitive | FabricPrimitive),
    type: ValueTag,
  ): LeafVisitorResult<Domain, ResultType>;

  /**
   * Visits the given arbitrary value. If this returns type `visitSubtype`, then
   * the visitor system will call one of `visitFabricContainer()`,
   * `visitNonFabricValue()`, or `visitPrimitive()`.
   */
  visitValue(value: Domain): GeneralVisitorResult<Domain, ResultType>;
}

/**
 * State of a visit currently in progress, along with most of the visit
 * execution machinery.
 */
class VisitInProgress<Domain, ResultType> {
  /** Concrete visitor implementation. */
  #visitor: ValueVisitor<Domain, ResultType>;

  /** Container stack of the visit currently in progress. */
  #stack = new IndexTrackingStack<Domain>();

  /**
   * Indicates if the value being visited is known to be a valid `FabricValue`.
   * This is used to avoid re-checking during the visit.
   */
  #knownValid = false;

  /**
   * Constructs an instance.
   */
  constructor(visitor: ValueVisitor<Domain, ResultType>) {
    this.#visitor = visitor;
  }

  //
  // Instance members
  //

  /** Visits the indicated value as a top-level operation. */
  visit(value: Domain): BaselineVisitResult<ResultType> {
    if (this.#stack.depth !== 0) {
      throw new Error(
        "Cannot use `VisitInProgress` for multiple concurrent top-level visits.",
      );
    }

    this.#knownValid = false; // Because it's read by the next call.
    this.#knownValid = this.#isValidFabricValue(value);

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

  #visitValue(value: Domain): BaselineVisitResult<ResultType> {
    const result = this.#visitResolvingSubtype(value);

    if (result === undefined) {
      return result;
    }

    switch (result.type) {
      case "arrayContents": {
        return this.#subvisitArray(value, result.value);
      }

      case "mainResult": {
        return result;
      }

      case "mapContents": {
        return this.#subvisitMap(value, result.value);
      }
    }
  }

  /**
   * Visits the items in an `arrayContents` result, recursing or returning as
   * directed by `ValueVisitor.visitArrayContentsItem()`.
   */
  #subvisitArray(value: Domain, values: readonly Domain[]): BaselineVisitResult<ResultType> {
    const vis = this.#visitor;

    this.#stack.push(value);

    try {
      for (const idx in values) {
        if (!isArrayIndexPropertyName(idx)) {
          throw new Error("Improper array returned in `arrayContents` result.");
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
   * Visits the items in an `mapContents` result, recursing or returning as
   * directed by `ValueVisitor.visitMapContentsItem()`.
   */
  #subvisitMap(
    value: Domain,
    mappings: readonly [Domain, Domain][],
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
    value: Domain,
  ): Exclude<GeneralVisitorResult<Domain, ResultType>, ReplaceForm<Domain>> {
    const vis = this.#visitor;

    for (;;) {
      const cycleAt = this.#stack.indexOf(value);
      const result = (cycleAt === -1)
        ? vis.visitValue(value)
        : vis.visitCycle(value, cycleAt, this.#stack.depth);

      if (result?.type === "replace") {
        value = result.value;
      } else {
        return result;
      }
    }
  }

  /**
   * Iteratively call `visitValue()`, `visitCycle()`, and the subtype-specific
   * visitor methods, until the vistor returns something other than a `replace`
   * or `subType` result.
   */
  #visitResolvingSubtype(
    value: Domain,
  ): Exclude<LeafVisitorResult<Domain, ResultType>, ReplaceForm<Domain>> {
    const vis = this.#visitor;

    for (;;) {
      let result: GeneralVisitorResult<Domain, ResultType> = this
        .#visitResolvingCyclesAndReplacement(value);

      if (result?.type !== "visitSubtype") {
        return result;
      }

      if (this.#isValidFabricValue(value)) {
        const tag = tagFromFabricValue(value);
        switch (tag) {
          case VALUE_TAGS.Array: {
            const array = value as (Domain & FabricArray);
            result = vis.visitFabricContainer(array);
            if (result?.type === "visitSubtype") {
              result = vis.visitFabricArray(array);
            }
            break;
          }

          case VALUE_TAGS.FabricInstance: {
            const instance = value as (Domain & FabricInstance);
            result = vis.visitFabricContainer(instance);
            if (result?.type === "visitSubtype") {
              result = vis.visitFabricInstance(instance);
            }
            break;
          }

          case VALUE_TAGS.Object: {
            const object = value as (Domain & FabricPlainObject);
            result = vis.visitFabricContainer(object);
            if (result?.type === "visitSubtype") {
              result = vis.visitFabricPlainObject(object);
            }
            break;
          }

          default: {
            const prim = value as (Domain & (Primitive | FabricPrimitive));
            result = vis.visitPrimitive(prim, tag);
          }
        }
      } else {
        result = vis.visitNonFabricValue(value);
      }

      if (result?.type !== "replace") {
        return result;
      }

      value = result.value;
    }
  }

  /**
   * Indicates whether or not the given value is a valid `FabricValue`.
   *
   * TODO(danfuzz): If cached, `isValidDeepFrozenFabricValue()` is faster than
   * `isValidFabricValue()`. The latter should actually sniff at the frozen
   * cache.
   */
  #isValidFabricValue(value: unknown): value is FabricValue {
    return this.#knownValid ||
      isValidDeepFrozenFabricValue(value) ||
      isValidFabricValue(value);
  }
}

/**
 * Performs a one-off visit of a value with a visitor.
 */
export function visitValue<Domain, ResultType>(
  value: Domain,
  visitor: ValueVisitor<Domain, ResultType>,
): BaselineVisitResult<ResultType> {
  const inProgress = new VisitInProgress<Domain, ResultType>(visitor);
  return inProgress.visit(value);
}

/**
 * Creates a visitor function bound to the given visitor. The result is a
 * single-argument `visit(value)` function.
 */
export function makeVisitFunction<Domain, ResultType>(
  visitor: ValueVisitor<Domain, ResultType>,
): (value: Domain) => BaselineVisitResult<ResultType> {
  return (value: Domain) => visitValue(value, visitor);
}
