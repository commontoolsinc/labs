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
import { type PrimitiveValueTag } from "@/types";

import { BaseValueVisitor } from "./BaseValueVisitor.ts";
import {
  type BaselineVisitResult,
  type DispatchingVisitorResult,
  type LeafVisitorResult,
} from "./interface.ts";

/**
 * No-op (empty implementation) of `ValueVisitor`: Every method is implemented
 * and just returns `undefined`, except for `isPlusType()` which returns `false`
 * (the safe choice which also aligns with the default binding for `PlusType`).
 * This is meant to be a reasonable base implementation for more useful
 * visitors, not to be particularly useful by itself.
 */
export class NopValueVisitor<PlusType = never, ResultType = FabricValue>
  extends BaseValueVisitor<PlusType, ResultType> {
  /** @inheritDoc */
  isPlusType(_value: unknown): _value is PlusType {
    return false;
  }

  /** @inheritDoc */
  visitCycle(
    _value: FabricValuePlus<PlusType>,
    _originalDepth: number,
    _thisDepth: number,
  ): LeafVisitorResult<PlusType, ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitFabricArray(
    _value: FabricArray,
  ): LeafVisitorResult<PlusType, ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitFabricInstance(
    _value: FabricInstance,
  ): LeafVisitorResult<PlusType, ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitFabricPlainObject(
    _value: FabricPlainObject,
  ): LeafVisitorResult<PlusType, ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitFabricContainer(
    _value: FabricContainerValue,
  ): DispatchingVisitorResult<PlusType, ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitPlusType(
    _value: PlusType,
  ): LeafVisitorResult<PlusType, ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitPrimitive(
    _value: Primitive | FabricPrimitive,
    _tag: PrimitiveValueTag,
  ): LeafVisitorResult<PlusType, ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitValue(
    _value: FabricValuePlus<PlusType>,
  ): DispatchingVisitorResult<PlusType, ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitedFabricArrayElement(
    _array: FabricArray,
    _index: number,
    _value: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType> {
    return undefined;
  }

  /** @inheritDoc */
  visitedFabricArrayGap(
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
  visitedFabricPlainObjectEntry(
    _container: FabricPlainObject,
    _key: FabricValuePlus<PlusType>,
    _value: FabricValuePlus<PlusType>,
  ): BaselineVisitResult<ResultType> {
    return undefined;
  }
}
