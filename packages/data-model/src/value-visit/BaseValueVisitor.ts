import { type Primitive } from "@commonfabric/utils/types";

import {
  type FabricArray,
  type FabricContainerValue,
  FabricInstance,
  type FabricPlainObject,
  FabricPrimitive,
  type FabricValue,
  type FabricValuePlus,
} from "@/interface.ts";
import { toCompactDebugString } from "@/value-debug.ts";
import { type PrimitiveValueTag } from "@/types";

import {
  type BaselineVisitResult,
  type DispatchingVisitorResult,
  type LeafVisitorResult,
  ValueVisitor,
} from "./interface.ts";

/**
 * Base implementation of `ValueVisitor`, which leaves all visitor methods
 * `abstract` and includes `protected` helper methods.
 */
export abstract class BaseValueVisitor<
  PlusType = never,
  ResultType = FabricValue,
> implements ValueVisitor<PlusType, ResultType> {
  //
  // Subclass contract
  //

  /** @inheritDoc */
  abstract isPlusType(value: unknown): value is PlusType;

  /** @inheritDoc */
  abstract visitCycle(
    value: FabricValuePlus<PlusType>,
    originalDepth: number,
    thisDepth: number,
  ): LeafVisitorResult<PlusType, ResultType>;

  /** @inheritDoc */
  abstract visitFabricArray(
    value: FabricArray,
  ): LeafVisitorResult<PlusType, ResultType>;

  /** @inheritDoc */
  abstract visitFabricInstance(
    value: FabricInstance,
  ): LeafVisitorResult<PlusType, ResultType>;

  /** @inheritDoc */
  abstract visitFabricPlainObject(
    value: FabricPlainObject,
  ): LeafVisitorResult<PlusType, ResultType>;

  /** @inheritDoc */
  abstract visitFabricContainer(
    value: FabricContainerValue,
  ): DispatchingVisitorResult<PlusType, ResultType>;

  /** @inheritDoc */
  abstract visitPlusType(
    value: PlusType,
  ): LeafVisitorResult<PlusType, ResultType>;

  /** @inheritDoc */
  abstract visitPrimitive(
    value: Primitive | FabricPrimitive,
    tag: PrimitiveValueTag,
  ): LeafVisitorResult<PlusType, ResultType>;

  /** @inheritDoc */
  abstract visitValue(
    value: FabricValuePlus<PlusType>,
  ): DispatchingVisitorResult<PlusType, ResultType>;

  /** @inheritDoc */
  abstract visitedFabricArrayElement(
    array: FabricArray,
    index: number,
    value: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType>;

  /** @inheritDoc */
  abstract visitedFabricArrayGap(
    array: FabricArray,
    start: number,
    count: number,
  ): BaselineVisitResult<ResultType>;

  /** @inheritDoc */
  abstract visitedFabricInstance(
    instance: FabricInstance,
    state: FabricValue,
  ): BaselineVisitResult<ResultType>;

  /** @inheritDoc */
  abstract visitedFabricPlainObjectEntry(
    container: FabricPlainObject,
    key: FabricValuePlus<PlusType>,
    value: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType>;

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
