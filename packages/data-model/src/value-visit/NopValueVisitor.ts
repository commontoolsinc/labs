import { type Primitive } from "@commonfabric/utils/types";

import {
  type FabricArray,
  type FabricContainerValue,
  FabricInstance,
  type FabricPlainObject,
  FabricPrimitive,
  type FabricValue,
} from "@/interface.ts";
import { type PrimitiveValueTag } from "@/value-tags.ts";

import { BaseValueVisitor } from "./BaseValueVisitor.ts";
import {
  type BaselineVisitResult,
  type DispatchingVisitorResult,
  type DomainFor,
  type LeafVisitorResult,
} from "./interface.ts";

/**
 * No-op (empty implementation) of `ValueVisitor`: Every method is implemented
 * and just returns `undefined`, except for `isDomainExtra()` which returns
 * `false` (the safe choice which also aligns with the default binding for
 * `DomainExtra`). This is meant to be a reasonable base implementation for more
 * useful visitors, not to be particularly useful by itself.
 */
export class NopValueVisitor<DomainExtra = never, ResultType = FabricValue>
  extends BaseValueVisitor<DomainExtra, ResultType> {
  /** @inheritDoc */
  isDomainExtra(_value: DomainFor<DomainExtra>): _value is DomainExtra {
    return false;
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
  visitedFabricInstance(
    _instance: FabricInstance,
    _state: FabricValue,
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
