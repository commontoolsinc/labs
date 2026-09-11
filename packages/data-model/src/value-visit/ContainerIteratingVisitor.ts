import {
  type FabricArray,
  type FabricContainerValue,
  FabricInstance,
  type FabricPlainObject,
  type FabricValue,
} from "@/interface.ts";

import { BaseValueVisitor } from "./BaseValueVisitor.ts";
import {
  type BaselineVisitResult,
  type DispatchingVisitorResult,
  DO_RECURSE_KEYS_VALUES,
  DO_RECURSE_VALUES,
  DO_VISIT_SUBTYPE,
  type DomainFor,
  type LeafVisitorResult,
} from "./interface.ts";

/**
 * Visitor which handles all containers by requesting that the engine iterate
 * over their contents. Recursion is as follows:
 *
 * * `FabricArray` -- all elements.
 * * `FabricInstance` -- keys and values.
 * * `FabricPlainObject`s -- values only.
 *
 * The implementation includes a definition for all container-specific `visit()`
 * methods per the above description, and also implements no-op (empty)
 * `visited*()` methods. Every other method of the interface remains `abstract`.
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
