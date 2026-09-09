/**
 * Types and classes for visiting (a/k/a, iterating or walking over)
 * `FabricValue`s.
 */

import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { IndexTrackingStack } from "@commonfabric/utils/index-tracking-stack";
import { backtickQuote } from "@commonfabric/utils/markdown";
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
import { toDebugKindString } from "./value-debug.ts";
import { tagFromFabricValue, VALUE_TAGS, type ValueTag } from "./value-tags.ts";

/** Type for a `mainResult` form. */
type MainResultForm<ResultType> = { type: "mainResult"; value: ResultType };

/** Type for a `replace` form. */
type ReplaceForm<Domain> = { type: "replace"; value: Domain };

/**
 * Most general result of a `ValueVisitor` method that visits or enters a value.
 *
 * * `{ arrayContents: values }` -- Indicates that the given `value` should be
 *   treated as a container which contains the indicated items, in an array-ish
 *   fashion. This causes the original `value` to be considered a stacked layer
 *   of containership.
 * * `{ mainResult: value }` -- Indicates that visiting should immediately end,
 *   returning the indicated `value` to the caller.
 * * `{ mapContents: mappings }` -- Indicates that the given `value` should be
 *   treated as a container which contains the indicated items, in a map-ish
 *   fashion. This causes the original `value` to be considered a stacked layer
 *   of containership.
 * * `{ replace: value }` -- Indicates that the given replacement value should
 *   be visited instead of the given one. This does _not_ add a stacked layer of
 *   containership to the visit.
 * * `{ visitSubtype: true }` -- Indicates that a more subtype-specific visitor
 *   should be called. This result only makes sense coming from visitor methods
 *   which in fact cover multiple subtypes.
 * * `undefined` -- The visit of the given value was completed; do nothing
 *   special.
 */
export type GeneralVisitorResult<Domain, ResultType> =
  | LeafVisitorResult<Domain, ResultType>
  | { type: "visitSubtype"; value: true };

/**
 * `GeneralVisitorResult` except without the `visitSubtype` option.
 *
 * This is a "leaf" in the sense of visitor dispatch -- there is not a
 * more-specific type-based visitor method to call -- but that said, the value
 * being visited itself might or might not be a leaf in the sense of the graph
 * structure of the value.
 */
export type LeafVisitorResult<Domain, ResultType> =
  | MainVisitResult<ResultType>
  | ReplaceForm<Domain>
  | { type: "arrayContents"; value: Domain[] }
  | { type: "mapContents"; value: [Domain, Domain][] };

/**
 * Result of a value-in-container visitor, called per item while iterating.
 *
 * * `{ mainResult: value }` -- As with other result types, indicates that
 *   visiting should immediately end, returning the indicated `value` to the
 *   caller.
 * * `{ recurse: true }` -- Indicates that the value which was visited should be
 *   recursively visited.
 */
export type ContainerIterationResult<ResultType> =
  | MainVisitResult<ResultType>
  | { type: "recurse"; value: true };

/**
 * Outer result of a `visit()` call.
 */
export type MainVisitResult<ResultType> =
  | MainResultForm<ResultType>
  | undefined;

/**
 * Interface for visit receivers.
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
   * Visits the given _known-value_ `FabricArray`.
   */
  visitFabricArray(
    value: Domain & FabricArray,
  ): LeafVisitorResult<Domain, ResultType>;

  /**
   * Visits the given _known-value_ `FabricInstance`.
   */
  visitFabricInstance(
    value: Domain & FabricInstance,
  ): LeafVisitorResult<Domain, ResultType>;

  /**
   * Visits the given _known-value_ `FabricPlainObject`.
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
  visit(value: Domain): MainVisitResult<ResultType> {
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

  #visitValue(value: Domain): MainVisitResult<ResultType> {
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
  #subvisitArray(value: Domain, values: Domain[]): MainVisitResult<ResultType> {
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
    mappings: [Domain, Domain][],
  ): MainVisitResult<ResultType> {
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
 * Base class for value visiting. In addition to implementing `ValueVisitor`
 * vacuously -- all visitor methods `throw`ing -- this includes the mechanism
 * for actually visiting. Subclasses are expected to `override` whatever methods
 * are needed in the context of the actual expected visits.
 */
export class BaseValueVisitor<Domain, ResultType>
  implements ValueVisitor<Domain, ResultType> {
  //
  // Subclass contract
  //

  /** @inheritDoc */
  visitArrayContentsItem(
    _index: number,
    value: Domain,
  ): ContainerIterationResult<ResultType> {
    BaseValueVisitor.#throwMissing("visitArrayContentsItem", value);
  }

  /** @inheritDoc */
  visitCycle(
    value: Domain,
    _originalDepth: number,
    _thisDepth: number,
  ): LeafVisitorResult<Domain, ResultType> {
    BaseValueVisitor.#throwMissing("visitCycle", value);
  }

  /** @inheritDoc */
  visitFabricArray(
    value: Domain & FabricArray,
  ): LeafVisitorResult<Domain, ResultType> {
    BaseValueVisitor.#throwMissing("visitFabricArray", value);
  }

  /** @inheritDoc */
  visitFabricInstance(
    value: Domain & FabricInstance,
  ): LeafVisitorResult<Domain, ResultType> {
    BaseValueVisitor.#throwMissing("visitFabricInstance", value);
  }

  /** @inheritDoc */
  visitFabricPlainObject(
    value: Domain & FabricPlainObject,
  ): LeafVisitorResult<Domain, ResultType> {
    BaseValueVisitor.#throwMissing("visitFabricPlainObject", value);
  }

  /** @inheritDoc */
  visitFabricContainer(
    value: Domain & FabricContainerValue,
  ): GeneralVisitorResult<Domain, ResultType> {
    BaseValueVisitor.#throwMissing("visitFabricContainer", value);
  }

  /** @inheritDoc */
  visitMapContentsItem(
    _key: Domain,
    value: Domain,
  ): ContainerIterationResult<ResultType> {
    BaseValueVisitor.#throwMissing("visitMapContentsItem", value);
  }

  /** @inheritDoc */
  visitNonFabricValue(
    value: Domain,
  ): LeafVisitorResult<Domain, ResultType> {
    BaseValueVisitor.#throwMissing("visitNonFabricValue", value);
  }

  /** @inheritDoc */
  visitPrimitive(
    value: Domain & (Primitive | FabricPrimitive),
    _type: ValueTag,
  ): LeafVisitorResult<Domain, ResultType> {
    BaseValueVisitor.#throwMissing("visitPrimitive", value);
  }

  /** @inheritDoc */
  visitValue(value: Domain): MainVisitResult<ResultType> {
    BaseValueVisitor.#throwMissing("visitValue", value);
  }

  //
  // Instance members
  //

  /** Visits the indicated value. */
  visit(value: Domain): MainVisitResult<ResultType> {
    const inProgress = new VisitInProgress<Domain, ResultType>(this);
    return inProgress.visit(value);
  }

  //
  // Static members
  //

  /**
   * `Throw`s a "missing implementation" exception.
   */
  static #throwMissing(methodName: string, value: unknown): never {
    const desc = `${methodName}(${toDebugKindString(value)})`;
    throw new Error(`Missing visitor implementation: ${backtickQuote(desc)}`);
  }
}
