/**
 * Top-level `export`ed visitor functions.
 */

import { type FabricValue } from "@/interface.ts";

import {
  type BaselineVisitResult,
  type DomainFor,
  type ValueVisitor,
} from "./interface.ts";
import { VisitInProgress } from "./VisitInProgress.ts";

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
 *   `isValidFabricValue()`, anywhere an encountered value to be dispatched
 *   might turn out not to be a valid `FabricValue`, resulting in a guarantee
 *   that anything of type `FabricValue` passed to the visitor is in fact a
 *   valid `FabricValue`.
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
