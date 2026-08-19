import { VERIFIED_BINDING_METADATA_FIELD } from "@commonfabric/utils/sandbox-contract";

/**
 * Where a builder artifact's function was AUTHORED, for debug display only.
 *
 * The transformer stamps the position onto every function-bearing builder
 * artifact at module scope (behavior spec §17.3); `Engine.recordModuleProvenance`
 * reads it during the post-evaluation provenance walk and records it here,
 * keyed by the same implementation function object that walk keys provenance by.
 *
 * This map is deliberately SEPARATE from `VerifiedProvenance`: nothing here is
 * consulted for identity, authorization, or scheduling, and the CFC adversarial
 * suite pins that a forged `.src` is inert. Keeping the two apart means a debug
 * field can never widen the red-team surface of the provenance record.
 */
export type AuthoredDebugSource = {
  /**
   * `cf:module/<identity>/<authoredPath>:<line>:<col>` — the same canonical
   * module source `Engine.canonicalModuleSource` produces, with the AUTHORED
   * line (the transformer's transformed-file line, corrected by the helper
   * prelude offset) and the column exactly as emitted, which is 0-based.
   * Absent whenever the position could not be resolved to authored coordinates.
   */
  src?: string;
  /** The authored declaration name; absent for inline-expression origins. */
  bindingName?: string;
};

const authoredDebugSourceByFn = new WeakMap<object, AuthoredDebugSource>();

/**
 * Record the authored debug source of an implementation function. First write
 * wins, mirroring `recordVerifiedProvenance`: an artifact reachable both as an
 * export and as a `__cfReg` registration keeps one entry.
 */
export function recordAuthoredDebugSource(
  fn: unknown,
  entry: AuthoredDebugSource,
): void {
  if (typeof fn !== "function") return;
  if (!authoredDebugSourceByFn.has(fn)) authoredDebugSourceByFn.set(fn, entry);
}

/**
 * The authored debug source recorded for a function, or undefined. A miss is
 * ordinary: warm-boot caches hold bodies compiled before the annotation
 * existed, and any artifact outside a verified evaluation was never recorded.
 */
export function getAuthoredDebugSource(
  fn: unknown,
): AuthoredDebugSource | undefined {
  return typeof fn === "function" ? authoredDebugSourceByFn.get(fn) : undefined;
}

/** The authored-position half of the transformer's binding annotation. */
export type AuthoredBindingAnnotation = {
  sourceFile: string;
  /** Line 1-based, col 0-based, indexing the TRANSFORMED file. */
  position?: { line: number; col: number };
  bindingName?: string;
};

/**
 * Read the authored-position fields of a `__cfBindVerifiedBinding` annotation
 * off a builder artifact.
 *
 * Lenient by design, and distinct from `readBindingIdentity` (which reads the
 * TRUSTED-scope `bindingPath` and must stay strict — it mints write authority).
 * `bindingPath` is present only on trusted bindings, so requiring it here would
 * drop the position of every ordinary artifact. Each field is admitted on its
 * own merits: a malformed `position` costs the position, not the whole read.
 */
export function readAuthoredBindingAnnotation(
  value: unknown,
): AuthoredBindingAnnotation | undefined {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  const metadata =
    (value as Record<string, unknown>)[VERIFIED_BINDING_METADATA_FIELD];
  if (!metadata || typeof metadata !== "object") return undefined;
  const fields = metadata as Record<string, unknown>;
  const sourceFile = fields.sourceFile;
  if (typeof sourceFile !== "string" || sourceFile.length === 0) {
    return undefined;
  }
  const bindingName = fields.bindingName;
  return {
    sourceFile,
    ...(readPosition(fields.position) ?? {}),
    ...(typeof bindingName === "string" && bindingName.length > 0
      ? { bindingName }
      : {}),
  };
}

function readPosition(
  value: unknown,
): { position: { line: number; col: number } } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { line, col } = value as Record<string, unknown>;
  if (
    typeof line !== "number" || !Number.isFinite(line) ||
    typeof col !== "number" || !Number.isFinite(col)
  ) {
    return undefined;
  }
  return { position: { line, col } };
}

/**
 * Install the lazy `src` debug accessor on a builder artifact's function.
 *
 * The value is served from the map rather than written onto the function
 * because the provenance walk that fills the map runs long after the builder
 * call, by which time `hardenVerifiedFunction` has frozen the implementation.
 * The accessor is non-enumerable so it stays out of serialization and
 * `Object.entries` walks, and configurable so a re-registered function can be
 * re-annotated.
 *
 * A miss returns undefined and never throws: `Runner` reads `.src` on the
 * invoke path, where a body compiled before the annotation existed is normal.
 */
export function defineAuthoredDebugAccessors(
  fn: (...args: any[]) => unknown,
): void {
  Object.defineProperty(fn, "src", {
    get: () => getAuthoredDebugSource(fn)?.src,
    enumerable: false,
    configurable: true,
  });
}
