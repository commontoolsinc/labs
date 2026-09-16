import { type Primitive } from "@commonfabric/utils/types";

import {
  type FabricArrayPlus,
  type FabricContainerValuePlus,
  type FabricInstancePlus,
  type FabricPlainObjectPlus,
  FabricPrimitive,
  type FabricValue,
  type FabricValuePlus,
} from "@/interface.ts";
import { toCompactDebugString } from "@/value-debug.ts";
import { type PrimitiveValueTag } from "@/types";

import {
  type BaselineVisitResult,
  type DispatchingVisitorResult,
  DO_VISIT_SUBTYPE,
  type LeafVisitorResult,
  ValueVisitor,
} from "./interface.ts";

/**
 * Base implementation of `ValueVisitor`, which implements most visitor methods
 * as `throw`ing a "shouldn't call" error, with a handful of exceptions. The point of
 * this arrangement is that many concrete visitors won't need to implement every
 * visitor method, and TypeScript doesn't let one just implement _part_ of an
 * abstract class's contract and try to call the result non-abstract. Subclasses
 * of this class _do_ get to avoid a lot of the boilerplate, but as a result
 * there may be cases where an implementer forgot about a method and only
 * discovers it through testing or at runtime and not because of the type
 * checker.
 *
 * The methods that don't just `throw` a "shouldn't call" error:
 *
 * * `isPlusType()` -- Implemented to return `false`, which is consistent with
 *   this class's default binding of `PlusType = never`.
 *
 * * `visitCycle()` -- Implemented to `throw` a "cycles not handled" error.
 *
 * * `visitFabricContainer()`, `visitValue()` -- Implemented to return
 *   `DO_VISIT_SUBTYPE`, so that concrete classes get subtype dispatched
 *   visiting by default (which is easy enough to override back to
 *   non-dispatched).
 */
export abstract class BaseValueVisitor<
  PlusType = never,
  ResultType = FabricValue,
> implements ValueVisitor<PlusType, ResultType> {
  //
  // Subclass contract
  //

  /** @inheritDoc */
  isPlusType(value: unknown): value is PlusType {
    return false;
  }

  /** @inheritDoc */
  visitCycle(
    value: FabricValuePlus<PlusType>,
    _originalDepth: number,
    _thisDepth: number,
  ): LeafVisitorResult<PlusType, ResultType> {
    this.throwNoCycles(value);
  }

  /** @inheritDoc */
  visitFabricArray(
    value: FabricArrayPlus<PlusType>,
  ): LeafVisitorResult<PlusType, ResultType> {
    this.throwShouldntCall("visitFabricArray");
  }

  /** @inheritDoc */
  visitFabricInstance(
    value: FabricInstancePlus<PlusType>,
  ): LeafVisitorResult<PlusType, ResultType> {
    this.throwShouldntCall("visitFabricInstance");
  }

  /** @inheritDoc */
  visitFabricPlainObject(
    value: FabricPlainObjectPlus<PlusType>,
  ): LeafVisitorResult<PlusType, ResultType> {
    this.throwShouldntCall("visitFabricPlainObject");
  }

  /** @inheritDoc */
  visitFabricContainer(
    value: FabricContainerValuePlus<PlusType>,
  ): DispatchingVisitorResult<PlusType, ResultType> {
    return DO_VISIT_SUBTYPE;
  }

  /** @inheritDoc */
  visitPlusType(
    value: PlusType,
  ): LeafVisitorResult<PlusType, ResultType> {
    this.throwShouldntCall("visitPlusType");
  }

  /** @inheritDoc */
  visitPrimitive(
    value: Primitive | FabricPrimitive,
    tag: PrimitiveValueTag,
  ): LeafVisitorResult<PlusType, ResultType> {
    this.throwShouldntCall("visitPrimitive");
  }

  /** @inheritDoc */
  visitValue(
    value: FabricValuePlus<PlusType>,
  ): DispatchingVisitorResult<PlusType, ResultType> {
    return DO_VISIT_SUBTYPE;
  }

  /** @inheritDoc */
  visitedFabricArrayElement(
    array: FabricArrayPlus<PlusType>,
    index: number,
    value: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType> {
    this.throwShouldntCall("visitedFabricArrayElement");
  }

  /** @inheritDoc */
  visitedFabricArrayGap(
    array: FabricArrayPlus<PlusType>,
    start: number,
    count: number,
  ): BaselineVisitResult<ResultType> {
    this.throwShouldntCall("visitedFabricArrayGap");
  }

  /** @inheritDoc */
  visitedFabricInstance(
    instance: FabricInstancePlus<PlusType>,
    state: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType> {
    this.throwShouldntCall("visitedFabricInstance");
  }

  /** @inheritDoc */
  visitedFabricPlainObjectEntry(
    container: FabricPlainObjectPlus<PlusType>,
    key: FabricValuePlus<PlusType>,
    value: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType> {
    this.throwShouldntCall("visitedFabricPlainObject");
  }

  //
  // Instance members
  //

  /**
   * Throws an error indicating that this visitor does not handle cycles.
   */
  protected throwNoCycles(value: FabricValuePlus<PlusType>): never {
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
