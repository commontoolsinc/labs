/**
 * Top-level `export`ed visitor functions.
 */

import type { FabricValuePlus } from "@/interface.ts";

import type { BaselineVisitResult, ValueVisitor } from "./interface.ts";
import { VisitInProgress } from "./VisitInProgress.ts";

/**
 * Performs a one-off visit of a value, with the given visitor.
 */
export function visitValue<PlusType, ResultType>(
  value: NoInfer<FabricValuePlus<PlusType>>,
  visitor: ValueVisitor<PlusType, ResultType>,
): BaselineVisitResult<ResultType> {
  const inProgress = new VisitInProgress<PlusType, ResultType>(visitor);
  return inProgress.visit(value);
}

/**
 * Creates a visitor function bound to the given visitor. The result is a
 * single-argument `visit(value)` function.
 */
export function makeVisitValueFunction<PlusType, ResultType>(
  visitor: ValueVisitor<PlusType, ResultType>,
): (value: FabricValuePlus<PlusType>) => BaselineVisitResult<ResultType> {
  return (value: FabricValuePlus<PlusType>) => visitValue(value, visitor);
}
