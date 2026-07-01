/**
 * Mergeable Push Validation Transformer
 *
 * Flags the read-then-mergeable-`push` shape inside a handler: a handler that
 * reads a collection (an explicit `.get()` or an iteration) and then
 * mergeable-`push`es to that same collection.
 *
 * A mergeable `push` commits as a tail-relative `append` and drops the op's own
 * array read from conflict detection so disjoint appends merge. When the
 * handler reads the collection on its own — the dedup-then-push shape — that
 * explicit read stays in the conflict set, so two concurrent appends conflict
 * and the loser retries. The intent is usually better expressed as an
 * identity-addressed `addUnique` (no retry) for a uniqueness condition, or a
 * read-modify-write `set` for other content-dependent conditions.
 *
 * The check reuses the capability analysis, which already tracks per-parameter
 * reads and the mergeable write methods. It is a warning, not an error: the
 * shape stays safe today (the kept read forces the retry), so this nudges
 * toward the better expression without failing the build.
 */
import ts from "typescript";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import { getCapabilitySummaryCallbackArgument } from "../ast/mod.ts";
import { analyzeFunctionCapabilities } from "../policy/mod.ts";

export class MergeablePushValidationTransformer extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callback = getCapabilitySummaryCallbackArgument(
          node,
          context.checker,
        );
        if (callback) {
          this.checkCallback(callback, context);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(context.sourceFile);
    return context.sourceFile;
  }

  private checkCallback(
    callback: ts.ArrowFunction | ts.FunctionExpression,
    context: TransformationContext,
  ): void {
    // One warning per collection per handler: several pushes to the same read
    // collection share a root cause, so the first push site stands for them.
    const reported = new Set<string>();
    analyzeFunctionCapabilities(callback, {
      checker: context.checker,
      typeRegistry: context.options.state?.typeRegistry,
      mergeablePushMisuseSink: (finding) => {
        const key = JSON.stringify([finding.rootName, ...finding.path]);
        if (reported.has(key)) return;
        reported.add(key);
        const label = finding.path.length > 0
          ? `'${finding.path.join(".")}'`
          : "the collection";
        context.reportDiagnostic({
          severity: "warning",
          type: "mergeable-push:read-then-push",
          message:
            `This handler both reads ${label} and mergeable-'push'es to it. ` +
            "The explicit read keeps the append in the conflict set, so it " +
            "conflicts and retries under write contention instead of merging. " +
            "For a uniqueness condition, address the element by identity with " +
            "'elementById(...)' and 'addUnique(...)' instead. For other " +
            "content-dependent conditions, use a read-modify-write 'set', and " +
            "keep any independent append in its own handler.",
          node: finding.node,
        });
      },
    });
  }
}
