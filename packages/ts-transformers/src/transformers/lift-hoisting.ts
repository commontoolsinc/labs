import ts from "typescript";
import {
  detectCallKind,
  getLiftAppliedInnerCall,
  SYNTHETIC_LIFT_HOIST_PREFIX,
} from "../ast/call-kind.ts";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";

/**
 * Phase 2 of derive→lift→selfcontained (CT-1644): hoist every reactive
 * `lift(...)` call to module scope.
 *
 * After Phase 1 (CT-1615) and SchemaInjection, every reactive lift-style
 * computation in lowered output is the schema-injected *lift-applied* shape:
 *
 * ```ts
 *   __cfHelpers.lift(argSchema, resSchema, callback)(captures).for("result", true)
 * ```
 *
 * where the inner `__cfHelpers.lift(...)` call builds the module factory and
 * the outer application supplies the captures object. This stage hoists the
 * **entire inner call** (schemas + callback) to a module-scope const and
 * rewrites the original site to apply the captures to the hoisted name:
 *
 * ```ts
 *   // module scope:
 *   const __cfLift_1 = __cfHelpers.lift(argSchema, resSchema, callback);
 *   // original site:
 *   __cfLift_1(captures).for("result", true)
 * ```
 *
 * ## Why this runs AFTER SchemaInjection
 *
 * SchemaInjection derives the lift's ARGUMENT schema from the applied captures
 * object (`call.arguments[0]` of the outer application) — the closure
 * transformer assembled that object's full type upstream. If the lift were
 * hoisted to a bare `const __cfLift_N = lift(callback)` BEFORE injection, the
 * captures object would no longer be adjacent and injection would fall back to
 * the callback's parameter type alone — which silently drops capture
 * properties in nested / multi-capture callbacks (verified regression; see
 * `session_outputs/2026-06-02_lift-hoist-phase2/02-ordering-correction.md`).
 * Running after injection means the schema is already baked into the inner
 * `lift(...)` call before we relocate it, so the hoist is schema-transparent.
 *
 * Result: every reactive computation is a named, addressable module-scope
 * const — the substrate Phase 3 wraps with `selfcontained(...)`.
 *
 * ## Why this owns lift hoisting (subsumes CT-1585 for lift)
 *
 * CT-1585's `BuilderCallbackHoistingTransformer` hoists builder *callbacks*
 * (the function argument), not the whole call, and only when the callback
 * closes solely over module-level symbols. For `lift` that mechanic is now
 * redundant and actively harmful: hoisting the call here AND the callback
 * there produces a double hoist whose two consts reference each other out of
 * declaration order (TDZ `ReferenceError` at module load). So `lift` is
 * removed from CT-1585's hoistable set; this stage is its sole owner. CT-1585
 * still owns `pattern`/`handler`/`patternTool`.
 *
 * ## Generality
 *
 * The hoist mechanic is builder-agnostic: only "which call expression is the
 * hoistable unit" and "what name prefix to bind it to" are builder-specific.
 * Those live in {@link HOISTABLE_BUILDERS}. Today only `lift` is registered;
 * when `pattern`/`handler` get the same addressed/selfcontained treatment they
 * register here too, converging CT-1585 and this stage into one hoisting phase
 * without restructuring.
 */
export class LiftHoistingTransformer extends HelpersOnlyTransformer {
  override transform(context: TransformationContext): ts.SourceFile {
    return hoistBuilderCalls(context.sourceFile, context);
  }
}

/**
 * A hoistable builder: given a visited call expression, decide whether it is
 * this builder's hoistable unit and, if so, return the inner call to relocate
 * to module scope plus the name prefix to bind it under.
 *
 * `innerCall` is the expression bound to `const <prefix>_N`. The original
 * outer call is rewritten to `<prefix>_N(...outer arguments)`, preserving any
 * surrounding member chain (e.g. the `.for(...)` tail) since that hangs off the
 * outer call node, which keeps its position.
 */
interface HoistableBuilderSpec {
  readonly prefix: string;
  readonly resolveHoistable: (
    call: ts.CallExpression,
    context: TransformationContext,
  ) => ts.CallExpression | undefined;
}

const LIFT_BUILDER: HoistableBuilderSpec = {
  prefix: SYNTHETIC_LIFT_HOIST_PREFIX,
  resolveHoistable: (call, context) => {
    // The lift-applied shape is `__cfHelpers.lift(...)(captures)`: an applied
    // call whose callee is itself the inner `lift(...)` call. detectCallKind
    // is the single source of truth for recognising it (it guards against
    // over-application chains like `lift(cb)(x)(y)`).
    if (detectCallKind(call, context.checker)?.kind !== "lift-applied") {
      return undefined;
    }
    return getLiftAppliedInnerCall(call);
  },
};

const HOISTABLE_BUILDERS: readonly HoistableBuilderSpec[] = [LIFT_BUILDER];

function hoistBuilderCalls(
  sourceFile: ts.SourceFile,
  context: TransformationContext,
): ts.SourceFile {
  const factory = context.factory;
  const hoisted: ts.Statement[] = [];

  // Per-file counters keyed by builder prefix. Explicit counters + literal
  // suffixes (NOT `factory.createUniqueName`, whose `.text` carries only the
  // bare prefix and defers suffixing to emit — breaking the identity-by-text
  // lookups later stages rely on; see SYNTHETIC_MODULE_CALLBACK_PREFIX's
  // history in module-scope-callback-hoisting.ts).
  const counters = new Map<string, number>();

  const visit: ts.Visitor = (node: ts.Node): ts.Node => {
    const visited = ts.visitEachChild(node, visit, context.tsContext);
    if (!ts.isCallExpression(visited)) {
      return visited;
    }

    for (const builder of HOISTABLE_BUILDERS) {
      const innerCall = builder.resolveHoistable(visited, context);
      if (!innerCall) {
        continue;
      }

      const next = (counters.get(builder.prefix) ?? 0) + 1;
      counters.set(builder.prefix, next);
      const name = factory.createIdentifier(`${builder.prefix}_${next}`);
      // Carry the hoisted call's identity on the synthetic call-site identifier.
      // The checker can't resolve a synthetic identifier to its const
      // initializer, so detectCallKind would otherwise fail to recognize
      // `__cfLift_N(captures)` as the lift-applied reactive origin it lowers
      // from — dropping e.g. the `.for(...)` tag ReactiveVariableFor attaches.
      // Pointing the identifier's original node at the inner lift call lets the
      // builder-kind resolver (`resolveBuilderExpressionKind`) fall back through
      // it and still classify `__cfLift_N(captures)` as lift-applied.
      ts.setOriginalNode(name, innerCall);

      // const <prefix>_N = <inner lift(...) call>;
      hoisted.push(
        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                name,
                undefined,
                undefined,
                innerCall,
              ),
            ],
            ts.NodeFlags.Const,
          ),
        ),
      );

      // Rewrite the site to apply the captures to the hoisted name. We reuse
      // the visited outer call's own node identity (updateCallExpression) so
      // any surrounding member chain — notably the `.for(...)` tail that
      // ReactiveVariableForTransformer later expects on the result — stays
      // anchored to the same position.
      return factory.updateCallExpression(
        visited,
        name,
        visited.typeArguments,
        visited.arguments,
      );
    }

    return visited;
  };

  const transformed = ts.visitNode(sourceFile, visit) as ts.SourceFile;
  if (hoisted.length === 0) {
    return transformed;
  }

  const insertAt = findHoistInsertionIndex(transformed.statements);
  return factory.updateSourceFile(transformed, [
    ...transformed.statements.slice(0, insertAt),
    ...hoisted,
    ...transformed.statements.slice(insertAt),
  ]);
}

/**
 * Insert hoisted consts immediately after the leading import declarations.
 * The hoisted lift const's initializer eagerly evaluates only self-contained
 * schema literals and constructs (does not invoke) its inline callback, so it
 * has no eager module-level identifier dependency that placement after imports
 * could leave undefined. (Verified by spike: a lift closing over a later
 * module-level `const` runs clean, because the reference lives in the
 * lazily-invoked callback body.)
 */
function findHoistInsertionIndex(
  statements: readonly ts.Statement[],
): number {
  let index = 0;
  while (
    index < statements.length && ts.isImportDeclaration(statements[index])
  ) {
    index += 1;
  }
  return index;
}
