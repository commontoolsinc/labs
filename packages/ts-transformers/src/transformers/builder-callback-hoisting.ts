import ts from "typescript";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import { hoistModuleScopedBuilderCallbacks } from "../closures/module-scope-callback-hoisting.ts";

/**
 * Hoist builder callbacks (derive/handler/lift/pattern/patternTool)
 * whose body closes only over module-level symbols. The hoisted form
 * becomes `const __cfModuleCallback_N = ...` at module scope, replacing
 * the inline callback at the call site with a reference to the new
 * name.
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
