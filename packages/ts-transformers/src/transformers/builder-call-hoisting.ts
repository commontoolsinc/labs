import ts from "typescript";
import {
  detectCallKind,
  getHandlerAppliedInnerCall,
  getLiftAppliedInnerCall,
  getWithPatternHoistablePatternCall,
  isHandlerAppliedCall,
  SYNTHETIC_HANDLER_HOIST_PREFIX,
  SYNTHETIC_LIFT_HOIST_PREFIX,
  SYNTHETIC_PATTERN_HOIST_PREFIX,
} from "../ast/call-kind.ts";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";

/**
 * Hoist every reactive *builder call* to module scope: `lift` (CT-1644, Phase 2
 * of derive→lift→selfcontained), then `handler` and `pattern` (CT-1655). Each
 * becomes a named, addressable, eventually-selfcontainable module-scope const —
 * the substrate Phase 3 wraps with `selfcontained(...)`. (Formerly named
 * `LiftHoistingTransformer` / `lift-hoisting.ts`, when it only owned lift.)
 *
 * The hoist mechanic differs by builder shape; see {@link HOISTABLE_BUILDERS}.
 * For the original lift case: after Phase 1 (CT-1615) and SchemaInjection, every
 * reactive lift-style computation in lowered output is the schema-injected
 * *lift-applied* shape:
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
 * closes solely over module-level symbols. For `lift` (CT-1644) and `handler`
 * (CT-1655) that mechanic is now redundant and actively harmful: hoisting the
 * call here AND the callback there produces a double hoist whose two consts
 * reference each other out of declaration order (TDZ `ReferenceError` at module
 * load). So `lift` and `handler` are removed from CT-1585's hoistable set; this
 * stage is their sole owner. CT-1585 still owns `pattern`/`patternTool`.
 *
 * ## Generality
 *
 * The hoist mechanic is builder-agnostic: only "which call expression is the
 * hoistable unit" and "what name prefix to bind it to" are builder-specific.
 * Those live in {@link HOISTABLE_BUILDERS}. Today `lift` and `handler` are
 * registered (both the single-application `builder(...)(captures)` shape); when
 * `pattern`/`patternTool` get the same addressed/selfcontained treatment they
 * register here too, converging CT-1585 and this stage into one hoisting phase
 * without restructuring.
 */
export class BuilderCallHoistingTransformer extends HelpersOnlyTransformer {
  override transform(context: TransformationContext): ts.SourceFile {
    return hoistBuilderCalls(context.sourceFile, context);
  }
}

/**
 * A hoistable builder: given a visited call expression, decide whether it is
 * this builder's hoistable unit and, if so, return the inner call to relocate
 * to module scope plus the name prefix to bind it under.
 *
 * `innerCall` is the expression bound to `const <prefix>_N`. How the original
 * site is rewritten to reference that name depends on the builder shape:
 *
 *   - **Applied builders** (`lift`/`handler`): the visited call IS the inner
 *     call applied to captures — `inner(captures)`. The default rewrite swaps
 *     the callee for the hoisted name, leaving the captures arguments and any
 *     surrounding member chain (e.g. the `.for(...)` tail) anchored in place.
 *   - **Argument-position builders** (`pattern`/`patternTool`): the visited
 *     call is the *enclosing* `mapWithPattern` call and the inner pattern call
 *     sits in one of its arguments. The default callee-swap is wrong here — the
 *     callee (`.mapWithPattern`) and the other arguments must survive untouched.
 *     Such builders provide {@link rewriteSite} to replace just the argument
 *     that held the inner call with the hoisted name.
 */
interface HoistableBuilderSpec {
  readonly prefix: string;
  readonly resolveHoistable: (
    call: ts.CallExpression,
    context: TransformationContext,
  ) => ts.CallExpression | undefined;
  /**
   * Optional: produce the replacement for the visited site once the inner call
   * has been hoisted to `hoistedName`. Omit for applied builders, which take
   * the default callee-swap. Provide it when the inner call sits in an argument
   * position (the visited call is an enclosing call whose callee must survive).
   */
  readonly rewriteSite?: (
    visited: ts.CallExpression,
    hoistedName: ts.Identifier,
    innerCall: ts.CallExpression,
    factory: ts.NodeFactory,
  ) => ts.Expression;
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

const HANDLER_BUILDER: HoistableBuilderSpec = {
  prefix: SYNTHETIC_HANDLER_HOIST_PREFIX,
  resolveHoistable: (call, context) => {
    // The handler-applied shape is
    // `__cfHelpers.handler(eventSchema, stateSchema, cb)(captures)` —
    // structurally the same single-application unit as lift, so the same hoist
    // mechanic applies: relocate the inner `handler(...)` call, leave
    // `__cfHandler_N(captures)` at the site (the `.for(...)` tail stays
    // anchored on the outer call). Unlike lift this is NOT a `lift-applied`
    // CallKind — `isHandlerAppliedCall` recognises it while keeping the applied
    // call classifying as `{ kind: "builder", builderName: "handler" }`, so
    // handler-specific downstream dispatchers are untouched (CT-1655).
    if (!isHandlerAppliedCall(call, context.checker)) {
      return undefined;
    }
    return getHandlerAppliedInnerCall(call);
  },
};

const PATTERN_BUILDER: HoistableBuilderSpec = {
  prefix: SYNTHETIC_PATTERN_HOIST_PREFIX,
  resolveHoistable: (call, context) => {
    // Pattern is NOT applied: the bare `__cfHelpers.pattern(cb, inSchema,
    // outSchema)` call sits in the FIRST argument of an enclosing
    // `receiver.mapWithPattern(pattern(...), { params })` call (per-instance
    // captures flow through the params object, the second argument). The
    // visited node here is the `*WithPattern` call; the hoistable unit is its
    // first argument. Because captures live in the params object, the bare
    // pattern call is capture-free and safe to relocate to module scope.
    return getWithPatternHoistablePatternCall(call, context.checker);
  },
  rewriteSite: (visited, hoistedName, _innerCall, factory) => {
    // Replace ONLY the first argument (the pattern call) with the hoisted name,
    // keeping the `.mapWithPattern` callee and the trailing params argument(s)
    // intact. (Applied builders take the default callee-swap instead.)
    return factory.updateCallExpression(
      visited,
      visited.expression,
      visited.typeArguments,
      [hoistedName, ...visited.arguments.slice(1)],
    );
  },
};

const HOISTABLE_BUILDERS: readonly HoistableBuilderSpec[] = [
  LIFT_BUILDER,
  HANDLER_BUILDER,
  PATTERN_BUILDER,
];

function hoistBuilderCalls(
  sourceFile: ts.SourceFile,
  context: TransformationContext,
): ts.SourceFile {
  const factory = context.factory;

  // Hoisted consts produced while visiting the CURRENT top-level statement.
  // They are flushed immediately before that statement (see below), not pooled
  // into a single after-imports block. This keeps each hoisted const *after*
  // every module-scoped binding declared in an earlier top-level statement —
  // which the original use site necessarily followed, since you cannot
  // reference a binding before its declaration in valid source. That ordering
  // matters because `pattern(...)` INVOKES its callback eagerly at construction
  // (unlike `lift`/`handler`, whose callbacks are stored and run lazily): a
  // hoisted `const __cfPattern_N = pattern(cb)` whose `cb` reads a later
  // module-scoped `const onRemoveFavorite = handler(...)` would otherwise throw
  // a module-load TDZ `ReferenceError`. (Verified against
  // patterns/system/favorites-manager.tsx; the after-imports placement that is
  // safe for lift/handler is NOT safe for pattern.)
  let pendingHoists: ts.Statement[] = [];

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
      pendingHoists.push(
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

      // Rewrite the site to reference the hoisted name. Applied builders take
      // the default callee-swap: reuse the visited outer call's own node
      // identity (updateCallExpression) so any surrounding member chain —
      // notably the `.for(...)` tail that ReactiveVariableForTransformer later
      // expects on the result — stays anchored to the same position.
      // Argument-position builders (pattern/patternTool) override via
      // `rewriteSite` to replace just the argument that held the inner call.
      if (builder.rewriteSite) {
        return builder.rewriteSite(visited, name, innerCall, factory);
      }
      return factory.updateCallExpression(
        visited,
        name,
        visited.typeArguments,
        visited.arguments,
      );
    }

    return visited;
  };

  // Visit each top-level statement, flushing the hoists it produced immediately
  // BEFORE it. A statement's hoisted consts are placed after every preceding
  // top-level statement — and therefore after every module-scoped binding the
  // hoisted (eagerly-run) pattern callbacks reference, since those bindings had
  // to precede the original use site. Among hoists from the same statement,
  // post-order traversal already pushed inner/earlier calls first, so a hoist
  // that references another hoist (e.g. `__cfPattern` whose callback calls
  // `__cfLift`) sees it declared above.
  const resultStatements: ts.Statement[] = [];
  for (const statement of sourceFile.statements) {
    pendingHoists = [];
    const visitedStatement = ts.visitNode(statement, visit) as ts.Statement;
    resultStatements.push(...pendingHoists, visitedStatement);
  }

  return factory.updateSourceFile(sourceFile, resultStatements);
}
