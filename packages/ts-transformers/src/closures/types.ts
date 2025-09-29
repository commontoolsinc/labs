import ts from "typescript";
import type { TransformationContext } from "../core/context.ts";

export interface ClosureRule {
  readonly name: string;
  transform(
    sourceFile: ts.SourceFile,
    context: TransformationContext,
    transformation: ts.TransformationContext,
  ): ts.SourceFile;
}