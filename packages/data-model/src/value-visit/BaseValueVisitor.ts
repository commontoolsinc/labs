import { type Primitive } from "@commonfabric/utils/types";

import {
  type FabricArray,
  type FabricContainerValue,
  FabricInstance,
  type FabricPlainObject,
  FabricPrimitive,
  type FabricValue,
} from "@/interface.ts";
import { toCompactDebugString } from "@/value-debug.ts";
import { type PrimitiveValueTag } from "@/value-tags.ts";

import {
  type BaselineVisitResult,
  type DispatchingVisitorResult,
  type DomainFor,
  type LeafVisitorResult,
  ValueVisitor,
} from "./interface.ts";

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
  abstract isDomainExtra(value: DomainFor<DomainExtra>): value is DomainExtra;

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
  abstract visitedFabricInstance(
    instance: FabricInstance,
    state: FabricValue,
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
