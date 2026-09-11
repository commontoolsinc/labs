/**
 * Types and classes for visiting (a/k/a, iterating or walking over)
 * `FabricValue`s.
 *
 * As with the `data-model` in general, the visitor engine uses `Object.is()`
 * comparisons (or equivalent) to determine value-sameness. This means that `0`
 * and `-0` are considered distinct, and that `NaN` is equal to itself.
 *
 * **IMPORTANT NOTE:** This file is a work-in-progress and not meant to be used
 * outside of the `data-model`. This is why it is _not_ exposed via the
 * `data-model`'s export map.
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
 * A `recurse` form. This is returned by visitor methods which visit containers.
 * This tells the visitor engine that it should recursively visit the contents
 * of the container, such that each visited item is known by the engine to be
 * contained by the container which is being iterated over. The two `boolean`
 * properties indicate whether the container's keys and/or values are to be
 * recursed over. `doKeys` is ignored in a context where there is no key.
 *
 * If a visitor returns an instance of this type which (implicitly) references a
 * non-container, that situation is detected at runtime and results in a
 * `throw`n error.
 *
 * **Note:** The visit calls per-mapping are specifically in key-then-value
 * order, and if the result of visiting a key is a `mainResult`, then that ends
 * the iteration before the corresponding value is visited.
 *
 * **Note:** It is technically possible to define a no-op instance of this type,
 * which is the equivalent to returning `undefined`. This is pointless, but it
 * is not prevented.
 */
export type RecurseForm = {
  type: "recurse";
  doKeys: boolean;
  doValues: boolean;
};

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
 * Standard instance of `RecurseForm` for recursing over keys and values. This
 * is only meaningful for recursing over mappings.
 *
 * The `DO_` prefix is intended to make it clear at use sites that it is telling
 * the visitor engine to "do" something.
 */
export const DO_RECURSE_KEYS_VALUES: RecurseForm = Object.freeze(
  { type: "recurse", doKeys: true, doValues: true } as const,
);

/**
 * Standard instance of `RecurseForm` for recursing over keys only. This is only
 * meaningful for recursing over mappings.
 *
 * The `DO_` prefix is intended to make it clear at use sites that it is telling
 * the visitor engine to "do" something.
 */
export const DO_RECURSE_KEYS: RecurseForm = Object.freeze(
  { type: "recurse", doKeys: true, doValues: false } as const,
);

/**
 * Standard instance of `RecurseForm` for recursing over values only. This
 * includes array elements and mapping values.
 *
 * The `DO_` prefix is intended to make it clear at use sites that it is telling
 * the visitor engine to "do" something.
 */
export const DO_RECURSE_VALUES: RecurseForm = Object.freeze(
  { type: "recurse", doKeys: false, doValues: true } as const,
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
 * Possible results from a `visit*()` method which accepts leaf (non-dispatched)
 * values. This includes the `recurse` form, which is only valid to return when
 * the value being visited is in fact a container; this constraint is checked at
 * runtime and results in a `throw`n error when violated.
 *
 * About the name: This is a "leaf" in the sense of visitor dispatch -- there is
 * not a more-specific subtype-based visitor method to call -- but that said,
 * the value being visited itself might or might not be a leaf in the sense of
 * the graph structure of the value.
 *
 * See the included result types for details on what they mean.
 */
export type LeafVisitorResult<DomainExtra = never, ResultType = FabricValue> =
  | BaselineVisitResult<ResultType>
  | RecurseForm
  | ReplaceForm<DomainExtra>;

/**
 * Possible results from a visitor method which covers two or more subtypes of
 * value that the visitor engine can dispatch to. Such a method is also allowed
 * to take a non-dispatch action, and so all of the `LeafVisitorResults` are
 * included as options with this type.
 *
 * See the included result types for details on what they mean.
 */
export type DispatchingVisitorResult<
  DomainExtra = never,
  ResultType = FabricValue,
> =
  | LeafVisitorResult<DomainExtra, ResultType>
  | VisitSubtypeForm;

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
    tag: PrimitiveValueTag,
  ): LeafVisitorResult<DomainExtra, ResultType>;

  /**
   * Visits the given arbitrary value. If this returns type `visitSubtype`, then
   * the visitor system will call one of `visitFabricContainer()`,
   * `visitNonFabricValue()`, or `visitPrimitive()`.
   */
  visitValue(
    value: DomainFor<DomainExtra>,
  ): DispatchingVisitorResult<DomainExtra, ResultType>;

  /**
   * Indicates that an array element was just visited. This method is called as
   * a result of the visitor returning a `recurse` result for a visited array
   * and is called _after_ the element itself was directly visited.
   */
  visitedArrayElement(
    array: FabricArray,
    index: number,
    value: DomainFor<DomainExtra>,
  ): BaselineVisitResult<ResultType>;

  /**
   * Indicates that an array gap (one or more holes) was just nominally visited.
   * This method is called as a result of the visitor returning a `recurse`
   * result for a visited array and is called during iteration as gaps are
   * encountered. The sequencing of this call is meant to mirror
   * `visitedArrayElement()`, but since there is nothing to recurse on (it's a
   * gap, not any actual values), there is no regular `visitValue()` call which
   * immediately precedes it (hence the visit was "nominal"). `start` is the
   * start index of the gap (integer `>= 0`), and `count` is the number of holes
   * in the gap (integer `>= 1`). This method is called as a result of the
   * visitor returning a `recurse` result for a visited array.
   */
  visitedArrayGap(
    array: FabricArray,
    start: number,
    count: number,
  ): BaselineVisitResult<ResultType>;

  /**
   * Indicates that a container mapping was just visited. This method is called
   * as a result of the visitor returning a `recurse` result for a visited
   * container and is called _after_ the mapping itself was directly visited.
   */
  visitedMapping(
    container: FabricPlainObject | FabricInstance,
    key: DomainFor<DomainExtra>,
    value: DomainFor<DomainExtra>,
  ): BaselineVisitResult<ResultType>;
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
  abstract visitNonFabricValue(
    value: DomainExtra,
  ): LeafVisitorResult<DomainExtra, ResultType>;

  /** @inheritDoc */
  abstract visitPrimitive(
    value: Primitive | FabricPrimitive,
    tag: PrimitiveValueTag,
  ): LeafVisitorResult<DomainExtra, ResultType>;

  /** @inheritDoc */
  abstract visitValue(
    value: DomainFor<DomainExtra>,
  ): DispatchingVisitorResult<DomainExtra, ResultType>;

  /** @inheritDoc */
  abstract visitedArrayElement(
    array: FabricArray,
    index: number,
    value: DomainFor<DomainExtra>,
  ): BaselineVisitResult<ResultType>;

  /** @inheritDoc */
  abstract visitedArrayGap(
    array: FabricArray,
    start: number,
    count: number,
  ): BaselineVisitResult<ResultType>;

  /** @inheritDoc */
  abstract visitedMapping(
    container: FabricPlainObject | FabricInstance,
    key: DomainFor<DomainExtra>,
    value: DomainFor<DomainExtra>,
  ): BaselineVisitResult<ResultType>;

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

  /**
   * Throws a "shouldn't happen" error, indicating a particular method should
   * not have been called.
   */
  protected throwShouldntCall(methodName: string): never {
    const desc = `\`${methodName}()\``;
    const thisDesc = toCompactDebugString(this, { backtickQuote: true });
    throw new Error(`Shouldn't happen: ${desc} called on ${thisDesc}`);
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
  visitNonFabricValue(
    _value: DomainExtra,
  ): LeafVisitorResult<DomainExtra, ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitPrimitive(
    _value: Primitive | FabricPrimitive,
    _tag: PrimitiveValueTag,
  ): LeafVisitorResult<DomainExtra, ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitValue(
    _value: DomainFor<DomainExtra>,
  ): DispatchingVisitorResult<DomainExtra, ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitedArrayElement(
    _array: FabricArray,
    _index: number,
    _value: DomainFor<DomainExtra>,
  ): BaselineVisitResult<ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitedArrayGap(
    _array: FabricArray,
    _start: number,
    _count: number,
  ): BaselineVisitResult<ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitedMapping(
    _container: FabricPlainObject | FabricInstance,
    _key: DomainFor<DomainExtra>,
    _value: DomainFor<DomainExtra>,
  ): BaselineVisitResult<ResultType> {
    return undefined;
  }
}

/**
 * Visitor which handles all containers by requesting that the engine iterate
 * over their contents. This class leaves all non-container `visit*()` methods
 * `abstract`, and implements no-op (empty) `visited*()` methods. Recursion is
 * as follows:
 *
 * * `FabricArray` -- all elements.
 * * `FabricInstance` -- keys and values.
 * * `FabricPlainObject`s -- values only.
 */
export abstract class ContainerIteratingVisitor<
  DomainExtra = never,
  ResultType = FabricValue,
> extends BaseValueVisitor<DomainExtra, ResultType> {
  //
  // Instance members
  //

  /** @inheritDoc */
  visitFabricArray(
    _value: FabricArray,
  ): LeafVisitorResult<DomainExtra, ResultType> {
    return DO_RECURSE_VALUES;
  }

  /** @inheritDoc */
  visitFabricInstance(
    _value: FabricInstance,
  ): LeafVisitorResult<DomainExtra, ResultType> {
    return DO_RECURSE_KEYS_VALUES;
  }

  /** @inheritDoc */
  visitFabricPlainObject(
    _value: FabricPlainObject,
  ): LeafVisitorResult<DomainExtra, ResultType> {
    return DO_RECURSE_VALUES;
  }

  /** @inheritDoc */
  visitFabricContainer(
    _value: FabricContainerValue,
  ): DispatchingVisitorResult<DomainExtra, ResultType> {
    return DO_VISIT_SUBTYPE;
  }

  /** @inheritDoc */
  visitedArrayElement(
    _array: FabricArray,
    _index: number,
    _value: DomainFor<DomainExtra>,
  ): BaselineVisitResult<ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitedArrayGap(
    _array: FabricArray,
    _start: number,
    _count: number,
  ): BaselineVisitResult<ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitedMapping(
    _container: FabricPlainObject | FabricInstance,
    _key: DomainFor<DomainExtra>,
    _value: DomainFor<DomainExtra>,
  ): BaselineVisitResult<ResultType> {
    return undefined;
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
type VisitSubtypeOfForm<DomainExtra> = {
  type: "visitSubtypeOf";
  value: DomainFor<DomainExtra>;
};

/**
 * Similar to `VisitSubtypeOfForm`, but for `recurse`. Unlike that one, though,
 * this one is _always_ propagated in the engine after getting a plain `recurse`
 * result, on the theory that if we're going to iterate the one extra allocation
 * is small potatoes, and it keeps the code a wee bit simpler.
 */
type RecurseOfForm = {
  type: "recurseOf";
  containerTag:
    | typeof VALUE_TAGS.Array
    | typeof VALUE_TAGS.FabricInstance
    | typeof VALUE_TAGS.Object;
  container: FabricContainerValue;
  doKeys: boolean;
  doValues: boolean;
};

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

  //
  // Visitor engine implementation
  //
  // This is arranged in approximately top-down fashion, to aid in readability.
  //

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

    return this.#visitValue(value);
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
        return (result.containerTag === VALUE_TAGS.Array)
          ? this.#iterateArray(result)
          : this.#iterateMap(result);
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
   * Iterates over all the elements in a map-like value, in response to a
   * `recurse` result.
   */
  #iterateMap(result: RecurseOfForm): BaselineVisitResult<ResultType> {
    const { container: looseTypedContainer, containerTag, doKeys, doValues } =
      result;
    const container =
      looseTypedContainer as (FabricInstance | FabricPlainObject);
    const vis = this.#visitor;

    if (!(doKeys || doValues)) {
      // `result` represents a no-op `recurse`. Though pointless, nothing
      // prevents a client from returning it as a visit result, so just handle
      // it gracefully here.
      return undefined;
    }

    const mappings = (containerTag === VALUE_TAGS.Object)
      ? Object.entries(container)
      : (() => {
        // TODO(danfuzz): This is where we finally need to sort out
        // `FabricInstance` iteration.
        throw new Error("`FabricInstance` not yet visitable");
      })();

    this.#stack.push(container);

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
        const result = vis.visitedMapping(container, key, value);
        if (result?.type === "mainResult") {
          return result;
        }
      }

      return undefined;
    } finally {
      this.#stack.popExpect(container);
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
 * * The shallow check is a fast single-layer check based on
 *   `isValidFabricValueLayer()`, see which for details.
 *
 * * The deep check performs a full-depth validity check, based on
 *   `isValidFabricValue()`, anywhere an encountered value to be dispatched might
 *   turn out not to be a valid `FabricValue`, resulting in a guarantee that
 *   anything of type `FabricValue` passed to the visitor is in fact a valid
 *   `FabricValue`.
 *
 *   This can incur significant performance overhead. As a worst-case, it can
 *   result in O(N^2) checks on the number of values in the graph of the
 *   top-level value being visited. _If this turns out to be a problem in
 *   practice,_ this will become an active area of optimization.
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
