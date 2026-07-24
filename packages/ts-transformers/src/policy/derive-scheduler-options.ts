import ts from "typescript";
import type {
  CapabilityParamSummary,
  FunctionCapabilitySummary,
} from "../core/mod.ts";

/**
 * Whether a computation callback's capability analysis is a complete, trusted
 * scheduler-scope summary — the `completeSchedulerScopeSummary` certificate the
 * server-primary executor consults to admit an action as statically servable.
 *
 * The certificate is only ever emitted when the capability analysis can account
 * for the callback's write surface. An empty summary is meaningful proof for a
 * source-backed zero-input computation; it is never inferred from an empty
 * runtime observation.
 *
 * Post-C0 the server firewall bounds only WRITES to the static envelope
 * (`packages/runner/src/scheduler/servability.ts`); reads are admitted
 * dynamically per-address and still promote the runtime context floor. The
 * certificate's load-bearing content is therefore write-completeness (plus the
 * structural CFC sibling reads), not read shape. So for a callback the analysis
 * proved to be read-only — every parameter has an empty `writePaths` and there
 * are no captured-cell writes — opaque whole-value reads (bare truthiness) and
 * `??` passthrough no longer disqualify it: they only describe how a read-only
 * value is read, and the dynamic read admission covers that.
 *
 * The rejections that survive are exactly the ones that make write-tracking
 * itself untrustworthy, so a "read-only" claim cannot be trusted:
 * - `recursive`: analysis short-circuited, so it never observed the body's
 *   writes at all.
 * - `unreadableCellArguments`: a cell argument reached a parameter whose
 *   capability the contract could not classify, so a write through it is
 *   invisible.
 * - `hasUnverifiedCellUse`: an unrecognized/dynamic mutator call or a
 *   set/send-with-onCommit means `writePaths` may be incomplete (documented on
 *   the field itself — consumers asserting write exhaustiveness must fail
 *   closed like `wildcard`).
 * - `opaquePaths`: an opaque sub-path derivation (`cell.foo.map(...)`) or an
 *   opaque/stream/sqlite cell argument whose interior use is unbounded.
 *
 * These stay strict whether or not the callback looks read-only, because each
 * is precisely a case where a write could hide from `writePaths`. The relaxed
 * pair (opaque whole-value use and passthrough) are read-shape-only markers
 * that carry no such hidden-write risk.
 *
 * ## W2.16 — envelope-complete materializers
 *
 * `wildcard` alone no longer disqualifies. A materializer writes through a
 * dynamic `.key(index)` descent (`c.key(i).key("backlinks").push(...)`); its
 * exact targets are data-dependent, but every target is enclosed by the
 * descent's static, param-anchored prefix. The analysis records that prefix as
 * a `writeEnvelopePaths` entry (a prefix-coverage bound matching the runtime's
 * `materializerWriteInputPaths` semantics), and — critically — proves the
 * dynamism was BOUNDED: `wildcardUnbounded` stays clear only when EVERY dynamic
 * access on the param was such a `.key(index)` descent or a read through one.
 * An `elementById`, a dynamic method name, or an opaque derivation sets
 * `wildcardUnbounded` and fails closed, because a write could then hide outside
 * the recorded envelopes. So a `wildcard` param certifies as a materializer iff
 * it (a) actually writes — `writePaths ∪ writeEnvelopePaths` is non-empty (a
 * read-only wildcard has no declared envelope and stays uncertified, keeping
 * the W2.12 boundary) and (b) is not `wildcardUnbounded`. The union of
 * `writePaths` and `writeEnvelopePaths` is then a complete write bound, which
 * the runtime enforces fail-closed (a write outside it de-claims the action).
 */
export function hasCompleteSchedulerScopeSummary(
  summary: FunctionCapabilitySummary,
): boolean {
  if (
    summary.recursive ||
    (summary.unreadableCellArguments?.length ?? 0) > 0
  ) {
    return false;
  }
  // A callback the analysis affirmatively proved writes nothing: every
  // parameter tracked zero write paths (exact or envelope). For such a callback
  // the certificate's write-completeness holds trivially, so opaque/passthrough
  // reads certify.
  const readOnly = summary.params.every((param) =>
    (param.writePaths?.length ?? 0) === 0 &&
    (param.writeEnvelopePaths?.length ?? 0) === 0
  );
  return summary.params.every((param) => {
    if (param.hasUnverifiedCellUse) return false;
    if ((param.opaquePaths?.length ?? 0) !== 0) return false;
    if (param.wildcard) {
      // Envelope-complete materializer: dynamic writes are bounded by
      // `.key(index)` descents whose static prefixes cover them, and no
      // unbounded dynamic access can hide a write outside those envelopes. A
      // read-only wildcard declares no envelope, so it stays uncertified.
      const hasWrites = (param.writePaths?.length ?? 0) > 0 ||
        (param.writeEnvelopePaths?.length ?? 0) > 0;
      return hasWrites && !param.wildcardUnbounded;
    }
    // Opaque whole-value reads and `??` passthrough only describe read shape.
    // They keep disqualifying a callback that also writes (a write param's
    // envelope must be exactly enumerable), but not a proven read-only one.
    return readOnly || (!param.passthrough && param.capability !== "opaque");
  });
}

/**
 * Build the trailing `DeriveSchedulerOptions` object literal for a lift/derive
 * call, or `undefined` when neither the materializer write paths nor the
 * completeness certificate need to be emitted. `inputParamSummary` is the
 * callback's first parameter — the one carrying any static materializer write
 * surface; `completeSchedulerScopeSummary` is the result of
 * {@link hasCompleteSchedulerScopeSummary} for the whole callback.
 *
 * `materializerWriteInputPaths` is the union of the parameter's exact
 * `writePaths` (`c.key("backlinks").set(...)`) and its dynamic-write
 * `writeEnvelopePaths` (`c.key(i).key("backlinks").push(...)`, bounded to the
 * descent prefix). Both are prefix-coverage envelopes at runtime, so they emit
 * into the same array; naming both families keeps the runtime's write bound
 * complete for an envelope-granular materializer.
 */
export function createDeriveSchedulerOptions(
  inputParamSummary: CapabilityParamSummary | undefined,
  completeSchedulerScopeSummary: boolean,
  factory: ts.NodeFactory,
): ts.ObjectLiteralExpression | undefined {
  const writePaths = [
    ...(inputParamSummary?.writePaths ?? []),
    ...(inputParamSummary?.writeEnvelopePaths ?? []),
  ];
  if (writePaths.length === 0 && !completeSchedulerScopeSummary) {
    return undefined;
  }

  return factory.createObjectLiteralExpression(
    [
      ...(writePaths.length > 0
        ? [
          factory.createPropertyAssignment(
            "materializerWriteInputPaths",
            factory.createArrayLiteralExpression(
              writePaths.map((path) =>
                factory.createArrayLiteralExpression(
                  path.map((segment) => factory.createStringLiteral(segment)),
                  false,
                )
              ),
              false,
            ),
          ),
        ]
        : []),
      ...(completeSchedulerScopeSummary
        ? [
          factory.createPropertyAssignment(
            "completeSchedulerScopeSummary",
            factory.createTrue(),
          ),
        ]
        : []),
    ],
    false,
  );
}
