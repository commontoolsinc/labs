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
  DO_RECURSE_VALUES,
  type DomainFor,
  type LeafVisitorResult,
} from "./interface.ts";

/**
 * Visitor which handles all containers by requesting that the engine iterate
 * over their contents. Recursion is as follows:
 *
 * * `FabricArray` -- all elements (values).
 * * `FabricInstance` -- _the_ state value (it only has the one).
 * * `FabricPlainObject`s -- values only.
 *
 * The implementation includes a definition for all container-specific `visit()`
 * methods, which all return `DO_RECURSE_VALUES` (per the above description),
 * and also implements no-op (empty) `visited*()` methods. Every other method of
 * the interface remains `abstract`.
 */
export abstract class ContainerIteratingValueVisitor<
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
    return DO_RECURSE_VALUES;
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
    return DO_RECURSE_VALUES;
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
  visitedFabricPlainObjectEntry(
    _container: FabricPlainObject,
    _key: DomainFor<DomainExtra>,
    _value: DomainFor<DomainExtra>,
  ): BaselineVisitResult<ResultType> {
    return undefined;
  }
}
