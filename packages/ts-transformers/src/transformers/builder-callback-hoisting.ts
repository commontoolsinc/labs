import ts from "typescript";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import { hoistModuleScopedBuilderCallbacks } from "../closures/module-scope-callback-hoisting.ts";

/**
 * Hoist builder callbacks whose body closes only over module-level symbols.
 * The hoisted form becomes `const __cfModuleCallback_N = ...` at module scope,
 * replacing the inline callback at the call site with a reference to the new
 * name.
 *
 * Only `patternTool` is handled here now. `lift` (CT-1644), `handler`, and
 * `pattern` (CT-1655) get their WHOLE call hoisted by
 * `BuilderCallHoistingTransformer` (which runs after SchemaInjection) with the
 * callback inline; hoisting the callback here too would double-hoist into a
 * module-load TDZ, so they are removed from this stage's set. `patternTool`
 * remains because its per-instance captures thread through the call's own
 * second argument (unlike `pattern`, whose captures live in the enclosing
 * `mapWithPattern` params), so relocating its whole call is not obviously
 * capture-safe — pending follow-up. When `patternTool` is resolved this stage
 * empties and can be deleted, leaving `BuilderCallHoistingTransformer` as the
 * sole module-scope hoisting phase.
 *
 * This stage runs after `PatternCallbackLoweringTransformer` so that
 * pattern callbacks have their in-place lowerings (the
 * `__cf_pattern_input.key("…")` prologue, well-known-key substitutions,
 * tracked-opaque `.key()` rewrites) applied to the callback body
 * *before* it is moved to module scope. Hoisting earlier would mean
 * those late lowerings never visit the callback — pattern callbacks
 * would survive with bare CF key identifiers (`obj[NAME]`) in module
 * scope.
 */
export class BuilderCallbackHoistingTransformer extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    return hoistModuleScopedBuilderCallbacks(context.sourceFile, context);
  }
}
